import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { WebhookDispatcher } from '../../src/webhooks/index.js';
import { verifySignature } from '../../src/webhooks/signing.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';
import { AU2_IRI, BLOCK_IRI, buildCmi5Zip, multipart } from '../helpers/cmi5-fixture.js';
import { CATEGORY, EXTENSION, VERBS } from '../../src/cmi5/constants.js';

const BASE = '/api/v1/webhooks';
const HOOK_URL = 'https://hooks.example.com/scormflow';

let app: FastifyInstance;
let lrs: MockLrs;
let dispatcher: WebhookDispatcher;
let status: number;
let received: Array<{ headers: Record<string, string>; body: string }>;

beforeEach(async () => {
  lrs = createMockLrs();
  status = 200;
  received = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    received.push({ headers: init!.headers as Record<string, string>, body: init!.body as string });
    return new Response(status === 200 ? 'thanks' : 'broken', { status });
  });
  dispatcher = new WebhookDispatcher({
    prisma: lrs.prisma,
    maxAttempts: 3,
    retryBaseSeconds: 30,
    timeoutMs: 1000,
    fetch: fetchMock as unknown as typeof fetch,
  });
  app = await buildApp({ env: createTestEnv(), prisma: lrs.prisma, storage: new MemoryStorage(), webhooks: dispatcher });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const key = () => ({ 'x-api-key': lrs.apiKey });

