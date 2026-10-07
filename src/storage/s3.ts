import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { XMLParser } from 'fast-xml-parser';

import {
  EMPTY_SHA256,
  encodePath,
  presignUrl,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
} from './sigv4.js';
import { StorageNotFoundError, type StorageAdapter } from './types.js';

export type S3Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface S3StorageOptions {
  bucket: string;
  /** `auto` for Cloudflare R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom endpoint for R2 / MinIO / other S3-compatible stores. Defaults to AWS. */
  endpoint?: string;
  /** Address the bucket as `<endpoint>/<bucket>/key` instead of `<bucket>.<endpoint>/key`. MinIO needs this. */
  forcePathStyle?: boolean;
  /** Uploads larger than this go through multipart upload in parts of this size. Min 5 MiB (an S3 limit). */
  partSize?: number;
  fetch?: S3Fetch;
  now?: () => Date;
}

const MiB = 1024 * 1024;
const MIN_PART_SIZE = 5 * MiB;
const DEFAULT_PART_SIZE = 8 * MiB;
/** S3 caps pre-signed URLs at 7 days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
/** DeleteObjects takes at most 1000 keys per call. */
const DELETE_BATCH = 1000;

/** An error response from the object store. */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    operation: string,
  ) {
    super(`S3 ${operation} failed: ${status}${code ? ` ${code}` : ''}`);
    this.name = 'S3Error';
  }
}

const xml = new XMLParser({ parseTagValue: false, ignoreAttributes: true });

interface Call {
  method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';
  /** Object key, or undefined for a bucket-level call. */
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer;
}

/**
 * StorageAdapter for S3 and S3-compatible stores (Cloudflare R2, MinIO, …),
 * talking plain REST with SigV4 signing.
 *
 * Mirrors the local driver's semantics: `delete(key)` removes the object and
 * everything "beneath" it (`key/…`), and `exists(key)` is true for a key that
 * is either an object or a non-empty prefix.
 */
export class S3Storage implements StorageAdapter {
  readonly #bucket: string;
  readonly #region: string;
  readonly #credentials: SigV4Credentials;
  readonly #protocol: string;
  readonly #host: string;
  /** Path to the bucket root: '' for virtual-hosted style, `/bucket` for path style. */
  readonly #bucketPath: string;
  readonly #partSize: number;
  readonly #fetch: S3Fetch;
  readonly #now: () => Date;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new Error('S3Storage: bucket is required');
    const partSize = options.partSize ?? DEFAULT_PART_SIZE;
    if (partSize < MIN_PART_SIZE) throw new Error(`S3Storage: partSize must be at least ${MIN_PART_SIZE} bytes`);

