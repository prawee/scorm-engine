import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../db/client.js';
import { readZipEntry, extractZipToStorage, ZipExtractionError } from '../parser/zip.js';
import { tenantKey } from '../storage/scoped.js';
import type { StorageAdapter } from '../storage/types.js';
import { lrsAuthority } from '../xapi/authority.js';
import { actorIfi } from '../xapi/ifi.js';
import { ActorSchema } from '../xapi/schema.js';
import { putState } from '../xapi/state.js';
import { storeStatements, type StoreStatementsResult } from '../xapi/statements.js';
import type { Actor } from '../xapi/types.js';
import type { EventSink } from '../webhooks/events.js';
import {
  ACTIVITY_TYPE,
  CATEGORY,
  EXTENSION,
  LAUNCH_DATA_STATE_ID,
  LAUNCH_MODES,
  VERBS,
  WAIVE_REASONS,
  type LaunchMode,
  type WaiveReason,
} from './constants.js';
import {
  CourseStructureError,
  parseCourseStructure,
  type ParsedCourseStructure,
  type StructureNode,
} from './course-structure.js';
import {
  applyAuStatements,
  EMPTY_PROGRESS,
  meetsMoveOn,
  satisfiedBlocks,
  type AuProgress,
  type SessionStatus,
} from './rules.js';

export class Cmi5Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Cmi5Error';
  }
}

type AuState = Record<string, AuProgress>;
/** Block publisher id → ISO time the block was satisfied. */
type BlockState = Record<string, string>;

function auStateOf(reg: { auState: unknown }): AuState {
  return (reg.auState ?? {}) as AuState;
}

function blockStateOf(reg: { blockState?: unknown }): BlockState {
  return (reg.blockState ?? {}) as BlockState;
}

type BlockNode = Extract<StructureNode, { type: 'block' }>;

function structureChildren(course: { structure: unknown } | null): StructureNode[] {
  return ((course?.structure as { children?: StructureNode[] } | null)?.children ?? []);
}

function flattenBlocks(children: StructureNode[]): BlockNode[] {
  return children.flatMap((node) =>
    node.type === 'block' ? [node, ...flattenBlocks(node.children)] : [],
  );
}

