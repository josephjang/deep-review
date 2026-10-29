import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FixState } from '../../src/checkpoint/fix-state.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { budgetStoppedRun, compareFindings, currentPhase, findingIdOf, hasCurrentReport, mergeRankInput, mergedResolution, nextPendingPhase, noFindingPastTheLast, ranAgain, rankedFindings, refuted, resolutionOf, reviewStatus, survivors, workingList, type ReportFinding } from '../../src/review/state.ts';
import { baselined, configured, ranked, reported, swept, triaged, verified, worker } from '../helpers/review-history.ts';

const candidate = (id: string, angle: CandidateState['angle'], change: Partial<CandidateState> = {}): CandidateState => ({
  id, angle, file: 'a.ts', line: 1, located: true, inScope: true, rawFile: 'a.ts', rawLine: 1, summary: 's', detail: 'd', phase: 'finders', workerId: worker(1), duplicateOf: null, verdict: null, unverified: false, ...change,
});
const confirmed = (id: string, angle: CandidateState['angle']): CandidateState => candidate(id, angle, { verdict: { verdict: 'CONFIRMED', evidence: `${id} evidence` } });
const plausible = (id: string, angle: CandidateState['angle']): CandidateState => candidate(id, angle, { verdict: { verdict: 'PLAUSIBLE', evidence: `${id} evidence` } });
const unverifiedOne = (id: string, angle: CandidateState['angle']): CandidateState => candidate(id, angle, { unverified: true });

describe('reviewStatus', () => {
  it('is active until a blocker or a report, and abandoned over both', () => {
    assert.equal(reviewStatus(configured().fold()), 'active');
    assert.equal(reviewStatus(configured().add('run.abandoned', { reason: 'r' }).fold()), 'abandoned');
    assert.equal(reviewStatus(reported().fold()), 'complete');
    const blocked = configured().start('triage').finish('triage', 'blocked', 1, { code: 'budget', detail: 'd', action: 'a' }).fold();
    assert.equal(reviewStatus(blocked), 'blocked');
    assert.equal(reviewStatus(configured().events.length > 0 ? { ...configured().fold(), review: null } : configured().fold()), 'active');
  });
});

describe('hasCurrentReport', () => {
  it('holds for a run whose review wrote its report, not for one with no review or a review with none yet', () => {
    assert.equal(hasCurrentReport(reported().fold()), true);
    assert.equal(hasCurrentReport(configured().fold()), false, 'a review with no report');
    assert.equal(hasCurrentReport({ ...configured().fold(), review: null }), false, 'a run with no review, whose report is undefined rather than null');
  });
});

describe('budgetStoppedRun', () => {
  const fixing = baselined().fold();
  const report = reported().fold().review!.report;
  type Settled = FixState['notAttempted'];
  const run = (notAttempted: Pick<Settled, 'fixes' | 'repair'> & Partial<Pick<Settled, 'documentation'>>, change: { report?: boolean; fix?: boolean } = {}): RunState => ({
    ...fixing, review: { ...fixing.review!, report: change.report === false ? null : report, fix: change.fix === false ? null : { ...fixing.review!.fix!, notAttempted: { documentation: {}, ...notAttempted, answer: {} } } },
  });
  const spent = { cause: 'budget', reason: 'spent' } as const;

  it('holds for a complete fix run the budget left a batch, the documentation step or the repair of', () => {
    assert.equal(budgetStoppedRun(run({ fixes: { 'c1-2': spent }, repair: {} })), true);
    assert.equal(budgetStoppedRun(run({ fixes: {}, repair: { repair: spent } })), true);
    assert.equal(budgetStoppedRun(run({ fixes: {}, documentation: { documentation: spent }, repair: {} })), true);
  });

  it('holds for none that is not complete, not fixing, or left nothing for the budget', () => {
    assert.equal(budgetStoppedRun(run({ fixes: { 'c1-2': spent }, repair: {} }, { report: false })), false, 'no report yet');
    assert.equal(budgetStoppedRun(run({ fixes: { 'c1-2': spent }, repair: {} }, { fix: false })), false, 'a read-only run');
    assert.equal(budgetStoppedRun(run({ fixes: { 'c1-2': { cause: 'failures', reason: 'failed twice' } }, repair: {} })), false, 'left after failures, not the budget');
    assert.equal(budgetStoppedRun(run({ fixes: {}, repair: {} })), false);
    assert.equal(budgetStoppedRun({ ...run({ fixes: { 'c1-2': spent }, repair: {} }), status: 'abandoned' }), false, 'abandoned');
  });
});

