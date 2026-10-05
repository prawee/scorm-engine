import type { PrismaClient } from '../db/client.js';
import { ActorSchema } from '../xapi/schema.js';
import { getProfile, putProfile } from '../xapi/profile.js';
import type { Actor } from '../xapi/types.js';
import {
  AUDIO_PREFERENCES,
  LEARNER_PREFERENCES_PROFILE_ID,
  type AudioPreference,
} from './constants.js';
import { Cmi5Error } from './service.js';

/**
 * The `cmi5LearnerPreferences` Agent Profile document (cmi5 §11).
 *
 * The LMS owns it; AUs read it through the LRS Agent Profile API to pick a
 * language and decide whether to play audio. It belongs to the learner rather
 * than a registration, so one document serves every course they take.
 */

export interface LearnerPreferences {
  /** Comma-separated RFC 5646 language codes, most preferred first. */
  languagePreference?: string;
  audioPreference?: AudioPreference;
}

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/** Validate a preferences payload; unknown keys are dropped. */
export function parseLearnerPreferences(input: unknown): LearnerPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Cmi5Error(400, 'invalid_preferences', 'learner preferences must be an object');
  }
  const raw = input as Record<string, unknown>;
  const out: LearnerPreferences = {};

  if (raw.languagePreference !== undefined) {
    const value = raw.languagePreference;
    const tags = typeof value === 'string' ? value.split(',').map((t) => t.trim()) : [];
    if (tags.length === 0 || !tags.every((t) => LANGUAGE_TAG.test(t))) {
      throw new Cmi5Error(
        400,
        'invalid_preferences',
        'languagePreference must be a comma-separated list of RFC 5646 language codes',
      );
    }
    out.languagePreference = tags.join(',');
  }

  if (raw.audioPreference !== undefined) {
    if (!AUDIO_PREFERENCES.includes(raw.audioPreference as AudioPreference)) {
      throw new Cmi5Error(400, 'invalid_preferences', `audioPreference must be one of ${AUDIO_PREFERENCES.join(', ')}`);
    }
    out.audioPreference = raw.audioPreference as AudioPreference;
  }

  return out;
}

function identifiedAgent(actor: unknown): Actor {
  const parsed = ActorSchema.safeParse(actor);
  if (!parsed.success || parsed.data.objectType === 'Group') {
    throw new Cmi5Error(400, 'invalid_actor', 'actor must be an identified xAPI Agent');
  }
  return parsed.data;
}

export async function getLearnerPreferences(
  tenantId: string,
  actor: unknown,
  prisma: PrismaClient,
): Promise<LearnerPreferences | null> {
  const doc = await getProfile(
    { tenantId, scope: 'AGENT', agent: identifiedAgent(actor), profileId: LEARNER_PREFERENCES_PROFILE_ID },
    prisma,
  );
  if (!doc) return null;
  try {
    return parseLearnerPreferences(JSON.parse(doc.content.toString('utf8')));
  } catch {
    // Someone wrote a malformed document through the raw Agent Profile API.
    return {};
  }
}

/** Replace the learner's preferences document. */
export async function setLearnerPreferences(
  tenantId: string,
  actor: unknown,
  preferences: LearnerPreferences,
  prisma: PrismaClient,
): Promise<LearnerPreferences> {
  await putProfile(
    {
      key: { tenantId, scope: 'AGENT', agent: identifiedAgent(actor), profileId: LEARNER_PREFERENCES_PROFILE_ID },
      content: Buffer.from(JSON.stringify(preferences), 'utf8'),
      contentType: 'application/json',
    },
    prisma,
  );
  return preferences;
}
