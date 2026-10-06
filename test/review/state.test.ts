import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { compareFindings, currentPhase, mergeRankInput, mergedResolution, nextPendingPhase, rankedFindings, refuted, resolutionOf, reviewStatus, survivors, workingList, type ReportFinding } from '../../src/review/state.ts';
import { configured, ranked, reported, swept, triaged, verified, worker } from '../helpers/review-history.ts';

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
