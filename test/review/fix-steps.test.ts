import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextStep, unitsOf, type Live, type Step } from '../../src/review/steps.ts';
import { baselined, checkRun, checksPhase, endCheck, fixAnswer, fixed, fixPlan, fixRevision, launch, mergeRanked, reference, withFixPass, worker } from '../helpers/review-history.ts';

const idle: Live = { running: new Set(), spend: { usd: 0, charged: 0, lost: 0 }, evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}` };
const live = (change: Partial<Live>): Live => ({ ...idle, ...change });

describe('nextStep in the fix pass', () => {
  it('passes over the five skipped phases of a run without the fix pass, and starts the baseline of one with it', () => {
    assert.deepEqual(nextStep(mergeRanked().review(), idle), { kind: 'start-phase', phase: 'report', attempt: 1 });
    assert.deepEqual(nextStep(withFixPass(mergeRanked()).review(), idle), { kind: 'start-phase', phase: 'baseline-checks', attempt: 1 });
  });

  it('runs the available checks one at a time, build first, passing over a kind with no command, then finishes the phase', () => {
    const history = withFixPass(mergeRanked()).start('baseline-checks');
    const step = (): Step => nextStep(history.review(), idle);
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'build', command: 'npm run build', skip: null } });
    history.add('check.ran', checkRun('baseline-checks', 'build'));
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'lint', command: 'npm run lint', skip: null } }, 'typecheck has no command');
    history.add('check.ran', checkRun('baseline-checks', 'lint', 'failed'));
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'test', command: 'npm run test', skip: null } }, 'a failed lint does not stop test');
    history.add('check.ran', checkRun('baseline-checks', 'test'));
    assert.deepEqual(step(), { kind: 'finish-phase', phase: 'baseline-checks', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('skips every later check once build did not pass, saying why', () => {
    for (const [outcome, reason] of [['failed', 'build failed'], ['timeout', 'build timed out'], ['not-started', 'build did not start']] as const) {
      const history = withFixPass(mergeRanked()).start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build', outcome));
      assert.deepEqual(nextStep(history.review(), idle), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'lint', command: 'npm run lint', skip: reason } }, outcome);
    }
  });

  it('runs only the checks a re-entered checks phase has not run', () => {
    const history = withFixPass(mergeRanked())
      .start('baseline-checks')
      .add('check.ran', checkRun('baseline-checks', 'build'))
      .add('phase.started', { phase: 'baseline-checks', attempt: 2 }, 2)
      .add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'start', drifted: false, head: null, files: [], strays: [] }, 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'run-check', phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', command: 'npm run lint', skip: null } });
  });

  it('plans the fixes from the ranked findings, then launches one fixer per cluster, and awaits it', () => {
    const running = baselined().start('fixes');
    assert.deepEqual(nextStep(running.review(), idle), { kind: 'plan-fixes', plan: fixPlan });
    running.add('fixes.planned', fixPlan);
    assert.deepEqual(nextStep(running.review(), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c1', role: 'fixer' }] });
    assert.deepEqual(nextStep(running.review(), live({ running: new Set(['fixes:c1']) })), { kind: 'await' });
  });

  it('checks the whole tree once the last unit of an editing phase settled, then finishes it', () => {
    const answered = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)));
    assert.deepEqual(nextStep(answered.review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    answered.add('worktree.checked', endCheck('fixes'), 2);
    assert.deepEqual(nextStep(answered.review(), idle), { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('blocks an editing phase whose end check found an unaccounted change, naming its expected bytes and the moved head', () => {
    const drifted = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)))
      .add('worktree.checked', { ...endCheck('fixes'), drifted: true, head: { expected: '2'.repeat(40), actual: '3'.repeat(40) }, files: [{ path: 'src/a.ts', outcome: 'modified', expected: { blob: reference('f') } }, { path: 'src/new.ts', outcome: 'restored', expected: null }] }, 2);
    const step = nextStep(drifted.review(), idle);
    assert.equal(step.kind, 'finish-phase');
    const detail = step.kind === 'finish-phase' ? step.blocker?.detail : undefined;
    assert.equal(detail, `the worktree differs from what the run expects: HEAD is ${'3'.repeat(40)}, the run expects ${'2'.repeat(40)}, src/a.ts (modified; expected at /evidence/ffffffff), src/new.ts (restored; expected absent)`);
  });

  it('degrades a cluster whose fixer failed twice, finishing the phase degraded once its end check is made', () => {
    const failing = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('attempt.failed', { phase: 'fixes', key: 'c1', workerId: worker(50), reason: 'failed' }, 2)
      .add('attempt.failed', { phase: 'fixes', key: 'c1', workerId: worker(51), reason: 'failed again' }, 2);
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'degrade', phase: 'fixes', degradations: [{ kind: 'cluster.failed', phase: 'fixes', key: 'c1', reason: '2 attempts did not complete: failed; failed again' }] });
    failing.add('cluster.failed', { phase: 'fixes', key: 'c1', reason: '2 attempts did not complete' });
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    failing.add('worktree.checked', endCheck('fixes'), 2);
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('blocks a fix phase whose unit lost a worker among its failures, as every phase does', () => {
    const lost = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('attempt.failed', { phase: 'fixes', key: 'c1', workerId: worker(50), reason: 'failed' }, 2)
      .add('worker.launched', launch(worker(51), 'fixer fixes:c1'))
      .add('worker.lost', { workerId: worker(51), phase: 'fixes', key: 'c1', reason: 'the engine exited while the worker ran' }, 2);
    const step = nextStep(lost.review(), idle);
    assert.equal(step.kind === 'finish-phase' ? step.blocker?.code : step.kind, 'worker-failed');
  });

  it('runs the checks after the fixes only when they changed the tree, and the repair only for a check they broke', () => {
    const unchanged = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1').add('fix.recorded', fixAnswer(worker(50))).add('worktree.checked', endCheck('fixes'), 2).finish('fixes').start('checks');
    assert.deepEqual(nextStep(unchanged.review(), idle), { kind: 'finish-phase', phase: 'checks', attempt: 1, outcome: 'completed', blocker: null }, 'no revision, nothing to check');
    assert.deepEqual(unitsOf(checksPhase(fixed(), 'checks').review(), 'repair'), [], 'every check passed after the fixes');
    assert.deepEqual(unitsOf(checksPhase(fixed({ test: 'failed' }), 'checks', { test: 'failed' }).review(), 'repair'), [], 'test failed before the fixes too');
    assert.deepEqual(unitsOf(checksPhase(fixed(), 'checks', { test: 'failed' }).review(), 'repair'), [{ phase: 'repair', key: 'repair', role: 'fixer' }]);
    // The repair checks run only when the repair phase had a unit.
    const noRepair = checksPhase(fixed(), 'checks').start('repair').finish('repair').start('repair-checks');
    assert.deepEqual(nextStep(noRepair.review(), idle), { kind: 'finish-phase', phase: 'repair-checks', attempt: 1, outcome: 'completed', blocker: null });
  });
});
