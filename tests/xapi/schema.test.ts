import { describe, expect, it } from 'vitest';

import { actorIfi } from '../../src/xapi/ifi.js';
import { StatementSchema, VOIDED_VERB } from '../../src/xapi/schema.js';
import { sampleStatement } from '../helpers/mock-lrs.js';

const parse = (overrides: Record<string, unknown> = {}) =>
  StatementSchema.safeParse(sampleStatement(overrides));

describe('actorIfi', () => {
  it('canonicalizes each inverse-functional identifier', () => {
    expect(actorIfi({ mbox: 'mailto:Ada@Example.com' })).toBe('mbox:mailto:ada@example.com');
    expect(actorIfi({ mbox_sha1sum: 'A'.repeat(40) })).toBe(`mbox_sha1sum:${'a'.repeat(40)}`);
    expect(actorIfi({ openid: 'https://openid.example.com/ada' })).toBe(
      'openid:https://openid.example.com/ada',
    );
    expect(actorIfi({ account: { homePage: 'https://lms.example.com', name: 'ada' } })).toBe(
      'account:https://lms.example.com|ada',
    );
  });

  it('ignores name and key order when identifying an agent', () => {
    expect(actorIfi({ name: 'Ada', mbox: 'mailto:ada@example.com' })).toBe(
      actorIfi({ mbox: 'mailto:ada@example.com' }),
    );
  });

  it('identifies an anonymous group by its member set, regardless of order', () => {
    const a = { mbox: 'mailto:a@example.com' };
    const b = { mbox: 'mailto:b@example.com' };
    const first = actorIfi({ objectType: 'Group', member: [a, b] });
    const second = actorIfi({ objectType: 'Group', member: [b, a] });
    expect(first).toBe(second);
    expect(first.startsWith('group:')).toBe(true);
  });

  it('prefers a group’s own identifier over its members', () => {
    expect(
      actorIfi({
        objectType: 'Group',
        mbox: 'mailto:team@example.com',
        member: [{ mbox: 'mailto:a@example.com' }],
      }),
    ).toBe('mbox:mailto:team@example.com');
  });
});

describe('StatementSchema', () => {
  it('accepts a minimal statement', () => {
    expect(parse().success).toBe(true);
  });

  it('requires exactly one inverse-functional identifier on an agent', () => {
    expect(parse({ actor: { name: 'Ada' } }).success).toBe(false);
    expect(
      parse({ actor: { mbox: 'mailto:a@example.com', openid: 'https://example.com/a' } }).success,
    ).toBe(false);
  });

  it('allows an anonymous group but requires members', () => {
    expect(parse({ actor: { objectType: 'Group', member: [{ mbox: 'mailto:a@e.com' }] } }).success).toBe(
      true,
    );
    expect(parse({ actor: { objectType: 'Group' } }).success).toBe(false);
  });

  it('requires absolute IRIs for verb and activity ids', () => {
    expect(parse({ verb: { id: 'completed' } }).success).toBe(false);
    expect(parse({ object: { id: '/courses/intro' } }).success).toBe(false);
  });

  it('rejects a mailto-less mbox and a malformed sha1sum', () => {
    expect(parse({ actor: { mbox: 'ada@example.com' } }).success).toBe(false);
    expect(parse({ actor: { mbox_sha1sum: 'nope' } }).success).toBe(false);
  });

  it('bounds score.scaled and orders raw/min/max', () => {
    expect(parse({ result: { score: { scaled: 1.5 } } }).success).toBe(false);
    expect(parse({ result: { score: { raw: 10, min: 0, max: 5 } } }).success).toBe(false);
    expect(parse({ result: { score: { raw: 4, min: 0, max: 5 } } }).success).toBe(true);
  });

  it('validates ISO 8601 durations', () => {
    expect(parse({ result: { duration: 'PT1H30M' } }).success).toBe(true);
    expect(parse({ result: { duration: '90 minutes' } }).success).toBe(false);
  });

  it('allows context.revision only against an Activity object', () => {
    expect(parse({ context: { revision: '2' } }).success).toBe(true);
    expect(
      parse({
        object: { objectType: 'Agent', mbox: 'mailto:b@example.com' },
        context: { revision: '2' },
      }).success,
    ).toBe(false);
  });

  it('requires a voiding statement to target a StatementRef', () => {
    const ref = { objectType: 'StatementRef', id: '8f1f71ff-3e3c-4f0c-8f9d-1a3f4f0f1a2b' };
    expect(parse({ verb: { id: VOIDED_VERB }, object: ref }).success).toBe(true);
    expect(parse({ verb: { id: VOIDED_VERB } }).success).toBe(false);
  });

  it('accepts a SubStatement object', () => {
    const result = parse({
      object: {
        objectType: 'SubStatement',
        actor: { mbox: 'mailto:ada@example.com' },
        verb: { id: 'http://adlnet.gov/expapi/verbs/attempted' },
        object: { id: 'http://example.com/courses/intro' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID statement id', () => {
    expect(parse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});