async function createHook(body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: BASE,
    headers: key(),
    payload: { url: HOOK_URL, events: ['*'], ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('webhook endpoint management', () => {
  it('creates an endpoint and shows the secret only on create and rotate', async () => {
    const hook = await createHook({ events: ['course.completed', 'course.completed'], description: 'CRM' });
    expect(hook).toMatchObject({ url: HOOK_URL, events: ['course.completed'], enabled: true, description: 'CRM' });
    expect(hook.secret).toMatch(/^whsec_/);

    const got = await app.inject({ method: 'GET', url: `${BASE}/${hook.id}`, headers: key() });
    expect(got.json().secret).toBeUndefined();
    const list = await app.inject({ method: 'GET', url: BASE, headers: key() });
    expect(list.json().data.map((h: { id: string }) => h.id)).toEqual([hook.id]);

    const rotated = await app.inject({ method: 'POST', url: `${BASE}/${hook.id}/rotate-secret`, headers: key() });
    expect(rotated.json().secret).toMatch(/^whsec_/);
    expect(rotated.json().secret).not.toBe(hook.secret);
  });

  it('validates the url and event types', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: 'http://169.254.169.254/latest', events: ['*'] }, 'invalid_url'],
      [{ url: 'ftp://example.com', events: ['*'] }, 'invalid_url'],
      [{ url: HOOK_URL, events: ['course.exploded'] }, 'invalid_events'],
      [{ url: HOOK_URL, events: [] }, 'invalid_events'],
      [{ events: ['*'] }, 'invalid_request'],
    ];
    for (const [payload, code] of cases) {
      const res = await app.inject({ method: 'POST', url: BASE, headers: key(), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
    }
  });

  it('updates, lists event types, deletes, and requires an API key', async () => {
    const hook = await createHook();
    const patched = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${hook.id}`,
      headers: key(),
      payload: { enabled: false, events: ['score.updated'] },
    });
    expect(patched.json()).toMatchObject({ enabled: false, events: ['score.updated'] });

    const types = await app.inject({ method: 'GET', url: `${BASE}/event-types`, headers: key() });
    expect(types.json().data).toContain('cmi5.course.satisfied');

    expect((await app.inject({ method: 'DELETE', url: `${BASE}/${hook.id}`, headers: key() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `${BASE}/${hook.id}`, headers: key() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: BASE })).statusCode).toBe(401);
  });

  it('keeps endpoints tenant-scoped', async () => {
    const hook = await createHook();
    lrs.webhooks.endpoints[0]!.tenantId = 'someone_else';
    expect((await app.inject({ method: 'GET', url: `${BASE}/${hook.id}`, headers: key() })).statusCode).toBe(404);
  });
});

describe('webhook test events and the delivery log', () => {
  it('sends a signed test event and records the delivery', async () => {
    const hook = await createHook({ events: ['course.completed'] });
    const res = await app.inject({ method: 'POST', url: `${BASE}/${hook.id}/test`, headers: key() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eventType: 'webhook.test', status: 'SUCCEEDED', attempts: 1, lastStatusCode: 200 });

    const [{ headers, body }] = received as [(typeof received)[number]];
    expect(verifySignature(hook.secret, headers['ScormFlow-Signature'], body)).toBe(true);
    expect(headers['ScormFlow-Delivery']).toBe(res.json().id);

    const log = await app.inject({ method: 'GET', url: `${BASE}/${hook.id}/deliveries`, headers: key() });
    expect(log.json().data).toHaveLength(1);
    expect(log.json().pagination).toEqual({ nextCursor: null, hasMore: false });
  });

  it('records a failure, filters the log by status, and retries on request', async () => {
    const hook = await createHook();
    status = 500;
    const failed = (await app.inject({ method: 'POST', url: `${BASE}/${hook.id}/test`, headers: key() })).json();
    expect(failed).toMatchObject({ status: 'PENDING', lastStatusCode: 500, lastResponse: 'broken' });
    expect(failed.nextAttemptAt).not.toBeNull();

    const pending = await app.inject({ method: 'GET', url: `${BASE}/${hook.id}/deliveries?status=pending`, headers: key() });
    expect(pending.json().data).toHaveLength(1);
    const none = await app.inject({ method: 'GET', url: `${BASE}/${hook.id}/deliveries?status=succeeded`, headers: key() });
    expect(none.json().data).toHaveLength(0);
    const bad = await app.inject({ method: 'GET', url: `${BASE}/${hook.id}/deliveries?status=lost`, headers: key() });
    expect(bad.statusCode).toBe(400);

    status = 200;
    const retried = await app.inject({ method: 'POST', url: `${BASE}/deliveries/${failed.id}/retry`, headers: key() });
    expect(retried.json()).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    // Same event id on the retry, so the receiver can tell it is a resend.
    expect(JSON.parse(received[1]!.body).id).toBe(JSON.parse(received[0]!.body).id);
  });

  it('404s a delivery from another tenant', async () => {
    const hook = await createHook();
    const delivery = (await app.inject({ method: 'POST', url: `${BASE}/${hook.id}/test`, headers: key() })).json();
    lrs.webhooks.deliveries[0]!.tenantId = 'someone_else';
    const res = await app.inject({ method: 'GET', url: `${BASE}/deliveries/${delivery.id}`, headers: key() });
    expect(res.statusCode).toBe(404);
  });
});

describe('cmi5 events', () => {
  it('publishes waive, block and course satisfaction to subscribed endpoints', async () => {
    await createHook({ events: ['cmi5.au.waived', 'cmi5.block.satisfied', 'cmi5.course.satisfied'] });

    const { payload, headers } = multipart(buildCmi5Zip());
    const course = (
      await app.inject({ method: 'POST', url: '/api/v1/cmi5/courses', payload, headers: { ...headers, ...key() } })
    ).json();
    const reg = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/cmi5/registrations',
        headers: key(),
        payload: { courseId: course.id, learnerId: 'u-1' },
      })
    ).json();

    for (const auId of [AU2_IRI, course.aus[0].publisherId]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cmi5/registrations/${reg.id}/waive`,
        headers: key(),
        payload: { auId, reason: 'Administrative' },
      });
      expect(res.statusCode).toBe(200);
    }
    await dispatcher.idle();

    const events = received.map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.type)).toEqual([
      'cmi5.au.waived',
      'cmi5.block.satisfied',
      'cmi5.au.waived',
      'cmi5.course.satisfied',
    ]);
    expect(events[1].data).toMatchObject({ registrationId: reg.id, block: { publisherId: BLOCK_IRI, title: 'Block 1' } });
    expect(events[0].data).toMatchObject({ courseId: course.id, au: { publisherId: AU2_IRI }, reason: 'Administrative' });
  });

  it('publishes session abandoned and terminated', async () => {
    await createHook({ events: ['cmi5.session.abandoned', 'cmi5.session.terminated'] });
    const { payload, headers } = multipart(buildCmi5Zip());
    const course = (
      await app.inject({ method: 'POST', url: '/api/v1/cmi5/courses', payload, headers: { ...headers, ...key() } })
    ).json();
    const reg = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/cmi5/registrations',
        headers: key(),
        payload: { courseId: course.id, learnerId: 'u-1' },
      })
    ).json();

    /** Launch AU 2, redeem its fetch URL, and send the given verbs as the AU. */
    const runAu = async (verbs: string[]) => {
      const launched = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/cmi5/registrations/${reg.id}/launch`,
          headers: { ...key(), host: 'lms.test' },
          payload: { auId: AU2_IRI },
        })
      ).json();
      const url = new URL(launched.url);
      const fetchUrl = new URL(url.searchParams.get('fetch')!);
      const token = (await app.inject({ method: 'POST', url: `${fetchUrl.pathname}${fetchUrl.search}` })).json()[
        'auth-token'
      ];
      const statements = verbs.map((verb) => ({
        actor: JSON.parse(url.searchParams.get('actor')!),
        verb: { id: verb },
        object: { id: url.searchParams.get('activityId')! },
        context: {
          registration: reg.id,
          contextActivities: { category: [{ id: CATEGORY.cmi5 }] },
          extensions: { [EXTENSION.sessionId]: launched.sessionId },
        },
      }));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/xapi/statements',
        headers: { authorization: `Basic ${token}`, 'x-experience-api-version': '1.0.3' },
        payload: statements,
      });
      expect(res.statusCode, res.body).toBe(200);
      return launched.sessionId as string;
    };

    const first = await runAu([VERBS.initialized]);
    const second = await runAu([VERBS.initialized, VERBS.terminated]); // relaunch abandons the first
    await dispatcher.idle();

    const events = received.map((r) => JSON.parse(r.body));
    expect(events.map((e) => [e.type, e.data.sessionId])).toEqual([
      ['cmi5.session.abandoned', first],
      ['cmi5.session.terminated', second],
    ]);
    expect(events[1].data).toMatchObject({ launchMode: 'Normal', au: { publisherId: AU2_IRI } });
  });
});
