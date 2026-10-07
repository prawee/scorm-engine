import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, just enough of it for S3-compatible object storage
 * (AWS S3, Cloudflare R2, MinIO, …). Kept dependency-free so the engine does
 * not pull in the AWS SDK for a handful of REST calls.
 *
 * Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary (STS) credentials carry a session token. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** `https:` or `http:`. */
  protocol: string;
  /** Host header value, including a non-default port. */
  host: string;
  /** Canonical, already URI-encoded path (e.g. from {@link encodePath}). */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign and send. Names are case-insensitive. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
}

export interface SigV4Context {
  credentials: SigV4Credentials;
  region: string;
  service?: string;
  date: Date;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encoding as SigV4 wants it: everything but `A-Za-z0-9-_.~` is escaped. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode an object key for use in a path, keeping `/` separators. */
export function encodePath(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function scopeOf(ctx: SigV4Context): string {
  return `${amzDate(ctx.date).slice(0, 8)}/${ctx.region}/${ctx.service ?? 's3'}/aws4_request`;
}

function signature(ctx: SigV4Context, canonicalRequest: string): string {
  const stamp = amzDate(ctx.date);
  const stringToSign = [ALGORITHM, stamp, scopeOf(ctx), sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${ctx.credentials.secretAccessKey}`, stamp.slice(0, 8));
  const kRegion = hmac(kDate, ctx.region);
  const kService = hmac(kRegion, ctx.service ?? 's3');
  const kSigning = hmac(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

function buildCanonical(
  req: SigV4Request,
  query: Record<string, string>,
  headers: Record<string, string>,
): { canonicalRequest: string; signedHeaders: string; queryString: string } {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [
    req.method.toUpperCase(),
    req.path || '/',
    queryString,
    canonicalHeaders,
    signedHeaders,
    req.payloadHash,
  ].join('\n');
  return { canonicalRequest, signedHeaders, queryString };
}

function lowerHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Sign a request with an `Authorization` header. Returns the URL to call and
 * the full header set to send (the signed headers minus `host`, which `fetch`
 * derives from the URL).
 */
export function signRequest(req: SigV4Request, ctx: SigV4Context): { url: string; headers: Record<string, string> } {
  const headers = lowerHeaders(req.headers);
  headers.host = req.host;
  headers['x-amz-date'] = amzDate(ctx.date);
  headers['x-amz-content-sha256'] = req.payloadHash;
  if (ctx.credentials.sessionToken) headers['x-amz-security-token'] = ctx.credentials.sessionToken;

  const { canonicalRequest, signedHeaders, queryString } = buildCanonical(req, req.query ?? {}, headers);
  const sig = signature(ctx, canonicalRequest);
  headers.authorization =
    `${ALGORITHM} Credential=${ctx.credentials.accessKeyId}/${scopeOf(ctx)}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const { host: _host, ...sendHeaders } = headers;
  return { url: `${req.protocol}//${req.host}${req.path || '/'}${queryString ? `?${queryString}` : ''}`, headers: sendHeaders };
}

/** Build a pre-signed URL (query-string auth) valid for `expiresSeconds`. */
export function presignUrl(
  req: Omit<SigV4Request, 'payloadHash' | 'headers'>,
  ctx: SigV4Context,
  expiresSeconds: number,
): string {
  const query: Record<string, string> = {
    ...req.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${ctx.credentials.accessKeyId}/${scopeOf(ctx)}`,
    'X-Amz-Date': amzDate(ctx.date),
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  if (ctx.credentials.sessionToken) query['X-Amz-Security-Token'] = ctx.credentials.sessionToken;

  const { canonicalRequest, queryString } = buildCanonical(
    { ...req, payloadHash: UNSIGNED_PAYLOAD },
    query,
    { host: req.host },
  );
  const sig = signature(ctx, canonicalRequest);
  return `${req.protocol}//${req.host}${req.path || '/'}?${queryString}&X-Amz-Signature=${sig}`;
}
