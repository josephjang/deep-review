import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { briefOf } from '../../src/review/brief.ts';
import { briefJson, briefJsonV1, briefJsonV2, briefJsonV3, briefJsonV4, briefJsonV5, gapKinds, gapKindsV1, type BriefJsonV4 } from '../../src/review/brief-json.ts';
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
const onTheBase = (): RunState => onBranch(answeredRun(checkedRun({ before: { lint: 'failed' }, after: { lint: 'failed' }, base: [['build', 'passed'], ['lint', 'passed']] }), { test: 'failed', lint: 'failed' }));

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

/** Version 4 of the JSON form as the engine before version 5 wrote it, for a run that only reviewed, a run that fixed, and a run with a check on the base: the outputs the versions before it are held to. */
const v4Samples = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/brief-json/v4.json'), 'utf8')) as Record<string, BriefJsonV4>;

/** Version 3 of the JSON form as an engine before version 4 wrote it, from a version 4 output: the headline less its checks, each check with `after` in place of what version 4 says of it, and no validation. */
const asV3 = (json: BriefJsonV4): Record<string, unknown> => {
  const without = (record: object, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  const checks = json.changed.checks.map((check) => ({ kind: check.kind, before: check.before, after: check.last?.outcome ?? null }));
  return { ...json, version: 3, headline: without(json.headline, 'checks'), changed: { ...without(json.changed, 'validation'), checks } };
};

/** Version 2 of the JSON form as an engine before version 3 wrote it, from a version 3 output: the same fields less `notShown`, and the change less its `beforeEdits`. */
const asV2 = (json: Record<string, unknown>): Record<string, unknown> => {
  const change = json.change === null ? null : Object.fromEntries(Object.entries(json.change as Record<string, unknown>).filter(([key]) => key !== 'beforeEdits'));
  return { ...Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'notShown')), change, version: 2 };
};

