import { XapiError } from '../xapi/errors.js';
import { actorIfi } from '../xapi/ifi.js';
import type { Actor } from '../xapi/types.js';
import {
  AU_DEFINED_VERBS,
  CATEGORY,
  EXTENSION,
  LMS_ONLY_VERBS,
  VERBS,
  type MoveOn,
} from './constants.js';
import type { StructureNode } from './course-structure.js';

/**
 * The cmi5 statement rules an LMS enforces on statements an AU sends.
 *
 * Pure: given the session's current state and a batch of statements, either
 * return the state the batch moves it to, or throw a 403 naming the first rule
 * broken. Nothing is persisted here — the caller stores the statements and the
 * resulting state together.
 */

/** Per-AU progress within one registration. */
export interface AuProgress {
  completed: boolean;
  passed: boolean;
  failed: boolean;
  waived: boolean;
  satisfied: boolean;
}

export const EMPTY_PROGRESS: AuProgress = {
  completed: false,
  passed: false,
  failed: false,
  waived: false,
  satisfied: false,
};

export type SessionStatus = 'LAUNCHED' | 'INITIALIZED' | 'TERMINATED' | 'ABANDONED';

export interface SessionRuleContext {
  sessionId: string;
  registrationId: string;
  actorIfi: string;
  /** LMS-generated activity id of the AU. */
  auActivityId: string;
  launchMode: string;
  masteryScore: number | null;
  status: SessionStatus;
  progress: AuProgress;
}

export interface RuleOutcome {
  status: SessionStatus;
  progress: AuProgress;
  /** The batch carried the session's `initialized` statement. */
  initialized: boolean;
  /** The batch carried the session's `terminated` statement. */
  terminated: boolean;
}

export function applyAuStatements(statements: unknown[], ctx: SessionRuleContext): RuleOutcome {
  let status = ctx.status;
  const progress = { ...ctx.progress };
  let initialized = false;
  let terminated = false;

  for (const raw of statements) {
    const s = (raw ?? {}) as StatementLike;
    const verb = s.verb?.id;

    if (status === 'TERMINATED' || status === 'ABANDONED') {
      reject('The session has ended; no further statements are accepted');
    }

    if (!s.actor || safeIfi(s.actor) !== ctx.actorIfi) {
      reject('Statement actor does not match the registration actor');
    }
    if (s.context?.registration?.toLowerCase() !== ctx.registrationId.toLowerCase()) {
      reject('Statement context.registration does not match the session registration');
    }
    if (s.context?.extensions?.[EXTENSION.sessionId] !== ctx.sessionId) {
      reject('Statement is missing the session id context extension, or it does not match');
    }
    if (!verb) reject('Statement has no verb');
    if (LMS_ONLY_VERBS.has(verb)) {
      reject(`Only the LMS may send "${verb}" statements`);
    }

    const categories = categoryIds(s);
    const defined = AU_DEFINED_VERBS.has(verb);

    if (status === 'LAUNCHED' && verb !== VERBS.initialized) {
      reject('The first statement of a session must be "initialized"');
    }

    if (!defined) {
      // A "cmi5 allowed" statement: anything goes between initialized and
      // terminated, as long as it does not claim to be cmi5 defined.
      if (categories.includes(CATEGORY.cmi5)) {
        reject('Only cmi5 defined statements may carry the cmi5 category');
      }
      continue;
    }

    if (!categories.includes(CATEGORY.cmi5)) {
      reject('cmi5 defined statements must carry the cmi5 context category');
    }
    if (s.object?.id !== ctx.auActivityId) {
      reject('cmi5 defined statements must target the AU activity id');
    }

    switch (verb) {
      case VERBS.initialized:
        if (status !== 'LAUNCHED') reject('The session is already initialized');
        status = 'INITIALIZED';
        initialized = true;
        break;

      case VERBS.completed:
        requireNormalMode(ctx);
        requireMoveOnCategory(categories);
        if (progress.completed) reject('The AU is already completed in this registration');
        if (s.result?.completion !== true) reject('A completed statement needs result.completion = true');
        progress.completed = true;
        break;

      case VERBS.passed: {
        requireNormalMode(ctx);
        requireMoveOnCategory(categories);
        if (progress.passed) reject('The AU is already passed in this registration');
        if (s.result?.success !== true) reject('A passed statement needs result.success = true');
        const scaled = s.result?.score?.scaled;
        if (ctx.masteryScore !== null) {
          if (typeof scaled !== 'number') {
            reject('A passed statement needs result.score.scaled when the AU has a masteryScore');
          }
          if (scaled < ctx.masteryScore) {
            reject(`score.scaled ${scaled} is below the masteryScore ${ctx.masteryScore}`);
          }
        }
        progress.passed = true;
        break;
      }

      case VERBS.failed: {
        requireNormalMode(ctx);
        requireMoveOnCategory(categories);
        if (progress.passed) reject('The AU is already passed in this registration');
        if (s.result?.success !== false) reject('A failed statement needs result.success = false');
        const scaled = s.result?.score?.scaled;
        if (ctx.masteryScore !== null && typeof scaled === 'number' && scaled >= ctx.masteryScore) {
          reject(`score.scaled ${scaled} meets the masteryScore ${ctx.masteryScore}; send passed`);
        }
        progress.failed = true;
        break;
      }

      case VERBS.terminated:
        status = 'TERMINATED';
        terminated = true;
        break;
    }
  }

  return { status, progress, initialized, terminated };
}

