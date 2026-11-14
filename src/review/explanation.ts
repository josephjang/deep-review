/**
 * The writer's explanation of the review of a pull request (R18, R19,
 * TD8, TD9 of the review on the pull request; R4, R10, R11, R13, TD2 of
 * the review that reads as a report): which findings it explains, the
 * merge of an answer, checked part by part in `explanation-checks.ts`,
 * with the earlier one of its unit, and what `explanation.recorded`
 * records of them; `writer-task.ts` gives the writer's task. A run
 * configured at `review.configured@13` has its writer answer in the
 * fourth form, in which it writes every sentence of the review (TD1, TD2
 * of the review in the writer's words), recorded at version 4; a run
 * configured at version 12 keeps the third form, which
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
import { recordedTextLengthV1, type DroppedPart, type DroppedPartV1, type DroppedPartV2, type DroppedPartV3, type DroppedPartV4, type ExplanationRecorded, type ExplanationRecordedV1, type ExplanationRecordedV2, type ExplanationRecordedV3, type ExplanationRecordedV4, type ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { explanationVersionOf, type ExplanationVersion, type ReviewState, type UnitFailure, type UnitState } from '../checkpoint/review-fold.ts';
import { defaultLanguage } from '../config/settings.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { commitIdsOrNull } from '../scope/git.ts';
import { StructuralCheckError } from './errors.ts';
import { checkAnswer, checkAnswerV4, gitLineCounts, heldConditions, type AnswerCheckInput, type CheckedAnswer, type CheckedAnswerV4, type CheckedPart, type CoreCheckInput, type DecisionFacts, type ReportCheckInput } from './explanation-checks.ts';
import { writerOutputSchema, writerOutputSchemaOf, writerOutputSchemaV2, writerOutputSchemaV3, writerOutputSchemaV4, type CitedSide, type WriterOutput, type WriterOutputV2, type WriterOutputV3, type WriterOutputV4 } from './schemas.ts';
import { rankedFindings, refuted, type ReportFinding } from './state.ts';
import { degradesOnNextFailure, truncated } from './steps.ts';
import { asksToAct, singleUnitKey, type FindingKind } from './vocabulary.ts';

const writerOutputShape = writerOutputSchema.shape;
const writerOutputShapeV2 = writerOutputSchemaV2.shape;
const writerOutputShapeV3 = writerOutputSchemaV3.shape;
const writerOutputShapeV4 = writerOutputSchemaV4.shape;
const explanationShape = writerOutputShape.findings.element.shape.explanation.unwrap().shape;
const explanationShapeV2 = writerOutputShapeV2.findings.element.shape.explanation.unwrap().shape;
const explanationShapeV4 = writerOutputShapeV4.findings.element.shape.explanation.unwrap().shape;

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

/** The fix of a finding decided `fix`, in the writer's words, in an answer of version 4 (R2 of the review in the writer's words): what it changes and settles, and the text of a departure, or null. */
export type WriterFix = NonNullable<NonNullable<WriterOutputV4['findings'][number]['explanation']>['fix']>;
/** The question of a finding decided `ask`, in the writer's words, in an answer of version 4 (R3 of the review in the writer's words): what is asked, each option by its number, and why deep-review recommends its option. */
export type WriterAsk = NonNullable<NonNullable<WriterOutputV4['findings'][number]['explanation']>['ask']>;
/** The title and the reason of a finding left as is, in an answer of version 4 (R2, PD10 of the review in the writer's words). */
export type LeftLine = WriterOutputV4['left'][number];

/**
 * A finding the writer explained in an answer of version 4 (R2, R3 of the
 * review in the writer's words): the parts of version 3 but its decision,
 * and one sentence of what deep-review would do, why a PLAUSIBLE verdict
 * is not confirmed or null, and the fix in full or the question, the
 * other null.
 */
export interface ExplainedFindingV4 {
  readonly id: string;
  readonly unexplained: false;
  readonly title: string;
  readonly problem: string;
  readonly cases: readonly CitedCase[];
  readonly diagram: string | null;
  readonly checked: string;
  readonly kind: FindingKind | null;
  readonly action: string;
  readonly unconfirmed: string | null;
  readonly fix: WriterFix | null;
  readonly ask: WriterAsk | null;
}
export type FindingExplanationV4 = ExplainedFindingV4 | UnexplainedFinding;

