import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import type { PrismaClient } from '../../src/db/client.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';

describe('buildApp', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ env: createTestEnv() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('health endpoints', () => {
    it('GET /healthz returns 200 with status and version', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', version: expect.any(String) });
    });

    it('serves /health and /ready inside the versioned API too', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toMatchObject({ status: 'ok' });
      expect((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode).not.toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/healthz' })).statusCode).toBe(404);
    });
  });

  describe('readiness', () => {
    async function readiness(deps: { db: () => Promise<unknown>; storage?: () => Promise<void> }) {
      const storage = new MemoryStorage();
      if (deps.storage) Object.assign(storage, { check: deps.storage });
      const prisma = { $queryRaw: deps.db } as unknown as PrismaClient;
      const probe = await buildApp({ env: createTestEnv(), prisma, storage });
      try {
        const [root, api] = await Promise.all([
          probe.inject({ method: 'GET', url: '/readyz' }),
          probe.inject({ method: 'GET', url: '/api/v1/ready' }),
        ]);
        expect(api.statusCode).toBe(root.statusCode);
        expect(api.json()).toEqual(root.json());
        return { status: root.statusCode, body: root.json() };
      } finally {
        await probe.close();
      }
    }

    it('reports ready when the database and storage respond', async () => {
      const res = await readiness({ db: async () => [{ '?column?': 1 }], storage: async () => undefined });
      expect(res).toEqual({ status: 200, body: { status: 'ready', checks: { database: 'ok', storage: 'ok' } } });
    });

    it('returns 503 and names the failing dependency', async () => {
      const res = await readiness({
        db: async () => [],
        storage: async () => {
          throw new Error('bucket gone');
        },
      });
      expect(res).toEqual({ status: 503, body: { status: 'not_ready', checks: { database: 'ok', storage: 'error' } } });
    });

    it('reports a failing database without leaking error details', async () => {
      const res = await readiness({ db: () => Promise.reject(new Error('password authentication failed')) });
      expect(res.status).toBe(503);
      expect(res.body.checks.database).toBe('error');
      expect(JSON.stringify(res.body)).not.toContain('password');
    });
  });

  describe('versioned API root', () => {
    it('GET /api/v1/ returns server name and version', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ name: '@scormflow/server' });
      expect(typeof body.version).toBe('string');
    });
  });

  describe('error handling', () => {
    it('returns a structured 404 for unknown routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/this-does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
    });

    it('returns 404 for unknown methods on a known path', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/healthz' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('CORS', () => {
    it('responds to a preflight request with permissive Allow-Origin headers', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('JWT plugin registration', () => {
    it('decorates the fastify instance with jwt', () => {
      expect(typeof app.jwt).toBe('object');
      expect(typeof app.jwt.sign).toBe('function');
      expect(typeof app.jwt.verify).toBe('function');
    });

    it('can sign and verify a payload round-trip', async () => {
      const token = app.jwt.sign({ attemptId: 'abc123' });
      const decoded = app.jwt.verify<{ attemptId: string }>(token);
      expect(decoded.attemptId).toBe('abc123');
    });
  });
});