function withBlockActivityIds(children: StructureNode[]): StructureNode[] {
  return children.map((node) =>
    node.type === 'block'
      ? { ...node, activityId: `urn:uuid:${randomUUID()}`, children: withBlockActivityIds(node.children) }
      : node,
  );
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// ---------------------------------------------------------------------------
// Course import
// ---------------------------------------------------------------------------

export interface Cmi5PackageSource {
  /** Either a ZIP containing `cmi5.xml` at its root, or a bare `cmi5.xml`. */
  buffer: Buffer;
}

/** Read the course structure out of an upload without importing it. */
export async function readCourseStructure(source: Cmi5PackageSource): Promise<{
  structure: ParsedCourseStructure;
  isZip: boolean;
}> {
  const isZip = source.buffer.subarray(0, 2).toString('latin1') === 'PK';
  let xml: string;

  if (isZip) {
    let entry: Buffer | null;
    try {
      entry = await readZipEntry(source.buffer, 'cmi5.xml');
    } catch (err) {
      if (err instanceof ZipExtractionError) throw new Cmi5Error(422, 'invalid_package', err.message);
      throw err;
    }
    if (!entry) {
      throw new Cmi5Error(422, 'missing_course_structure', 'cmi5.xml not found at the root of the package');
    }
    xml = entry.toString('utf8');
  } else {
    xml = source.buffer.toString('utf8');
  }

  let structure: ParsedCourseStructure;
  try {
    structure = parseCourseStructure(xml);
  } catch (err) {
    if (err instanceof CourseStructureError) throw new Cmi5Error(422, err.code, err.message);
    throw err;
  }

  if (!isZip) {
    const relative = structure.aus.find((au) => !ABSOLUTE_URL.test(au.url));
    if (relative) {
      throw new Cmi5Error(
        422,
        'relative_au_url',
        `AU ${relative.id} has a relative url, which needs a ZIP package to resolve against`,
      );
    }
  }

  return { structure, isZip };
}

export interface ImportCourseInput extends Cmi5PackageSource {
  tenantId: string;
  titleOverride?: string | undefined;
}

export async function importCmi5Course(
  input: ImportCourseInput,
  deps: { prisma: PrismaClient; storage: StorageAdapter },
): Promise<string> {
  const { structure, isZip } = await readCourseStructure(input);
  const courseId = randomUUID();
  const storageKey = isZip ? tenantKey(input.tenantId, 'cmi5', courseId) : null;

  if (storageKey) {
    try {
      await extractZipToStorage(input.buffer, deps.storage, storageKey);
    } catch (err) {
      if (err instanceof ZipExtractionError) throw new Cmi5Error(422, 'invalid_package', err.message);
      throw err;
    }
  }

  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.cmi5Course.create({
        data: {
          id: courseId,
          tenantId: input.tenantId,
          publisherId: structure.id,
          activityId: `urn:uuid:${randomUUID()}`,
          title: input.titleOverride?.trim() || structure.title,
          description: structure.description,
          storageKey,
          structure: {
            ...structure,
            children: withBlockActivityIds(structure.children),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.cmi5Au.createMany({
        data: structure.aus.map((au, order) => ({
          courseId,
          publisherId: au.id,
          activityId: `urn:uuid:${randomUUID()}`,
          title: au.title,
          description: au.description,
          url: au.url,
          launchMethod: au.launchMethod,
          moveOn: au.moveOn,
          masteryScore: au.masteryScore,
          activityType: au.activityType,
          launchParameters: au.launchParameters,
          entitlementKey: au.entitlementKey,
          order,
        })),
      });
    });
  } catch (err) {
    if (storageKey) await deps.storage.delete(storageKey).catch(() => undefined);
    throw err;
  }

  return courseId;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export interface CreateRegistrationInput {
  tenantId: string;
  courseId: string;
  actor: unknown;
}

export async function createRegistration(
  input: CreateRegistrationInput,
  prisma: PrismaClient,
): Promise<string> {
  const parsed = ActorSchema.safeParse(input.actor);
  if (!parsed.success || parsed.data.objectType === 'Group') {
    throw new Cmi5Error(400, 'invalid_actor', 'actor must be an identified xAPI Agent');
  }
  const course = await prisma.cmi5Course.findFirst({
    where: { id: input.courseId, tenantId: input.tenantId },
    select: { id: true },
  });
  if (!course) throw new Cmi5Error(404, 'course_not_found', 'cmi5 course not found');

  const id = randomUUID();
  await prisma.cmi5Registration.create({
    data: {
      id,
      tenantId: input.tenantId,
      courseId: course.id,
      actor: parsed.data as Prisma.InputJsonValue,
      actorIfi: actorIfi(parsed.data),
      auState: {},
    },
  });
  return id;
}

export interface RegistrationView {
  id: string;
  courseId: string;
  actor: unknown;
  satisfied: boolean;
  satisfiedAt: string | null;
  createdAt: string;
  aus: Array<
    { id: string; publisherId: string; title: string; moveOn: string } & AuProgress
  >;
  /** Every block in the course, in document order. */
  blocks: Array<{ publisherId: string; title: string; satisfied: boolean; satisfiedAt: string | null }>;
}

export async function getRegistrationView(
  tenantId: string,
  registrationId: string,
  prisma: PrismaClient,
): Promise<RegistrationView | null> {
  const reg = await prisma.cmi5Registration.findFirst({ where: { id: registrationId, tenantId } });
  if (!reg) return null;
  const aus = await listAus(reg.courseId, prisma);
  const course = await prisma.cmi5Course.findFirst({
    where: { id: reg.courseId },
    select: { structure: true },
  });
  const state = auStateOf(reg);
  const blockState = blockStateOf(reg);
  return {
    id: reg.id,
    courseId: reg.courseId,
    actor: reg.actor,
    satisfied: reg.satisfiedAt !== null,
    satisfiedAt: reg.satisfiedAt?.toISOString() ?? null,
    createdAt: reg.createdAt.toISOString(),
    blocks: flattenBlocks(structureChildren(course)).map((block) => ({
      publisherId: block.id,
      title: block.title,
      satisfied: blockState[block.id] !== undefined,
      satisfiedAt: blockState[block.id] ?? null,
    })),
    aus: aus.map((au) => {
      const progress = { ...EMPTY_PROGRESS, ...state[au.publisherId] };
      return {
        id: au.id,
        publisherId: au.publisherId,
        title: au.title,
        moveOn: au.moveOn,
        ...progress,
        satisfied: meetsMoveOn(au.moveOn, progress),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface LaunchInput {
  tenantId: string;
  registrationId: string;
  /** AU row id or publisher id. */
  auId: string;
  launchMode?: string | undefined;
  returnUrl?: string | undefined;
  ttlSeconds: number;
  /** Absolute endpoint of the LRS, ending in `/`. */
  lrsEndpoint: string;
  /** Builds the fetch URL for a session from its id and one-time key. */
  fetchUrlFor: (sessionId: string, key: string) => string;
  /** Builds an absolute URL for a file inside the course package. */
  contentUrlFor: (courseId: string, relativePath: string) => string;
  homePage: string;
  now?: Date;
  events?: EventSink | undefined;
}

export interface LaunchResult {
  url: string;
  sessionId: string;
  launchMode: LaunchMode;
  launchMethod: string;
  expiresAt: string;
}

/**
 * Launch an AU: abandon any session the learner left open on it, open a new
 * session, write `LMS.LaunchData`, record `launched`, and compose the launch URL.
 */
export async function launchAu(input: LaunchInput, prisma: PrismaClient): Promise<LaunchResult> {
  const now = input.now ?? new Date();
  const launchMode = (input.launchMode ?? 'Normal') as LaunchMode;
  if (!LAUNCH_MODES.includes(launchMode)) {
    throw new Cmi5Error(400, 'invalid_launch_mode', `launchMode must be one of ${LAUNCH_MODES.join(', ')}`);
  }

  const reg = await prisma.cmi5Registration.findFirst({
    where: { id: input.registrationId, tenantId: input.tenantId },
  });
  if (!reg) throw new Cmi5Error(404, 'registration_not_found', 'Registration not found');

  const au = await findAu(reg.courseId, input.auId, prisma);
  if (!au) throw new Cmi5Error(404, 'au_not_found', 'AU not found in this course');

  const actor = reg.actor as Actor;
  const authority = lrsAuthority(input.tenantId, input.homePage);

  await abandonOpenSessions(
    { tenantId: input.tenantId, reg, au, actor, authority, now, events: input.events },
    prisma,
  );

  const sessionId = randomUUID();
  const fetchKey = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

  await prisma.cmi5Session.create({
    data: {
      id: sessionId,
      tenantId: input.tenantId,
      registrationId: reg.id,
      auId: au.id,
      launchMode,
      status: 'LAUNCHED',
      fetchKeyHash: hashKey(fetchKey),
      expiresAt,
      launchedAt: now,
    },
  });

  const launchData: Record<string, unknown> = {
    contextTemplate: {
      contextActivities: { grouping: [{ objectType: 'Activity', id: au.publisherId }] },
      extensions: { [EXTENSION.sessionId]: sessionId },
    },
    launchMode,
    moveOn: au.moveOn,
  };
  if (au.launchParameters) launchData.launchParameters = au.launchParameters;
  if (au.masteryScore !== null) launchData.masteryScore = au.masteryScore;
  if (input.returnUrl) launchData.returnURL = input.returnUrl;
  if (au.entitlementKey) launchData.entitlementKey = { courseStructure: au.entitlementKey };

  await putState(
    {
      key: {
        tenantId: input.tenantId,
        activityId: au.activityId,
        agent: actor,
        registration: reg.id,
        stateId: LAUNCH_DATA_STATE_ID,
      },
      content: Buffer.from(JSON.stringify(launchData), 'utf8'),
      contentType: 'application/json',
    },
    prisma,
  );

  const base = ABSOLUTE_URL.test(au.url) ? au.url : input.contentUrlFor(reg.courseId, au.url);
  const url = new URL(base);
  url.searchParams.set('endpoint', input.lrsEndpoint);
  url.searchParams.set('fetch', input.fetchUrlFor(sessionId, fetchKey));
  url.searchParams.set('actor', JSON.stringify(actor));
  url.searchParams.set('registration', reg.id);
  url.searchParams.set('activityId', au.activityId);

  const extensions: Record<string, unknown> = {
    [EXTENSION.sessionId]: sessionId,
    [EXTENSION.launchMode]: launchMode,
    [EXTENSION.launchUrl]: base,
    [EXTENSION.moveOn]: au.moveOn,
  };
  if (au.launchParameters) extensions[EXTENSION.launchParameters] = au.launchParameters;
  if (au.masteryScore !== null) extensions[EXTENSION.masteryScore] = au.masteryScore;

  await storeStatements(
    {
      tenantId: input.tenantId,
      authority,
      now,
      events: input.events,
      statements: [
        lmsStatement({
          verb: VERBS.launched,
          display: 'Launched',
          actor,
          objectId: au.activityId,
          registrationId: reg.id,
          publisherId: au.publisherId,
          extensions,
          now,
        }),
      ],
    },
    prisma,
  );

  return {
    url: url.toString(),
    sessionId,
    launchMode,
    launchMethod: au.launchMethod,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Redeem a fetch URL. Each one works exactly once (cmi5 §8.2.3); the caller
 * mints the auth token from the returned session.
 */
export async function redeemFetchKey(
  sessionId: string,
  key: string,
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ tenantId: string; sessionId: string; registrationId: string; expiresAt: Date }> {
  const session = await prisma.cmi5Session.findFirst({ where: { id: sessionId } });
  if (!session || !keyMatches(key, session.fetchKeyHash)) {
    throw new Cmi5Error(401, '2', 'Fetch URL is not valid');
  }
  if (session.fetchedAt) {
    throw new Cmi5Error(401, '1', 'Fetch URL has already been used');
  }
  if (session.expiresAt <= now || session.status === 'TERMINATED' || session.status === 'ABANDONED') {
    throw new Cmi5Error(401, '2', 'Fetch URL has expired');
  }
  const claimed = await prisma.cmi5Session.updateMany({
    where: { id: session.id, fetchedAt: null },
    data: { fetchedAt: now },
  });
  // Lost a race against a concurrent redeem of the same URL.
  if (claimed.count === 0) throw new Cmi5Error(401, '1', 'Fetch URL has already been used');

  return {
    tenantId: session.tenantId,
    sessionId: session.id,
    registrationId: session.registrationId,
    expiresAt: session.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Statements from an AU session
// ---------------------------------------------------------------------------

export interface SessionStatementsInput {
  tenantId: string;
  sessionId: string;
  statements: unknown[];
  statementId?: string | undefined;
  homePage: string;
  now?: Date;
  events?: EventSink | undefined;
}

/**
 * Store statements an AU sent under a cmi5 session token, after enforcing the
 * cmi5 rules, then advance the session and registration state they imply.
 */
export async function recordSessionStatements(
  input: SessionStatementsInput,
  prisma: PrismaClient,
): Promise<StoreStatementsResult> {
  const now = input.now ?? new Date();
  const session = await prisma.cmi5Session.findFirst({
    where: { id: input.sessionId, tenantId: input.tenantId },
  });
  if (!session) throw new Cmi5Error(401, 'session_not_found', 'cmi5 session not found');

  const reg = await prisma.cmi5Registration.findFirst({ where: { id: session.registrationId } });
  const au = await prisma.cmi5Au.findFirst({ where: { id: session.auId } });
  if (!reg || !au) throw new Cmi5Error(401, 'session_not_found', 'cmi5 session not found');

  const state = auStateOf(reg);
  const before = { ...EMPTY_PROGRESS, ...state[au.publisherId] };

  // An AU retrying a batch that already landed resends statements the session
  // state has moved past. Leave those to the LRS's own duplicate check (no-op
  // if identical, 409 if not) instead of failing them on the rules.
  const ids = input.statements
    .map((s) => (s as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.toLowerCase());
  const alreadyStored = new Set(
    ids.length === 0
      ? []
      : (
          await prisma.xapiStatement.findMany({
            where: { tenantId: input.tenantId, statementId: { in: ids } },
            select: { statementId: true },
          })
        ).map((row) => row.statementId),
  );
  const fresh = input.statements.filter((s) => {
    const id = (s as { id?: unknown } | null)?.id;
    return typeof id !== 'string' || !alreadyStored.has(id.toLowerCase());
  });

  const outcome = applyAuStatements(fresh, {
    sessionId: session.id,
    registrationId: reg.id,
    actorIfi: reg.actorIfi,
    auActivityId: au.activityId,
    launchMode: session.launchMode,
    masteryScore: au.masteryScore,
    status: session.status as SessionStatus,
    progress: before,
  });

  const authority = lrsAuthority(input.tenantId, input.homePage);
  const stored = await storeStatements(
    {
      tenantId: input.tenantId,
      statements: input.statements,
      statementId: input.statementId,
      authority,
      now,
      events: input.events,
    },
    prisma,
  );

  if (outcome.status !== session.status) {
    await prisma.cmi5Session.update({
      where: { id: session.id },
      data: {
        status: outcome.status,
        ...(outcome.initialized ? { initializedAt: now } : {}),
        ...(outcome.terminated ? { endedAt: now } : {}),
      },
    });
  }

  if (!sameProgress(before, outcome.progress)) {
    await saveProgress(
      {
        tenantId: input.tenantId,
        reg,
        au,
        progress: outcome.progress,
        sessionId: session.id,
        authority,
        now,
        events: input.events,
      },
      prisma,
    );
  }

  if (outcome.terminated) {
    input.events?.emit(input.tenantId, 'cmi5.session.terminated', {
      ...eventSubject(reg, au),
      sessionId: session.id,
      launchMode: session.launchMode,
      progress: { ...outcome.progress, satisfied: meetsMoveOn(au.moveOn, outcome.progress) },
    });
  }

  return stored;
}

/** Resolve the session a cmi5 token names, if it is still accepting statements. */
export async function getActiveSession(
  tenantId: string,
  sessionId: string,
  prisma: PrismaClient,
): Promise<{ registrationId: string; actorIfi: string } | null> {
  const session = await prisma.cmi5Session.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) return null;
  const reg = await prisma.cmi5Registration.findFirst({
    where: { id: session.registrationId },
    select: { actorIfi: true },
  });
  if (!reg) return null;
  return { registrationId: session.registrationId, actorIfi: reg.actorIfi };
}

// ---------------------------------------------------------------------------
// Waive
// ---------------------------------------------------------------------------

export interface WaiveInput {
  tenantId: string;
  registrationId: string;
  auId: string;
  reason: string;
  homePage: string;
  now?: Date;
  events?: EventSink | undefined;
}

export async function waiveAu(input: WaiveInput, prisma: PrismaClient): Promise<void> {
  const now = input.now ?? new Date();
  if (!WAIVE_REASONS.includes(input.reason as WaiveReason)) {
    throw new Cmi5Error(400, 'invalid_reason', `reason must be one of ${WAIVE_REASONS.join(', ')}`);
  }
  const reg = await prisma.cmi5Registration.findFirst({
    where: { id: input.registrationId, tenantId: input.tenantId },
  });
  if (!reg) throw new Cmi5Error(404, 'registration_not_found', 'Registration not found');
  const au = await findAu(reg.courseId, input.auId, prisma);
  if (!au) throw new Cmi5Error(404, 'au_not_found', 'AU not found in this course');

  const state = auStateOf(reg);
  const before = { ...EMPTY_PROGRESS, ...state[au.publisherId] };
  if (meetsMoveOn(au.moveOn, before) && au.moveOn !== 'NotApplicable') {
    throw new Cmi5Error(409, 'already_satisfied', 'The AU is already satisfied');
  }

  const authority = lrsAuthority(input.tenantId, input.homePage);
  const sessionId = randomUUID();
  await storeStatements(
    {
      tenantId: input.tenantId,
      authority,
      now,
      events: input.events,
      statements: [
        lmsStatement({
          verb: VERBS.waived,
          display: 'Waived',
          actor: reg.actor as Actor,
          objectId: au.activityId,
          registrationId: reg.id,
          publisherId: au.publisherId,
          extensions: { [EXTENSION.sessionId]: sessionId },
          moveOn: true,
          result: {
            success: true,
            completion: true,
            extensions: { [EXTENSION.reason]: input.reason },
          },
          now,
        }),
      ],
    },
    prisma,
  );

  input.events?.emit(input.tenantId, 'cmi5.au.waived', { ...eventSubject(reg, au), reason: input.reason });

  await saveProgress(
    {
      tenantId: input.tenantId,
      reg,
      au,
      progress: { ...before, waived: true },
      sessionId,
      authority,
      now,
      events: input.events,
    },
    prisma,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type AuRow = Awaited<ReturnType<PrismaClient['cmi5Au']['findFirst']>> & {};
type RegRow = Awaited<ReturnType<PrismaClient['cmi5Registration']['findFirst']>> & {};

async function listAus(courseId: string, prisma: PrismaClient): Promise<AuRow[]> {
  return prisma.cmi5Au.findMany({ where: { courseId }, orderBy: { order: 'asc' } });
}

async function findAu(courseId: string, auId: string, prisma: PrismaClient): Promise<AuRow | null> {
  return (
    (await prisma.cmi5Au.findFirst({ where: { courseId, id: auId } })) ??
    (await prisma.cmi5Au.findFirst({ where: { courseId, publisherId: auId } }))
  );
}

/**
 * Close sessions the learner never terminated. Sessions that got as far as
 * `initialized` get an `abandoned` statement; ones that never started just close.
 */
async function abandonOpenSessions(
  ctx: {
    tenantId: string;
    reg: RegRow;
    au: AuRow;
    actor: Actor;
    authority: Actor;
    now: Date;
    events?: EventSink | undefined;
  },
  prisma: PrismaClient,
): Promise<void> {
  const open = await prisma.cmi5Session.findMany({
    where: {
      registrationId: ctx.reg.id,
      auId: ctx.au.id,
      status: { in: ['LAUNCHED', 'INITIALIZED'] },
    },
  });
  if (open.length === 0) return;
  const initialized = open.filter((s) => s.status === 'INITIALIZED');

  await prisma.cmi5Session.updateMany({
    where: { id: { in: open.map((s) => s.id) } },
    data: { status: 'ABANDONED', endedAt: ctx.now },
  });

  const statements = initialized.map((s) =>
      lmsStatement({
        verb: VERBS.abandoned,
        display: 'Abandoned',
        actor: ctx.actor,
        objectId: ctx.au.activityId,
        registrationId: ctx.reg.id,
        publisherId: ctx.au.publisherId,
        extensions: { [EXTENSION.sessionId]: s.id },
        result: { duration: isoDuration(ctx.now.getTime() - s.launchedAt.getTime()) },
        now: ctx.now,
      }),
    );
  if (statements.length > 0) {
    await storeStatements(
      { tenantId: ctx.tenantId, statements, authority: ctx.authority, now: ctx.now, events: ctx.events },
      prisma,
    );
  }

  // Only sessions the AU actually started count as abandoned; a launch the
  // learner never opened just closes.
  for (const s of initialized) {
    ctx.events?.emit(ctx.tenantId, 'cmi5.session.abandoned', { ...eventSubject(ctx.reg, ctx.au), sessionId: s.id });
  }
}

/** Who and what a cmi5 event is about. */
function eventSubject(reg: RegRow, au: AuRow): Record<string, unknown> {
  return {
    registrationId: reg.id,
    courseId: reg.courseId,
    actor: reg.actor,
    au: { id: au.id, publisherId: au.publisherId, title: au.title },
  };
}

/**
 * Persist an AU's new progress, and record `satisfied` for every block — then
 * the course — that it tips over. Blocks are reported
 * innermost first, the course last.
 */
async function saveProgress(
  ctx: {
    tenantId: string;
    reg: RegRow;
    au: AuRow;
    progress: AuProgress;
    sessionId: string;
    authority: Actor;
    now: Date;
    events?: EventSink | undefined;
  },
  prisma: PrismaClient,
): Promise<void> {
  const state = { ...auStateOf(ctx.reg) };
  state[ctx.au.publisherId] = {
    ...ctx.progress,
    satisfied: meetsMoveOn(ctx.au.moveOn, ctx.progress),
  };

  const aus = await listAus(ctx.reg.courseId, prisma);
  const moveOnOf = new Map(aus.map((au) => [au.publisherId, au.moveOn]));
  const isAuSatisfied = (publisherId: string) =>
    meetsMoveOn(moveOnOf.get(publisherId) ?? 'NotApplicable', { ...EMPTY_PROGRESS, ...state[publisherId] });

  const course = await prisma.cmi5Course.findFirst({
    where: { id: ctx.reg.courseId },
    select: { activityId: true, publisherId: true, structure: true },
  });
  const blocks = new Map(flattenBlocks(structureChildren(course)).map((b) => [b.id, b]));

  const blockState = { ...blockStateOf(ctx.reg) };
  const statements: Record<string, unknown>[] = [];
  const satisfiedStatement = (objectId: string, objectType: string, publisherId: string) =>
    lmsStatement({
      verb: VERBS.satisfied,
      display: 'Satisfied',
      actor: ctx.reg.actor as Actor,
      objectId,
      objectType,
      registrationId: ctx.reg.id,
      publisherId,
      extensions: { [EXTENSION.sessionId]: ctx.sessionId },
      now: ctx.now,
    });

  const newlySatisfied: string[] = [];
  for (const blockId of satisfiedBlocks(structureChildren(course), isAuSatisfied)) {
    if (blockState[blockId]) continue;
    blockState[blockId] = ctx.now.toISOString();
    newlySatisfied.push(blockId);
    // Courses imported before blocks got their own activity id fall back to the publisher id.
    const activityId = blocks.get(blockId)?.activityId ?? blockId;
    statements.push(satisfiedStatement(activityId, ACTIVITY_TYPE.block, blockId));
  }

  let satisfiedAt = ctx.reg.satisfiedAt;
  let courseNewlySatisfied = false;
  if (!satisfiedAt && aus.every((au) => isAuSatisfied(au.publisherId))) {
    satisfiedAt = ctx.now;
    courseNewlySatisfied = true;
    if (course) {
      statements.push(satisfiedStatement(course.activityId, ACTIVITY_TYPE.course, course.publisherId));
    }
  }

  if (statements.length > 0) {
    await storeStatements(
      { tenantId: ctx.tenantId, authority: ctx.authority, now: ctx.now, statements, events: ctx.events },
      prisma,
    );
  }

  await prisma.cmi5Registration.update({
    where: { id: ctx.reg.id },
    data: {
      auState: state as unknown as Prisma.InputJsonValue,
      blockState: blockState as unknown as Prisma.InputJsonValue,
      satisfiedAt,
    },
  });

  // Emitted once the state is saved, so a receiver that calls back sees it.
  const subject = { registrationId: ctx.reg.id, courseId: ctx.reg.courseId, actor: ctx.reg.actor };
  for (const blockId of newlySatisfied) {
    ctx.events?.emit(ctx.tenantId, 'cmi5.block.satisfied', {
      ...subject,
      block: { publisherId: blockId, title: blocks.get(blockId)?.title ?? blockId },
    });
  }
  if (courseNewlySatisfied) {
    ctx.events?.emit(ctx.tenantId, 'cmi5.course.satisfied', { ...subject, satisfiedAt: ctx.now.toISOString() });
  }
}

function lmsStatement(args: {
  verb: string;
  display: string;
  actor: Actor;
  objectId: string;
  objectType?: string;
  registrationId: string;
  publisherId: string;
  extensions: Record<string, unknown>;
  moveOn?: boolean;
  result?: Record<string, unknown>;
  now: Date;
}): Record<string, unknown> {
  const category: Array<{ objectType: string; id: string }> = [
    { objectType: 'Activity', id: CATEGORY.cmi5 },
  ];
  if (args.moveOn) category.push({ objectType: 'Activity', id: CATEGORY.moveOn });
  return {
    id: randomUUID(),
    actor: args.actor,
    verb: { id: args.verb, display: { 'en-US': args.display } },
    object: {
      objectType: 'Activity',
      id: args.objectId,
      ...(args.objectType ? { definition: { type: args.objectType } } : {}),
    },
    ...(args.result ? { result: args.result } : {}),
    context: {
      registration: args.registrationId,
      contextActivities: {
        category,
        grouping: [{ objectType: 'Activity', id: args.publisherId }],
      },
      extensions: args.extensions,
    },
    timestamp: args.now.toISOString(),
  };
}

function isoDuration(ms: number): string {
  return `PT${Math.max(0, Math.round(ms / 10) / 100)}S`;
}

function sameProgress(a: AuProgress, b: AuProgress): boolean {
  return a.completed === b.completed && a.passed === b.passed && a.failed === b.failed && a.waived === b.waived;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function keyMatches(key: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashKey(key), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
