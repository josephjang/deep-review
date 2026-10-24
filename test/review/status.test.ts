import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { cutAtWord, shortLineLimit } from '../../src/review/brief.ts';
import { askedModeOf, describeRun, listedRuns, noReportWords, runListLines } from '../../src/review/status.ts';
import { blockerActions } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { answer, askDecision, decidedFixRun, passToReport, configured, continuedRun, continuedToReport, decidedOf, decisions, History, launch, mergeRanked, readOnlyReported, reference, reported, scope, settingsConfigured, triaged, worker } from '../helpers/review-history.ts';

/** An evidence path that names the reference, so a test sees which one was asked for. */
const evidencePath = (reference: { sha256: string; bytes: number }): string => `/evidence/${reference.sha256.slice(0, 8)}-${String(reference.bytes)}`;

describe('describeRun', () => {
  it('describes a run with no review configured: no runtime, no phase, no workers and no spend', () => {
    const described = describeRun(new History().add('run.created', { worktree: '/w' }).fold(), claudeAdapter, evidencePath);
    assert.deepEqual(described.lines, [
      'Run run-1: active',
      'Worktree: /w',
      'Review: not configured',
      'Phase: none running',
      'Workers: 0 running, 0 finished, 0 lost',
      'Spend: none',
    ]);
    assert.deepEqual(described.json, { runId: 'run-1', status: 'active', worktree: '/w', scope: null, phase: null, workers: { running: 0, finished: 0, lost: 0 }, statistics: null, budgetCheck: null, blocker: null, report: null, reportCopy: null, continuedFrom: null, decisions: null, answers: [], answerPasses: [], fix: null, patches: [], commits: [], continueCommand: null, review: null });
  });

  it('names the reason of an abandoned run on its first line', () => {
    const state = new History().add('run.created', { worktree: '/w' }).add('run.abandoned', { reason: 'the wrong branch' }).fold();
    assert.equal(describeRun(state, claudeAdapter, evidencePath).lines[0], 'Run run-1: abandoned (the wrong branch)');
  });

  it('describes a blocked phase: its attempt, every worker by status, the spend against the budget in force, and the blocker with its action', () => {
    const blocker = { code: 'budget', detail: 'spent 1.75 USD of the 45.00 USD run budget', action: blockerActions.budget };
    const history = triaged()
      // The budget in force is this invocation's, not the 30 USD the configuration pinned.
      .add('limits.changed', { concurrency: 2, runBudgetUsd: 45 })
      .start('finders')
      .worker(2, 'finder-RIPPLE finders:RIPPLE', {}, 1.25, 300)
      .add('worker.launched', launch(worker(3), 'finder-FOOTGUNS finders:FOOTGUNS'))
      .add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'FOOTGUNS', reason: 'the engine exited while the worker ran' })
      .add('worker.launched', launch(worker(4), 'finder-WRAPPERS finders:WRAPPERS'))
      .finish('finders', 'blocked', 1, blocker);
    const state = history.fold();
    const described = describeRun(state, claudeAdapter, evidencePath);
    assert.deepEqual(described.lines, [
      'Run run-1: blocked',
      'Worktree: /w',
      // The scope the run captured, with no count of commits, which status gives it from git (R12 of the questions in the chat).
      `Scope: worktree, 1 file, from HEAD (${'1'.repeat(8)}) to the working tree`,
      'Runtime: claude 2.1.283; models opus and sonnet',
      // A run configured before the settings says so, as the report's account of the settings would (R17 of the configuration).
      'Settings: recorded before the settings existed; the run\'s values came from the defaults and its flags',
      'Phase: finders (attempt 1, blocked)',
      'Workers: 1 running, 2 finished, 1 lost',
      // The triage's 0.50 USD and RIPPLE's 1.25; input tokens count the cached ones, 200 and 600.
      'Spend: 1.75 USD; 800 input, 400 output tokens',
      // The lost FOOTGUNS worker is named beside what the check counts, which is then shown apart from the reported spend.
      'Budget check: 1.75 USD of 45.00 USD, 1 worker lost with an earlier engine is not counted',
      `Blocker: budget: ${blocker.detail}`,
      `Action: ${blockerActions.budget}`,
      // What the stop did to the FOOTGUNS worker, as the report's Limitations names it (R15 of resumable runs).
      'Stop: Lost with the engine: the worker of finder-FOOTGUNS finders:FOOTGUNS, and did not run again.',
    ]);
    assert.equal(described.json.status, 'blocked');
    assert.equal(described.json.phase, 'finders');
    assert.deepEqual(described.json.workers, { running: 1, finished: 2, lost: 1 });
    assert.deepEqual(described.json.budgetCheck, { usd: 1.75, charged: 0, lost: 1 });
    assert.deepEqual(described.json.blocker, { ...blocker, phase: 'finders' }, 'the blocker as the fold holds it, with its phase');
    assert.equal(described.json.report, null);
    assert.equal(described.json.review, state.review);
  });

  it('shows the reported spend against the budget when the check counts only that, and both numbers when it charged a worker at its cap', () => {
    const plain = triaged().fold();
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[7], 'Spend: 0.50 USD of 30.00 USD; 200 input, 100 output tokens');
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[8], undefined, 'no budget check line when it counts the reported spend alone');
    const timedOut = triaged().start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    const described = describeRun(timedOut, claudeAdapter, evidencePath);
    assert.deepEqual(described.lines.slice(7), [
      'Spend: 0.50 USD; 200 input, 100 output tokens',
      'Budget check: 8.50 USD of 30.00 USD, counting 1 worker that reported no cost at its per-worker cap',
    ]);
    assert.deepEqual(described.json.budgetCheck, { usd: 8.5, charged: 1, lost: 0 });
    const unbudgeted = triaged().add('limits.changed', { concurrency: 4, runBudgetUsd: null }).start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    assert.deepEqual(describeRun(unbudgeted, claudeAdapter, evidencePath).lines.slice(7), ['Spend: 0.50 USD; 200 input, 100 output tokens'], 'no budget in force, so no check to describe');
  });

  it('describes a spend no worker reported, and a run with no budget in force, without inventing either', () => {
    const state = configured()
      .add('limits.changed', { concurrency: 4, runBudgetUsd: null })
      .start('triage')
      .worker(1, 'triage triage:SCAN', { usage: null })
      .fold();
    assert.equal(describeRun(state, claudeAdapter, evidencePath).lines[7], 'Spend: no cost reported; no tokens reported');
  });

  it('names the report of a complete run through the evidence path, and no phase', () => {
    const state = reported().fold();
    const described = describeRun(state, claudeAdapter, evidencePath);
    assert.equal(described.lines[0], 'Run run-1: complete');
    assert.equal(described.lines[5], 'Phase: none running');
    // The report, then what a stop did: this run lost a WRAPPERS worker and ran it again (R15 of resumable runs).
    assert.deepEqual(described.lines.slice(-2), [`Report: /evidence/${'e'.repeat(8)}-2048`, 'Stop: Lost with the engine: the worker of finder-WRAPPERS finders:WRAPPERS, and ran again.']);
    assert.ok(!described.lines.some((line) => line.startsWith('Blocker: ')));
    assert.equal(described.json.report, `/evidence/${'e'.repeat(8)}-2048`);
    assert.ok(!described.lines.some((line) => line.startsWith('Decisions: ')), 'a run configured before the decision step decided nothing');
    assert.equal(described.json.decisions, null);
  });

  it('names the copy of the report beside the ledger with the record, and only beside a current report (R16 of the brief of a run)', () => {
    const copy = '/w/.git/deep-review-checkpoint/reports/2026-09-27-run-1.md';
    const described = describeRun(reported().fold(), claudeAdapter, evidencePath, { reportCopy: copy });
    assert.ok(described.lines.includes(`Report: ${copy}, a copy of the record /evidence/${'e'.repeat(8)}-2048`), described.lines.join('\n'));
    assert.equal(described.json.reportCopy, copy);
    assert.equal(describeRun(reported().fold(), claudeAdapter, evidencePath).json.reportCopy, null, 'no copy given');
    const working = describeRun(continuedRun().fold(), claudeAdapter, evidencePath, { reportCopy: copy });
    assert.equal(working.json.reportCopy, null, 'the copy holds the report before while the run works again');
    assert.ok(!working.lines.some((line) => line.startsWith('Report: ')));
  });

  it('counts the decisions of a read-only run once they are recorded, after its report (R8 of the decision step)', () => {
    const described = describeRun(decidedOf(reported(), [decisions[0], askDecision('SWEEP-1', false)]).fold(), claudeAdapter, evidencePath);
    assert.equal(described.lines.at(-1), 'Decisions: 1 to fix, 0 to leave, 1 to ask the author');
    assert.deepEqual(described.json.decisions, { fix: 1, leave: 0, ask: 1 });
    assert.equal(describeRun(decidedOf(mergeRanked(), null).fold(), claudeAdapter, evidencePath).json.decisions, null, 'none while the decision has not run');
  });
});