/** Whether an AU's progress meets its moveOn criterion. */
export function meetsMoveOn(moveOn: MoveOn | string, p: AuProgress): boolean {
  if (p.waived) return true;
  switch (moveOn) {
    case 'Passed':
      return p.passed;
    case 'Completed':
      return p.completed;
    case 'CompletedAndPassed':
      return p.completed && p.passed;
    case 'CompletedOrPassed':
      return p.completed || p.passed;
    default:
      return true;
  }
}

/**
 * Publisher ids of the blocks whose every child — AU or nested block — is
 * satisfied, innermost first. Empty blocks are never satisfied.
 */
export function satisfiedBlocks(
  children: StructureNode[],
  isAuSatisfied: (publisherId: string) => boolean,
): string[] {
  const out: string[] = [];
  const visit = (node: StructureNode): boolean => {
    if (node.type === 'au') return isAuSatisfied(node.id);
    // Visit every child, so satisfied blocks nested under unsatisfied ones still count.
    const results = node.children.map(visit);
    const ok = results.length > 0 && results.every(Boolean);
    if (ok) out.push(node.id);
    return ok;
  };
  children.forEach(visit);
  return out;
}

interface StatementLike {
  actor?: Actor;
  verb?: { id?: string };
  object?: { id?: string };
  result?: {
    success?: unknown;
    completion?: unknown;
    score?: { scaled?: unknown };
  };
  context?: {
    registration?: string;
    extensions?: Record<string, unknown>;
    contextActivities?: { category?: unknown };
  };
}

function categoryIds(s: StatementLike): string[] {
  const raw = s.context?.contextActivities?.category;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((a) => (a as { id?: string } | undefined)?.id).filter((id): id is string => !!id);
}

function requireNormalMode(ctx: SessionRuleContext): void {
  if (ctx.launchMode !== 'Normal') {
    reject(`completed, passed and failed are not allowed in ${ctx.launchMode} mode`);
  }
}

function requireMoveOnCategory(categories: string[]): void {
  if (!categories.includes(CATEGORY.moveOn)) {
    reject('completed, passed and failed statements must carry the moveon context category');
  }
}

function safeIfi(actor: Actor): string | undefined {
  try {
    return actorIfi(actor);
  } catch {
    return undefined;
  }
}

function reject(message: string): never {
  throw new XapiError(403, 'cmi5_rule_violation', message);
}
