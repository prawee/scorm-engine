import type { Readable } from 'node:stream';

export interface StorageAdapter {
  put(key: string, body: Readable | Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Storage-backend-native absolute path for a key. Useful for local-disk static serving. */
  resolve?(key: string): string;
  /** Readiness probe: resolves when the backend is reachable and usable, throws otherwise. */
  check?(): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage key not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}
