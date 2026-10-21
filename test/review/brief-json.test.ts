import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefOf } from '../../src/review/brief.ts';
import { briefJson, briefJsonV1 } from '../../src/review/brief-json.ts';
import { answer, answerableDecisions, changeReading, decidedFixRun, readOnlyReported } from '../helpers/review-history.ts';

const local = { copy: '/repo/.git/deep-review-checkpoint/reports/2026-09-27-run-1.md', record: '/repo/.git/deep-review-checkpoint/artifacts/abc', repository: '/repo', store: '/repo/.git/deep-review-checkpoint/artifacts', continueCommand: null };

/** Runs of each shape the brief covers: read-only with a question and a departure, answered, fixed, deferred, and with the triage's account. */
const runs = (): [string, RunState][] => {
  const readOnly = readOnlyReported(answerableDecisions()).fold();
  return [
    ['a run that only reviewed', readOnly],
    ['an answered run', readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.recorded', answer('RIPPLE-1', 'accept')).fold()],
    ['a run that fixed', decidedFixRun().fold()],
    ['a fix it deferred', decidedFixRun(answerableDecisions(), 'deferred').fold()],
    ['a run with the triage\'s account', { ...readOnly, review: { ...readOnly.review!, change: { kind: 'given', reading: changeReading as never } } }],
  ];
};

describe('briefJson (R16, TD8 of the brief of a run)', () => {
  for (const [name, state] of runs()) {
    it(`matches version 1 of its schema for ${name}`, () => {
      const json = briefJson(briefOf(state), local);
      const parsed = briefJsonV1.safeParse(json);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'it is plain JSON, with nothing lost in a round trip');
    });
  }

  it('keeps the names of its fields, which a program reads', () => {
    const json = briefJson(briefOf(runs()[4]![1]), local);
    assert.deepEqual(Object.keys(json), ['version', 'run', 'title', 'headline', 'changeState', 'change', 'questions', 'departures', 'notCovered', 'covered', 'look', 'changed', 'local']);
    assert.equal(json.version, 1);
    assert.deepEqual(Object.keys(json.change!), ['what', 'why', 'whyFrom', 'restsOn', 'publicInterface', 'wideEffect', 'cut']);
    assert.deepEqual(Object.keys(json.questions[0]!), ['id', 'question', 'inPlace', 'defaultApplied', 'choice', 'options', 'lookedIn', 'grounds', 'answer', 'command']);
    assert.deepEqual(Object.keys(json.departures[0]!), ['id', 'rule', 'source', 'fact', 'fix', 'fate', 'review', 'accept', 'reject']);
    assert.deepEqual(Object.keys(json.changed), ['fixed', 'decided', 'applied', 'alreadyInTree', 'deferred', 'blocked', 'notAttempted', 'toFix', 'commits', 'patches', 'left', 'checks']);
    assert.deepEqual(json.local, local);
  });

  it('gives no change, and says why, for a run whose triage recorded none', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local);
    assert.equal(json.change, null);
    assert.equal(json.changeState, 'unrecorded');
  });

  it('refuses a field the version does not hold, so a change of the shape is a new version', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local);
    assert.equal(briefJsonV1.safeParse({ ...json, extra: true }).success, false);
    assert.equal(briefJsonV1.safeParse({ ...json, version: 2 }).success, false);
  });
});
