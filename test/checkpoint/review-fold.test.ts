import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import type { ReviewConfiguration, ScopeState } from '../../src/checkpoint/events.ts';
import { foldRun, type DecodedEvent, type RunState } from '../../src/checkpoint/fold.ts';
import { poolCandidates, singleUnitKey, unitsOfPhase, type ReviewState } from '../../src/checkpoint/review-fold.ts';
import { finderAngles, phases } from '../../src/review/vocabulary.ts';

const reference = (fill: string, bytes = 1): { sha256: string; bytes: number } => ({ sha256: fill.repeat(64), bytes });
const worker = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const scope: ScopeState = {
  mode: 'worktree',
  request: { paths: [] },
  base: '1'.repeat(40),
  head: '2'.repeat(40),
  files: [{ path: 'src/a.ts', status: 'modified', symlink: false, before: { blob: reference('a') }, after: { blob: reference('b') } }],
  patch: reference('c'),
};

const configuration: ReviewConfiguration = {
  runtime: 'claude',
  executable: '/bin/claude',
  executableArgs: [],
  version: '2.1.283',
  models: { strong: 'opus', fast: 'sonnet' },
  roles: [{ role: 'triage', model: 'opus', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 }],
  rolesDigest: 'd'.repeat(64),
  concurrency: 4,
  runBudgetUsd: 30,
};

const launch = (workerId: string, label: string): Record<string, unknown> => ({
  workerId,
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
  prompt: reference('a'),
  schema: reference('b'),
});

const candidate = (id: string, angle: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  angle,
  file: 'src/a.ts',
  line: 3,
  located: true,
  rawFile: 'src/a.ts',
  rawLine: 3,
  summary: `${id} summary`,
  detail: `${id} detail`,
  ...change,
});
const unlocated = (id: string, angle: string): Record<string, unknown> => candidate(id, angle, { file: null, line: null, located: false, rawFile: 'C:\\elsewhere\\b.ts', rawLine: 9 });

const leads = finderAngles.map((angle) => ({ angle, lead: angle === 'RIPPLE' ? 'the callers of parse()' : null }));

/** A history builder that numbers events as it goes, so a scenario reads as its event list. */
class History {
  readonly events: DecodedEvent[] = [];
  add(kind: string, payload: unknown): this {
    const sequence = this.events.length + 1;
    this.events.push({ sequence, runId: 'run-1', kind, version: 1, payload, recordedAt: `2026-09-27T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`, engine: '0.0.0' });
    return this;
  }
  /** Start a phase at the given attempt and record a clean worktree check for it. */
  start(phase: string, attempt = 1): this {
    return this.add('phase.started', { phase, attempt }).add('worktree.checked', { phase, attempt, drifted: false, files: [] });
  }
  finish(phase: string, outcome = 'completed', attempt = 1, blocker: unknown = null): this {
    return this.add('phase.finished', { phase, attempt, outcome, blocker });
  }
  fold(): RunState {
    return foldRun(this.events);
  }
  review(): ReviewState {
    const review = this.fold().review;
    assert.ok(review !== null, 'the run is configured for review');
    return review;
  }
}

/** A run created, scoped and configured, before any phase. */
const configured = (): History => new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).add('review.configured', configuration);

/** The run through its triage, with one SCAN candidate and the leads. */
const triaged = (): History =>
  configured()
    .start('triage')
    .add('worker.launched', launch(worker(1), 'triage triage:SCAN'))
    .add('candidates.recorded', { phase: 'triage', key: 'SCAN', workerId: worker(1), candidates: [candidate('SCAN-1', 'SCAN')], leads })
    .finish('triage');

/**
 * The run through its finders: RIPPLE finds one, FOOTGUNS fails twice
 * (once by a lost worker) and is not run, WRAPPERS fails once and then
 * answers, and every other angle answers with nothing.
 */
