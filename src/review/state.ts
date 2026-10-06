/**
 * Questions the planner, the phases and the report ask of a folded run, each
 * answered from the state alone (R10 of the read-only review, TD1): which
 * candidates are on a working list, what verdict each carries, what the
 * merge and rank pass works on, and in what order the report lists the
 * findings.
 */
import type { RankedFinding } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { poolCandidates, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import { angleClasses, phases, severities, type DeduplicationPhase, type Phase, type Verdict, type VerificationPhase } from './vocabulary.ts';

/** What a run is doing, as `status` prints it: the ledger's own status, refined by the review's blocker and report. */
export type ReviewStatus = 'active' | 'blocked' | 'complete' | 'abandoned';

export function reviewStatus(state: RunState): ReviewStatus {
  if (state.status === 'abandoned') return 'abandoned';
  if (state.review?.report !== null && state.review?.report !== undefined) return 'complete';
  if (state.review?.blocker !== null && state.review?.blocker !== undefined) return 'blocked';
  return 'active';
}

/** The phase that is running or blocked, or null when none is. */
export function currentPhase(review: ReviewState): Phase | null {
  return phases.find((phase) => review.phases[phase].status === 'running' || review.phases[phase].status === 'blocked') ?? null;
}

/** The first phase not yet started, or null when every phase has run. */
export function nextPendingPhase(review: ReviewState): Phase | null {
  return phases.find((phase) => review.phases[phase].status === 'pending') ?? null;
}

/** The candidates a deduplication or verification phase works on, less the duplicates deduplication removed: the working list of that pool. */
export function workingList(review: ReviewState, phase: DeduplicationPhase | VerificationPhase): CandidateState[] {
  return poolCandidates(review, phase).filter((candidate) => candidate.duplicateOf === null);
}

/** What verification decided about a candidate: its verdict, or PLAUSIBLE with the unverified mark, or null while neither is recorded. */
export interface Resolution {
  readonly verdict: Verdict;
  readonly unverified: boolean;
  readonly evidence: string | null;
}

export function resolutionOf(candidate: CandidateState): Resolution | null {
  if (candidate.verdict !== null) return { verdict: candidate.verdict.verdict, unverified: false, evidence: candidate.verdict.evidence };
  if (candidate.unverified) return { verdict: 'PLAUSIBLE', unverified: true, evidence: null };
  return null;
}

/** A candidate with the resolution it carries. */
export interface Resolved {
  readonly candidate: CandidateState;
  readonly resolution: Resolution;
}

/** The candidates of a verification phase's working list that were verified and not refuted, in recorded order. */
export function survivors(review: ReviewState, phase: VerificationPhase): Resolved[] {
  return workingList(review, phase)
    .map((candidate) => ({ candidate, resolution: resolutionOf(candidate) }))
    .filter((entry): entry is Resolved => entry.resolution !== null && entry.resolution.verdict !== 'REFUTED');
}

/** The candidates of a verification phase's working list a verifier refuted, with the evidence. */
export function refutedIn(review: ReviewState, phase: VerificationPhase): { candidate: CandidateState; evidence: string }[] {
  return workingList(review, phase)
    .filter((candidate) => candidate.verdict?.verdict === 'REFUTED')
    .map((candidate) => ({ candidate, evidence: candidate.verdict!.evidence }));
}

/** Every refuted candidate of the run, first pool then sweep. */
export function refuted(review: ReviewState): { candidate: CandidateState; evidence: string }[] {
  return [...refutedIn(review, 'verification'), ...refutedIn(review, 'sweep-verification')];
}

/** What merge and rank works on: the survivors of both verification phases, first pool then sweep, in recorded order. */
export function mergeRankInput(review: ReviewState): Resolved[] {
  return [...survivors(review, 'verification'), ...survivors(review, 'sweep-verification')];
}

/** A finding as the report prints it: the ranked finding, its primary candidate, its members and the merged resolution. */
export interface ReportFinding {
  readonly finding: RankedFinding;
  readonly primary: CandidateState;
  readonly members: readonly CandidateState[];
  /** CONFIRMED when any member is, else PLAUSIBLE; unverified when every member is. */
  readonly resolution: Resolution;
}

/**
 * The merged resolution of a finding: CONFIRMED when any candidate is, unverified only when every candidate is;
 * the evidence of the first candidate, primary first, that carries the merged verdict, so a CONFIRMED finding
 * never shows a PLAUSIBLE member's 'Not CONFIRMED' line and keeps the confirming member's narrowed claim.
 */
export function mergedResolution(candidates: readonly CandidateState[]): Resolution {
  const resolutions = candidates.map(resolutionOf).filter((resolution): resolution is Resolution => resolution !== null);
  const verdict: Verdict = resolutions.some((resolution) => resolution.verdict === 'CONFIRMED') ? 'CONFIRMED' : 'PLAUSIBLE';
  const unverified = resolutions.length > 0 && resolutions.every((resolution) => resolution.unverified);
  const evidence = resolutions.find((resolution) => resolution.verdict === verdict && resolution.evidence !== null)?.evidence ?? null;
  return { verdict, unverified, evidence };
}

/** The number in a candidate id, for an order that puts `RIPPLE-2` before `RIPPLE-10`. */
const idParts = (id: string): [string, number] => {
  const dash = id.lastIndexOf('-');
  return [id.slice(0, dash), Number(id.slice(dash + 1))];
};

/** The engine's order over findings (TD9): severity, then verdict, then correctness angles before design angles, then the primary id. */
export function compareFindings(a: ReportFinding, b: ReportFinding): number {
  const severity = severities.indexOf(a.finding.severity) - severities.indexOf(b.finding.severity);
  if (severity !== 0) return severity;
  const verdict = Number(a.resolution.verdict !== 'CONFIRMED') - Number(b.resolution.verdict !== 'CONFIRMED');
  if (verdict !== 0) return verdict;
  const angle = Number(angleClasses[a.primary.angle] !== 'correctness') - Number(angleClasses[b.primary.angle] !== 'correctness');
  if (angle !== 0) return angle;
  const [prefixA, numberA] = idParts(a.finding.id);
  const [prefixB, numberB] = idParts(b.finding.id);
  return prefixA < prefixB ? -1 : prefixA > prefixB ? 1 : numberA - numberB;
}

/** The recorded findings resolved against the candidates and put in the engine's order; the worker's order is advisory. */
export function rankedFindings(review: ReviewState, findings: readonly RankedFinding[] = review.ranking ?? []): ReportFinding[] {
  const resolved = findings.map((finding): ReportFinding => {
    const primary = review.candidates[finding.id];
    const members = finding.members.map((id) => review.candidates[id]);
    if (primary === undefined || members.some((member) => member === undefined)) throw new Error(`Ranking names a candidate the run never recorded: ${finding.id}`);
    return { finding, primary, members: members as CandidateState[], resolution: mergedResolution([primary, ...(members as CandidateState[])]) };
  });
  return resolved.sort(compareFindings);
}
