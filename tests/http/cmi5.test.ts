import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { CATEGORY, EXTENSION, VERBS } from '../../src/cmi5/constants.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';
import { AU1_IRI, AU2_IRI, BLOCK_IRI, buildCmi5Zip, cmi5Xml, multipart } from '../helpers/cmi5-fixture.js';

const BASE = '/api/v1/cmi5';
const ACTOR = { objectType: 'Agent', mbox: 'mailto:ada@example.com', name: 'Ada' };

let app: FastifyInstance;
let lrs: MockLrs;
let storage: MemoryStorage;

beforeEach(async () => {
  lrs = createMockLrs();
  storage = new MemoryStorage();
  app = await buildApp({ env: createTestEnv(), prisma: lrs.prisma, storage });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const key = () => ({ 'x-api-key': lrs.apiKey });

async function importCourse(zip = buildCmi5Zip()) {
  const { payload, headers } = multipart(zip);
  const res = await app.inject({ method: 'POST', url: `${BASE}/courses`, payload, headers: { ...headers, ...key() } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function register(courseId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/registrations`,
    headers: key(),
    payload: { courseId, actor: ACTOR },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function launch(registrationId: string, auId: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/registrations/${registrationId}/launch`,
    headers: { ...key(), host: 'lms.test' },
    payload: { auId, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Follow a launch URL the way an AU does: read the params, redeem the fetch URL. */
async function startAu(launchUrl: string) {
  const url = new URL(launchUrl);
  const fetchUrl = new URL(url.searchParams.get('fetch')!);
  const res = await app.inject({ method: 'POST', url: `${fetchUrl.pathname}${fetchUrl.search}` });
  expect(res.statusCode).toBe(200);
  const token = res.json()['auth-token'] as string;
  return {
    url,
    fetchUrl,
    activityId: url.searchParams.get('activityId')!,
    registration: url.searchParams.get('registration')!,
    actor: JSON.parse(url.searchParams.get('actor')!),
    headers: { authorization: `Basic ${token}`, 'x-experience-api-version': '1.0.3' },
  };
}

type Au = Awaited<ReturnType<typeof startAu>>;

async function launchData(au: Au) {
  const qs = new URLSearchParams({
    activityId: au.activityId,
    agent: JSON.stringify(au.actor),
    registration: au.registration,
    stateId: 'LMS.LaunchData',
  });
  const res = await app.inject({ method: 'GET', url: `/api/v1/xapi/activities/state?${qs}`, headers: au.headers });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function auStatement(au: Au, sessionId: string, verb: string, opts: { result?: unknown; moveOn?: boolean } = {}) {
  const category: Array<{ id: string }> = [{ id: CATEGORY.cmi5 }];
  if (opts.moveOn) category.push({ id: CATEGORY.moveOn });
  return {
    actor: au.actor,
    verb: { id: verb },
    object: { id: au.activityId },
    ...(opts.result ? { result: opts.result } : {}),
    context: {
      registration: au.registration,
      contextActivities: { category },
      extensions: { [EXTENSION.sessionId]: sessionId },
    },
  };
}

function send(au: Au, statements: unknown) {
  return app.inject({ method: 'POST', url: '/api/v1/xapi/statements', headers: au.headers, payload: statements as object });
}

describe('cmi5 course import', () => {
  it('imports a ZIP package and exposes its AUs in course order', async () => {
    const course = await importCourse();

    expect(course.title).toBe('Intro to cmi5');
    expect(course.hosted).toBe(true);
    expect(course.aus.map((a: { publisherId: string }) => a.publisherId)).toEqual([AU1_IRI, AU2_IRI]);
    expect(course.aus[0].activityId).toMatch(/^urn:uuid:/);
    expect(course.structure[1].type).toBe('block');
    expect(storage.files.has(`tenants/${lrs.tenantId}/cmi5/${course.id}/au1/index.html`)).toBe(true);

    const list = await app.inject({ method: 'GET', url: `${BASE}/courses`, headers: key() });
    expect(list.json().data).toHaveLength(1);
  });

  it('imports a bare cmi5.xml when every AU URL is absolute, and rejects relative ones', async () => {
    const abs = cmi5Xml({ au1Url: 'https://cdn.example.com/au1/', au2Url: 'https://cdn.example.com/au2/' });
    const ok = multipart(Buffer.from(abs), 'cmi5.xml');
    const res = await app.inject({ method: 'POST', url: `${BASE}/courses`, payload: ok.payload, headers: { ...ok.headers, ...key() } });
    expect(res.statusCode).toBe(201);
    expect(res.json().hosted).toBe(false);

    const rel = multipart(Buffer.from(cmi5Xml()), 'cmi5.xml');
    const bad = await app.inject({ method: 'POST', url: `${BASE}/courses`, payload: rel.payload, headers: { ...rel.headers, ...key() } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('relative_au_url');
  });

  it('validates without importing', async () => {
    const { payload, headers } = multipart(Buffer.from('<courseStructure/>'), 'cmi5.xml');
    const res = await app.inject({ method: 'POST', url: `${BASE}/courses/validate`, payload, headers: { ...headers, ...key() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: false, errors: [{ code: 'missing_course' }] });
    expect(lrs.cmi5.courses).toHaveLength(0);
  });

  it('requires an API key', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/courses` });
    expect(res.statusCode).toBe(401);
  });
});

describe('cmi5 launch flow', () => {
  it('runs a learner through both AUs to a satisfied course', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    expect(reg.aus.every((a: { satisfied: boolean }) => !a.satisfied)).toBe(true);

    // --- AU 1 --------------------------------------------------------------
    const launched = await launch(reg.id, AU1_IRI);
    expect(launched.launchMode).toBe('Normal');
    const au = await startAu(launched.url);

    expect(au.url.origin).toBe('http://lms.test');
    expect(au.url.pathname).toMatch(/^\/api\/v1\/cmi5\/content\/[^/]+\/au1\/index\.html$/);
    expect(au.url.searchParams.get('endpoint')).toBe('http://lms.test/api/v1/xapi/');
    expect(au.registration).toBe(reg.id);

    // The launched statement is already in the LRS.
    expect(lrs.statements.some((s) => s.verbId === VERBS.launched)).toBe(true);

    const data = await launchData(au);
    const sessionId = data.contextTemplate.extensions[EXTENSION.sessionId];
    expect(sessionId).toBe(launched.sessionId);
    expect(data).toMatchObject({ launchMode: 'Normal', moveOn: 'CompletedAndPassed', launchParameters: '{"level":1}' });
    expect(data.contextTemplate.contextActivities.grouping[0].id).toBe(AU1_IRI);

    // The engine-hosted AU content is reachable through the path token.
    const page = await app.inject({ method: 'GET', url: au.url.pathname });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('lesson 1');

    const res = await send(au, [
      auStatement(au, sessionId, VERBS.initialized),
      auStatement(au, sessionId, VERBS.completed, { moveOn: true, result: { completion: true } }),
      auStatement(au, sessionId, VERBS.passed, { moveOn: true, result: { success: true } }),
      auStatement(au, sessionId, VERBS.terminated),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(4);

    let view = (await app.inject({ method: 'GET', url: `${BASE}/registrations/${reg.id}`, headers: key() })).json();
    expect(view.aus[0]).toMatchObject({ completed: true, passed: true, satisfied: true });
    expect(view.satisfied).toBe(false);

    // Further statements in a terminated session are refused.
    const late = await send(au, auStatement(au, sessionId, 'http://adlnet.gov/expapi/verbs/experienced'));
    expect(late.statusCode).toBe(403);

    // --- AU 2 --------------------------------------------------------------
    const launched2 = await launch(reg.id, AU2_IRI);
    expect(launched2.launchMethod).toBe('OwnWindow');
    const au2 = await startAu(launched2.url);
    const sid2 = launched2.sessionId;
    expect(
      (await send(au2, [
        auStatement(au2, sid2, VERBS.initialized),
        auStatement(au2, sid2, VERBS.completed, { moveOn: true, result: { completion: true } }),
        auStatement(au2, sid2, VERBS.terminated),
      ])).statusCode,
    ).toBe(200);

    view = (await app.inject({ method: 'GET', url: `${BASE}/registrations/${reg.id}`, headers: key() })).json();
    expect(view.satisfied).toBe(true);
    expect(view.satisfiedAt).not.toBeNull();
    expect(view.blocks).toEqual([
      { publisherId: BLOCK_IRI, title: 'Block 1', satisfied: true, satisfiedAt: expect.any(String) },
    ]);

    // The block AU 2 sits in is satisfied first, then the course.
    const satisfied = lrs.statements.filter((s) => s.verbId === VERBS.satisfied);
    expect(satisfied).toHaveLength(2);
    const blockActivityId = course.structure[1].activityId;
    expect(blockActivityId).toMatch(/^urn:uuid:/);
    expect(satisfied.map((s) => s.objectId)).toEqual([blockActivityId, course.activityId]);
    const blockStatement = satisfied[0]!.statement as any;
    expect(blockStatement.object.definition.type).toBe('https://w3id.org/xapi/cmi5/activitytype/block');
    expect(blockStatement.context.contextActivities.grouping[0].id).toBe(BLOCK_IRI);
  });

  it('records a block as satisfied once, without waiting for the rest of the course', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    expect(reg.blocks).toEqual([{ publisherId: BLOCK_IRI, title: 'Block 1', satisfied: false, satisfiedAt: null }]);

    // Waiving AU 2 satisfies the block; AU 1 is still outstanding.
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/${reg.id}/waive`,
      headers: key(),
      payload: { auId: AU2_IRI, reason: 'Administrative' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ satisfied: false, blocks: [{ satisfied: true }] });

    // A later AU 1 waive satisfies the course, but must not repeat the block statement.
    await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/${reg.id}/waive`,
      headers: key(),
      payload: { auId: AU1_IRI, reason: 'Administrative' },
    });
    const satisfied = lrs.statements.filter((s) => s.verbId === VERBS.satisfied);
    expect(satisfied.map((s) => s.objectId)).toEqual([course.structure[1].activityId, course.activityId]);
  });

  it('lets a fetch URL be redeemed only once', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const { url } = await launch(reg.id, AU1_IRI);
    const au = await startAu(url);

    const again = await app.inject({ method: 'POST', url: `${au.fetchUrl.pathname}${au.fetchUrl.search}` });
    expect(again.statusCode).toBe(401);
    expect(again.json()['error-code']).toBe('1');

    const forged = await app.inject({ method: 'POST', url: `${au.fetchUrl.pathname}?session=x&key=y` });
    expect(forged.json()['error-code']).toBe('2');
  });

  it('accepts an identical resend of a batch that already landed', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const { url, sessionId } = await launch(reg.id, AU1_IRI);
    const au = await startAu(url);
    const batch = [
      { id: '55555555-5555-4555-8555-555555555555', ...auStatement(au, sessionId, VERBS.initialized) },
      {
        id: '66666666-6666-4666-8666-666666666666',
        ...auStatement(au, sessionId, VERBS.completed, { moveOn: true, result: { completion: true } }),
      },
    ];

    expect((await send(au, batch)).statusCode).toBe(200);
    const retry = await send(au, batch);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(lrs.statements.filter((s) => s.verbId === VERBS.completed)).toHaveLength(1);
  });

  it('rejects statements that break the cmi5 rules with 403 and stores nothing', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const { url, sessionId } = await launch(reg.id, AU1_IRI);
    const au = await startAu(url);
    const before = lrs.statements.length;

    const notInitialized = await send(
      au,
      auStatement(au, sessionId, VERBS.completed, { moveOn: true, result: { completion: true } }),
    );
    expect(notInitialized.statusCode).toBe(403);
    expect(notInitialized.json().code).toBe('cmi5_rule_violation');

    const lmsVerb = await send(au, auStatement(au, sessionId, VERBS.satisfied));
    expect(lmsVerb.statusCode).toBe(403);
    expect(lrs.statements.length).toBe(before);
  });

  it('scopes a session token to its own learner and registration', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const other = await register(course.id);
    await launch(other.id, AU1_IRI);
    const { url } = await launch(reg.id, AU1_IRI);
    const au = await startAu(url);

    const query = await app.inject({ method: 'GET', url: '/api/v1/xapi/statements', headers: au.headers });
    expect(query.statusCode).toBe(200);
    const registrations = query.json().statements.map((s: { context: { registration: string } }) => s.context.registration);
    expect(registrations.length).toBeGreaterThan(0);
    expect(new Set(registrations)).toEqual(new Set([reg.id]));

    const crossReg = await app.inject({
      method: 'GET',
      url: `/api/v1/xapi/statements?registration=${other.id}`,
      headers: au.headers,
    });
    expect(crossReg.statusCode).toBe(403);

    const qs = new URLSearchParams({
      activityId: au.activityId,
      agent: JSON.stringify({ mbox: 'mailto:eve@example.com' }),
      stateId: 'LMS.LaunchData',
    });
    const otherAgent = await app.inject({ method: 'GET', url: `/api/v1/xapi/activities/state?${qs}`, headers: au.headers });
    expect(otherAgent.statusCode).toBe(403);
  });

  it('abandons an initialized session when the AU is relaunched', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const first = await launch(reg.id, AU1_IRI);
    const au = await startAu(first.url);
    const init = await send(au, auStatement(au, first.sessionId, VERBS.initialized));
    expect(init.statusCode, init.body).toBe(200);

    await launch(reg.id, AU1_IRI);

    const abandoned = lrs.statements.filter((s) => s.verbId === VERBS.abandoned);
    expect(abandoned).toHaveLength(1);
    expect((abandoned[0]!.statement as any).context.extensions[EXTENSION.sessionId]).toBe(first.sessionId);

    // The abandoned session's token no longer writes.
    const res = await send(au, auStatement(au, first.sessionId, VERBS.terminated));
    expect(res.statusCode).toBe(403);
  });

  it('refuses moveOn statements in Browse mode', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const { url, sessionId } = await launch(reg.id, AU1_IRI, { launchMode: 'Browse' });
    const au = await startAu(url);
    expect((await launchData(au)).launchMode).toBe('Browse');

    const res = await send(au, [
      auStatement(au, sessionId, VERBS.initialized),
      auStatement(au, sessionId, VERBS.completed, { moveOn: true, result: { completion: true } }),
    ]);
    expect(res.statusCode).toBe(403);
  });

  it('waives an AU and counts it toward satisfaction', async () => {
    const course = await importCourse();
    const reg = await register(course.id);

    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/${reg.id}/waive`,
      headers: key(),
      payload: { auId: AU1_IRI, reason: 'Tested Out' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().aus[0]).toMatchObject({ waived: true, satisfied: true });
    expect(lrs.statements.some((s) => s.verbId === VERBS.waived)).toBe(true);

    const bad = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/${reg.id}/waive`,
      headers: key(),
      payload: { auId: AU2_IRI, reason: 'Because' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('404s an unknown registration or AU', async () => {
    const course = await importCourse();
    const reg = await register(course.id);
    const missingReg = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/nope/launch`,
      headers: key(),
      payload: { auId: AU1_IRI },
    });
    expect(missingReg.statusCode).toBe(404);

    const missingAu = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations/${reg.id}/launch`,
      headers: key(),
      payload: { auId: 'https://example.com/nope' },
    });
    expect(missingAu.statusCode).toBe(404);
    expect(missingAu.json().code).toBe('au_not_found');
  });
});

describe('cmi5 learner preferences', () => {
  const prefsUrl = (agent: unknown) =>
    `${BASE}/learner-preferences?agent=${encodeURIComponent(JSON.stringify(agent))}`;

  it('stores preferences as the cmi5LearnerPreferences agent profile the AU can read', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `${BASE}/learner-preferences`,
      headers: key(),
      payload: { actor: ACTOR, languagePreference: 'fr-FR, en-US', audioPreference: 'off' },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ languagePreference: 'fr-FR,en-US', audioPreference: 'off' });

    const get = await app.inject({ method: 'GET', url: prefsUrl(ACTOR), headers: key() });
    expect(get.json()).toEqual({ languagePreference: 'fr-FR,en-US', audioPreference: 'off' });

    // An AU session reads it through the LRS Agent Profile API.
    const course = await importCourse();
    const reg = await register(course.id);
    const au = await startAu((await launch(reg.id, AU1_IRI)).url);
    const qs = new URLSearchParams({ agent: JSON.stringify(au.actor), profileId: 'cmi5LearnerPreferences' });
    const viaLrs = await app.inject({ method: 'GET', url: `/api/v1/xapi/agents/profile?${qs}`, headers: au.headers });
    expect(viaLrs.statusCode, viaLrs.body).toBe(200);
    expect(viaLrs.json()).toEqual({ languagePreference: 'fr-FR,en-US', audioPreference: 'off' });
  });

  it('accepts preferences alongside a new registration', async () => {
    const course = await importCourse();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations`,
      headers: key(),
      payload: { courseId: course.id, learnerId: 'u-42', learnerPreferences: { audioPreference: 'on' } },
    });
    expect(res.statusCode).toBe(201);
    const get = await app.inject({ method: 'GET', url: `${BASE}/learner-preferences?learnerId=u-42`, headers: key() });
    expect(get.json()).toEqual({ audioPreference: 'on' });
  });

  it('rejects invalid values without creating a registration, and 404s a learner with none', async () => {
    const course = await importCourse();
    const bad = await app.inject({
      method: 'POST',
      url: `${BASE}/registrations`,
      headers: key(),
      payload: { courseId: course.id, actor: ACTOR, learnerPreferences: { audioPreference: 'loud' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_preferences');
    expect(lrs.cmi5.registrations).toHaveLength(0);

    const badLang = await app.inject({
      method: 'PUT',
      url: `${BASE}/learner-preferences`,
      headers: key(),
      payload: { actor: ACTOR, languagePreference: 'not a tag' },
    });
    expect(badLang.statusCode).toBe(400);

    const none = await app.inject({ method: 'GET', url: prefsUrl(ACTOR), headers: key() });
    expect(none.statusCode).toBe(404);
  });
});