/**
 * The parts of an answer of version 4 that a merge keeps, each null when
 * no answer passed it, and each finding kept in the order of the findings
 * to explain (TD2 of the review in the writer's words).
 */
export interface AnswerV4 {
  readonly core: Core | null;
  readonly conditions: ConditionSentence[] | null;
  readonly summary: string | null;
  readonly areas: Area[] | null;
  readonly findings: FindingExplanationV4[];
  readonly left: LeftLine[] | null;
  readonly refuted: RefutedLine[] | null;
  readonly notExamined: string | null;
}

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

/** The writer's answer as the evidence store freezes it at version 4, the reference `explanation.recorded@4` holds: `AnswerV4`, each part null when dropped, and a dropped finding with no entry. */
export const recordedAnswerSchemaV4 = z.strictObject({
  core: writerOutputShapeV4.core.nullable(),
  conditions: writerOutputShapeV4.conditions.nullable(),
  summary: writerOutputShapeV4.summary.nullable(),
  areas: writerOutputShapeV4.areas.nullable(),
  findings: z.array(z.discriminatedUnion('unexplained', [z.strictObject({ id: z.string(), unexplained: z.literal(false), ...explanationShapeV4 }), unexplainedFindingSchema])),
  left: writerOutputShapeV4.left.nullable(),
  refuted: writerOutputShapeV4.refuted.nullable(),
  notExamined: writerOutputShapeV4.notExamined.nullable(),
}) satisfies z.ZodType<AnswerV4>;

/** The answer `explanation.recorded@4` froze, or null when no answer passed any part. */
export function frozenAnswerV4Of(recorded: Pick<ExplanationRecorded, 'answer' | 'version'>, evidence: Pick<EvidenceStore, 'read'>): AnswerV4 | null {
  if (recorded.version !== 4) throw new Error(`An explanation recorded at version ${String(recorded.version)} froze no answer of version 4`);
  if (recorded.answer === null) return null;
  return recordedAnswerSchemaV4.parse(JSON.parse(evidence.read(recorded.answer).toString('utf8')));
}

/**
 * The answer a merge of answers of version 1 to 3 keeps, in the shape of
 * its version's parts: each part an answer passed, and null for a part
 * dropped or one its version does not have. The account is an answer of
 * version 1's alone; the areas, the refuted lines and each finding's
 * `checked` and `kind` are an answer of version 2's or 3's; the core and
 * the conditions are an answer of version 3's alone.
 */
export interface OlderAnswer {
  readonly conclusion: Conclusion | null;
  readonly account: Account | null;
  readonly areas: Area[] | null;
  readonly refuted: RefutedLine[] | null;
  readonly core: Core | null;
  readonly conditions: ConditionSentence[] | null;
  readonly findings: FindingExplanation[];
}

/**
 * A finding the writer explained, as the form reads it from an answer of
 * any version (TD5 of the review in the writer's words): the parts of
 * version 4, each null that the answer's version does not have, so the
 * form treats a part an older answer lacks as one the checks dropped.
 */
export interface RecordedFinding {
  readonly id: string;
  readonly unexplained: false;
  readonly title: string;
  readonly problem: string;
  readonly cases: readonly CitedCase[];
  readonly diagram: string | null;
  readonly checked: string | null;
  readonly kind: FindingKind | null;
  readonly action: string | null;
  readonly unconfirmed: string | null;
  readonly fix: WriterFix | null;
  readonly ask: WriterAsk | null;
}

/**
 * The writer's answer as the form reads it, whatever version froze it
 * (R10, TD5 of the review in the writer's words): the parts of version 4,
 * each null when the answer has none, because the checks dropped it or
 * its version does not have it. `recordedAnswerOf` reads an answer of
 * any version into it, so the form has no branch by version.
 */
export interface RecordedAnswer {
  readonly core: Core | null;
  readonly conditions: readonly ConditionSentence[] | null;
  readonly summary: string | null;
  readonly areas: readonly Area[] | null;
  readonly findings: readonly (RecordedFinding | UnexplainedFinding)[];
  readonly left: readonly LeftLine[] | null;
  readonly refuted: readonly RefutedLine[] | null;
  readonly notExamined: string | null;
}

