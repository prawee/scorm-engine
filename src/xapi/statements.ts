import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../db/client.js';
import type { EventSink } from '../webhooks/events.js';
import { XapiError } from './errors.js';
import { actorIfi } from './ifi.js';
import { StatementSchema, VOIDED_VERB } from './schema.js';
import type { Actor, Statement, StatementFormat } from './types.js';

/** The xAPI version this LRS implements and stamps onto stored statements. */
export const XAPI_VERSION = '1.0.3';

/** Largest page a Statement query will return, and the default when `limit=0`. */
export const MAX_PAGE_SIZE = 100;

/** Fields the LRS owns; a client-supplied value for them is replaced, not trusted. */
const LRS_OWNED = ['stored', 'authority', 'version'] as const;

export interface StoreStatementsInput {
  tenantId: string;
  /** Raw, unvalidated statement bodies. */
  statements: unknown[];
  /** Set by `PUT /statements?statementId=`; the body must agree with it or carry no id. */
  statementId?: string | undefined;
  /** Stamped onto every stored statement as the `authority`. */
  authority: Actor;
  /** Injectable for deterministic tests. */
  now?: Date;
  /** Told about each newly stored statement (`xapi.statement.stored`). */
  events?: EventSink | undefined;
}

export interface StoreStatementsResult {
  /** Ids in request order, whether freshly stored or already present. */
  ids: string[];
  /** Subset of `ids` that matched an identical statement already in the LRS. */
  duplicates: string[];
}

/**
 * Store a batch of statements.
 *
 * Statements are immutable: re-sending a byte-identical statement under the same
 * id is a no-op (so clients can retry a half-failed POST safely), while sending a
 * *different* statement under an id that already exists is a 409.
 */
export async function storeStatements(
  input: StoreStatementsInput,
  prisma: PrismaClient,
): Promise<StoreStatementsResult> {
  const now = input.now ?? new Date();

  if (input.statements.length === 0) {
    return { ids: [], duplicates: [] };
  }

  const prepared = input.statements.map((raw) => prepare(raw, input, now));

  const seen = new Set<string>();
  for (const { id } of prepared) {
    if (seen.has(id)) {
      throw XapiError.badRequest(`Statement id ${id} appears more than once in the batch`);
    }
    seen.add(id);
  }

  const existing = await prisma.xapiStatement.findMany({
    where: { tenantId: input.tenantId, statementId: { in: [...seen] } },
    select: { statementId: true, statement: true },
  });
  const existingById = new Map(existing.map((row) => [row.statementId, row.statement]));

  const duplicates: string[] = [];
  const toInsert: typeof prepared = [];

  for (const candidate of prepared) {
    const prior = existingById.get(candidate.id);
    if (prior === undefined) {
      toInsert.push(candidate);
      continue;
    }
    if (!sameStatement(prior, candidate.statement, candidate.clientTimestamp)) {
      throw XapiError.conflict(
        `A different statement is already stored under id ${candidate.id}`,
        'statement_conflict',
      );
    }
    duplicates.push(candidate.id);
  }

  if (toInsert.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.xapiStatement.createMany({
        data: toInsert.map((s) => ({
          tenantId: input.tenantId,
          statementId: s.id,
          actorIfi: s.actorIfi,
          verbId: s.statement.verb.id,
          objectType: s.objectType,
          objectId: s.objectId,
          registration: s.statement.context?.registration ?? null,
          relatedActivities: s.relatedActivities,
          relatedAgents: s.relatedAgents,
          voidsStatementId: s.voidsStatementId,
          statement: s.statement as object,
          timestamp: new Date(s.statement.timestamp as string),
          stored: now,
        })),
      });

      const targets = toInsert
        .map((s) => s.voidsStatementId)
        .filter((v): v is string => Boolean(v));
      if (targets.length > 0) {
        // A voiding statement may not itself be voided, so skip those targets.
        await tx.xapiStatement.updateMany({
          where: {
            tenantId: input.tenantId,
            statementId: { in: targets },
            voidsStatementId: null,
          },
          data: { voided: true },
        });
      }
    });
  }

  // A duplicate was announced when it was first stored, so only fresh rows fire.
  for (const s of toInsert) {
    input.events?.emit(input.tenantId, 'xapi.statement.stored', {
      statementId: s.id,
      verbId: s.statement.verb.id,
      actor: s.actorIfi,
      objectType: s.objectType,
      objectId: s.objectId,
      registration: s.statement.context?.registration ?? null,
      voidsStatementId: s.voidsStatementId,
      statement: s.statement,
    });
  }

  return { ids: prepared.map((s) => s.id), duplicates };
}