describe('briefJson (R13, TD8 of the report for the person; R16, TD8 of the brief of a run)', () => {
  for (const [name, state] of runs()) {
    it(`matches version 5 of its schema for ${name}`, () => {
      const json = briefJson(briefOf(state), local, []);
      const parsed = briefJsonV5.safeParse(json);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'it is plain JSON, with nothing lost in a round trip');
    });
  }

  it('keeps the names of its fields, which a program reads, and those that version 4 kept', () => {
    const json = briefJson(briefOf(runs()[4]![1]), local, []);
    assert.deepEqual(Object.keys(json), ['version', 'run', 'title', 'changeState', 'change', 'status', 'findings', 'needs', 'needsLine', 'checks', 'baseChecks', 'base', 'fixes', 'notExamined', 'leftAs', 'questions', 'departures', 'documents', 'local', 'notShown']);
    assert.equal(json.version, 5);
    assert.deepEqual(Object.keys(json.change!), ['what', 'why', 'whyFrom', 'restsOn', 'publicInterface', 'wideEffect', 'beforeEdits']);
    assert.deepEqual(Object.keys(json.questions[0]!), ['id', 'finding', 'question', 'default', 'defaultApplied', 'choice', 'options', 'lookedIn', 'grounds', 'answer', 'command']);
    assert.deepEqual(Object.keys(json.departures[0]!), ['id', 'rule', 'source', 'fact', 'fix', 'fate', 'review', 'accept', 'reject', 'finding']);
    assert.deepEqual(Object.keys(json.findings[0]!), ['number', 'id', 'merged', 'severity', 'verdict', 'status', 'summary']);
    assert.deepEqual(json.findings.map((finding) => [finding.number, finding.id, finding.merged]), [[1, 'RIPPLE-1', ['SWEEP-2']], [2, 'SWEEP-1', []]]);
    assert.deepEqual(json.local, local);
  });

  it('gives each item of what needs you its rank, its condition, its finding or check and its lines, and the count line', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local, []);
    assert.deepEqual(json.needs.map((need) => [need.rank, need.condition, need.finding, need.check]), [[5, 'departure', 1, null], [6, 'question-other', 2, null], [8, 'uncommitted', null, null]]);
    assert.equal(json.needsLine, briefOf(runs()[0]![1]).needsLine);
    assert.deepEqual(Object.keys(json.status), ['kind', 'findings', 'fixed', 'againstRule', 'alreadyInTree', 'notFixed', 'questions', 'answered', 'left', 'toFix', 'committed', 'text']);
  });

  it('gives each check its results, what its base says, its fault, its meaning and who compared it', () => {
    const json = briefJson(briefOf(onTheBase()), local, []);
    for (const check of json.checks) assert.deepEqual(Object.keys(check), ['kind', 'before', 'last', 'base', 'fault', 'meaning', 'comparedBy'], check.kind);
    assert.deepEqual(json.checks.find((check) => check.kind === 'lint'), {
      kind: 'lint', before: 'failed', last: { outcome: 'failed', when: 'answers' },
      base: { commit: `2247b35e${'0'.repeat(32)}`, name: 'the merge base with origin/main', outcome: 'passed', reading: null, reason: null },
      fault: 'change-breaks', meaning: 'fails because of the change', comparedBy: 'engine',
    });
    assert.deepEqual(json.checks.find((check) => check.kind === 'test'), { kind: 'test', before: 'passed', last: { outcome: 'failed', when: 'answers' }, base: null, fault: 'edits', meaning: 'the edits of this run made it fail', comparedBy: null });
    assert.deepEqual(json.needs.filter((need) => need.check !== null).map((need) => [need.rank, need.check]), [[1, 'test'], [2, 'lint']]);
  });

  it('gives each fix the kinds of its validations and its patches, and a run that only reviewed what it would fix', () => {
    assert.deepEqual(briefJson(briefOf(decidedFixRun().fold()), local, []).fixes, [{ finding: 1, severity: 'major', plausible: false, againstRule: true, subject: 'fix: Guard the null', kinds: [], patches: [1] }]);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).fixes.map((fix) => [fix.finding, fix.patches]), [[1, []]]);
  });

  it('holds each document the run left out of date, with its facts and who reported each, and its reasons, and an item for it', () => {
    const json = briefJson(briefOf(leftStale()), local, []);
    assert.deepEqual(json.documents, [{ file: 'docs/a.md', facts: [{ what: 'parse throws on a null', by: 'a fixer' }], reasons: [{ kind: 'not-run', text: 'The documentation step did not run: an engine before the documentation step configured this run.' }] }]);
    assert.deepEqual(json.needs.filter((need) => need.condition === 'document').map((need) => need.document), ['docs/a.md']);
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).documents, [], 'a run that only reviewed left none');
  });

  it('marks the account written before the fixes and the answers of the run, as the text forms do (R5 of the questions in the chat)', () => {
    const fixed = decidedFixRun().fold();
    const account = { kind: 'given', reading: changeReading as never } as const;
    const marked = briefJson(briefOf({ ...fixed, review: { ...fixed.review!, change: account } }), local, []);
    assert.equal(marked.change?.beforeEdits, true, 'a fix run with an applied fix');
    assert.equal(briefJson(briefOf(runs()[4]![1]), local, []).change?.beforeEdits, false, 'a run that only reviewed');
    assert.equal(briefJsonV5.safeParse({ ...marked, change: { ...marked.change, beforeEdits: undefined } }).success, false, 'version 5 holds the mark');
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
    assert.deepEqual(briefJson(briefOf(runs()[0]![1]), local, []).notShown, [], 'none when report passed over no run');
    assert.equal(briefJsonV5.safeParse({ ...json, notShown: [{ run: 'r' }] }).success, false, 'each run has its state');
  });

  it('refuses a field the version does not hold, so a change of the shape is a new version', () => {
    const json = briefJson(briefOf(runs()[0]![1]), local, []);
    assert.equal(briefJsonV5.safeParse({ ...json, extra: true }).success, false);
    assert.equal(briefJsonV5.safeParse({ ...json, headline: v4Samples['read-only']!.headline }).success, false, 'version 5 holds no headline');
    assert.equal(briefJsonV5.safeParse({ ...json, version: 4 }).success, false);
    assert.equal(briefJsonV4.safeParse(json).success, false, 'version 4 refuses version 5');
  });

  it('keeps version 4 as it was, for the outputs an engine before version 5 wrote', () => {
    for (const [name, json] of Object.entries(v4Samples)) assert.equal(briefJsonV4.safeParse(json).success, true, name);
    const sample = v4Samples['on-the-base']!;
    assert.equal(briefJsonV4.safeParse({ ...sample, changed: { ...sample.changed, checks: sample.changed.checks.map((check) => ({ ...check, after: check.last?.outcome ?? null })) } }).success, false, 'version 4 holds no after');
    assert.equal(briefJsonV4.safeParse({ ...sample, documents: [{ file: 'a.md', facts: [], reasons: [{ kind: 'guessed', text: 't' }] }] }).success, false, 'a reason of no kind it knows');
    assert.equal(briefJsonV3.safeParse(sample).success, false, 'version 3 refuses version 4');
  });

  it('keeps version 3 as it was: version 4 less the count of the checks and the validation, each check with after', () => {
    for (const [name, sample] of Object.entries(v4Samples)) {
      const json = asV3(sample);
      assert.equal(briefJsonV3.safeParse(json).success, true, name);
      assert.equal(briefJsonV3.safeParse({ ...json, changed: { ...(json.changed as object), validation: { test: [], existing: [], static: [], limited: [], none: [] } } }).success, false, `${name}: version 3 holds no validation`);
    }
  });

  it('keeps version 2 as it was: version 3 less the runs report passed over', () => {
    for (const [name, sample] of Object.entries(v4Samples)) {
      const json = asV3(sample);
      assert.equal(briefJsonV2.safeParse(asV2(json)).success, true, name);
      assert.equal(briefJsonV2.safeParse({ ...asV2(json), notShown: [] }).success, false, `${name}: version 2 holds no notShown`);
    }
  });

  it('keeps version 1 as it was: its headline, no documents, and its frozen kinds of gaps, which leave out the documentation step\'s', () => {
    assert.deepEqual([...gapKindsV1], gapKinds.filter((kind) => kind !== 'documentation'));
    const json = asV2(asV3(v4Samples['read-only']!)) as { headline: { questions: number; departures: number; text: string } };
    const withoutDocuments = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'documents'));
    const v1 = { ...withoutDocuments, version: 1, headline: { questions: json.headline.questions, departures: json.headline.departures, text: json.headline.text } };
    assert.equal(briefJsonV1.safeParse(v1).success, true);
    assert.equal(briefJsonV1.safeParse({ ...v1, notCovered: [{ kind: 'documentation', text: 'The documentation step did not run: its worker failed twice.' }] }).success, false, 'version 1 refuses the kind of gap version 2 added');
    assert.equal(briefJsonV1.safeParse(json).success, false, 'version 1 refuses version 2');
  });
});
