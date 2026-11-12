/**
 * The writer's explanation of the review of a pull request (R18, R19,
 * TD8, TD9 of the review on the pull request; R4, R10, R11, R13, TD2 of
 * the review that reads as a report): which findings it explains, the
 * merge of an answer, checked part by part in `explanation-checks.ts`,
 * with the earlier one of its unit, what `explanation.recorded` records
 * of them, and the writer's task. A run configured at
 * `review.configured@12` has its writer answer in the third form, which
 * adds the core of the change and the sentences of the conditions (R2,
 * R3, R5, R8, TD2 of the core of the change on the pull request),
 * recorded at version 3; a run configured at version 11 keeps the second
 * form, with the areas and the refuted lines and no account, recorded at
 * version 2; and a run configured before keeps the first, at version 1.
 * The answer as
 * the evidence store freezes it reads as one `RecordedAnswer` whatever
 * its version, which the form of the pull request renders beside the
 * ledger's own words.
 */
import { z } from 'zod';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import { recordedTextLengthV1, type DroppedPart, type DroppedPartV1, type DroppedPartV2, type DroppedPartV3, type ExplanationRecorded, type ExplanationRecordedV1, type ExplanationRecordedV2, type ExplanationRecordedV3, type CandidateChoice, type RecordedDecision, type ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { changeReadingOf, explanationVersionOf, type CandidateState, type ExplanationVersion, type ReviewState, type UnitFailure, type UnitState } from '../checkpoint/review-fold.ts';
import { defaultLanguage } from '../config/settings.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { commitIdsOrNull } from '../scope/git.ts';
import { briefMarkdown, briefOf } from './brief.ts';
import { StructuralCheckError } from './errors.ts';
import { checkAnswer, gitLineCounts, heldConditions, type CheckedAnswer, type CheckedPart, type CoreCheckInput, type ReportCheckInput } from './explanation-checks.ts';
import { counted, inlineText } from './markdown.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicWords, type MachineContext } from './public-text.ts';
import { writerOutputSchema, writerOutputSchemaFor, writerOutputSchemaV2, writerOutputSchemaV3, type CitedSide, type WriterOutput, type WriterOutputV2, type WriterOutputV3 } from './schemas.ts';
import { findingNumbers, rankedFindings, refuted, resolutionOf, shownChoiceLines, type ReportFinding } from './state.ts';
import { degradesOnNextFailure, truncated } from './steps.ts';
import { commitMessagesSection, describeLocation, type ChangeMessages } from './tasks.ts';
import { asksToAct, singleUnitKey, verdictBasisWords, type ChangeConditionName, type FindingKind } from './vocabulary.ts';

const writerOutputShape = writerOutputSchema.shape;
const writerOutputShapeV2 = writerOutputSchemaV2.shape;
const writerOutputShapeV3 = writerOutputSchemaV3.shape;
const explanationShape = writerOutputShape.findings.element.shape.explanation.unwrap().shape;
const explanationShapeV2 = writerOutputShapeV2.findings.element.shape.explanation.unwrap().shape;

/** The writer's answer as it gave it, of any version. */
export type AnyWriterOutput = WriterOutput | WriterOutputV2 | WriterOutputV3;

/** The conclusion as the writer gives it: why the pull request needs what it needs, a sentence for each action by the id of its finding, and a diagram or none. */
export type Conclusion = WriterOutput['conclusion'];
/** The account of the pull request, which only an answer of version 1 gives: the terms a newcomer needs, the problem before the change and the change, each with a diagram or none. */
export type Account = WriterOutput['account'];
/** An area of the major findings that ask a person to act (R4 of the review that reads as a report): a title that says what goes wrong for whom, an intro of one or two sentences, a diagram or none, and the ids of its findings. */
export type Area = WriterOutputV2['areas'][number];
/** The line of a refuted candidate (R11 of the review that reads as a report): its id, one sentence of its claim and one of why it was refuted. */
export type RefutedLine = WriterOutputV2['refuted'][number];
/** The core of the change as the writer gives it (R2, R3 of the core of the change on the pull request): a title, what the change does, why in its own words or null, the commits and files the reason comes from, and a diagram or none. */
export type Core = WriterOutputV3['core'];
/** The writer's sentences on a condition of principle 8 the triage judged to hold (R8 of the core of the change on the pull request): its explanation from the code, or what the writer found instead. */
export type ConditionSentence = WriterOutputV3['conditions'][number];
/** One case in which a finding breaks: a sentence and the lines that show it. */
export type CitedCase = z.infer<typeof explanationShape.cases.element>;
/** The lines a case cites: a range of a path at the head, or at the merge base for lines the change removed. */
export type CitedLines = CitedCase['lines'];

/** A finding the writer explained, as an answer of version 1 freezes it. */
const explainedFindingSchema = z.strictObject({ id: z.string(), unexplained: z.literal(false), ...explanationShape });
/** A finding the writer explained, as an answer of version 2 freezes it: also how its verifier checked it, and its kind. */
const explainedFindingSchemaV2 = z.strictObject({ id: z.string(), unexplained: z.literal(false), ...explanationShapeV2 });
/**
 * A finding the writer explained, from an answer of either version: the
 * cause in one sentence, the problem as who meets what, the cases, a
 * diagram or none, and its words on the decision; and one line of how its
 * verifier checked it (R10) and, for a minor finding that asks a person to
 * act, its kind (R13), each null in an answer of version 1, and the kind
 * null for every other finding. `recordedAnswerOf` gives both for an
 * answer of either version.
 */
export type ExplainedFinding = z.infer<typeof explainedFindingSchema> & { readonly checked: string | null; readonly kind: FindingKind | null };
/** A finding the writer could not explain from its evidence and the code, with the reason: the review gives it in the ledger's words with the mark (R19). */
const unexplainedFindingSchema = z.strictObject({ id: z.string(), unexplained: z.literal(true), reason: z.string() });
export type UnexplainedFinding = z.infer<typeof unexplainedFindingSchema>;
export type FindingExplanation = ExplainedFinding | UnexplainedFinding;

/**
 * The writer's answer as the evidence store freezes it at version 1, the
 * reference `explanation.recorded@1` holds: each part that an answer
 * passed, and none that no answer passed, which the record lists as
 * dropped. A dropped conclusion or account is null, and a dropped finding
 * has no entry; each finding kept is in the rank of the findings.
 */
export const recordedAnswerSchema = z.strictObject({
  conclusion: writerOutputShape.conclusion.nullable(),
  account: writerOutputShape.account.nullable(),
  findings: z.array(z.discriminatedUnion('unexplained', [explainedFindingSchema, unexplainedFindingSchema])),
});

/** The writer's answer as the evidence store freezes it at version 2, the reference `explanation.recorded@2` holds: as version 1, with the areas and the refuted lines, each null when dropped, and no account. */
export const recordedAnswerSchemaV2 = z.strictObject({
  conclusion: writerOutputShapeV2.conclusion.nullable(),
  areas: writerOutputShapeV2.areas.nullable(),
  refuted: writerOutputShapeV2.refuted.nullable(),
  findings: z.array(z.discriminatedUnion('unexplained', [explainedFindingSchemaV2, unexplainedFindingSchema])),
});

/** The writer's answer as the evidence store freezes it at version 3, the reference `explanation.recorded@3` holds: as version 2, with the core of the change and the sentences of the conditions, each null when dropped. */
export const recordedAnswerSchemaV3 = z.strictObject({
  ...recordedAnswerSchemaV2.shape,
  core: writerOutputShapeV3.core.nullable(),
  conditions: writerOutputShapeV3.conditions.nullable(),
});

/**
 * The writer's answer as the form reads it, whatever version froze it:
 * each part an answer passed, and null for a part dropped or one its
 * version does not have. The account is an answer of version 1's alone;
 * the areas, the refuted lines and each finding's `checked` and `kind`
 * are an answer of version 2's or 3's; the core and the conditions are an
 * answer of version 3's alone. `recordedAnswerOf` gives every part for an
 * answer of any version.
 */
export interface RecordedAnswer {
  readonly conclusion: Conclusion | null;
  readonly account: Account | null;
  readonly areas: Area[] | null;
  readonly refuted: RefutedLine[] | null;
  readonly core: Core | null;
  readonly conditions: ConditionSentence[] | null;
  readonly findings: FindingExplanation[];
}

/** The recorded answer of an explanation, read by the version of its event, as the form reads it, or null when no answer passed any part. */
export function recordedAnswerOf(recorded: Pick<ExplanationRecorded, 'answer' | 'version'>, evidence: Pick<EvidenceStore, 'read'>): RecordedAnswer | null {
  if (recorded.answer === null) return null;
  const frozen: unknown = JSON.parse(evidence.read(recorded.answer).toString('utf8'));
  if (recorded.version === 3) return { ...recordedAnswerSchemaV3.parse(frozen), account: null };
  if (recorded.version === 2) return { ...recordedAnswerSchemaV2.parse(frozen), account: null, core: null, conditions: null };
  const answer = recordedAnswerSchema.parse(frozen);
  return { ...answer, areas: null, refuted: null, core: null, conditions: null, findings: answer.findings.map((finding) => (finding.unexplained ? finding : { ...finding, checked: null, kind: null })) };
}

/** The answer as the evidence store freezes it at `version`: the parts that version has, each finding in its shape. */
function frozenAnswer(version: ExplanationVersion, { conclusion, account, areas, refuted: lines, core, conditions, findings }: RecordedAnswer): object {
  if (version === 3) return { conclusion, areas, refuted: lines, core, conditions, findings };
  if (version === 2) return { conclusion, areas, refuted: lines, findings };
  return { conclusion, account, findings: findings.map((finding) => (finding.unexplained ? finding : (({ checked: _checked, kind: _kind, ...rest }) => rest)(finding))) };
}

/**
 * The findings the writer explains, by id in rank order: each that goes on
 * its line or in full in the body of the review, which is each decided
 * `fix`, with a departure or without, or `ask` (R9, R10, R18 of the review
 * on the pull request). A finding left as is gets no explanation.
 */
export function findingsToExplain(review: ReviewState): string[] {
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision.decision]));
  return rankedFindings(review).flatMap((entry) => (asksToAct(decided.get(entry.finding.id)) ? [entry.finding.id] : []));
}

