import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleFailedV1, blockerSchema, groupUnverifiedV1, type ReviewLimits } from '../../src/checkpoint/events.ts';
import { foldRun } from '../../src/checkpoint/fold.ts';
import type { ReviewState } from '../../src/checkpoint/review-fold.ts';
import { noCheckFlags } from '../../src/review/checks/discover.ts';
import { budgetBlocker, driftBlocker, groupsOf, maxAttempts, nextStep, truncated, unitsOf, workerFailedBlocker, type Live, type Step, type Unit } from '../../src/review/steps.ts';
import { finderAngles, phases, unitName, type Phase } from '../../src/review/vocabulary.ts';
import { candidate, configured, decidedOf, type History, finding, found, leads, mergeRanked, ranked, ranking, reported, swept, triaged, unlocated, verified, worker } from '../helpers/review-history.ts';

/** What the budget check counted: `usd`, with `charged` workers at their caps and `lost` ones named. */
const counted = (usd: number, charged = 0, lost = 0): { usd: number; charged: number; lost: number } => ({ usd, charged, lost });
const idle: Live = { running: new Set(), spend: counted(0), evidencePath: (reference) => `/evidence/${reference.sha256.slice(0, 8)}`, checkFlags: noCheckFlags };
const live = (change: Partial<Live>): Live => ({ ...idle, ...change });
/** The part of `Live` the budget check reads: `usd` counted, or null on a runtime that reports no cost. */
const spent = (usd: number | null, charged = 0, lost = 0): Partial<Live> => ({ spend: { usd, charged, lost } });
/** The review with other limits in force than its configuration's 4 workers and 30 USD, as a `limits.changed` would put. */
const limited = (review: ReviewState, change: Partial<ReviewLimits>): ReviewState => ({ ...review, limits: { ...review.limits, ...change } });

