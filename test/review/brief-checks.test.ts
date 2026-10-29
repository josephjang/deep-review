import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefChatForm, briefMarkdown, briefOf, type Brief } from '../../src/review/brief.ts';
import { checkMeanings, meaningRowOf, validationKindsOf, validationWords, type BriefCheck } from '../../src/review/brief-checks.ts';
import { briefJson } from '../../src/review/brief-json.ts';
import type { NeedCondition } from '../../src/review/needs.ts';
import { answeredRun, checkedRun, mergeBase, onBranch, rewordedOnBase, type ChecksOfRun } from '../helpers/base-checks-history.ts';
import { answer, answerableDecisions, decidedFixRun } from '../helpers/review-history.ts';

/** The run whose checks end as `checks` says, its scope a branch's, and its question answered, so "What needs you" holds the checks and the patches alone. */
const run = (checks: ChecksOfRun = {}): RunState => onBranch(checkedRun(checks).add('answer.recorded', answer('SWEEP-1', 0)));
const check = (brief: Brief, kind: string) => brief.checks.find((entry) => entry.kind === kind)!;
const meaning = (brief: Brief, kind: string): string => brief.checks.find((entry) => entry.kind === kind)!.meaning;
/** The row of a check in the table of "Before you merge". */
const row = (brief: Brief, kind: string): string => briefMarkdown(brief, 'chat').find((line) => line.startsWith(`| ${kind} |`))!;
/** The lead and the rest of each item of a condition. */
const items = (brief: Brief, condition: NeedCondition): string[] => brief.needs.filter((need) => need.condition === condition).map((need) => need.lines.join('\n'));
/** The paragraph under the table of the checks. */
const paragraph = (brief: Brief): string => {
  const lines = briefMarkdown(brief);
  return lines[lines.indexOf('## What deep-review fixed') - 2]!;
};

const same = { kind: 'lint', reading: 'same', words: 'the same two lint errors as on the base' };
/** lint failed before the fixes and after them, so it runs on the base after build. */
const failing = { before: { lint: 'failed' }, after: { lint: 'failed' } } as const;
const where = 'the merge base with origin/main (2247b35e)';

describe('when the last run of each check ran (R3 of the facts before a merge)', () => {
  it('says after the fixes, after the fixes for the checks or after your answers by the phase of the last run', () => {
    assert.deepEqual(check(briefOf(run()), 'test').last, { outcome: 'passed', when: 'fixes' });
    assert.deepEqual(check(briefOf(run({ after: { lint: 'failed' }, repaired: {} })), 'test').last, { outcome: 'passed', when: 'repair' });
    assert.deepEqual(check(briefOf(onBranch(answeredRun(checkedRun()))), 'test').last, { outcome: 'passed', when: 'answers' });
    assert.equal(row(briefOf(run({ after: { lint: 'failed' }, repaired: {} })), 'test'), '| test | not run | passed | passed, after the fixes for the checks | passes |');
  });

  it('says a test that fails after an answer pass failed after your answers, not after the fixes, in a run configured before the checks on the base too (#78)', () => {
    for (const compared of [true, false]) {
      const brief = briefOf(onBranch(answeredRun(checkedRun({ compared }), { test: 'failed' })));
      assert.deepEqual(check(brief, 'test').last, { outcome: 'failed', when: 'answers' }, String(compared));
      assert.match(row(brief, 'test'), /\| passed \| failed, after your answers \| the edits of this run made it fail \|$/);
      assert.deepEqual(items(brief, 'edits'), ['**The test check fails after your answers, and passed after the fixes.** The edits of this run made it fail. If you do nothing, `deep-review commit` commits a tree in which it fails.']);
    }
  });

  it('gives each check its result on the base, as submitted and in its last run with when it ran, and a timeout in plain words', () => {
    const brief = briefOf(run());
    assert.deepEqual(briefMarkdown(brief, 'chat').filter((line) => line.startsWith('| ')).slice(0, 2), ['| Check | On the base | As submitted | Last run | What it means |', '| build | not run | passed | passed, after the fixes | passes |']);
    assert.equal(row(briefOf(run({ after: { lint: 'timeout' } })), 'lint'), '| lint | not run | passed | timed out, after the fixes | the edits of this run made it fail |');
  });
});