/** Whether a finding of a severity is major, as the areas hold it (R4 of the review that reads as a report): critical or major, not minor. */
const isMajor = (entry: ReportFinding): boolean => entry.finding.severity !== 'minor';

/** What the run holds an answer of version 2 to (`ReportCheckInput`). */
export function reportCheckInputOf(review: ReviewState): ReportCheckInput {
  const ids = new Set(findingsToExplain(review));
  return {
    major: rankedFindings(review).filter((entry) => ids.has(entry.finding.id) && isMajor(entry)).map((entry) => entry.finding.id),
    asks: (review.decisions ?? []).filter((decision) => ids.has(decision.id) && decision.decision === 'ask').map((decision) => decision.id),
    refuted: refuted(review).map(({ candidate }) => candidate.id),
  };
}

/** A part of the answer as `explanation.recorded` names a dropped one: the conclusion, the account, the areas, the refuted lines, the core, the conditions, or `finding <id>`. */
export type PartName = 'conclusion' | 'account' | 'areas' | 'refuted' | 'core' | 'conditions' | `finding ${string}`;

/** The most failures a dropped part records, as `explanation.recorded` holds them. */
const maxPartFailures = 100;

/** The failures a dropped part records: the latest answer's, then `extra`, each cut to what the ledger holds; a part no answer gave at all says so. */
function recordedFailures(failures: readonly string[], extra: readonly string[]): string[] {
  const all = [...failures, ...extra];
  return (all.length === 0 ? ['no answer of the writer gave it'] : all).slice(0, maxPartFailures).map((failure) => truncated(failure, recordedTextLengthV1));
}