describe('unitsOf', () => {
  it('gives one unit to the triage, the sweep and merge-rank, nine to the finders and none to the report', () => {
    const review = configured().review();
    assert.deepEqual(unitsOf(review, 'triage'), [{ phase: 'triage', key: 'SCAN', role: 'triage' }]);
    assert.deepEqual(unitsOf(review, 'finders').map((unit) => [unit.key, unit.role]), finderAngles.map((angle) => [angle, `finder-${angle}`]));
    assert.deepEqual(unitsOf(review, 'sweep'), [{ phase: 'sweep', key: 'sweep', role: 'sweep' }]);
    assert.deepEqual(unitsOf(review, 'report'), []);
  });

  it('gives deduplication a unit only when its pool holds two candidates, and merge-rank only when something survived', () => {
    assert.deepEqual(unitsOf(triaged().review(), 'deduplication'), [], 'one candidate cannot repeat');
    assert.deepEqual(unitsOf(found().review(), 'deduplication'), [{ phase: 'deduplication', key: 'deduplication', role: 'deduplication' }]);
    assert.deepEqual(unitsOf(verified().review(), 'sweep-deduplication'), []);
    assert.deepEqual(unitsOf(swept().review(), 'sweep-deduplication'), [{ phase: 'sweep-deduplication', key: 'sweep-deduplication', role: 'deduplication' }]);
    assert.deepEqual(unitsOf(swept().review(), 'merge-rank'), [{ phase: 'merge-rank', key: 'merge-rank', role: 'merge-rank' }]);
    assert.deepEqual(unitsOf(configured().review(), 'merge-rank'), []);
  });

  it('gives the decision one decider when the ranking holds a finding, and none when it holds none (R1 of the decision step)', () => {
    assert.deepEqual(unitsOf(decidedOf(mergeRanked(), null).review(), 'decision'), [{ phase: 'decision', key: 'decision', role: 'decider' }]);
    assert.deepEqual(unitsOf({ ...decidedOf(mergeRanked(), null).review(), ranking: [] }, 'decision'), []);
    assert.deepEqual(unitsOf(configured().review(), 'decision'), [], 'no ranking yet');
  });

  it('finishes a decision with no finding to decide without a worker', () => {
    const nothing = { ...decidedOf(mergeRanked(), null).start('decision').review(), ranking: [] };
    assert.deepEqual(nextStep(nothing, idle), { kind: 'finish-phase', phase: 'decision', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('gives verification one unit per planned group, from the recorded plan when there is one and from the working list otherwise', () => {
    const planned = verified().review();
    assert.deepEqual(unitsOf(planned, 'verification'), [{ phase: 'verification', key: 'g1', role: 'verifier' }]);
    const unplanned = found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').review();
    assert.deepEqual(groupsOf(unplanned, 'verification'), [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }]);
    assert.deepEqual(unitsOf(unplanned, 'verification').map((unit) => unit.key), ['g1']);
  });
});

describe('nextStep', () => {
  it('starts the triage on a configured run', () => {
    assert.deepEqual(nextStep(configured().review(), idle), { kind: 'start-phase', phase: 'triage', attempt: 1 });
  });

  it('checks the worktree once per attempt before anything else in a running phase', () => {
    const started = configured().add('phase.started', { phase: 'triage', attempt: 1 });
    assert.deepEqual(nextStep(started.review(), idle), { kind: 'check-worktree', phase: 'triage', attempt: 1, moment: 'start' });
    const checked = started.add('worktree.checked', { phase: 'triage', attempt: 1, drifted: false, files: [] });
    assert.deepEqual(nextStep(checked.review(), idle), { kind: 'launch', units: [{ phase: 'triage', key: 'SCAN', role: 'triage' }] });
    const reentered = checked.add('phase.started', { phase: 'triage', attempt: 2 });
    assert.deepEqual(nextStep(reentered.review(), idle), { kind: 'check-worktree', phase: 'triage', attempt: 2, moment: 'start' });
  });

  it('awaits the workers in flight once a drift is found while the phase runs, then blocks with it, launching nothing more', () => {
    const files = [{ path: 'src/a.ts', outcome: 'modified' as const }];
    // The check at the attempt's start was clean; a later one, made before recording an answer, found the drift.
    const drifted = triaged().start('finders').add('worktree.checked', { phase: 'finders', attempt: 1, drifted: true, files }).review();
    assert.deepEqual(nextStep(limited(drifted, { concurrency: 16 }), live({ running: new Set(['finders:REMOVALS']) })), { kind: 'await' }, 'nothing more is launched while one runs');
    assert.deepEqual(nextStep(drifted, idle), { kind: 'finish-phase', phase: 'finders', attempt: 1, outcome: 'blocked', blocker: driftBlocker({ files, head: null }, idle.evidencePath) });
    // The check at the start of an attempt that finds a drift blocks the same way, before any launch.
    const atStart = configured().add('phase.started', { phase: 'triage', attempt: 1 }).add('worktree.checked', { phase: 'triage', attempt: 1, drifted: true, files }).review();
    assert.deepEqual(nextStep(atStart, idle), { kind: 'finish-phase', phase: 'triage', attempt: 1, outcome: 'blocked', blocker: driftBlocker({ files, head: null }, idle.evidencePath) });
    // A drift found in an earlier attempt does not block the re-entered one, whose own check was clean.
    const reentered = triaged().start('finders').add('worktree.checked', { phase: 'finders', attempt: 1, drifted: true, files }).finish('finders', 'blocked', 1, driftBlocker({ files, head: null }, idle.evidencePath)).start('finders', 2).review();
    assert.equal(nextStep(reentered, idle).kind, 'launch');
  });

  it('returns the blocker of a blocked run', () => {
    const blocker = { code: 'drift', detail: 'src/a.ts modified', action: 'restore it' };
    const review = configured().add('phase.started', { phase: 'triage', attempt: 1 }).add('worktree.checked', { phase: 'triage', attempt: 1, drifted: true, files: [{ path: 'src/a.ts', outcome: 'modified' }] }).finish('triage', 'blocked', 1, blocker).review();
    assert.deepEqual(nextStep(review, idle), { kind: 'blocked', blocker: { ...blocker, phase: 'triage' } });
  });

  it('awaits the running triage worker and finishes the phase once it answered', () => {
    const running = configured().start('triage').review();
    assert.deepEqual(nextStep(running, live({ running: new Set(['triage:SCAN']) })), { kind: 'await' });
    const answered = configured().start('triage').add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [], leads }).review();
    assert.deepEqual(nextStep(answered, idle), { kind: 'finish-phase', phase: 'triage', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('launches the finders up to the concurrency, skipping the answered and the in-flight units, then awaits', () => {
    const review = triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [], leads: null }).review();
    const step = nextStep(limited(review, { concurrency: 3 }), live({ running: new Set(['finders:REMOVALS']) }));
    assert.equal(step.kind, 'launch');
    assert.deepEqual(step.kind === 'launch' ? step.units.map((unit) => unit.key) : [], ['FOOTGUNS', 'WRAPPERS']);
    assert.deepEqual(nextStep(limited(review, { concurrency: 3 }), live({ running: new Set(['finders:REMOVALS', 'finders:FOOTGUNS', 'finders:WRAPPERS']) })), { kind: 'await' });
    const six = nextStep(limited(review, { concurrency: 16 }), idle);
    assert.deepEqual(six.kind === 'launch' ? six.units.map((unit) => unit.key) : [], finderAngles.filter((angle) => angle !== 'RIPPLE'));
  });

  it('plans a retry for a unit that failed once and a degradation for a degrading unit that failed twice', () => {
    const once = triaged().start('finders').add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'failed' }).review();
    const first = nextStep(limited(once, { concurrency: 1 }), idle);
    assert.deepEqual(first.kind === 'launch' ? first.units.map((unit) => unit.key) : [], ['REMOVALS'], 'units launch in angle order');
    const all = nextStep(limited(once, { concurrency: 16 }), idle);
    assert.ok(all.kind === 'launch' && all.units.some((unit) => unitName('finders', unit.key) === 'finders:RIPPLE'), 'RIPPLE is still launchable after one failure');
    const twice = triaged().start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'first' })
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'second' })
      .review();
    assert.deepEqual(nextStep(twice, idle), { kind: 'degrade', phase: 'finders', degradations: [{ kind: 'angle.failed', angle: 'RIPPLE', reason: '2 attempts did not complete: first; second' }] });
    assert.equal(maxAttempts, 2);
  });

  it('launches every unit that still has attempts before finishing a degraded phase', () => {
    const review = finding().review();
    // WRAPPERS failed once and then answered; FOOTGUNS is not run; every other angle answered.
    assert.deepEqual(nextStep(review, idle), { kind: 'finish-phase', phase: 'finders', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('counts a lost worker as one failed attempt', () => {
    const lost = triaged().start('finders').add('worker.launched', { ...launchOf(3, 'finder-RIPPLE finders:RIPPLE') }).add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'RIPPLE', reason: 'engine exited' }).review();
    const step = nextStep(limited(lost, { concurrency: 16 }), idle);
    assert.ok(step.kind === 'launch' && step.units.some((unit) => unit.key === 'RIPPLE'), 'one more attempt remains');
  });

  /** A finders phase in which RIPPLE lost two workers with their engines. */
  const findersLostTwice = (): History => triaged().start('finders')
    .add('worker.launched', launchOf(3, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'RIPPLE', reason: 'engine exited' })
    .add('worker.launched', launchOf(4, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(4), phase: 'finders', key: 'RIPPLE', reason: 'engine exited again' });

  it('blocks the phase, rather than degrade, when a degrading unit ran out of attempts with a lost worker among its failures', () => {
    const lostTwice = findersLostTwice().review();
    const step = nextStep(lostTwice, idle);
    assert.equal(step.kind, 'finish-phase', JSON.stringify(step));
    if (step.kind === 'finish-phase') {
      assert.equal(step.outcome, 'blocked');
      assert.equal(step.blocker?.code, 'worker-failed');
      assert.match(step.blocker?.detail ?? '', /^the finder-RIPPLE worker for finders:RIPPLE failed twice, a worker lost with its engine among the failures: 2 attempts did not complete: engine exited; engine exited again$/);
    }
    assert.deepEqual(nextStep(lostTwice, live({ running: new Set(['finders:REMOVALS']) })), { kind: 'await' }, 'the workers still running settle first');
    const lostThenTimedOut = triaged().start('finders')
      .add('worker.launched', launchOf(3, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'RIPPLE', reason: 'engine exited' })
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(4), reason: 'timeout: ran long' })
      .review();
    const mixed = nextStep(lostThenTimedOut, idle);
    assert.ok(mixed.kind === 'finish-phase' && mixed.outcome === 'blocked' && mixed.blocker?.code === 'worker-failed', `a loss and a timeout block: ${JSON.stringify(mixed)}`);
    const timedOutThenLost = triaged().start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'timeout: ran long' })
      .add('worker.launched', launchOf(4, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(4), phase: 'finders', key: 'RIPPLE', reason: 'engine exited' })
      .review();
    assert.equal(nextStep(timedOutThenLost, idle).kind, 'finish-phase', 'the loss blocks whichever attempt it was');
  });

  it('blocks a verification group whose verifier was lost twice rather than leave its candidates unverified', () => {
    const history = found().start('deduplication')
      .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] })
      .finish('deduplication')
      .start('verification')
      .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }, { id: 'g2', candidateIds: ['RIPPLE-1'] }] })
      .add('worker.launched', launchOf(21, 'verifier verification:g1')).add('worker.lost', { workerId: worker(21), phase: 'verification', key: 'g1', reason: 'engine exited' })
      .add('worker.launched', launchOf(22, 'verifier verification:g1')).add('worker.lost', { workerId: worker(22), phase: 'verification', key: 'g1', reason: 'engine exited again' })
      .add('verdicts.recorded', { phase: 'verification', groupId: 'g2', workerId: worker(23), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'e' }] });
    const step = nextStep(history.review(), idle);
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'worker-failed', JSON.stringify(step));
    assert.match(step.kind === 'finish-phase' ? step.blocker?.detail ?? '' : '', /^the verifier worker for verification:g1 failed twice, a worker lost with its engine among the failures: /);
  });

  it('gives a unit blocked by its lost workers fresh attempts when its phase is started again, and launches it', () => {
    const history = findersLostTwice();
    for (const angle of finderAngles.filter((name) => name !== 'RIPPLE')) history.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
    const blocked = nextStep(history.review(), idle);
    assert.ok(blocked.kind === 'finish-phase' && blocked.outcome === 'blocked');
    history.finish('finders', 'blocked', 1, blocked.kind === 'finish-phase' ? blocked.blocker : null).start('finders', 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'launch', units: [{ phase: 'finders', key: 'RIPPLE', role: 'finder-RIPPLE' }] });
    history.add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(5), candidates: [], leads: null });
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'finish-phase', phase: 'finders', attempt: 2, outcome: 'completed', blocker: null }, 'no angle was given up');
  });

  it('keeps a running phase\'s losses when a resumed engine re-enters it, so a second loss still blocks', () => {
    const reentered = findersLostTwice().add('phase.started', { phase: 'finders', attempt: 2 }).add('worktree.checked', { phase: 'finders', attempt: 2, drifted: false, files: [] }).review();
    const step = nextStep(reentered, idle);
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.attempt === 2, JSON.stringify(step));
  });

  it('blocks the run when a blocking role fails twice, after the running workers finish', () => {
    const failed = configured().start('triage')
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(1), reason: 'first' })
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(2), reason: 'second' })
      .review();
    const step = nextStep(failed, idle);
    assert.equal(step.kind, 'finish-phase');
    if (step.kind === 'finish-phase') {
      assert.equal(step.outcome, 'blocked');
      assert.equal(step.blocker?.code, 'worker-failed');
      assert.match(step.blocker?.detail ?? '', /the triage worker for triage:SCAN failed twice: 2 attempts did not complete: first; second/);
      assert.match(step.blocker?.action ?? '', /run the command again/);
    }
    assert.deepEqual(nextStep(failed, live({ running: new Set(['triage:SCAN']) })), { kind: 'await' });
  });

  it('takes whether a unit degrades from its phase, never from a flag the unit carries', () => {
    // The typecheck is the assertion: the directive fails `npm run typecheck` if a unit ever carries a degrade flag again.
    // @ts-expect-error: a unit carries no degrade flag; degradationOf decides from its phase
    void ({ phase: 'triage', key: 'SCAN', role: 'triage', degrades: true } satisfies Unit);
  });

  it('blocks the run when the decider fails twice, with no degrade: no fixer acts on a finding nobody decided (R9 of the decision step)', () => {
    const failed = decidedOf(mergeRanked(), null).start('decision')
      .add('attempt.failed', { phase: 'decision', key: 'decision', workerId: worker(90), reason: 'first' }, 4)
      .add('attempt.failed', { phase: 'decision', key: 'decision', workerId: worker(91), reason: 'second' }, 4)
      .review();
    const step = nextStep(failed, idle);
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'worker-failed', JSON.stringify(step));
    assert.match(step.kind === 'finish-phase' ? step.blocker!.detail : '', /^the decider worker for decision:decision failed twice: 2 attempts did not complete: first; second$/);
    assert.deepEqual(nextStep(failed, live({ running: new Set(['decision:decision']) })), { kind: 'await' }, 'nothing finishes while a worker is in flight');
  });

  it('blocks the decision at the run budget, as every reading phase does', () => {
    const running = decidedOf(mergeRanked(), null).start('decision').review();
    const step = nextStep(running, live(spent(31)));
    assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'budget', JSON.stringify(step));
    assert.deepEqual(nextStep(running, idle), { kind: 'launch', units: [{ phase: 'decision', key: 'decision', role: 'decider' }] });
  });

  it('blocks the run when any blocking role fails twice: the deduplications, the sweep and merge-rank as well as the triage', () => {
    const failedTwice = (history: History, phase: Phase): ReviewState => history.start(phase)
      .add('attempt.failed', { phase, key: phase, workerId: worker(90), reason: 'first' })
      .add('attempt.failed', { phase, key: phase, workerId: worker(91), reason: 'second' })
      .review();
    const sweptTwo = (): History => verified().start('sweep')
      .add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN'), candidate('SWEEP-2', 'SCAN', { line: 7, rawLine: 7 })], leads: null })
      .finish('sweep');
    const beforeMergeRank = sweptTwo().start('sweep-deduplication').add('deduplication.recorded', { phase: 'sweep-deduplication', workerId: worker(31), groups: [] }).finish('sweep-deduplication')
      .start('sweep-verification').add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'] }] })
      .add('verdicts.recorded', { phase: 'sweep-verification', groupId: 'g1', workerId: worker(32), verdicts: [{ id: 'SWEEP-1', verdict: 'PLAUSIBLE', evidence: 'e' }, { id: 'SWEEP-2', verdict: 'CONFIRMED', evidence: 'e' }] })
      .finish('sweep-verification');
    for (const [phase, history] of [['deduplication', found()], ['sweep', verified()], ['sweep-deduplication', sweptTwo()], ['merge-rank', beforeMergeRank]] as const) {
      const step = nextStep(failedTwice(history, phase), idle);
      assert.ok(step.kind === 'finish-phase' && step.outcome === 'blocked' && step.blocker?.code === 'worker-failed', `${phase} blocks: ${JSON.stringify(step)}`);
    }
  });

  it('gives a blocked phase fresh attempts when it is started again', () => {
    const again = configured().start('triage')
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(1), reason: 'first' })
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(2), reason: 'second' })
      .finish('triage', 'blocked', 1, { code: 'worker-failed', detail: 'd', action: 'a' })
      .start('triage', 2)
      .review();
    assert.deepEqual(nextStep(again, idle), { kind: 'launch', units: [{ phase: 'triage', key: 'SCAN', role: 'triage' }] });
  });

  it('never launches an angle already recorded as not run, even after a blocked phase gives every unit fresh attempts', () => {
    const history = triaged().start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'first' })
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'second' })
      .add('angle.failed', { angle: 'RIPPLE', reason: '2 attempts did not complete: first; second' })
      .finish('finders', 'blocked', 1, budgetBlocker(counted(31), 30))
      .start('finders', 2);
    const step = nextStep(limited(history.review(), { concurrency: 16 }), idle);
    assert.equal(step.kind, 'launch');
    assert.deepEqual(step.kind === 'launch' ? step.units.map((unit) => unit.key) : [], finderAngles.filter((angle) => angle !== 'RIPPLE'), 'RIPPLE is not relaunched');
    for (const angle of finderAngles) {
      if (angle !== 'RIPPLE') history.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
    }
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'finish-phase', phase: 'finders', attempt: 2, outcome: 'degraded', blocker: null }, 'the phase finishes degraded with RIPPLE still not run');
  });

  it('never launches a group already marked unverified, even after a blocked phase gives every unit fresh attempts', () => {
    const history = found().start('deduplication')
      .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] })
      .finish('deduplication')
      .start('verification')
      .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }, { id: 'g2', candidateIds: ['RIPPLE-1'] }] })
      .add('attempt.failed', { phase: 'verification', key: 'g1', workerId: worker(21), reason: 'a' })
      .add('attempt.failed', { phase: 'verification', key: 'g1', workerId: worker(22), reason: 'b' })
      .add('group.unverified', { phase: 'verification', groupId: 'g1', reason: '2 attempts did not complete: a; b' })
      .finish('verification', 'blocked', 1, budgetBlocker(counted(31), 30))
      .start('verification', 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'launch', units: [{ phase: 'verification', key: 'g2', role: 'verifier' }] });
    history.add('verdicts.recorded', { phase: 'verification', groupId: 'g2', workerId: worker(23), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'e' }] });
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'finish-phase', phase: 'verification', attempt: 2, outcome: 'degraded', blocker: null });
  });

  it('blocks on the budget before a launch, once the running workers have finished, and not when nothing is left to launch', () => {
    const review = triaged().start('finders').review();
    const exhausted = live(spent(31.2));
    const step = nextStep(review, exhausted);
    assert.deepEqual(step, { kind: 'finish-phase', phase: 'finders', attempt: 1, outcome: 'blocked', blocker: budgetBlocker(counted(31.2), 30) });
    assert.equal(budgetBlocker(counted(31.2), 30).detail, 'spent 31.20 USD of the 30.00 USD run budget');
    assert.equal(budgetBlocker(counted(31.2), 30).action, 'run the command again with --budget-usd above 31.20, or abandon the run');
    const withUnreported = nextStep(review, live(spent(33.25, 2, 1)));
    assert.deepEqual(withUnreported, { kind: 'finish-phase', phase: 'finders', attempt: 1, outcome: 'blocked', blocker: budgetBlocker(counted(33.25, 2, 1), 30) });
    assert.equal(
      budgetBlocker(counted(33.25, 2, 1), 30).detail,
      'spent 33.25 USD of the 30.00 USD run budget, counting 2 workers that reported no cost at their per-worker caps; 1 worker lost with an earlier engine is not counted',
      'the detail names the workers counted at their caps and the lost ones left out',
    );
    assert.deepEqual(nextStep(review, { ...exhausted, running: new Set(['finders:REMOVALS']) }), { kind: 'await' });
    assert.equal(nextStep(review, live(spent(29.99))).kind, 'launch');
    assert.equal(nextStep(review, live(spent(null))).kind, 'launch', 'a runtime without cost has no budget check');
    assert.equal(nextStep(limited(review, { runBudgetUsd: null }), live(spent(100))).kind, 'launch', 'no budget, no check');
    const done = finding().review();
    assert.equal(nextStep(done, exhausted).kind, 'finish-phase', 'nothing to launch, so the budget does not block');
  });

  it('checks the budget and fills the concurrency a recorded limits.changed put in force, not the pinned ones', () => {
    const blocked = triaged().start('finders').finish('finders', 'blocked', 1, budgetBlocker(counted(31.2), 30));
    const raised = blocked.add('limits.changed', { concurrency: 2, runBudgetUsd: 60 }).start('finders', 2).review();
    assert.equal(raised.configuration.runBudgetUsd, 30);
    const step = nextStep(raised, live(spent(31.2)));
    assert.deepEqual(step.kind === 'launch' ? step.units.map((unit) => unit.key) : [], ['REMOVALS', 'RIPPLE'], 'two launch under the raised budget, at the concurrency in force');
    assert.deepEqual(nextStep(raised, live(spent(60))), { kind: 'finish-phase', phase: 'finders', attempt: 2, outcome: 'blocked', blocker: budgetBlocker(counted(60), 60) });
    const unbudgeted = triaged().add('limits.changed', { concurrency: 4, runBudgetUsd: null }).start('finders').review();
    assert.equal(nextStep(unbudgeted, live(spent(1000))).kind, 'launch', 'no budget in force, no check');
  });

  it('starts and finishes a phase with no unit, after its check', () => {
    // deduplication with one candidate has no unit.
    const review = triaged().start('finders');
    for (const angle of finderAngles) review.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
    review.finish('finders');
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'start-phase', phase: 'deduplication', attempt: 1 });
    review.start('deduplication');
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'finish-phase', phase: 'deduplication', attempt: 1, outcome: 'completed', blocker: null });
  });

  it('plans verification from the working list once, then launches one verifier per group', () => {
    const review = found().start('deduplication')
      .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'r' }] })
      .finish('deduplication')
      .start('verification');
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'plan-verification', phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1'] }] });
    review.add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1'] }] });
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'launch', units: [{ phase: 'verification', key: 'g1', role: 'verifier' }] });
  });

  it('degrades a verification group that failed twice and finishes the phase degraded', () => {
    const review = verified().start('sweep')
      .add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN'), candidate('SWEEP-2', 'SCAN', { line: 7, rawLine: 7 })], leads: null })
      .finish('sweep')
      .start('sweep-deduplication')
      .add('deduplication.recorded', { phase: 'sweep-deduplication', workerId: worker(31), groups: [] })
      .finish('sweep-deduplication')
      .start('sweep-verification')
      .add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'] }] })
      .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(32), reason: 'a' })
      .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(33), reason: 'b' });
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'degrade', phase: 'sweep-verification', degradations: [{ kind: 'group.unverified', phase: 'sweep-verification', groupId: 'g1', reason: '2 attempts did not complete: a; b' }] });
    review.add('group.unverified', { phase: 'sweep-verification', groupId: 'g1', reason: '2 attempts did not complete: a; b' });
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'finish-phase', phase: 'sweep-verification', attempt: 1, outcome: 'degraded', blocker: null });
  });

  it('runs the sweep whatever the first pool held, and merge-rank only with survivors', () => {
    const empty = triaged().start('finders');
    for (const angle of finderAngles) empty.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
    empty.finish('finders').start('deduplication').finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }] })
      .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'SCAN-1', verdict: 'REFUTED', evidence: 'no' }] }).finish('verification');
    assert.deepEqual(nextStep(empty.review(), idle), { kind: 'start-phase', phase: 'sweep', attempt: 1 });
    empty.start('sweep').add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [], leads: null }).finish('sweep');
    empty.start('sweep-deduplication').finish('sweep-deduplication').start('sweep-verification').add('verification.planned', { phase: 'sweep-verification', groups: [] }).finish('sweep-verification');
    empty.start('merge-rank');
    assert.deepEqual(nextStep(empty.review(), idle), { kind: 'finish-phase', phase: 'merge-rank', attempt: 1, outcome: 'completed', blocker: null }, 'nothing survived, so no merge-rank worker');
  });

  it('writes the report once its phase is checked, and is complete once it is written', () => {
    assert.deepEqual(nextStep(swept().start('merge-rank').add('ranking.recorded', { workerId: worker(40), findings: ranking }).finish('merge-rank').review(), idle), { kind: 'start-phase', phase: 'report', attempt: 1 });
    assert.deepEqual(nextStep(ranked().review(), idle), { kind: 'write-report' });
    assert.deepEqual(nextStep(reported().review(), idle), { kind: 'complete' });
  });

  it('gives a step at every prefix of a whole run, and never a blocked or await one when no worker is in flight', () => {
    const kinds = new Set<Step['kind']>();
    const history = reported();
    for (let length = 3; length <= history.events.length; length += 1) {
      const review = foldRun(history.events.slice(0, length)).review;
      if (review === null) continue;
      kinds.add(nextStep(review, idle).kind);
    }
    assert.ok(!kinds.has('blocked') && !kinds.has('await'), [...kinds].join(', '));
    assert.deepEqual([...kinds].sort(), ['check-worktree', 'complete', 'degrade', 'finish-phase', 'launch', 'plan-verification', 'start-phase', 'write-report']);
    assert.equal(phases.length, 16, 'the walk covers a run without the fix pass, the survey and the decision; the fix phases are walked by the fix planner tests, the survey by the survey planner tests, and the decision by the walk below');
  });

  it('gives a step at every prefix of a whole run with the survey and the decision, launching the decider once the ranking is recorded', () => {
    const history = decidedOf(reported());
    const launched: Step[] = [];
    for (let length = 3; length <= history.events.length; length += 1) {
      const review = foldRun(history.events.slice(0, length)).review;
      if (review === null) continue;
      const step = nextStep(review, idle);
      assert.ok(step.kind !== 'blocked' && step.kind !== 'await', `${String(length)}: ${step.kind}`);
      if (step.kind === 'launch' && step.units.some((unit) => unit.phase === 'decision')) launched.push(step);
    }
    assert.deepEqual(launched.at(-1), { kind: 'launch', units: [{ phase: 'decision', key: 'decision', role: 'decider' }] });
  });
});

