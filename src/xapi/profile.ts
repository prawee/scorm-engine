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

/**
 * The xAPI Activity Profile and Agent Profile resources.
 *
 * The two are the same document API with a different owner — an activity IRI or
 * an agent IFI — so they share one storage model and one set of operations,
 * discriminated by `scope`. Document semantics (etags, conditional requests,
 * PUT-replaces / POST-merges) come from `documents.ts`, exactly as the State
 * resource does.
 */

export type ProfileScope = 'ACTIVITY' | 'AGENT';

/** Identifies one Profile document: an owner plus a profileId. */
export type ProfileKey = {
  tenantId: string;
  profileId: string;
} & ({ scope: 'ACTIVITY'; activityId: string } | { scope: 'AGENT'; agent: Actor });

export interface ProfileDocument {
  profileId: string;
  contentType: string;
  content: Buffer;
  etag: string;
  updatedAt: Date;
}

/** The owner half of a key, without a profileId — used for listing and bulk reads. */
export type ProfileOwner = { tenantId: string } & (
  | { scope: 'ACTIVITY'; activityId: string }
  | { scope: 'AGENT'; agent: Actor }
);

/** The stored columns that identify the owner, derived from the discriminated key. */
function ownerColumns(owner: ProfileOwner): { activityId: string | null; agentIfi: string | null } {
  return owner.scope === 'ACTIVITY'
    ? { activityId: owner.activityId, agentIfi: null }
    : { activityId: null, agentIfi: actorIfi(owner.agent) };
}

function lookupKey(key: ProfileKey): string {
  const { activityId, agentIfi } = ownerColumns(key);
  return hashLookupKey([key.scope, activityId ?? '', agentIfi ?? '', key.profileId]);
}

function whereOwner(owner: ProfileOwner): Record<string, unknown> {
  const { activityId, agentIfi } = ownerColumns(owner);
  return owner.scope === 'ACTIVITY'
    ? { tenantId: owner.tenantId, scope: 'ACTIVITY', activityId }
    : { tenantId: owner.tenantId, scope: 'AGENT', agentIfi };
}

function toDocument(row: {
  profileId: string;
  contentType: string;
  content: Uint8Array;
  etag: string;
  updatedAt: Date;
}): ProfileDocument {
  return {
    profileId: row.profileId,
    contentType: row.contentType,
    content: Buffer.from(row.content),
    etag: row.etag,
    updatedAt: row.updatedAt,
  };
}

export async function getProfile(
  key: ProfileKey,
  prisma: PrismaClient,
): Promise<ProfileDocument | null> {
  const row = await prisma.xapiProfile.findUnique({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
  });
  return row ? toDocument(row) : null;
}

export interface ListProfileIdsInput {
  owner: ProfileOwner;
  since?: Date | undefined;
}

export async function listProfileIds(
  input: ListProfileIdsInput,
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await prisma.xapiProfile.findMany({
    where: {
      ...whereOwner(input.owner),
      ...(input.since ? { updatedAt: { gt: input.since } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: { profileId: true },
  });
  return rows.map((r) => r.profileId);
}

export interface WriteProfileInput {
  key: ProfileKey;
  content: Buffer;
  contentType: string;
  preconditions?: Preconditions;
}

/** Replace a document (`PUT`). */
export async function putProfile(
  input: WriteProfileInput,
  prisma: PrismaClient,
): Promise<ProfileDocument> {
  const existing = await getProfile(input.key, prisma);
  checkPreconditions(existing, input.preconditions, 'profile_precondition_required');
  return write(input.key, input.content, input.contentType, prisma);
}

/** Merge a document (`POST`). */
export async function postProfile(
  input: WriteProfileInput,
  prisma: PrismaClient,
): Promise<ProfileDocument> {
  const existing = await getProfile(input.key, prisma);
  checkPreconditions(existing, input.preconditions, 'profile_precondition_required');

  if (!existing) {
    return write(input.key, input.content, input.contentType, prisma);
  }

  const merged = mergeJsonDocuments(
    existing,
    { contentType: input.contentType, content: input.content },
    'profile',
  );
  return write(input.key, merged, 'application/json', prisma);
}

export async function deleteProfile(
  key: ProfileKey,
  prisma: PrismaClient,
  preconditions?: Preconditions,
): Promise<void> {
  const existing = await getProfile(key, prisma);
  checkPreconditions(existing, preconditions, 'profile_precondition_required');
  if (!existing) return;
  await prisma.xapiProfile.delete({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
  });
}

async function write(
  key: ProfileKey,
  content: Buffer,
  contentType: string,
  prisma: PrismaClient,
): Promise<ProfileDocument> {
  const etag = etagFor(content);
  const { activityId, agentIfi } = ownerColumns(key);
  const row = await prisma.xapiProfile.upsert({
    where: { tenantId_lookupKey: { tenantId: key.tenantId, lookupKey: lookupKey(key) } },
    create: {
      tenantId: key.tenantId,
      scope: key.scope,
      lookupKey: lookupKey(key),
      activityId,
      agentIfi,
      profileId: key.profileId,
      contentType,
      content,
      etag,
    },
    update: { contentType, content, etag },
  });
  return toDocument(row);
}