/** What the merge of a unit's answers keeps, and each part none of them passed. */
export interface MergedAnswer {
  readonly answer: RecordedAnswer;
  readonly dropped: readonly DroppedPart[];
}

/**
 * The answers of one unit merged, in the order they were given (R19,
 * TD9): each part of the answer's `version` is taken from the first answer
 * that passed it, so a retry replaces only the parts that failed, and a
 * part that passed the first time is kept; a part that no answer passed is
 * dropped, with the failures of the latest answer that gave it and
 * `extra`, such as why no other answer came. A finding kept is in the
 * order of `ids`. A part the version does not have is null.
 *
 * The core and the conditions of an answer of version 3 are taken each
 * on its own, as a finding is (TD2 of the core of the change on the pull
 * request): the summary names neither.
 *
 * In an answer of version 2 or 3 the conclusion's `why` is the summary that
 * names the areas (R1, PD6 of the review that reads as a report), so the
 * two are taken from one answer: the first that passed both. When none
 * did, the areas are taken from the first answer that passed them, and
 * the conclusion of that answer failed, so it is dropped with that
 * answer's failures; with no areas kept, the conclusion is taken as any
 * other part, since the body then posts no summary.
 */
export function mergeAnswers(version: ExplanationVersion, answers: readonly CheckedAnswer[], ids: readonly string[], extra: readonly string[] = []): MergedAnswer {
  const dropped: DroppedPart[] = [];
  const passes = <T>(part: CheckedPart<T> | null): part is CheckedPart<T> => part !== null && part.value !== null && part.failures.length === 0;
  const pick = <T>(parts: readonly (CheckedPart<T> | null)[], drop: (failures: string[]) => DroppedPart): T | null => {
    const given = parts.filter((part): part is CheckedPart<T> => part !== null);
    const passed = given.find(passes);
    if (passed !== undefined) return passed.value;
    dropped.push(drop(recordedFailures(given.at(-1)?.failures ?? [], extra)));
    return null;
  };
  const paired = answers.find((answer) => passes(answer.conclusion) && passes(answer.areas));
  const areasFrom = version === 1 ? undefined : (paired ?? answers.find((answer) => passes(answer.areas)));
  const pairedSource = areasFrom === undefined ? answers : [areasFrom];
  const conclusion = pick(pairedSource.map((answer) => answer.conclusion), (failures) => ({ part: 'conclusion', failures }));
  const account = version === 1 ? pick(answers.map((answer) => answer.account), (failures) => ({ part: 'account', failures })) : null;
  const areas = version === 1 ? null : pick(pairedSource.map((answer) => answer.areas), (failures) => ({ part: 'areas', failures }));
  const lines = version === 1 ? null : pick(answers.map((answer) => answer.refuted), (failures) => ({ part: 'refuted', failures }));
  const core = version === 3 ? pick(answers.map((answer) => answer.core), (failures) => ({ part: 'core', failures })) : null;
  const conditions = version === 3 ? pick(answers.map((answer) => answer.conditions), (failures) => ({ part: 'conditions', failures })) : null;
  const findings = ids.flatMap((id) => {
    const kept = pick(answers.map((answer) => answer.findings.get(id)!), (failures) => ({ part: 'finding', finding: id, failures }));
    return kept === null ? [] : [kept];
  });
  return { answer: { conclusion, account, areas, refuted: lines, core, conditions, findings }, dropped };
}

