import type { PrismaClient } from '../db/client.js';
import {
  checkPreconditions,
  etagFor,
  hashLookupKey,
  mergeJsonDocuments,
  type Preconditions,
} from './documents.js';
import { actorIfi } from './ifi.js';
import type { Actor } from './types.js';

export { etagFor, parseEtagHeader } from './documents.js';
export type { Preconditions } from './documents.js';

/** Identifies one State API document. */
export interface StateKey {
  tenantId: string;
  activityId: string;
  agent: Actor;
  registration?: string | undefined;
  stateId: string;
}

export interface StateDocument {
  stateId: string;
  contentType: string;
  content: Buffer;
  etag: string;
  updatedAt: Date;
}

function lookupKey(key: StateKey): string {
  return hashLookupKey([
    key.activityId,
    actorIfi(key.agent),
    key.registration ?? '',
    key.stateId,
  ]);
}

export async function getState(key: StateKey, prisma: PrismaClient): Promise<StateDocument | null> {
  const row = await prisma.xapiState.findUnique({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
  });
  if (!row) return null;
  return {
    stateId: row.stateId,
    contentType: row.contentType,
    content: Buffer.from(row.content),
    etag: row.etag,
    updatedAt: row.updatedAt,
  };
}

export interface ListStateIdsInput {
  tenantId: string;
  activityId: string;
  agent: Actor;
  registration?: string | undefined;
  since?: Date | undefined;
}

export async function listStateIds(
  input: ListStateIdsInput,
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await prisma.xapiState.findMany({
    where: {
      tenantId: input.tenantId,
      activityId: input.activityId,
      agentIfi: actorIfi(input.agent),
      ...(input.registration ? { registration: input.registration } : {}),
      ...(input.since ? { updatedAt: { gt: input.since } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: { stateId: true },
  });
  return rows.map((r) => r.stateId);
}

export interface WriteStateInput {
  key: StateKey;
  content: Buffer;
  contentType: string;
  preconditions?: Preconditions;
}

/** Replace a document (`PUT`). */
export async function putState(
  input: WriteStateInput,
  prisma: PrismaClient,
): Promise<StateDocument> {
  const existing = await getState(input.key, prisma);
  checkPreconditions(existing, input.preconditions, 'state_precondition_required');
  return write(input.key, input.content, input.contentType, prisma);
}

/** Merge a document (`POST`). */
export async function postState(
  input: WriteStateInput,
  prisma: PrismaClient,
): Promise<StateDocument> {
  const existing = await getState(input.key, prisma);
  checkPreconditions(existing, input.preconditions, 'state_precondition_required');

  if (!existing) {
    return write(input.key, input.content, input.contentType, prisma);
  }

  const merged = mergeJsonDocuments(
    existing,
    { contentType: input.contentType, content: input.content },
    'state',
  );
  return write(input.key, merged, 'application/json', prisma);
}

export async function deleteState(
  key: StateKey,
  prisma: PrismaClient,
  preconditions?: Preconditions,
): Promise<void> {
  const existing = await getState(key, prisma);
  checkPreconditions(existing, preconditions, 'state_precondition_required');
  if (!existing) return;
  await prisma.xapiState.delete({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
  });
}

/** Delete every document for an activity/agent (optionally one registration). */
export async function deleteStates(
  input: Omit<ListStateIdsInput, 'since'>,
  prisma: PrismaClient,
): Promise<number> {
  const result = await prisma.xapiState.deleteMany({
    where: {
      tenantId: input.tenantId,
      activityId: input.activityId,
      agentIfi: actorIfi(input.agent),
      ...(input.registration ? { registration: input.registration } : {}),
    },
  });
  return result.count;
}

async function write(
  key: StateKey,
  content: Buffer,
  contentType: string,
  prisma: PrismaClient,
): Promise<StateDocument> {
  const etag = etagFor(content);
  const row = await prisma.xapiState.upsert({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
    create: {
      tenantId: key.tenantId,
      lookupKey: lookupKey(key),
      activityId: key.activityId,
      agentIfi: actorIfi(key.agent),
      registration: key.registration ?? null,
      stateId: key.stateId,
      contentType,
      content,
      etag,
    },
    update: { contentType, content, etag },
  });
  return {
    stateId: row.stateId,
    contentType: row.contentType,
    content: Buffer.from(row.content),
    etag: row.etag,
    updatedAt: row.updatedAt,
  };
}
