import type { Readable } from 'node:stream';

import type { StorageAdapter } from './types.js';

/**
 * Storage key layout.
 *
 * Every tenant's files live under `tenants/<tenantId>/`, and nothing the engine
 * writes on a tenant's behalf may leave that prefix. Keys are built here and
 * nowhere else so the layout has exactly one definition.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The root every key for `tenantId` lives under. Throws on ids that could escape it. */
export function tenantPrefix(tenantId: string): string {
  if (!SAFE_SEGMENT.test(tenantId)) {
    throw new Error(`Unsafe tenant id for storage: ${JSON.stringify(tenantId)}`);
  }
  return `tenants/${tenantId}`;
}

/** Join path segments under the tenant's prefix, e.g. `tenantKey(t, 'courses', id)`. */
export function tenantKey(tenantId: string, ...segments: string[]): string {
  for (const s of segments) {
    if (!SAFE_SEGMENT.test(s)) throw new Error(`Unsafe storage key segment: ${JSON.stringify(s)}`);
  }
  return [tenantPrefix(tenantId), ...segments].join('/');
}

/** Whether `key` (as persisted on a course) sits inside the tenant's prefix. */
export function isTenantKey(tenantId: string, key: string): boolean {
  const prefix = `${tenantPrefix(tenantId)}/`;
  return key.startsWith(prefix) && !key.split('/').includes('..');
}

/**
 * An adapter that transparently roots every key under `prefix`. Used for the
 * deployment-wide `STORAGE_PREFIX`, so several engines can share one bucket.
 */
export class PrefixedStorage implements StorageAdapter {
  readonly #inner: StorageAdapter;
  readonly #prefix: string;

  constructor(inner: StorageAdapter, prefix: string) {
    const trimmed = prefix.replace(/^\/+|\/+$/g, '');
    if (!trimmed || trimmed.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`Invalid storage prefix: ${JSON.stringify(prefix)}`);
    }
    this.#inner = inner;
    this.#prefix = trimmed;
    if (inner.resolve) {
      const resolveInner = inner.resolve.bind(inner);
      this.resolve = (key: string) => resolveInner(this.#key(key));
    }
    if (inner.check) this.check = inner.check.bind(inner);
  }

  resolve?: (key: string) => string;
  check?: () => Promise<void>;

  #key(key: string): string {
    const rel = key.replace(/^\/+/, '');
    if (rel.split('/').includes('..')) throw new Error(`Invalid storage key: ${key}`);
    return `${this.#prefix}/${rel}`;
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    return this.#inner.put(this.#key(key), body);
  }

  async get(key: string): Promise<Readable> {
    return this.#inner.get(this.#key(key));
  }

  async delete(key: string): Promise<void> {
    return this.#inner.delete(this.#key(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.#inner.exists(this.#key(key));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.#inner.signedUrl(this.#key(key), ttlSeconds);
  }
}
