import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefOf, gapKinds } from '../../src/review/brief.ts';
import { briefJson, briefJsonV1, briefJsonV2, briefJsonV3, briefJsonV4, gapKindsV1 } from '../../src/review/brief-json.ts';
import { answeredRun, checkedRun, onBranch } from '../helpers/base-checks-history.ts';
import { answer, answerableDecisions, changeReading, decidedFixRun, readOnlyReported } from '../helpers/review-history.ts';

const local = { copy: '/repo/.git/deep-review-checkpoint/reports/2026-09-27-run-1.md', record: '/repo/.git/deep-review-checkpoint/artifacts/abc', repository: '/repo', store: '/repo/.git/deep-review-checkpoint/artifacts', continueCommand: null };

/** A run that fixed, whose fixer reported a stale document, which no step of this older run brought in line. */
const leftStale = (): RunState => {
  const state = decidedFixRun().fold();
  const fix = state.review!.fix!;
  const answers = { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, drift: [{ file: 'docs/a.md', what: 'parse throws on a null' }] } } };
  return { ...state, review: { ...state.review!, fix: { ...fix, answers } } };
};

/** A run whose lint failed before and after the fixes and passes on the base, and whose test failed after an answer pass. */
const onTheBase = (): RunState => onBranch(answeredRun(checkedRun({ before: { lint: 'failed' }, after: { lint: 'failed' }, base: [['build', 'passed'], ['lint', 'passed']] }), { test: 'failed' }));

/** Runs of each shape the brief covers: read-only with a question and a departure, answered, fixed, deferred, with the triage's account, with a document left out of date, and with a check on the base. */
const runs = (): [string, RunState][] => {
  const readOnly = readOnlyReported(answerableDecisions()).fold();
  return [
    ['a run that only reviewed', readOnly],
    ['an answered run', readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold()],
    ['a run that fixed', decidedFixRun().fold()],
    ['a fix it deferred', decidedFixRun(answerableDecisions(), 'deferred').fold()],
    ['a run with the triage\'s account', { ...readOnly, review: { ...readOnly.review!, change: { kind: 'given', reading: changeReading as never } } }],
    ['a run that left a document out of date', leftStale()],
    ['a run with a check on the base', onTheBase()],
  ];
};

/** Version 3 of the JSON form as an engine before version 4 wrote it, from a version 4 output: the headline less its checks, each check with `after` in place of what version 4 says of it, and no validation. */
const asV3 = (json: ReturnType<typeof briefJson>): Record<string, unknown> => {
  const without = (record: object, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  const checks = json.changed.checks.map((check) => ({ kind: check.kind, before: check.before, after: check.last?.outcome ?? null }));
  return { ...json, version: 3, headline: without(json.headline, 'checks'), changed: { ...without(json.changed, 'validation'), checks } };
};

/** Version 2 of the JSON form as an engine before version 3 wrote it, from a version 3 output: the same fields less `notShown`, and the change less its `beforeEdits`. */
const asV2 = (json: Record<string, unknown>): Record<string, unknown> => {
  const change = json.change === null ? null : Object.fromEntries(Object.entries(json.change as Record<string, unknown>).filter(([key]) => key !== 'beforeEdits'));
  return { ...Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'notShown')), change, version: 2 };
};