/**
 * The recorded answer of an explanation, read by the version of its event
 * into the one shape the form reads (TD5 of the review in the writer's
 * words), or null when no answer passed any part. An answer of version 4
 * is that shape. From an older one it takes what the older version
 * holds: from version 3 the core and the conditions; from versions 2 and
 * 3 the areas, the refuted lines and each finding's `checked` and `kind`;
 * from every version the summary, as `conclusion.why`, and each finding's
 * title, problem, cases and diagram, with its sentence of what
 * deep-review would do from `conclusion.actions` when `review` decided
 * the finding `fix`. The sentence of a question, which the checks of
 * versions 1 to 3 did not hold, and the account of version 1 are not
 * taken.
 */
export function recordedAnswerOf(recorded: Pick<ExplanationRecorded, 'answer' | 'version'>, evidence: Pick<EvidenceStore, 'read'>, review: Pick<ReviewState, 'decisions'>): RecordedAnswer | null {
  if (recorded.answer === null) return null;
  if (recorded.version === 4) return frozenAnswerV4Of(recorded, evidence);
  const frozen: unknown = JSON.parse(evidence.read(recorded.answer).toString('utf8'));
  const older: OlderAnswer = recorded.version === 3
    ? { ...recordedAnswerSchemaV3.parse(frozen), account: null }
    : recorded.version === 2
      ? { ...recordedAnswerSchemaV2.parse(frozen), account: null, core: null, conditions: null }
      : (({ findings, ...answer }) => ({ ...answer, areas: null, refuted: null, core: null, conditions: null, findings: findings.map((finding) => (finding.unexplained ? finding : { ...finding, checked: null, kind: null })) }))(recordedAnswerSchema.parse(frozen));
  const fixes = new Set((review.decisions ?? []).filter((decision) => decision.decision === 'fix').map((decision) => decision.id));
  const actionOf = (id: string): string | null => (fixes.has(id) ? older.conclusion?.actions.find((action) => action.id === id)?.sentence ?? null : null);
  return {
    core: older.core,
    conditions: older.conditions,
    summary: older.conclusion?.why ?? null,
    areas: older.areas,
    findings: older.findings.map((finding): RecordedFinding | UnexplainedFinding => (finding.unexplained ? finding : {
      id: finding.id,
      unexplained: false,
      title: finding.title,
      problem: finding.problem,
      cases: finding.cases,
      diagram: finding.diagram,
      checked: finding.checked,
      kind: finding.kind,
      action: actionOf(finding.id),
      unconfirmed: null,
      fix: null,
      ask: null,
    })),
    left: null,
    refuted: older.refuted,
    notExamined: null,
  };
}

