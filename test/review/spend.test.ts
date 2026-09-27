import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUnitLabel, unitLabel } from '../../src/review/labels.ts';
import type { WorkerState } from '../../src/checkpoint/fold.ts';
import { runSpendUsd, settledWorkers, spendOf, statisticsOf, usageOf } from '../../src/review/spend.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { History, configuration, configured, launch, reported, scope, worker } from '../helpers/review-history.ts';

type Finished = Extract<WorkerState, { status: 'finished' }>;
const finishedOf = (workers: readonly WorkerState[]): Finished[] => workers.filter((entry): entry is Finished => entry.status === 'finished');

describe('unit labels', () => {
  it('write the role and unit and read them back, and read nothing from another label', () => {
    assert.equal(unitLabel('finder-RIPPLE', 'finders', 'RIPPLE'), 'finder-RIPPLE finders:RIPPLE');
    assert.deepEqual(parseUnitLabel('verifier sweep-verification:g12'), { role: 'verifier', phase: 'sweep-verification', key: 'g12' });
    assert.deepEqual(parseUnitLabel(unitLabel('triage', 'triage', 'SCAN')), { role: 'triage', phase: 'triage', key: 'SCAN' });
    assert.equal(parseUnitLabel(null), null);
    assert.equal(parseUnitLabel('smoke claude'), null);
    assert.equal(parseUnitLabel('finder-RIPPLE nowhere:RIPPLE'), null, 'an unknown phase is no unit');
    assert.equal(parseUnitLabel('finder-RIPPLE finders:RIP PLE'), null);
  });
});

