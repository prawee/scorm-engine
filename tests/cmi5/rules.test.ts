import { describe, expect, it } from 'vitest';

import { CATEGORY, EXTENSION, VERBS } from '../../src/cmi5/constants.js';
import {
  applyAuStatements,
  EMPTY_PROGRESS,
  meetsMoveOn,
  satisfiedBlocks,
  type SessionRuleContext,
} from '../../src/cmi5/rules.js';
import type { StructureNode } from '../../src/cmi5/course-structure.js';

const REG = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const AU = 'urn:uuid:44444444-4444-4444-8444-444444444444';

const ctx = (over: Partial<SessionRuleContext> = {}): SessionRuleContext => ({
  sessionId: SESSION,
  registrationId: REG,
  actorIfi: 'mbox:mailto:ada@example.com',
  auActivityId: AU,
  launchMode: 'Normal',
  masteryScore: null,
  status: 'LAUNCHED',
  progress: { ...EMPTY_PROGRESS },
  ...over,
});

function stmt(verb: string, extra: { result?: unknown; moveOn?: boolean; cmi5?: boolean } = {}) {
  const category = [];
  if (extra.cmi5 !== false) category.push({ id: CATEGORY.cmi5 });
  if (extra.moveOn) category.push({ id: CATEGORY.moveOn });
  return {
    actor: { mbox: 'mailto:ada@example.com' },
    verb: { id: verb },
    object: { id: AU },
    ...(extra.result ? { result: extra.result } : {}),
    context: {
      registration: REG,
      contextActivities: { category },
      extensions: { [EXTENSION.sessionId]: SESSION },
    },
  };
}

const completed = () => stmt(VERBS.completed, { moveOn: true, result: { completion: true } });
const passed = (scaled?: number) =>
  stmt(VERBS.passed, {
    moveOn: true,
    result: { success: true, ...(scaled === undefined ? {} : { score: { scaled } }) },
  });

