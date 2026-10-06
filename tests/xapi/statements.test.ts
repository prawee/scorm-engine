import { beforeEach, describe, expect, it } from 'vitest';

import { XapiError } from '../../src/xapi/errors.js';
import {
  getStatement,
  queryStatements,
  storeStatements,
  XAPI_VERSION,
} from '../../src/xapi/statements.js';
import { VOIDED_VERB } from '../../src/xapi/schema.js';
import type { Actor } from '../../src/xapi/types.js';
import { createMockLrs, sampleStatement, type MockLrs } from '../helpers/mock-lrs.js';

const AUTHORITY: Actor = {
  objectType: 'Agent',
  account: { homePage: 'https://scormflow.test/lrs', name: 'tenant_test' },
};

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

let lrs: MockLrs;

const store = (statements: unknown[], extra: Record<string, unknown> = {}) =>
  storeStatements(
    { tenantId: lrs.tenantId, statements, authority: AUTHORITY, ...extra },
    lrs.prisma,
  );

beforeEach(() => {
  lrs = createMockLrs();
});

describe('storeStatements', () => {
  it('assigns an id, timestamp, authority and version', async () => {
    const result = await store([sampleStatement()]);

    expect(result.ids).toHaveLength(1);
    const stored = lrs.statements[0]!.statement as Record<string, unknown>;
    expect(stored.id).toBe(result.ids[0]);
    expect(stored.authority).toEqual(AUTHORITY);
    expect(stored.version).toBe(XAPI_VERSION);
    expect(typeof stored.timestamp).toBe('string');
    expect(typeof stored.stored).toBe('string');
  });

  it('keeps a client-supplied id, lowercased', async () => {
    const result = await store([sampleStatement({ id: ID_A.toUpperCase() })]);
    expect(result.ids).toEqual([ID_A]);
  });

  it('rejects an invalid statement with a 400', async () => {
    await expect(store([{ actor: { name: 'Ada' }, verb: { id: 'nope' } }])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('treats a byte-identical resend as a duplicate, not a conflict', async () => {
    await store([sampleStatement({ id: ID_A })]);
    const again = await store([sampleStatement({ id: ID_A })]);

    expect(again.duplicates).toEqual([ID_A]);
    expect(lrs.statements).toHaveLength(1);
  });

  it('rejects a different statement under an existing id', async () => {
    await store([sampleStatement({ id: ID_A })]);

    await expect(
      store([sampleStatement({ id: ID_A, verb: { id: 'http://example.com/verbs/other' } })]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a batch that repeats an id', async () => {
    await expect(
      store([sampleStatement({ id: ID_A }), sampleStatement({ id: ID_A })]),
    ).rejects.toBeInstanceOf(XapiError);
  });

  it('honours the statementId parameter and catches a mismatched body id', async () => {
    await store([sampleStatement()], { statementId: ID_A });
    expect(lrs.statements[0]!.statementId).toBe(ID_A);

    await expect(
      store([sampleStatement({ id: ID_B })], { statementId: ID_A }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('marks the target of a voiding statement as voided', async () => {
    await store([sampleStatement({ id: ID_A })]);
    await store([
      sampleStatement({
        id: ID_B,
        verb: { id: VOIDED_VERB },
        object: { objectType: 'StatementRef', id: ID_A },
      }),
    ]);

    expect(lrs.statements.find((s) => s.statementId === ID_A)!.voided).toBe(true);
    expect(lrs.statements.find((s) => s.statementId === ID_B)!.voided).toBe(false);
  });

  it('does not let a voiding statement itself be voided', async () => {
    await store([sampleStatement({ id: ID_A })]);
    await store([
      sampleStatement({
        id: ID_B,
        verb: { id: VOIDED_VERB },
        object: { objectType: 'StatementRef', id: ID_A },
      }),
    ]);
    await store([
      sampleStatement({
        verb: { id: VOIDED_VERB },
        object: { objectType: 'StatementRef', id: ID_B },
      }),
    ]);

    expect(lrs.statements.find((s) => s.statementId === ID_B)!.voided).toBe(false);
  });

  it('indexes related activities and agents for broadened queries', async () => {
    await store([
      sampleStatement({
        context: {
          instructor: { mbox: 'mailto:teacher@example.com' },
          contextActivities: { parent: { id: 'http://example.com/courses' } },
        },
      }),
    ]);

    const row = lrs.statements[0]!;
    expect(row.relatedActivities).toEqual(
      expect.arrayContaining(['http://example.com/courses/intro', 'http://example.com/courses']),
    );
    expect(row.relatedAgents).toEqual(
      expect.arrayContaining(['mbox:mailto:ada@example.com', 'mbox:mailto:teacher@example.com']),
    );
  });

  it('reports each newly stored statement once, skipping duplicates', async () => {
    const events: Array<{ tenantId: string; type: string; data: Record<string, any> }> = [];
    const sink = { emit: (tenantId: string, type: string, data: Record<string, any>) => events.push({ tenantId, type, data }) };

    await store([sampleStatement({ id: ID_A })], { events: sink });
    await store([sampleStatement({ id: ID_A }), sampleStatement({ id: ID_B })], { events: sink });

    expect(events.map((e) => [e.type, e.data.statementId])).toEqual([
      ['xapi.statement.stored', ID_A],
      ['xapi.statement.stored', ID_B],
    ]);
    expect(events[0]).toMatchObject({
      tenantId: lrs.tenantId,
      data: {
        actor: 'mbox:mailto:ada@example.com',
        objectType: 'Activity',
        objectId: 'http://example.com/courses/intro',
        registration: null,
        voidsStatementId: null,
        statement: { id: ID_A, version: XAPI_VERSION },
      },
    });
  });

  it('reports nothing when a batch is rejected', async () => {
    const events: unknown[] = [];
    const sink = { emit: (...args: unknown[]) => events.push(args) };
    await store([sampleStatement({ id: ID_A })]);

    await expect(
      store(
        [sampleStatement({ id: ID_B }), sampleStatement({ id: ID_A, verb: { id: 'http://example.com/verbs/other' } })],
        { events: sink },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(events).toEqual([]);
  });
});

describe('getStatement', () => {
  it('returns a stored statement and hides voided ones', async () => {
    await store([sampleStatement({ id: ID_A })]);
    expect(await getStatement(lrs.tenantId, ID_A, {}, lrs.prisma)).toMatchObject({ id: ID_A });

    await store([
      sampleStatement({
        verb: { id: VOIDED_VERB },
        object: { objectType: 'StatementRef', id: ID_A },
      }),
    ]);

    expect(await getStatement(lrs.tenantId, ID_A, {}, lrs.prisma)).toBeNull();
    expect(
      await getStatement(lrs.tenantId, ID_A, { voided: true }, lrs.prisma),
    ).toMatchObject({ id: ID_A });
  });

  it('is scoped to the tenant', async () => {
    await store([sampleStatement({ id: ID_A })]);
    expect(await getStatement('other_tenant', ID_A, {}, lrs.prisma)).toBeNull();
  });

  it('reduces a statement to identifiers with format=ids', async () => {
    await store([sampleStatement({ id: ID_A })]);
    const projected = (await getStatement(
      lrs.tenantId,
      ID_A,
      { format: 'ids' },
      lrs.prisma,
    )) as Record<string, any>;

    expect(projected).toEqual({
      id: ID_A,
      actor: { mbox: 'mailto:ada@example.com' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      object: { objectType: 'Activity', id: 'http://example.com/courses/intro' },
    });
  });
});

describe('queryStatements', () => {
  const activity = 'http://example.com/courses/intro';

  beforeEach(async () => {
    await store([
      sampleStatement({ id: ID_A }),
      sampleStatement({
        id: ID_B,
        actor: { mbox: 'mailto:grace@example.com' },
        verb: { id: 'http://adlnet.gov/expapi/verbs/attempted' },
        object: { id: 'http://example.com/courses/advanced' },
        context: { contextActivities: { parent: { id: activity } } },
      }),
    ]);
  });

  it('filters by verb, activity and agent', async () => {
    const byVerb = await queryStatements(
      { tenantId: lrs.tenantId, verb: 'http://adlnet.gov/expapi/verbs/attempted' },
      lrs.prisma,
    );
    expect(byVerb.statements).toHaveLength(1);

    const byActivity = await queryStatements({ tenantId: lrs.tenantId, activity }, lrs.prisma);
    expect(byActivity.statements).toHaveLength(1);

    const byAgent = await queryStatements(
      { tenantId: lrs.tenantId, agent: { mbox: 'mailto:ada@example.com' } },
      lrs.prisma,
    );
    expect(byAgent.statements).toHaveLength(1);
  });

  it('broadens an activity filter with related_activities', async () => {
    const page = await queryStatements(
      { tenantId: lrs.tenantId, activity, relatedActivities: true },
      lrs.prisma,
    );
    expect(page.statements).toHaveLength(2);
  });

  it('excludes voided statements', async () => {
    await store([
      sampleStatement({
        verb: { id: VOIDED_VERB },
        object: { objectType: 'StatementRef', id: ID_A },
      }),
    ]);

    const page = await queryStatements({ tenantId: lrs.tenantId, verb: 'http://adlnet.gov/expapi/verbs/completed' }, lrs.prisma);
    expect(page.statements).toHaveLength(0);
  });

  it('pages with a cursor when more results remain', async () => {
    const first = await queryStatements({ tenantId: lrs.tenantId, limit: 1 }, lrs.prisma);
    expect(first.statements).toHaveLength(1);
    expect(first.nextOffset).toBe(1);

    const second = await queryStatements(
      { tenantId: lrs.tenantId, limit: 1, offset: first.nextOffset! },
      lrs.prisma,
    );
    expect(second.statements).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect(second.statements[0]).not.toEqual(first.statements[0]);
  });

  it('never leaks statements from another tenant', async () => {
    const page = await queryStatements({ tenantId: 'other_tenant' }, lrs.prisma);
    expect(page.statements).toHaveLength(0);
  });
});