describe('spend', () => {
  it('summarizes each finished worker through the runtime, and nothing for a worker without usage or with usage that is not JSON', () => {
    const state = reported().fold();
    const finished = finishedOf(settledWorkers(state));
    assert.equal(finished.length, 15);
    assert.deepEqual(usageOf(finished[0]!, claudeAdapter), { costUsd: 0.5, inputTokens: 200, cachedInputTokens: 100, outputTokens: 100 });
    const timedOut = finished.find((entry) => entry.finish.outcome === 'timeout')!;
    assert.deepEqual(usageOf(timedOut, claudeAdapter), { costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.deepEqual(usageOf({ ...finished[0]!, finish: { ...finished[0]!.finish, usage: 'not json' } }, claudeAdapter), { costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null });
  });

  it('sums the run over the workers that reported, rounding cost to the cent', () => {
    const state = reported().fold();
    const spend = spendOf(settledWorkers(state), claudeAdapter);
    // Fourteen workers reported 0.5 USD and 100 tokens of each kind; the timed-out one reported nothing, and one was lost.
    // Every synthetic worker ran over the same 30 seconds, so the wall time is 30, not 15 times 30.
    assert.deepEqual(spend, { workers: 15, seconds: 30, costUsd: 7, costUnreported: 2, inputTokens: 2800, cachedInputTokens: 1400, outputTokens: 1400 });
    assert.equal(runSpendUsd(state, claudeAdapter), 7);
    assert.equal(runSpendUsd(configured().fold(), claudeAdapter), null, 'no worker, no spend');
    const floating = configured().worker(1, 'triage triage:SCAN', {}, 0.1).worker(2, 'sweep sweep:sweep', {}, 0.2).fold();
    assert.equal(runSpendUsd(floating, claudeAdapter), 0.3);
  });

  it('rounds a cost half a cent up, even where the float times a hundred falls just below the half', () => {
    const costOf = (usd: number): number | null => runSpendUsd(configured().worker(1, 'triage triage:SCAN', {}, usd).fold(), claudeAdapter);
    // 1.005 * 100 is 100.49999999999999 and 2.675 * 100 is 267.49999999999997 in binary floating point.
    assert.equal(costOf(1.005), 1.01);
    assert.equal(costOf(2.675), 2.68);
    assert.equal(costOf(1234.565), 1234.57);
    assert.equal(costOf(1.004), 1);
    assert.equal(costOf(0.0000001), 0, 'a cost printed in exponent form still rounds');
    assert.equal(costOf(0), 0);
  });

  it('measures wall time as the union of the worker intervals, so concurrent workers count once', () => {
    const at = (second: number): string => new Date(Date.UTC(2026, 8, 27, 0, 0, second)).toISOString();
    const ran = (from: number, to: number): Record<string, unknown> => ({ startedAt: at(from), endedAt: at(to) });
    const state = configured()
      .worker(1, 'finder-RIPPLE finders:RIPPLE', ran(0, 30))
      .worker(2, 'finder-FOOTGUNS finders:FOOTGUNS', ran(10, 40))
      .worker(3, 'finder-DESIGN finders:DESIGN', ran(15, 20))
      .worker(4, 'finder-WRAPPERS finders:WRAPPERS', ran(100, 130))
      .worker(5, 'finder-ALTITUDE finders:ALTITUDE', ran(130, 145))
      .worker(6, 'sweep sweep:sweep', ran(200, 210))
      .fold();
    const statistics = statisticsOf(state, claudeAdapter);
    // [0, 40] overlapping three workers, then [100, 145] touching end to start: 40 + 45.
    assert.equal(statistics.phases.find((entry) => entry.phase === 'finders')!.seconds, 85);
    assert.equal(statistics.phases.find((entry) => entry.phase === 'sweep')!.seconds, 10);
    assert.equal(statistics.total.seconds, 95, 'the total is the union over the whole run, not a sum of the phase rows');
    assert.equal(spendOf([], claudeAdapter).seconds, 0, 'no worker, no time');
    const skewed = configured().worker(1, 'sweep sweep:sweep', ran(50, 20)).fold();
    assert.equal(spendOf(settledWorkers(skewed), claudeAdapter).seconds, 0, 'a clock that ran backwards counts as no time, never negative');
  });

  it('reports no cost through a runtime that reports none, and says the budget did not apply', () => {
    const state = reported().fold();
    assert.equal(runSpendUsd(state, codexAdapter), null);
    assert.equal(statisticsOf(state, codexAdapter).budgetApplied, false);
    assert.equal(statisticsOf(state, claudeAdapter).budgetApplied, true);
  });

  it('says the run budget applied from the limits in force at the end, not the pinned budget', () => {
    const pinnedWithout = new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', { ...configuration, runBudgetUsd: null });
    assert.equal(statisticsOf(pinnedWithout.fold(), claudeAdapter).budgetApplied, false, 'no budget pinned and none given');
    pinnedWithout.add('limits.changed', { concurrency: 4, runBudgetUsd: 50 });
    assert.equal(statisticsOf(pinnedWithout.fold(), claudeAdapter).budgetApplied, true, 'a budget given on a resume applies');
    assert.equal(statisticsOf(pinnedWithout.fold(), codexAdapter).budgetApplied, false, 'never on a runtime that reports no cost');
    const lifted = configured().add('limits.changed', { concurrency: 4, runBudgetUsd: null });
    assert.equal(statisticsOf(lifted.fold(), claudeAdapter).budgetApplied, false, 'the budget in force at the end is none');
  });

  it('gives one row per phase from the workers whose label names it, and a total', () => {
    const statistics = statisticsOf(reported().fold(), claudeAdapter);
    const row = (phase: string) => statistics.phases.find((entry) => entry.phase === phase)!;
    assert.deepEqual(row('triage'), { phase: 'triage', workers: 1, seconds: 30, costUsd: 0.5, costUnreported: 0, inputTokens: 200, cachedInputTokens: 100, outputTokens: 100 });
    assert.equal(row('finders').workers, 9, 'nine finders finished: eight answered, one timed out; the lost one never finished');
    assert.equal(row('finders').costUsd, 4);
    assert.equal(row('finders').costUnreported, 2, 'the timed-out finder and the lost one spent money no summary reports');
    assert.deepEqual(row('report'), { phase: 'report', workers: 0, seconds: 0, costUsd: null, costUnreported: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.deepEqual(statistics.phases.map((entry) => entry.phase), ['triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'report']);
    assert.equal(statistics.total.workers, 15);
    assert.equal(statistics.phases.reduce((total, entry) => total + entry.workers, 0), 15, 'every finished worker counts toward one phase');
    assert.equal(statistics.total.costUnreported, 2);
  });

  it('counts every settled worker whose cost is unknown, and leaves it out of the budget sum', () => {
    const history = configured()
      .worker(1, 'triage triage:SCAN', {}, 1.25)
      .worker(2, 'finder-RIPPLE finders:RIPPLE', { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null, usage: null, error: 'timed out' })
      .worker(3, 'finder-DESIGN finders:DESIGN', { outcome: 'failed', exitCode: 1, output: null, usage: JSON.stringify({ usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, modelUsage: null }), error: 'no envelope' })
      .add('worker.launched', launch(worker(4), 'finder-ALTITUDE finders:ALTITUDE'))
      .add('worker.lost', { workerId: worker(4), phase: 'finders', key: 'ALTITUDE', reason: 'the engine exited while the worker ran' })
      .add('worker.launched', launch(worker(5), 'finder-WRAPPERS finders:WRAPPERS'));
    const state = history.fold();
    assert.deepEqual(settledWorkers(state).map((entry) => entry.launch.workerId), [worker(1), worker(2), worker(3), worker(4)], 'a running worker is not settled');
    const statistics = statisticsOf(state, claudeAdapter);
    const finders = statistics.phases.find((entry) => entry.phase === 'finders')!;
    assert.equal(finders.workers, 2, 'the lost worker never finished');
    assert.equal(finders.costUnreported, 3, 'a timeout, a failure whose usage names no cost, and a lost worker');
    assert.equal(finders.costUsd, null, 'no finder reported a cost');
    assert.equal(finders.inputTokens, 5, 'tokens are summed where reported, independent of cost');
    assert.equal(statistics.total.costUnreported, 3);
    assert.equal(statistics.total.costUsd, 1.25);
    assert.equal(runSpendUsd(state, claudeAdapter), 1.25, 'the budget check sums the reported costs alone');
    assert.equal(statisticsOf(state, codexAdapter).total.costUnreported, null, 'a runtime that reports no cost has no unreported count');
    assert.equal(spendOf([], claudeAdapter).costUnreported, 0);
  });
});