describe('applyAuStatements', () => {
  it('walks a full session: initialized → completed → passed → terminated', () => {
    const out = applyAuStatements(
      [stmt(VERBS.initialized), completed(), passed(), stmt(VERBS.terminated)],
      ctx(),
    );
    expect(out).toMatchObject({ status: 'TERMINATED', initialized: true, terminated: true });
    expect(out.progress).toMatchObject({ completed: true, passed: true });
  });

  it('requires initialized first', () => {
    expect(() => applyAuStatements([completed()], ctx())).toThrow(/first statement/);
  });

  it('rejects anything after terminated', () => {
    expect(() =>
      applyAuStatements([stmt(VERBS.initialized), stmt(VERBS.terminated), completed()], ctx()),
    ).toThrow(/ended/);
  });

  it('rejects LMS-only verbs', () => {
    expect(() =>
      applyAuStatements([stmt(VERBS.satisfied)], ctx({ status: 'INITIALIZED' })),
    ).toThrow(/Only the LMS/);
  });

  it('rejects a mismatched actor, registration, or session id', () => {
    const wrongActor = { ...stmt(VERBS.initialized), actor: { mbox: 'mailto:eve@example.com' } };
    expect(() => applyAuStatements([wrongActor], ctx())).toThrow(/actor/);

    const wrongSession = stmt(VERBS.initialized);
    wrongSession.context.extensions = { [EXTENSION.sessionId]: 'other' };
    expect(() => applyAuStatements([wrongSession], ctx())).toThrow(/session id/);

    const wrongReg = stmt(VERBS.initialized);
    wrongReg.context.registration = '99999999-9999-4999-8999-999999999999';
    expect(() => applyAuStatements([wrongReg], ctx())).toThrow(/registration/);
  });

  it('requires the cmi5 category on defined statements and forbids it on allowed ones', () => {
    expect(() =>
      applyAuStatements([stmt(VERBS.initialized, { cmi5: false })], ctx()),
    ).toThrow(/cmi5 context category/);

    const allowed = stmt('http://adlnet.gov/expapi/verbs/answered');
    expect(() => applyAuStatements([allowed], ctx({ status: 'INITIALIZED' }))).toThrow(
      /Only cmi5 defined/,
    );
    const plain = stmt('http://adlnet.gov/expapi/verbs/answered', { cmi5: false });
    expect(applyAuStatements([plain], ctx({ status: 'INITIALIZED' })).status).toBe('INITIALIZED');
  });

  it('enforces completion / success flags and the moveon category', () => {
    const live = ctx({ status: 'INITIALIZED' });
    expect(() =>
      applyAuStatements([stmt(VERBS.completed, { moveOn: true })], live),
    ).toThrow(/completion = true/);
    expect(() =>
      applyAuStatements([stmt(VERBS.completed, { result: { completion: true } })], live),
    ).toThrow(/moveon/);
    expect(() =>
      applyAuStatements([stmt(VERBS.failed, { moveOn: true, result: { success: true } })], live),
    ).toThrow(/success = false/);
  });

  it('allows completed and passed only once per registration', () => {
    const live = ctx({ status: 'INITIALIZED', progress: { ...EMPTY_PROGRESS, completed: true, passed: true } });
    expect(() => applyAuStatements([completed()], live)).toThrow(/already completed/);
    expect(() => applyAuStatements([passed()], live)).toThrow(/already passed/);
  });

  it('checks scores against the masteryScore', () => {
    const live = ctx({ status: 'INITIALIZED', masteryScore: 0.7 });
    expect(() => applyAuStatements([passed()], live)).toThrow(/score.scaled/);
    expect(() => applyAuStatements([passed(0.5)], live)).toThrow(/below the masteryScore/);
    expect(applyAuStatements([passed(0.9)], live).progress.passed).toBe(true);

    const failedHigh = stmt(VERBS.failed, { moveOn: true, result: { success: false, score: { scaled: 0.8 } } });
    expect(() => applyAuStatements([failedHigh], live)).toThrow(/send passed/);
  });

  it('forbids completed / passed / failed outside Normal mode', () => {
    const browse = ctx({ status: 'INITIALIZED', launchMode: 'Browse' });
    expect(() => applyAuStatements([completed()], browse)).toThrow(/Browse mode/);
  });
});

describe('meetsMoveOn', () => {
  const p = (over = {}) => ({ ...EMPTY_PROGRESS, ...over });

  it.each([
    ['Passed', p({ passed: true }), true],
    ['Passed', p({ completed: true }), false],
    ['Completed', p({ completed: true }), true],
    ['CompletedAndPassed', p({ completed: true }), false],
    ['CompletedAndPassed', p({ completed: true, passed: true }), true],
    ['CompletedOrPassed', p({ passed: true }), true],
    ['NotApplicable', p(), true],
    ['Completed', p({ waived: true }), true],
  ])('%s with %o → %s', (moveOn, progress, expected) => {
    expect(meetsMoveOn(moveOn, progress)).toBe(expected);
  });
});

describe('satisfiedBlocks', () => {
  const block = (id: string, children: StructureNode[]): StructureNode => ({ type: 'block', id, title: id, description: null, children });
  const au = (id: string): StructureNode => ({ type: 'au', id });
  const tree: StructureNode[] = [
    au('a1'),
    block('outer', [au('a2'), block('inner', [au('a3')])]),
    block('empty', []),
  ];

  it('returns blocks whose every child is satisfied, innermost first', () => {
    expect(satisfiedBlocks(tree, (id) => ['a2', 'a3'].includes(id))).toEqual(['inner', 'outer']);
  });

  it('reports a satisfied nested block even when its parent is not', () => {
    expect(satisfiedBlocks(tree, (id) => id === 'a3')).toEqual(['inner']);
  });

  it('never treats an empty block as satisfied', () => {
    expect(satisfiedBlocks(tree, () => true)).toEqual(['inner', 'outer']);
  });
});
