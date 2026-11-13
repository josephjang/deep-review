/**
 * The view of a run that the form of the pull request renders (R9, R10,
 * TD4, TD6 of the review on the pull request; R16 of the review that
 * reads as a report): the place of each finding (`placeFindings`, "The
 * place of a finding" of the design), and the one view of the run
 * (`FormView`) that `formViewOf` builds once from the brief value, the
 * ranked findings with their decisions, the place of each finding, the
 * counts of the run and the writer's explanation. `pull-request-form.ts`
 * renders the body and the comments from it.
 */
import type { CandidateChoice, ExplanationRecorded, PullRequestFacts, RecordedDecision, ScopeState, Unconfirmed } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { repositoryLocation, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { NewLineKind, PullRequestFile } from '../github/pull-request.ts';
import { newLinesOf } from '../github/pull-request.ts';
import { briefOf, type Brief, type BriefChange, type BriefDeparture, type BriefFinding, type BriefQuestion } from './brief.ts';
import { reviewLanguage, type ConditionSentence, type Core, type LeftLine, type RecordedAnswer as WriterAnswer, type RecordedFinding } from './explanation.ts';
import type { NamedId } from './finding-names.ts';
import type { MachineContext } from './public-text.ts';
import { pullRequestWords, type PullRequestWords } from './pull-request-words.ts';
import { mergeRankInput, rankedFindings, refuted, type ReportFinding } from './state.ts';
import { asksToAct, verdictBases, type FindingKind, type PlaceReason, type VerdictBasis } from './vocabulary.ts';

/** Where a finding points in the repository: its path from the root and its line at the head. */
export interface FindingLocation {
  readonly path: string;
  readonly line: number;
}

/**
 * What the pull request does to the line of a finding: a line of a hunk,
 * added or context; a line of a changed file that no hunk holds; a file
 * the pull request does not change; or a file GitHub shows no diff of.
 */
export type DiffState = NewLineKind | 'outside-the-hunks' | 'not-in-the-pull-request' | 'no-patch';

/**
 * The place of a finding (R10, TD4): on its line, which only a fix or a
 * question on the new side of a hunk gets, or in the body with the reason;
 * with where it points and what the pull request does to that line, which
 * a finding left as is has too, for the note that the pull request does
 * not change its line or its file.
 */
export type FindingPlacement =
  | { readonly finding: string; readonly place: 'line'; readonly reason: 'on-the-diff'; readonly location: FindingLocation; readonly diff: NewLineKind }
  | { readonly finding: string; readonly place: 'body'; readonly reason: Exclude<PlaceReason, 'on-the-diff'>; readonly location: FindingLocation | null; readonly diff: DiffState | null };

/** What the pull request does to `line` of `file`, by GitHub's patch of it; `undefined` for a file not among the pull request's. */
function diffStateOf(file: PullRequestFile | undefined, line: number): DiffState {
  if (file === undefined) return 'not-in-the-pull-request';
  const lines = newLinesOf(file.patch);
  if (lines === null) return 'no-patch';
  return lines.get(line) ?? 'outside-the-hunks';
}

/**
 * The place of each ranked finding, in rank order ("The place of a
 * finding" of the design): on its line when it is decided `fix`, with a
 * departure or without, or `ask`, it is located, its file is among the
 * files of the pull request with a patch, and its line is on the new side
 * of a hunk, added or context. Every other finding goes in the body: one
 * left as is, one with no place in the repository, one whose file has no
 * patch, and one whose line or file the pull request does not change.
 */
export function placeFindings(review: ReviewState, files: readonly PullRequestFile[]): FindingPlacement[] {
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision.decision]));
  const byPath = new Map(files.map((file) => [file.path, file]));
  return rankedFindings(review).map(({ finding, primary }): FindingPlacement => {
    const location = repositoryLocation(primary) === null ? null : { path: primary.file!, line: primary.line! };
    const diff = location === null ? null : diffStateOf(byPath.get(location.path), location.line);
    const decision = decided.get(finding.id);
    if (!asksToAct(decision)) return { finding: finding.id, place: 'body', reason: 'left', location, diff };
    if (location === null || diff === null) return { finding: finding.id, place: 'body', reason: 'no-place', location: null, diff: null };
    if (diff === 'added' || diff === 'context') return { finding: finding.id, place: 'line', reason: 'on-the-diff', location, diff };
    return { finding: finding.id, place: 'body', reason: diff === 'no-patch' ? 'no-patch' : 'outside-the-diff', location, diff };
  });
}

