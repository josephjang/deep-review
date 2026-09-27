import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleFailedV1, blockerSchema, groupUnverifiedV1 } from '../../src/checkpoint/events.ts';
import { foldRun } from '../../src/checkpoint/fold.ts';
import { budgetBlocker, driftBlocker, groupsOf, maxAttempts, nextStep, truncated, unitsOf, workerFailedBlocker, type Live, type Step } from '../../src/review/steps.ts';
import { finderAngles, phases, unitName } from '../../src/review/vocabulary.ts';
import { candidate, configured, finding, found, leads, ranked, ranking, reported, swept, triaged, unlocated, verified, worker } from '../helpers/review-history.ts';

const idle: Live = { running: new Set(), concurrency: 4, spendUsd: 0, budgetUsd: 30 };
const live = (change: Partial<Live>): Live => ({ ...idle, ...change });

describe('unitsOf', () => {
  it('gives one unit to the triage, the sweep and merge-rank, nine to the finders and none to the report', () => {
    const review = configured().review();
    assert.deepEqual(unitsOf(review, 'triage'), [{ phase: 'triage', key: 'SCAN', role: 'triage', degrades: false }]);
    assert.deepEqual(unitsOf(review, 'finders').map((unit) => [unit.key, unit.role, unit.degrades]), finderAngles.map((angle) => [angle, `finder-${angle}`, true]));
    assert.deepEqual(unitsOf(review, 'sweep'), [{ phase: 'sweep', key: 'sweep', role: 'sweep', degrades: false }]);
    assert.deepEqual(unitsOf(review, 'report'), []);
  });

  it('gives deduplication a unit only when its pool holds two candidates, and merge-rank only when something survived', () => {
    assert.deepEqual(unitsOf(triaged().review(), 'deduplication'), [], 'one candidate cannot repeat');
    assert.deepEqual(unitsOf(found().review(), 'deduplication'), [{ phase: 'deduplication', key: 'deduplication', role: 'deduplication', degrades: false }]);
    assert.deepEqual(unitsOf(verified().review(), 'sweep-deduplication'), []);
    assert.deepEqual(unitsOf(swept().review(), 'sweep-deduplication'), [{ phase: 'sweep-deduplication', key: 'sweep-deduplication', role: 'deduplication', degrades: false }]);
    assert.deepEqual(unitsOf(swept().review(), 'merge-rank'), [{ phase: 'merge-rank', key: 'merge-rank', role: 'merge-rank', degrades: false }]);
    assert.deepEqual(unitsOf(configured().review(), 'merge-rank'), []);
  });

  it('gives verification one unit per planned group, from the recorded plan when there is one and from the working list otherwise', () => {
    const planned = verified().review();
    assert.deepEqual(unitsOf(planned, 'verification'), [{ phase: 'verification', key: 'g1', role: 'verifier', degrades: true }]);
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
    assert.deepEqual(nextStep(started.review(), idle), { kind: 'check-worktree', phase: 'triage', attempt: 1 });
    const checked = started.add('worktree.checked', { phase: 'triage', attempt: 1, drifted: false, files: [] });
    assert.deepEqual(nextStep(checked.review(), idle), { kind: 'launch', units: [{ phase: 'triage', key: 'SCAN', role: 'triage', degrades: false }] });
    const reentered = checked.add('phase.started', { phase: 'triage', attempt: 2 });
    assert.deepEqual(nextStep(reentered.review(), idle), { kind: 'check-worktree', phase: 'triage', attempt: 2 });
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
    const step = nextStep(review, live({ running: new Set(['finders:REMOVALS']), concurrency: 3 }));
    assert.equal(step.kind, 'launch');
    assert.deepEqual(step.kind === 'launch' ? step.units.map((unit) => unit.key) : [], ['FOOTGUNS', 'WRAPPERS']);
    assert.deepEqual(nextStep(review, live({ running: new Set(['finders:REMOVALS', 'finders:FOOTGUNS', 'finders:WRAPPERS']), concurrency: 3 })), { kind: 'await' });
    const six = nextStep(review, live({ concurrency: 16 }));
    assert.deepEqual(six.kind === 'launch' ? six.units.map((unit) => unit.key) : [], finderAngles.filter((angle) => angle !== 'RIPPLE'));
  });

  it('plans a retry for a unit that failed once and a degradation for a degrading unit that failed twice', () => {
    const once = triaged().start('finders').add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'failed' }).review();
    const first = nextStep(once, live({ concurrency: 1 }));
    assert.deepEqual(first.kind === 'launch' ? first.units.map((unit) => unit.key) : [], ['REMOVALS'], 'units launch in angle order');
    const all = nextStep(once, live({ concurrency: 16 }));
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
    const step = nextStep(lost, live({ concurrency: 16 }));
    assert.ok(step.kind === 'launch' && step.units.some((unit) => unit.key === 'RIPPLE'), 'one more attempt remains');
    const lostTwice = triaged().start('finders')
      .add('worker.launched', launchOf(3, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'RIPPLE', reason: 'engine exited' })
      .add('worker.launched', launchOf(4, 'finder-RIPPLE finders:RIPPLE')).add('worker.lost', { workerId: worker(4), phase: 'finders', key: 'RIPPLE', reason: 'engine exited again' })
      .review();
    assert.equal(nextStep(lostTwice, idle).kind, 'degrade');
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

  it('gives a blocked phase fresh attempts when it is started again', () => {
    const again = configured().start('triage')
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(1), reason: 'first' })
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(2), reason: 'second' })
      .finish('triage', 'blocked', 1, { code: 'worker-failed', detail: 'd', action: 'a' })
      .start('triage', 2)
      .review();
    assert.deepEqual(nextStep(again, idle), { kind: 'launch', units: [{ phase: 'triage', key: 'SCAN', role: 'triage', degrades: false }] });
  });

  it('never launches an angle already recorded as not run, even after a blocked phase gives every unit fresh attempts', () => {
    const history = triaged().start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'first' })
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'second' })
      .add('angle.failed', { angle: 'RIPPLE', reason: '2 attempts did not complete: first; second' })
      .finish('finders', 'blocked', 1, budgetBlocker(31, 30))
      .start('finders', 2);
    const step = nextStep(history.review(), live({ concurrency: 16 }));
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
      .finish('verification', 'blocked', 1, budgetBlocker(31, 30))
      .start('verification', 2);
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'launch', units: [{ phase: 'verification', key: 'g2', role: 'verifier', degrades: true }] });
    history.add('verdicts.recorded', { phase: 'verification', groupId: 'g2', workerId: worker(23), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'e' }] });
    assert.deepEqual(nextStep(history.review(), idle), { kind: 'finish-phase', phase: 'verification', attempt: 2, outcome: 'degraded', blocker: null });
  });

  it('blocks on the budget before a launch, once the running workers have finished, and not when nothing is left to launch', () => {
    const review = triaged().start('finders').review();
    const exhausted = live({ spendUsd: 31.2, budgetUsd: 30 });
    const step = nextStep(review, exhausted);
    assert.deepEqual(step, { kind: 'finish-phase', phase: 'finders', attempt: 1, outcome: 'blocked', blocker: budgetBlocker(31.2, 30) });
    assert.equal(budgetBlocker(31.2, 30).detail, 'spent 31.20 USD of the 30.00 USD run budget');
    assert.equal(budgetBlocker(31.2, 30).action, 'run the command again with --budget-usd above 31.20, or abandon the run');
    assert.deepEqual(nextStep(review, { ...exhausted, running: new Set(['finders:REMOVALS']) }), { kind: 'await' });
    assert.equal(nextStep(review, live({ spendUsd: 29.99, budgetUsd: 30 })).kind, 'launch');
    assert.equal(nextStep(review, live({ spendUsd: null, budgetUsd: 30 })).kind, 'launch', 'a runtime without cost has no budget check');
    assert.equal(nextStep(review, live({ spendUsd: 100, budgetUsd: null })).kind, 'launch', 'no budget, no check');
    const done = finding().review();
    assert.equal(nextStep(done, exhausted).kind, 'finish-phase', 'nothing to launch, so the budget does not block');
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
    assert.deepEqual(nextStep(review.review(), idle), { kind: 'launch', units: [{ phase: 'verification', key: 'g1', role: 'verifier', degrades: true }] });
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
    assert.equal(phases.length, 9);
  });
});

