import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { noCheckFlags } from '../../src/review/checks/discover.ts';
import { fixPlanOf, nextStep, unitsOf, type Live, type Step } from '../../src/review/steps.ts';
import { askDecision, baselined, checkRun, checksPhase, configured, decidedOf, decisions, endCheck, fixAnswer, fixed, fixPlan, fixRevision, launch, mergeRanked, noSecondRound, reference, withFixPass, worker } from '../helpers/review-history.ts';

const idle: Live = { running: new Set(), spend: { usd: 0, charged: 0, lost: 0 }, evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}`, checkFlags: noCheckFlags };
const live = (change: Partial<Live>): Live => ({ ...idle, ...change });

describe('nextStep in the fix pass', () => {
  it('passes over the five skipped phases of a run without the fix pass, and starts the baseline of one with it', () => {
    assert.deepEqual(nextStep(mergeRanked().review(), idle), { kind: 'start-phase', phase: 'report', attempt: 1 });
    assert.deepEqual(nextStep(withFixPass(mergeRanked()).review(), idle), { kind: 'start-phase', phase: 'baseline-checks', attempt: 1 });
  });

  it('passes over the skipped decision of a run configured before the decision step, and decides a later run\'s findings before its report or its baseline, fix or not (R1 of the decision step)', () => {
    for (const fix of [false, true]) {
      const ranked = (): ReturnType<typeof mergeRanked> => (fix ? withFixPass(mergeRanked()) : mergeRanked());
      assert.deepEqual(nextStep(decidedOf(ranked(), null).review(), idle), { kind: 'start-phase', phase: 'decision', attempt: 1 }, `fix ${String(fix)}`);
      assert.deepEqual(nextStep(decidedOf(ranked()).review(), idle), { kind: 'start-phase', phase: fix ? 'baseline-checks' : 'report', attempt: 1 }, `fix ${String(fix)}, decided`);
    }
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

  it('plans the fixes from the ranked findings and their decisions, then launches one fixer per cluster, and awaits it', () => {
    const running = checksPhase(decidedOf(withFixPass(mergeRanked())), 'baseline-checks').start('fixes');
    assert.deepEqual(nextStep(running.review(), idle), { kind: 'plan-fixes', plan: fixPlan }, 'RIPPLE-1 decided fix, SWEEP-1 left');
    running.add('fixes.planned', fixPlan);
    assert.deepEqual(nextStep(running.review(), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c1-1', role: 'fixer' }] });
    assert.deepEqual(nextStep(running.review(), live({ running: new Set(['fixes:c1-1']) })), { kind: 'await' });
  });

  it('plans a fixer for an ask whose default edits, and an empty plan for a run that ranked nothing', () => {
    const asked = checksPhase(decidedOf(withFixPass(mergeRanked()), [decisions[0], askDecision('SWEEP-1', true)]), 'baseline-checks').start('fixes');
    const step = nextStep(asked.review(), idle);
    assert.equal(step.kind, 'plan-fixes');
    assert.deepEqual(step.kind === 'plan-fixes' ? step.plan.routes : null, [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }]);
    // A run whose ranking holds no finding launches no decider and records no decision: its plan is empty.
    assert.deepEqual(fixPlanOf({ ...decidedOf(withFixPass(mergeRanked()), null).review(), ranking: [] }), { routes: [], clusters: [], batches: [] });
  });

  it('cannot plan the fixes of a run configured before the decision step, which has no decision to route by and is refused before it resumes', () => {
    assert.throws(() => nextStep(baselined().start('fixes').review(), idle), /A fix plan routes each finding by its decision, and the run recorded none/);
  });

  it('launches a cluster\'s batches one after another, the next once the one before is answered or not attempted', () => {
    // Batches of one: RIPPLE-1 and SWEEP-1 share src/a.ts, so c1 runs as c1-1 then c1-2.
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c1-2', cluster: 'c1', findingIds: ['SWEEP-1'] }],
    };
    const fixes = (): ReturnType<typeof baselined> => checksPhase(withFixPass(mergeRanked(), 1), 'baseline-checks').start('fixes').add('fixes.planned', plan);
    const first: Step = { kind: 'launch', units: [{ phase: 'fixes', key: 'c1-1', role: 'fixer' }] };
    const second: Step = { kind: 'launch', units: [{ phase: 'fixes', key: 'c1-2', role: 'fixer' }] };
    assert.deepEqual(unitsOf(fixes().review(), 'fixes').map((unit) => unit.key), ['c1-1', 'c1-2']);
    assert.deepEqual(nextStep(fixes().review(), idle), first, 'c1-2 waits for c1-1 though capacity is left');
    assert.deepEqual(nextStep(fixes().review(), live({ running: new Set(['fixes:c1-1']) })), { kind: 'await' });
    const once = fixes().worker(50, 'fixer fixes:c1-1').add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(50), reason: 'failed' }, 2);
    assert.deepEqual(nextStep(once.review(), idle), first, 'a batch that failed once is retried before its cluster moves on');
    const answered = fixes().worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50)));
    assert.deepEqual(nextStep(answered.review(), idle), second);
    const failed = fixes().add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: '2 attempts did not complete' });
    assert.deepEqual(nextStep(failed.review(), idle), second, 'a batch not attempted settles, and its cluster goes on');
  });

  it('stops an editing phase\'s launches at the run budget: every unit not settled and not running is not attempted, with the budget as the cause (R19)', () => {
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
    };
    const fixes = baselined().start('fixes').add('fixes.planned', plan);
    const spent = live({ spend: { usd: 30.5, charged: 0, lost: 0 } });
    const reason = 'spent 30.50 USD of the 30.00 USD run budget';
    assert.deepEqual(nextStep(fixes.review(), spent), { kind: 'degrade', phase: 'fixes', degradations: [
      { kind: 'unit.unattempted', phase: 'fixes', key: 'c1-1', cause: 'budget', reason },
      { kind: 'unit.unattempted', phase: 'fixes', key: 'c2-1', cause: 'budget', reason },
    ] });
    // A batch already running finishes; only the one with no worker is given up.
    assert.deepEqual(nextStep(fixes.review(), { ...spent, running: new Set(['fixes:c1-1']) }), { kind: 'degrade', phase: 'fixes', degradations: [{ kind: 'unit.unattempted', phase: 'fixes', key: 'c2-1', cause: 'budget', reason }] });
    // Once every unit settled, the phase is checked and finishes degraded, and the run goes on.
    fixes.worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('unit.unattempted', { phase: 'fixes', key: 'c2-1', cause: 'budget', reason });
    assert.deepEqual(nextStep(fixes.review(), spent), { kind: 'plan-second-round', plan: noSecondRound });
    fixes.add('fixes.replanned', noSecondRound);
    assert.deepEqual(nextStep(fixes.review(), spent), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    fixes.add('worktree.checked', endCheck('fixes'), 2);
    assert.deepEqual(nextStep(fixes.review(), spent), { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('gives up a batch that failed once, and one waiting for its cluster, at the budget, and still blocks a reading phase there', () => {
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1', 'SWEEP-1'], files: ['src/a.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c1-2', cluster: 'c1', findingIds: ['SWEEP-1'] }],
    };
    const once = checksPhase(withFixPass(mergeRanked(), 1), 'baseline-checks').start('fixes').add('fixes.planned', plan).worker(50, 'fixer fixes:c1-1').add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(50), reason: 'timeout' }, 2);
    const spent = live({ spend: { usd: 31, charged: 0, lost: 0 } });
    const step = nextStep(once.review(), spent);
    assert.ok(step.kind === 'degrade', JSON.stringify(step));
    assert.deepEqual(step.degradations.map((degradation) => [degradation.kind === 'unit.unattempted' ? degradation.key : null, degradation.kind === 'unit.unattempted' ? degradation.cause : null]), [['c1-1', 'budget'], ['c1-2', 'budget']]);
    // A reading phase blocks at the budget as before.
    const reading = withFixPass(configured()).start('triage');
    assert.equal(nextStep(reading.review(), spent).kind, 'finish-phase');
    assert.equal((nextStep(reading.review(), spent) as { blocker: { code: string } }).blocker.code, 'budget');
  });

  it('gives the repair up at the budget too', () => {
    const repair = checksPhase(fixed(), 'checks', { test: 'failed' }).start('repair');
    const step = nextStep(repair.review(), live({ spend: { usd: 30, charged: 0, lost: 0 } }));
    assert.deepEqual(step, { kind: 'degrade', phase: 'repair', degradations: [{ kind: 'unit.unattempted', phase: 'repair', key: 'repair', cause: 'budget', reason: 'spent 30.00 USD of the 30.00 USD run budget' }] });
  });

  it('plans the second round once the first settled, launches its batch, and plans no third round for a finding blocked again (R21)', () => {
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
    };
    const blocked = (key: string, workerId: string): Record<string, unknown> => fixAnswer(workerId, { key, findings: [{ id: 'RIPPLE-1', status: 'blocked', file: 'src/a.ts', line: 1, note: 'needs src/b.ts', message: null, files: [], corrections: [], validation: [], requiredFiles: ['src/b.ts'] }] });
    const fixes = baselined().start('fixes').add('fixes.planned', plan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', blocked('c1-1', worker(50)));
    assert.deepEqual(nextStep(fixes.review(), live({ running: new Set(['fixes:c2-1']) })), { kind: 'await' }, 'not while a first-round batch runs');
    fixes.worker(51, 'fixer fixes:c2-1').add('fix.recorded', fixAnswer(worker(51), { key: 'c2-1', findings: [{ id: 'SWEEP-1', status: 'applied', file: 'src/b.ts', line: 1, note: 'n', message: { subject: 'fix: b', body: '' }, files: ['src/b.ts'], corrections: [], validation: [], requiredFiles: [] }] }));
    const second = { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/b.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/a.ts', 'src/b.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] };
    assert.deepEqual(nextStep(fixes.review(), idle), { kind: 'plan-second-round', plan: second });
    fixes.add('fixes.replanned', second);
    assert.deepEqual(unitsOf(fixes.review(), 'fixes').map((unit) => unit.key), ['c1-1', 'c2-1', 'c3-1']);
    assert.deepEqual(nextStep(fixes.review(), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c3-1', role: 'fixer' }] });
    fixes.worker(52, 'fixer fixes:c3-1').add('fix.recorded', blocked('c3-1', worker(52)));
    assert.deepEqual(nextStep(fixes.review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' }, 'blocked again, it stays blocked');
  });

  it('launches the batches of different clusters together, in the order the plan ranks them', () => {
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
    };
    const fixes = baselined().start('fixes').add('fixes.planned', plan);
    assert.deepEqual(nextStep(fixes.review(), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c1-1', role: 'fixer' }, { phase: 'fixes', key: 'c2-1', role: 'fixer' }] });
    assert.deepEqual(nextStep(fixes.review(), live({ running: new Set(['fixes:x', 'fixes:y', 'fixes:z']) })), { kind: 'launch', units: [{ phase: 'fixes', key: 'c1-1', role: 'fixer' }] }, 'with one slot left, the best-ranked batch takes it');
  });

  it('checks the whole tree once the last unit of an editing phase settled, then finishes it', () => {
    const answered = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)));
    assert.deepEqual(nextStep(answered.review(), idle), { kind: 'plan-second-round', plan: noSecondRound }, 'no finding was blocked, and the empty round is still recorded');
    answered.add('fixes.replanned', noSecondRound);
    assert.deepEqual(nextStep(answered.review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    answered.add('worktree.checked', endCheck('fixes'), 2);
    assert.deepEqual(nextStep(answered.review(), idle), { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('blocks an editing phase whose end check found an unaccounted change, naming its expected bytes and the moved head', () => {
    const drifted = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('tree.revised', fixRevision(worker(50)))
      .add('worktree.checked', { ...endCheck('fixes'), drifted: true, head: { expected: '2'.repeat(40), actual: '3'.repeat(40) }, files: [{ path: 'src/a.ts', outcome: 'modified', expected: { blob: reference('f') } }, { path: 'src/new.ts', outcome: 'restored', expected: null }] }, 2);
    const step = nextStep(drifted.review(), idle);
    assert.equal(step.kind, 'finish-phase');
    const detail = step.kind === 'finish-phase' ? step.blocker?.detail : undefined;
    assert.equal(detail, `the worktree differs from what the run expects: HEAD is ${'3'.repeat(40)}, the run expects ${'2'.repeat(40)}, src/a.ts (modified; expected at /evidence/ffffffff), src/new.ts (restored; expected absent)`);
  });

  it('degrades a cluster whose fixer failed twice, finishing the phase degraded once its end check is made', () => {
    const failing = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(50), reason: 'failed' }, 2)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(51), reason: 'failed again' }, 2);
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'degrade', phase: 'fixes', degradations: [{ kind: 'unit.unattempted', phase: 'fixes', key: 'c1-1', cause: 'failures', reason: '2 attempts did not complete: failed; failed again' }] });
    failing.add('unit.unattempted', { phase: 'fixes', key: 'c1-1', cause: 'failures', reason: '2 attempts did not complete' });
    failing.add('fixes.replanned', noSecondRound);
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    failing.add('worktree.checked', endCheck('fixes'), 2);
    assert.deepEqual(nextStep(failing.review(), idle), { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('blocks a fix phase whose unit lost a worker among its failures, as every phase does', () => {
    const lost = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(50), reason: 'failed' }, 2)
      .add('worker.launched', launch(worker(51), 'fixer fixes:c1-1'))
      .add('worker.lost', { workerId: worker(51), phase: 'fixes', key: 'c1-1', reason: 'the engine exited while the worker ran' }, 2);
    const step = nextStep(lost.review(), idle);
    assert.equal(step.kind === 'finish-phase' ? step.blocker?.code : step.kind, 'worker-failed');
  });

  it('runs the checks after the fixes only when they changed the tree, and the repair only for a check failing after them', () => {
    const unchanged = baselined().start('fixes').add('fixes.planned', fixPlan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('worktree.checked', endCheck('fixes'), 2).finish('fixes').start('checks');
    assert.deepEqual(nextStep(unchanged.review(), idle), { kind: 'finish-phase', phase: 'checks', attempt: 1, outcome: 'completed', blocker: null }, 'no revision, nothing to check');
    const repairUnit = [{ phase: 'repair', key: 'repair', role: 'fixer' }];
    assert.deepEqual(unitsOf(checksPhase(fixed(), 'checks').review(), 'repair'), [], 'every check passed after the fixes');
    assert.deepEqual(unitsOf(checksPhase(fixed(), 'checks', { test: 'failed' }).review(), 'repair'), repairUnit, 'the fixes broke test');
    assert.deepEqual(unitsOf(checksPhase(fixed({ test: 'failed' }), 'checks', { test: 'failed' }).review(), 'repair'), repairUnit, 'test failed before the fixes too, and is read for new failures (R24)');
    assert.deepEqual(unitsOf(checksPhase(fixed({ test: 'failed' }), 'checks').review(), 'repair'), [], 'test failed before the fixes and passes after');
    // The repair checks run only when the repair phase had a unit.
    const noRepair = checksPhase(fixed(), 'checks').start('repair').finish('repair').start('repair-checks');
    assert.deepEqual(nextStep(noRepair.review(), idle), { kind: 'finish-phase', phase: 'repair-checks', attempt: 1, outcome: 'completed', blocker: null });
  });
});