/** The answer as the evidence store freezes it at `version`: the parts that version has, each finding in its shape. */
function frozenAnswer(version: ExplanationVersion, { conclusion, account, areas, refuted: lines, core, conditions, findings }: OlderAnswer): object {
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
export const isMajor = (entry: ReportFinding): boolean => entry.finding.severity !== 'minor';

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
export type PartName = 'conclusion' | 'account' | 'areas' | 'refuted' | 'core' | 'conditions' | 'left' | 'not-examined' | `finding ${string}`;

/** The most failures a dropped part records, as `explanation.recorded` holds them. */
const maxPartFailures = 100;

/** The failures a dropped part records: the latest answer's, then `extra`, each cut to what the ledger holds; a part no answer gave at all says so. */
function recordedFailures(failures: readonly string[], extra: readonly string[]): string[] {
  const all = [...failures, ...extra];
  return (all.length === 0 ? ['no answer of the writer gave it'] : all).slice(0, maxPartFailures).map((failure) => truncated(failure, recordedTextLengthV1));
}

/** Whether an answer passed a part: it gave the part, and the part passed every check. */
const passes = <T>(part: CheckedPart<T> | null): part is CheckedPart<T> => part !== null && part.value !== null && part.failures.length === 0;

/** Take a part from the first answer that passed it, or drop it: `null` stands for an answer that does not give the part. */
type PickPart = <T>(parts: readonly (CheckedPart<T> | null)[], drop: (failures: string[]) => DroppedPart) => T | null;

/**
 * What a merge of a unit's answers, of any version, takes each part with,
 * and the parts it dropped, in the order it picked them: a part is taken
 * from the first answer that passed it, and a part that no answer passed
 * is dropped with the failures of the latest answer that gave it and
 * `extra`.
 */
function merger(extra: readonly string[]): { readonly pick: PickPart; readonly dropped: readonly DroppedPart[] } {
  const dropped: DroppedPart[] = [];
  const pick: PickPart = <T>(parts: readonly (CheckedPart<T> | null)[], drop: (failures: string[]) => DroppedPart): T | null => {
    const given = parts.filter((part): part is CheckedPart<T> => part !== null);
    const passed = given.find(passes);
    if (passed !== undefined) return passed.value;
    dropped.push(drop(recordedFailures(given.at(-1)?.failures ?? [], extra)));
    return null;
  };
  return { pick, dropped };
}

/**
 * The answers the summary and the areas are taken from, as one answer
 * since the summary names the areas: the first that passed both, else the
 * first that passed the areas, whose summary then failed; with none, every
 * answer, so the summary is taken as any other part.
 */
function summarySource<A extends { readonly conclusion: CheckedPart<unknown> | null; readonly areas: CheckedPart<unknown> | null }>(answers: readonly A[]): readonly A[] {
  const from = answers.find((answer) => passes(answer.conclusion) && passes(answer.areas)) ?? answers.find((answer) => passes(answer.areas));
  return from === undefined ? answers : [from];
}

/** What the merge of a unit's answers keeps, and each part none of them passed. */
export interface MergedAnswer {
  readonly answer: OlderAnswer;
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
export function mergeAnswers(version: Exclude<ExplanationVersion, 4>, answers: readonly CheckedAnswer[], ids: readonly string[], extra: readonly string[] = []): MergedAnswer {
  const { pick, dropped } = merger(extra);
  const pairedSource = version === 1 ? answers : summarySource(answers);
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

/** What the merge of a unit's answers of version 4 keeps, and each part none of them passed. */
export interface MergedAnswerV4 {
  readonly answer: AnswerV4;
  readonly dropped: readonly DroppedPart[];
}

/**
 * The answers of version 4 of one unit merged, in the order they were
 * given (TD2 of the review in the writer's words), as `mergeAnswers`
 * merges an answer of version 3: each part taken from the first answer
 * that passed it, and a part that no answer passed dropped with the
 * failures of the latest answer and `extra`. Each finding, with its
 * sentence of what deep-review would do and the text of its decision,
 * is one part, so a failure in it drops that finding alone. The summary
 * keeps the part name `conclusion` and, since it names the areas, is taken
 * with them from one answer when one passed both; when no answer passed the
 * areas, it is taken from the first answer that passed it, and the view
 * then withholds it.
 */
export function mergeAnswersV4(answers: readonly CheckedAnswerV4[], ids: readonly string[], extra: readonly string[] = []): MergedAnswerV4 {
  const { pick, dropped } = merger(extra);
  const pairedSource = summarySource(answers);
  const summary = pick(pairedSource.map((answer) => answer.conclusion), (failures) => ({ part: 'conclusion', failures }));
  const areas = pick(pairedSource.map((answer) => answer.areas), (failures) => ({ part: 'areas', failures }));
  const core = pick(answers.map((answer) => answer.core), (failures) => ({ part: 'core', failures }));
  const conditions = pick(answers.map((answer) => answer.conditions), (failures) => ({ part: 'conditions', failures }));
  const findings = ids.flatMap((id) => {
    const kept = pick(answers.map((answer) => answer.findings.get(id)!), (failures) => ({ part: 'finding', finding: id, failures }));
    return kept === null ? [] : [kept];
  });
  const left = pick(answers.map((answer) => answer.left), (failures) => ({ part: 'left', failures }));
  const lines = pick(answers.map((answer) => answer.refuted), (failures) => ({ part: 'refuted', failures }));
  const notExamined = pick(answers.map((answer) => answer.notExamined), (failures) => ({ part: 'not-examined', failures }));
  return { answer: { core, conditions, summary, areas, findings, left, refuted: lines, notExamined }, dropped };
}

/** Whether the merge kept any part. */
const keptAny = ({ answer }: MergedAnswer): boolean => answer.conclusion !== null || answer.account !== null || answer.areas !== null || answer.refuted !== null || answer.core !== null || answer.conditions !== null || answer.findings.length > 0;

/** A dropped part by its name, as the reason of a refused answer and the next writer's task give it: `conclusion`, `account`, `areas`, `refuted`, `core`, `conditions`, `left`, `not-examined` or `finding <id>`. */
export const partNameOf = (part: DroppedPart): PartName => (part.part === 'finding' ? `finding ${part.finding}` : part.part);

/** The event that records a writer's explanation, at the version of its answer, typed as a pair. */
export type ExplanationEvent =
  | { readonly kind: 'explanation.recorded'; readonly version: 1; readonly payload: ExplanationRecordedV1 }
  | { readonly kind: 'explanation.recorded'; readonly version: 2; readonly payload: ExplanationRecordedV2 }
  | { readonly kind: 'explanation.recorded'; readonly version: 3; readonly payload: ExplanationRecordedV3 }
  | { readonly kind: 'explanation.recorded'; readonly version: 4; readonly payload: ExplanationRecordedV4 };

/** Whether a dropped part is one version 1 names. */
const isPartV1 = (part: DroppedPart): part is DroppedPartV1 => part.part === 'conclusion' || part.part === 'account' || part.part === 'finding';
/** Whether a dropped part is one version 2 names. */
const isPartV2 = (part: DroppedPart): part is DroppedPartV2 => part.part === 'conclusion' || part.part === 'areas' || part.part === 'refuted' || part.part === 'finding';
/** Whether a dropped part is one version 3 names. */
const isPartV3 = (part: DroppedPart): part is DroppedPartV3 => part.part === 'conclusion' || part.part === 'areas' || part.part === 'refuted' || part.part === 'finding' || part.part === 'core' || part.part === 'conditions';
/** Whether a dropped part is one version 4 names: any but the account. */
const isPartV4 = (part: DroppedPart): part is DroppedPartV4 => part.part !== 'account';

/**
 * What `explanation.recorded` records of a merge, at `version`: the writer
 * whose answer completed the unit, or null when the phase degraded
 * without one; the kept answer frozen in the evidence store in the shape
 * of its version, always for a writer that completed the unit and
 * otherwise when it keeps any part; each part dropped with its failures;
 * and the findings marked unexplained.
 */
export function explanationRecord(version: Exclude<ExplanationVersion, 4>, workerId: string | null, merged: MergedAnswer, evidence: Pick<EvidenceStore, 'put'>): ExplanationEvent {
  const answer: ArtifactReference | null = workerId !== null || keptAny(merged) ? evidence.put(`${JSON.stringify(frozenAnswer(version, merged.answer))}\n`) : null;
  const unexplained = merged.answer.findings.filter((finding) => finding.unexplained).map((finding) => finding.id);
  if (version === 3) return { kind: 'explanation.recorded', version: 3, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV3), unexplained } };
  if (version === 2) return { kind: 'explanation.recorded', version: 2, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV2), unexplained } };
  return { kind: 'explanation.recorded', version: 1, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV1), unexplained } };
}

