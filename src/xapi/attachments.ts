import { createHash, createVerify, X509Certificate } from 'node:crypto';
import type { Readable } from 'node:stream';

import { tenantKey } from '../storage/scoped.js';
import type { StorageAdapter } from '../storage/types.js';
import { XapiError } from './errors.js';
import { boundaryOf, buildMultipart, parseMultipart, type MultipartPart } from './multipart.js';
import { canonicalJson } from './statements.js';

/**
 * xAPI 1.0.3 attachments (§1.5.2 / Data §2.4.11).
 *
 * A statement declares each attachment by its SHA-2 hash; the body travels as a
 * part of a `multipart/mixed` request, keyed by `X-Experience-API-Hash`. Bodies
 * are stored content-addressed under the tenant's prefix, so two statements
 * sharing a file share one copy, and a statement re-sent on retry is free.
 */

export const SIGNATURE_USAGE_TYPE = 'http://adlnet.gov/expapi/attachments/signature';

const HASH_HEADER = 'x-experience-api-hash';
const SIGNATURE_ALGORITHMS: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};
/** SHA-2 variant implied by the length of a hex digest. */
const SHA2_BY_HEX_LENGTH: Record<number, string> = {
  56: 'sha224',
  64: 'sha256',
  96: 'sha384',
  128: 'sha512',
};

export interface AttachmentBody {
  /** Lower-case hex SHA-2 digest of `content`. */
  sha2: string;
  contentType: string;
  content: Buffer;
}

export interface StatementUpload {
  /** The parsed JSON part: one statement or an array of them. */
  body: unknown;
  attachments: AttachmentBody[];
}

export function isMultipart(contentType: string | undefined): boolean {
  return /^multipart\/mixed\b/i.test(contentType?.trim() ?? '');
}

/**
 * Split a `multipart/mixed` statement request into its JSON statement part and
 * attachment bodies, checking each body against the hash it claims.
 */
