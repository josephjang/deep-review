/**
 * The writer's explanation of the review of a pull request (R18, R19,
 * TD8, TD9 of the review on the pull request; R4, R10, R11, R13, TD2 of
 * the review that reads as a report): which findings it explains, the
 * checks the engine can count in its answer, part by part, the merge of
 * an answer with the earlier one of its unit, what `explanation.recorded`
 * records of them, and the writer's task. A run configured at
 * `review.configured@11` has its writer answer in the second form, with
 * the areas and the refuted lines and no account, recorded at version 2;
 * a run configured before keeps the first, at version 1. The answer as
 * the evidence store freezes it reads as one `RecordedAnswer` whatever
 * its version, which the form of the pull request renders beside the
 * ledger's own words.
 */
import { z } from 'zod';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import { recordedTextLengthV1, type DroppedPart, type DroppedPartV1, type DroppedPartV2, type ExplanationRecorded, type ExplanationRecordedV1, type ExplanationRecordedV2, type CandidateChoice, type RecordedDecision, type ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { CandidateState, ReviewState, UnitFailure, UnitState } from '../checkpoint/review-fold.ts';
import { defaultLanguage } from '../config/settings.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { blobsRaw, treeEntries, type TreeEntry } from '../scope/git.ts';
import { briefMarkdown, briefOf } from './brief.ts';
import { StructuralCheckError } from './errors.ts';
import { counted, inlineText } from './markdown.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicWords, type MachineContext } from './public-text.ts';
import { writerOutputSchema, writerOutputSchemaV2, type CitedSide, type WriterOutput, type WriterOutputV2 } from './schemas.ts';
import { findingNumbers, rankedFindings, refuted, resolutionOf, shownChoiceLines, type ReportFinding } from './state.ts';
import { degradesOnNextFailure, truncated } from './steps.ts';
import { describeLocation } from './tasks.ts';
import { asksToAct, singleUnitKey, verdictBasisWords, verdicts, type FindingKind } from './vocabulary.ts';

const writerOutputShape = writerOutputSchema.shape;
const writerOutputShapeV2 = writerOutputSchemaV2.shape;
const explanationShape = writerOutputShape.findings.element.shape.explanation.unwrap().shape;
const explanationShapeV2 = writerOutputShapeV2.findings.element.shape.explanation.unwrap().shape;

/** The version of the writer's answer, which is the version of `explanation.recorded` that records it: 2 in a run whose review reads as a report, 1 before. */
export type AnswerVersion = 1 | 2;

/** The version of the writer's answer a run asks for, by its configuration, also when this engine resumes it. */
export const answerVersionOf = (review: Pick<ReviewState, 'reportForm'>): AnswerVersion => (review.reportForm ? 2 : 1);

/** The writer's answer as it gave it, of either version. */
export type AnyWriterOutput = WriterOutput | WriterOutputV2;

/** The conclusion as the writer gives it: why the pull request needs what it needs, a sentence for each action by the id of its finding, and a diagram or none. */
export type Conclusion = WriterOutput['conclusion'];
/** The account of the pull request, which only an answer of version 1 gives: the terms a newcomer needs, the problem before the change and the change, each with a diagram or none. */
export type Account = WriterOutput['account'];
/** An area of the major findings that ask a person to act (R4 of the review that reads as a report): a title that says what goes wrong for whom, an intro of one or two sentences, a diagram or none, and the ids of its findings. */
export type Area = WriterOutputV2['areas'][number];
/** The line of a refuted candidate (R11 of the review that reads as a report): its id, one sentence of its claim and one of why it was refuted. */
export type RefutedLine = WriterOutputV2['refuted'][number];
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

/**
 * The writer's answer as the form reads it, whatever version froze it:
 * each part an answer passed, and null for a part dropped or one its
 * version does not have. The account is an answer of version 1's alone;
 * the areas, the refuted lines and each finding's `checked` and `kind`
 * are an answer of version 2's alone. `recordedAnswerOf` gives every
 * part for an answer of either version.
 */
export interface RecordedAnswer {
  readonly conclusion: Conclusion | null;
  readonly account: Account | null;
  readonly areas: Area[] | null;
  readonly refuted: RefutedLine[] | null;
  readonly findings: FindingExplanation[];
}

/** The recorded answer of an explanation, read by the version of its event, as the form reads it, or null when no answer passed any part. */
export function recordedAnswerOf(recorded: Pick<ExplanationRecorded, 'answer' | 'version'>, evidence: Pick<EvidenceStore, 'read'>): RecordedAnswer | null {
  if (recorded.answer === null) return null;
  const frozen: unknown = JSON.parse(evidence.read(recorded.answer).toString('utf8'));
  if (recorded.version === 2) return { ...recordedAnswerSchemaV2.parse(frozen), account: null };
  const answer = recordedAnswerSchema.parse(frozen);
  return { ...answer, areas: null, refuted: null, findings: answer.findings.map((finding) => (finding.unexplained ? finding : { ...finding, checked: null, kind: null })) };
}

/** The answer as the evidence store freezes it at `version`: the parts that version has, each finding in its shape. */
function frozenAnswer(version: AnswerVersion, { conclusion, account, areas, refuted: lines, findings }: RecordedAnswer): object {
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

/**
 * What an answer of version 2 is held to beyond the findings it explains
 * (R4, R11, R13 of the review that reads as a report): the findings to
 * explain that are major, by id in rank order, which go in the areas, the
 * others being minor and given a kind; the findings to explain that are
 * questions, by id in rank order, whose sentence in the conclusion the
 * form does not post; and the refuted candidates, by id, which each have
 * one line.
 */
export interface ReportCheckInput {
  readonly major: readonly string[];
  readonly asks: readonly string[];
  readonly refuted: readonly string[];
}

/** What the run holds an answer of version 2 to (`ReportCheckInput`). */
export function reportCheckInputOf(review: ReviewState): ReportCheckInput {
  const ids = new Set(findingsToExplain(review));
  return {
    major: rankedFindings(review).filter((entry) => ids.has(entry.finding.id) && isMajor(entry)).map((entry) => entry.finding.id),
    asks: (review.decisions ?? []).filter((decision) => ids.has(decision.id) && decision.decision === 'ask').map((decision) => decision.id),
    refuted: refuted(review).map(({ candidate }) => candidate.id),
  };
}

/** A part of the answer as `explanation.recorded` names a dropped one: the conclusion, the account, the areas, the refuted lines, or `finding <id>`. */
export type PartName = 'conclusion' | 'account' | 'areas' | 'refuted' | `finding ${string}`;

/** One part of an answer with the failures of its checks: kept when it has a value and no failure. */
export interface CheckedPart<T> {
  readonly value: T | null;
  readonly failures: readonly string[];
}

/**
 * An answer checked part by part (TD9): its conclusion; the account of an
 * answer of version 1, or the areas and the refuted lines of one of
 * version 2, each null in the other; and its explanation of each finding
 * to explain, by id.
 */
export interface CheckedAnswer {
  readonly conclusion: CheckedPart<Conclusion>;
  readonly account: CheckedPart<Account> | null;
  readonly areas: CheckedPart<Area[]> | null;
  readonly refuted: CheckedPart<RefutedLine[]> | null;
  readonly findings: ReadonlyMap<string, CheckedPart<FindingExplanation>>;
  /** The ids of the entries of `findings` that name no finding to explain: refused, so never kept, and they cost no part. */
  readonly strays: readonly string[];
}

/** What the checks read beyond the answer: the findings to explain, the count of lines of a path at a side, or null when its commit holds no such file, and for an answer of version 2 what the run holds it to. */
export interface AnswerCheckInput {
  readonly ids: readonly string[];
  readonly lineCount: (side: CitedSide, path: string) => number | null;
  readonly report?: ReportCheckInput;
}

/** The count of lines a file holds: each line feed ends one, and text after the last is one more. */
export function lineCountOf(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? count + 1 : count;
}

/** A path from the root of the repository, as git names a file: no root, no drive, no backslash, no NUL, which git cannot be given and no file name holds, and no empty, `.` or `..` name. */
const repositoryPath = (path: string): boolean => path !== '' && !path.includes('\\') && !path.includes('\0') && !/^[A-Za-z]:/.test(path) && path.split('/').every((name) => name !== '' && name !== '.' && name !== '..');

/** The most characters of paths one `git ls-tree` of `gitLineCounts` is given, well inside the shortest command line a platform takes. */
const maxPathCharacters = 8000;

/**
 * The count of lines of a path at a side, read with git at the commit of
 * the side, the head or the merge base the run recorded, so a resume in a
 * worktree that moved checks the same lines; null when that commit holds
 * no regular file at the path. Each path and commit is read once. The
 * first count asked of a side reads every path of `paths` for that side
 * at once, with one `git ls-tree` for each few thousand characters of
 * paths and one `git cat-file --batch`; a path outside them is read alone.
 */
export function gitLineCounts(worktree: string, scope: Pick<ScopeState, 'base' | 'head'>, paths: Readonly<Partial<Record<CitedSide, readonly string[]>>> = {}): AnswerCheckInput['lineCount'] {
  const counts = new Map<string, number | null>();
  const read = (commit: string, wanted: readonly string[]): void => {
    const entries = new Map<string, TreeEntry>();
    for (let from = 0; from < wanted.length;) {
      let to = from + 1;
      for (let length = wanted[from]!.length; to < wanted.length && length + wanted[to]!.length <= maxPathCharacters; to += 1) length += wanted[to]!.length;
      for (const [path, entry] of treeEntries(worktree, commit, wanted.slice(from, to))) entries.set(path, entry);
      from = to;
    }
    const file = (path: string): TreeEntry | undefined => {
      const entry = entries.get(path);
      return entry?.mode.startsWith('100') ? entry : undefined;
    };
    const blobs = blobsRaw(worktree, wanted.flatMap((path) => file(path)?.objectId ?? []));
    for (const path of wanted) {
      const entry = file(path);
      counts.set(`${commit}:${path}`, entry === undefined ? null : lineCountOf(blobs.get(entry.objectId)!));
    }
  };
  const prefilled = new Set<CitedSide>();
  return (side, path) => {
    const commit = side === 'head' ? scope.head : scope.base;
    if (!prefilled.has(side)) {
      prefilled.add(side);
      read(commit, [...new Set(paths[side] ?? [])].filter((given) => repositoryPath(given) && !counts.has(`${commit}:${given}`)));
    }
    const key = `${commit}:${path}`;
    if (!counts.has(key)) read(commit, [path]);
    return counts.get(key)!;
  };
}

/** Each verdict of the review, which no part may hold as a word in upper case: the engine writes the verdict beside each finding (R19). */
const verdictWord = new RegExp(`\\b(${verdicts.join('|')})\\b`, 'g');

/** The failures of the texts of a part that hold a verdict of the review, each verdict once. */
function verdictFailures(what: string, texts: readonly string[]): string[] {
  const found = new Set(texts.flatMap((text) => [...text.matchAll(verdictWord)].map((match) => match[1]!)));
  return [...found].map((verdict) => `${what} holds the verdict ${verdict}, which the engine writes beside the finding`);
}

const blank = (text: string): boolean => text.trim() === '';

/** An HTML entity, named or numbered, which GitHub decodes before Mermaid reads a diagram. */
const htmlEntity = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

/** The failures of one label, message or note of a diagram: an HTML entity, or a semicolon outside one. */
function labelFailures(what: string, text: string): string[] {
  const entities = [...text.matchAll(htmlEntity)].map((match) => match[0]);
  return [
    ...entities.map((entity) => `${what} holds the HTML entity ${entity}`),
    ...(text.replaceAll(htmlEntity, '').includes(';') ? [`${what} holds a semicolon`] : []),
  ];
}

/** The kinds of diagram GitHub draws, each by its first line (R19). */
const diagramHeaders: readonly [kind: 'flowchart' | 'sequenceDiagram' | 'stateDiagram-v2', header: RegExp][] = [
  ['flowchart', /^flowchart(?:\s+(?:TB|TD|BT|RL|LR))?\s*$/],
  ['sequenceDiagram', /^sequenceDiagram\s*$/],
  ['stateDiagram-v2', /^stateDiagram-v2\s*$/],
];

/** The lines of a flowchart that style or link what is drawn and hold no label. */
const flowchartStyling = /^(?:style|classDef|class|linkStyle|click)\b/;
/** The opening of a node's shape right after its id, longest first: a label follows it. */
const shapeOpening = /^(?:\(\(\(|\[\[|\[\(|\(\[|\(\(|\{\{|\[\/|\[\\|[[({>])/;
const nodeId = /^[\p{L}\p{N}_]+/u;
/**
 * The opening of the text of an edge written between its arrow's two
 * halves, as in `A -- text --> B`, `A -. text .-> B` and `A == text ==> B`:
 * `--`, `-.` or `==` that is no part of a longer arrow. A `--` or `==`
 * right before `x` or `o` is a cross or circle arrow, as `A --x B`, which
 * holds no text.
 */
const edgeTextOpening = /(?<![-=.<])<?(?:(?:--|==)(?![-=.>xo])|-\.(?![-=.>]))/y;
/** The second half of the arrow that ends the text of an edge, which a semicolon in the text would end early. */
const edgeTextClosing = /(?:-{2,}|={2,}|\.-+)[>ox]?/y;
/** The value of `label:` in the body of a node's `@{ ... }` shape, its quoted text taken out. */
const shapeLabel = /(?:^|[\s,])label\s*:\s*([^,]*)/;

/** The text of an edge whose opening is at `at`: where its text starts and ends, past each quoted label and each label between bars in it, and where its closing arrow ends; null when no edge text opens there or none closes. */
function edgeTextAt(line: string, at: number): { readonly start: number; readonly end: number; readonly closed: number } | null {
  edgeTextOpening.lastIndex = at;
  const opening = edgeTextOpening.exec(line);
  if (opening === null) return null;
  const start = at + opening[0].length;
  let end = start;
  while (end < line.length) {
    const char = line.charAt(end);
    if (char === '"' || char === '|') {
      const close = line.indexOf(char, end + 1);
      if (close === -1) return null;
      end = close + 1;
      continue;
    }
    edgeTextClosing.lastIndex = end;
    const closing = edgeTextClosing.exec(line);
    if (closing !== null) return { start, end, closed: end + closing[0].length };
    end += 1;
  }
  return null;
}

/** The failures of a subgraph's line, the text after `subgraph`: each quoted label, and the title as the rest of the line gives it, `S [title]` or a title alone. */
function subgraphFailures(rest: string, number: number): string[] {
  const quoted = /"([^"]*)"/g;
  const bare = rest.replaceAll(quoted, '');
  return [
    ...[...rest.matchAll(quoted)].flatMap((label) => labelFailures(`the label on line ${String(number)}`, label[1]!)),
    ...(bare.includes('"') ? [`line ${String(number)} opens a label it does not close`] : []),
    ...labelFailures(`the title of the subgraph on line ${String(number)}`, bare),
  ];
}

/** The failures of one line of a flowchart: each quoted label, each label between bars, each text of an edge, the title of a subgraph and the label of a node's `@{ ... }` shape, and the label of a node that is not quoted. */
function flowchartLineFailures(line: string, number: number): string[] {
  if (flowchartStyling.test(line)) return [];
  const subgraph = /^subgraph\b(.*)$/.exec(line);
  if (subgraph !== null) return subgraphFailures(subgraph[1]!, number);
  const failures: string[] = [];
  // The text of the edge the walk is in, whose words are no nodes, and which the walk leaves past its closing arrow.
  let edge: ReturnType<typeof edgeTextAt> = null;
  let at = 0;
  while (at < line.length) {
    if (edge !== null && at >= edge.end) {
      at = edge.closed;
      edge = null;
      continue;
    }
    if (edge === null) {
      edge = edgeTextAt(line, at);
      if (edge !== null) {
        // Its quoted labels and those between bars are checked as the walk meets them, so they are taken out of its text.
        failures.push(...labelFailures(`the text of an edge on line ${String(number)}`, line.slice(edge.start, edge.end).replaceAll(/"[^"]*"|\|[^|]*\|/g, '""')));
        at = edge.start;
        continue;
      }
    }
    const char = line.charAt(at);
    if (char === '"' || char === '|') {
      const close = line.indexOf(char, at + 1);
      if (close === -1) {
        failures.push(`line ${String(number)} opens a label it does not close`);
        break;
      }
      failures.push(...labelFailures(`the label on line ${String(number)}`, line.slice(at + 1, close)));
      at = close + 1;
      continue;
    }
    const id = nodeId.exec(line.slice(at));
    if (id === null) {
      at += 1;
      continue;
    }
    at += id[0].length;
    if (edge !== null) continue;
    if (line.startsWith('@{', at)) {
      // The body of the shape runs to the first `}` outside a quoted text.
      let close = at + 2;
      while (close < line.length && line.charAt(close) !== '}') close = line.charAt(close) === '"' ? line.indexOf('"', close + 1) + 1 || line.length : close + 1;
      if (close === line.length) {
        failures.push(`line ${String(number)} opens the shape of node ${id[0]} it does not close`);
        break;
      }
      const body = line.slice(at + 2, close);
      for (const quoted of body.matchAll(/"([^"]*)"/g)) failures.push(...labelFailures(`the label on line ${String(number)}`, quoted[1]!));
      const label = shapeLabel.exec(body.replaceAll(/"[^"]*"/g, '""'));
      if (label !== null) failures.push(...labelFailures(`the label of node ${id[0]} on line ${String(number)}`, label[1]!));
      at = close + 1;
      continue;
    }
    const opening = shapeOpening.exec(line.slice(at));
    if (opening === null) continue;
    at += opening[0].length;
    if (line.charAt(at) !== '"') failures.push(`the label of node ${id[0]} on line ${String(number)} is not quoted`);
  }
  return failures;
}

/** The blocks of a sequence diagram and the participants, whose text after the keyword is a label. */
const sequenceLabelled = /^(?:loop|alt|else|opt|par|and|critical|option|break|box)\s+(.+)$|^(?:participant|actor)\s+\S+\s+as\s+(.+)$/;
/** The title of a sequence diagram written with no colon, as `title The login`. */
const sequenceTitle = /^title\s+(.+)$/;

/**
 * The failures of a diagram (R19, TD9): its first line names a kind GitHub
 * draws; in a flowchart, the label of each node is quoted; and no label,
 * message or note holds an HTML entity or a semicolon: in a flowchart each
 * quoted label, each label between bars, each text of an edge, the title
 * of a subgraph and the label of an `@{ ... }` shape, and in the two other
 * kinds the text after a colon, each quoted text, each label of a block or
 * a participant, the title of a sequence diagram, and each line of a note
 * that spans lines. No line after
 * the first holds a directive, `%%{`, which Mermaid reads anywhere in a
 * diagram and which can change how it draws it; a comment, `%%` alone,
 * is no failure. A run of backticks is no failure: the form fences a
 * diagram with a longer one.
 */
export function diagramFailures(diagram: string): string[] {
  const lines = diagram.split(/\r\n|\r|\n/);
  const start = lines.findIndex((line) => !blank(line));
  const header = start === -1 ? '' : lines[start]!.trim();
  const kind = diagramHeaders.find(([, pattern]) => pattern.test(header))?.[0];
  if (kind === undefined) return [`it starts with ${header === '' ? 'nothing' : `"${truncated(header, 80)}"`}, not with flowchart, sequenceDiagram or stateDiagram-v2, the kinds GitHub draws`];
  const failures: string[] = [];
  let inNote = false;
  lines.slice(start + 1).forEach((raw, index) => {
    const line = raw.trim();
    const number = start + index + 2;
    if (line.includes('%%{')) failures.push(`line ${String(number)} holds a directive, %%{, which changes how Mermaid draws the diagram`);
    if (line === '' || line.startsWith('%%')) return;
    if (kind === 'flowchart') {
      failures.push(...flowchartLineFailures(line, number));
      return;
    }
    const where = `line ${String(number)}`;
    if (inNote) {
      if (/^end\s+note$/i.test(line)) inNote = false;
      else failures.push(...labelFailures(`the note on ${where}`, line));
      return;
    }
    if (kind === 'stateDiagram-v2' && /^note\s/i.test(line) && !line.includes(':')) {
      inNote = true;
      return;
    }
    for (const quoted of line.matchAll(/"([^"]*)"/g)) failures.push(...labelFailures(`the label on ${where}`, quoted[1]!));
    const colon = line.indexOf(':');
    if (colon !== -1) failures.push(...labelFailures(`the text after the colon on ${where}`, line.slice(colon + 1)));
    const labelled = kind === 'sequenceDiagram' && colon === -1 ? sequenceLabelled.exec(line) : null;
    if (labelled !== null) failures.push(...labelFailures(`the label on ${where}`, labelled[1] ?? labelled[2] ?? ''));
    const title = kind === 'sequenceDiagram' && colon === -1 ? sequenceTitle.exec(line) : null;
    if (title !== null) failures.push(...labelFailures(`the title on ${where}`, title[1]!));
  });
  return [...new Set(failures)];
}

/** The failures of a part's diagram, named by where it is; none for a part with no diagram. */
const diagramFailuresOf = (what: string, diagram: string | null): string[] => (diagram === null ? [] : diagramFailures(diagram).map((failure) => `${what} is no diagram GitHub draws: ${failure}`));

/** How a failure names a side. */
const sideWords: Readonly<Record<CitedSide, string>> = { head: 'the head', base: 'the merge base' };

/** The failures of the lines a case cites: a path the commit of its side holds, and a range of lines within it (R19, PD11). */
function linesFailures(what: string, lines: CitedLines, lineCount: AnswerCheckInput['lineCount']): string[] {
  const { side, path, from, to } = lines;
  if (!repositoryPath(path)) return [`${what} cites ${JSON.stringify(path)}, which is not a path from the root of the repository`];
  if (from < 1 || to < from) return [`${what} cites lines ${String(from)} to ${String(to)} of ${path}, which is no range of lines`];
  const count = lineCount(side, path);
  if (count === null) return [`${what} cites ${path} at ${sideWords[side]}, which holds no such file`];
  if (to > count) return [`${what} cites ${path}:${from === to ? String(from) : `${String(from)}-${String(to)}`}, which has ${counted(count, 'line', 'lines')} at ${sideWords[side]}`];
  return [];
}

/**
 * The conclusion checked: a why; a sentence for each finding to explain,
 * by its id, and for no other; no verdict; and, in an answer of version
 * 1, its diagram. The form of the review that reads as a report posts no
 * conclusion's diagram, and for a question it posts the decider's
 * recommended option instead of the writer's sentence, so an answer of
 * version 2 is held to neither: a question in `asks` may have any
 * sentence, or none, and still names no stray finding.
 */
function checkConclusion(conclusion: Conclusion, ids: readonly string[], version: AnswerVersion, asks: readonly string[]): string[] {
  const posted = version === 1 ? ids : ids.filter((id) => !asks.includes(id));
  const named = conclusion.actions.map((action) => action.id);
  const sentenceFor = (id: string): string => (named.filter((name) => name === id).length > 1 ? `the conclusion has more than one sentence for ${id}` : '');
  const diagram = version === 1 ? conclusion.diagram : null;
  const postedActions = conclusion.actions.filter((action) => posted.includes(action.id) || !ids.includes(action.id));
  return [
    ...(blank(conclusion.why) ? ['the conclusion says no why'] : []),
    ...[...new Set(named)].filter((id) => !ids.includes(id)).map((id) => `the conclusion names ${JSON.stringify(id)}, which is no finding of the run that asks a person to act`),
    ...posted.map(sentenceFor).filter((failure) => failure !== ''),
    ...posted.filter((id) => !named.includes(id)).map((id) => `the conclusion has no sentence for ${id}`),
    ...conclusion.actions.filter((action) => posted.includes(action.id) && blank(action.sentence)).map((action) => `the conclusion's sentence for ${action.id} is empty`),
    ...verdictFailures('the conclusion', [conclusion.why, ...postedActions.map((action) => action.sentence), diagram ?? '']),
    ...diagramFailuresOf('the conclusion\'s diagram', diagram),
  ];
}

/** The account checked: the problem and the change each said, each term with its meaning, no verdict, and its diagrams. */
function checkAccount(account: Account): string[] {
  return [
    ...(blank(account.problem.text) ? ['the account says no problem before the change'] : []),
    ...(blank(account.change.text) ? ['the account says nothing of the change'] : []),
    ...account.terms.filter((term) => blank(term.term) || blank(term.meaning)).map((term) => `the account's term ${JSON.stringify(term.term)} has no ${blank(term.term) ? 'name' : 'meaning'}`),
    ...verdictFailures('the account', [account.problem.text, account.problem.diagram ?? '', account.change.text, account.change.diagram ?? '', ...account.terms.flatMap((term) => [term.term, term.meaning])]),
    ...diagramFailuresOf('the diagram of the problem before the change', account.problem.diagram),
    ...diagramFailuresOf('the diagram of the change', account.change.diagram),
  ];
}

type FindingEntry = AnyWriterOutput['findings'][number];

/**
 * The explanation of one finding checked, from the entries the answer
 * gives for its id: one entry, explained or unexplained and not both; and
 * for an explanation, its texts, at least one case, the lines of each, no
 * verdict, and its diagram. `major` is null for an answer of version 1,
 * whose explanation must say something of its decision. For an answer of
 * version 2 it is true or false, as the finding is major or not, and only
 * then do the checks of version 2 run: an explanation also says how its
 * verifier checked it, and has a kind exactly when the finding is minor;
 * its `decision`, which the form of the review that reads as a report
 * does not post, is held to nothing; and so are the cases, the diagram
 * and the check of a minor finding, whose comment posts none of them.
 */
function checkFinding(id: string, entries: readonly FindingEntry[], lineCount: AnswerCheckInput['lineCount'], major: boolean | null): CheckedPart<FindingExplanation> {
  const refused = (failure: string): CheckedPart<FindingExplanation> => ({ value: null, failures: [failure] });
  if (entries.length === 0) return refused(`the answer does not explain ${id}`);
  if (entries.length > 1) return refused(`the answer explains ${id} ${String(entries.length)} times`);
  const { explanation, unexplained } = entries[0]!;
  if (explanation === null && unexplained === null) return refused(`${id} has neither an explanation nor the reason it is unexplained`);
  if (explanation !== null && unexplained !== null) return refused(`${id} has both an explanation and the reason it is unexplained`);
  if (unexplained !== null) {
    const failures = [...(blank(unexplained) ? [`the reason ${id} is unexplained is empty`] : []), ...verdictFailures(`the reason ${id} is unexplained`, [unexplained])];
    return { value: { id, unexplained: true, reason: unexplained }, failures };
  }
  const { title, problem, cases, diagram, decision } = explanation!;
  const checked = 'checked' in explanation! ? explanation.checked : null;
  const kind = 'kind' in explanation! ? explanation.kind : null;
  const checkedDecision = major === null ? decision : '';
  // A minor finding's comment posts its title and problem alone, so its cases, diagram and check, posted nowhere, cannot drop it.
  const posted = major !== false;
  const postedCases = posted ? cases : [];
  const postedChecked = posted ? checked : null;
  const postedDiagram = posted ? diagram : null;
  const failures = [
    ...(blank(title) ? [`${id} has no title`] : []),
    ...(blank(problem) ? [`${id} says no problem`] : []),
    ...(major === null && blank(decision) ? [`${id} says nothing of its decision`] : []),
    ...(posted && cases.length === 0 ? [`${id} has no case`] : []),
    ...postedCases.flatMap((cited, index) => {
      const what = `case ${String(index + 1)} of ${id}`;
      return [...(blank(cited.sentence) ? [`${what} has no sentence`] : []), ...linesFailures(what, cited.lines, lineCount)];
    }),
    ...(postedChecked !== null && blank(postedChecked) ? [`${id} says nothing of how its verifier checked it`] : []),
    ...(major === false && kind === null ? [`${id} is a minor finding and has no kind`] : []),
    ...(major === true && kind !== null ? [`${id} is a major finding and has the kind ${kind}, which only a minor finding has`] : []),
    ...verdictFailures(`the explanation of ${id}`, [title, problem, checkedDecision, postedDiagram ?? '', postedChecked ?? '', ...postedCases.map((cited) => cited.sentence)]),
    ...diagramFailuresOf(`the diagram of ${id}`, postedDiagram),
  ];
  return { value: { id, unexplained: false, title, problem, cases, diagram, decision, checked, kind }, failures };
}

/** How a list of named ids covers the ids expected, one for each and none for another: each expected id named none, each named more than once with its count, and each named id not expected, once. */
interface IdCoverage {
  readonly missing: readonly string[];
  readonly repeated: readonly (readonly [id: string, count: number])[];
  readonly stray: readonly string[];
}

/** The coverage of `expected` by `named`, each list in the order of `expected` or, for the stray ids, of `named`. */
function idCoverage(named: readonly string[], expected: readonly string[]): IdCoverage {
  const counts = new Map<string, number>();
  for (const id of named) counts.set(id, (counts.get(id) ?? 0) + 1);
  return {
    missing: expected.filter((id) => !counts.has(id)),
    repeated: expected.flatMap((id) => {
      const count = counts.get(id) ?? 0;
      return count > 1 ? [[id, count] as const] : [];
    }),
    stray: [...counts.keys()].filter((id) => !expected.includes(id)),
  };
}

/**
 * The areas checked (R4, PD6 of the review that reads as a report): each
 * major finding to explain in exactly one area and no other id in any,
 * each area with a title, an intro and a finding, no verdict, and its
 * diagram.
 */
function checkAreas(areas: readonly Area[], ids: readonly string[], major: readonly string[]): string[] {
  const { missing, repeated, stray } = idCoverage(areas.flatMap((area) => area.findings), major);
  return [
    ...missing.map((id) => `the areas leave out ${id}, a major finding that asks a person to act`),
    ...repeated.map(([id, count]) => `${id} is in ${String(count)} areas, and a finding is in one`),
    ...stray.map((id) => (ids.includes(id) ? `the areas name ${id}, a minor finding, which no area holds` : `the areas name ${JSON.stringify(id)}, which is no major finding of the run that asks a person to act`)),
    ...areas.flatMap((area, index) => {
      const what = `area ${String(index + 1)}`;
      return [
        ...(blank(area.title) ? [`${what} has no title`] : []),
        ...(blank(area.intro) ? [`${what} has no intro`] : []),
        ...(area.findings.length === 0 ? [`${what} names no finding`] : []),
        ...verdictFailures(what, [area.title, area.intro, area.diagram ?? '']),
        ...diagramFailuresOf(`the diagram of ${what}`, area.diagram),
      ];
    }),
  ];
}

/** The refuted lines checked (R11 of the review that reads as a report): one line for each refuted candidate and for no other id, each with its claim and why, and no verdict. */
function checkRefuted(lines: readonly RefutedLine[], refutedIds: readonly string[]): string[] {
  const { missing, repeated, stray } = idCoverage(lines.map((line) => line.id), refutedIds);
  return [
    ...missing.map((id) => `the refuted lines have no line for ${id}`),
    ...repeated.map(([id, count]) => `the refuted lines have ${String(count)} lines for ${id}, and a candidate has one`),
    ...stray.map((id) => `the refuted lines name ${JSON.stringify(id)}, which is no refuted candidate of the run`),
    ...lines.filter((line) => refutedIds.includes(line.id)).flatMap((line) => [
      ...(blank(line.claim) ? [`the refuted line for ${line.id} says no claim`] : []),
      ...(blank(line.why) ? [`the refuted line for ${line.id} says not why it was refuted`] : []),
      ...verdictFailures(`the refuted line for ${line.id}`, [line.claim, line.why]),
    ]),
  ];
}

/**
 * An answer checked part by part, with what the engine can count (TD9):
 * each id is a finding to explain, the conclusion has a sentence for each
 * and for no other, each cited path is in the commit of its side and each
 * range within its lines, no part holds a verdict of the review, and each
 * diagram is one GitHub draws. An answer of version 1 has its account
 * checked; one of version 2 its areas, its refuted lines, how each finding
 * was checked and the kind of each minor one, against `input.report`.
 * Whether a case follows from its lines is left to the gate (PD11).
 */
export function checkAnswer(output: AnyWriterOutput, input: AnswerCheckInput): CheckedAnswer {
  const entries = new Map(input.ids.map((id): [string, FindingEntry[]] => [id, []]));
  const strays: string[] = [];
  for (const entry of output.findings) {
    const of = entries.get(entry.id);
    if (of === undefined) strays.push(entry.id);
    else of.push(entry);
  }
  const conclusion = { value: output.conclusion, failures: checkConclusion(output.conclusion, input.ids, 'account' in output ? 1 : 2, input.report?.asks ?? []) };
  if ('account' in output) {
    return { conclusion, account: { value: output.account, failures: checkAccount(output.account) }, areas: null, refuted: null, findings: new Map(input.ids.map((id) => [id, checkFinding(id, entries.get(id)!, input.lineCount, null)])), strays };
  }
  if (input.report === undefined) throw new Error('An answer in the form of the review that reads as a report is checked against the major findings and the refuted candidates of its run');
  const { major, refuted: refutedIds } = input.report;
  return {
    conclusion,
    account: null,
    areas: { value: output.areas, failures: checkAreas(output.areas, input.ids, major) },
    refuted: { value: output.refuted, failures: checkRefuted(output.refuted, refutedIds) },
    findings: new Map(input.ids.map((id) => [id, checkFinding(id, entries.get(id)!, input.lineCount, major.includes(id))])),
    strays,
  };
}

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
 */
export function mergeAnswers(version: AnswerVersion, answers: readonly CheckedAnswer[], ids: readonly string[], extra: readonly string[] = []): MergedAnswer {
  const dropped: DroppedPart[] = [];
  const pick = <T>(parts: readonly (CheckedPart<T> | null)[], drop: (failures: string[]) => DroppedPart): T | null => {
    const given = parts.filter((part): part is CheckedPart<T> => part !== null);
    const passed = given.find((part) => part.value !== null && part.failures.length === 0);
    if (passed !== undefined) return passed.value;
    dropped.push(drop(recordedFailures(given.at(-1)?.failures ?? [], extra)));
    return null;
  };
  const conclusion = pick(answers.map((answer) => answer.conclusion), (failures) => ({ part: 'conclusion', failures }));
  const account = version === 1 ? pick(answers.map((answer) => answer.account), (failures) => ({ part: 'account', failures })) : null;
  const areas = version === 2 ? pick(answers.map((answer) => answer.areas), (failures) => ({ part: 'areas', failures })) : null;
  const lines = version === 2 ? pick(answers.map((answer) => answer.refuted), (failures) => ({ part: 'refuted', failures })) : null;
  const findings = ids.flatMap((id) => {
    const kept = pick(answers.map((answer) => answer.findings.get(id)!), (failures) => ({ part: 'finding', finding: id, failures }));
    return kept === null ? [] : [kept];
  });
  return { answer: { conclusion, account, areas, refuted: lines, findings }, dropped };
}

/** Whether the merge kept any part. */
const keptAny = ({ answer }: MergedAnswer): boolean => answer.conclusion !== null || answer.account !== null || answer.areas !== null || answer.refuted !== null || answer.findings.length > 0;

/** A dropped part by its name, as the reason of a refused answer and the next writer's task give it: `conclusion`, `account`, `areas`, `refuted` or `finding <id>`. */
const partNameOf = (part: DroppedPart): PartName => (part.part === 'finding' ? `finding ${part.finding}` : part.part);

/** The event that records a writer's explanation, at the version of its answer, typed as a pair. */
export type ExplanationEvent =
  | { readonly kind: 'explanation.recorded'; readonly version: 1; readonly payload: ExplanationRecordedV1 }
  | { readonly kind: 'explanation.recorded'; readonly version: 2; readonly payload: ExplanationRecordedV2 };

/** Whether a dropped part is one version 1 names. */
const isPartV1 = (part: DroppedPart): part is DroppedPartV1 => part.part === 'conclusion' || part.part === 'account' || part.part === 'finding';
/** Whether a dropped part is one version 2 names. */
const isPartV2 = (part: DroppedPart): part is DroppedPartV2 => part.part !== 'account';

/**
 * What `explanation.recorded` records of a merge, at `version`: the writer
 * whose answer completed the unit, or null when the phase degraded
 * without one; the kept answer frozen in the evidence store in the shape
 * of its version, always for a writer that completed the unit and
 * otherwise when it keeps any part; each part dropped with its failures;
 * and the findings marked unexplained.
 */
export function explanationRecord(version: AnswerVersion, workerId: string | null, merged: MergedAnswer, evidence: Pick<EvidenceStore, 'put'>): ExplanationEvent {
  const answer: ArtifactReference | null = workerId !== null || keptAny(merged) ? evidence.put(`${JSON.stringify(frozenAnswer(version, merged.answer))}\n`) : null;
  const unexplained = merged.answer.findings.filter((finding) => finding.unexplained).map((finding) => finding.id);
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
  const schema = answerVersionOf(review) === 2 ? writerOutputSchemaV2 : writerOutputSchema;
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
  const input: AnswerCheckInput = answerVersionOf(review) === 2 ? { ids, lineCount, report: reportCheckInputOf(review) } : { ids, lineCount };
  return answers.map((answer) => checkAnswer(answer, input));
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
  const version = answerVersionOf(review);
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
  const merged = mergeAnswers(answerVersionOf(review), checkedAnswers(state, review, context, ids, null), ids, [reason]);
  return explanationRecord(answerVersionOf(review), null, merged, context.evidence);
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

/** What the writer's task needs beyond the fold: the worktree and the evidence store an earlier answer is read and checked from, and the machine whose places and secrets each quoted text is cleaned of. */
export interface WriterTaskInput {
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'read'>;
  readonly machine: MachineContext;
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
function explainWords(entry: ReportFinding, version: AnswerVersion): string {
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

/**
 * The writer's task (R18, R20, TD8 of the review on the pull request; R4,
 * R10, R11, R13, TD2 of the review that reads as a report): the language
 * the run recorded; the findings it explains, and in an answer of version
 * 2 which go in areas, which take a kind and which refuted candidates take
 * a line; the brief of the run in its report form; every ranked finding
 * with its decision, its evidence, the runs its verdict cites and the
 * notes of its verifier; in an answer of version 2, every refuted
 * candidate with its evidence; and, after a refused answer, the parts that
 * still fail with their failures. Each text of a worker is cleaned as the
 * review cleans the text it posts (R11), and the brief and each printed
 * output are fenced. The scope block that follows the task carries the
 * patch. Neither the title nor the body of the pull request is in it (PD8).
 */
export function writerTask(state: RunState, input: WriterTaskInput): string {
  const review = requireReview(state);
  const version = answerVersionOf(review);
  const ids = findingsToExplain(review);
  const clean = (text: string): string => inlineText(publicWords(text, input.machine).text);
  // Cleaned as code, so its places and secrets give way to their marks and nothing in it is escaped, then fenced longer than any run of backticks the cleaning left.
  const quote = (text: string, info = ''): string => fenced(publicCode(text, input.machine).text, info);
  const numbers = findingNumbers(review);
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const ranked = rankedFindings(review);
  const answers = checkedAnswers(state, review, input, ids, null);
  const dropped = answers.length === 0 ? [] : mergeAnswers(version, answers, ids).dropped;
  const report = version === 2 ? reportCheckInputOf(review) : null;
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
      'An earlier writer\'s answer failed the engine\'s checks in these parts, and the engine keeps every other part of it. Give your whole answer again: the engine takes from it only these parts, and drops each that fails again.',
      '',
      ...dropped.map((part) => `- ${partNameOf(part)}: ${part.failures.map((failure) => inlineText(failure)).join('; ')}`),
      '',
    ]),
    version === 1
      ? 'Return `conclusion`, `account` and `findings`. Your role prompt defines the conclusion and the findings; `account` gives, for a reader who does not know the change, the `terms` a newcomer needs, each with its meaning, the `problem` before the change and the `change` the pull request makes, each with a diagram or null.'
      : 'Return `conclusion`, `areas`, `findings` and `refuted` as your role prompt defines them.',
  ].join('\n');
}