    const base = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
    const basePath = base.pathname.replace(/\/+$/, '');
    this.#protocol = base.protocol;
    if (options.forcePathStyle) {
      this.#host = base.host;
      this.#bucketPath = `${basePath}/${encodePath(options.bucket)}`;
    } else {
      this.#host = `${options.bucket}.${base.host}`;
      this.#bucketPath = basePath;
    }

    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    };
    this.#partSize = partSize;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => new Date());
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const objectKey = normalizeKey(key);
    const source: AsyncIterable<unknown> | Iterable<unknown> = Buffer.isBuffer(body) ? [body] : body;

    let pending: Buffer[] = [];
    let pendingSize = 0;
    let upload: MultipartUpload | undefined;
    try {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
        pending.push(buf);
        pendingSize += buf.length;
        // Stream big objects out in parts so memory stays bounded by partSize.
        while (pendingSize >= this.#partSize) {
          const all = Buffer.concat(pending);
          upload ??= await this.#startMultipart(objectKey);
          await upload.uploadPart(all.subarray(0, this.#partSize));
          const rest = all.subarray(this.#partSize);
          pending = rest.length ? [rest] : [];
          pendingSize = rest.length;
        }
      }

      const tail = Buffer.concat(pending);
      if (!upload) {
        await this.#expect(await this.#call({ method: 'PUT', key: objectKey, body: tail }), 'PutObject');
        return;
      }
      if (tail.length) await upload.uploadPart(tail);
      await upload.complete();
    } catch (err) {
      if (upload) await upload.abort().catch(() => undefined);
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const res = await this.#call({ method: 'GET', key: normalizeKey(key) });
    if (res.status === 404) {
      await res.body?.cancel();
      throw new StorageNotFoundError(key);
    }
    await this.#expect(res, 'GetObject', { keepBody: true });
    return res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream) : Readable.from([]);
  }

  async delete(key: string): Promise<void> {
    const objectKey = normalizeKey(key);
    await this.#expect(await this.#call({ method: 'DELETE', key: objectKey }), 'DeleteObject', { allow: [404] });

    // Collect the whole listing before deleting: removing keys mid-listing can
    // invalidate continuation tokens on some S3-compatible stores.
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.#list(`${objectKey}/`, { continuationToken: token });
      keys.push(...page.keys);
      token = page.nextToken;
    } while (token);
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.#deleteMany(keys.slice(i, i + DELETE_BATCH));
    }
  }

  async exists(key: string): Promise<boolean> {
    const objectKey = normalizeKey(key);
    const res = await this.#call({ method: 'HEAD', key: objectKey });
    if (res.ok) return true;
    await this.#expect(res, 'HeadObject', { allow: [404] });
    const page = await this.#list(`${objectKey}/`, { maxKeys: 1 });
    return page.keys.length > 0;
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const objectKey = normalizeKey(key);
    if (!(await this.exists(objectKey))) throw new StorageNotFoundError(key);
    const expires = Math.min(Math.max(Math.floor(ttlSeconds), 1), MAX_PRESIGN_SECONDS);
    return presignUrl(
      { method: 'GET', protocol: this.#protocol, host: this.#host, path: this.#path(objectKey) },
      { credentials: this.#credentials, region: this.#region, date: this.#now() },
      expires,
    );
  }

  /** Readiness probe: the bucket exists and these credentials can reach it. */
  async check(): Promise<void> {
    await this.#expect(await this.#call({ method: 'HEAD' }), `HeadBucket(${this.#bucket})`);
  }

  // ---- internals -----------------------------------------------------------

  #path(key?: string): string {
    if (key === undefined) return this.#bucketPath || '/';
    return `${this.#bucketPath}/${encodePath(key)}`;
  }

  async #call(call: Call): Promise<Response> {
    const { url, headers } = signRequest(
      {
        method: call.method,
        protocol: this.#protocol,
        host: this.#host,
        path: this.#path(call.key),
        ...(call.query ? { query: call.query } : {}),
        ...(call.headers ? { headers: call.headers } : {}),
        payloadHash: call.body ? sha256Hex(call.body) : EMPTY_SHA256,
      },
      { credentials: this.#credentials, region: this.#region, date: this.#now() },
    );
    const init: RequestInit = { method: call.method, headers };
    if (call.body) init.body = call.body;
    return this.#fetch(url, init);
  }

  /**
   * Throw an {@link S3Error} unless the response is a 2xx (or an allowed
   * status). Drains the body unless `keepBody`. S3 can answer some calls
   * (CompleteMultipartUpload, DeleteObjects) with 200 and an `<Error>` body,
   * so callers that care read the body themselves.
   */
  async #expect(
    res: Response,
    operation: string,
    opts: { allow?: number[]; keepBody?: boolean } = {},
  ): Promise<void> {
    if (res.ok || opts.allow?.includes(res.status)) {
      if (!opts.keepBody) await res.body?.cancel();
      return;
    }
    const text = await res.text().catch(() => '');
    throw new S3Error(res.status, errorCode(text), operation);
  }

  async #list(
    prefix: string,
    opts: { continuationToken?: string | undefined; maxKeys?: number } = {},
  ): Promise<{ keys: string[]; nextToken: string | undefined }> {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (opts.continuationToken) query['continuation-token'] = opts.continuationToken;
    if (opts.maxKeys) query['max-keys'] = String(opts.maxKeys);
    const res = await this.#call({ method: 'GET', query });
    await this.#expect(res, 'ListObjectsV2', { keepBody: true });
    const result = xml.parse(await res.text())?.ListBucketResult ?? {};
    const contents = asArray(result.Contents) as Array<{ Key?: string }>;
    const truncated = String(result.IsTruncated) === 'true';
    return {
      keys: contents.map((c) => c.Key).filter((k): k is string => typeof k === 'string'),
      nextToken: truncated && result.NextContinuationToken ? String(result.NextContinuationToken) : undefined,
    };
  }

  async #deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const body = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
        .map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`)
        .join('')}</Delete>`,
    );
    const res = await this.#call({
      method: 'POST',
      query: { delete: '' },
      headers: {
        'content-type': 'application/xml',
        'content-md5': createHash('md5').update(body).digest('base64'),
      },
      body,
    });
    await this.#expect(res, 'DeleteObjects', { keepBody: true });
    const errors = asArray(xml.parse(await res.text())?.DeleteResult?.Error) as Array<{ Code?: string }>;
    if (errors.length > 0) throw new S3Error(res.status, errors[0]?.Code, `DeleteObjects (${errors.length} failed)`);
  }

  async #startMultipart(key: string): Promise<MultipartUpload> {
    const res = await this.#call({ method: 'POST', key, query: { uploads: '' } });
    await this.#expect(res, 'CreateMultipartUpload', { keepBody: true });
    const uploadId = xml.parse(await res.text())?.InitiateMultipartUploadResult?.UploadId;
    if (!uploadId) throw new S3Error(res.status, 'MissingUploadId', 'CreateMultipartUpload');
    const id = String(uploadId);
    const etags: string[] = [];

    return {
      uploadPart: async (part) => {
        const partNumber = etags.length + 1;
        const r = await this.#call({
          method: 'PUT',
          key,
          query: { partNumber: String(partNumber), uploadId: id },
          body: part,
        });
        await this.#expect(r, `UploadPart(${partNumber})`);
        const etag = r.headers.get('etag');
        if (!etag) throw new S3Error(r.status, 'MissingETag', `UploadPart(${partNumber})`);
        etags.push(etag);
      },
      complete: async () => {
        const body = Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${etags
            .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
            .join('')}</CompleteMultipartUpload>`,
        );
        const r = await this.#call({
          method: 'POST',
          key,
          query: { uploadId: id },
          headers: { 'content-type': 'application/xml' },
          body,
        });
        await this.#expect(r, 'CompleteMultipartUpload', { keepBody: true });
        const text = await r.text();
        if (/<Error>/.test(text)) throw new S3Error(r.status, errorCode(text), 'CompleteMultipartUpload');
      },
      abort: async () => {
        await this.#expect(
          await this.#call({ method: 'DELETE', key, query: { uploadId: id } }),
          'AbortMultipartUpload',
          { allow: [404] },
        );
      },
    };
  }
}

interface MultipartUpload {
  uploadPart(part: Buffer): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

function normalizeKey(key: string): string {
  const rel = key.replace(/^\/+/, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === '.')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return rel.replace(/\/+$/, '');
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function errorCode(body: string): string | undefined {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
