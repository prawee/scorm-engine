import type { Env } from '../config/env.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import { PrefixedStorage } from './scoped.js';
import type { StorageAdapter } from './types.js';

export { LocalStorage } from './local.js';
export { S3Error, S3Storage } from './s3.js';
export type { S3StorageOptions } from './s3.js';
export { isTenantKey, PrefixedStorage, tenantKey, tenantPrefix } from './scoped.js';
export { StorageNotFoundError } from './types.js';
export type { StorageAdapter } from './types.js';

export function createStorage(env: Env): StorageAdapter {
  const base = createDriver(env);
  return env.STORAGE_PREFIX ? new PrefixedStorage(base, env.STORAGE_PREFIX) : base;
}

function createDriver(env: Env): StorageAdapter {
  if (env.STORAGE_DRIVER === 'local') {
    return new LocalStorage({ rootDir: env.STORAGE_LOCAL_DIR });
  }
  if (env.STORAGE_DRIVER === 's3') {
    // loadEnv() guarantees these are set when STORAGE_DRIVER=s3.
    return new S3Storage({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  throw new Error(`Storage driver '${env.STORAGE_DRIVER}' is not implemented yet`);
}