describe('the blockers', () => {
  it('name the operator action for a failed worker and a drift', () => {
    const unit = { phase: 'triage' as const, key: 'SCAN', role: 'triage' as const };
    const blocker = workerFailedBlocker(configured().review(), unit, { answeredBy: null, failures: [{ workerId: worker(1), reason: 'x', lost: false }, { workerId: worker(2), reason: 'y', lost: false }] });
    assert.equal(blocker.code, 'worker-failed');
    assert.match(blocker.action, /two fresh attempts/);
    const drift = driftBlocker({ files: [{ path: 'a.ts', outcome: 'modified' }, { path: 'b.ts', outcome: 'deleted' }], head: null }, idle.evidencePath);
    assert.equal(drift.code, 'drift');
    assert.equal(drift.detail, 'the worktree differs from what the run expects: a.ts (modified), b.ts (deleted)');
    assert.match(drift.action, /restore the named files/);
  });
});

describe('truncated', () => {
  it('keeps text that fits and cuts longer text to the limit with a mark', () => {
    assert.equal(truncated('abc', 3), 'abc');
    assert.equal(truncated('', 0), '');
    assert.equal(truncated('a'.repeat(20), 15), 'aaa [truncated]');
    assert.equal(truncated('a'.repeat(20), 15).length, 15);
  });

  it('drops the mark when there is no room for it, and gives nothing for a limit at or below zero', () => {
    assert.equal(truncated('abcdef', 4), 'abcd');
    assert.equal(truncated('abcdef', 0), '');
    assert.equal(truncated('abcdef', -5), '');
  });

  it('never cuts between the two halves of a surrogate pair', () => {
    // The cut would fall after the high half of the emoji at position 2.
    assert.equal(truncated('ab\u{1F600}cdefghijklmnop', 15), 'ab [truncated]');
    assert.equal(truncated('ab\u{1F600}cd', 3), 'ab');
  });
});

