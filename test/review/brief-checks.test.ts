import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { briefMarkdown, briefOf, briefShortForm, shortLineLimit, type Brief } from '../../src/review/brief.ts';
import type { BriefCheck } from '../../src/review/brief-checks.ts';
import { briefJson } from '../../src/review/brief-json.ts';
import { answeredRun, checkedRun, mergeBase, onBranch, type ChecksOfRun } from '../helpers/base-checks-history.ts';
import { answer, answerableDecisions, decidedFixRun, readOnlyReported } from '../helpers/review-history.ts';

/** The run whose checks end as `checks` says, its scope a branch's, and its question answered, so the headline counts the checks alone. */
const run = (checks: ChecksOfRun = {}): RunState => onBranch(checkedRun(checks).add('answer.recorded', answer('SWEEP-1', 0)));
const check = (brief: Brief, kind: string) => brief.changed.checks.find((entry) => entry.kind === kind)!;
// The checks of these runs have no typecheck command, which gives a gap of its own in each.
const checkGaps = (brief: Brief): string[] => brief.notCovered.filter((gap) => gap.kind === 'check' && !gap.text.startsWith('No typecheck check ran')).map((gap) => gap.text);
const sentence = (brief: Brief): string => briefMarkdown(brief, 'chat').at(-1)!;

const same = { kind: 'lint', reading: 'same', words: 'the same two lint errors as on the base' };
/** lint failed before the fixes and after them, so it runs on the base after build. */
const failing = { before: { lint: 'failed' }, after: { lint: 'failed' } } as const;
const where = 'the merge base with origin/main (2247b35e)';

describe('when the last run of each check ran (R3 of the facts before a merge)', () => {
  it('says after the fixes, after the repair or after your answers by the phase of the last run', () => {
    assert.deepEqual(check(briefOf(run()), 'test').last, { outcome: 'passed', when: 'fixes' });
    assert.deepEqual(check(briefOf(run({ after: { lint: 'failed' }, repaired: {} })), 'test').last, { outcome: 'passed', when: 'repair' });
    assert.deepEqual(check(briefOf(onBranch(answeredRun(checkedRun()))), 'test').last, { outcome: 'passed', when: 'answers' });
  });

  it('says a test that fails after an answer pass failed after your answers, not after the fixes, in a run configured before the checks on the base too (#78)', () => {
    for (const compared of [true, false]) {
      const brief = briefOf(onBranch(answeredRun(checkedRun({ compared }), { test: 'failed' })));
      assert.deepEqual(check(brief, 'test').last, { outcome: 'failed', when: 'answers' }, String(compared));
      assert.ok(sentence(brief).includes('test passed before the fixes and failed after your answers.'), sentence(brief));
      assert.doesNotMatch(sentence(brief), /test passed before the fixes and failed after them/);
    }
  });

  it('gives each check its outcome before the fixes and its last outcome with when it ran, in the sentence of what deep-review changed', () => {
    assert.ok(sentence(briefOf(run())).includes(' The checks passed before and after the fixes. '));
    const repaired = sentence(briefOf(run({ after: { lint: 'failed' }, repaired: {} })));
    assert.ok(repaired.includes('The checks: build passed before the fixes and after the repair; lint passed before the fixes and after the repair; test passed before the fixes and after the repair.'), repaired);
    assert.ok(sentence(briefOf(run({ after: { lint: 'timeout' } }))).includes('lint passed before the fixes and timed out after them; '), 'a timeout in plain words');
  });
});