/**
 * What follows the review of the run (R6 of the review of a fix run): a
 * fix pass still to come, run with `review --pr <n> --fix`, or one that
 * the run went on into on the machine of the person who ran the review.
 */
export type FixPass = 'to-come' | 'continued';

/** What the form renders from beyond the fold, each read by the caller. */
export interface PullRequestFormInput {
  /** The run, folded: a read-only run of a pull request with its report, or such a run as it stood before it was continued into its fix pass. */
  readonly state: RunState;
  /** Whether the run went on into its fix pass, which the folded `state` before the continuation does not show. */
  readonly fixPass: FixPass;
  /** The writer's answer as the evidence store froze it (`recordedAnswerOf`), or null when the run recorded no explanation or no writer completed its unit and no answer passed any part. A writer that completed its unit has its answer frozen even when no part of it passed. */
  readonly answer: WriterAnswer | null;
  /** The place of each finding (`placeFindings`), against the files of the pull request as `publish` read them. */
  readonly places: readonly FindingPlacement[];
  /** The machine that ran the review, which no posted text names (R11). */
  readonly machine: MachineContext;
  /** The identity of the engine that renders the review. */
  readonly engine: string;
  /** The serial of the publication, counting the prepared publications of the run from 1. */
  readonly serial: number;
  /** The full ids of the change's commits, read by the caller with git from the run's base to its head, which a source of the core's reason names by a prefix (TD3, TD4 of the core of the change on the pull request); null or absent when git could not read them, and the body then names such a source as code with no link. */
  readonly commits?: readonly string[] | null;
}

/** The counts of the run that the review shows as data (R3, R12, TD3): the candidates through each step, and the verdicts and bases of the ranked findings. */
export interface ReviewCounts {
  readonly candidates: number;
  readonly groups: number;
  readonly refuted: number;
  readonly kept: number;
  readonly merged: number;
  readonly findings: number;
  readonly major: number;
  readonly critical: number;
  readonly minor: number;
  readonly confirmed: number;
  readonly plausible: number;
  readonly unverified: number;
  readonly majorConfirmed: number;
  readonly majorConfirmedRan: number;
  readonly bases: Readonly<Record<VerdictBasis, number>>;
  /** The findings whose verdict records no basis. */
  readonly noBasis: number;
}

/** How a finding is explained: by the writer, not explained (marked by the writer with its reason, dropped by the checks, or not asked of the writer), or by no explanation the run recorded. */
export type Explained =
  | { readonly kind: 'explained'; readonly value: RecordedFinding }
  | { readonly kind: 'unexplained'; readonly reason: string | null }
  | { readonly kind: 'none' };

/**
 * A ranked finding with all the form reads of it: the ledger's facts, and
 * the parts that the writer's and the verifier's answers give, each null
 * when the answer has none, which the form then replaces with the
 * recorded words of the other workers under a label (R8 of the review in
 * the writer's words).
 */
export interface FindingView {
  readonly finding: BriefFinding;
  readonly entry: ReportFinding;
  readonly decision: RecordedDecision | null;
  readonly placement: FindingPlacement;
  readonly explained: Explained;
  readonly question: BriefQuestion | null;
  readonly departure: BriefDeparture | null;
  /** The writer's text of the finding, null when it gave none that passed: its sentence of what deep-review would do, and its fix or its question. */
  readonly written: RecordedFinding | null;
  /** The writer's kind of a minor finding (R13); null lists it with the code. */
  readonly kind: FindingKind | null;
  /** The writer's title and reason for a finding left as is, or null. */
  readonly left: LeftLine | null;
  /** The verifier's reason for a PLAUSIBLE verdict (R7); null says that it gave none. */
  readonly unconfirmed: Unconfirmed | null;
  /** Every candidate, primary first, with the choice its verifier left to the author or null (R9), which the review shows beside the decision (PD8, PD9 of the settled choice). */
  readonly choices: readonly CandidateChoice[];
}

