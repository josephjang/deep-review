import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TreeRevised } from '../../src/checkpoint/events.ts';
import { cutShortBefore, emptyFixState, failedAtBaseline, isOldRun, lastRecordedRun, lastRun, repairTargets, unitRevisions, type CheckRunState, type FixState } from '../../src/checkpoint/fix-state.ts';
import type { CheckKind, CheckPhase } from '../../src/review/vocabulary.ts';

/** A revision of `src/a.ts` by `source` in `phase`; its message and bytes play no part in whose it is. */
const revision = (phase: TreeRevised['phase'], source: TreeRevised['source']): TreeRevised => ({
  phase,
  source,
  change: { findings: [], message: { subject: 's', body: '' } },
  files: [{ path: 'src/a.ts', status: 'modified', before: null, beforeSymlink: false, symlink: false, after: null }],
});

const worker = '00000000-0000-4000-8000-000000000001';
const fixOf = (revisions: readonly TreeRevised[]): FixState => ({ ...emptyFixState(), revisions });

describe('unitRevisions', () => {
  it('holds a unit\'s fixer and attempt revisions, in ledger order', () => {
    const own = [revision('answer', { kind: 'attempt', key: 'pass-1', workerId: worker }), revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker })];
    assert.deepEqual(unitRevisions(fixOf(own), 'answer', 'pass-1'), own);
  });

  it('leaves out another unit\'s, the same key in another phase, and a check\'s', () => {
    const fix = fixOf([
      revision('answer', { kind: 'fix', key: 'pass-2', workerId: worker }),
      revision('fixes', { kind: 'fix', key: 'pass-1', workerId: worker }),
      revision('answer-checks', { kind: 'check', check: 'lint' }),
    ]);
    assert.deepEqual(unitRevisions(fix, 'answer', 'pass-1'), []);
  });

  it('holds none for a run without revisions', () => {
    assert.deepEqual(unitRevisions(emptyFixState(), 'fixes', 'c1-1'), []);
  });
});

/** A run of `kind` in `phase` at `attempt`, folded with `revisionsBefore` revisions before it. */
const run = (phase: CheckPhase, kind: CheckKind, outcome: CheckRunState['outcome'], attempt: number, revisionsBefore: number): CheckRunState => ({
  phase, attempt, kind, command: `npm run ${kind}`, outcome, exitCode: outcome === 'passed' ? 0 : 1, signal: null, termination: outcome === 'timeout' ? 'killed' : 'exited',
  startedAt: '2026-10-19T00:00:00.000Z', endedAt: '2026-10-19T00:00:01.000Z', stdout: null, stderr: null, error: null, replaces: null, revisionsBefore,
});
const withRuns = (fix: FixState, runs: Partial<Record<CheckPhase, readonly CheckRunState[]>>): FixState => ({ ...fix, checks: { ...fix.checks, runs: { ...fix.checks.runs, ...runs } } });

