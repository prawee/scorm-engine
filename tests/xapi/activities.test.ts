import { beforeEach, describe, expect, it } from 'vitest';

import { getActivity, getPerson } from '../../src/xapi/activities.js';
import { storeStatements } from '../../src/xapi/statements.js';
import type { Actor } from '../../src/xapi/types.js';

import { createMockLrs, sampleStatement, type MockLrs } from '../helpers/mock-lrs.js';

const ACTIVITY = 'http://example.com/courses/intro';
const AGENT: Actor = { mbox: 'mailto:ada@example.com' };

let lrs: MockLrs;

beforeEach(() => {
  lrs = createMockLrs();
});

const AUTHORITY: Actor = { mbox: 'mailto:lrs@example.com' };

const store = (...statements: Record<string, unknown>[]) =>
  storeStatements({ tenantId: lrs.tenantId, statements, authority: AUTHORITY }, lrs.prisma);

/** Store at an explicit instant, so "newest wins" is not left to a tie. */
const storeAt = (at: string, statement: Record<string, unknown>) =>
  storeStatements(
    {
      tenantId: lrs.tenantId,
      statements: [statement],
      authority: AUTHORITY,
      now: new Date(at),
    },
    lrs.prisma,
  );

describe('activity lookup', () => {
  it('returns null for an activity no statement mentions', async () => {
    expect(await getActivity(lrs.tenantId, ACTIVITY, lrs.prisma)).toBeNull();
  });

  it('returns the activity once a statement references it', async () => {
    await store(sampleStatement());

    expect(await getActivity(lrs.tenantId, ACTIVITY, lrs.prisma)).toEqual({
      objectType: 'Activity',
      id: ACTIVITY,
    });
  });

  it('returns the definition a statement supplied', async () => {
    await store(
      sampleStatement({
        object: {
          id: ACTIVITY,
          definition: { name: { 'en-US': 'Intro' }, type: 'http://adlnet.gov/expapi/activities/course' },
        },
      }),
    );

    const activity = await getActivity(lrs.tenantId, ACTIVITY, lrs.prisma);
    expect(activity).toMatchObject({
      id: ACTIVITY,
      definition: {
        name: { 'en-US': 'Intro' },
        type: 'http://adlnet.gov/expapi/activities/course',
      },
    });
  });

  it('merges language maps across statements and lets the newest value win', async () => {
    await storeAt(
      '2026-01-01T00:00:00Z',
      sampleStatement({
        object: {
          id: ACTIVITY,
          definition: { name: { 'en-US': 'Intro' }, interactionType: 'true-false' },
        },
      }),
    );
    await storeAt(
      '2026-01-02T00:00:00Z',
      sampleStatement({
        object: { id: ACTIVITY, definition: { name: { fr: 'Intro FR' }, interactionType: 'choice' } },
      }),
    );

    const activity = await getActivity(lrs.tenantId, ACTIVITY, lrs.prisma);
    expect(activity).toMatchObject({
      definition: {
        name: { 'en-US': 'Intro', fr: 'Intro FR' },
        interactionType: 'choice',
      },
    });
  });

  it('finds an activity that only appears in contextActivities', async () => {
    const parent = 'http://example.com/courses/parent';
    await store(
      sampleStatement({
        context: {
          contextActivities: {
            parent: [{ id: parent, definition: { name: { 'en-US': 'Parent' } } }],
          },
        },
      }),
    );

    expect(await getActivity(lrs.tenantId, parent, lrs.prisma)).toMatchObject({
      id: parent,
      definition: { name: { 'en-US': 'Parent' } },
    });
  });

  it('isolates tenants', async () => {
    await store(sampleStatement());

    expect(await getActivity('other_tenant', ACTIVITY, lrs.prisma)).toBeNull();
  });
});

describe('agent (person) lookup', () => {
  it('returns a Person carrying just the IFI for an unknown agent', async () => {
    expect(await getPerson(lrs.tenantId, AGENT, lrs.prisma)).toEqual({
      objectType: 'Person',
      mbox: ['mailto:ada@example.com'],
    });
  });

  it('collects the names seen alongside one IFI', async () => {
    await store(sampleStatement({ actor: { name: 'Ada', mbox: 'mailto:ada@example.com' } }));
    await store(sampleStatement({ actor: { name: 'Ada L.', mbox: 'mailto:ada@example.com' } }));

    const person = await getPerson(lrs.tenantId, AGENT, lrs.prisma);
    expect(person.objectType).toBe('Person');
    expect(person.mbox).toEqual(['mailto:ada@example.com']);
    expect(person.name).toEqual(expect.arrayContaining(['Ada', 'Ada L.']));
  });

  it('ignores actors with a different IFI', async () => {
    await store(sampleStatement({ actor: { name: 'Grace', mbox: 'mailto:grace@example.com' } }));

    const person = await getPerson(lrs.tenantId, AGENT, lrs.prisma);
    expect(person.name).toBeUndefined();
  });

  it('picks up an agent that appears as the instructor', async () => {
    await store(
      sampleStatement({
        actor: { mbox: 'mailto:grace@example.com' },
        context: { instructor: { name: 'Ada', mbox: 'mailto:ada@example.com' } },
      }),
    );

    expect(await getPerson(lrs.tenantId, AGENT, lrs.prisma)).toMatchObject({ name: ['Ada'] });
  });

  it('reports an account IFI as an object, not a string', async () => {
    const agent: Actor = { account: { homePage: 'https://example.com', name: 'ada' } };
    await store(sampleStatement({ actor: { name: 'Ada', ...agent } }));

    expect(await getPerson(lrs.tenantId, agent, lrs.prisma)).toMatchObject({
      account: [{ homePage: 'https://example.com', name: 'ada' }],
      name: ['Ada'],
    });
  });
});