/** An area of the major findings that ask a person to act, as the writer gives it (R4): its title, its intro, a diagram or none, and its findings by id. */
export interface AreaView {
  readonly title: string;
  readonly intro: string;
  readonly diagram: string | null;
  readonly findings: readonly string[];
}

/** A candidate a verifier refuted, with the writer's sentence of its claim and of why it was refuted (R11), each null when the writer gave none. */
export interface RefutedView {
  readonly candidate: CandidateState;
  readonly claim: string | null;
  readonly why: string | null;
}

/**
 * The core of the change that the body opens with (R1, R10 of the core of
 * the change on the pull request): the writer's, from an answer of
 * version 3 that kept it; else the account of the triage, from the brief,
 * with its title; else none, with why the run has no account.
 */
export type CoreView =
  | { readonly kind: 'writer'; readonly core: Core }
  | { readonly kind: 'triage'; readonly title: string; readonly change: Extract<BriefChange, { readonly state: 'given' }> }
  | { readonly kind: 'none'; readonly state: 'none' | 'unrecorded' };

/** The run as every part of the form reads it, built once by `formViewOf`. */
export interface FormView {
  readonly state: RunState;
  readonly review: ReviewState;
  readonly scope: ScopeState;
  readonly pullRequest: PullRequestFacts;
  readonly brief: Brief;
  readonly words: PullRequestWords;
  readonly core: CoreView;
  /** The writer's sentences on the conditions the triage judged to hold, from an answer that kept them; null otherwise, and each condition is then given in the triage's words (R8, R10 of the core of the change on the pull request). */
  readonly conditions: readonly ConditionSentence[] | null;
  /** Whether the run went on into its fix pass, which chooses the fixed notices of what follows the review. */
  readonly fixPass: FixPass;
  readonly findings: readonly FindingView[];
  /** The writer's areas; null puts every major finding that acts in one area named by the engine (R16). */
  readonly areas: readonly AreaView[] | null;
  readonly refuted: readonly RefutedView[];
  readonly counts: ReviewCounts;
  /** The writer's summary, which names the areas, so it is null when the writer's areas are not shown. */
  readonly summary: string | null;
  /** The writer's text of what the review did not examine, or null. */
  readonly notExamined: string | null;
  readonly recorded: ExplanationRecorded | null;
  /** What each id of the run names in a worker's text: a finding by its number, merged candidates included, or a refuted candidate (R1, R2 of the finding names in the review). */
  readonly names: ReadonlyMap<string, NamedId>;
  readonly input: PullRequestFormInput;
}

/**
 * How the writer explained a finding, from the recorded explanation and its
 * frozen answer. A finding the answer does not hold is one the writer was
 * not asked about, or whose explanation no answer passed, which the body
 * marks as given in deep-review's own words.
 */
export function explainedOf(recorded: ExplanationRecorded | null, answer: WriterAnswer | null, id: string): Explained {
  if (recorded === null) return { kind: 'none' };
  if (recorded.dropped.some((part) => part.part === 'finding' && part.finding === id)) return { kind: 'unexplained', reason: null };
  const given = answer?.findings.find((finding) => finding.id === id);
  if (given === undefined) return { kind: 'unexplained', reason: null };
  return given.unexplained ? { kind: 'unexplained', reason: given.reason } : { kind: 'explained', value: given };
}