/** Whether the merge kept any part. */
const keptAny = ({ answer }: MergedAnswer): boolean => answer.conclusion !== null || answer.account !== null || answer.areas !== null || answer.refuted !== null || answer.core !== null || answer.conditions !== null || answer.findings.length > 0;

/** A dropped part by its name, as the reason of a refused answer and the next writer's task give it: `conclusion`, `account`, `areas`, `refuted`, `core`, `conditions` or `finding <id>`. */
const partNameOf = (part: DroppedPart): PartName => (part.part === 'finding' ? `finding ${part.finding}` : part.part);

/** The event that records a writer's explanation, at the version of its answer, typed as a pair. */
export type ExplanationEvent =
  | { readonly kind: 'explanation.recorded'; readonly version: 1; readonly payload: ExplanationRecordedV1 }
  | { readonly kind: 'explanation.recorded'; readonly version: 2; readonly payload: ExplanationRecordedV2 }
  | { readonly kind: 'explanation.recorded'; readonly version: 3; readonly payload: ExplanationRecordedV3 };

/** Whether a dropped part is one version 1 names. */
const isPartV1 = (part: DroppedPart): part is DroppedPartV1 => part.part === 'conclusion' || part.part === 'account' || part.part === 'finding';
/** Whether a dropped part is one version 2 names. */
const isPartV2 = (part: DroppedPart): part is DroppedPartV2 => part.part === 'conclusion' || part.part === 'areas' || part.part === 'refuted' || part.part === 'finding';
/** Whether a dropped part is one version 3 names. */
const isPartV3 = (part: DroppedPart): part is DroppedPartV3 => part.part === 'conclusion' || part.part === 'areas' || part.part === 'refuted' || part.part === 'finding' || part.part === 'core' || part.part === 'conditions';

/**
 * What `explanation.recorded` records of a merge, at `version`: the writer
 * whose answer completed the unit, or null when the phase degraded
 * without one; the kept answer frozen in the evidence store in the shape
 * of its version, always for a writer that completed the unit and
 * otherwise when it keeps any part; each part dropped with its failures;
 * and the findings marked unexplained.
 */
export function explanationRecord(version: ExplanationVersion, workerId: string | null, merged: MergedAnswer, evidence: Pick<EvidenceStore, 'put'>): ExplanationEvent {
  const answer: ArtifactReference | null = workerId !== null || keptAny(merged) ? evidence.put(`${JSON.stringify(frozenAnswer(version, merged.answer))}\n`) : null;
  const unexplained = merged.answer.findings.filter((finding) => finding.unexplained).map((finding) => finding.id);
  if (version === 3) return { kind: 'explanation.recorded', version: 3, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV3), unexplained } };
  if (version === 2) return { kind: 'explanation.recorded', version: 2, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV2), unexplained } };
  return { kind: 'explanation.recorded', version: 1, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV1), unexplained } };
}

/** What recording or retrying the writer's answer needs beyond the fold: the worktree git reads the commits in, and the evidence store the earlier answers are read from and the kept answer is frozen in. */
export interface ExplanationContext {
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'put' | 'read'>;
}

/** The review of a run that explains it, configured at `review.configured@10` or 11. */
function requireReview(state: RunState): ReviewState {
  if (state.review === null || !state.review.explanationStep) throw new Error(`Run ${state.id} does not explain its review`);
  return state.review;
}

/** The failures of the writer's unit in the phase's current attempt, which a re-entered phase clears. */
const writerUnit = (review: ReviewState): UnitState | undefined => review.units.explanation[singleUnitKey('explanation')];
const writerFailures = (review: ReviewState): readonly UnitFailure[] => writerUnit(review)?.failures ?? [];

/**
 * The answers of the writers whose attempts at the unit failed in the
 * phase's current attempt, in order, as the evidence store froze them,
 * each read in the schema of the run's answer: the earlier answers a later
 * one is merged with. An attempt that ended with no answer, or one a
 * re-entered phase cleared, gives none.
 */
function earlierAnswers(state: RunState, review: ReviewState, evidence: Pick<EvidenceStore, 'read'>): AnyWriterOutput[] {
  const schema = writerOutputSchemaFor(review);
  return writerFailures(review).flatMap((failure) => {
    const worker = Object.hasOwn(state.workers, failure.workerId) ? state.workers[failure.workerId] : undefined;
    if (worker?.status !== 'finished' || worker.finish.output === null) return [];
    const parsed = schema.safeParse(JSON.parse(evidence.read(worker.finish.output).toString('utf8')));
    return parsed.success ? [parsed.data] : [];
  });
}