const finding = (): History => {
  const history = triaged().start('finders');
  history.add('candidates.recorded', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), candidates: [candidate('RIPPLE-1', 'RIPPLE', { line: 4, rawLine: 4 })], leads: null });
  history.add('worker.launched', launch(worker(3), 'finder-FOOTGUNS finders:FOOTGUNS'));
  history.add('worker.lost', { workerId: worker(3), phase: 'finders', key: 'FOOTGUNS', reason: 'the engine exited while the worker ran' });
  history.add('attempt.failed', { phase: 'finders', key: 'FOOTGUNS', workerId: worker(4), reason: 'timeout: The worker ran past its timeout' });
  history.add('angle.failed', { angle: 'FOOTGUNS', reason: 'two attempts failed: lost; timeout' });
  history.add('attempt.failed', { phase: 'finders', key: 'WRAPPERS', workerId: worker(5), reason: 'failed: The answer does not match the output schema' });
  for (const angle of finderAngles.filter((name) => name !== 'RIPPLE' && name !== 'FOOTGUNS')) {
    history.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(10 + finderAngles.indexOf(angle)), candidates: [], leads: null });
  }
  return history;
};
const found = (): History => finding().finish('finders', 'degraded');

/** The run through deduplication and verification of the first pool. */
const verified = (): History =>
  found()
    .start('deduplication')
    .add('deduplication.recorded', { phase: 'deduplication', workerId: worker(20), groups: [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'one defect at one line' }] })
    .finish('deduplication')
    .start('verification')
    .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['RIPPLE-1'] }] })
    .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'RIPPLE-1', verdict: 'CONFIRMED', evidence: 'line 4 dereferences null' }] })
    .finish('verification');

/** The run through the sweep, its deduplication (no groups) and its verification, whose one group goes unverified. */
const swept = (): History =>
  verified()
    .start('sweep')
    .add('candidates.recorded', { phase: 'sweep', key: 'sweep', workerId: worker(30), candidates: [unlocated('SWEEP-1', 'DESIGN'), candidate('SWEEP-2', 'SCAN', { line: 7, rawLine: 7 })], leads: null })
    .finish('sweep')
    .start('sweep-deduplication')
    .add('deduplication.recorded', { phase: 'sweep-deduplication', workerId: worker(31), groups: [] })
    .finish('sweep-deduplication')
    .start('sweep-verification')
    .add('verification.planned', { phase: 'sweep-verification', groups: [{ id: 'g1', candidateIds: ['SWEEP-1', 'SWEEP-2'] }] })
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(32), reason: 'failed' })
    .add('attempt.failed', { phase: 'sweep-verification', key: 'g1', workerId: worker(33), reason: 'failed again' })
    .add('group.unverified', { phase: 'sweep-verification', groupId: 'g1', reason: 'two attempts failed' })
    .finish('sweep-verification', 'degraded');

const ranking = [
  { id: 'RIPPLE-1', members: ['SWEEP-2'], severity: 'major', summary: 'null dereference', reason: 'same root cause at lines 4 and 7' },
  { id: 'SWEEP-1', members: [], severity: 'minor', summary: 'extract the helper', reason: 'one improvement' },
];
const statistics = {
  phases: phases.map((phase) => ({ phase, workers: 1, seconds: 2.5, costUsd: 0.5, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 })),
  total: { workers: 9, seconds: 22.5, costUsd: 4.5, inputTokens: 900, cachedInputTokens: 180, outputTokens: 90 },
  budgetApplied: true,
};

/** The whole run, report written. */
const reported = (): History =>
  swept()
    .start('merge-rank')
    .add('ranking.recorded', { workerId: worker(40), findings: ranking })
    .finish('merge-rank')
    .start('report')
    .add('report.written', { report: reference('e', 2048), statistics })
    .finish('report');

