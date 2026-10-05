import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';

/**
 * In-memory stand-in for the Prisma operations the LRS uses, so statement and
 * state tests run without Postgres. Supports just enough of the Prisma `where`
 * grammar for these call sites: equality, `in`, `has`, `gt`/`lte`, and `OR`.
 */

export interface MockLrsOptions {
  tenantId?: string;
  apiKeyPlaintext?: string;
}

export interface MockLrs {
  prisma: PrismaClient;
  tenantId: string;
  apiKey: string;
  statements: StatementRow[];
  states: StateRow[];
  profiles: ProfileRow[];
  cmi5: Cmi5Tables;
  webhooks: WebhookTables;
}

export interface WebhookTables {
  endpoints: Array<Record<string, any>>;
  deliveries: Array<Record<string, any>>;
}

export interface StatementRow {
  tenantId: string;
  statementId: string;
  actorIfi: string;
  verbId: string;
  objectType: string;
  objectId: string | null;
  registration: string | null;
  relatedActivities: string[];
  relatedAgents: string[];
  voided: boolean;
  voidsStatementId: string | null;
  statement: unknown;
  timestamp: Date;
  stored: Date;
}

export interface StateRow {
  id: string;
  tenantId: string;
  lookupKey: string;
  activityId: string;
  agentIfi: string;
  registration: string | null;
  stateId: string;
  contentType: string;
  content: Buffer;
  etag: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileRow {
  id: string;
  tenantId: string;
  scope: 'ACTIVITY' | 'AGENT';
  lookupKey: string;
  activityId: string | null;
  agentIfi: string | null;
  profileId: string;
  contentType: string;
  content: Buffer;
  etag: string;
  createdAt: Date;
  updatedAt: Date;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (condition === undefined) continue;

    if (field === 'OR') {
      const branches = condition as Array<Record<string, unknown>>;
      if (!branches.some((branch) => matches(row, branch))) return false;
      continue;
    }

    const value = row[field];

    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const op = condition as Record<string, unknown>;
      if ('in' in op && !(op.in as unknown[]).includes(value)) return false;
      if ('has' in op && !(value as unknown[]).includes(op.has)) return false;
      if ('gt' in op && !((value as Date) > (op.gt as Date))) return false;
      if ('lt' in op && !((value as Date) < (op.lt as Date))) return false;
      if ('lte' in op && !((value as Date) <= (op.lte as Date))) return false;
      continue;
    }

    if (value !== condition) return false;
  }
  return true;
}

function select<T extends Record<string, unknown>>(row: T, fields?: Record<string, boolean>): unknown {
  if (!fields) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) out[key] = row[key];
  return out;
}

