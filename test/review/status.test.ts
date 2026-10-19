import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeRun } from '../../src/review/status.ts';
import { blockerActions } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { answer, askDecision, decidedFixRun, passToReport, configured, continuedRun, continuedToReport, decidedOf, decisions, History, launch, mergeRanked, readOnlyReported, reference, reported, triaged, worker } from '../helpers/review-history.ts';

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
    assert.deepEqual(described.json, { runId: 'run-1', status: 'active', worktree: '/w', phase: null, workers: { running: 0, finished: 0, lost: 0 }, statistics: null, budgetCheck: null, blocker: null, report: null, continuedFrom: null, decisions: null, answers: [], answerPasses: [], fix: null, patches: [], commits: [], continueCommand: null, review: null });
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
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[6], 'Spend: 0.50 USD of 30.00 USD; 200 input, 100 output tokens');
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[7], undefined, 'no budget check line when it counts the reported spend alone');
    const timedOut = triaged().start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    const described = describeRun(timedOut, claudeAdapter, evidencePath);
    assert.deepEqual(described.lines.slice(6), [
      'Spend: 0.50 USD; 200 input, 100 output tokens',
      'Budget check: 8.50 USD of 30.00 USD, counting 1 worker that reported no cost at its per-worker cap',
    ]);
    assert.deepEqual(described.json.budgetCheck, { usd: 8.5, charged: 1, lost: 0 });
    const unbudgeted = triaged().add('limits.changed', { concurrency: 4, runBudgetUsd: null }).start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    assert.deepEqual(describeRun(unbudgeted, claudeAdapter, evidencePath).lines.slice(6), ['Spend: 0.50 USD; 200 input, 100 output tokens'], 'no budget in force, so no check to describe');
  });

  it('describes a spend no worker reported, and a run with no budget in force, without inventing either', () => {
    const state = configured()
      .add('limits.changed', { concurrency: 4, runBudgetUsd: null })
      .start('triage')
      .worker(1, 'triage triage:SCAN', { usage: null })
      .fold();
    assert.equal(describeRun(state, claudeAdapter, evidencePath).lines[6], 'Spend: no cost reported; no tokens reported');
  });

  it('names the report of a complete run through the evidence path, and no phase', () => {
    const state = reported().fold();
    const described = describeRun(state, claudeAdapter, evidencePath);
    assert.equal(described.lines[0], 'Run run-1: complete');
    assert.equal(described.lines[4], 'Phase: none running');
    // The report, then what a stop did: this run lost a WRAPPERS worker and ran it again (R15 of resumable runs).
    assert.deepEqual(described.lines.slice(-2), [`Report: /evidence/${'e'.repeat(8)}-2048`, 'Stop: Lost with the engine: the worker of finder-WRAPPERS finders:WRAPPERS, and ran again.']);
    assert.ok(!described.lines.some((line) => line.startsWith('Blocker: ')));
    assert.equal(described.json.report, `/evidence/${'e'.repeat(8)}-2048`);
    assert.ok(!described.lines.some((line) => line.startsWith('Decisions: ')), 'a run configured before the decision step decided nothing');
    assert.equal(described.json.decisions, null);
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