describe('ranAgain', () => {
  type WorkerState = RunState['workers'][string];
  const launched = (workerId: string, label: string | null, launchedAt: string): WorkerState => ({ launch: { workerId, label }, launchedAt }) as unknown as WorkerState;

  it('holds only for a later worker of the same label', () => {
    const first = launched('w1', 'finder finders:WRAPPERS', '2026-10-01T00:00:01.000Z');
    const rerun = launched('w2', 'finder finders:WRAPPERS', '2026-10-01T00:00:02.000Z');
    const other = launched('w3', 'finder finders:RIPPLE', '2026-10-01T00:00:03.000Z');
    assert.equal(ranAgain([first, rerun, other], first), true);
    assert.equal(ranAgain([first, rerun, other], rerun), false, 'an earlier worker of the label is not its rerun');
    assert.equal(ranAgain([first, other], first), false, 'a later worker of another label');
    assert.equal(ranAgain([first], first), false, 'the worker alone');
  });

  it('matches no worker with no label, not even a later one with none', () => {
    const unlabelled = launched('w1', null, '2026-10-01T00:00:01.000Z');
    assert.equal(ranAgain([unlabelled, launched('w2', null, '2026-10-01T00:00:02.000Z')], unlabelled), false);
  });
});

describe('the phase selectors', () => {
  it('find the running or blocked phase and the next pending one', () => {
    assert.equal(currentPhase(configured().review()), null);
    assert.equal(nextPendingPhase(configured().review()), 'triage');
    assert.equal(currentPhase(configured().start('triage').review()), 'triage');
    assert.equal(currentPhase(configured().start('triage').finish('triage', 'blocked', 1, { code: 'budget', detail: 'd', action: 'a' }).review()), 'triage');
    assert.equal(nextPendingPhase(triaged().review()), 'finders');
    assert.equal(nextPendingPhase(reported().review()), null);
  });
});

