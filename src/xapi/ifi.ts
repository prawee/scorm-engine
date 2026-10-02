import { createHash } from 'node:crypto';

import type { Actor, Agent, Group } from './types.js';

/**
 * Collapse an Agent or Group down to a single canonical string — its
 * inverse-functional identifier (IFI).
 *
 * xAPI says two actors are the same actor when they share an IFI, so every
 * lookup (statement `agent` filter, State API document key) keys off this
 * string rather than off the actor object, which clients may spell differently
 * from one statement to the next (extra `name`, reordered keys, different
 * `objectType` casing on groups, and so on).
 *
 * Anonymous groups have no IFI of their own; per the spec their identity is the
 * set of their members, so we hash the sorted member IFIs instead.
 */
export function actorIfi(actor: Actor): string {
  const direct = agentIfi(actor);
  if (direct) return direct;

  if (actor.objectType === 'Group') {
    const members = ((actor as Group).member ?? [])
      .map((m) => agentIfi(m))
      .filter((v): v is string => Boolean(v))
      .sort();
    const digest = createHash('sha1').update(members.join('\n')).digest('hex');
    return `group:${digest}`;
  }

  // The zod schema rejects these before we get here; be explicit anyway.
  throw new Error('Actor has no inverse-functional identifier');
}

/** The IFI of an identified actor, or `undefined` for an anonymous group. */
export function agentIfi(actor: Agent | Group): string | undefined {
  if (actor.mbox) return `mbox:${actor.mbox.trim().toLowerCase()}`;
  if (actor.mbox_sha1sum) return `mbox_sha1sum:${actor.mbox_sha1sum.trim().toLowerCase()}`;
  if (actor.openid) return `openid:${actor.openid.trim()}`;
  if (actor.account) return `account:${actor.account.homePage.trim()}|${actor.account.name}`;
  return undefined;
}

/** How many inverse-functional identifiers an actor carries (must be exactly 1 for an Agent). */
export function countIfis(actor: {
  mbox?: unknown;
  mbox_sha1sum?: unknown;
  openid?: unknown;
  account?: unknown;
}): number {
  let n = 0;
  if (actor.mbox !== undefined) n += 1;
  if (actor.mbox_sha1sum !== undefined) n += 1;
  if (actor.openid !== undefined) n += 1;
  if (actor.account !== undefined) n += 1;
  return n;
}
