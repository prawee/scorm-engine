import { describe, expect, it } from 'vitest';

import { createStorage } from '../../src/storage/index.js';
import { isTenantKey, PrefixedStorage, tenantKey, tenantPrefix } from '../../src/storage/scoped.js';
import { LocalStorage } from '../../src/storage/local.js';
import { loadEnv, resetEnvForTests } from '../../src/config/env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createTestEnv } from '../helpers/test-env.js';

describe('tenant key layout', () => {
  it('roots every key under tenants/<id>', () => {
    expect(tenantPrefix('t1')).toBe('tenants/t1');
    expect(tenantKey('t1', 'courses', 'c-1')).toBe('tenants/t1/courses/c-1');
  });

  it('refuses ids and segments that could escape the prefix', () => {
    for (const bad of ['', '..', 'a/b', '../t2', 'a b']) {
      expect(() => tenantPrefix(bad)).toThrow();
      expect(() => tenantKey('t1', 'courses', bad)).toThrow();
    }
  });

  it('recognises keys that belong to the tenant', () => {
    expect(isTenantKey('t1', 'tenants/t1/courses/c1')).toBe(true);
    expect(isTenantKey('t1', 'tenants/t10/courses/c1')).toBe(false);
    expect(isTenantKey('t1', 'tenants/t2/courses/c1')).toBe(false);
    expect(isTenantKey('t1', 'tenants/t1/../t2/courses/c1')).toBe(false);
    expect(isTenantKey('t1', 'tenants/t1')).toBe(false);
  });
});

describe('PrefixedStorage', () => {
  it('stores, reads and deletes under the prefix', async () => {
    const inner = new MemoryStorage();
    const storage = new PrefixedStorage(inner, 'deploy-a/');
    await storage.put('tenants/t1/x.txt', Buffer.from('hi'));
    expect([...inner.files.keys()]).toEqual(['deploy-a/tenants/t1/x.txt']);
    expect(await storage.exists('tenants/t1/x.txt')).toBe(true);
    expect(await storage.signedUrl('tenants/t1/x.txt', 60)).toBe('mem://deploy-a/tenants/t1/x.txt');
    await storage.delete('tenants/t1');
    expect(inner.files.size).toBe(0);
  });

  it('rejects keys that climb out of the prefix', async () => {
    const storage = new PrefixedStorage(new MemoryStorage(), 'deploy-a');
    await expect(storage.get('../deploy-b/secret')).rejects.toThrow(/Invalid storage key/);
  });

  it('rejects unusable prefixes', () => {
    for (const bad of ['', '/', '..', 'a/../b', 'a//b']) {
      expect(() => new PrefixedStorage(new MemoryStorage(), bad)).toThrow();
    }
  });

  it('passes resolve() through when the inner driver has one', () => {
    const storage = new PrefixedStorage(new LocalStorage({ rootDir: '/srv/data' }), 'deploy-a');
    expect(storage.resolve?.('tenants/t1/a.html')).toBe('/srv/data/deploy-a/tenants/t1/a.html');
    expect(new PrefixedStorage(new MemoryStorage(), 'p').resolve).toBeUndefined();
  });
});

describe('createStorage', () => {
  it('wraps the driver when STORAGE_PREFIX is set', () => {
    expect(createStorage(createTestEnv({ STORAGE_PREFIX: 'deploy-a' }))).toBeInstanceOf(PrefixedStorage);
    expect(createStorage(createTestEnv())).toBeInstanceOf(LocalStorage);
  });

  it('validates STORAGE_PREFIX in the environment', () => {
    const base = {
      DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
      JWT_SECRET: 'x'.repeat(32),
    };
    resetEnvForTests();
    expect(() => loadEnv({ ...base, STORAGE_PREFIX: 'a/../b' })).toThrow(/STORAGE_PREFIX/);
    resetEnvForTests();
    expect(loadEnv({ ...base, STORAGE_PREFIX: 'prod/eu-1' }).STORAGE_PREFIX).toBe('prod/eu-1');
    resetEnvForTests();
    expect(loadEnv({ ...base, STORAGE_PREFIX: '' }).STORAGE_PREFIX).toBeUndefined();
    resetEnvForTests();
  });
});
