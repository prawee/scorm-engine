import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteProfile,
  getProfile,
  listProfileIds,
  postProfile,
  putProfile,
  type ProfileKey,
  type ProfileOwner,
} from '../../src/xapi/profile.js';
import { XapiError } from '../../src/xapi/errors.js';
import type { Actor } from '../../src/xapi/types.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';

const ACTIVITY = 'http://example.com/courses/intro';
const AGENT: Actor = { mbox: 'mailto:ada@example.com' };

let lrs: MockLrs;

beforeEach(() => {
  lrs = createMockLrs();
});

const activityKey = (profileId = 'prefs', activityId = ACTIVITY): ProfileKey => ({
  tenantId: lrs.tenantId,
  scope: 'ACTIVITY',
  activityId,
  profileId,
});

const agentKey = (profileId = 'prefs', agent: Actor = AGENT): ProfileKey => ({
  tenantId: lrs.tenantId,
  scope: 'AGENT',
  agent,
  profileId,
});

const put = (key: ProfileKey, content: string, contentType = 'application/json') =>
  putProfile({ key, content: Buffer.from(content), contentType }, lrs.prisma);

describe('profile documents', () => {
  it('round-trips an activity profile with an etag', async () => {
    const written = await put(activityKey(), '{"theme":"dark"}');
    const read = await getProfile(activityKey(), lrs.prisma);

    expect(read?.content.toString()).toBe('{"theme":"dark"}');
    expect(read?.contentType).toBe('application/json');
    expect(read?.etag).toBe(written.etag);
    expect(written.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('round-trips an agent profile', async () => {
    await put(agentKey(), '{"locale":"en-GB"}');

    expect((await getProfile(agentKey(), lrs.prisma))?.content.toString()).toBe('{"locale":"en-GB"}');
  });

  it('returns null for a document that was never written', async () => {
    expect(await getProfile(activityKey(), lrs.prisma)).toBeNull();
  });

  it('keeps activity and agent profiles in separate namespaces', async () => {
    await put(activityKey(), '{"owner":"activity"}');
    await put(agentKey(), '{"owner":"agent"}');

    expect(lrs.profiles).toHaveLength(2);
    expect((await getProfile(activityKey(), lrs.prisma))?.content.toString()).toBe(
      '{"owner":"activity"}',
    );
    expect((await getProfile(agentKey(), lrs.prisma))?.content.toString()).toBe('{"owner":"agent"}');
  });

  it('keys documents per owner and profileId', async () => {
    await put(activityKey('a'), '{"n":1}');
    await put(activityKey('b'), '{"n":2}');
    await put(activityKey('a', 'http://example.com/other'), '{"n":3}');
    await put(agentKey('a', { mbox: 'mailto:grace@example.com' }), '{"n":4}');

    expect(lrs.profiles).toHaveLength(4);
  });

  it('identifies an agent by its IFI, not by how the actor is spelled', async () => {
    await put(agentKey(), '{"n":1}');
    // Same mbox, different casing and an added name — the same person.
    await put(agentKey('prefs', { name: 'Ada', mbox: 'mailto:ADA@example.com' }), '{"n":2}');

    expect(lrs.profiles).toHaveLength(1);
    expect((await getProfile(agentKey(), lrs.prisma))?.content.toString()).toBe('{"n":2}');
  });

  it('replaces on put and merges on post', async () => {
    await put(activityKey(), '{"a":1,"b":1}');
    await postProfile(
      { key: activityKey(), content: Buffer.from('{"b":2,"c":3}'), contentType: 'application/json' },
      lrs.prisma,
    );

    expect(JSON.parse((await getProfile(activityKey(), lrs.prisma))!.content.toString())).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });

    await put(activityKey(), '{"only":"this"}');
    expect(JSON.parse((await getProfile(activityKey(), lrs.prisma))!.content.toString())).toEqual({
      only: 'this',
    });
  });

  it('posts a brand new document without trying to merge', async () => {
    await postProfile(
      { key: activityKey(), content: Buffer.from('not json'), contentType: 'text/plain' },
      lrs.prisma,
    );

    expect((await getProfile(activityKey(), lrs.prisma))?.content.toString()).toBe('not json');
  });

  it('refuses to merge when either side is not JSON', async () => {
    await put(activityKey(), 'plain text', 'text/plain');

    await expect(
      postProfile(
        { key: activityKey(), content: Buffer.from('{"a":1}'), contentType: 'application/json' },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'profile_merge_unsupported' });
  });

  it('lists profile ids for one owner, newest first', async () => {
    await put(activityKey('first'), '{"n":1}');
    await put(activityKey('second'), '{"n":2}');
    await put(agentKey('agent-only'), '{"n":3}');

    const owner: ProfileOwner = { tenantId: lrs.tenantId, scope: 'ACTIVITY', activityId: ACTIVITY };
    expect(await listProfileIds({ owner }, lrs.prisma)).toEqual(['second', 'first']);

    const agentOwner: ProfileOwner = { tenantId: lrs.tenantId, scope: 'AGENT', agent: AGENT };
    expect(await listProfileIds({ owner: agentOwner }, lrs.prisma)).toEqual(['agent-only']);
  });

  it('filters listed ids by since', async () => {
    // `since` is exclusive, so the first document's own timestamp excludes it.
    const cutoff = (await put(activityKey('old'), '{"n":1}')).updatedAt;
    await put(activityKey('new'), '{"n":2}');

    const owner: ProfileOwner = { tenantId: lrs.tenantId, scope: 'ACTIVITY', activityId: ACTIVITY };
    expect(await listProfileIds({ owner, since: cutoff }, lrs.prisma)).toEqual(['new']);
  });

  it('deletes a document and tolerates deleting a missing one', async () => {
    await put(activityKey(), '{"n":1}');
    await deleteProfile(activityKey(), lrs.prisma);

    expect(await getProfile(activityKey(), lrs.prisma)).toBeNull();
    await expect(deleteProfile(activityKey(), lrs.prisma)).resolves.toBeUndefined();
  });

  it('isolates tenants', async () => {
    await put(activityKey(), '{"n":1}');

    expect(await getProfile({ ...activityKey(), tenantId: 'other_tenant' }, lrs.prisma)).toBeNull();
  });
});

describe('profile preconditions', () => {
  it('fails If-Match when the etag does not match', async () => {
    await put(activityKey(), '{"n":1}');

    await expect(
      putProfile(
        {
          key: activityKey(),
          content: Buffer.from('{"n":2}'),
          contentType: 'application/json',
          preconditions: { ifMatch: ['"nope"'] },
        },
        lrs.prisma,
      ),
    ).rejects.toBeInstanceOf(XapiError);
  });

  it('passes If-Match with the current etag', async () => {
    const written = await put(activityKey(), '{"n":1}');

    await expect(
      putProfile(
        {
          key: activityKey(),
          content: Buffer.from('{"n":2}'),
          contentType: 'application/json',
          preconditions: { ifMatch: [written.etag] },
        },
        lrs.prisma,
      ),
    ).resolves.toMatchObject({ profileId: 'prefs' });
  });

  it('fails If-None-Match: * when the document already exists', async () => {
    await put(activityKey(), '{"n":1}');

    await expect(
      putProfile(
        {
          key: activityKey(),
          content: Buffer.from('{"n":2}'),
          contentType: 'application/json',
          preconditions: { ifNoneMatch: ['*'] },
        },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 412 });
  });

  it('demands a precondition on overwrite when required is set', async () => {
    await put(activityKey(), '{"n":1}');

    await expect(
      putProfile(
        {
          key: activityKey(),
          content: Buffer.from('{"n":2}'),
          contentType: 'application/json',
          preconditions: { required: true },
        },
        lrs.prisma,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'profile_precondition_required' });
  });

  it('allows a first write with required set, since nothing can be lost', async () => {
    await expect(
      putProfile(
        {
          key: activityKey(),
          content: Buffer.from('{"n":1}'),
          contentType: 'application/json',
          preconditions: { required: true },
        },
        lrs.prisma,
      ),
    ).resolves.toMatchObject({ profileId: 'prefs' });
  });
});