export function createMockLrs(options: MockLrsOptions = {}): MockLrs {
  const tenantId = options.tenantId ?? 'tenant_test';
  const apiKey = options.apiKeyPlaintext ?? 'sk_test_lrs';

  const statements: StatementRow[] = [];
  const states: StateRow[] = [];
  const profiles: ProfileRow[] = [];

  const xapiStatement = {
    findMany: async ({ where, orderBy, skip, take, select: fields }: any) => {
      let rows = statements.filter((row) => matches(row as any, where ?? {}));
      if (orderBy?.stored) {
        rows = [...rows].sort((a, b) =>
          orderBy.stored === 'asc'
            ? a.stored.getTime() - b.stored.getTime()
            : b.stored.getTime() - a.stored.getTime(),
        );
      }
      if (skip) rows = rows.slice(skip);
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map((row) => select(row as any, fields));
    },
    findUnique: async ({ where, select: fields }: any) => {
      const key = where.tenantId_statementId;
      const row = statements.find(
        (s) => s.tenantId === key.tenantId && s.statementId === key.statementId,
      );
      return row ? select(row as any, fields) : null;
    },
    createMany: async ({ data }: any) => {
      for (const item of data as Array<Partial<StatementRow>>) {
        statements.push({
          voided: false,
          voidsStatementId: null,
          objectId: null,
          registration: null,
          relatedActivities: [],
          relatedAgents: [],
          ...item,
        } as StatementRow);
      }
      return { count: data.length };
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of statements) {
        if (matches(row as any, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const xapiState = documentStore(states, 'state', { registration: null });
  const xapiProfile = documentStore(profiles, 'profile', { activityId: null, agentIfi: null });

  const cmi5: Cmi5Tables = { courses: [], aus: [], registrations: [], sessions: [] };
  const webhooks: WebhookTables = { endpoints: [], deliveries: [] };

  const prisma = {
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.hashedKey === hashApiKey(apiKey) ? { id: 'k1', tenantId, revokedAt: null } : null,
    },
    xapiStatement,
    xapiState,
    xapiProfile,
    cmi5Course: table(cmi5.courses, 'c5c', () => ({ description: null, storageKey: null })),
    cmi5Au: table(cmi5.aus, 'c5a', () => ({})),
    cmi5Registration: table(cmi5.registrations, 'c5r', () => ({ satisfiedAt: null, auState: {}, blockState: {} })),
    cmi5Session: table(cmi5.sessions, 'c5s', () => ({
      fetchedAt: null,
      initializedAt: null,
      endedAt: null,
      launchedAt: new Date(),
    })),
    webhookEndpoint: table(webhooks.endpoints, 'whe', () => ({ description: null, enabled: true })),
    webhookDelivery: table(webhooks.deliveries, 'whd', () => ({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      lastResponse: null,
      deliveredAt: null,
    })),
    $transaction: async (fn: any) => fn(prisma),
  } as unknown as PrismaClient;

  return { prisma, tenantId, apiKey, statements, states, profiles, cmi5, webhooks };
}

export interface Cmi5Tables {
  courses: Array<Record<string, any>>;
  aus: Array<Record<string, any>>;
  registrations: Array<Record<string, any>>;
  sessions: Array<Record<string, any>>;
}

/** A generic id-keyed table covering the Prisma calls the cmi5 service makes. */
function table(
  rows: Array<Record<string, any>>,
  idPrefix: string,
  defaults: () => Record<string, unknown>,
) {
  let seq = 0;
  const sorted = (found: Array<Record<string, any>>, orderBy?: Record<string, 'asc' | 'desc'>) => {
    if (!orderBy) return found;
    const [field, dir] = Object.entries(orderBy)[0]!;
    return [...found].sort((a, b) => {
      const x = a[field] instanceof Date ? a[field].getTime() : a[field];
      const y = b[field] instanceof Date ? b[field].getTime() : b[field];
      return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
    });
  };
  const make = (data: Record<string, unknown>) => {
    seq += 1;
    const now = new Date();
    const row = { id: `${idPrefix}_${seq}`, createdAt: now, updatedAt: now, ...defaults(), ...data };
    rows.push(row);
    return row;
  };
  return {
    findFirst: async ({ where, select: fields }: any) => {
      const row = rows.find((r) => matches(r, where ?? {}));
      return row ? select(row, fields) : null;
    },
    findMany: async ({ where, orderBy, take, select: fields }: any = {}) => {
      let found = sorted(rows.filter((r) => matches(r, where ?? {})), orderBy);
      if (take !== undefined) found = found.slice(0, take);
      return found.map((r) => select(r, fields));
    },
    create: async ({ data }: any) => make(data),
    createMany: async ({ data }: any) => {
      for (const item of data) make(item);
      return { count: data.length };
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`No ${idPrefix} row ${where.id}`);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
    delete: async ({ where }: any) => {
      const index = rows.findIndex((r) => r.id === where.id);
      const [row] = rows.splice(index, 1);
      return row;
    },
  };
}

/**
 * The State and Profile tables are the same shape — keyed by
 * `(tenantId, lookupKey)`, ordered by `updatedAt` — so one stand-in serves both.
 */
function documentStore<T extends { tenantId: string; lookupKey: string; updatedAt: Date }>(
  rows: T[],
  idPrefix: string,
  defaults: Record<string, unknown>,
) {
  let seq = 0;
  const find = (key: { tenantId: string; lookupKey: string }) =>
    rows.find((r) => r.tenantId === key.tenantId && r.lookupKey === key.lookupKey);

  return {
    findUnique: async ({ where }: any) => find(where.tenantId_lookupKey) ?? null,
    findMany: async ({ where, orderBy, select: fields }: any) => {
      let found = rows.filter((row) => matches(row as any, where ?? {}));
      if (orderBy?.updatedAt) {
        found = [...found].sort((a, b) =>
          orderBy.updatedAt === 'asc'
            ? a.updatedAt.getTime() - b.updatedAt.getTime()
            : b.updatedAt.getTime() - a.updatedAt.getTime(),
        );
      }
      return found.map((row) => select(row as any, fields));
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = find(where.tenantId_lookupKey);
      // Nudge the clock per write so `updatedAt` ordering is deterministic.
      const now = new Date(Date.now() + seq);
      if (existing) {
        Object.assign(existing, update, { updatedAt: now });
        return existing;
      }
      seq += 1;
      const row = {
        id: `${idPrefix}_${seq}`,
        ...defaults,
        createdAt: now,
        updatedAt: now,
        ...create,
      } as unknown as T;
      rows.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const key = where.tenantId_lookupKey;
      const index = rows.findIndex(
        (r) => r.tenantId === key.tenantId && r.lookupKey === key.lookupKey,
      );
      if (index >= 0) rows.splice(index, 1);
      return { id: 'deleted' };
    },
    deleteMany: async ({ where }: any) => {
      const keep = rows.filter((row) => !matches(row as any, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

/** A minimal valid statement, with overrides merged on top. */
export function sampleStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: { mbox: 'mailto:ada@example.com' },
    verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
    object: { id: 'http://example.com/courses/intro' },
    ...overrides,
  };
}
