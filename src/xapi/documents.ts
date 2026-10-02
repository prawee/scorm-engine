import { createHash } from 'node:crypto';

import { XapiError } from './errors.js';

/**
 * Semantics shared by the three xAPI document resources — State, Activity
 * Profile and Agent Profile.
 *
 * The spec gives all three the same document behaviour (etags, conditional
 * requests, PUT-replaces / POST-merges, and the "no document" cases); they
 * differ only in what identifies the owning resource. That identity lives in
 * `state.ts` and `profile.ts`; everything else lives here so the two cannot
 * drift apart.
 */

/** HTTP conditional headers, already split into their component etags. */
export interface Preconditions {
  ifMatch?: string[] | undefined;
  ifNoneMatch?: string[] | undefined;
  /**
   * When true, a write against an existing document without either header is a
   * 409, as the spec requires. Off by default so simple clients keep working.
   */
  required?: boolean | undefined;
}

/** The parts of a stored document the precondition check needs. */
export interface EtaggedDocument {
  etag: string;
}

/** Strong etag for a document body. */
export function etagFor(content: Buffer): string {
  return `"${createHash('sha1').update(content).digest('hex')}"`;
}

/** Hash an identity tuple down to a fixed-width lookup key. */
export function hashLookupKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function checkPreconditions(
  existing: EtaggedDocument | null,
  pre?: Preconditions,
  conflictCode = 'precondition_required',
): void {
  const ifMatch = pre?.ifMatch;
  const ifNoneMatch = pre?.ifNoneMatch;

  if (ifMatch?.length) {
    const ok = existing ? ifMatch.includes('*') || ifMatch.includes(existing.etag) : false;
    if (!ok) throw XapiError.preconditionFailed('If-Match precondition failed');
  }

  if (ifNoneMatch?.length) {
    const matched = existing
      ? ifNoneMatch.includes('*') || ifNoneMatch.includes(existing.etag)
      : false;
    if (matched) throw XapiError.preconditionFailed('If-None-Match precondition failed');
  }

  if (pre?.required && !ifMatch?.length && !ifNoneMatch?.length && existing) {
    throw XapiError.conflict(
      'This document already exists; send If-Match or If-None-Match to avoid losing a concurrent update',
      conflictCode,
    );
  }
}

export function isJsonContentType(contentType: string): boolean {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
}

/**
 * Top-level merge of a stored document and an incoming one (`POST`).
 *
 * Both sides must be JSON objects: the spec merges them at the top level, and
 * explicitly calls out that merging anything else is a 400 rather than a silent
 * overwrite.
 */
export function mergeJsonDocuments(
  existing: { contentType: string; content: Buffer },
  incoming: { contentType: string; content: Buffer },
  codePrefix: string,
): Buffer {
  if (!isJsonContentType(existing.contentType) || !isJsonContentType(incoming.contentType)) {
    throw XapiError.badRequest(
      'Cannot merge documents unless both the stored and the posted document are application/json',
      `${codePrefix}_merge_unsupported`,
    );
  }

  const merged = {
    ...parseJsonObject(existing.content, codePrefix),
    ...parseJsonObject(incoming.content, codePrefix),
  };
  return Buffer.from(JSON.stringify(merged));
}

function parseJsonObject(content: Buffer, codePrefix: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw XapiError.badRequest('Document is not valid JSON', `${codePrefix}_invalid_json`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw XapiError.badRequest('Only JSON objects can be merged', `${codePrefix}_merge_unsupported`);
  }
  return parsed as Record<string, unknown>;
}

/** Split an If-Match / If-None-Match header into individual etags. */
export function parseEtagHeader(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value.join(',') : value;
  const parts = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    // Weak comparison is good enough here: our etags are content hashes.
    .map((v) => (v.startsWith('W/') ? v.slice(2) : v));
  return parts.length ? parts : undefined;
}
