import { createHash } from 'node:crypto';

import type { S3Fetch } from '../../src/storage/s3.js';

export interface FakeS3Call {
  method: string;
  key: string | undefined;
  query: Record<string, string>;
}

/**
 * Just enough of the S3 REST API, in memory, for driving S3Storage in tests:
 * object CRUD, ListObjectsV2 (with a small page size so paging is exercised),
 * DeleteObjects and multipart upload. Checks every request carries a SigV4
 * Authorization header and a payload hash that matches its body.
 */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  readonly calls: FakeS3Call[] = [];
  /** Max keys per ListObjectsV2 page. */
  pageSize = 2;
  /** Return this status for every call whose method matches. */
  failWith: { method: string; status: number; code: string } | undefined;
  #nextUpload = 1;

  constructor(
    readonly bucket: string,
    readonly opts: { pathStyle: boolean; baseHost: string },
  ) {}

  readonly fetch: S3Fetch = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);

    if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=')) return xmlError(403, 'AccessDenied');
    if (headers.get('x-amz-content-sha256') !== createHash('sha256').update(body).digest('hex')) {
      return xmlError(400, 'XAmzContentSHA256Mismatch');
    }

    let segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (this.opts.pathStyle) {
      if (url.host !== this.opts.baseHost || segments[0] !== this.bucket) return xmlError(404, 'NoSuchBucket');
      segments = segments.slice(1);
    } else if (url.host !== `${this.bucket}.${this.opts.baseHost}`) {
      return xmlError(404, 'NoSuchBucket');
    }
    const key = segments.join('/') || undefined;
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ method, key, query });

    if (this.failWith?.method === method) return xmlError(this.failWith.status, this.failWith.code);
    return key === undefined ? this.#bucketCall(method, query, body, headers) : this.#objectCall(method, key, query, body);
  };

  #bucketCall(method: string, query: Record<string, string>, body: Buffer, headers: Headers): Response {
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (method === 'GET' && query['list-type'] === '2') {
      const prefix = query.prefix ?? '';
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = query['continuation-token'] ? Number(query['continuation-token']) : 0;
      const size = Math.min(this.pageSize, Number(query['max-keys'] ?? this.pageSize));
      const page = all.slice(start, start + size);
      const truncated = start + size < all.length;
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><Name>${this.bucket}</Name><Prefix>${prefix}</Prefix>` +
          page.map((k) => `<Contents><Key>${esc(k)}</Key></Contents>`).join('') +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : '') +
          '</ListBucketResult>',
        { status: 200 },
      );
    }
    if (method === 'POST' && 'delete' in query) {
      const md5 = createHash('md5').update(body).digest('base64');
      if (headers.get('content-md5') !== md5) return xmlError(400, 'InvalidDigest');
      for (const m of body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)) this.objects.delete(unesc(m[1]!));
      return new Response('<?xml version="1.0"?><DeleteResult></DeleteResult>', { status: 200 });
    }
    return xmlError(400, 'UnsupportedBucketCall');
  }

  #objectCall(method: string, key: string, query: Record<string, string>, body: Buffer): Response {
    if (method === 'POST' && 'uploads' in query) {
      const id = `up-${this.#nextUpload++}`;
      this.uploads.set(id, { key, parts: new Map() });
      return new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (query.uploadId) {
      const upload = this.uploads.get(query.uploadId);
      if (!upload || upload.key !== key) return xmlError(404, 'NoSuchUpload');
      if (method === 'PUT') {
        const n = Number(query.partNumber);
        upload.parts.set(n, body);
        return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
      }
      if (method === 'POST') {
        const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;etag-(\d+)&quot;<\/ETag>/g)];
        const ordered = listed.map((m) => upload.parts.get(Number(m[1]))!);
        this.objects.set(key, Buffer.concat(ordered));
        this.uploads.delete(query.uploadId);
        return new Response('<?xml version="1.0"?><CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      }
      if (method === 'DELETE') {
        this.uploads.delete(query.uploadId);
        return new Response(null, { status: 204 });
      }
    }
    const obj = this.objects.get(key);
    switch (method) {
      case 'PUT':
        this.objects.set(key, body);
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      case 'GET':
        return obj ? new Response(obj, { status: 200 }) : xmlError(404, 'NoSuchKey');
      case 'HEAD':
        return new Response(null, { status: obj ? 200 : 404 });
      case 'DELETE':
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return xmlError(400, 'UnsupportedObjectCall');
    }
  }
}

function xmlError(status: number, code: string): Response {
  return new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>fake</Message></Error>`, { status });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