// R7 of fix pass continuation.
describe('describeRun of a run continued into the fix pass', () => {
  it('names the read-only report beside the current state while the continuation runs, and beside the second report once written', () => {
    const running = describeRun(continuedRun().fold(), claudeAdapter, evidencePath);
    const at = continuedRun().fold().review!.continuedFrom!.at;
    const first = evidencePath(reference('e', 2048));
    assert.ok(running.lines.includes(`Continued from: ${first}, into the fix pass on ${at}`), running.lines.join('\n'));
    assert.ok(!running.lines.some((line) => line.startsWith('Report: ')), 'no report while the continuation runs');
    assert.deepEqual(running.json.continuedFrom, { report: first, at });
    assert.equal(running.json.report, null);
    assert.equal(running.json.status, 'active');
    const done = describeRun(continuedToReport().fold(), claudeAdapter, evidencePath);
    assert.deepEqual(done.json.continuedFrom, { report: first, at });
    assert.equal(done.json.report, evidencePath(reference('9', 4096)));
    assert.ok(done.lines.indexOf(`Continued from: ${first}, into the fix pass on ${at}`) === done.lines.indexOf(`Report: ${evidencePath(reference('9', 4096))}`) - 1, 'the read-only report, then the second');
  });

  it('names none for a run never continued', () => {
    const described = describeRun(readOnlyReported().fold(), claudeAdapter, evidencePath);
    assert.equal(described.json.continuedFrom, null);
    assert.ok(!described.lines.some((line) => line.startsWith('Continued from:')));
  });
});