/** Whether the merge of answers of version 4 kept any part. */
const keptAnyV4 = ({ answer }: MergedAnswerV4): boolean => answer.core !== null || answer.conditions !== null || answer.summary !== null || answer.areas !== null || answer.findings.length > 0 || answer.left !== null || answer.refuted !== null || answer.notExamined !== null;

/**
 * What `explanation.recorded@4` records of a merge of answers of version
 * 4 (TD2 of the review in the writer's words), as `explanationRecord`
 * records an older one: the writer whose answer completed the unit, or
 * null; the kept answer frozen as `AnswerV4`, each part null that no
 * answer passed; each part dropped with its failures; and the findings
 * marked unexplained.
 */
export function explanationRecordV4(workerId: string | null, merged: MergedAnswerV4, evidence: Pick<EvidenceStore, 'put'>): ExplanationEvent {
  const answer: ArtifactReference | null = workerId !== null || keptAnyV4(merged) ? evidence.put(`${JSON.stringify(merged.answer)}\n`) : null;
  const unexplained = merged.answer.findings.filter((finding) => finding.unexplained).map((finding) => finding.id);
  return { kind: 'explanation.recorded', version: 4, payload: { workerId, answer, dropped: merged.dropped.filter(isPartV4), unexplained } };
}

/** What recording or retrying the writer's answer needs beyond the fold: the worktree git reads the commits in, and the evidence store the earlier answers are read from and the kept answer is frozen in. */
export interface ExplanationContext {
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'put' | 'read'>;
}

