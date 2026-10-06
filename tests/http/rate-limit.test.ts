import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { TenantRateLimiter } from '../../src/http/rate-limit.js';
import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';

const KEYS: Record<string, string> = {
  sk_tenant_a: 'tenant_a',
  sk_tenant_a_second: 'tenant_a',
  sk_tenant_b: 'tenant_b',
};

function authPrisma() {
  return {
    apiKey: {
      findUnique: async ({ where }: any) => {
        const plaintext = Object.keys(KEYS).find((k) => hashApiKey(k) === where.hashedKey);
        return plaintext ? { id: plaintext, tenantId: KEYS[plaintext], revokedAt: null } : null;
      },
    },
    course: { findMany: async () => [], count: async () => 0 },
  } as unknown as PrismaClient;
}

describe('TenantRateLimiter', () => {
  it('allows `max` requests per window, then refuses until the window rolls over', () => {
    let now = 1_000_000;
    const limiter = new TenantRateLimiter({ max: 2, windowSeconds: 10, now: () => now });

    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 1, resetSeconds: 10 });
    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 0 });
    now += 4_000;
    expect(limiter.consume('t')).toMatchObject({ allowed: false, remaining: 0, resetSeconds: 6 });

    now += 6_000;
    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 1, resetSeconds: 10 });
  });

  it('keeps separate budgets per tenant', () => {
    const limiter = new TenantRateLimiter({ max: 1, windowSeconds: 60 });
    expect(limiter.consume('a')?.allowed).toBe(true);
    expect(limiter.consume('a')?.allowed).toBe(false);
    expect(limiter.consume('b')?.allowed).toBe(true);
  });

  it('applies per-tenant overrides, where 0 exempts the tenant', () => {
    const limiter = new TenantRateLimiter({
      max: 1,
      windowSeconds: 60,
      limitFor: (t) => ({ big: 3, exempt: 0 })[t],
    });
    expect(limiter.consume('big')?.limit).toBe(3);
    expect(limiter.consume('exempt')).toBeNull();
    expect(limiter.consume('other')?.limit).toBe(1);
  });

  it('is disabled when max is 0 and there are no overrides', () => {
    const limiter = new TenantRateLimiter({ max: 0, windowSeconds: 60 });
    expect(limiter.enabled).toBe(false);
    expect(limiter.consume('t')).toBeNull();
  });
});

describe('per-tenant rate limiting (HTTP)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function build(env = createTestEnv({ RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW_SECONDS: 60 })) {
    app = await buildApp({ env, prisma: authPrisma(), storage: new MemoryStorage() });
    await app.ready();
  }

  const list = (key: string) =>
    app.inject({ method: 'GET', url: '/api/v1/courses', headers: { 'x-api-key': key } });

  it('reports the budget in X-RateLimit-* headers', async () => {
    await build();
    const res = await list('sk_tenant_a');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('2');
    expect(res.headers['x-ratelimit-remaining']).toBe('1');
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('answers 429 with Retry-After once the tenant exhausts its budget', async () => {
    await build();
    await list('sk_tenant_a');
    await list('sk_tenant_a');
    const res = await list('sk_tenant_a');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('shares one budget across a tenant’s keys but not across tenants', async () => {
    await build();
    await list('sk_tenant_a');
    await list('sk_tenant_a_second');
    expect((await list('sk_tenant_a')).statusCode).toBe(429);
    expect((await list('sk_tenant_b')).statusCode).toBe(200);
  });

  it('does not count unauthenticated or rejected requests', async () => {
    await build();
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await list('sk_unknown')).statusCode).toBe(401);
    }
    expect((await list('sk_tenant_a')).statusCode).toBe(200);
  });

  it('is off by default', async () => {
    await build(createTestEnv());
    for (let i = 0; i < 5; i++) {
      const res = await list('sk_tenant_a');
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('accepts an injected limiter with per-tenant limits', async () => {
    app = await buildApp({
      env: createTestEnv(),
      prisma: authPrisma(),
      storage: new MemoryStorage(),
      rateLimiter: new TenantRateLimiter({ max: 0, windowSeconds: 60, limitFor: (t) => (t === 'tenant_b' ? 1 : undefined) }),
    });
    await app.ready();
    expect((await list('sk_tenant_b')).statusCode).toBe(200);
    expect((await list('sk_tenant_b')).statusCode).toBe(429);
    expect((await list('sk_tenant_a')).headers['x-ratelimit-limit']).toBeUndefined();
  });
});
