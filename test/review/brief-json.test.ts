import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefOf, gapKinds } from '../../src/review/brief.ts';
import { briefJson, briefJsonV1, briefJsonV2, briefJsonV3, gapKindsV1 } from '../../src/review/brief-json.ts';
import { answer, answerableDecisions, changeReading, decidedFixRun, readOnlyReported } from '../helpers/review-history.ts';

const local = { copy: '/repo/.git/deep-review-checkpoint/reports/2026-09-27-run-1.md', record: '/repo/.git/deep-review-checkpoint/artifacts/abc', repository: '/repo', store: '/repo/.git/deep-review-checkpoint/artifacts', continueCommand: null };

/** A run that fixed, whose fixer reported a stale document, which no step of this older run brought in line. */
const leftStale = (): RunState => {
  const state = decidedFixRun().fold();
  const fix = state.review!.fix!;
  const answers = { ...fix.answers, fixes: { 'c1-1': { ...fix.answers.fixes['c1-1']!, drift: [{ file: 'docs/a.md', what: 'parse throws on a null' }] } } };
  return { ...state, review: { ...state.review!, fix: { ...fix, answers } } };
};

/** Runs of each shape the brief covers: read-only with a question and a departure, answered, fixed, deferred, with the triage's account, and with a document left out of date. */
const runs = (): [string, RunState][] => {
  const readOnly = readOnlyReported(answerableDecisions()).fold();
  return [
    ['a run that only reviewed', readOnly],
    ['an answered run', readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold()],
    ['a run that fixed', decidedFixRun().fold()],
    ['a fix it deferred', decidedFixRun(answerableDecisions(), 'deferred').fold()],
    ['a run with the triage\'s account', { ...readOnly, review: { ...readOnly.review!, change: { kind: 'given', reading: changeReading as never } } }],
    ['a run that left a document out of date', leftStale()],
  ];
};

/** Version 2 of the JSON form as an engine before version 3 wrote it, from a version 3 output: the same fields less `notShown`. */
const asV2 = (json: Record<string, unknown>): Record<string, unknown> => ({ ...Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'notShown')), version: 2 });

describe('briefJson (R16, TD8 of the brief of a run; R7, TD7 of the documentation step; R8 of the questions in the chat)', () => {
  for (const [name, state] of runs()) {
    it(`matches version 3 of its schema for ${name}`, () => {
      const json = briefJson(briefOf(state), local, []);
      const parsed = briefJsonV3.safeParse(json);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'it is plain JSON, with nothing lost in a round trip');
    });
  }

  it('keeps the names of its fields, which a program reads', () => {
    const json = briefJson(briefOf(runs()[4]![1]), local, []);
    assert.deepEqual(Object.keys(json), ['version', 'run', 'title', 'headline', 'changeState', 'change', 'questions', 'departures', 'documents', 'notCovered', 'covered', 'look', 'changed', 'local', 'notShown']);
    assert.equal(json.version, 3);
    assert.deepEqual(Object.keys(json.headline), ['questions', 'departures', 'documents', 'text']);
    assert.deepEqual(Object.keys(json.change!), ['what', 'why', 'whyFrom', 'restsOn', 'publicInterface', 'wideEffect']);
    assert.deepEqual(Object.keys(json.questions[0]!), ['id', 'question', 'default', 'defaultApplied', 'choice', 'options', 'lookedIn', 'grounds', 'answer', 'command']);
    assert.deepEqual(Object.keys(json.departures[0]!), ['id', 'rule', 'source', 'fact', 'fix', 'fate', 'review', 'accept', 'reject']);
    assert.deepEqual(Object.keys(json.changed), ['fixed', 'decided', 'applied', 'alreadyInTree', 'deferred', 'blocked', 'notAttempted', 'toFix', 'commits', 'patches', 'left', 'checks']);
    assert.deepEqual(json.local, local);
  });

  it('holds each document the run left out of date, with its facts and who reported each, and its reasons, and counts them in the headline', () => {
    const json = briefJson(briefOf(leftStale()), local, []);
    assert.equal(json.headline.documents, 1);
    assert.deepEqual(json.documents, [{ file: 'docs/a.md', facts: [{ what: 'parse throws on a null', by: 'a fixer' }], reasons: [{ kind: 'not-run', text: 'The documentation step did not run: an engine before the documentation step configured this run.' }] }]);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).documents, [], 'a run that only reviewed left none');
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
    assert.equal(briefJsonV3.safeParse(json).success, true);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).notShown, [], 'none when report passed over no run');
    assert.equal(briefJsonV3.safeParse({ ...json, notShown: [{ run: 'r' }] }).success, false, 'each run has its state');
  });

  it('refuses a field the version does not hold, so a change of the shape is a new version', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local, []);
    assert.equal(briefJsonV3.safeParse({ ...json, extra: true }).success, false);
    assert.equal(briefJsonV3.safeParse({ ...json, version: 2 }).success, false);
    assert.equal(briefJsonV3.safeParse({ ...json, documents: [{ file: 'a.md', facts: [], reasons: [{ kind: 'guessed', text: 't' }] }] }).success, false, 'a reason of no kind it knows');
    assert.equal(briefJsonV2.safeParse(json).success, false, 'version 2 refuses version 3');
  });

  it('keeps version 2 as it was: version 3 less the runs report passed over', () => {
    for (const [name, state] of runs()) {
      const json = briefJson(briefOf(state), local, [{ run: 'r', state: 'is in progress' }]);
      assert.equal(briefJsonV2.safeParse(asV2(json)).success, true, name);
      assert.equal(briefJsonV2.safeParse({ ...asV2(json), notShown: [] }).success, false, `${name}: version 2 holds no notShown`);
    }
  });

  it('keeps version 1 as it was: its headline, no documents, and its frozen kinds of gaps, which leave out the documentation step\'s', () => {
    assert.deepEqual([...gapKindsV1], gapKinds.filter((kind) => kind !== 'documentation'));
    const json = asV2(briefJson(briefOf(runs()[0]![1]), local, [])) as ReturnType<typeof briefJson>;
    const withoutDocuments = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'documents'));
    const v1 = { ...withoutDocuments, version: 1, headline: { questions: json.headline.questions, departures: json.headline.departures, text: json.headline.text } };
    assert.equal(briefJsonV1.safeParse(v1).success, true);
    assert.equal(briefJsonV1.safeParse({ ...v1, notCovered: [{ kind: 'documentation', text: 'The documentation step did not run: its worker failed twice.' }] }).success, false, 'version 1 refuses the kind of gap version 2 added');
    assert.equal(briefJsonV1.safeParse(json).success, false, 'version 1 refuses version 2');
  });
});