describe('the blockers', () => {
  it('name the operator action for a failed worker and a drift', () => {
    const unit = { phase: 'triage' as const, key: 'SCAN', role: 'triage', degrades: false };
    const blocker = workerFailedBlocker(unit, { answeredBy: null, failures: [{ workerId: worker(1), reason: 'x' }, { workerId: worker(2), reason: 'y' }] });
    assert.equal(blocker.code, 'worker-failed');
    assert.match(blocker.action, /two fresh attempts/);
    const drift = driftBlocker([{ path: 'a.ts', outcome: 'modified' }, { path: 'b.ts', outcome: 'deleted' }]);
    assert.equal(drift.code, 'drift');
    assert.equal(drift.detail, 'the worktree differs from the reviewed change: a.ts (modified), b.ts (deleted)');
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
  const twoLongFailures = { answeredBy: null, failures: [{ workerId: worker(1), reason: long('x') }, { workerId: worker(2), reason: long('y') }] };

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
    const blocker = workerFailedBlocker({ phase: 'triage', key: 'SCAN', role: 'triage', degrades: false }, { answeredBy: null, failures: [{ workerId: worker(1), reason: 'x' }, { workerId: worker(2), reason: 'y' }] });
    assert.equal(blocker.detail, 'the triage worker for triage:SCAN failed twice: 2 attempts did not complete: x; y');
  });

  it('fit a worker-failed blocker however long the failures were', () => {
    const blocker = workerFailedBlocker({ phase: 'merge-rank', key: 'merge-rank', role: 'merge-rank', degrades: false }, twoLongFailures);
    blockerSchema.parse(blocker);
    assert.ok(blocker.detail.length <= 4000, String(blocker.detail.length));
    assert.match(blocker.detail, /^the merge-rank worker for merge-rank:merge-rank failed twice: 2 attempts did not complete: x+ \[truncated\]; y+ \[truncated\]$/);
  });

  it('fit a worker-failed blocker when a lost worker added a third failure', () => {
    const blocker = workerFailedBlocker({ phase: 'triage', key: 'SCAN', role: 'triage', degrades: false }, { answeredBy: null, failures: [...twoLongFailures.failures, { workerId: worker(3), reason: long('z') }] });
    blockerSchema.parse(blocker);
    assert.match(blocker.detail, /3 attempts did not complete: x+ \[truncated\]; y+ \[truncated\]; z+ \[truncated\]$/);
  });

  it('fit a drift blocker over thousands of files, naming as many as fit and counting the rest', () => {
    const files = Array.from({ length: 2000 }, (_, index) => ({ path: `src/generated/module-${String(index).padStart(4, '0')}.ts`, outcome: 'modified' }));
    const drift = driftBlocker(files);
    blockerSchema.parse(drift);
    assert.ok(drift.detail.length <= 4000, String(drift.detail.length));
    const match = /^the worktree differs from the reviewed change: (.+), and (\d+) more$/.exec(drift.detail);
    assert.ok(match !== null, drift.detail.slice(-200));
    const named = match[1]!.split(', ');
    assert.deepEqual(named, files.slice(0, named.length).map((file) => `${file.path} (modified)`), 'the first files, in order');
    assert.equal(named.length + Number(match[2]), files.length, 'every file is named or counted');
  });

  it('fit a drift blocker whose one path is longer than the detail', () => {
    const one = driftBlocker([{ path: `src/${'d/'.repeat(3000)}a.ts`, outcome: 'deleted' }]);
    blockerSchema.parse(one);
    assert.match(one.detail, /^the worktree differs from the reviewed change: src\/d\/.* \[truncated\]$/);
    const two = driftBlocker([{ path: `src/${'d/'.repeat(3000)}a.ts`, outcome: 'deleted' }, { path: 'b.ts', outcome: 'modified' }]);
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
