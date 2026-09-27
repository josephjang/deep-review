import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUnitLabel, unitLabel } from '../../src/review/labels.ts';
import { finishedWorkers, runSpendUsd, spendOf, statisticsOf, usageOf } from '../../src/review/spend.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { configured, reported, worker } from '../helpers/review-history.ts';

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
    const finished = finishedWorkers(state);
    assert.equal(finished.length, 15);
    assert.deepEqual(usageOf(finished[0]!, claudeAdapter), { costUsd: 0.5, inputTokens: 200, cachedInputTokens: 100, outputTokens: 100 });
    const timedOut = finished.find((entry) => entry.finish.outcome === 'timeout')!;
    assert.deepEqual(usageOf(timedOut, claudeAdapter), { costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.deepEqual(usageOf({ ...finished[0]!, finish: { ...finished[0]!.finish, usage: 'not json' } }, claudeAdapter), { costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null });
  });

  it('sums the run over the workers that reported, rounding cost to the cent', () => {
    const state = reported().fold();
    const spend = spendOf(finishedWorkers(state), claudeAdapter);
    // Fourteen workers reported 0.5 USD and 100 tokens of each kind; the timed-out one reported nothing.
    assert.deepEqual(spend, { workers: 15, seconds: 450, costUsd: 7, inputTokens: 2800, cachedInputTokens: 1400, outputTokens: 1400 });
    assert.equal(runSpendUsd(state, claudeAdapter), 7);
    assert.equal(runSpendUsd(configured().fold(), claudeAdapter), null, 'no worker, no spend');
    const floating = configured().worker(1, 'triage triage:SCAN', {}, 0.1).worker(2, 'sweep sweep:sweep', {}, 0.2).fold();
    assert.equal(runSpendUsd(floating, claudeAdapter), 0.3);
  });

  it('reports no cost through a runtime that reports none, and says the budget did not apply', () => {
    const state = reported().fold();
    assert.equal(runSpendUsd(state, codexAdapter), null);
    assert.equal(statisticsOf(state, codexAdapter).budgetApplied, false);
    assert.equal(statisticsOf(state, claudeAdapter).budgetApplied, true);
  });

  it('gives one row per phase from the workers whose label names it, and a total', () => {
    const statistics = statisticsOf(reported().fold(), claudeAdapter);
    const row = (phase: string) => statistics.phases.find((entry) => entry.phase === phase)!;
    assert.deepEqual(row('triage'), { phase: 'triage', workers: 1, seconds: 30, costUsd: 0.5, inputTokens: 200, cachedInputTokens: 100, outputTokens: 100 });
    assert.equal(row('finders').workers, 9, 'nine finders finished: eight answered, one timed out; the lost one never finished');
    assert.equal(row('finders').costUsd, 4);
    assert.deepEqual(row('report'), { phase: 'report', workers: 0, seconds: 0, costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.deepEqual(statistics.phases.map((entry) => entry.phase), ['triage', 'finders', 'deduplication', 'verification', 'sweep', 'sweep-deduplication', 'sweep-verification', 'merge-rank', 'report']);
    assert.equal(statistics.total.workers, 15);
    assert.equal(statistics.phases.reduce((total, entry) => total + entry.workers, 0), 15, 'every finished worker counts toward one phase');
    void worker;
  });
});