describe('briefJson (R16, TD8 of the brief of a run; R7, TD7 of the documentation step; R8 of the questions in the chat; R9, TD10 of the facts before a merge)', () => {
  for (const [name, state] of runs()) {
    it(`matches version 4 of its schema for ${name}`, () => {
      const json = briefJson(briefOf(state), local, []);
      const parsed = briefJsonV4.safeParse(json);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'it is plain JSON, with nothing lost in a round trip');
    });
  }

  it('keeps the names of its fields, which a program reads', () => {
    const json = briefJson(briefOf(runs()[4]![1]), local, []);
    assert.deepEqual(Object.keys(json), ['version', 'run', 'title', 'headline', 'changeState', 'change', 'questions', 'departures', 'documents', 'notCovered', 'covered', 'look', 'changed', 'local', 'notShown']);
    assert.equal(json.version, 4);
    assert.deepEqual(Object.keys(json.headline), ['questions', 'departures', 'documents', 'checks', 'text']);
    assert.deepEqual(Object.keys(json.change!), ['what', 'why', 'whyFrom', 'restsOn', 'publicInterface', 'wideEffect', 'beforeEdits']);
    assert.deepEqual(Object.keys(json.questions[0]!), ['id', 'question', 'default', 'defaultApplied', 'choice', 'options', 'lookedIn', 'grounds', 'answer', 'command']);
    assert.deepEqual(Object.keys(json.departures[0]!), ['id', 'rule', 'source', 'fact', 'fix', 'fate', 'review', 'accept', 'reject']);
    assert.deepEqual(Object.keys(json.changed), ['fixed', 'decided', 'applied', 'alreadyInTree', 'deferred', 'blocked', 'notAttempted', 'toFix', 'commits', 'patches', 'left', 'checks', 'validation']);
    assert.deepEqual(Object.keys(json.changed.validation), ['test', 'existing', 'static', 'limited', 'none']);
    assert.deepEqual(json.local, local);
  });

  it('gives each check its outcome before the fixes, its last run with when it ran in place of after, what its base says and its fault, and counts in the headline the checks the edits made fail', () => {
    const json = briefJson(briefOf(onTheBase()), local, []);
    for (const check of json.changed.checks) assert.deepEqual(Object.keys(check), ['kind', 'before', 'last', 'base', 'fault'], check.kind);
    assert.deepEqual(json.changed.checks.find((check) => check.kind === 'lint'), {
      kind: 'lint', before: 'failed', last: { outcome: 'passed', when: 'answers' },
      base: { commit: `2247b35e${'0'.repeat(32)}`, name: 'the merge base with origin/main', outcome: 'passed', reading: null, reason: null },
      fault: 'change-breaks',
    });
    assert.deepEqual(json.changed.checks.find((check) => check.kind === 'test'), { kind: 'test', before: 'passed', last: { outcome: 'failed', when: 'answers' }, base: null, fault: 'edits' });
    assert.equal(json.headline.checks, 1);
    assert.equal(briefJsonV4.safeParse({ ...json, changed: { ...json.changed, checks: json.changed.checks.map((check) => ({ ...check, after: check.last?.outcome ?? null })) } }).success, false, 'version 4 holds no after');
  });

  it('gives the applied fixes under the strongest validation of each', () => {
    const json = briefJson(briefOf(decidedFixRun().fold()), local, []);
    assert.deepEqual(json.changed.validation, { test: [], existing: [], static: [], limited: [], none: ['RIPPLE-1'] });
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).changed.validation, { test: [], existing: [], static: [], limited: [], none: [] }, 'a run that only reviewed applied none');
  });

  it('holds each document the run left out of date, with its facts and who reported each, and its reasons, and counts them in the headline', () => {
    const json = briefJson(briefOf(leftStale()), local, []);
    assert.equal(json.headline.documents, 1);
    assert.deepEqual(json.documents, [{ file: 'docs/a.md', facts: [{ what: 'parse throws on a null', by: 'a fixer' }], reasons: [{ kind: 'not-run', text: 'The documentation step did not run: an engine before the documentation step configured this run.' }] }]);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).documents, [], 'a run that only reviewed left none');
  });

  it('marks the account written before the fixes and the answers of the run, as the text forms do (R5 of the questions in the chat)', () => {
    const fixed = decidedFixRun().fold();
    const account = { kind: 'given', reading: changeReading as never } as const;
    const marked = briefJson(briefOf({ ...fixed, review: { ...fixed.review!, change: account } }), local, []);
    assert.equal(marked.change?.beforeEdits, true, 'a fix run with an applied fix');
    assert.equal(briefJsonV4.safeParse(marked).success, true);
    assert.equal(briefJson(briefOf(runs()[4]![1]), local, []).change?.beforeEdits, false, 'a run that only reviewed');
    assert.equal(briefJsonV4.safeParse({ ...marked, change: { ...marked.change, beforeEdits: undefined } }).success, false, 'version 4 holds the mark');
  });

  it('gives no change, and says why, for a run whose triage recorded none', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local, []);
    assert.equal(json.change, null);
    assert.equal(json.changeState, 'unrecorded');
  });

  it('names each later run that report passed over, with its id and why it has no report', () => {
    const notShown = [{ run: '171fd810-0000-4000-8000-000000000000', state: 'was abandoned: wrong scope' }, { run: '9f8e7d6c-0000-4000-8000-000000000000', state: 'is in progress' }];
    const json = briefJson(briefOf(runs()[0]![1]), local, notShown);
    assert.deepEqual(json.notShown, notShown);
    assert.notEqual(json.notShown[0], notShown[0], 'a copy, not the caller\'s object');
    assert.equal(briefJsonV4.safeParse(json).success, true);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).notShown, [], 'none when report passed over no run');
    assert.equal(briefJsonV4.safeParse({ ...json, notShown: [{ run: 'r' }] }).success, false, 'each run has its state');
  });

  it('refuses a field the version does not hold, so a change of the shape is a new version', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local, []);
    assert.equal(briefJsonV4.safeParse({ ...json, extra: true }).success, false);
    assert.equal(briefJsonV4.safeParse({ ...json, version: 3 }).success, false);
    assert.equal(briefJsonV4.safeParse({ ...json, documents: [{ file: 'a.md', facts: [], reasons: [{ kind: 'guessed', text: 't' }] }] }).success, false, 'a reason of no kind it knows');
    assert.equal(briefJsonV3.safeParse(json).success, false, 'version 3 refuses version 4');
  });

  it('keeps version 3 as it was: version 4 less the count of the checks and the validation, each check with after', () => {
    for (const [name, state] of runs()) {
      const json = asV3(briefJson(briefOf(state), local, [{ run: 'r', state: 'is in progress' }]));
      assert.equal(briefJsonV3.safeParse(json).success, true, name);
      assert.equal(briefJsonV3.safeParse({ ...json, changed: { ...(json.changed as object), validation: { test: [], existing: [], static: [], limited: [], none: [] } } }).success, false, `${name}: version 3 holds no validation`);
    }
  });

  it('keeps version 2 as it was: version 3 less the runs report passed over', () => {
    for (const [name, state] of runs()) {
      const json = asV3(briefJson(briefOf(state), local, [{ run: 'r', state: 'is in progress' }]));
      assert.equal(briefJsonV2.safeParse(asV2(json)).success, true, name);
      assert.equal(briefJsonV2.safeParse({ ...asV2(json), notShown: [] }).success, false, `${name}: version 2 holds no notShown`);
    }
  });

  it('keeps version 1 as it was: its headline, no documents, and its frozen kinds of gaps, which leave out the documentation step\'s', () => {
    assert.deepEqual([...gapKindsV1], gapKinds.filter((kind) => kind !== 'documentation'));
    const json = asV2(asV3(briefJson(briefOf(runs()[0]![1]), local, []))) as { headline: { questions: number; departures: number; text: string } };
    const withoutDocuments = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'documents'));
    const v1 = { ...withoutDocuments, version: 1, headline: { questions: json.headline.questions, departures: json.headline.departures, text: json.headline.text } };
    assert.equal(briefJsonV1.safeParse(v1).success, true);
    assert.equal(briefJsonV1.safeParse({ ...v1, notCovered: [{ kind: 'documentation', text: 'The documentation step did not run: its worker failed twice.' }] }).success, false, 'version 1 refuses the kind of gap version 2 added');
    assert.equal(briefJsonV1.safeParse(json).success, false, 'version 1 refuses version 2');
  });
});