/** The answers of the unit's earlier attempts and `latest`, checked against the run, in order, the lines of every path their cases cite read at once. */
function checkedAnswers(state: RunState, review: ReviewState, context: { readonly worktree: string; readonly evidence: Pick<EvidenceStore, 'read'> }, ids: readonly string[], latest: AnyWriterOutput | null): CheckedAnswer[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const answers = [...earlierAnswers(state, review, context.evidence), ...(latest === null ? [] : [latest])];
  const cited = answers.flatMap((answer) => answer.findings.flatMap((entry) => entry.explanation?.cases ?? []).map((cited) => cited.lines));
  const citedAt = (side: CitedSide): string[] => cited.filter((lines) => lines.side === side).map((lines) => lines.path);
  const lineCount = gitLineCounts(context.worktree, state.scope, { head: citedAt('head'), base: citedAt('base') });
  const version = explanationVersionOf(review);
  const report = version === 1 ? {} : { report: reportCheckInputOf(review) };
  const core = version === 3 && answers.length > 0 ? { core: coreCheckInputOf(review, state.scope, context.worktree) } : {};
  return answers.map((answer) => checkAnswer(answer, { ids, lineCount, ...report, ...core }));
}

/**
 * What the run holds the core and the conditions of an answer of version 3
 * to (`CoreCheckInput`): the commits of the change, read with git in the
 * worktree from the base and the head the run recorded, so a check of a
 * resumed run sees the same ones (TD3 of the core of the change on the
 * pull request), or null when git cannot read them, which leaves the
 * writer to name the files; the paths of the files the scope captured;
 * the ids of the run's candidates; and the conditions the triage judged
 * to hold.
 */
function coreCheckInputOf(review: ReviewState, scope: ScopeState, worktree: string): CoreCheckInput {
  // A history git cannot read costs the writer its commits as sources, never the run: a source that names one fails its check, and the retry is told why.
  const commits = commitIdsOrNull(worktree, scope.base, scope.head);
  return { commits, files: scope.files.map((file) => file.path), candidates: Object.keys(review.candidates), held: heldConditions(review) };
}

/** The failures of the parts a merge dropped, as one reason of an attempt that failed and as the task of the next names them. */
function droppedWords(dropped: readonly DroppedPart[]): string {
  return dropped.map((part) => `${partNameOf(part)}: ${part.failures.join('; ')}`).join('. ');
}

/**
 * The record of the writer's answer (R18, R19, TD9): the answer merged
 * with the earlier answers of its unit in this attempt of the phase, at
 * the version of the run's answer. When every part passed in some answer,
 * it is recorded; when one did not and the unit has an attempt left, the
 * answer is refused with the failures of each part, and the next writer
 * is given them (`writerTask`); on the unit's last attempt, a part that
 * still fails is dropped, and the answer completes the unit. An attempt
 * after one lost with its engine or stopped from outside is no last
 * attempt: that unit blocks and is given fresh attempts, as every unit
 * is, so an interruption never drops a part. Throws `StructuralCheckError`
 * for an answer refused.
 */
export function writerContribution(state: RunState, receipt: { readonly workerId: string; readonly output: unknown }, context: ExplanationContext & { readonly log: (line: string) => void }): ExplanationEvent {
  const review = requireReview(state);
  const ids = findingsToExplain(review);
  // The launcher held the answer to the schema of the run's version (`writerOutputSchemaFor`).
  const answers = checkedAnswers(state, review, context, ids, receipt.output as AnyWriterOutput);
  const strays = answers.at(-1)!.strays;
  if (strays.length > 0) context.log(`the answer explains ${strays.join(', ')}, which ${strays.length === 1 ? 'is no finding' : 'are no findings'} of the run that asks a person to act; not kept`);
  const version = explanationVersionOf(review);
  const merged = mergeAnswers(version, answers, ids);
  if (merged.dropped.length > 0 && !degradesOnNextFailure(writerUnit(review))) throw new StructuralCheckError(`the answer fails the engine's checks: ${droppedWords(merged.dropped)}`);
  return explanationRecord(version, receipt.workerId, merged, context.evidence);
}

/**
 * The explanation a phase records when it degrades without an answer that
 * completed its unit (R18): its writer failed twice with no answer
 * recorded, or the run budget stopped it. Each part that an earlier answer
 * of this attempt of the phase passed is kept, and every other is dropped
 * with `reason` among its failures, so a step that decides nothing never
 * holds the report back.
 */
export function droppedExplanation(state: RunState, context: ExplanationContext, reason: string): NewEvent {
  const review = requireReview(state);
  const ids = findingsToExplain(review);
  const merged = mergeAnswers(explanationVersionOf(review), checkedAnswers(state, review, context, ids, null), ids, [reason]);
  return explanationRecord(explanationVersionOf(review), null, merged, context.evidence);
}

/** The language the run recorded for its review (R20): `review.language` of its settings, or the default language for a run that recorded none. */
export function reviewLanguage(review: ReviewState): string {
  const values = review.configuration.settings?.values;
  return values !== undefined && 'review.language' in values ? values['review.language'] : defaultLanguage;
}

