import type { WebhookEventType } from '../webhooks/events.js';
import type { AttemptRollup, ObjectiveRow } from './mapper.js';

/** The rollup columns a commit can move, before and after. */
export type AttemptProgress = Pick<
  AttemptRollup,
  'completionStatus' | 'successStatus' | 'scoreRaw' | 'scoreMin' | 'scoreMax' | 'scoreScaled'
>;

/**
 * The events one commit raises, from the attempt's progress before and after.
 * Each fires on the transition only, so re-committing the same state is silent.
 */
export function attemptTransitionEvents(
  before: AttemptProgress,
  after: AttemptProgress,
  terminal: boolean,
): WebhookEventType[] {
  const events: WebhookEventType[] = [];
  if (after.completionStatus === 'COMPLETED' && before.completionStatus !== 'COMPLETED') {
    events.push('course.completed');
  }
  if (after.successStatus !== before.successStatus) {
    if (after.successStatus === 'PASSED') events.push('course.passed');
    if (after.successStatus === 'FAILED') events.push('course.failed');
  }
  const scoreChanged =
    after.scoreRaw !== before.scoreRaw ||
    after.scoreScaled !== before.scoreScaled ||
    after.scoreMin !== before.scoreMin ||
    after.scoreMax !== before.scoreMax;
  if (scoreChanged && (after.scoreRaw !== null || after.scoreScaled !== null)) {
    events.push('score.updated');
  }
  if (terminal) events.push('attempt.terminated');
  return events;
}

/**
 * The objectives one commit masters: those whose success status is now
 * `PASSED` but was not before. Objectives are matched by identifier, not
 * index, so content that reorders `cmi.objectives.n` doesn't re-fire them.
 */
export function masteredObjectives(
  before: ReadonlyArray<Pick<ObjectiveRow, 'identifier' | 'successStatus'>>,
  after: readonly ObjectiveRow[],
): ObjectiveRow[] {
  const passed = new Set(before.filter((o) => o.successStatus === 'PASSED').map((o) => o.identifier));
  return after.filter((o) => o.successStatus === 'PASSED' && !passed.has(o.identifier));
}
