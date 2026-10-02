import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteState,
  deleteStates,
  getState,
  listStateIds,
  parseEtagHeader,
  postState,
  putState,
  type StateKey,
} from '../../src/xapi/state.js';
import type { Actor } from '../../src/xapi/types.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';

const ACTIVITY = 'http://example.com/courses/intro';
const AGENT: Actor = { mbox: 'mailto:ada@example.com' };

let lrs: MockLrs;

const key = (overrides: Partial<StateKey> = {}): StateKey => ({
  tenantId: lrs.tenantId,
  activityId: ACTIVITY,
  agent: AGENT,
  stateId: 'bookmark',
  ...overrides,
});

const put = (content: string, overrides: Partial<StateKey> = {}, contentType = 'application/json') =>
  putState({ key: key(overrides), content: Buffer.from(content), contentType }, lrs.prisma);

beforeEach(() => {
  lrs = createMockLrs();
});

describe('state documents', () => {
  it('round-trips a document with an etag', async () => {
    const written = await put('{"page":2}');
    const read = await getState(key(), lrs.prisma);

    expect(read?.content.toString()).toBe('{"page":2}');
    expect(read?.contentType).toBe('application/json');
    expect(read?.etag).toBe(written.etag);
    expect(written.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('returns null for a document that was never written', async () => {
    expect(await getState(key(), lrs.prisma)).toBeNull();
  });

  it('keys documents separately per agent, activity, registration and stateId', async () => {
    await put('{"a":1}');
    await put('{"b":1}', { agent: { mbox: 'mailto:grace@example.com' } });
    await put('{"c":1}', { registration: 'reg-1' });
    await put('{"d":1}', { stateId: 'other' });

    expect(lrs.states).toHaveLength(4);
    expect((await getState(key(), lrs.prisma))?.content.toString()).toBe('{"a":1}');
    expect((await getState(key({ registration: 'reg-1' }), lrs.prisma))?.content.toString()).toBe(
      '{"c":1}',
    );
  });

  it('identifies the agent by its IFI, not by how the client spelled it', async () => {
    await put('{"a":1}');
    const read = await getState(
      key({ agent: { name: 'Ada', objectType: 'Agent', mbox: 'mailto:ADA@example.com' } }),
      lrs.prisma,
    );
    expect(read?.content.toString()).toBe('{"a":1}');
  });

  it('replaces on PUT and merges on POST', async () => {
    await put('{"page":2,"notes":"a"}');
    await postState(
      {
        key: key(),
        content: Buffer.from('{"page":3}'),
        contentType: 'application/json',
      },
      lrs.prisma,
    );

    const merged = JSON.parse((await getState(key(), lrs.prisma))!.content.toString());
    expect(merged).toEqual({ page: 3, notes: 'a' });

    await put('{"page":9}');
    expect(JSON.parse((await getState(key(), lrs.prisma))!.content.toString())).toEqual({ page: 9 });
  });

  it('refuses to merge when either side is not JSON', async () => {
    await put('plain text', {}, 'text/plain');
    await expect(
      postState(
        { key: key(), content: Buffer.from('{"a":1}'), contentType: 'application/json' },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('stores a non-JSON document verbatim', async () => {
    const written = await put('plain text', {}, 'text/plain; charset=utf-8');
    expect(written.contentType).toBe('text/plain; charset=utf-8');
    expect((await getState(key(), lrs.prisma))?.content.toString()).toBe('plain text');
  });

  it('enforces If-Match and If-None-Match', async () => {
    const first = await put('{"v":1}');

    await expect(
      putState(
        {
          key: key(),
          content: Buffer.from('{"v":2}'),
          contentType: 'application/json',
          preconditions: { ifMatch: ['"stale"'] },
        },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 412 });

    await expect(
      putState(
        {
          key: key(),
          content: Buffer.from('{"v":2}'),
          contentType: 'application/json',
          preconditions: { ifNoneMatch: ['*'] },
        },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 412 });

    const updated = await putState(
      {
        key: key(),
        content: Buffer.from('{"v":2}'),
        contentType: 'application/json',
        preconditions: { ifMatch: [first.etag] },
      },
      lrs.prisma,
    );
    expect(updated.etag).not.toBe(first.etag);
  });

  it('requires a precondition header only when configured to', async () => {
    await put('{"v":1}');

    await expect(
      putState(
        {
          key: key(),
          content: Buffer.from('{"v":2}'),
          contentType: 'application/json',
          preconditions: { required: true },
        },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // Same write without the strict flag succeeds.
    await expect(put('{"v":2}')).resolves.toBeDefined();
  });

  it('lists state ids for an activity and agent', async () => {
    await put('{}', { stateId: 'bookmark' });
    await put('{}', { stateId: 'prefs' });
    await put('{}', { agent: { mbox: 'mailto:grace@example.com' }, stateId: 'theirs' });

    const ids = await listStateIds(
      { tenantId: lrs.tenantId, activityId: ACTIVITY, agent: AGENT },
      lrs.prisma,
    );
    expect(ids.sort()).toEqual(['bookmark', 'prefs']);
  });

  it('deletes one document and all documents', async () => {
    await put('{}', { stateId: 'bookmark' });
    await put('{}', { stateId: 'prefs' });

    await deleteState(key({ stateId: 'bookmark' }), lrs.prisma);
    expect(await getState(key({ stateId: 'bookmark' }), lrs.prisma)).toBeNull();
    expect(lrs.states).toHaveLength(1);

    const removed = await deleteStates(
      { tenantId: lrs.tenantId, activityId: ACTIVITY, agent: AGENT },
      lrs.prisma,
    );
    expect(removed).toBe(1);
    expect(lrs.states).toHaveLength(0);
  });

  it('is scoped to the tenant', async () => {
    await put('{"a":1}');
    expect(await getState(key({ tenantId: 'other_tenant' }), lrs.prisma)).toBeNull();
  });
});

describe('parseEtagHeader', () => {
  it('splits a list and strips weak markers', () => {
    expect(parseEtagHeader('"a", W/"b"')).toEqual(['"a"', '"b"']);
    expect(parseEtagHeader(undefined)).toBeUndefined();
    expect(parseEtagHeader('')).toBeUndefined();
  });
});
