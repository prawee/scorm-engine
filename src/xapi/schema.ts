import { z } from 'zod';

import { countIfis } from './ifi.js';

/**
 * Zod schemas for the xAPI 1.0.3 Statement object.
 *
 * The spec's own validity rules are stricter than "is this JSON" — exactly one
 * inverse-functional identifier per Agent, `scaled` inside [-1,1], `revision`
 * and `platform` only against Activity objects, a voiding statement targeting a
 * StatementRef — so the structural schemas below are paired with refinements
 * that encode those rules. Anything that fails here is a 400, never a 500.
 */

const IRI_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SHA1 = /^[0-9a-fA-F]{40}$/;
const MAILTO = /^mailto:[^@\s]+@[^@\s]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// ISO 8601 duration; at least one component, fractional values allowed.
const DURATION =
  /^P(?!$)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=\d)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;

export const VOIDED_VERB = 'http://adlnet.gov/expapi/verbs/voided';

const iri = z
  .string()
  .min(1)
  .refine((v) => IRI_PREFIX.test(v) && !/\s/.test(v), 'must be an absolute IRI');

const uuid = z.string().regex(UUID, 'must be a UUID');

/** An ISO 8601 timestamp we can actually turn into a Date. */
const timestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 timestamp');

const languageMap = z.record(z.string().min(1), z.string());

const extensions = z.record(iri, z.unknown());

const accountSchema = z.object({
  homePage: iri,
  name: z.string().min(1),
});

const ifiFields = {
  mbox: z.string().regex(MAILTO, 'mbox must be a mailto: IRI').optional(),
  mbox_sha1sum: z.string().regex(SHA1, 'mbox_sha1sum must be a SHA-1 hex digest').optional(),
  openid: iri.optional(),
  account: accountSchema.optional(),
};

export const AgentSchema = z
  .object({
    objectType: z.literal('Agent').optional(),
    name: z.string().optional(),
    ...ifiFields,
  })
  .superRefine((agent, ctx) => {
    const n = countIfis(agent);
    if (n !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `an Agent must have exactly one inverse-functional identifier (found ${n})`,
      });
    }
  });

export const GroupSchema = z
  .object({
    objectType: z.literal('Group'),
    name: z.string().optional(),
    member: z.array(AgentSchema).optional(),
    ...ifiFields,
  })
  .superRefine((group, ctx) => {
    const n = countIfis(group);
    if (n > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a Group must not have more than one inverse-functional identifier',
      });
    }
    if (n === 0 && !group.member?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an anonymous Group must list at least one member',
      });
    }
  });

export const ActorSchema = z.union([GroupSchema, AgentSchema]);

export const VerbSchema = z.object({
  id: iri,
  display: languageMap.optional(),
});

const interactionComponent = z.object({
  id: z.string().min(1),
  description: languageMap.optional(),
});

export const ActivityDefinitionSchema = z.object({
  name: languageMap.optional(),
  description: languageMap.optional(),
  type: iri.optional(),
  moreInfo: iri.optional(),
  interactionType: z
    .enum([
      'true-false',
      'choice',
      'fill-in',
      'long-fill-in',
      'matching',
      'performance',
      'sequencing',
      'likert',
      'numeric',
      'other',
    ])
    .optional(),
  correctResponsesPattern: z.array(z.string()).optional(),
  choices: z.array(interactionComponent).optional(),
  scale: z.array(interactionComponent).optional(),
  source: z.array(interactionComponent).optional(),
  target: z.array(interactionComponent).optional(),
  steps: z.array(interactionComponent).optional(),
  extensions: extensions.optional(),
});

export const ActivitySchema = z.object({
  objectType: z.literal('Activity').optional(),
  id: iri,
  definition: ActivityDefinitionSchema.optional(),
});

export const StatementRefSchema = z.object({
  objectType: z.literal('StatementRef'),
  id: uuid,
});

export const ScoreSchema = z
  .object({
    scaled: z.number().min(-1).max(1).optional(),
    raw: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((score, ctx) => {
    if (score.min !== undefined && score.max !== undefined && score.min > score.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score.min must not exceed score.max' });
    }
    if (score.raw !== undefined) {
      if (score.min !== undefined && score.raw < score.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score.raw must not be below score.min' });
      }
      if (score.max !== undefined && score.raw > score.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score.raw must not exceed score.max' });
      }
    }
  });

export const ResultSchema = z.object({
  score: ScoreSchema.optional(),
  success: z.boolean().optional(),
  completion: z.boolean().optional(),
  response: z.string().optional(),
  duration: z.string().regex(DURATION, 'must be an ISO 8601 duration').optional(),
  extensions: extensions.optional(),
});

const contextActivitySet = z.union([ActivitySchema, z.array(ActivitySchema)]);

export const ContextActivitiesSchema = z.object({
  parent: contextActivitySet.optional(),
  grouping: contextActivitySet.optional(),
  category: contextActivitySet.optional(),
  other: contextActivitySet.optional(),
});

export const ContextSchema = z.object({
  registration: uuid.optional(),
  instructor: ActorSchema.optional(),
  team: GroupSchema.optional(),
  contextActivities: ContextActivitiesSchema.optional(),
  revision: z.string().optional(),
  platform: z.string().optional(),
  language: z.string().optional(),
  statement: StatementRefSchema.optional(),
  extensions: extensions.optional(),
});

/** A SubStatement is a Statement minus id/stored/authority/version, and it may not nest. */
export const SubStatementSchema = z.object({
  objectType: z.literal('SubStatement'),
  actor: ActorSchema,
  verb: VerbSchema,
  object: z.union([ActivitySchema, StatementRefSchema, GroupSchema, AgentSchema]),
  result: ResultSchema.optional(),
  context: ContextSchema.optional(),
  timestamp: timestamp.optional(),
});

export const StatementObjectSchema = z.union([
  StatementRefSchema,
  SubStatementSchema,
  GroupSchema,
  // Activity is the default when objectType is absent, so it has to be tried
  // after the tagged variants but before the untagged Agent.
  ActivitySchema,
  AgentSchema,
]);

export const AttachmentSchema = z.object({
  usageType: iri,
  display: languageMap,
  description: languageMap.optional(),
  contentType: z.string().min(1),
  length: z.number().int().nonnegative(),
  sha2: z.string().min(1),
  fileUrl: iri.optional(),
});

export const StatementSchema = z
  .object({
    id: uuid.optional(),
    actor: ActorSchema,
    verb: VerbSchema,
    object: StatementObjectSchema,
    result: ResultSchema.optional(),
    context: ContextSchema.optional(),
    timestamp: timestamp.optional(),
    stored: timestamp.optional(),
    authority: ActorSchema.optional(),
    version: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
  })
  .superRefine((statement, ctx) => {
    const objectType = (statement.object as { objectType?: string }).objectType ?? 'Activity';

    if (statement.context && objectType !== 'Activity') {
      for (const key of ['revision', 'platform'] as const) {
        if (statement.context[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['context', key],
            message: `context.${key} is only allowed when the object is an Activity`,
          });
        }
      }
    }

    if (statement.verb.id === VOIDED_VERB && objectType !== 'StatementRef') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['object'],
        message: 'a voiding statement must target a StatementRef',
      });
    }
  });

export type Agent = z.infer<typeof AgentSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type Verb = z.infer<typeof VerbSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type StatementRef = z.infer<typeof StatementRefSchema>;
export type SubStatement = z.infer<typeof SubStatementSchema>;
export type StatementObject = z.infer<typeof StatementObjectSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type Statement = z.infer<typeof StatementSchema>;