describe('the recorded reasons and details', () => {
  // attempt.failed records a reason of up to 4000 characters, so two of them overflow a reason that quotes both.
  const long = (fill: string): string => fill.repeat(4000);
  const twoLongFailures = { answeredBy: null, failures: [{ workerId: worker(1), reason: long('x'), lost: false }, { workerId: worker(2), reason: long('y'), lost: false }] };

  it('fit an angle.failed and a group.unverified however long the failures were, and still quote each one', () => {
    const finders = triaged().start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: long('x') })
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: long('y') })
      .review();
    const step = nextStep(finders, idle);
    assert.ok(step.kind === 'degrade');
    const degradation = step.degradations[0];
    assert.ok(degradation?.kind === 'angle.failed');
    angleFailedV1.parse({ angle: degradation.angle, reason: degradation.reason });
    assert.ok(degradation.reason.length <= 4000, String(degradation.reason.length));
    assert.match(degradation.reason, /^2 attempts did not complete: x+ \[truncated\]; y+ \[truncated\]$/);

    const verification = found().start('deduplication')
      .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] })
      .finish('deduplication')
      .start('verification')
      .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }] })
      .add('attempt.failed', { phase: 'verification', key: 'g1', workerId: worker(21), reason: long('a') })
      .add('attempt.failed', { phase: 'verification', key: 'g1', workerId: worker(22), reason: long('b') })
      .review();
    const unverified = nextStep(verification, idle);
    assert.ok(unverified.kind === 'degrade');
    const group = unverified.degradations[0];
    assert.ok(group?.kind === 'group.unverified');
    groupUnverifiedV1.parse({ phase: group.phase, groupId: group.groupId, reason: group.reason });
    assert.match(group.reason, /^2 attempts did not complete: a+ \[truncated\]; b+ \[truncated\]$/);
  });

  it('keep short failures whole', () => {
    const blocker = workerFailedBlocker(configured().review(), { phase: 'triage', key: 'SCAN', role: 'triage' }, { answeredBy: null, failures: [{ workerId: worker(1), reason: 'x', lost: false }, { workerId: worker(2), reason: 'y', lost: false }] });
    assert.equal(blocker.detail, 'the triage worker for triage:SCAN failed twice: 2 attempts did not complete: x; y');
  });

  it('fit a worker-failed blocker however long the failures were', () => {
    const blocker = workerFailedBlocker(configured().review(), { phase: 'merge-rank', key: 'merge-rank', role: 'merge-rank' }, twoLongFailures);
    blockerSchema.parse(blocker);
    assert.ok(blocker.detail.length <= 4000, String(blocker.detail.length));
    assert.match(blocker.detail, /^the merge-rank worker for merge-rank:merge-rank failed twice: 2 attempts did not complete: x+ \[truncated\]; y+ \[truncated\]$/);
  });

  it('fit a worker-failed blocker when a lost worker added a third failure', () => {
    const blocker = workerFailedBlocker(configured().review(), { phase: 'triage', key: 'SCAN', role: 'triage' }, { answeredBy: null, failures: [...twoLongFailures.failures, { workerId: worker(3), reason: long('z'), lost: true }] });
    blockerSchema.parse(blocker);
    assert.match(blocker.detail, /3 attempts did not complete: x+ \[truncated\]; y+ \[truncated\]; z+ \[truncated\]$/);
  });

  it('fit a drift blocker over thousands of files, naming as many as fit and counting the rest', () => {
    const files = Array.from({ length: 2000 }, (_, index) => ({ path: `src/generated/module-${String(index).padStart(4, '0')}.ts`, outcome: 'modified' as const }));
    const drift = driftBlocker({ files, head: null }, idle.evidencePath);
    blockerSchema.parse(drift);
    assert.ok(drift.detail.length <= 4000, String(drift.detail.length));
    const match = /^the worktree differs from what the run expects: (.+), and (\d+) more$/.exec(drift.detail);
    assert.ok(match !== null, drift.detail.slice(-200));
    const named = match[1]!.split(', ');
    assert.deepEqual(named, files.slice(0, named.length).map((file) => `${file.path} (modified)`), 'the first files, in order');
    assert.equal(named.length + Number(match[2]), files.length, 'every file is named or counted');
  });

  it('fit a drift blocker whose one path is longer than the detail', () => {
    const one = driftBlocker({ files: [{ path: `src/${'d/'.repeat(3000)}a.ts`, outcome: 'deleted' }], head: null }, idle.evidencePath);
    blockerSchema.parse(one);
    assert.match(one.detail, /^the worktree differs from what the run expects: src\/d\/.* \[truncated\]$/);
    const two = driftBlocker({ files: [{ path: `src/${'d/'.repeat(3000)}a.ts`, outcome: 'deleted' }, { path: 'b.ts', outcome: 'modified' }], head: null }, idle.evidencePath);
    blockerSchema.parse(two);
    assert.match(two.detail, / \[truncated\], and 1 more$/);
  });
});

/** A launch payload for a worker of the given label. */
function launchOf(n: number, label: string): Record<string, unknown> {
  return {
    workerId: worker(n),
    label,
    runtime: 'claude',
    executable: '/bin/claude',
    executableArgs: [],
    version: '2.1.283',
    model: 'opus',
    effort: 'high',
    access: 'read-only',
    shell: true,
    sessionId: null,
    resumes: null,
    scratch: null,
    budgetUsd: null,
    timeoutMs: 60_000,
    prompt: { sha256: 'a'.repeat(64), bytes: 1 },
    schema: { sha256: 'b'.repeat(64), bytes: 1 },
  };
}
