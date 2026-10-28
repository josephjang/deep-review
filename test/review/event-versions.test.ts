import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventRegistry } from '../../src/checkpoint/events.ts';
import { lookupEvent } from '../../src/checkpoint/registry.ts';
import { checkRanEvent, writtenVersion } from '../../src/review/event-versions.ts';
import { attemptFaults, budgetDegradingPhases, checkPhases, editingPhases, phases, worktreeMoments, type Phase } from '../../src/review/vocabulary.ts';

// The expressions each writer chose its version with before the table, as they were written at each site.
const before = {
  phaseStarted: (phase: Phase): number => (phase === 'documentation' ? 6 : 5),
  phaseFinished: (phase: Phase): number => (phase === 'report' ? 6 : phase === 'documentation' ? 7 : 6),
  worktreeChecked: (phase: Phase, moment: string): number => (phase === 'documentation' ? 7 : moment === 'restored' ? 6 : 5),
  attemptFailed: (phase: Phase, fault: string): number => (phase === 'documentation' ? 8 : fault === 'cut' || fault === 'limit' ? 7 : 6),
  workerLost: (phase: Phase | null): number => (phase === 'documentation' ? 6 : 5),
  reportWritten: (rows: readonly Phase[]): number => (rows.some((row) => row === 'documentation') ? 6 : 5),
  treeRevised: (phase: Phase): number => ((checkPhases as readonly Phase[]).includes(phase) ? 2 : phase === 'documentation' ? 3 : 2),
  fixRecorded: (phase: Phase): number => (phase === 'documentation' ? 3 : 2),
  unitUnattempted: (phase: Phase): number => (phase === 'documentation' ? 2 : 1),
  fixReopened: (units: readonly Phase[]): number => (units.some((phase) => phase === 'documentation') ? 2 : 1),
  checkStarted: (): number => 1,
  checkRan: (): number => 3,
};

/** The phases the engine wrote before the checks on the base, which the expressions above covered. */
const earlierPhases = phases.filter((phase) => phase !== 'base-checks');

/** Every list of the phases in `of`, the empty one among them. */
const subsets = (of: readonly Phase[]): Phase[][] => of.reduce<Phase[][]>((lists, phase) => [...lists, ...lists.map((list) => [...list, phase])], [[]]);