/** A language tag with its name in English where the platform knows it, as `ko (Korean)`. */
function languageWords(tag: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name === undefined || name === tag ? `\`${tag}\`` : `\`${tag}\` (${name})`;
  } catch {
    return `\`${tag}\``;
  }
}

/** What the writer's task needs beyond the fold: the worktree and the evidence store an earlier answer is read and checked from, the machine whose places and secrets each quoted text is cleaned of, and for an answer of version 3 the commit messages of the change, as the triage was given them (TD7 of the core of the change on the pull request). */
export interface WriterTaskInput {
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'read'>;
  readonly machine: MachineContext;
  readonly commitMessages?: ChangeMessages | null;
}

/** A text fenced so nothing in it can end its fence, as the task embeds what the brief and a cited run printed. */
function fenced(text: string, info = ''): string {
  const fence = fenceFor(text);
  return `${fence}${info}\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`;
}

/**
 * What a decision says, as the writer's task gives it, each text of the
 * decider cleaned: its kind, grounds and part, and for a fix or a finding
 * left as is each choice it settles, the step in words, which is the
 * decision's and not the author's to make, beside the verifiers' choices
 * it answers, and each verifier's choice it leaves unsettled (R5, PD9 of
 * the settled choice).
 */
function decisionLines(decision: RecordedDecision | undefined, choices: readonly CandidateChoice[], clean: (text: string) => string): string[] {
  if (decision === undefined) return ['    decision: none recorded'];
  const grounds = `        grounds: ${clean(decision.grounds)}`;
  const settled = shownChoiceLines(choices, decision.settled, clean, 'settled by the decision');
  switch (decision.decision) {
    case 'fix':
      return [
        `    decision: fix${decision.departure === null ? '' : ', against a written rule'}`,
        grounds,
        `        approach: ${clean(decision.fix.approach)}`,
        ...decision.fix.rejected.map((option) => `        rejected: ${clean(option.option)}, because ${clean(option.reason)}`),
        ...(decision.departure === null ? [] : [`        departs from the rule "${clean(decision.departure.rule)}" (${clean(decision.departure.source)}): ${clean(decision.departure.reason)}`]),
        ...settled,
      ];
    case 'ask':
      return [
        '    decision: ask the author',
        grounds,
        `        question: ${clean(decision.ask.question)}`,
        ...decision.ask.options.map((option, index) => `        option ${String(index + 1)}: ${clean(option.option)}; cost: ${clean(option.cost)}; rule: ${clean(option.rule)}${index === decision.ask.recommended ? '; recommended' : ''}${index === decision.ask.applied ? '; the default deep-review would apply' : ''}`),
      ];
    case 'leave':
      return ['    decision: leave it as it is', grounds, `        reason: ${decision.leave.reason}${decision.leave.supersededBy === null ? '' : `, superseded by ${decision.leave.supersededBy}`}`, ...settled];
  }
}

/** The notes of a verdict as the writer's task gives them, cleaned (R7, R9 of the review that reads as a report): what keeps it from CONFIRMED, and the choice its verifier leaves to the author; none for a verdict recorded without them. */
function noteLines(verdict: CandidateState['verdict'], clean: (text: string) => string): string[] {
  if (verdict === null) return [];
  return [
    ...(verdict.unconfirmed === null ? [] : [`        not CONFIRMED, ${verdict.unconfirmed.kind === 'fact' ? 'a fact not settled' : 'a choice that remains'}: ${clean(verdict.unconfirmed.text)}`]),
    ...(verdict.authorChoice === null ? [] : [`        the choice its verifier leaves to the author: ${clean(verdict.authorChoice)}`]),
  ];
}

/** A candidate as the writer's task gives it: its place and claim, its verdict, and the evidence, runs and notes of its verifier, cleaned. */
function candidateLines(candidate: CandidateState, primary: boolean, clean: (text: string) => string, fence: (text: string) => string): string[] {
  const resolution = resolutionOf(candidate);
  const verdict = resolution === null ? 'no verdict' : resolution.unverified ? `${resolution.verdict}, which no verifier examined` : resolution.verdict;
  return [
    `    - ${candidate.id} (${candidate.angle})${primary ? ', primary,' : ''} at ${clean(describeLocation(candidate))}: ${verdict}`,
    `        summary: ${clean(candidate.summary)}`,
    `        detail: ${clean(candidate.detail)}`,
    `        evidence: ${resolution?.evidence === null || resolution === null ? 'none' : clean(resolution.evidence)}`,
    ...(resolution?.basis === null || resolution === null ? [] : [`        how its verifier established it: ${verdictBasisWords[resolution.basis]}`]),
    ...(resolution?.runs ?? []).flatMap((run) => [`        run: \`${clean(run.command)}\`, ${run.exitCode === null ? 'no exit code on record' : `exit ${String(run.exitCode)}`}, printed:`, fence(run.printed.join('\n'))]),
    ...noteLines(candidate.verdict, clean),
  ];
}