export function parseStatementUpload(raw: Buffer, contentType: string): StatementUpload {
  const [first, ...rest] = parseMultipart(raw, boundaryOf(contentType));
  if (!first) {
    throw XapiError.badRequest('multipart/mixed request has no parts', 'invalid_multipart');
  }
  if (!/^application\/json\b/i.test(first.headers['content-type'] ?? '')) {
    throw XapiError.badRequest(
      'The first part of a multipart statement request must be application/json',
      'invalid_multipart',
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(first.body.toString('utf8'));
  } catch {
    throw XapiError.badRequest('The statement part is not valid JSON', 'invalid_statement');
  }

  const bySha = new Map<string, AttachmentBody>();
  for (const part of rest) {
    const attachment = readAttachmentPart(part);
    bySha.set(attachment.sha2, attachment);
  }
  return { body, attachments: [...bySha.values()] };
}

function readAttachmentPart(part: MultipartPart): AttachmentBody {
  const declared = part.headers[HASH_HEADER]?.toLowerCase();
  if (!declared) {
    throw XapiError.badRequest(
      'Every attachment part needs an X-Experience-API-Hash header',
      'invalid_attachment',
    );
  }
  const encoding = part.headers['content-transfer-encoding'];
  if (encoding?.toLowerCase() !== 'binary') {
    throw XapiError.badRequest(
      'Attachment parts must be sent with Content-Transfer-Encoding: binary',
      'invalid_attachment',
    );
  }
  const algorithm = SHA2_BY_HEX_LENGTH[declared.length];
  if (!algorithm || !/^[0-9a-f]+$/.test(declared)) {
    throw XapiError.badRequest(
      `X-Experience-API-Hash "${declared}" is not a hex SHA-2 digest`,
      'invalid_attachment',
    );
  }
  if (createHash(algorithm).update(part.body).digest('hex') !== declared) {
    throw XapiError.badRequest(
      `Attachment content does not match its hash ${declared}`,
      'attachment_hash_mismatch',
    );
  }
  return {
    sha2: declared,
    contentType: part.headers['content-type'] ?? 'application/octet-stream',
    content: part.body,
  };
}

interface DeclaredAttachment {
  usageType?: unknown;
  contentType?: unknown;
  sha2?: unknown;
  fileUrl?: unknown;
}

function declaredOn(statement: unknown): DeclaredAttachment[] {
  const list = (statement as { attachments?: unknown } | null)?.attachments;
  return Array.isArray(list)
    ? list.filter((a): a is DeclaredAttachment => !!a && typeof a === 'object')
    : [];
}

/**
 * Check that the bodies sent match what the statements declare, both ways:
 * every attachment without a `fileUrl` must have its body in the request, and
 * every body must belong to some declared attachment. Signature attachments are
 * also checked against the statement they sign.
 *
 * Runs on raw statements, before schema validation, so it tolerates any shape.
 */
export function reconcileAttachments(statements: unknown[], bodies: AttachmentBody[]): void {
  const bySha = new Map(bodies.map((b) => [b.sha2, b]));
  const used = new Set<string>();

  for (const statement of statements) {
    for (const attachment of declaredOn(statement)) {
      const sha2 = typeof attachment.sha2 === 'string' ? attachment.sha2.toLowerCase() : '';
      const body = bySha.get(sha2);
      if (body) used.add(sha2);

      if (attachment.usageType === SIGNATURE_USAGE_TYPE) {
        if (!body) {
          throw XapiError.badRequest(
            'A signature attachment must be sent with its body',
            'missing_attachment',
          );
        }
        verifySignature(statement, body);
        continue;
      }
      if (!body && typeof attachment.fileUrl !== 'string') {
        throw XapiError.badRequest(
          `Attachment ${sha2 || '(no sha2)'} has no fileUrl and its body was not sent`,
          'missing_attachment',
        );
      }
    }
  }

  const stray = bodies.find((b) => !used.has(b.sha2));
  if (stray) {
    throw XapiError.badRequest(
      `Attachment part ${stray.sha2} is not declared by any statement`,
      'unexpected_attachment',
    );
  }
}

/**
 * A signed statement carries a compact JWS (RS256/384/512) whose payload is the
 * statement as it was before the signature attachment was added. We check the
 * structure and that payload; when the JWS embeds its certificate (`x5c`) we
 * also verify the signature cryptographically. Trusting the certificate itself
 * is left to the consumer, as the spec allows.
 */
function verifySignature(statement: unknown, body: AttachmentBody): void {
  const invalid = (reason: string): never => {
    throw XapiError.badRequest(`Invalid statement signature: ${reason}`, 'invalid_signature');
  };

  if (!/^application\/octet-stream\b/i.test(body.contentType)) {
    invalid('the signature part must be application/octet-stream');
  }
  const segments = body.content.toString('utf8').trim().split('.');
  if (segments.length !== 3) invalid('not a compact JWS');
  const [rawHeader, rawPayload, rawSignature] = segments as [string, string, string];

  const header = decodeSegment(rawHeader) as { alg?: unknown; x5c?: unknown } | undefined;
  const payload = decodeSegment(rawPayload);
  if (!header || typeof header !== 'object') invalid('the JWS header is not JSON');
  const algorithm = SIGNATURE_ALGORITHMS[String(header?.alg)];
  if (!algorithm) invalid('alg must be RS256, RS384 or RS512');
  if (!payload || typeof payload !== 'object') invalid('the JWS payload is not a JSON statement');

  if (!sameSignedContent(statement, payload as Record<string, unknown>)) {
    invalid('the JWS payload does not match the statement');
  }

  const x5c = header?.x5c;
  if (Array.isArray(x5c) && typeof x5c[0] === 'string') {
    let ok = false;
    try {
      const cert = new X509Certificate(Buffer.from(x5c[0], 'base64'));
      ok = createVerify(algorithm as string)
        .update(`${rawHeader}.${rawPayload}`)
        .verify(cert.publicKey, Buffer.from(rawSignature, 'base64url'));
    } catch {
      ok = false;
    }
    if (!ok) invalid('the signature does not verify against the x5c certificate');
  }
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The signed payload predates the signature attachment and the LRS-owned
 * fields, so those are ignored; `id` and `timestamp` only count when both sides
 * carry them (the LRS may have assigned them after signing).
 */
function sameSignedContent(statement: unknown, payload: Record<string, unknown>): boolean {
  const s = { ...(statement as Record<string, unknown>) };
  const p = { ...payload };
  for (const field of ['attachments', 'stored', 'authority', 'version']) {
    delete s[field];
    delete p[field];
  }
  for (const field of ['id', 'timestamp']) {
    if (s[field] === undefined || p[field] === undefined) {
      delete s[field];
      delete p[field];
    }
  }
  if (typeof s.id === 'string' && typeof p.id === 'string') {
    s.id = s.id.toLowerCase();
    p.id = p.id.toLowerCase();
  }
  return canonicalJson(s) === canonicalJson(p);
}

function attachmentKey(tenantId: string, sha2: string): string {
  return tenantKey(tenantId, 'xapi-attachments', sha2);
}

/** Persist attachment bodies; content addressing makes re-sends a no-op. */
export async function saveAttachments(
  tenantId: string,
  bodies: AttachmentBody[],
  storage: StorageAdapter,
): Promise<void> {
  for (const body of bodies) {
    const key = attachmentKey(tenantId, body.sha2);
    if (!(await storage.exists(key))) await storage.put(key, body.content);
  }
}

/**
 * Load the stored bodies for every attachment the given statements declare.
 * Attachments that were only ever referenced by `fileUrl` have no body and are
 * skipped.
 */
export async function loadAttachments(
  tenantId: string,
  statements: unknown[],
  storage: StorageAdapter,
): Promise<AttachmentBody[]> {
  const wanted = new Map<string, string>();
  for (const statement of statements) {
    for (const attachment of declaredOn(statement)) {
      if (typeof attachment.sha2 !== 'string') continue;
      const sha2 = attachment.sha2.toLowerCase();
      if (!/^[0-9a-f]+$/.test(sha2) || wanted.has(sha2)) continue;
      wanted.set(
        sha2,
        typeof attachment.contentType === 'string' ? attachment.contentType : 'application/octet-stream',
      );
    }
  }

  const out: AttachmentBody[] = [];
  for (const [sha2, contentType] of wanted) {
    const key = attachmentKey(tenantId, sha2);
    if (!(await storage.exists(key))) continue;
    out.push({ sha2, contentType, content: await readAll(await storage.get(key)) });
  }
  return out;
}

/** The multipart response for `GET /statements?attachments=true`. */
export function statementResponse(
  json: unknown,
  bodies: AttachmentBody[],
): { contentType: string; body: Buffer } {
  return buildMultipart([
    {
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(json), 'utf8'),
    },
    ...bodies.map((b) => ({
      headers: {
        'Content-Type': b.contentType,
        'Content-Transfer-Encoding': 'binary',
        'X-Experience-API-Hash': b.sha2,
      },
      body: b.content,
    })),
  ]);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
