import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeRun } from '../../src/review/status.ts';
import { blockerActions } from '../../src/review/vocabulary.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { configured, History, launch, reported, triaged, worker } from '../helpers/review-history.ts';

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
    assert.deepEqual(described.json, { runId: 'run-1', status: 'active', worktree: '/w', phase: null, workers: { running: 0, finished: 0, lost: 0 }, statistics: null, budgetCheck: null, blocker: null, report: null, review: null });
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
      'Phase: finders (attempt 1, blocked)',
      'Workers: 1 running, 2 finished, 1 lost',
      // The triage's 0.50 USD and RIPPLE's 1.25; input tokens count the cached ones, 200 and 600.
      'Spend: 1.75 USD; 800 input, 400 output tokens',
      // The lost FOOTGUNS worker is named beside what the check counts, which is then shown apart from the reported spend.
      'Budget check: 1.75 USD of 45.00 USD, 1 worker lost with an earlier engine is not counted',
      `Blocker: budget: ${blocker.detail}`,
      `Action: ${blockerActions.budget}`,
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
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[5], 'Spend: 0.50 USD of 30.00 USD; 200 input, 100 output tokens');
    assert.equal(describeRun(plain, claudeAdapter, evidencePath).lines[6], undefined, 'no budget check line when it counts the reported spend alone');
    const timedOut = triaged().start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    const described = describeRun(timedOut, claudeAdapter, evidencePath);
    assert.deepEqual(described.lines.slice(5), [
      'Spend: 0.50 USD; 200 input, 100 output tokens',
      'Budget check: 8.50 USD of 30.00 USD, counting 1 worker that reported no cost at its per-worker cap',
    ]);
    assert.deepEqual(described.json.budgetCheck, { usd: 8.5, charged: 1, lost: 0 });
    const unbudgeted = triaged().add('limits.changed', { concurrency: 4, runBudgetUsd: null }).start('finders').worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' }).fold();
    assert.deepEqual(describeRun(unbudgeted, claudeAdapter, evidencePath).lines.slice(5), ['Spend: 0.50 USD; 200 input, 100 output tokens'], 'no budget in force, so no check to describe');
  });

  it('describes a spend no worker reported, and a run with no budget in force, without inventing either', () => {
    const state = configured()
      .add('limits.changed', { concurrency: 4, runBudgetUsd: null })
      .start('triage')
      .worker(1, 'triage triage:SCAN', { usage: null })
      .fold();
    assert.equal(describeRun(state, claudeAdapter, evidencePath).lines[5], 'Spend: no cost reported; no tokens reported');
  });

  it('names the report of a complete run through the evidence path, and no phase', () => {
    const state = reported().fold();
    const described = describeRun(state, claudeAdapter, evidencePath);
    assert.equal(described.lines[0], 'Run run-1: complete');
    assert.equal(described.lines[3], 'Phase: none running');
    assert.equal(described.lines.at(-1), `Report: /evidence/${'e'.repeat(8)}-2048`);
    assert.ok(!described.lines.some((line) => line.startsWith('Blocker: ')));
    assert.equal(described.json.report, `/evidence/${'e'.repeat(8)}-2048`);
  });
});