describe('the last current run of a check (TD3 of resumable runs)', () => {
  const fixes = revision('fixes', { kind: 'fix', key: 'c1-1', workerId: worker });
  const repair = revision('repair', { kind: 'fix', key: 'repair', workerId: worker });
  const answer = revision('answer', { kind: 'fix', key: 'pass-1', workerId: worker });
  const lint = revision('checks', { kind: 'check', check: 'lint' });

  it('keeps a baseline run current after every edit, so the baseline failures stay what the fixers are told', () => {
    const fix = withRuns(fixOf([fixes, repair, answer]), { 'baseline-checks': [run('baseline-checks', 'test', 'failed', 1, 0)] });
    assert.equal(lastRun(fix, 'baseline-checks', 'test')?.outcome, 'failed');
    assert.equal(failedAtBaseline(fix, 'test'), true);
  });

  it('makes a run after the fixes old by a later revision of the fixes or of an answer pass, never of the repair or a check', () => {
    const checks = run('checks', 'test', 'failed', 1, 1);
    for (const [later, old] of [[fixes, true], [answer, true], [repair, false], [lint, false]] as const) {
      const fix = withRuns(fixOf([fixes, later]), { checks: [checks] });
      assert.equal(isOldRun(fix, 'checks', checks), old, later.phase);
      assert.equal(lastRun(fix, 'checks', 'test'), old ? null : checks, later.phase);
      assert.equal(lastRecordedRun(fix, 'checks', 'test'), checks, `${later.phase}: the table still shows it`);
    }
  });

  it('makes a run after the repair old by a later revision of the fixes, the repair or an answer pass, and one after answers by the fixes or the repair', () => {
    for (const [phase, later, old] of [['repair-checks', repair, true], ['repair-checks', answer, true], ['answer-checks', repair, true], ['answer-checks', answer, false], ['answer-checks', fixes, true]] as const) {
      const ran = run(phase, 'build', 'passed', 1, 0);
      assert.equal(isOldRun(fixOf([later]), phase, ran), old, `${phase} after ${later.phase}`);
    }
  });

  it('reads the repair\'s targets from the baseline and the current runs after the fixes, so an answer pass that revised the tree leaves none to repair', () => {
    const runs = { 'baseline-checks': [run('baseline-checks', 'test', 'passed', 1, 0)], checks: [run('checks', 'test', 'failed', 1, 1)] };
    const planned = { checks: [{ kind: 'test' as const, command: 'npm run test', origin: 'setting' as const, layer: 'flag' as const, reason: null, source: null }], manager: null };
    const fix = (revisions: readonly TreeRevised[]): FixState => { const state = withRuns(fixOf(revisions), runs); return { ...state, checks: { ...state.checks, planned } }; };
    assert.deepEqual(repairTargets(fix([fixes])), ['test']);
    assert.deepEqual(repairTargets(fix([fixes, answer])), [], 'the run after the fixes checked a tree the answer pass changed');
  });
});

describe('the check a kill cut short before the current attempt (R7 of resumable runs)', () => {
  const review = (fix: FixState, attempt: number): Parameters<typeof cutShortBefore>[0] => ({ phases: { 'baseline-checks': { status: 'running', attempt } } as never, checks: [], fix });
  const start = (kind: CheckKind, attempt: number, runsBefore: number) => ({ phase: 'baseline-checks' as const, attempt, kind, command: `npm run ${kind}`, runsBefore });

  it('finds a start no run came after, a cut run, or one killed at its timeout, in an earlier attempt, the last of them', () => {
    const fix = emptyFixState();
    const cutStart = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('build', 1, 0), start('lint', 1, 1)] }, runs: { ...fix.checks.runs, 'baseline-checks': [run('baseline-checks', 'build', 'passed', 1, 0)] } } };
    assert.deepEqual(cutShortBefore(review(cutStart, 2), 'baseline-checks'), { kind: 'lint', attempt: 1 });
    const timedOut = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('test', 1, 0)] }, runs: { ...fix.checks.runs, 'baseline-checks': [run('baseline-checks', 'test', 'timeout', 1, 0)] } } };
    assert.deepEqual(cutShortBefore(review(timedOut, 2), 'baseline-checks'), { kind: 'test', attempt: 1 });
    assert.equal(cutShortBefore(review(timedOut, 1), 'baseline-checks'), null, 'the step that ran a check of the current attempt writes it back itself');
    assert.equal(cutShortBefore(review(withRuns(fix, { 'baseline-checks': [run('baseline-checks', 'test', 'failed', 1, 0)] }), 2), 'baseline-checks'), null, 'a failure that exited is no kill');
  });

  it('never finds a run that a kill ended with no start before it, which an engine from before check.started recorded with its writes as a revision', () => {
    const fix = emptyFixState();
    const killed = { ...run('baseline-checks', 'test', 'failed', 1, 0), exitCode: 137 };
    for (const legacy of [run('baseline-checks', 'test', 'timeout', 1, 0), killed]) {
      assert.equal(cutShortBefore(review(withRuns(fix, { 'baseline-checks': [legacy] }), 2), 'baseline-checks'), null, legacy.outcome);
      // A start of the kind in the attempt that came after the run is no start of it.
      const startedAfter = { ...fix, checks: { ...fix.checks, starts: { ...fix.checks.starts, 'baseline-checks': [start('test', 1, 1)] }, runs: { ...fix.checks.runs, 'baseline-checks': [legacy, run('baseline-checks', 'test', 'passed', 1, 0)] } } };
      assert.equal(cutShortBefore(review(startedAfter, 2), 'baseline-checks'), null, `${legacy.outcome}, started after`);
    }
  });
});