/** The review of a run that explains it, configured at `review.configured@10` or 11. */
export function requireReview(state: RunState): ReviewState {
  if (state.review === null || !state.review.explanationStep) throw new Error(`Run ${state.id} does not explain its review`);
  return state.review;
}

/** The failures of the writer's unit in the phase's current attempt, which a re-entered phase clears. */
const writerUnit = (review: ReviewState): UnitState | undefined => review.units.explanation[singleUnitKey('explanation')];
const writerFailures = (review: ReviewState): readonly UnitFailure[] => writerUnit(review)?.failures ?? [];

/**
 * The answers of the writers whose attempts at the unit failed in the
 * phase's current attempt, in order, as the evidence store froze them,
 * each that parses in `schema`, the schema of the run's answer: the
 * earlier answers a later one is merged with. An attempt that ended with
 * no answer, or one a re-entered phase cleared, gives none.
 */
function earlierAnswers<T>(state: RunState, review: ReviewState, evidence: Pick<EvidenceStore, 'read'>, schema: z.ZodType<T>): T[] {
  return writerFailures(review).flatMap((failure) => {
    const worker = Object.hasOwn(state.workers, failure.workerId) ? state.workers[failure.workerId] : undefined;
    if (worker?.status !== 'finished' || worker.finish.output === null) return [];
    const parsed = schema.safeParse(JSON.parse(evidence.read(worker.finish.output).toString('utf8')));
    return parsed.success ? [parsed.data] : [];
  });
}

/** An answer of any version, as far as the lines its cases cite. */
interface CitingAnswer {
  readonly findings: readonly { readonly explanation: { readonly cases: readonly { readonly lines: { readonly side: CitedSide; readonly path: string } }[] } | null }[];
}

/** The line counts of every path the cases of `answers` cite, read at once on the side each cites. */
function citedLineCounts(worktree: string, scope: ScopeState, answers: readonly CitingAnswer[]): AnswerCheckInput['lineCount'] {
  const cited = answers.flatMap((answer) => answer.findings.flatMap((entry) => entry.explanation?.cases ?? []).map((cited) => cited.lines));
  const citedAt = (side: CitedSide): string[] => cited.filter((lines) => lines.side === side).map((lines) => lines.path);
  return gitLineCounts(worktree, scope, { head: citedAt('head'), base: citedAt('base') });
}

/** The answers of the unit's earlier attempts and `latest`, checked against the run, in order, the lines of every path their cases cite read at once. */
export function checkedAnswers(state: RunState, review: ReviewState, context: { readonly worktree: string; readonly evidence: Pick<EvidenceStore, 'read'> }, ids: readonly string[], latest: AnyWriterOutput | null): CheckedAnswer[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const version = explanationVersionOf(review);
  if (version === 4) throw new Error(`Run ${state.id} has its writer answer in the fourth form, whose answers \`checkedAnswersV4\` reads`);
  const answers = [...earlierAnswers<AnyWriterOutput>(state, review, context.evidence, writerOutputSchemaOf(version)), ...(latest === null ? [] : [latest])];
  const lineCount = citedLineCounts(context.worktree, state.scope, answers);
  const report = version === 1 ? {} : { report: reportCheckInputOf(review) };
  const core = version === 3 && answers.length > 0 ? { core: coreCheckInputOf(review, state.scope, context.worktree) } : {};
  return answers.map((answer) => checkAnswer(answer, { ids, lineCount, ...report, ...core }));
}

/** The findings left as is, by id in rank order: each ranked finding that does not ask a person to act, which an answer of version 4 gives a title and a reason (R2, PD10 of the review in the writer's words). */
export function findingsLeftAsIs(review: ReviewState): string[] {
  const acting = new Set(findingsToExplain(review));
  return rankedFindings(review).map((entry) => entry.finding.id).filter((id) => !acting.has(id));
}

