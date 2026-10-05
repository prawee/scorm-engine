/** IRIs the cmi5 specification defines. */

export const VERBS = {
  launched: 'http://adlnet.gov/expapi/verbs/launched',
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
  abandoned: 'https://w3id.org/xapi/adl/verbs/abandoned',
  waived: 'https://w3id.org/xapi/adl/verbs/waived',
  terminated: 'http://adlnet.gov/expapi/verbs/terminated',
  satisfied: 'https://w3id.org/xapi/adl/verbs/satisfied',
} as const;

/** Verbs only the LMS may use; an AU sending one is rejected. */
export const LMS_ONLY_VERBS = new Set<string>([
  VERBS.launched,
  VERBS.abandoned,
  VERBS.waived,
  VERBS.satisfied,
]);

/** cmi5 defined verbs an AU may send. Anything else is a "cmi5 allowed" statement. */
export const AU_DEFINED_VERBS = new Set<string>([
  VERBS.initialized,
  VERBS.completed,
  VERBS.passed,
  VERBS.failed,
  VERBS.terminated,
]);

export const CATEGORY = {
  cmi5: 'https://w3id.org/xapi/cmi5/context/categories/cmi5',
  moveOn: 'https://w3id.org/xapi/cmi5/context/categories/moveon',
} as const;

export const EXTENSION = {
  sessionId: 'https://w3id.org/xapi/cmi5/context/extensions/sessionid',
  launchMode: 'https://w3id.org/xapi/cmi5/context/extensions/launchmode',
  launchUrl: 'https://w3id.org/xapi/cmi5/context/extensions/launchurl',
  moveOn: 'https://w3id.org/xapi/cmi5/context/extensions/moveon',
  launchParameters: 'https://w3id.org/xapi/cmi5/context/extensions/launchparameters',
  masteryScore: 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore',
  reason: 'https://w3id.org/xapi/cmi5/result/extensions/reason',
} as const;

export const ACTIVITY_TYPE = {
  course: 'https://w3id.org/xapi/cmi5/activitytype/course',
  block: 'https://w3id.org/xapi/cmi5/activitytype/block',
} as const;

/** State API id of the document the LMS writes before each launch. */
export const LAUNCH_DATA_STATE_ID = 'LMS.LaunchData';

/** Agent Profile id of the learner's language / audio preferences (cmi5 §11). */
export const LEARNER_PREFERENCES_PROFILE_ID = 'cmi5LearnerPreferences';

export const AUDIO_PREFERENCES = ['on', 'off'] as const;
export type AudioPreference = (typeof AUDIO_PREFERENCES)[number];

export const LAUNCH_MODES = ['Normal', 'Browse', 'Review'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export const MOVE_ON = [
  'Passed',
  'Completed',
  'CompletedAndPassed',
  'CompletedOrPassed',
  'NotApplicable',
] as const;
export type MoveOn = (typeof MOVE_ON)[number];

export const LAUNCH_METHODS = ['AnyWindow', 'OwnWindow'] as const;
export type LaunchMethod = (typeof LAUNCH_METHODS)[number];

/** Reasons the spec allows on a `waived` statement. */
export const WAIVE_REASONS = ['Tested Out', 'Equivalent AU', 'Equivalent Outside Activity', 'Administrative'] as const;
export type WaiveReason = (typeof WAIVE_REASONS)[number];