interface PreparedStatement {
  id: string;
  statement: Statement;
  actorIfi: string;
  objectType: string;
  objectId: string | null;
  relatedActivities: string[];
  relatedAgents: string[];
  voidsStatementId: string | null;
  /** Whether the client supplied `timestamp`, or we defaulted it. */
  clientTimestamp: boolean;
}

function prepare(raw: unknown, input: StoreStatementsInput, now: Date): PreparedStatement {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw XapiError.badRequest('Each statement must be a JSON object');
  }

  const parsed = StatementSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'statement'}: ${i.message}`)
      .join('; ');
    throw XapiError.badRequest(`Invalid statement — ${detail}`, 'invalid_statement');
  }

  const statement = parsed.data;

  if (input.statementId) {
    if (statement.id && statement.id.toLowerCase() !== input.statementId.toLowerCase()) {
      throw XapiError.badRequest(
        'Statement id in the body does not match the statementId parameter',
        'statement_id_mismatch',
      );
    }
    statement.id = input.statementId;
  }

  const id = (statement.id ?? randomUUID()).toLowerCase();
  const clientTimestamp = statement.timestamp !== undefined;
  statement.id = id;
  statement.timestamp = statement.timestamp ?? now.toISOString();
  statement.stored = now.toISOString();
  statement.authority = input.authority;
  statement.version = XAPI_VERSION;

  const object = statement.object as { objectType?: string; id?: string };
  const objectType = object.objectType ?? 'Activity';

  return {
    id,
    statement,
    actorIfi: actorIfi(statement.actor),
    objectType,
    objectId: objectIdentifier(statement),
    relatedActivities: collectActivities(statement),
    relatedAgents: collectAgents(statement),
    voidsStatementId:
      statement.verb.id === VOIDED_VERB && objectType === 'StatementRef'
        ? (object.id as string).toLowerCase()
        : null,
    clientTimestamp,
  };
}

/** Whatever identifies the statement's object: activity IRI, actor IFI, or statement id. */
function objectIdentifier(statement: Statement): string | null {
  const object = statement.object as { objectType?: string; id?: string };
  const objectType = object.objectType ?? 'Activity';
  if (objectType === 'Activity' || objectType === 'StatementRef') {
    return object.id ?? null;
  }
  if (objectType === 'Agent' || objectType === 'Group') {
    return actorIfi(statement.object as Actor);
  }
  return null;
}

function collectActivities(statement: Statement): string[] {
  const out = new Set<string>();
  const object = statement.object as { objectType?: string; id?: string };
  if ((object.objectType ?? 'Activity') === 'Activity' && object.id) {
    out.add(object.id);
  }
  for (const context of [statement.context, (statement.object as { context?: unknown }).context]) {
    const activities = (context as { contextActivities?: Record<string, unknown> } | undefined)
      ?.contextActivities;
    if (!activities) continue;
    for (const value of Object.values(activities)) {
      for (const activity of Array.isArray(value) ? value : [value]) {
        const id = (activity as { id?: string } | undefined)?.id;
        if (id) out.add(id);
      }
    }
  }
  return [...out];
}

function collectAgents(statement: Statement): string[] {
  const out = new Set<string>();
  const add = (actor: unknown): void => {
    if (!actor || typeof actor !== 'object') return;
    try {
      out.add(actorIfi(actor as Actor));
    } catch {
      // Unidentifiable actor — nothing to index it under.
    }
    for (const member of (actor as { member?: unknown[] }).member ?? []) {
      add(member);
    }
  };

  add(statement.actor);
  add(statement.authority);
  add(statement.context?.instructor);
  add(statement.context?.team);

  const object = statement.object as { objectType?: string };
  if (object.objectType === 'Agent' || object.objectType === 'Group') {
    add(statement.object);
  }
  if (object.objectType === 'SubStatement') {
    const sub = statement.object as { actor?: unknown; object?: unknown };
    add(sub.actor);
    const subObjectType = (sub.object as { objectType?: string } | undefined)?.objectType;
    if (subObjectType === 'Agent' || subObjectType === 'Group') add(sub.object);
  }

  return [...out];
}

/**
 * Immutability check. The LRS rewrites `stored`, `authority` and `version` on
 * every write — and fills in `timestamp` when the client omitted it — so those
 * are excluded. Otherwise an honest retry would look like a conflicting edit.
 */
function sameStatement(a: unknown, b: unknown, clientTimestamp: boolean): boolean {
  const owned = clientTimestamp ? [...LRS_OWNED] : [...LRS_OWNED, 'timestamp'];
  return canonicalJson(stripFields(a, owned)) === canonicalJson(stripFields(b, owned));
}

function stripFields(value: unknown, fields: string[]): unknown {
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy;
}

/** JSON with object keys sorted, so key order never affects equality. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface StatementQuery {
  tenantId: string;
  statementId?: string | undefined;
  voidedStatementId?: string | undefined;
  agent?: Actor | undefined;
  verb?: string | undefined;
  activity?: string | undefined;
  registration?: string | undefined;
  relatedActivities?: boolean | undefined;
  relatedAgents?: boolean | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  limit?: number | undefined;
  ascending?: boolean | undefined;
  format?: StatementFormat | undefined;
  /** Zero-based offset into the result set; supplied by the `more` link. */
  offset?: number | undefined;
}

export interface StatementPage {
  statements: unknown[];
  /** Offset to resume from, or `null` when the result set is exhausted. */
  nextOffset: number | null;
}

/** Fetch a single statement by id. Returns `null` when absent or voided-but-not-asked-for. */
export async function getStatement(
  tenantId: string,
  statementId: string,
  options: { voided?: boolean | undefined; format?: StatementFormat | undefined } = {},
  prisma: PrismaClient,
): Promise<unknown | null> {
  const row = await prisma.xapiStatement.findUnique({
    where: { tenantId_statementId: { tenantId, statementId: statementId.toLowerCase() } },
    select: { statement: true, voided: true },
  });
  if (!row) return null;
  if (Boolean(options.voided) !== row.voided) return null;
  return project(row.statement, options.format ?? 'exact');
}

/**
 * Run a Statement query.
 *
 * Voided statements never appear in filtered results — the spec only surfaces
 * them through an explicit `voidedStatementId` lookup.
 */
export async function queryStatements(
  query: StatementQuery,
  prisma: PrismaClient,
): Promise<StatementPage> {
  const limit =
    query.limit && query.limit > 0 ? Math.min(query.limit, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const offset = query.offset ?? 0;

  const where: Record<string, unknown> = { tenantId: query.tenantId, voided: false };

  if (query.verb) where.verbId = query.verb;
  if (query.registration) where.registration = query.registration;

  if (query.activity) {
    if (query.relatedActivities) {
      where.relatedActivities = { has: query.activity };
    } else {
      where.objectType = 'Activity';
      where.objectId = query.activity;
    }
  }

  if (query.agent) {
    const ifi = actorIfi(query.agent);
    if (query.relatedAgents) {
      where.relatedAgents = { has: ifi };
    } else {
      where.OR = [{ actorIfi: ifi }, { objectType: { in: ['Agent', 'Group'] }, objectId: ifi }];
    }
  }

  if (query.since || query.until) {
    where.stored = {
      ...(query.since ? { gt: query.since } : {}),
      ...(query.until ? { lte: query.until } : {}),
    };
  }

  const rows = await prisma.xapiStatement.findMany({
    where,
    orderBy: { stored: query.ascending ? 'asc' : 'desc' },
    skip: offset,
    // One extra row tells us whether a `more` link is warranted.
    take: limit + 1,
    select: { statement: true },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    statements: page.map((row) => project(row.statement, query.format ?? 'exact')),
    nextOffset: hasMore ? offset + limit : null,
  };
}

/** Reduce a stored statement to the shape the requested `format` allows. */
function project(statement: unknown, format: StatementFormat): unknown {
  if (format === 'exact') return statement;
  if (format === 'canonical') return canonicalize(statement);

  const s = statement as Statement;
  const object = s.object as { objectType?: string; id?: string };
  return {
    id: s.id,
    actor: minimalActor(s.actor),
    verb: { id: s.verb.id },
    object:
      (object.objectType ?? 'Activity') === 'Agent' || object.objectType === 'Group'
        ? minimalActor(s.object as Actor)
        : { objectType: object.objectType ?? 'Activity', id: object.id },
  };
}

/** An actor stripped to its inverse-functional identifier, per `format=ids`. */
function minimalActor(actor: Actor): Record<string, unknown> {
  const a = actor as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (a.objectType) out.objectType = a.objectType;
  for (const key of ['mbox', 'mbox_sha1sum', 'openid', 'account'] as const) {
    if (a[key] !== undefined) {
      out[key] = a[key];
      return out;
    }
  }
  if (Array.isArray(a.member)) {
    out.member = a.member.map((m) => minimalActor(m as Actor));
  }
  return out;
}

/** `format=canonical`: collapse every language map to a single entry. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const entry =
      (key === 'display' || key === 'name' || key === 'description') && isLanguageMap(v)
        ? Object.entries(v as Record<string, string>)[0]
        : undefined;
    if (entry) {
      out[key] = { [entry[0]]: entry[1] };
    } else {
      out[key] = canonicalize(v);
    }
  }
  return out;
}

function isLanguageMap(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length > 0 &&
    Object.values(value as object).every((v) => typeof v === 'string')
  );
}