describe('describeRun of an answered run (R10 of answers)', () => {
  it('says nothing of answers for a run nobody answered', () => {
    const described = describeRun(decidedFixRun().fold(), claudeAdapter, evidencePath);
    assert.ok(!described.lines.some((line) => line.startsWith('Answers:')));
    assert.deepEqual((described.json as { answers: unknown }).answers, []);
  });

  it('names each answered finding with its standing answer, how many the tree holds, and the passes', () => {
    const answered = decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.recorded', answer('SWEEP-1', 0)).add('answer.recorded', answer('SWEEP-1', 1));
    assert.ok(describeRun(answered.fold(), claudeAdapter, evidencePath).lines.includes('Answers: 2 recorded (RIPPLE-1 rejected, SWEEP-1 option 2), 0 applied; no pass'));
    const passed = passToReport(answered.add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] }), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2);
    const state = passed.fold();
    const at = state.review!.answerPasses[0]!.at;
    const described = describeRun(state, claudeAdapter, evidencePath);
    assert.ok(described.lines.includes(`Answers: 2 recorded (RIPPLE-1 rejected, SWEEP-1 option 2), 1 applied; passes: 1, the last on ${at}`), described.lines.join('\n'));
    assert.ok(described.lines.includes('Check build: baseline-checks passed, checks passed, repair-checks -, answer-checks passed'), described.lines.join('\n'));
    const json = JSON.parse(JSON.stringify(described.json)) as { answers: { id: string; appliedBy: unknown }[]; answerPasses: { ids: string[]; at: string; reportBefore: string }[]; commits: unknown[] };
    assert.deepEqual(json.answers.map((entry) => [entry.id, entry.appliedBy]), [['RIPPLE-1', { phase: 'answer', key: 'pass-1' }], ['SWEEP-1', 'tree'], ['SWEEP-1', null]]);
    assert.deepEqual(json.answerPasses, [{ ids: ['RIPPLE-1', 'SWEEP-1'], at, reportBefore: '/evidence/99999999-4096', openedAt: { answer: 0, checks: 0 } }]);
    assert.deepEqual(json.commits, []);
  });

  it('marks a check run a later fix made old as one of an earlier tree, and not one an answer pass followed (TD3 of resumable runs)', () => {
    const state = decidedFixRun().fold();
    const fix = state.review!.fix!;
    const lines = (phase: string): string[] => describeRun({ ...state, review: { ...state.review!, fix: { ...fix, revisions: [...fix.revisions, { ...fix.revisions[0]!, phase } as never] } } }, claudeAdapter, evidencePath).lines;
    assert.ok(lines('fixes').some((line) => /^Check build: baseline-checks passed, checks passed \(an earlier tree\), /.test(line)), lines('fixes').join('\n'));
    assert.ok(lines('answer').some((line) => /^Check build: baseline-checks passed, checks passed, /.test(line)), lines('answer').join('\n'));
  });

  it('names every series of commits', () => {
    const first = { commits: [{ sha: 'a'.repeat(40), revision: 'change', subject: 'the change' }, { sha: 'b'.repeat(40), revision: 0, subject: 'fix: Guard the null' }], from: '2'.repeat(40), to: 'b'.repeat(40) };
    const lines = describeRun(decidedFixRun().add('commits.created', first).fold(), claudeAdapter, evidencePath).lines;
    assert.ok(lines.includes(`Commits: 2 created, ${'2'.repeat(40)} to ${'b'.repeat(40)}`), lines.join('\n'));
  });
});