describe('the review fold', () => {
  it('leaves review null until the run is configured, and folds the configuration verbatim', () => {
    const before = new History().add('run.created', { worktree: '/w' }).add('scope.captured', scope).fold();
    assert.equal(before.review, null);
    const review = configured().review();
    assert.deepEqual(review.configuration, configuration);
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
    assert.deepEqual(unitsOfPhase(review, 'triage'), { SCAN: { answeredBy: worker(1), failures: [] } });
    assert.deepEqual(review.checks, [{ phase: 'triage', attempt: 1, drifted: false, files: [] }]);
  });

  it('counts a lost worker and a failed attempt against their unit, and marks the angle that failed twice not run', () => {
    const state = found().fold();
    const review = state.review!;
    assert.equal(state.workers[worker(3)]?.status, 'lost');
    assert.deepEqual(unitsOfPhase(review, 'finders').FOOTGUNS, {
      answeredBy: null,
      failures: [{ workerId: worker(3), reason: 'the engine exited while the worker ran' }, { workerId: worker(4), reason: 'timeout: The worker ran past its timeout' }],
    });
    assert.deepEqual(unitsOfPhase(review, 'finders').WRAPPERS, { answeredBy: worker(10 + finderAngles.indexOf('WRAPPERS')), failures: [{ workerId: worker(5), reason: 'failed: The answer does not match the output schema' }] });
    assert.deepEqual(review.anglesNotRun, { FOOTGUNS: 'two attempts failed: lost; timeout' });
    assert.deepEqual(review.phases.finders, { status: 'degraded', attempt: 1 });
  });

  it('folds deduplication into duplicateOf and verification into verdicts', () => {
    const review = verified().review();
    assert.equal(review.candidates['SCAN-1']?.duplicateOf, 'RIPPLE-1');
    assert.equal(review.candidates['RIPPLE-1']?.duplicateOf, null);
    assert.deepEqual(review.deduplications.deduplication, [{ members: ['SCAN-1', 'RIPPLE-1'], keep: 'RIPPLE-1', reason: 'one defect at one line' }]);
    assert.deepEqual(review.plans.verification, [{ id: 'g1', candidateIds: ['RIPPLE-1'] }]);
    assert.deepEqual(review.candidates['RIPPLE-1']?.verdict, { verdict: 'CONFIRMED', evidence: 'line 4 dereferences null' });
    assert.deepEqual(unitsOfPhase(review, 'verification'), { g1: { answeredBy: worker(21), failures: [] } });
    assert.deepEqual(unitsOfPhase(review, 'deduplication'), { deduplication: { answeredBy: worker(20), failures: [] } });
  });

  it('keeps the sweep pool apart, and marks an unverified group on every candidate of it', () => {
    const review = swept().review();
    assert.deepEqual(poolCandidates(review, 'sweep-deduplication').map((candidate) => candidate.id), ['SWEEP-1', 'SWEEP-2']);
    assert.deepEqual(poolCandidates(review, 'deduplication').map((candidate) => candidate.id), ['SCAN-1', 'RIPPLE-1']);
    assert.equal(review.candidates['SWEEP-1']?.unverified, true);
    assert.equal(review.candidates['SWEEP-2']?.unverified, true);
    assert.equal(review.candidates['SWEEP-1']?.verdict, null);
    assert.equal(review.candidates['RIPPLE-1']?.unverified, false);
    assert.deepEqual(review.unverifiedGroups, { 'sweep-verification:g1': 'two attempts failed' });
    assert.deepEqual(review.candidates['SWEEP-1']?.located, false);
    assert.equal(review.candidates['SWEEP-1']?.file, null);
  });

  it('folds the ranking and the report, with every phase completed or degraded', () => {
    const review = reported().review();
    assert.deepEqual(review.ranking, ranking);
    assert.deepEqual(review.report, { report: reference('e', 2048), statistics });
    assert.deepEqual(Object.values(review.phases).map((phase) => phase.status), ['completed', 'degraded', 'completed', 'completed', 'completed', 'completed', 'degraded', 'completed', 'completed']);
    assert.equal(singleUnitKey('triage'), 'SCAN');
    assert.equal(singleUnitKey('sweep'), 'sweep');
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
    assert.equal(unitsOfPhase(review, 'triage').SCAN?.failures.length, 2);
    review = blocked.start('triage', 2).review();
    assert.equal(review.blocker, null);
    assert.deepEqual(review.phases.triage, { status: 'running', attempt: 2 });
    assert.deepEqual(unitsOfPhase(review, 'triage').SCAN, { answeredBy: null, failures: [] });
  });

  it('keeps a running phase\'s failures when a resumed engine re-enters it', () => {
    const review = triaged()
      .start('finders')
      .add('attempt.failed', { phase: 'finders', key: 'RIPPLE', workerId: worker(2), reason: 'failed' })
      .add('phase.started', { phase: 'finders', attempt: 2 })
      .review();
    assert.deepEqual(review.phases.finders, { status: 'running', attempt: 2 });
    assert.equal(unitsOfPhase(review, 'finders').RIPPLE?.failures.length, 1);
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
    assert.deepEqual(state.review?.units, {});
    const unconfigured = new History().add('run.created', { worktree: '/w' }).add('worker.launched', launch(worker(9), 'smoke')).add('worker.lost', { workerId: worker(9), phase: null, key: null, reason: 'engine exited' }).fold();
    assert.equal(unconfigured.workers[worker(9)]?.status, 'lost');
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