describe('the fault of each check, and the item it gives (R4, R5 of the facts before a merge; R2, R4 of the report for the person)', () => {
  it('gives an item of rank 1 to a check that failed after it passed earlier in the run, a timeout as a failure', () => {
    for (const outcome of ['failed', 'timeout']) {
      const brief = briefOf(run({ after: { lint: outcome } }));
      assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier.passed], ['edits', 'before'], outcome);
      assert.deepEqual(items(brief, 'edits'), ['**The lint check fails after the fixes, and passed as submitted.** The edits of this run made it fail. If you do nothing, `deep-review commit` commits a tree in which it fails.']);
      assert.match(brief.needsLine, /^Before a merge: 1 check that the edits of this run made fail and \d+ patch(es)? to commit\. The run left no work unfinished and no document out of date\.$/);
    }
    assert.match(briefOf(run({ after: { lint: 'failed', test: 'failed' } })).needsLine, /^Before a merge: 2 checks that the edits of this run made fail /);
  });

  it('gives an item to a check that failed before the fixes, passed after them and failed after an answer pass, by its pass after the fixes', () => {
    const brief = briefOf(onBranch(answeredRun(checkedRun({ before: { lint: 'failed' } }), { lint: 'failed' })));
    assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier, check(brief, 'lint').base], ['edits', { passed: 'fixes', failed: 'before' }, null]);
    assert.equal(items(brief, 'edits').length, 1);
  });

  it('gives an item to a check that passed after an earlier answer pass and failed after the last one', () => {
    const brief = briefOf(onBranch(answeredRun(answeredRun(checkedRun()), { test: 'failed' }, 2)));
    assert.deepEqual([check(brief, 'test').fault, check(brief, 'test').earlier.passed], ['edits', 'answers']);
    assert.deepEqual(items(brief, 'edits'), ['**The test check fails after your answers, and passed after earlier answers.** The edits of this run made it fail. If you do nothing, `deep-review commit` commits a tree in which it fails.']);
  });

  it('gives no item of rank 1 to a check that failed before the fixes and never passed since, whatever the base says, and says that the edits made no check fail', () => {
    for (const checks of [{ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }, { ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }, { ...failing, compared: false }] as const) {
      const brief = briefOf(run(checks));
      assert.deepEqual(items(brief, 'edits'), [], JSON.stringify(checks));
      assert.match(brief.needsLine, / The edits of this run made no check fail, and the run left no work unfinished and no document out of date\.$/);
    }
  });

  it('gives an item of rank 2 to a check the change breaks, which passes on the base (PD4 of the report for the person)', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }));
    assert.equal(check(brief, 'lint').fault, 'change-breaks');
    assert.deepEqual(check(brief, 'lint').base, { commit: `2247b35e${'0'.repeat(32)}`, name: 'the merge base with origin/main', outcome: 'passed', reading: null, reason: null });
    assert.deepEqual(items(brief, 'change-breaks'), [`**The lint check fails because of the change.** It passes on the base, ${where}. If you do nothing, the check keeps failing, since no step of the run fixes a failure that the change brings.`]);
    assert.equal(row(brief, 'lint'), '| lint | passed | failed | failed, after the fixes | fails because of the change |');
    assert.match(brief.needsLine, /^Before a merge: 1 check fails because of the change and /);
    assert.equal(brief.checks.find((entry) => entry.kind === 'lint')!.comparedBy, 'engine');
  });

  it('gives an item of rank 2 to a check the change adds failures to, as a model compared them', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'adds' }] }));
    assert.equal(check(brief, 'lint').fault, 'change-adds');
    assert.deepEqual(items(brief, 'change-breaks'), [`**The lint check has failures that the base does not have, by a model's comparison.** The base is ${where}. If you do nothing, the check keeps failing, since no step of the run fixes a failure that the change brings.`]);
    assert.equal(meaning(brief, 'lint'), 'fails on the base too, and the change adds failures, by a model\'s comparison');
    assert.ok(paragraph(brief).includes('A model\'s comparison is the reading of the worker that compared the failures of the change with those of the base.'), paragraph(brief));
  });

  it('gives no item to a check whose base has the same failures, as a model compared them, and says what that means under the table', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }));
    assert.equal(check(brief, 'lint').fault, 'base-has');
    assert.deepEqual(brief.needs.filter((need) => need.check !== null), []);
    assert.equal(row(brief, 'lint'), '| lint | failed | failed | failed, after the fixes | fails the same way on the base, by a model\'s comparison |');
    assert.ok(paragraph(brief).startsWith(`The base is ${where}. A check that fails the same way on the base has no failure that the change adds.`), paragraph(brief));
    assert.equal(check(briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'timeout']], comparisons: [same] })), 'lint').fault, 'base-has', 'a timeout on the base is compared as a failure is');
  });

  it('reads why a run on the base was skipped from its skipReason, whatever words its error recorded (TD17 of the facts before a merge)', () => {
    for (const reason of ['no-worktree', 'build-failed'] as const) {
      const base: ChecksOfRun['base'] = reason === 'build-failed' ? [['build', 'failed'], ['lint', 'skipped', reason]] : [['lint', 'skipped', reason, 'fatal: x']];
      const lint = check(briefOf(rewordedOnBase(onBranch(checkedRun({ ...failing, base })), 'the base could not be checked out: fatal: x')), 'lint');
      assert.equal(lint.base?.reason, reason, reason);
      assert.equal(lint.fault, 'not-compared', reason);
    }
  });

  it('gives an item of rank 3 to a check the run took to the base and could not compare, with why in fixed words, for each reason', () => {
    const notCompared = (checks: ChecksOfRun, state: (history: ReturnType<typeof checkedRun>) => RunState = onBranch): string[] => {
      const brief = briefOf(state(checkedRun({ ...failing, ...checks })));
      assert.equal(check(brief, 'lint').fault, 'not-compared', JSON.stringify(checks));
      return items(brief, 'not-compared');
    };
    const item = (reason: string): string => `**The lint check fails, and the run did not compare it with the base.** ${reason}. If you do nothing, nobody knows whether the change causes the failure.`;
    const emptyTree = (history: ReturnType<typeof checkedRun>): RunState => { const state = onBranch(history); return { ...state, scope: { ...state.scope!, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' } }; };
    assert.deepEqual(notCompared({ base: [['lint', 'skipped', 'empty-tree']] }, emptyTree), [item('The base of the change is the empty tree')]);
    assert.deepEqual(notCompared({ base: [['lint', 'skipped', 'no-worktree', 'fatal: could not create work tree dir \'/home/me/.cache/x\': Permission denied']] }), [item('No worktree of the base could be made')]);
    assert.deepEqual(notCompared({ base: [['build', 'failed'], ['lint', 'skipped', 'build-failed']] }), [item('The build did not pass on the base')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'not-started']] }), [item('The check did not start on the base')]);
    assert.deepEqual(notCompared({ base: [] }), [item('The check did not run on the base')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [] }), [item('The worker that compared the failures gave no comparison')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: null }), [item('The worker that compared the failures gave no comparison')], 'a repair the run budget stopped');
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'unknown' }] }), [item('The worker that compared the failures could not compare the outputs')]);
  });

  it('says how a check not compared with the base ended as submitted and in its last run, a timeout as timed out', () => {
    for (const [outcomes, cells] of [[{ before: { lint: 'timeout' }, after: { lint: 'timeout' } }, '| timed out | timed out, after the fixes |'], [{ before: { lint: 'failed' }, after: { lint: 'timeout' } }, '| failed | timed out, after the fixes |']] as const) {
      const brief = briefOf(run({ ...outcomes, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [] }));
      assert.equal(check(brief, 'lint').fault, 'not-compared');
      assert.ok(row(brief, 'lint').includes(`${cells} fails, not compared with the base, since the worker that compared the failures gave no comparison |`), row(brief, 'lint'));
    }
  });

  it('gives the build that only prepares the base no fault and no item of its own', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'failed'], ['lint', 'skipped', 'build-failed']] }));
    assert.deepEqual([check(brief, 'build').base, check(brief, 'build').fault], [null, null]);
    assert.deepEqual(brief.needs.filter((need) => need.check !== null).map((need) => need.check), ['lint']);
  });

  it('takes the first fault that holds for a kind two rows match: the edits of the run over what the base says', () => {
    for (const base of [{ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }, { base: [['build', 'passed'], ['lint', 'passed']] }] as const) {
      const brief = briefOf(onBranch(answeredRun(checkedRun({ ...failing, ...base, repaired: {} }), { lint: 'failed' })));
      assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier.passed], ['edits', 'repair'], JSON.stringify(base));
      assert.notEqual(check(brief, 'lint').base, null, 'the base still says what it said');
      assert.deepEqual(brief.needs.filter((need) => need.check !== null).map((need) => need.condition), ['edits'], 'one item per check');
    }
  });

  it('keeps what the base says after an answer pass, which makes the runs after the fixes old (R2, TD13)', () => {
    const brief = briefOf(onBranch(answeredRun(checkedRun({ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }), { lint: 'failed' })));
    assert.equal(check(brief, 'lint').fault, 'change-breaks');
    assert.equal(check(brief, 'lint').last?.when, 'answers');
  });

  it('gives a check that an answer pass made pass no fault and no item, whatever the base says, since it passes now', () => {
    for (const base of [{ base: [['build', 'passed'], ['lint', 'passed']] }, { base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }, { base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'adds' }] }, { base: [['build', 'passed'], ['lint', 'failed']], comparisons: [] }] as const) {
      const brief = briefOf(onBranch(answeredRun(checkedRun({ ...failing, ...base }))));
      assert.deepEqual([check(brief, 'lint').last, check(brief, 'lint').fault], [{ outcome: 'passed', when: 'answers' }, null], JSON.stringify(base));
      assert.deepEqual(brief.needs.filter((need) => need.check !== null), []);
      assert.ok(row(brief, 'lint').endsWith('| failed | passed, after your answers | passes; it failed as submitted |'), row(brief, 'lint'));
    }
  });

  it('gives a kind skipped after a failed build no fault from the base, and the meaning of a check that did not finish', () => {
    const brief = briefOf(run({ before: { lint: 'failed' }, after: { build: 'failed', lint: 'skipped' } }));
    assert.deepEqual([check(brief, 'lint').base, check(brief, 'lint').fault], [null, null]);
    assert.equal(meaning(brief, 'lint'), 'did not finish its last run');
  });

  it('gives a run configured before the checks on the base no column and no fact of the base, no item of rank 3, and the fault of the edits (R10)', () => {
    const older = briefOf(run({ ...failing, compared: false }));
    assert.deepEqual([check(older, 'lint').base, check(older, 'lint').fault], [null, null]);
    assert.equal(row(older, 'lint'), '| lint | failed | failed, after the fixes | fails |');
    assert.doesNotMatch(briefMarkdown(older).join('\n'), /the base/);
    assert.deepEqual(older.needs.filter((need) => need.check !== null), []);
    assert.equal(check(briefOf(run({ after: { lint: 'failed' }, compared: false })), 'lint').fault, 'edits');
  });

  it('names no local path from the error of git in any form of the brief (R5; R15 of the brief of a run)', () => {
    const state = run({ ...failing, base: [['lint', 'skipped', 'no-worktree', 'fatal: could not create work tree dir \'/home/me/.cache/x\': Permission denied']] });
    const brief = briefOf(state);
    const json = { ...briefJson(brief, { copy: null, record: '/r', repository: '/w', store: '/s', continueCommand: null }, []), local: null };
    for (const text of [briefMarkdown(brief, 'report').join('\n'), briefMarkdown(brief, 'chat').join('\n'), briefChatForm(brief).join('\n'), JSON.stringify(json)]) {
      assert.doesNotMatch(text, /\/home\/me|Permission denied|fatal/);
    }
  });
});