describe('runListLines (R10 of the questions in the chat)', () => {
  // Each run of a list has an id and a start of its own; the histories here all fold to run-1.
  const as = (state: RunState, n: number, worktree = '/w'): RunState => ({ ...state, id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, createdAt: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`, worktree });
  const copyOf = (state: RunState): string | null => `/w/.git/deep-review-checkpoint/reports/${state.id.slice(0, 8)}.md`;
  const scopeWords = 'worktree, 1 file, from 11111111 to the working tree';

  it('gives a line for each state, newest first, with the reason of an abandon and the code of a blocker', () => {
    const blocker = { code: 'budget', detail: 'd', action: blockerActions.budget };
    const runs = [
      as(reported().fold(), 1),
      as(configured().add('run.abandoned', { reason: 'the wrong\nscope' }).fold(), 2),
      as(triaged().start('finders').finish('finders', 'blocked', 1, blocker).fold(), 3),
      as(configured().fold(), 4),
    ];
    assert.deepEqual(runListLines(runs, '/w', copyOf), [
      `00000004 started 2026-10-04T00:00:00.000Z: active; ${scopeWords}; no current report`,
      `00000003 started 2026-10-03T00:00:00.000Z: blocked (budget); ${scopeWords}; no current report`,
      `00000002 started 2026-10-02T00:00:00.000Z: abandoned (the wrong scope); ${scopeWords}; no current report`,
      `00000001 started 2026-10-01T00:00:00.000Z: complete; ${scopeWords}; report /w/.git/deep-review-checkpoint/reports/00000001.md`,
    ]);
  });

  it('cuts the reason of an abandon at a word at 200 characters, and keeps the scope and the report after it whole', () => {
    const reason = `${'very '.repeat(100)}long`;
    const [line] = runListLines([as(configured().add('run.abandoned', { reason }).fold(), 1)], '/w', copyOf);
    assert.equal(line, `00000001 started 2026-10-01T00:00:00.000Z: abandoned (${cutAtWord(reason, shortLineLimit)}); ${scopeWords}; no current report`);
    assert.ok(cutAtWord(reason, shortLineLimit).length <= shortLineLimit && cutAtWord(reason, shortLineLimit).endsWith('very...'));
  });

  it('says that a run has no scope yet, and names the worktree of a run of another one', () => {
    const runs = [as(new History().add('run.created', { worktree: '/other' }).fold(), 1, '/other'), as(reported().fold(), 2, '/other')];
    assert.deepEqual(runListLines(runs, '/w', copyOf), [
      `00000002 started 2026-10-02T00:00:00.000Z: complete; ${scopeWords}; worktree /other; report /w/.git/deep-review-checkpoint/reports/00000002.md`,
      '00000001 started 2026-10-01T00:00:00.000Z: active; no scope captured yet; worktree /other; no current report',
    ]);
  });

  it('names a commit as its end, and the empty tree as the base of a root commit', () => {
    const root = new History().add('run.created', { worktree: '/w' }).add('scope.captured', { ...scope, mode: 'last-commit', base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }).fold();
    assert.deepEqual(runListLines([as(root, 1)], '/w', copyOf), ['00000001 started 2026-10-01T00:00:00.000Z: active; last-commit, 1 file, from the empty tree to 22222222; no current report']);
  });

  it('says how to write the copy of a current report that has none, and names no copy for a run that works again, whose copy holds the report before', () => {
    const lines = runListLines([as(reported().fold(), 1), as(continuedRun().fold(), 2)], '/w', (state) => (state.id.startsWith('00000001') ? null : copyOf(state)));
    assert.deepEqual(lines, [
      `00000002 started 2026-10-02T00:00:00.000Z: active; ${scopeWords}; no current report`,
      `00000001 started 2026-10-01T00:00:00.000Z: complete; ${scopeWords}; a current report with no copy; deep-review report --run 00000001 writes one`,
    ]);
  });

  it('lists at most 20 runs, the newest, and counts the others', () => {
    const state = configured().fold();
    const runs = Array.from({ length: 22 }, (_, index) => as(state, index + 1));
    const lines = runListLines(runs, '/w', copyOf);
    assert.equal(listedRuns, 20);
    assert.equal(lines.length, 21);
    assert.ok(lines[0]!.startsWith('00000022 started'), lines[0]!);
    assert.ok(lines[19]!.startsWith('00000003 started'), lines[19]!);
    assert.equal(lines[20], '2 older runs are not shown; deep-review status --run <id> shows one');
    assert.equal(runListLines(runs.slice(0, 21), '/w', copyOf).at(-1), '1 older run is not shown; deep-review status --run <id> shows one');
    assert.equal(runListLines(runs.slice(0, 20), '/w', copyOf).length, 20, 'no count line when every run is shown');
    assert.deepEqual(runListLines([], '/w', copyOf), []);
  });

  it('keeps the reverse of the ledger order for runs that started at the same moment', () => {
    const state = configured().fold();
    const runs = [as(state, 1), { ...as(state, 2), createdAt: as(state, 1).createdAt }];
    assert.deepEqual(runListLines(runs, '/w', copyOf).map((line) => line.slice(0, 8)), ['00000002', '00000001']);
  });
});

describe('the scope of a run in status (R12 of the questions in the chat)', () => {
  const values = { 'review.base': 'origin/main', 'scope.default': 'auto', 'scope.exclude': [], 'tools.path': [] };
  /** A run whose settings recorded `origin/main` as its base, with the range `range` captured, or with no recorded settings. */
  const ranged = (range: { from: string; to: string; mergeBase: boolean } | null, recorded = true): RunState => {
    const state = (recorded ? settingsConfigured(false, { values }) : configured()).fold();
    return range === null ? state : { ...state, scope: { ...state.scope!, mode: 'range', request: { ...state.scope!.request, range } } };
  };

  it('reads branch for the range that --branch records, and for the same range given by --from, --to and --merge-base', () => {
    assert.equal(askedModeOf(ranged({ from: 'origin/main', to: 'HEAD', mergeBase: true })), 'branch');
  });

  it('keeps range for a range with another start, another end or no merge base, and for a run with no recorded settings', () => {
    assert.equal(askedModeOf(ranged({ from: 'origin/dev', to: 'HEAD', mergeBase: true })), 'range');
    assert.equal(askedModeOf(ranged({ from: 'origin/main', to: 'main', mergeBase: true })), 'range');
    assert.equal(askedModeOf(ranged({ from: 'origin/main', to: 'HEAD', mergeBase: false })), 'range');
    assert.equal(askedModeOf(ranged({ from: 'origin/main', to: 'HEAD', mergeBase: true }, false)), 'range');
    assert.equal(askedModeOf(ranged(null)), 'worktree', 'any other mode as it was captured');
  });

  it('gives the Scope line of a captured scope, with the count of commits status gives it, and the paths in the JSON form', () => {
    const state = ranged({ from: 'origin/main', to: 'HEAD', mergeBase: true });
    const withExcluded: RunState = { ...state, scope: { ...state.scope!, request: { ...state.scope!.request, exclude: ['dist/**'] }, excluded: { paths: ['dist/a.js', 'dist/b.js'], count: 2 } } };
    const described = describeRun(withExcluded, claudeAdapter, evidencePath, { commits: 3 });
    assert.equal(described.lines[2], `Scope: branch, 3 commits and 1 file (2 more paths left out by scope.exclude), from the merge base with origin/main (${'1'.repeat(8)}) to the working tree`);
    assert.deepEqual(described.json.scope, { mode: 'branch', base: '1'.repeat(40), baseName: 'the merge base with origin/main', target: null, commits: 3, fileCount: 1, excludedCount: 2, uncommitted: null, empty: null, files: ['src/a.ts'], excluded: ['dist/a.js', 'dist/b.js'] });
    // With no count, the line leaves it out; a last-commit scope ends at its commit.
    const lastCommit: RunState = { ...state, scope: { ...state.scope!, mode: 'last-commit', request: { paths: [], exclude: [] } } };
    assert.equal(describeRun(lastCommit, claudeAdapter, evidencePath).lines[2], `Scope: last-commit, 1 file, from the parent of HEAD (${'1'.repeat(8)}) to ${'2'.repeat(8)}`);
  });

  it('names branch in the list of runs too', () => {
    const state = { ...ranged({ from: 'origin/main', to: 'HEAD', mergeBase: true }), id: '00000001-0000-4000-8000-000000000000', createdAt: '2026-10-01T00:00:00.000Z' };
    assert.deepEqual(runListLines([state], '/w', () => null), [`00000001 started 2026-10-01T00:00:00.000Z: active; branch, 1 file, from ${'1'.repeat(8)} to the working tree; no current report`]);
  });
});

describe('noReportWords (R9 of the questions in the chat)', () => {
  const blocker = { code: 'budget', detail: 'd', action: blockerActions.budget };

  it('gives the reason of an abandon, with no period of its own at the end, also between two phases', () => {
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: 'wrong scope.' }).fold()), 'was abandoned: wrong scope');
    assert.equal(noReportWords(triaged().add('run.abandoned', { reason: 'the wrong\nbranch' }).fold()), 'was abandoned: the wrong branch');
    assert.equal(noReportWords(new History().add('run.created', { worktree: '/w' }).add('run.abandoned', { reason: 'r' }).fold()), 'was abandoned: r', 'an abandon comes before a review that never started');
  });

  it('keeps a reason made only of periods, so something follows the colon', () => {
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: '.' }).fold()), 'was abandoned: .');
    assert.equal(noReportWords(configured().add('run.abandoned', { reason: ' ...\n' }).fold()), 'was abandoned: ...');
  });

  it('gives the code of the blocker of a blocked run, and says that a run with no blocker is in progress', () => {
    assert.equal(noReportWords(triaged().start('finders').finish('finders', 'blocked', 1, blocker).fold()), 'is blocked (budget)');
    assert.equal(noReportWords(configured().fold()), 'is in progress');
    assert.equal(noReportWords(triaged().start('finders').fold()), 'is in progress');
  });

  it('says that a run whose review never started never started it', () => {
    assert.equal(noReportWords(new History().add('run.created', { worktree: '/w' }).fold()), 'never started its review');
  });

  it('names the answer pass, the continuation or the reopened fix pass that a run works again in', () => {
    const passing = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }).fold();
    assert.equal(passing.review!.report, null);
    assert.equal(noReportWords(passing), 'works again in an answer pass');
    const continued = continuedRun().fold();
    assert.equal(continued.review!.report, null);
    assert.equal(noReportWords(continued), 'works again, continued into the fix pass');
    // A reopening as the fold holds it, on a run whose report it set aside.
    const fixedRun = decidedFixRun().fold();
    const reopening = { at: '2026-09-27T01:00:00.000Z', units: [], reportBefore: fixedRun.review!.report!, answerPassesBefore: 0, repairAnswered: false };
    const reopened: RunState = { ...fixedRun, review: { ...fixedRun.review!, report: null, reportSetAsideBy: 'reopened-fix-pass', fix: { ...fixedRun.review!.fix!, reopenings: [reopening] } } };
    assert.equal(noReportWords(reopened), 'works again in a reopened fix pass');
    assert.equal(noReportWords({ ...reopened, review: { ...reopened.review!, blocker: { ...blocker, code: 'budget' as const, phase: 'fixes' as const } } }), 'is blocked (budget)', 'a blocker comes first');
  });

  it('names what set the last report aside, whatever the times of the earlier reopenings', () => {
    // A continued run that then opened an answer pass; the clock of these histories wraps each minute, so the continuation's time is the later one.
    const passing = decidedFixRun().add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['SWEEP-1'] }).fold();
    const continuedFrom = continuedToReport().fold().review!.continuedFrom;
    const worked: RunState = { ...passing, review: { ...passing.review!, continuedFrom } };
    assert.ok(continuedFrom!.at > passing.review!.answerPasses.at(-1)!.at, 'the continuation reads as the later one by its time');
    assert.equal(noReportWords(worked), 'works again in an answer pass');
    // At the same time, too.
    assert.equal(noReportWords({ ...worked, review: { ...worked.review!, continuedFrom: { ...continuedFrom!, at: passing.review!.answerPasses.at(-1)!.at } } }), 'works again in an answer pass');
  });
});
