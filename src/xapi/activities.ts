import type { PrismaClient } from '../db/client.js';
import { actorIfi } from './ifi.js';
import type { Activity, Actor, Statement } from './types.js';

/**
 * The xAPI Activity and Agent (Person) lookup resources.
 *
 * Neither is a document store: both are *derived* views over the statements
 * this LRS has already accepted. We hold no separate activity registry, so the
 * canonical Activity is the merge of every definition clients have sent for
 * that IRI, and a Person is the union of the identifying properties seen on
 * actors sharing one IFI.
 */

/**
 * How many statements a lookup scans. Both resources merge over a potentially
 * unbounded history; in practice a definition is repeated on every statement
 * for the activity, so the newest slice carries the same answer as the whole
 * table at a fraction of the cost.
 */
export const LOOKUP_SCAN_LIMIT = 500;

/**
 * The canonical Activity for an IRI, or `null` if this LRS has never seen it.
 *
 * Definitions are merged newest-first, each statement filling in only what no
 * newer one already said, so the most recent description of an activity wins.
 * Language maps (`name`, `description`, `extensions`) merge per key rather than
 * wholesale — two statements naming the same activity in different languages
 * both contribute. Statements stored in the same instant are ordered by the
 * database; which of them wins a direct conflict is undefined.
 */
export async function getActivity(
  tenantId: string,
  activityId: string,
  prisma: PrismaClient,
): Promise<Activity | null> {
  const rows = await prisma.xapiStatement.findMany({
    where: { tenantId, relatedActivities: { has: activityId } },
    orderBy: { stored: 'desc' },
    take: LOOKUP_SCAN_LIMIT,
    select: { statement: true },
  });

  if (rows.length === 0) return null;

  const definition: Record<string, unknown> = {};
  // Rows arrive newest first; each one only fills gaps the newer ones left.
  for (const row of rows) {
    for (const found of activitiesIn(row.statement as unknown as Statement, activityId)) {
      fillDefinition(definition, found.definition as Record<string, unknown> | undefined);
    }
  }

  const activity: Activity = { objectType: 'Activity', id: activityId };
  if (Object.keys(definition).length > 0) {
    (activity as Record<string, unknown>).definition = definition;
  }
  return activity;
}

/** Every Activity with this id anywhere in a statement (object or contextActivities). */
function activitiesIn(statement: Statement, activityId: string): Activity[] {
  const found: Activity[] = [];

  const consider = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const candidate = value as Activity;
    if (candidate.id === activityId) found.push(candidate);
  };

  const object = statement.object as unknown;
  if (object && typeof object === 'object') {
    const objectType = (object as { objectType?: string }).objectType;
    if (objectType === undefined || objectType === 'Activity') consider(object);
    // A SubStatement carries its own object and context.
    if (objectType === 'SubStatement') {
      found.push(...activitiesIn(object as unknown as Statement, activityId));
    }
  }

  const context = statement.context as { contextActivities?: Record<string, unknown> } | undefined;
  for (const group of Object.values(context?.contextActivities ?? {})) {
    if (Array.isArray(group)) group.forEach(consider);
    else consider(group);
  }

  return found;
}

/** Keys whose values are maps, merged entry by entry rather than replaced whole. */
const MAP_VALUED_KEYS = new Set(['name', 'description', 'extensions']);

/**
 * Fill gaps in the accumulator from one definition, never overwriting what a
 * newer statement already contributed.
 */
function fillDefinition(
  into: Record<string, unknown>,
  definition: Record<string, unknown> | undefined,
): void {
  if (!isPlainObject(definition)) return;

  for (const [key, value] of Object.entries(definition)) {
    if (value === undefined) continue;
    const existing = into[key];

    if (MAP_VALUED_KEYS.has(key) && isPlainObject(value)) {
      // Older entries supply only the keys (language tags) still missing.
      into[key] = isPlainObject(existing) ? { ...value, ...existing } : value;
      continue;
    }

    if (!(key in into)) into[key] = value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The xAPI Person object for an agent.
 *
 * A Person is an Agent whose identifying properties are *arrays* — it is the
 * LRS's view of everything it knows about one person. We key on the IFI, so the
 * result always contains at least the IFI that was asked for, plus any names
 * seen alongside it. An agent we have never recorded still gets a Person back,
 * as the spec requires; it simply carries nothing but that IFI.
 */
export async function getPerson(
  tenantId: string,
  agent: Actor,
  prisma: PrismaClient,
): Promise<Record<string, unknown>> {
  const ifi = actorIfi(agent);
  const rows = await prisma.xapiStatement.findMany({
    where: { tenantId, relatedAgents: { has: ifi } },
    orderBy: { stored: 'desc' },
    take: LOOKUP_SCAN_LIMIT,
    select: { statement: true },
  });

  const person: Record<string, string[]> = {};
  const add = (key: string, value: string | undefined): void => {
    if (!value) return;
    const list = (person[key] ??= []);
    if (!list.includes(value)) list.push(value);
  };

  const absorb = (actor: Actor): void => {
    add('name', actor.name);
    add('mbox', actor.mbox);
    add('mbox_sha1sum', actor.mbox_sha1sum);
    add('openid', actor.openid);
    if (actor.account) add('account', JSON.stringify(actor.account));
  };

  // Always honour what the caller gave us, even with no statements on file.
  absorb(agent);
  for (const row of rows) {
    for (const actor of actorsIn(row.statement as unknown as Statement)) {
      if (safeIfi(actor) === ifi) absorb(actor);
    }
  }

  const result: Record<string, unknown> = { objectType: 'Person' };
  for (const [key, values] of Object.entries(person)) {
    result[key] = key === 'account' ? values.map((v) => JSON.parse(v)) : values;
  }
  return result;
}

/** Every actor-shaped value in a statement. */
function actorsIn(statement: Statement): Actor[] {
  const actors: Actor[] = [];
  const consider = (value: unknown): void => {
    if (value && typeof value === 'object') actors.push(value as Actor);
  };

  consider(statement.actor);
  consider(statement.authority);

  const object = statement.object as { objectType?: string } | undefined;
  if (object?.objectType === 'Agent' || object?.objectType === 'Group') consider(object);
  if (object?.objectType === 'SubStatement') {
    actors.push(...actorsIn(object as unknown as Statement));
  }

  const context = statement.context as
    | { instructor?: unknown; team?: unknown }
    | undefined;
  consider(context?.instructor);
  consider(context?.team);

  return actors;
}

/** `actorIfi` throws on an anonymous group; here that just means "not a match". */
function safeIfi(actor: Actor): string | null {
  try {
    return actorIfi(actor);
  } catch {
    return null;
  }
}
