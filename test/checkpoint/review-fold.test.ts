import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { isAnswered, isUnverified, poolCandidates, rawLocation, scopeLocation, unverifiedGroupsOf } from '../../src/checkpoint/review-fold.ts';
import { finderAngles, phases } from '../../src/review/vocabulary.ts';
import { History, candidate, configuration, configured, finding, found, launch, leads, ranking, reference, reported, scope, statistics, swept, triaged, unlocated, verified, worker } from '../helpers/review-history.ts';

describe('the review fold', () => {
  it('leaves review null until the run is configured, and folds the configuration verbatim', () => {
    const before = new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).fold();
    assert.equal(before.review, null);
    const review = configured().review();
    assert.deepEqual(review.configuration, configuration);
    assert.deepEqual(review.limits, { concurrency: 4, runBudgetUsd: 30 }, 'the limits in force start as the pinned ones');
    assert.deepEqual(review.phases, Object.fromEntries(phases.map((phase) => [phase, { status: 'pending', attempt: 0 }])));
    assert.equal(review.blocker, null);
    assert.deepEqual(review.candidates, {});
    assert.deepEqual(review.deduplications, { deduplication: null, 'sweep-deduplication': null });
    assert.deepEqual(review.plans, { verification: null, 'sweep-verification': null });
    assert.equal(review.ranking, null);
    assert.equal(review.report, null);
  });

  it('folds the triage: its candidate, its leads, its unit answered and the phase completed', () => {
    const review = triaged().review();
    assert.deepEqual(review.phases.triage, { status: 'completed', attempt: 1 });
    assert.deepEqual(review.leads, leads);
    assert.deepEqual(Object.keys(review.candidates), ['SCAN-1']);
    assert.deepEqual(review.candidates['SCAN-1'], { ...candidate('SCAN-1', 'SCAN'), phase: 'triage', workerId: worker(1), duplicateOf: null, verdict: null, unverified: false });
    assert.deepEqual(review.units.triage, { SCAN: { answeredBy: worker(1), failures: [] } });
    assert.deepEqual(review.checks, [{ phase: 'triage', attempt: 1, drifted: false, files: [] }]);
  });

  it('counts a lost worker and a failed attempt against their unit, and marks the angle that failed twice not run', () => {
    const state = found().fold();
    const review = state.review!;
    assert.equal(state.workers[worker(3)]?.status, 'lost');
    assert.deepEqual(review.units.finders.FOOTGUNS, {
      answeredBy: null,
      failures: [{ workerId: worker(3), reason: 'the engine exited while the worker ran' }, { workerId: worker(4), reason: 'timeout: The worker ran past its timeout' }],
    });
    assert.deepEqual(review.units.finders.WRAPPERS, { answeredBy: worker(10 + finderAngles.indexOf('WRAPPERS')), failures: [{ workerId: worker(5), reason: 'failed: The answer does not match the output schema' }] });
    assert.deepEqual(review.anglesNotRun, { FOOTGUNS: '2 attempts did not complete: the engine exited while the worker ran; timeout: The worker ran past its timeout' });
    assert.deepEqual(review.phases.finders, { status: 'degraded', attempt: 1 });
  });

  it('folds deduplication into duplicateOf and verification into verdicts', () => {
    const review = verified().review();
    assert.equal(review.candidates['SCAN-1']?.duplicateOf, 'RIPPLE-1');
    assert.equal(review.candidates['RIPPLE-1']?.duplicateOf, null);
    assert.deepEqual(review.deduplications.deduplication, [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'one defect at one line' }]);
    assert.deepEqual(review.plans.verification, [{ id: 'g1', candidateIds: ['RIPPLE-1'] }]);
    assert.deepEqual(review.candidates['RIPPLE-1']?.verdict, { verdict: 'CONFIRMED', evidence: 'line 4 dereferences null' });
    assert.deepEqual(review.units.verification, { g1: { answeredBy: worker(21), failures: [] } });
    assert.deepEqual(review.units.deduplication, { deduplication: { answeredBy: worker(20), failures: [] } });
  });

  it('keeps the sweep pool apart, and marks an unverified group on every candidate of it', () => {
    const review = swept().review();
    assert.deepEqual(poolCandidates(review, 'sweep-deduplication').map((candidate) => candidate.id), ['SWEEP-1', 'SWEEP-2']);
    assert.deepEqual(poolCandidates(review, 'deduplication').map((candidate) => candidate.id), ['SCAN-1', 'RIPPLE-1']);
    assert.equal(review.candidates['SWEEP-1']?.unverified, true);
    assert.equal(review.candidates['SWEEP-2']?.unverified, true);
    assert.equal(review.candidates['SWEEP-1']?.verdict, null);
    assert.equal(review.candidates['RIPPLE-1']?.unverified, false);
    assert.deepEqual(review.unverifiedGroups, { verification: {}, 'sweep-verification': { g1: '2 attempts did not complete: failed; failed again' } });
    assert.deepEqual(review.candidates['SWEEP-1']?.located, false);
    assert.equal(review.candidates['SWEEP-1']?.file, null);
  });

  it('answers whether a unit contributed, not whether it has a record', () => {
    const review = found().review();
    assert.equal(isAnswered(review, 'triage', 'SCAN'), true);
    assert.equal(isAnswered(review, 'finders', 'RIPPLE'), true);
    assert.equal(isAnswered(review, 'finders', 'WRAPPERS'), true, 'answered after one failure');
    assert.equal(isAnswered(review, 'finders', 'FOOTGUNS'), false, 'failed twice: a record, no answer');
    assert.equal(isAnswered(review, 'verification', 'g1'), false, 'no record at all');
    assert.equal(isAnswered(review, 'triage', 'RIPPLE'), false, 'a key of another phase');
  });

  it('gives a located candidate its scope location and an unlocated one none, and every candidate its raw location', () => {
    const { candidates } = swept().review();
    // SWEEP-2 matched src/a.ts at line 7; SWEEP-1 named a file outside the scope.
    assert.equal(scopeLocation(candidates['SWEEP-2']!), 'src/a.ts:7');
    assert.equal(rawLocation(candidates['SWEEP-2']!), 'src/a.ts:7');
    assert.equal(scopeLocation(candidates['SWEEP-1']!), null);
    assert.equal(rawLocation(candidates['SWEEP-1']!), 'C:\\elsewhere\\b.ts:9');
    assert.equal(rawLocation({ rawFile: './src/a.ts', rawLine: 3 }), './src/a.ts:3', 'the raw location is the finder\'s spelling, not the scope path');
    assert.equal(scopeLocation({ located: true, file: 'src/a.ts', line: null }), null, 'a location missing its line is no scope location, whatever the flag says');
    assert.equal(scopeLocation({ located: false, file: 'src/a.ts', line: 3 }), null, 'an unlocated candidate has no scope location even with a file and line');
  });

  it('lists every unverified group from the plans, with its candidates and reason', () => {
    const review = swept().review();
    assert.deepEqual(unverifiedGroupsOf(review), [{ phase: 'sweep-verification', groupId: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'], reason: '2 attempts did not complete: failed; failed again' }]);
    assert.equal(isUnverified(review, 'sweep-verification', 'g1'), true);
    assert.equal(isUnverified(review, 'verification', 'g1'), false, 'the same group id in the other phase is another group');
    assert.deepEqual(unverifiedGroupsOf(verified().review()), []);
    assert.deepEqual(unverifiedGroupsOf(configured().review()), [], 'nothing planned, nothing unverified');
  });

  it('folds the ranking and the report, with every phase completed or degraded', () => {
    const review = reported().review();
    assert.deepEqual(review.ranking, ranking);
    assert.deepEqual(review.report, { report: reference('e', 2048), statistics });
    assert.deepEqual(Object.values(review.phases).map((phase) => phase.status), ['completed', 'degraded', 'completed', 'completed', 'completed', 'completed', 'degraded', 'completed', 'completed']);
  });

  it('records a blocker on a blocked finish and clears it, with the phase\'s failures, on the next start', () => {
    const blocker = { code: 'worker-failed', detail: 'the triage failed twice', action: 'run again' };
    const blocked = configured()
      .start('triage')
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(1), reason: 'failed' })
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(2), reason: 'failed' })
      .finish('triage', 'blocked', 1, blocker);
    let review = blocked.review();
    assert.deepEqual(review.blocker, { ...blocker, phase: 'triage' });
    assert.deepEqual(review.phases.triage, { status: 'blocked', attempt: 1 });
    assert.equal(review.units.triage.SCAN?.failures.length, 2);
    review = blocked.start('triage', 2).review();
    assert.equal(review.blocker, null);
    assert.deepEqual(review.phases.triage, { status: 'running', attempt: 2 });
    assert.deepEqual(review.units.triage.SCAN, { answeredBy: null, failures: [] });
  });

  it('forgets only the re-entered phase\'s failures, and keeps every other phase\'s and every answer', () => {
    const blocked = configured()
      .start('triage')
      .add('attempt.failed', { phase: 'triage', key: 'SCAN', workerId: worker(1), reason: 'first' })
      .add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(2), candidates: [], leads })
      .finish('triage')
      .start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'failed' })
      .add('candidates.recorded', { phase: 'finders', key: 'DESIGN', workerId: worker(4), candidates: [], leads: null })
      .finish('finders', 'blocked', 1, { code: 'budget', detail: 'spent', action: 'raise it' });
    const before = blocked.fold();
    const review = blocked.start('finders', 2).review();
    assert.deepEqual(review.units.finders, { RIPPLE: { answeredBy: null, failures: [] }, DESIGN: { answeredBy: worker(4), failures: [] } });
    assert.deepEqual(review.units.triage, { SCAN: { answeredBy: worker(2), failures: [{ workerId: worker(1), reason: 'first' }] } }, 'the triage is not re-entered, so its failure stays');
    assert.equal(before.review!.units.finders.RIPPLE?.failures.length, 1, 'the state before the start is left as it was');
  });

  it('keeps a running phase\'s failures when a resumed engine re-enters it', () => {
    const review = triaged()
      .start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'failed' })
      .add('phase.started', { phase: 'finders', attempt: 2 })
      .review();
    assert.deepEqual(review.phases.finders, { status: 'running', attempt: 2 });
    assert.equal(review.units.finders.RIPPLE?.failures.length, 1);
  });

  it('records a drift check with its files', () => {
    const review = configured()
      .add('phase.started', { phase: 'triage', attempt: 1 })
      .add('worktree.checked', { phase: 'triage', attempt: 1, drifted: true, files: [{ path: 'src/a.ts', outcome: 'modified' }] })
      .finish('triage', 'blocked', 1, { code: 'drift', detail: 'src/a.ts modified', action: 'restore it' })
      .review();
    assert.deepEqual(review.checks, [{ phase: 'triage', attempt: 1, drifted: true, files: [{ path: 'src/a.ts', outcome: 'modified' }] }]);
    assert.equal(review.blocker?.code, 'drift');
  });

  it('loses a worker without a unit when its label named none', () => {
    const state = configured()
      .add('worker.launched', launch(worker(9), 'smoke'))
      .add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'engine exited' })
      .fold();
    assert.equal(state.workers[worker(9)]?.status, 'lost');
    assert.deepEqual(state.review?.units, Object.fromEntries(phases.map((phase) => [phase, {}])), 'no unit of any phase has a record');
    const unconfigured = new History().add('run.created', { worktree: '/w' }).add('worker.launched', launch(worker(9), 'smoke')).add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'engine exited' }).fold();
    assert.equal(unconfigured.workers[worker(9)]?.status, 'lost');
  });

  it('replaces the limits in force with each limits.changed, and keeps the configuration as pinned', () => {
    const raised = triaged().add('limits.changed', { concurrency: 2, runBudgetUsd: 60 });
    assert.deepEqual(raised.review().limits, { concurrency: 2, runBudgetUsd: 60 });
    assert.deepEqual(raised.review().configuration, configuration);
    const unbudgeted = raised.start('finders').add('limits.changed', { concurrency: 16, runBudgetUsd: null }).review();
    assert.deepEqual(unbudgeted.limits, { concurrency: 16, runBudgetUsd: null }, 'a change mid-phase replaces both, and a null budget is no budget');
    assert.deepEqual(unbudgeted.phases.finders, { status: 'running', attempt: 1 }, 'a change of limits leaves the phases alone');
  });

  it('never changes a state it was handed', () => {
    const history = verified();
    const before = history.fold();
    const snapshot = structuredClone(before);
    history.start('sweep').add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN')], leads: null }).fold();
    assert.deepEqual(before, snapshot);
  });

  const invalid: [name: string, build: () => History, message: RegExp][] = [
    ['configuring before the scope', () => new History().add('run.created', { worktree: '/w' }).add('review.configured', configuration), /before its scope is captured/],
    ['configuring twice', () => configured().add('review.configured', configuration), /configured for review twice/],
    ['a phase event before configuration', () => new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('phase.started', { phase: 'triage', attempt: 1 }), /before review.configured/],
    ['starting a phase at the wrong attempt', () => configured().add('phase.started', { phase: 'triage', attempt: 2 }), /at attempt 2 after attempt 0/],
    ['starting a later phase before the earlier one completed', () => configured().add('phase.started', { phase: 'finders', attempt: 1 }), /while phase triage is pending/],
    ['starting a completed phase again', () => triaged().add('phase.started', { phase: 'triage', attempt: 2 }), /again after it completed/],
    ['finishing a phase that is not running', () => configured().finish('triage'), /while it is pending/],
    ['finishing a phase under another attempt', () => configured().start('triage').finish('triage', 'completed', 2), /attempt 2 while it is at attempt 1/],
    ['a blocked finish without a blocker', () => configured().start('triage').finish('triage', 'blocked'), /a blocker is present exactly when the outcome is blocked/],
    ['a check for a phase that is not running', () => configured().add('worktree.checked', { phase: 'triage', attempt: 1, drifted: false, files: [] }), /while it is pending/],
    ['a drift flag that disagrees with its files', () => configured().start('triage').add('worktree.checked', { phase: 'triage', attempt: 1, drifted: true, files: [] }), /drifted exactly when some file differs/],
    ['candidates for a phase that is not running', () => configured().add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [], leads }), /while it is pending/],
    ['triage candidates without leads', () => configured().start('triage').add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [], leads: null }), /the triage alone returns leads/],
    ['finder candidates with leads', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [], leads }), /the triage alone returns leads/],
    ['leads that miss an angle', () => configured().start('triage').add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [], leads: [...leads.slice(1), leads[1]] }), /one lead per finder angle/],
    ['triage candidates under another key', () => configured().start('triage').add('candidates.recorded', { phase: 'triage', key: 'RIPPLE', workerId: worker(1), candidates: [], leads }), /under unit RIPPLE, not SCAN/],
    ['finder candidates under a key that is not an angle', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'SCAN', workerId: worker(2), candidates: [], leads: null }), /not a finder angle/],
    ['a candidate whose id names another angle', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [candidate('DESIGN-1', 'RIPPLE')], leads: null }), /whose ids start with RIPPLE-/],
    ['a candidate whose angle is not its unit\'s', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [candidate('RIPPLE-1', 'DESIGN')], leads: null }), /with angle DESIGN under unit RIPPLE/],
    ['sweep candidates under another key', () => verified().start('sweep').add('candidates.recorded', { phase: 'sweep', key: 'SWEEP', workerId: worker(30), candidates: [], leads: null }), /records sweep candidates under unit SWEEP, not sweep/],
    ['a sweep candidate whose id is not SWEEP', () => verified().start('sweep').add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [candidate('DESIGN-9', 'DESIGN')], leads: null }), /whose ids start with SWEEP-/],
    ['a unit answered twice', () => triaged().add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(2), candidates: [], leads }), /while it is completed/],
    ['a unit answered twice within its phase', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [], leads: null }).add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), candidates: [], leads: null }), /already answered/],
    ['a candidate id recorded twice', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [candidate('RIPPLE-1', 'RIPPLE'), candidate('RIPPLE-1', 'RIPPLE')], leads: null }), /candidate ids are unique/],
    ['a located candidate without a line', () => configured().start('triage').add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [candidate('SCAN-1', 'SCAN', { line: null })], leads }), /a located candidate has a scope file and a line/],
    ['candidates for an angle that failed', () => finding().add('candidates.recorded', { phase: 'finders', key: 'FOOTGUNS', workerId: worker(6), candidates: [], leads: null }), /after it failed/],
    ['a failure for an answered unit', () => triaged().start('finders').add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [], leads: null }).add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(3), reason: 'late' }), /already answered/],
    ['an angle failed twice', () => finding().add('angle.failed', { angle: 'FOOTGUNS', reason: 'again' }), /fails angle FOOTGUNS twice/],
    ['deduplication of a candidate outside its pool', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'SWEEP-1'], keep: 'SCAN-1', reason: 'r' }] }), /not in the deduplication pool/],
    ['deduplication grouping a candidate twice', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'SCAN-1', reason: 'r' }, { members: ['RIPPLE-1', 'SCAN-1'], keep: 'RIPPLE-1', reason: 'r' }] }), /groups candidate .* twice/],
    ['deduplication keeping a non-member', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'SWEEP-1', reason: 'r' }] }), /the kept candidate is a member/],
    ['deduplication recorded twice', () => verified().add('phase.started', { phase: 'deduplication', attempt: 2 }), /again after it completed/],
    ['a plan naming a duplicate', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'r' }] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }] }), /a duplicate of RIPPLE-1/],
    ['a plan naming a candidate twice', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }, { id: 'g2', candidateIds: ['SCAN-1'] }] }), /in two groups/],
    ['a plan with a group id twice', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }, { id: 'g1', candidateIds: ['RIPPLE-1'] }] }), /plans group g1 twice/],
    ['a plan recorded twice', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [] }).add('verification.planned', { phase: 'verification', groups: [] }), /plans verification twice/],
    ['verdicts before a plan', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'SCAN-1', verdict: 'REFUTED', evidence: 'e' }] }), /before it is planned/],
    ['verdicts for an unplanned group', () => verified().add('phase.started', { phase: 'verification', attempt: 2 }), /again after it completed/],
    ['verdicts for a candidate outside the group', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }] }).add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'e' }] }), /which holds \[SCAN-1\]/],
    ['verdicts that miss a candidate of the group', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }] }).add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'e' }] }), /which holds \[SCAN-1, RIPPLE-1\]/],
    ['two verdicts for one candidate', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }] }).add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'e' }, { id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'e' }] }), /two verdicts for one candidate/],
    ['verdicts for an unverified group', () => swept().add('phase.started', { phase: 'sweep-verification', attempt: 2 }), /again after it degraded/],
    ['an unverified mark for a group with verdicts', () => found().start('deduplication').add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [] }).finish('deduplication').start('verification').add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1', 'RIPPLE-1'] }] }).add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'SCAN-1', verdict: 'REFUTED', evidence: 'e' }, { id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'e' }] }).add('group.unverified', { phase: 'verification', groupId: 'g1', reason: 'r' }), /already answered/],
    ['a ranking of an unknown candidate', () => swept().start('merge-rank').add('ranking.recorded', { workerId: worker(40), findings: [{ id: 'RIPPLE-9', members: [], severity: 'major', summary: 's', reason: 'r' }] }), /never recorded/],
    ['a ranking naming a candidate twice', () => swept().start('merge-rank').add('ranking.recorded', { workerId: worker(40), findings: [{ id: 'RIPPLE-1', members: ['SWEEP-1'], severity: 'major', summary: 's', reason: 'r' }, { id: 'SWEEP-1', members: [], severity: 'minor', summary: 's', reason: 'r' }] }), /ranks candidate SWEEP-1 twice/],
    ['a ranking recorded twice', () => swept().start('merge-rank').add('ranking.recorded', { workerId: worker(40), findings: ranking }).add('ranking.recorded', { workerId: worker(41), findings: ranking }), /ranking twice/],
    ['a report before its phase', () => swept().add('report.written', { report: reference('e', 2), statistics }), /while it is pending/],
    ['a report written twice', () => reported().add('report.written', { report: reference('e', 2), statistics }), /while it is completed/],
    ['a limits change before configuration', () => new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('limits.changed', { concurrency: 4, runBudgetUsd: 30 }), /has limits.changed before review.configured/],
    ['a limits change after the report', () => reported().add('limits.changed', { concurrency: 4, runBudgetUsd: 60 }), /changes its limits after its report/],
    ['a concurrency outside 1 to 16', () => configured().add('limits.changed', { concurrency: 17, runBudgetUsd: 30 }), /concurrency/],
    ['a run budget of zero', () => configured().add('limits.changed', { concurrency: 4, runBudgetUsd: 0 }), /runBudgetUsd/],
    ['losing a worker never launched', () => configured().add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'r' }), /without launching it/],
    ['losing a finished worker', () => configured().add('worker.launched', launch(worker(9), 'x')).add('worker.finished', { workerId: worker(9), outcome: 'failed', exitCode: 1, signal: null, termination: 'exited', startedAt: '2026-09-27T00:00:00.000Z', endedAt: '2026-09-27T00:00:01.000Z', sessionIds: [], usage: null, denials: null, error: 'x', stdout: reference('a'), stderr: reference('b'), finalMessage: null, output: null }).add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'r' }), /after it finished/],
    ['losing a worker twice', () => configured().add('worker.launched', launch(worker(9), 'x')).add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'r' }).add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'r' }), /after it was lost/],
    ['a lost worker naming a phase without a key', () => configured().add('worker.launched', launch(worker(9), 'x')).add('worker.lost', { workerId: worker(9), phase: 'finders', key: null, reason: 'r' }), /both its phase and its unit key, or neither/],
    ['a lost worker with a unit before review is configured', () => new History().add('run.created', { worktree: '/w' }).add('worker.launched', launch(worker(9), 'x')).add('worker.lost', { workerId: worker(9), phase: 'finders', key: 'RIPPLE', reason: 'r' }), /before review.configured/],
  ];
  for (const [name, build, message] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => build().fold(), (error: unknown) => error instanceof InvalidHistoryError && message.test(error.message), name);
    });
  }
});