/** What a finding to explain asks of the writer, as its heading gives it: in an answer of version 2, an area for a major one and a kind for a minor one. */
function explainWords(entry: ReportFinding, version: ExplanationVersion): string {
  if (version === 1) return 'explain it';
  return isMajor(entry) ? 'explain it, in an area' : 'explain it, with a kind';
}

/** One ranked finding as the writer's task gives it: its number and id, whether the writer explains it, its severity and verdict, its summary and reason, its decision, and each candidate with its evidence. */
function findingLines(entry: ReportFinding, number: number, explained: string | null, decision: RecordedDecision | undefined, clean: (text: string) => string, fence: (text: string) => string): string[] {
  const verdict = entry.resolution.unverified ? `${entry.resolution.verdict}, which no verifier examined` : entry.resolution.verdict;
  return [
    `#### ${String(number)}. ${entry.finding.id}: ${explained ?? 'context only, not to explain'}`,
    '',
    `    severity: ${entry.finding.severity}; verdict: ${verdict}`,
    `    summary: ${clean(entry.finding.summary)}`,
    `    reason: ${clean(entry.finding.reason)}`,
    ...decisionLines(decision, entry.choices, clean),
    '    candidates:',
    ...[entry.primary, ...entry.members].flatMap((candidate, index) => candidateLines(candidate, index === 0, clean, fence)),
  ];
}

/** A list of ids in a sentence. */
const idList = (ids: readonly string[]): string => ids.join(', ');

/**
 * What an answer of version 2 is asked beyond the findings it explains
 * (R4, R11, R13 of the review that reads as a report): the major findings
 * to put in areas, the minor ones to give a kind, and the refuted
 * candidates to give a line.
 */
function reportAsks(ids: readonly string[], report: ReportCheckInput): string[] {
  const minor = ids.filter((id) => !report.major.includes(id));
  return [
    report.major.length === 0
      ? 'No finding you explain is major, so give `areas` empty.'
      : `Put each of these ${counted(report.major.length, 'major finding', 'major findings')} in exactly one area of \`areas\`, and no other finding in any: ${idList(report.major)}.`,
    ...(minor.length === 0 ? [] : [`Give each of these ${counted(minor.length, 'minor finding', 'minor findings')} a \`kind\`, and every other finding none: ${idList(minor)}.`]),
    report.refuted.length === 0
      ? 'No candidate of this review was refuted, so give `refuted` empty.'
      : `Give one line in \`refuted\` for each of these ${counted(report.refuted.length, 'refuted candidate', 'refuted candidates')}, by its id, and for no other: ${idList(report.refuted)}.`,
  ];
}

/** How a condition of principle 8 is named in the writer's task and answer. */
const conditionWords: Readonly<Record<ChangeConditionName, string>> = { 'public-interface': 'a change to a public interface', 'wide-effect': 'an effect on many files beyond the ones the change changes' };

/**
 * What an answer of version 3 is asked beyond version 2 (R2, R3, R8, PD4,
 * TD7 of the core of the change on the pull request): the commit messages
 * of the change, the triage's account read as an unverified start, and
 * each condition the triage judged to hold, with its sentence and files,
 * to explain in `conditions`, or that `conditions` is empty.
 */
function coreAsks(review: ReviewState, messages: ChangeMessages, clean: (text: string) => string): string[] {
  const held = heldConditions(review);
  const given = changeReadingOf(review.change) !== null;
  const conditions = held.length === 0
    ? [given ? 'The triage judged that the change alters no public interface and does not affect many files beyond the ones it changes, so give `conditions` empty.' : 'The triage gave no account of the change, so it judged no condition: give `conditions` empty.']
    : [
      `The triage judged ${held.length === 1 ? 'this condition' : 'these conditions'} to hold. Give one entry of \`conditions\` for each, by its name, and for no other:`,
      '',
      ...held.map((entry) => `- \`${entry.condition}\`, ${conditionWords[entry.condition]}: ${entry.what === null ? 'the triage gave no sentence' : clean(entry.what)}${entry.files.length === 0 ? '' : ` (files: ${entry.files.map((file) => clean(file)).join(', ')})`}`),
    ];
  return [
    '### The commit messages of the change',
    '',
    'The change\'s own words, as the triage was given them. Take the reason of the core from these and from the documents the change adds or edits, and name each commit in `whyFrom` by its id as it is listed here.',
    '',
    ...commitMessagesSection(messages),
    '',
    '### The core of the change and the conditions',
    '',
    'The brief above opens with the triage\'s account of the change: deep-review\'s earlier reading, written before the review for its other workers, and not verified. Start from it, check each statement against the patch and the code, and never copy it: where the code says otherwise, follow the code.',
    '',
    ...conditions,
    '',
  ];
}