/** The counts of the run that the body states (R3, R12, TD3), from its state: the candidates through each step, and the verdicts and bases of the ranked findings. */
export function reviewCountsOf(review: ReviewState): ReviewCounts {
  const candidates = Object.values(review.candidates);
  const ranked = rankedFindings(review);
  const major = ranked.filter((entry) => entry.finding.severity !== 'minor');
  const majorConfirmed = major.filter((entry) => entry.resolution.verdict === 'CONFIRMED');
  const bases = Object.fromEntries(verdictBases.map((basis) => [basis, ranked.filter((entry) => entry.resolution.basis === basis).length])) as Record<VerdictBasis, number>;
  return {
    candidates: candidates.length,
    groups: candidates.filter((candidate) => candidate.duplicateOf === null).length,
    refuted: refuted(review).length,
    kept: mergeRankInput(review).length,
    merged: ranked.reduce((sum, entry) => sum + entry.members.length, 0),
    findings: ranked.length,
    major: major.length,
    critical: ranked.filter((entry) => entry.finding.severity === 'critical').length,
    minor: ranked.length - major.length,
    confirmed: ranked.filter((entry) => entry.resolution.verdict === 'CONFIRMED').length,
    plausible: ranked.filter((entry) => entry.resolution.verdict === 'PLAUSIBLE').length,
    unverified: ranked.filter((entry) => entry.resolution.unverified).length,
    majorConfirmed: majorConfirmed.length,
    majorConfirmedRan: majorConfirmed.filter((entry) => entry.resolution.basis === 'ran').length,
    bases,
    noBasis: ranked.filter((entry) => entry.resolution.basis === null).length,
  };
}

/**
 * The view of the run that the form renders, built once: each ranked
 * finding with its decision, place, explanation, question and departure;
 * the counts of the run; the refuted candidates; and the writer's
 * conclusion. The parts that only a newer writer's or verifier's answer
 * holds (the areas, how each finding was checked, the kind of a minor
 * finding, why a verdict is PLAUSIBLE, the choice for the author, and the
 * sentences of a refuted candidate) are null for an older run, and the
 * form gives the engine's words for each (R16).
 */
export function formViewOf(input: PullRequestFormInput): FormView {
  const { state } = input;
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null || scope.pullRequest === null) throw new Error(`Run ${state.id} reviewed no pull request`);
  const brief = briefOf(state);
  const words = pullRequestWords(reviewLanguage(review));
  const writerCore = input.answer?.core ?? null;
  const core: CoreView = writerCore !== null ? { kind: 'writer', core: writerCore } : brief.change.state === 'given' ? { kind: 'triage', title: brief.title, change: brief.change } : { kind: 'none', state: brief.change.state };
  const placements = new Map(input.places.map((placement) => [placement.finding, placement]));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const entries = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const recorded = state.explanation;
  const answer = input.answer;
  const findings = brief.findings.map((finding): FindingView => {
    const placement = placements.get(finding.id);
    if (placement === undefined) throw new Error(`Finding ${finding.id} of run ${state.id} has no place`);
    const entry = entries.get(finding.id)!;
    const explained = explainedOf(recorded, input.answer, finding.id);
    return {
      finding,
      entry,
      decision: decided.get(finding.id) ?? null,
      placement,
      explained,
      question: brief.questions.find((question) => question.id === finding.id) ?? null,
      departure: brief.departures.find((departure) => departure.id === finding.id) ?? null,
      written: explained.kind === 'explained' ? explained.value : null,
      kind: explained.kind === 'explained' ? explained.value.kind : null,
      left: answer?.left?.find((line) => line.id === finding.id) ?? null,
      unconfirmed: entry.resolution.unconfirmed,
      choices: entry.choices,
    };
  });
  return {
    state,
    review,
    scope,
    pullRequest: scope.pullRequest,
    brief,
    words,
    core,
    conditions: answer?.conditions ?? null,
    fixPass: input.fixPass,
    findings,
    areas: answer?.areas ?? null,
    refuted: refuted(review).map(({ candidate }) => {
      const line = answer?.refuted?.find((given) => given.id === candidate.id);
      return { candidate, claim: line?.claim ?? null, why: line?.why ?? null };
    }),
    counts: reviewCountsOf(review),
    // The summary names the areas, so it is not shown when the checks dropped them: the merge of an answer of version 4 keeps the two from one answer, and an older one could keep the summary and drop its areas.
    summary: recorded?.dropped.some((part) => part.part === 'areas') ?? false ? null : answer?.summary ?? null,
    notExamined: answer?.notExamined ?? null,
    recorded,
    names: new Map<string, NamedId>([
      ...refuted(review).map(({ candidate }): [string, NamedId] => [candidate.id, { kind: 'refuted' }]),
      ...[...brief.numbers].map(([id, number]): [string, NamedId] => [id, { kind: 'finding', number }]),
    ]),
    input,
  };
}