describe('the version each event that names a phase is written at', () => {
  it('is the version each writer chose before the table, for every phase it knew and every word it carries', () => {
    for (const phase of earlierPhases) {
      assert.equal(writtenVersion('phase.started', [phase]), before.phaseStarted(phase), `phase.started ${phase}`);
      assert.equal(writtenVersion('phase.finished', [phase]), before.phaseFinished(phase), `phase.finished ${phase}`);
      for (const moment of worktreeMoments) assert.equal(writtenVersion('worktree.checked', [phase], { moment }), before.worktreeChecked(phase, moment), `worktree.checked ${phase} ${moment}`);
      for (const fault of attemptFaults) assert.equal(writtenVersion('attempt.failed', [phase], { fault }), before.attemptFailed(phase, fault), `attempt.failed ${phase} ${fault}`);
      assert.equal(writtenVersion('worker.lost', [phase]), before.workerLost(phase), `worker.lost ${phase}`);
      assert.equal(writtenVersion('report.written', [phase]), before.reportWritten([phase]), `report.written ${phase}`);
      assert.equal(writtenVersion('tree.revised', [phase]), before.treeRevised(phase), `tree.revised ${phase}`);
      assert.equal(writtenVersion('check.started', [phase]), before.checkStarted(), `check.started ${phase}`);
      assert.equal(writtenVersion('check.ran', [phase]), before.checkRan(), `check.ran ${phase}`);
    }
    for (const phase of editingPhases) {
      assert.equal(writtenVersion('fix.recorded', [phase], { comparisons: false }), before.fixRecorded(phase), `fix.recorded ${phase}`);
      assert.equal(writtenVersion('unit.unattempted', [phase]), before.unitUnattempted(phase), `unit.unattempted ${phase}`);
    }
    assert.equal(writtenVersion('worker.lost', []), before.workerLost(null), 'a lost worker with no unit');
    assert.equal(writtenVersion('report.written', earlierPhases), before.reportWritten(earlierPhases), 'a report with a row for every phase');
    assert.equal(writtenVersion('report.written', earlierPhases.filter((phase) => phase !== 'documentation')), 5, 'a report of a run that skips the documentation step');
    for (const units of subsets(budgetDegradingPhases)) assert.equal(writtenVersion('fix.reopened', units), before.fixReopened(units), `fix.reopened [${units.join(', ')}]`);
  });

  // The versions TD7 of the facts before a merge names: each event that names the phase, and the repair's answer with its comparisons.
  it('names the checks on the base only at the versions that first hold them, and leaves every other kind at its floor', () => {
    assert.equal(writtenVersion('phase.started', ['base-checks']), 7);
    assert.equal(writtenVersion('phase.finished', ['base-checks']), 8);
    for (const moment of worktreeMoments) assert.equal(writtenVersion('worktree.checked', ['base-checks'], { moment }), 8, moment);
    assert.equal(writtenVersion('check.started', ['base-checks']), 2);
    assert.equal(writtenVersion('check.ran', ['base-checks']), 4);
    assert.equal(writtenVersion('report.written', ['base-checks']), 7);
    assert.equal(writtenVersion('report.written', phases), 7, 'a report with a row for every phase, documentation among them');
    assert.equal(writtenVersion('tree.revised', ['base-checks']), 2, 'no run on the base revises the tree, so no version names it');
    assert.equal(writtenVersion('worker.lost', ['base-checks']), 5, 'the phase has no worker');
    assert.equal(writtenVersion('fix.recorded', ['repair'], { comparisons: true }), 4);
    assert.equal(writtenVersion('fix.recorded', ['repair'], { comparisons: false }), 2, 'the repair of a run configured before the phase');
    assert.equal(writtenVersion('fix.recorded', ['documentation'], { comparisons: false }), 3);
    assert.equal(writtenVersion('phase.started', ['checks']), 5, 'the other check phases keep their versions');
    assert.equal(writtenVersion('check.ran', ['checks']), 3);
  });

  it('is a version whose schema holds the phase, for each kind a writer gives every phase', () => {
    const accepts = (kind: string, version: number, payload: unknown): boolean => lookupEvent(eventRegistry, kind, version)?.schema.safeParse(payload).success ?? false;
    for (const phase of phases) {
      assert.ok(accepts('phase.started', writtenVersion('phase.started', [phase]), { phase, attempt: 1 }), `phase.started ${phase}`);
      assert.ok(accepts('phase.finished', writtenVersion('phase.finished', [phase]), { phase, attempt: 1, outcome: 'completed', blocker: null }), `phase.finished ${phase}`);
      for (const moment of worktreeMoments) assert.ok(accepts('worktree.checked', writtenVersion('worktree.checked', [phase], { moment }), { phase, attempt: 1, moment, drifted: false, head: null, files: [], strays: [] }), `worktree.checked ${phase} ${moment}`);
    }
    for (const phase of checkPhases) {
      assert.ok(accepts('check.started', writtenVersion('check.started', [phase]), { phase, attempt: 1, kind: 'test', command: 'npm test' }), `check.started ${phase}`);
      // The writer's own event, whose payload has the `skipReason` of a run on the base only at a version that records it.
      const skipped = checkRanEvent({ phase, attempt: 1, kind: 'test', command: 'npm test', outcome: 'skipped', exitCode: null, signal: null, termination: null, startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:00.000Z', stdout: null, stderr: null, error: 'build failed', replaces: null, skipReason: phase === 'base-checks' ? 'build-failed' : null });
      assert.ok(accepts(skipped.kind, skipped.version, skipped.payload), `check.ran ${phase}`);
    }
  });
});