/**
 * The writer's task (R18, R20, TD8 of the review on the pull request; R4,
 * R10, R11, R13, TD2 of the review that reads as a report): the language
 * the run recorded; the findings it explains, and in an answer of version
 * 2 which go in areas, which take a kind and which refuted candidates take
 * a line; the brief of the run in its report form; every ranked finding
 * with its decision, its evidence, the runs its verdict cites and the
 * notes of its verifier; in an answer of version 2, every refuted
 * candidate with its evidence; and, after a refused answer, the parts that
 * still fail with their failures. In an answer of version 3, after the
 * brief, the commit messages of the change and what the core and the
 * conditions start from (`coreAsks`). Each text of a worker is cleaned as
 * the review cleans the text it posts (R11), and the brief and each
 * printed output are fenced. The scope block that follows the task carries
 * the patch. Neither the title nor the body of the pull request is in it
 * (PD8).
 */
export function writerTask(state: RunState, input: WriterTaskInput): string {
  const review = requireReview(state);
  const version = explanationVersionOf(review);
  const ids = findingsToExplain(review);
  const clean = (text: string): string => inlineText(publicWords(text, input.machine).text);
  // Cleaned as code, so its places and secrets give way to their marks and nothing in it is escaped, then fenced longer than any run of backticks the cleaning left.
  const quote = (text: string, info = ''): string => fenced(publicCode(text, input.machine).text, info);
  const numbers = findingNumbers(review);
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const ranked = rankedFindings(review);
  const answers = checkedAnswers(state, review, input, ids, null);
  const dropped = answers.length === 0 ? [] : mergeAnswers(version, answers, ids).dropped;
  const report = version === 1 ? null : reportCheckInputOf(review);
  if (version === 3 && (input.commitMessages === undefined || input.commitMessages === null)) throw new Error('The writer\'s task of an answer with the core of the change lists the commit messages of the change and needs them');
  const core = version === 3 ? coreAsks(review, input.commitMessages!, clean) : [];
  const refutedCandidates = refuted(review);
  return [
    `Write every text of your answer in the language ${languageWords(reviewLanguage(review))}.`,
    '',
    ids.length === 0
      ? `No finding of this review asks a person to act, so you explain none: give the conclusion with no action, ${version === 1 ? 'the account' : 'no area'}, and no entry in \`findings\`.`
      : `Explain these ${counted(ids.length, 'finding', 'findings')}, each by its id, with an action of the conclusion and an entry of \`findings\`: ${ids.join(', ')}. Every other finding below is context, which you explain nowhere.`,
    ...(report === null ? [] : ['', ...reportAsks(ids, report).flatMap((line, index) => (index === 0 ? [line] : ['', line]))]),
    '',
    '### The brief of the run',
    '',
    'The engine\'s account of the run, as its report gives it. The review on the pull request carries its facts in the engine\'s own words.',
    '',
    quote(briefMarkdown(briefOf(state), 'report').join('\n'), 'markdown'),
    '',
    ...core,
    '### The findings',
    '',
    `The review's ${counted(ranked.length, 'finding', 'findings')}, in rank order, each with its decision, every candidate merged into it and its verifier's evidence.${ranked.some((entry) => (decided.get(entry.finding.id)?.settled.length ?? 0) > 0) ? ' A choice a decision settles, on its line `settled by the decision`, is the decision\'s and not the author\'s to make, whatever a verifier\'s note says: explain it as decided.' : ''}`,
    '',
    ...ranked.flatMap((entry) => [...findingLines(entry, numbers.get(entry.finding.id) ?? 0, ids.includes(entry.finding.id) ? explainWords(entry, version) : null, decided.get(entry.finding.id), clean, quote), '']),
    ...(report === null || refutedCandidates.length === 0 ? [] : [
      '### The refuted candidates',
      '',
      `The ${counted(refutedCandidates.length, 'candidate', 'candidates')} the verifiers refuted, each with its claim and its verifier's evidence.`,
      '',
      ...refutedCandidates.flatMap(({ candidate }) => candidateLines(candidate, false, clean, quote)),
      '',
    ]),
    ...(dropped.length === 0 ? [] : [
      '### What failed in the earlier answer',
      '',
      `An earlier writer's answer failed the engine's checks in these parts, and the engine keeps every other part of it. Give your whole answer again: the engine takes from it only these parts, and drops each that fails again.${version !== 1 && dropped.some((part) => part.part === 'conclusion' || part.part === 'areas') ? ' The conclusion and the areas go together, since the conclusion\'s summary names the areas: when either is listed here, the engine takes both from your answer if both pass, so give both so that they pass.' : ''}`,
      '',
      ...dropped.map((part) => `- ${partNameOf(part)}: ${part.failures.map((failure) => inlineText(failure)).join('; ')}`),
      '',
    ]),
    version === 1
      ? 'Return `conclusion`, `account` and `findings`. Your role prompt defines the conclusion and the findings; `account` gives, for a reader who does not know the change, the `terms` a newcomer needs, each with its meaning, the `problem` before the change and the `change` the pull request makes, each with a diagram or null.'
      : version === 2
        ? 'Return `conclusion`, `areas`, `findings` and `refuted` as your role prompt defines them.'
        : 'Return `conclusion`, `areas`, `findings`, `refuted`, `core` and `conditions` as your role prompt defines them.',
  ].join('\n');
}
