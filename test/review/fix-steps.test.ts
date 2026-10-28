import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReviewState } from '../../src/checkpoint/review-fold.ts';
import { noCheckSettings } from '../../src/review/checks/discover.ts';
import { driftBlocker, dueCheck, fixPlanOf, nextStep, unitsOf, type CheckSkip, type Live, type Step } from '../../src/review/steps.ts';
import { baseSkipReasons } from '../../src/review/vocabulary.ts';
import { answer, answerableDecisions, askDecision, baseSkip, decidedFixRun, flagPlan, passAnswer, passRevision, passToReport, pin, readOnlyReported, type History, baselined, checkRun, checkedForBase, checksPhase, configured, decidedOf, decisions, endCheck, fixAnswer, fixed, fixPlan, fixRevision, launch, mergeRanked, noSecondRound, ranOnBase, reference, withFixPass, worker } from '../helpers/review-history.ts';

const idle: Live = { running: new Set(), spend: { usd: 0, charged: 0, lost: 0 }, evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}`, checkSettings: noCheckSettings, claimsLost: null };
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
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'build', command: 'npm run build', skip: null, replaces: null } });
    history.add('check.ran', checkRun('baseline-checks', 'build'));
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'lint', command: 'npm run lint', skip: null, replaces: null } }, 'typecheck has no command');
    history.add('check.ran', checkRun('baseline-checks', 'lint', 'failed'));
    assert.deepEqual(step(), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'test', command: 'npm run test', skip: null, replaces: null } }, 'a failed lint does not stop test');
    history.add('check.ran', checkRun('baseline-checks', 'test'));
    assert.deepEqual(step(), { kind: 'finish-phase', phase: 'baseline-checks', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('skips every later check once build did not pass, saying why, a build that timed out once running again first (R7 of resumable runs)', () => {
    for (const [outcome, reason] of [['failed', 'build failed'], ['timeout', 'build timed out'], ['not-started', 'build did not start']] as const) {
      const history = withFixPass(mergeRanked()).start('baseline-checks').add('check.ran', checkRun('baseline-checks', 'build', outcome));
      if (outcome === 'timeout') {
        const again = nextStep(history.review(), idle);
        assert.ok(again.kind === 'run-check' && again.check.kind === 'build' && again.check.replaces?.why === 'timeout', JSON.stringify(again));
        history.add('check.started', { phase: 'baseline-checks', attempt: 1, kind: 'build', command: 'npm run build' }).add('check.ran', { ...checkRun('baseline-checks', 'build', outcome), replaces: { attempt: 1, outcome } }, 3);
      }
      assert.deepEqual(nextStep(history.review(), idle), { kind: 'run-check', phase: 'baseline-checks', attempt: 1, check: { kind: 'lint', command: 'npm run lint', skip: { reason: null, error: reason }, replaces: null } }, outcome);
    }
  });

  it('runs only the checks a re-entered checks phase has not run', () => {
    const history = withFixPass(mergeRanked())
      .start('baseline-checks')
      .add('check.ran', checkRun('baseline-checks', 'build'))
      .add('phase.started', { phase: 'baseline-checks', attempt: 2 }, 2)
      .add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'start', drifted: false, head: null, files: [], strays: [] }, 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'run-check', phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', command: 'npm run lint', skip: null, replaces: null } });
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
    // Once every unit settled, the phase is checked and finishes degraded, and the run goes on; with a first-round batch left for the budget, no second round is planned (PD13 of resumable runs).
    fixes.worker(50, 'fixer fixes:c1-1').add('fix.recorded', fixAnswer(worker(50))).add('unit.unattempted', { phase: 'fixes', key: 'c2-1', cause: 'budget', reason });
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

  // PD13 of resumable runs: the second round is planned from the answers of the whole first round, which a reopened fix pass finishes first.
  describe('with a first-round batch the run budget left', () => {
    const plan = {
      routes: [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }],
      clusters: [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['src/a.ts'] }, { id: 'c2', findingIds: ['SWEEP-1'], files: ['src/b.ts'] }],
      batches: [{ key: 'c1-1', cluster: 'c1', findingIds: ['RIPPLE-1'] }, { key: 'c2-1', cluster: 'c2', findingIds: ['SWEEP-1'] }],
    };
    const blocked = (workerId: string): Record<string, unknown> => fixAnswer(workerId, { key: 'c1-1', findings: [{ id: 'RIPPLE-1', status: 'blocked', file: 'src/a.ts', line: 1, note: 'needs src/b.ts', message: null, files: [], corrections: [], validation: [], requiredFiles: ['src/b.ts'] }] });
    const second = { blocked: [{ id: 'RIPPLE-1', requiredFiles: ['src/b.ts'] }], clusters: [{ id: 'c3', findingIds: ['RIPPLE-1'], files: ['src/a.ts', 'src/b.ts'] }], batches: [{ key: 'c3-1', cluster: 'c3', findingIds: ['RIPPLE-1'] }] };
    const stopped = (): History => baselined().start('fixes').add('fixes.planned', plan).worker(50, 'fixer fixes:c1-1').add('fix.recorded', blocked(worker(50))).add('unit.unattempted', { phase: 'fixes', key: 'c2-1', cause: 'budget', reason: 'spent 30.50 USD of the 30.00 USD run budget' });
    /** The review as a reopened fix pass leaves it: the batch the budget left no longer not attempted. */
    const reopened = (review: ReviewState): ReviewState => ({ ...review, fix: { ...review.fix!, notAttempted: { ...review.fix!.notAttempted, fixes: {} } } });

    it('plans no second round, so the phase finishes without one', () => {
      assert.deepEqual(nextStep(stopped().review(), idle), { kind: 'check-worktree', phase: 'fixes', attempt: 1, moment: 'end' });
    });

    it('launches the batch first once reopened, then plans the second round from the whole first round', () => {
      assert.deepEqual(nextStep(reopened(stopped().review()), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c2-1', role: 'fixer' }] });
    });

    it('launches no second-round batch an older engine planned while the reopened first-round batch has not settled, across clusters', () => {
      const planned = stopped().add('fixes.replanned', second);
      assert.deepEqual(nextStep(planned.review(), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c3-1', role: 'fixer' }] }, 'the batch the budget left is settled until the reopen');
      assert.deepEqual(nextStep(reopened(planned.review()), idle), { kind: 'launch', units: [{ phase: 'fixes', key: 'c2-1', role: 'fixer' }] });
      assert.deepEqual(nextStep(reopened(planned.review()), live({ running: new Set(['fixes:c2-1']) })), { kind: 'await' });
    });
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

  it('stops the fixes phase once its claims directory is lost: awaits the units in flight, launches nothing more, then blocks with claims-lost (R12 of commit series integrity)', () => {
    const running = baselined().start('fixes').add('fixes.planned', fixPlan);
    const lost = '/scratch/claims/run/round-1';
    assert.deepEqual(nextStep(running.review(), live({ claimsLost: lost, running: new Set(['fixes:c1-1']) })), { kind: 'await' });
    const step = nextStep(running.review(), live({ claimsLost: lost }));
    assert.deepEqual(step, { kind: 'finish-phase', phase: 'fixes', attempt: 1, outcome: 'blocked', blocker: { code: 'claims-lost', detail: `the claims directory ${lost} was removed while the run was editing`, action: 'run the command again, which seeds the claims directory from the ledger and gives the units that ran without it fresh attempts, or abandon the run' } });
    assert.equal(nextStep(running.review(), idle).kind, 'launch', 'nothing is lost without the directory gone');
  });

  it('blocks rather than degrades a batch an environment failure is among the two failures of, which the next run gives fresh attempts (R12 of commit series integrity)', () => {
    const failing = baselined().start('fixes').add('fixes.planned', fixPlan)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(50), reason: 'failed', fault: 'unit' }, 5)
      .add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(51), reason: 'the claims directory was removed while the unit ran', fault: 'environment' }, 5);
    const step = nextStep(failing.review(), idle);
    assert.equal(step.kind === 'finish-phase' ? step.blocker?.code : step.kind, 'worker-failed');
    assert.match(step.kind === 'finish-phase' ? step.blocker!.detail : '', /failed twice, an attempt whose claims directory was removed among the failures: /);
    const once = baselined().start('fixes').add('fixes.planned', fixPlan).add('attempt.failed', { phase: 'fixes', key: 'c1-1', workerId: worker(51), reason: 'gone', fault: 'environment' }, 5);
    assert.equal(nextStep(once.review(), idle).kind, 'launch', 'one environment failure leaves the batch its second attempt');
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

describe('nextStep in an answer pass (R5 of answers)', () => {
  /** The decided fix run answered on both findings and its pass opened. */
  const opened = (): History => decidedFixRun().add('answer.recorded', answer('RIPPLE-1', 'reject')).add('answer.recorded', answer('SWEEP-1', 1)).add('answer.pass', { ids: ['RIPPLE-1', 'SWEEP-1'] });

  it('starts the answer phase, gives it one fixer for the pass, and launches it', () => {
    const history = opened();
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'start-phase', phase: 'answer', attempt: 1 });
    history.start('answer');
    assert.deepEqual(unitsOf(history.review(), 'answer'), [{ phase: 'answer', key: 'pass-1', role: 'fixer' }]);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'launch', units: [{ phase: 'answer', key: 'pass-1', role: 'fixer' }] });
    assert.deepEqual(unitsOf(decidedFixRun().review(), 'answer'), [], 'no pass, no unit');
  });

  it('blocks the pass at the run budget before its launch, never settling it as not attempted (TD8)', () => {
    const history = opened().start('answer');
    const spent = live({ spend: { usd: 31, charged: 0, lost: 0 } });
    const step = nextStep(history.review(), spent);
    assert.equal(step.kind, 'finish-phase');
    assert.equal((step as { blocker: { code: string } }).blocker.code, 'budget');
  });

  it('blocks with worker-failed when the pass\'s fixer fails twice, and degrades nothing', () => {
    const history = opened().start('answer')
      .add('attempt.failed', { phase: 'answer', key: 'pass-1', workerId: worker(71), reason: 'failed', fault: 'unit' }, 6)
      .add('attempt.failed', { phase: 'answer', key: 'pass-1', workerId: worker(72), reason: 'failed again', fault: 'unit' }, 6);
    const step = nextStep(history.review(), idle);
    assert.equal(step.kind, 'finish-phase');
    assert.equal((step as { blocker: { code: string; detail: string } }).blocker.code, 'worker-failed');
    assert.match((step as { blocker: { detail: string } }).blocker.detail, /^the fixer worker for answer:pass-1 failed twice: /);
  });

  it('checks the tree at the answer phase\'s end once its fixer answered, then finishes it', () => {
    const history = opened().start('answer').worker(71, 'fixer answer:pass-1').add('fix.recorded', passAnswer(worker(71), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']]), 2).add('tree.revised', passRevision(worker(71), 1, 'RIPPLE-1'), 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'check-worktree', phase: 'answer', attempt: 1, moment: 'end' });
    history.add('worktree.checked', endCheck('answer'), 5);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'finish-phase', phase: 'answer', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('runs every check again after a pass that revised the tree, at each pass, and none after a pass that did not', () => {
    const revised = opened().start('answer').worker(71, 'fixer answer:pass-1').add('fix.recorded', passAnswer(worker(71), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']]), 2).add('tree.revised', passRevision(worker(71), 1, 'RIPPLE-1'), 2).add('worktree.checked', endCheck('answer'), 5).finish('answer').start('answer-checks');
    assert.deepEqual(dueCheck(revised.review(), 'answer-checks'), { kind: 'build', command: 'npm run build', skip: null, replaces: null });
    const unrevised = opened().start('answer').worker(71, 'fixer answer:pass-1').add('fix.recorded', passAnswer(worker(71), 1, [['RIPPLE-1', 'deferred'], ['SWEEP-1', 'deferred']]), 2).add('worktree.checked', endCheck('answer'), 5).finish('answer').start('answer-checks');
    assert.equal(dueCheck(unrevised.review(), 'answer-checks'), null);
    assert.deepEqual(nextStep(unrevised.review(), idle), { kind: 'finish-phase', phase: 'answer-checks', attempt: 1, outcome: 'completed', blocker: null });
    // The second pass runs them again, whatever the first ran.
    const first = passToReport(opened(), 1, [['RIPPLE-1', 'applied'], ['SWEEP-1', 'deferred']], 2);
    const second = first.add('answer.pass', { ids: ['SWEEP-1'] }).start('answer', 2).worker(72, 'fixer answer:pass-2').add('fix.recorded', passAnswer(worker(72), 2, [['SWEEP-1', 'applied']]), 2).add('tree.revised', passRevision(worker(72), 2, 'SWEEP-1'), 2).add('worktree.checked', endCheck('answer', 2), 5).finish('answer', 'completed', 2).start('answer-checks', 2);
    assert.deepEqual(dueCheck(second.review(), 'answer-checks'), { kind: 'build', command: 'npm run build', skip: null, replaces: null });
    second.add('check.ran', checkRun('answer-checks', 'build', 'passed', 2), 2);
    assert.deepEqual(dueCheck(second.review(), 'answer-checks'), { kind: 'lint', command: 'npm run lint', skip: null, replaces: null }, 'counted within the second pass');
  });

  it('plans a continued run\'s answered finding to a fixer, which its decision held', () => {
    const continued = checksPhase(readOnlyReported(answerableDecisions()).add('answer.recorded', answer('SWEEP-1', 1)).add('fix.pinned', pin(flagPlan)), 'baseline-checks').start('fixes');
    const plan = fixPlanOf(continued.review());
    assert.deepEqual(plan.routes, [{ id: 'RIPPLE-1', route: 'fixer' }, { id: 'SWEEP-1', route: 'fixer' }]);
    assert.deepEqual(plan.batches.map((entry) => entry.findingIds), [['RIPPLE-1'], ['SWEEP-1']]);
    assert.doesNotThrow(() => continued.add('fixes.planned', plan).fold(), 'the fold holds the plan to the same rule');
  });
});

describe('nextStep in the checks after a stop (R3, R7, TD11 of resumable runs)', () => {
  const commandOf = (kind: string): string => ({ build: 'npm run build', lint: 'npm run lint', test: 'npm run test' })[kind] ?? 'none';
  /** A check that ran at version 3: its start, then its run, which replaces `replaces`. */
  const ranV3 = (history: History, phase: string, kind: string, outcome: string, attempt: number, replaces: Record<string, unknown> | null = null): History =>
    history.add('check.started', { phase, attempt, kind, command: commandOf(kind) }).add('check.ran', { ...checkRun(phase, kind, outcome, attempt), replaces }, 3);
  const restart = (history: History, phase: string, attempt: number, files: readonly Record<string, unknown>[] = [], head: Record<string, unknown> | null = null): History =>
    history.add('phase.started', { phase, attempt }, 5).add('worktree.checked', { phase, attempt, moment: 'start', drifted: files.length > 0 || head !== null, head, files, strays: [] }, 5);
  const inBaseline = (): History => withFixPass(mergeRanked()).start('baseline-checks');
  const runCheck = (step: Step): { kind: string; replaces: string | null; skip: string | null } | null =>
    step.kind === 'run-check' ? { kind: step.check.kind, replaces: step.check.replaces === null ? null : `${step.check.replaces.why} ${step.check.replaces.run.outcome}@${String(step.check.replaces.run.attempt)}`, skip: step.check.skip?.error ?? null } : null;

  it('runs again, in the order of the kinds, each kind whose last run did not pass in a cut attempt, and not one that passed (R3)', () => {
    for (const outcome of ['failed', 'timeout', 'not-started', 'skipped'] as const) {
      // Attempt 1 ran build and lint and was cut before test and before its phase.finished; build passed.
      const history = ranV3(inBaseline(), 'baseline-checks', 'build', 'passed', 1);
      if (outcome === 'skipped') history.add('check.ran', { ...checkRun('baseline-checks', 'lint', 'skipped'), replaces: null }, 3);
      else ranV3(history, 'baseline-checks', 'lint', outcome, 1);
      restart(history, 'baseline-checks', 2);
      assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: `cut-attempt ${outcome}@1`, skip: null }, outcome);
      ranV3(history, 'baseline-checks', 'lint', 'passed', 2, { attempt: 1, outcome });
      assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'test', replaces: null, skip: null }, `${outcome}: test has no run yet`);
    }
  });

  it('runs a build again first when it did not pass in a cut attempt, and the kinds after it read its new outcome', () => {
    const history = ranV3(inBaseline(), 'baseline-checks', 'build', 'failed', 1).add('check.ran', { ...checkRun('baseline-checks', 'lint', 'skipped'), replaces: null }, 3);
    restart(history, 'baseline-checks', 2);
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'build', replaces: 'cut-attempt failed@1', skip: null });
    ranV3(history, 'baseline-checks', 'build', 'passed', 2, { attempt: 1, outcome: 'failed' });
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: 'cut-attempt skipped@1', skip: null }, 'lint runs now that build passed');
  });

  it('runs nothing again from an attempt that finished, nor a failure of the current attempt', () => {
    const finished = ranV3(inBaseline(), 'baseline-checks', 'lint', 'failed', 1).add('phase.finished', { phase: 'baseline-checks', attempt: 1, outcome: 'blocked', blocker: { code: 'drift', detail: 'd', action: 'a' } }, 6);
    restart(finished, 'baseline-checks', 2);
    assert.deepEqual(runCheck(nextStep(finished.review(), idle)), { kind: 'build', replaces: null, skip: null }, 'lint failed in an attempt that finished, which stays its result');
    const current = ranV3(inBaseline(), 'baseline-checks', 'build', 'passed', 1);
    ranV3(current, 'baseline-checks', 'lint', 'failed', 1);
    assert.deepEqual(runCheck(nextStep(current.review(), idle)), { kind: 'test', replaces: null, skip: null }, 'a failure of the current attempt is its result');
  });

  it('runs a check that timed out once again in its attempt, and takes a second timeout as its result (R7)', () => {
    const history = ranV3(inBaseline(), 'baseline-checks', 'build', 'passed', 1);
    ranV3(history, 'baseline-checks', 'lint', 'timeout', 1);
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: 'timeout timeout@1', skip: null });
    ranV3(history, 'baseline-checks', 'lint', 'timeout', 1, { attempt: 1, outcome: 'timeout' });
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'test', replaces: null, skip: null });
  });

  const drifted = { path: 'src/a.ts', outcome: 'modified', expected: { blob: reference('a') } };

  it('writes back a drift at the start that a check a kill cut short in an earlier attempt explains, instead of blocking (R7, TD7)', () => {
    const cut = inBaseline().add('check.started', { phase: 'baseline-checks', attempt: 1, kind: 'lint', command: 'npm run lint' });
    restart(cut, 'baseline-checks', 2, [drifted]);
    assert.deepEqual(nextStep(cut.review(), idle), { kind: 'restore-tree', phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [drifted] });
    // Once the write back is recorded, the drift before it no longer blocks, and the tree is checked again.
    cut.add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [{ path: 'src/a.ts', before: { blob: reference('5') }, beforeSymlink: false, expected: { blob: reference('a') }, expectedSymlink: false }] });
    assert.deepEqual(nextStep(cut.review(), idle), { kind: 'check-worktree', phase: 'baseline-checks', attempt: 2, moment: 'restored' });
    cut.add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] }, 6);
    assert.deepEqual(runCheck(nextStep(cut.review(), idle)), { kind: 'build', replaces: null, skip: null });
  });

  it('writes back again at the next start when a stop cut the write back between its record and its writes', () => {
    const cut = inBaseline().add('check.started', { phase: 'baseline-checks', attempt: 1, kind: 'lint', command: 'npm run lint' });
    restart(cut, 'baseline-checks', 2, [drifted]).add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [] });
    restart(cut, 'baseline-checks', 3, [drifted]);
    assert.deepEqual(nextStep(cut.review(), idle), { kind: 'restore-tree', phase: 'baseline-checks', attempt: 3, check: { kind: 'lint', attempt: 1 }, files: [drifted] });
  });

  it('blocks on a drift at a later start when the check a kill cut short was written back already, as a person\'s edit while no engine ran is', () => {
    const blocked = (step: Step): boolean => step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'drift';
    // A check a stop cut, written back at the next start and checked again: a drift at a start after it is no longer its.
    const stopped = inBaseline().add('check.started', { phase: 'baseline-checks', attempt: 1, kind: 'lint', command: 'npm run lint' });
    restart(stopped, 'baseline-checks', 2, [drifted])
      .add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [] })
      .add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'restored', drifted: false, head: null, files: [], strays: [] }, 6);
    assert.ok(blocked(nextStep(restart(stopped, 'baseline-checks', 3, [drifted]).review(), idle)), JSON.stringify(nextStep(stopped.review(), idle)));
    // A check that timed out, written back in its own step and checked again, then run once more.
    const timedOut = inBaseline();
    ranV3(timedOut, 'baseline-checks', 'lint', 'timeout', 1)
      .add('tree.restored', { phase: 'baseline-checks', attempt: 1, check: { kind: 'lint', attempt: 1 }, files: [] })
      .add('worktree.checked', { phase: 'baseline-checks', attempt: 1, moment: 'restored', drifted: false, head: null, files: [], strays: [] }, 6);
    assert.ok(blocked(nextStep(restart(timedOut, 'baseline-checks', 2, [drifted]).review(), idle)), JSON.stringify(nextStep(timedOut.review(), idle)));
  });

  it('blocks on a drift at a later start after a check a version 2 run recorded as killed, whose writes its revision holds', () => {
    const blocked = (step: Step): boolean => step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'drift';
    for (const run of [checkRun('baseline-checks', 'lint', 'timeout', 1), { ...checkRun('baseline-checks', 'lint', 'failed', 1), exitCode: 137 }]) {
      const legacy = inBaseline().add('check.ran', run, 2);
      const step = nextStep(restart(legacy, 'baseline-checks', 2, [drifted]).review(), idle);
      assert.ok(blocked(step), JSON.stringify(step));
    }
  });

  it('still blocks on a drift of HEAD, on one no cut check explains, on one whose bytes were too large to keep, and on one left after a write back', () => {
    const blocked = (step: Step): boolean => step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'drift';
    const cut = (): History => inBaseline().add('check.started', { phase: 'baseline-checks', attempt: 1, kind: 'lint', command: 'npm run lint' });
    assert.ok(blocked(nextStep(restart(cut(), 'baseline-checks', 2, [drifted], { expected: '1'.repeat(40), actual: '2'.repeat(40) }).review(), idle)), 'HEAD moved');
    assert.ok(blocked(nextStep(restart(ranV3(inBaseline(), 'baseline-checks', 'build', 'passed', 1), 'baseline-checks', 2, [drifted]).review(), idle)), 'no check was cut');
    assert.ok(blocked(nextStep(restart(cut(), 'baseline-checks', 2, [{ ...drifted, expected: { oversized: { sha256: 'f'.repeat(64), size: 1 } } }]).review(), idle)), 'the bytes were too large to keep');
    const after = restart(cut(), 'baseline-checks', 2, [drifted])
      .add('tree.restored', { phase: 'baseline-checks', attempt: 2, check: { kind: 'lint', attempt: 1 }, files: [] })
      .add('worktree.checked', { phase: 'baseline-checks', attempt: 2, moment: 'restored', drifted: true, head: null, files: [drifted], strays: [] }, 6);
    assert.ok(blocked(nextStep(after.review(), idle)), 'the write back did not hold');
  });

  it('runs the checks after the repair only when the repair changed the tree (TD11)', () => {
    const toRepair = checksPhase(fixed(), 'checks', { test: 'failed' }).start('repair').worker(60, 'fixer repair:repair');
    const deferred = toRepair.clone().add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings: [{ id: 'test', status: 'deferred', file: 'src/a.ts', line: null, note: 'n', message: null, files: [], corrections: [], validation: [], requiredFiles: [] }] }, 2).add('worktree.checked', endCheck('repair'), 2).finish('repair').start('repair-checks');
    assert.deepEqual(nextStep(deferred.review(), idle), { kind: 'finish-phase', phase: 'repair-checks', attempt: 1, outcome: 'completed', blocker: null }, 'a repair that changed nothing');
    const applied = toRepair.clone()
      .add('fix.recorded', { ...fixAnswer(worker(60)), phase: 'repair', key: 'repair', findings: [{ id: 'test', status: 'applied', file: 'src/a.ts', line: 1, note: 'n', message: { subject: 's', body: 'b' }, files: ['src/a.ts'], corrections: [], validation: [], requiredFiles: [] }] }, 2)
      .add('tree.revised', { phase: 'repair', source: { kind: 'fix', key: 'repair', workerId: worker(60) }, change: { findings: ['test'], message: { subject: 's', body: 'b' } }, files: [{ path: 'src/a.ts', status: 'modified', before: { blob: reference('f') }, beforeSymlink: false, symlink: false, after: { blob: reference('9') } }] })
      .add('worktree.checked', endCheck('repair'), 2).finish('repair').start('repair-checks');
    assert.deepEqual(runCheck(nextStep(applied.review(), idle)), { kind: 'build', replaces: null, skip: null });
  });
});

describe('nextStep in the checks on the base (R1, R11, TD4, TD14, TD16 of the facts before a merge)', () => {
  /** What a step runs: the kind, the run it replaces as `<why> <outcome>@<attempt>`, and why it is skipped. */
  const runCheck = (step: Step): { kind: string; replaces: string | null; skip: CheckSkip | null } | null =>
    step.kind === 'run-check' && step.phase === 'base-checks' ? { kind: step.check.kind, replaces: step.check.replaces === null ? null : `${step.check.replaces.why} ${step.check.replaces.run.outcome}@${String(step.check.replaces.run.attempt)}`, skip: step.check.skip } : null;
  const finished = (attempt = 1): Step => ({ kind: 'finish-phase', phase: 'base-checks', attempt, outcome: 'completed', blocker: null });
  /** lint fails before the fixes and after them, test only after them, so lint alone needs a fact of the base. */
  const onBase = (): History => checkedForBase({ lint: 'failed' }, { lint: 'failed', test: 'failed' }).start('base-checks');

  it('runs build first, then only the kinds that failed before the fixes and after them, and finishes', () => {
    const history = onBase();
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'build', replaces: null, skip: null }, 'lint reads what build produces, though build passed before and after the fixes');
    ranOnBase(history, 'build', 'passed');
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: null, skip: null });
    ranOnBase(history, 'lint', 'failed');
    assert.deepEqual(nextStep(history.review(), idle), finished(), 'test passed before the fixes, so the change did not break it');
  });

  it('finishes at once when no kind failed before the fixes and after them', () => {
    for (const [before, after] of [[{}, {}], [{}, { lint: 'failed' }], [{ lint: 'failed' }, {}]] as const) {
      assert.deepEqual(nextStep(checkedForBase(before, after).start('base-checks').review(), idle), finished(), JSON.stringify([before, after]));
    }
  });

  it('runs build alone when only build failed before the fixes and after them', () => {
    const history = checkedForBase({ build: 'failed' }, { build: 'failed' }).start('base-checks');
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'build', replaces: null, skip: null });
    assert.deepEqual(nextStep(ranOnBase(history, 'build', 'failed').review(), idle), finished());
  });

  it('skips each later kind once build did not pass on the base, in the fixed words of the brief', () => {
    for (const outcome of ['failed', 'timeout', 'not-started'] as const) {
      const history = ranOnBase(onBase(), 'build', outcome);
      assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: null, skip: { reason: 'build-failed', error: baseSkipReasons['build-failed'] } }, outcome);
    }
  });

  it('skips each later kind with the reason of a build skipped on the base, which never ran there', () => {
    for (const skip of [baseSkip('empty-tree'), baseSkip('no-worktree', 'fatal: no room')]) {
      const history = ranOnBase(onBase(), 'build', 'skipped', 1, null, skip);
      assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: null, skip: { reason: skip.skipReason, error: skip.error } }, skip.error);
    }
  });

  it('builds the base again first after a stop that left a kind due, since the new attempt makes a new worktree, and then nothing more (TD16)', () => {
    const history = ranOnBase(onBase(), 'build', 'passed').start('base-checks', 2);
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'build', replaces: 'earlier-worktree passed@1', skip: null });
    ranOnBase(history, 'build', 'passed', 2, { attempt: 1, outcome: 'passed' });
    assert.deepEqual(runCheck(nextStep(history.review(), idle)), { kind: 'lint', replaces: null, skip: null });
    ranOnBase(history, 'lint', 'failed', 2);
    assert.deepEqual(nextStep(history.review(), idle), finished(2));
  });

  it('blocks on a drift after a stop during a run on the base, which never wrote the reviewed worktree, and writes nothing back (TD14)', () => {
    const drifted = { path: 'src/a.ts', outcome: 'modified' as const, expected: { blob: reference('f') } };
    const stopped = ranOnBase(onBase(), 'build', 'passed')
      .add('check.started', { phase: 'base-checks', attempt: 1, kind: 'lint', command: 'npm run lint' }, 2)
      .add('phase.started', { phase: 'base-checks', attempt: 2 }, 7)
      .add('worktree.checked', { phase: 'base-checks', attempt: 2, moment: 'start', drifted: true, head: null, files: [drifted], strays: [] }, 8);
    assert.deepEqual(nextStep(stopped.review(), idle), { kind: 'finish-phase', phase: 'base-checks', attempt: 2, outcome: 'blocked', blocker: driftBlocker({ files: [drifted], head: null }, idle.evidencePath) });
  });
});