describe('the meanings of the checks (R4, TD3 of the report for the person)', () => {
  const base = { commit: mergeBase, name: 'the merge base with origin/main', outcome: 'failed', reading: null, reason: null } as const;
  const of = (facts: Partial<BriefCheck>, baseChecksStep = true): { meaning: string; rank: number | null; comparedBy: string | null } => {
    const entry: BriefCheck = { kind: 'lint', before: 'passed', last: { outcome: 'passed', when: 'fixes' }, earlier: { passed: null, failed: null }, base: null, fault: null, ...facts };
    const found = meaningRowOf(entry, { baseChecksStep });
    return { meaning: found.meaning(entry), rank: found.rank, comparedBy: found.comparedBy };
  };

  it('gives each row its meaning, its rank and who compared, the first row that holds', () => {
    const rows: [Partial<BriefCheck>, boolean, string, number | null, string | null][] = [
      [{ last: { outcome: 'failed', when: 'answers' }, earlier: { passed: 'fixes', failed: null }, fault: 'edits' }, true, 'the edits of this run made it fail', 1, null],
      [{ before: 'failed', last: { outcome: 'failed', when: 'fixes' }, base: { ...base, outcome: 'passed' }, fault: 'change-breaks' }, true, 'fails because of the change', 2, 'engine'],
      [{ before: 'failed', last: { outcome: 'failed', when: 'fixes' }, base: { ...base, reading: 'adds' }, fault: 'change-adds' }, true, 'fails on the base too, and the change adds failures, by a model\'s comparison', 2, 'model'],
      [{ before: 'failed', last: { outcome: 'failed', when: 'fixes' }, base: { ...base, reason: 'no-comparison' }, fault: 'not-compared' }, true, 'fails, not compared with the base, since the worker that compared the failures gave no comparison', 3, null],
      [{ before: 'failed', last: { outcome: 'failed', when: 'fixes' }, base: { ...base, reading: 'same' }, fault: 'base-has' }, true, 'fails the same way on the base, by a model\'s comparison', null, 'model'],
      [{ before: 'failed', last: { outcome: 'failed', when: 'fixes' } }, false, 'fails', null, null],
      [{ before: 'failed', last: null }, false, 'fails', null, null],
      [{ before: 'failed', last: null }, true, 'fails as submitted, not compared with the base', 3, null],
      [{}, true, 'passes', null, null],
      [{ before: 'failed' }, true, 'passes; it failed as submitted', null, null],
      [{ before: 'timeout' }, true, 'passes; it failed as submitted', null, null],
      [{ last: null }, true, 'passes as submitted; no check ran after the fixes', null, null],
      [{ last: { outcome: 'cut', when: 'fixes' } }, true, 'did not finish its last run', null, null],
      [{ last: { outcome: 'skipped', when: 'repair' } }, true, 'did not finish its last run', null, null],
      [{ before: 'not-started', last: null }, true, 'did not finish its last run', null, null],
      [{ before: null, last: null }, true, 'did not run', null, null],
    ];
    for (const [facts, baseChecksStep, expected, rank, comparedBy] of rows) assert.deepEqual(of(facts, baseChecksStep), { meaning: expected, rank, comparedBy }, JSON.stringify(facts));
  });

  it('says of every meaning that rests on the comparison of a model that it does', () => {
    for (const row of checkMeanings.filter((entry) => entry.comparedBy === 'model')) {
      const entry: BriefCheck = { kind: 'lint', before: 'failed', last: { outcome: 'failed', when: 'fixes' }, earlier: { passed: null, failed: null }, base: { ...base, reading: 'same' }, fault: null };
      assert.match(row.meaning(entry), /by a model's comparison$/);
    }
  });

  it('gives a check with no last run in a fix run that changed no file an item of rank 3, in a run that takes its checks to the base', () => {
    const state = decidedFixRun(answerableDecisions(), 'deferred').fold();
    const fix = state.review!.fix!;
    const runs = fix.checks.runs['baseline-checks'].map((entry) => (entry.kind === 'lint' ? { ...entry, outcome: 'failed' as const } : entry));
    const brief = briefOf({ ...state, review: { ...state.review!, baseChecksStep: true, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'baseline-checks': runs } } } } });
    assert.deepEqual(items(brief, 'not-compared'), ['**The lint check fails as submitted, and the run did not compare it with the base.** No fix changed a file, so no check ran after the fixes and none ran on the base. If you do nothing, nobody knows whether the change causes the failure.']);
    assert.equal(meaning(brief, 'test'), 'passes as submitted; no check ran after the fixes');
  });
});

describe('the kinds of validation (R5 of the report for the person)', () => {
  it('lists the kinds a fixer reports, each once, the strongest first, and none when it reported none', () => {
    assert.deepEqual(validationKindsOf(['limited', 'existing', 'old-code', 'existing']), ['old-code', 'existing', 'limited']);
    assert.equal(validationWords(['static', 'mutation']), 'a test fails when the fix is undone; read against the source');
    assert.equal(validationWords([]), 'none reported');
  });
});