describe('the fault of each check (R4, R5 of the facts before a merge)', () => {
  it('counts in the headline a check that failed after it passed earlier in the run, a timeout as a failure', () => {
    for (const outcome of ['failed', 'timeout']) {
      const brief = briefOf(run({ after: { lint: outcome } }));
      assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier.passed], ['edits', 'before'], outcome);
      assert.equal(brief.headline.checks, 1);
      assert.equal(brief.headline.text, '1 thing needs you: 1 check that the edits of the run made fail. Nothing waits for you: the run went on as it decided.');
    }
    const two = briefOf(run({ after: { lint: 'failed', test: 'failed' } }));
    assert.match(two.headline.text, /^2 things need you: 2 checks that the edits of the run made fail\./);
  });

  it('counts a check that failed before the fixes, passed after them and failed after an answer pass, by its pass after the fixes', () => {
    const brief = briefOf(onBranch(answeredRun(checkedRun({ before: { lint: 'failed' } }), { lint: 'failed' })));
    assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier, check(brief, 'lint').base], ['edits', { passed: 'fixes', failed: 'before' }, null]);
    assert.equal(brief.headline.checks, 1);
  });

  it('counts no check that failed before the fixes and never passed since, whatever the base says, and says that its edits made no check fail when none did', () => {
    for (const checks of [{ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }, { ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }, { ...failing, compared: false }] as const) {
      assert.equal(briefOf(run(checks)).headline.checks, 0, JSON.stringify(checks));
    }
    assert.equal(briefOf(run()).headline.text, 'Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, the run left no document out of date that it knows of, and its edits made no check fail.');
  });

  it('says the change breaks a check that passes on the base, and lists it in what the review did not cover, not in the headline (PD4)', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }));
    assert.equal(check(brief, 'lint').fault, 'change-breaks');
    assert.deepEqual(check(brief, 'lint').base, { commit: `2247b35e${'0'.repeat(32)}`, name: 'the merge base with origin/main', outcome: 'passed', reading: null, reason: null });
    assert.deepEqual(checkGaps(brief), [`The lint check fails on the change and passes on its base, ${where}. No step of the run fixes a failure that the change brings.`]);
    assert.equal(brief.headline.checks, 0);
    assert.ok(sentence(brief).includes(`lint failed before and after the fixes, and it passes on the base, ${where}; `), sentence(brief));
  });

  it('says the change adds failures to those of the base, as the repair reads it, and lists it in what the review did not cover', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'adds' }] }));
    assert.equal(check(brief, 'lint').fault, 'change-adds');
    assert.deepEqual(checkGaps(brief), [`The lint check fails on the change with failures that its base, ${where}, does not have, by the repair's reading. No step of the run fixes a failure that the change brings.`]);
    assert.ok(sentence(brief).includes(`lint failed before and after the fixes, and the change has failures that the base, ${where}, does not have, by the repair's reading; `), sentence(brief));
  });

  it('says the base has the same failures, as the repair reads it, and lists no gap for it, since the run covered it', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }));
    assert.equal(check(brief, 'lint').fault, 'base-has');
    assert.deepEqual(checkGaps(brief), []);
    assert.ok(sentence(brief).includes(`lint failed before and after the fixes, and the base, ${where}, has the same failures, by the repair's reading; `), sentence(brief));
    assert.equal(check(briefOf(run({ ...failing, base: [['build', 'passed'], ['lint', 'timeout']], comparisons: [same] })), 'lint').fault, 'base-has', 'a timeout on the base is compared as a failure is');
  });

  it('says why the run could not compare a check it took to the base, in fixed words, for each reason', () => {
    const notCompared = (checks: ChecksOfRun, state: (history: ReturnType<typeof checkedRun>) => RunState = onBranch): string[] => {
      const brief = briefOf(state(checkedRun({ ...failing, ...checks })));
      assert.equal(check(brief, 'lint').fault, 'not-compared', JSON.stringify(checks));
      return checkGaps(brief);
    };
    const gap = (reason: string, base = where): string => `The lint check failed before and after the fixes, and the run could not compare it with the base, ${base}: ${reason}.`;
    const emptyTree = (history: ReturnType<typeof checkedRun>): RunState => { const state = onBranch(history); return { ...state, scope: { ...state.scope!, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' } }; };
    assert.deepEqual(notCompared({ base: [['lint', 'skipped', 'the base of the change is the empty tree']] }, emptyTree), [gap('the base of the change is the empty tree', 'the empty tree')]);
    assert.deepEqual(notCompared({ base: [['lint', 'skipped', 'no worktree of the base could be made: fatal: could not create work tree dir \'/home/me/.cache/x\': Permission denied']] }), [gap('no worktree of the base could be made')]);
    assert.deepEqual(notCompared({ base: [['build', 'failed'], ['lint', 'skipped', 'the build failed on the base']] }), [gap('the build failed on the base')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'not-started']] }), [gap('the check did not start on the base')]);
    assert.deepEqual(notCompared({ base: [] }), [gap('the check did not run on the base')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [] }), [gap('the repair gave no comparison')]);
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: null }), [gap('the repair gave no comparison')], 'a repair the run budget stopped');
    assert.deepEqual(notCompared({ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'unknown' }] }), [gap('the repair could not compare the outputs')]);
  });

  it('gives the build that only prepares the base no fault and no gap of its own', () => {
    const brief = briefOf(run({ ...failing, base: [['build', 'failed'], ['lint', 'skipped', 'the build failed on the base']] }));
    assert.deepEqual([check(brief, 'build').base, check(brief, 'build').fault], [null, null]);
    assert.equal(checkGaps(brief).length, 1);
  });

  it('takes the first fault that holds for a kind two rows match: the edits of the run over what the base says', () => {
    for (const base of [{ base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }, { base: [['build', 'passed'], ['lint', 'passed']] }] as const) {
      const brief = briefOf(onBranch(answeredRun(checkedRun({ ...failing, ...base, repaired: {} }), { lint: 'failed' })));
      assert.deepEqual([check(brief, 'lint').fault, check(brief, 'lint').earlier.passed], ['edits', 'repair'], JSON.stringify(base));
      assert.notEqual(check(brief, 'lint').base, null, 'the base still says what it said');
      assert.deepEqual(checkGaps(brief), [], 'no gap for a fault of the change it does not have');
    }
  });

  it('keeps what the base says after an answer pass, which makes the runs after the fixes old (R2, TD13)', () => {
    const brief = briefOf(onBranch(answeredRun(checkedRun({ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }), { lint: 'failed' })));
    assert.equal(check(brief, 'lint').fault, 'change-breaks');
    assert.equal(check(brief, 'lint').last?.when, 'answers');
  });

  it('gives a kind skipped after a failed build no fault from the base, and the one gap of a check that did not finish', () => {
    const brief = briefOf(run({ before: { lint: 'failed' }, after: { build: 'failed', lint: 'skipped' } }));
    assert.deepEqual([check(brief, 'lint').base, check(brief, 'lint').fault], [null, null]);
    assert.deepEqual(checkGaps(brief).filter((gap) => gap.includes('lint')), ['The lint check did not finish: it was skipped.']);
  });

  it('gives a run configured before the checks on the base no fact of the base and no check not compared, and the fault of the edits (R10)', () => {
    const older = briefOf(run({ ...failing, compared: false }));
    assert.deepEqual([check(older, 'lint').base, check(older, 'lint').fault], [null, null]);
    assert.doesNotMatch(briefMarkdown(older).join('\n'), /the base/);
    assert.equal(check(briefOf(run({ after: { lint: 'failed' }, compared: false })), 'lint').fault, 'edits');
  });

  it('names no local path from the error of git in any form of the brief (R5; R15 of the brief of a run)', () => {
    const state = run({ ...failing, base: [['lint', 'skipped', 'no worktree of the base could be made: fatal: could not create work tree dir \'/home/me/.cache/x\': Permission denied']] });
    const brief = briefOf(state);
    const json = { ...briefJson(brief, { copy: null, record: '/r', repository: '/w', store: '/s', continueCommand: null }, []), local: null };
    for (const text of [briefMarkdown(brief, 'report').join('\n'), briefMarkdown(brief, 'chat').join('\n'), briefShortForm(brief).join('\n'), JSON.stringify(json)]) {
      assert.doesNotMatch(text, /\/home\/me|Permission denied|fatal/);
    }
  });
});

