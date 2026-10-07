import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { StorageNotFoundError, type StorageAdapter } from './types.js';

export interface LocalStorageOptions {
  rootDir: string;
}

export class LocalStorage implements StorageAdapter {
  readonly #rootDir: string;

  constructor(options: LocalStorageOptions) {
    this.#rootDir = path.resolve(options.rootDir);
  }

  resolve(key: string): string {
    const normalized = path.posix.normalize(key).replace(/^\/+/, '');
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(this.#rootDir, normalized);
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, createWriteStream(target));
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolve(key);
    if (!(await this.exists(key))) {
      throw new StorageNotFoundError(key);
    }
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolve(key);
    await rm(target, { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Readiness probe: the root directory exists (or can be created) and is writable. */
  async check(): Promise<void> {
    await mkdir(this.#rootDir, { recursive: true });
    await access(this.#rootDir, constants.R_OK | constants.W_OK);
  }

  async signedUrl(key: string, _ttlSeconds: number): Promise<string> {
    if (!(await this.exists(key))) {
      throw new StorageNotFoundError(key);
    }
    return `file://${this.resolve(key)}`;
  }
}