describe('the working list and resolutions', () => {
  it('drops duplicates from the working list of each pool', () => {
    const review = verified().review();
    assert.deepEqual(workingList(review, 'verification').map((candidate) => candidate.id), ['RIPPLE-1']);
    assert.deepEqual(workingList(review, 'deduplication').map((candidate) => candidate.id), ['RIPPLE-1']);
    assert.deepEqual(workingList(swept().review(), 'sweep-verification').map((candidate) => candidate.id), ['SWEEP-1', 'SWEEP-2']);
  });

  it('resolves a verdict, an unverified mark as PLAUSIBLE without evidence, and nothing otherwise', () => {
    assert.deepEqual(resolutionOf(confirmed('A-1', 'SCAN')), { verdict: 'CONFIRMED', unverified: false, evidence: 'A-1 evidence' });
    assert.deepEqual(resolutionOf(unverifiedOne('A-2', 'SCAN')), { verdict: 'PLAUSIBLE', unverified: true, evidence: null });
    assert.equal(resolutionOf(candidate('A-3', 'SCAN')), null);
  });

  it('lists survivors and the refuted, and feeds merge-rank both pools in order', () => {
    const review = swept().review();
    assert.deepEqual(survivors(review, 'verification').map(({ candidate, resolution }) => [candidate.id, resolution.verdict, resolution.unverified]), [['RIPPLE-1', 'CONFIRMED', false]]);
    assert.deepEqual(survivors(review, 'sweep-verification').map(({ candidate, resolution }) => [candidate.id, resolution.verdict, resolution.unverified]), [['SWEEP-1', 'PLAUSIBLE', true], ['SWEEP-2', 'PLAUSIBLE', true]]);
    assert.deepEqual(mergeRankInput(review).map(({ candidate }) => candidate.id), ['RIPPLE-1', 'SWEEP-1', 'SWEEP-2']);
    assert.deepEqual(refuted(review), []);
    const withRefuted = triaged().start('finders');
    for (const angle of ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS']) withRefuted.add('candidates.recorded', { phase: 'finders', key: angle, workerId: worker(2), candidates: [], leads: null });
    withRefuted.finish('finders').start('deduplication').finish('deduplication').start('verification')
      .add('verification.planned', { phase: 'verification', groups: [{ id: 'g1', candidateIds: ['SCAN-1'] }] })
      .add('verdicts.recorded', { phase: 'verification', groupId: 'g1', workerId: worker(21), verdicts: [{ id: 'SCAN-1', verdict: 'REFUTED', evidence: 'a comment' }] });
    assert.deepEqual(refuted(withRefuted.review()).map(({ candidate, evidence }) => [candidate.id, evidence]), [['SCAN-1', 'a comment']]);
    assert.deepEqual(mergeRankInput(withRefuted.review()), []);
  });
});

describe('mergedResolution and the ranking order', () => {
  it('escalates to CONFIRMED when any member is, and is unverified only when every member is', () => {
    assert.deepEqual(mergedResolution([confirmed('A-1', 'SCAN'), plausible('A-2', 'SCAN')]), { verdict: 'CONFIRMED', unverified: false, evidence: 'A-1 evidence' });
    assert.deepEqual(mergedResolution([unverifiedOne('A-1', 'SCAN'), unverifiedOne('A-2', 'SCAN')]), { verdict: 'PLAUSIBLE', unverified: true, evidence: null });
    assert.deepEqual(mergedResolution([unverifiedOne('A-1', 'SCAN'), plausible('A-2', 'SCAN')]), { verdict: 'PLAUSIBLE', unverified: false, evidence: 'A-2 evidence' });
    assert.deepEqual(mergedResolution([plausible('A-1', 'SCAN'), plausible('A-2', 'SCAN')]), { verdict: 'PLAUSIBLE', unverified: false, evidence: 'A-1 evidence' });
  });

  it('takes the evidence of a CONFIRMED member over a PLAUSIBLE primary, so the verdict and its evidence agree', () => {
    assert.deepEqual(mergedResolution([plausible('A-1', 'SCAN'), unverifiedOne('A-2', 'SCAN'), confirmed('A-3', 'SCAN'), confirmed('A-4', 'SCAN')]), { verdict: 'CONFIRMED', unverified: false, evidence: 'A-3 evidence' });
  });

  const finding = (id: string, severity: 'critical' | 'major' | 'minor', primary: CandidateState): ReportFinding => ({
    finding: { id, members: [], severity, summary: 's', reason: 'r' },
    primary,
    members: [],
    resolution: resolutionOf(primary)!,
  });

  it('orders by severity, then CONFIRMED before PLAUSIBLE, then correctness angles before design angles, then the id with its number', () => {
    const entries = [
      finding('DESIGN-1', 'major', confirmed('DESIGN-1', 'DESIGN')),
      finding('RIPPLE-10', 'major', confirmed('RIPPLE-10', 'RIPPLE')),
      finding('RIPPLE-2', 'major', confirmed('RIPPLE-2', 'RIPPLE')),
      finding('SCAN-1', 'minor', confirmed('SCAN-1', 'SCAN')),
      finding('FOOTGUNS-1', 'major', plausible('FOOTGUNS-1', 'FOOTGUNS')),
      finding('SWEEP-1', 'critical', plausible('SWEEP-1', 'ALTITUDE')),
      finding('CONVENTIONS-1', 'major', plausible('CONVENTIONS-1', 'CONVENTIONS')),
    ];
    const ordered = [...entries].sort(compareFindings).map((entry) => entry.finding.id);
    assert.deepEqual(ordered, ['SWEEP-1', 'RIPPLE-2', 'RIPPLE-10', 'DESIGN-1', 'CONVENTIONS-1', 'FOOTGUNS-1', 'SCAN-1']);
  });

  it('resolves the recorded ranking against the candidates in the engine\'s order, whatever order the worker gave', () => {
    const review = ranked().review();
    const findings = rankedFindings(review);
    assert.deepEqual(findings.map((entry) => [entry.finding.id, entry.resolution.verdict, entry.resolution.unverified, entry.members.map((member) => member.id)]), [
      ['RIPPLE-1', 'CONFIRMED', false, ['SWEEP-2']],
      ['SWEEP-1', 'PLAUSIBLE', true, []],
    ]);
    const reversed = rankedFindings(review, [...review.ranking!].reverse());
    assert.deepEqual(reversed.map((entry) => entry.finding.id), ['RIPPLE-1', 'SWEEP-1']);
    assert.throws(() => rankedFindings(review, [{ id: 'GHOST-1', members: [], severity: 'minor', summary: 's', reason: 'r' }]), /never recorded/);
  });
});

describe('findingIdOf (R7 of the report for the person)', () => {
  const review = ranked().review();

  it('takes a number for the finding of that rank, and none past the last', () => {
    assert.equal(findingIdOf(review, '1'), 'RIPPLE-1');
    assert.equal(findingIdOf(review, '2'), 'SWEEP-1');
    assert.equal(findingIdOf(review, '3'), null);
  });

  it('takes the id of a candidate merged into a finding for that finding\'s id, as the numbers key it', () => {
    assert.equal(findingIdOf(review, 'SWEEP-2'), 'RIPPLE-1');
    assert.equal(findingIdOf(review, 'RIPPLE-1'), 'RIPPLE-1');
  });

  it('leaves an id the run does not rank as it is, for the caller to refuse', () => {
    assert.equal(findingIdOf(review, 'SCAN-99'), 'SCAN-99');
  });

  it('words a number past the last finding the same for answer and report, one finding in the singular', () => {
    assert.equal(noFindingPastTheLast('run-1', review, '3'), 'run run-1 has 2 findings, so it has no finding 3');
    assert.equal(noFindingPastTheLast('run-1', { ...review, ranking: review.ranking!.slice(0, 1) }, '2'), 'run run-1 has 1 finding, so it has no finding 2');
    assert.equal(noFindingPastTheLast('run-1', { ...review, ranking: null }, '1'), 'run run-1 has 0 findings, so it has no finding 1');
  });
});