/**
 * What the decision of each finding to explain holds an answer of version
 * 4 to (`DecisionFacts`): a fix or a question; whether the fix departs from
 * a written rule; the count of options the question records; and whether
 * a verifier examined the finding's PLAUSIBLE verdict and recorded why it
 * is not confirmed. The decision as decided, which no answer changes (R6
 * of the review in the writer's words).
 */
export function decisionFactsOf(review: ReviewState): Map<string, DecisionFacts> {
  const acting = new Set(findingsToExplain(review));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  return new Map(rankedFindings(review).flatMap((entry): [string, DecisionFacts][] => {
    const decision = decided.get(entry.finding.id);
    if (!acting.has(entry.finding.id) || decision === undefined || decision.decision === 'leave') return [];
    const { resolution } = entry;
    return [[entry.finding.id, {
      decision: decision.decision,
      departs: decision.decision === 'fix' && decision.departure !== null,
      options: decision.decision === 'ask' ? decision.ask.options.length : 0,
      unconfirmed: resolution.verdict === 'PLAUSIBLE' && !resolution.unverified && resolution.unconfirmed !== null,
    }]];
  }));
}

/**
 * Answers of version 4 checked against the run, in order, the lines of
 * every path their cases cite read at once: the answers of the unit's
 * earlier attempts that parse at version 4, then `latest`. The replay of
 * the writer gives a run whose unit has no earlier attempt, and the
 * answers its own writers gave.
 */
export function checkedAnswersV4(state: RunState, review: ReviewState, context: { readonly worktree: string; readonly evidence: Pick<EvidenceStore, 'read'> }, ids: readonly string[], latest: readonly WriterOutputV4[]): CheckedAnswerV4[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const answers = [...earlierAnswers(state, review, context.evidence, writerOutputSchemaV4), ...latest];
  if (answers.length === 0) return [];
  const input = { ids, lineCount: citedLineCounts(context.worktree, state.scope, answers), report: reportCheckInputOf(review), core: coreCheckInputOf(review, state.scope, context.worktree), decided: decisionFactsOf(review), left: findingsLeftAsIs(review) };
  return answers.map((answer) => checkAnswerV4(answer, input));
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
  const version = explanationVersionOf(review);
  const logStrays = (strays: readonly string[]): void => {
    if (strays.length > 0) context.log(`the answer explains ${strays.join(', ')}, which ${strays.length === 1 ? 'is no finding' : 'are no findings'} of the run that asks a person to act; not kept`);
  };
  // The launcher held the answer to the schema of the run's version (`writerOutputSchemaFor`).
  if (version === 4) {
    const answers = checkedAnswersV4(state, review, context, ids, [receipt.output as WriterOutputV4]);
    logStrays(answers.at(-1)!.strays);
    const merged = mergeAnswersV4(answers, ids);
    refuseOnFailure(review, merged.dropped);
    return explanationRecordV4(receipt.workerId, merged, context.evidence);
  }
  const answers = checkedAnswers(state, review, context, ids, receipt.output as AnyWriterOutput);
  logStrays(answers.at(-1)!.strays);
  const merged = mergeAnswers(version, answers, ids);
  refuseOnFailure(review, merged.dropped);
  return explanationRecord(version, receipt.workerId, merged, context.evidence);
}

/** Refuse an answer a part of which no answer passed, while the writer's unit has an attempt left; on its last attempt, the part is dropped instead. */
function refuseOnFailure(review: ReviewState, dropped: readonly DroppedPart[]): void {
  if (dropped.length > 0 && !degradesOnNextFailure(writerUnit(review))) throw new StructuralCheckError(`the answer fails the engine's checks: ${droppedWords(dropped)}`);
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
  const version = explanationVersionOf(review);
  if (version === 4) return explanationRecordV4(null, mergeAnswersV4(checkedAnswersV4(state, review, context, ids, []), ids, [reason]), context.evidence);
  return explanationRecord(version, null, mergeAnswers(version, checkedAnswers(state, review, context, ids, null), ids, [reason]), context.evidence);
}

/** The language the run recorded for its review (R20): `review.language` of its settings, or the default language for a run that recorded none. */
export function reviewLanguage(review: ReviewState): string {
  const values = review.configuration.settings?.values;
  return values !== undefined && 'review.language' in values ? values['review.language'] : defaultLanguage;
}