describe('the line Checks: of the short form (R6, PD5 of the facts before a merge)', () => {
  /** The run with only the kinds that have a command, so no line names a kind with none. */
  const commanded = (state: RunState): RunState => {
    const fix = state.review!.fix!;
    const planned = fix.checks.planned!;
    return { ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, planned: { ...planned, checks: planned.checks.filter((entry) => entry.command !== null) } } } } };
  };
  const lineOf = (brief: Brief): string => briefShortForm(brief).find((entry) => entry.startsWith('Checks:'))!;
  const line = (state: RunState): string => lineOf(briefOf(state));
  /** The decided fix run whose fixer deferred RIPPLE-1, so no fix changed a file and no check ran after the fixes, with lint before the fixes as `lint` says. */
  const unchanged = (lint: 'passed' | 'failed' = 'passed'): RunState => {
    const state = decidedFixRun(answerableDecisions(), 'deferred').fold();
    const fix = state.review!.fix!;
    const runs = fix.checks.runs['baseline-checks'].map((entry) => (entry.kind === 'lint' ? { ...entry, outcome: lint } : entry));
    return { ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, 'baseline-checks': runs } } } } };
  };

  it('says each example of the proposal, with lint where it names typecheck', () => {
    assert.equal(line(commanded(run())), 'Checks: each passed before and after the fixes');
    assert.equal(line(commanded(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same] }))), 'Checks: lint failed, as it does on the base (2247b35e), by the repair\'s reading; build and test passed');
    assert.equal(line(commanded(onBranch(answeredRun(checkedRun({ ...failing, base: [['build', 'passed'], ['lint', 'passed']] }), { test: 'failed' })))), 'Checks: test failed after your answers, and passed after the fixes; lint fails on the change and passes on the base (2247b35e); build passed');
    assert.equal(line(commanded(run({ ...failing, base: [['build', 'passed'], ['lint', 'failed']] }))), 'Checks: lint failed before and after the fixes, not compared with the base; build and test passed');
    assert.equal(line(commanded(unchanged())), 'Checks: each passed before the fixes; no check ran after them, since no fix changed a file');
  });

  it('gives each other row its clause', () => {
    const clauses: [ChecksOfRun, string][] = [
      [{ after: { lint: 'timeout' } }, 'Checks: lint timed out after the fixes, and passed before the fixes; build and test passed'],
      [{ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [{ ...same, reading: 'adds' }] }, 'Checks: lint fails on the change with failures that the base (2247b35e) does not have, by the repair\'s reading; build and test passed'],
      [{ before: { lint: 'failed' } }, 'Checks: lint failed before the fixes and passes now; build and test passed'],
      [{ after: { lint: 'failed' }, repaired: {} }, 'Checks: lint failed after the fixes and passed after the repair; build and test passed'],
      [{ before: { lint: 'failed' }, after: { build: 'failed', lint: 'skipped' } }, 'Checks: build failed after the fixes, and passed before the fixes; lint did not finish; test passed'],
      [{ ...failing, compared: false }, 'Checks: lint failed before and after the fixes; build and test passed'],
    ];
    for (const [checks, expected] of clauses) assert.equal(line(commanded(run(checks))), expected, JSON.stringify(checks));
    assert.equal(line(commanded(unchanged('failed'))), 'Checks: lint failed before the fixes and did not run again; build and test passed; no check ran after the fixes, since no fix changed a file');
  });

  it('names the kinds in the order of the rows, two kinds of one row in the order of the kinds, and a kind with no command before the kinds that passed', () => {
    assert.equal(line(run({ before: { lint: 'failed' }, after: { build: 'failed', lint: 'failed' }, base: [['build', 'passed'], ['lint', 'passed']] })), 'Checks: build failed after the fixes, and passed before the fixes; lint fails on the change and passes on the base (2247b35e); no typecheck check; test passed');
    assert.equal(line(run({ after: { test: 'failed', build: 'failed' } })), 'Checks: build failed after the fixes, and passed before the fixes; test failed after the fixes, and passed before the fixes; no typecheck check; lint passed');
    assert.equal(line(run()), 'Checks: no typecheck check; build, lint and test passed');
  });

  it('gives a kind that two rows match the clause of the first: the edits of the run over what the base says', () => {
    const state = commanded(onBranch(answeredRun(checkedRun({ ...failing, base: [['build', 'passed'], ['lint', 'failed']], comparisons: [same], repaired: {} }), { lint: 'failed' })));
    assert.equal(line(state), 'Checks: lint failed after your answers, and passed after the repair; build and test passed');
  });

  it('says so of a run with no check command', () => {
    const state = run();
    const fix = state.review!.fix!;
    const planned = fix.checks.planned!;
    const none = { ...state, review: { ...state.review!, fix: { ...fix, checks: { ...fix.checks, planned: { ...planned, checks: planned.checks.map((entry) => ({ ...entry, command: null })) } } } } };
    assert.equal(line(none), 'Checks: none, since the run has no check command');
  });

  it('comes after the line of the documents and before Not covered, in a fix run alone', () => {
    const lines = briefShortForm(briefOf(run()));
    const at = lines.findIndex((entry) => entry.startsWith('Checks:'));
    assert.ok(lines[at - 1]!.startsWith('Documents left out of date: ') && lines[at + 1]!.startsWith('Not covered: '), lines.join('\n'));
    assert.ok(!briefShortForm(briefOf(readOnlyReported().fold())).some((entry) => entry.startsWith('Checks:')), 'a run that only reviews has no such line');
  });

  it('is cut at a word at 200 characters, and the cut keeps the kinds that need the person', () => {
    const brief = briefOf(run());
    const base = { commit: mergeBase, name: 'the merge base with origin/main', outcome: 'failed', reading: 'adds', reason: null } as const;
    const checks: BriefCheck[] = [
      { kind: 'build', before: 'failed', last: { outcome: 'failed', when: 'repair' }, earlier: { passed: null, failed: 'fixes' }, base: { ...base, reading: null, reason: 'no-comparison' }, fault: 'not-compared' },
      { kind: 'lint', before: 'failed', last: { outcome: 'failed', when: 'repair' }, earlier: { passed: null, failed: 'fixes' }, base, fault: 'change-adds' },
      { kind: 'test', before: 'passed', last: { outcome: 'timeout', when: 'answers' }, earlier: { passed: 'answers', failed: null }, base: null, fault: 'edits' },
    ];
    const cut = lineOf({ ...brief, changed: { ...brief.changed, checks } });
    assert.ok(cut.length <= shortLineLimit && cut.endsWith('...'), cut);
    assert.ok(cut.startsWith('Checks: test timed out after your answers, and passed after earlier answers; lint fails on the change with failures that the base (2247b35e) does not have'), cut);
  });
});
