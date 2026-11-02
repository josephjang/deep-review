/**
 * The writer's explanation of the review of a pull request (R18, R19,
 * TD8, TD9 of the review on the pull request): which findings it
 * explains, the checks the engine can count in its answer, part by part,
 * the merge of an answer with the earlier one of its unit, what
 * `explanation.recorded@1` records of them, and the writer's task. The
 * answer as the evidence store freezes it is `RecordedAnswer`, which the
 * form of the pull request renders beside the ledger's own words.
 */
import { z } from 'zod';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import { recordedTextLengthV1, type DroppedPart, type ExplanationRecorded, type RecordedDecision, type ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { CandidateState, ReviewState, UnitFailure } from '../checkpoint/review-fold.ts';
import { defaultLanguage } from '../config/settings.ts';
import type { ArtifactReference, EvidenceStore } from '../evidence/store.ts';
import { blobsRaw, treeEntries, type TreeEntry } from '../scope/git.ts';
import { briefMarkdown, briefOf } from './brief.ts';
import { StructuralCheckError } from './errors.ts';
import { inlineText } from './markdown.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicWords, type MachineContext } from './public-text.ts';
import { writerOutputSchema, type CitedSide, type WriterOutput } from './schemas.ts';
import { findingNumbers, rankedFindings, resolutionOf, type ReportFinding } from './state.ts';
import { maxAttempts, truncated } from './steps.ts';
import { describeLocation } from './tasks.ts';
import { asksToAct, singleUnitKey, verdictBasisWords, verdicts } from './vocabulary.ts';

const writerOutputShape = writerOutputSchema.shape;
const explanationShape = writerOutputShape.findings.element.shape.explanation.unwrap().shape;

/** The conclusion as the writer gives it: why the pull request needs what it needs, a sentence for each action by the id of its finding, and a diagram or none. */
export type Conclusion = WriterOutput['conclusion'];
/** The account of the pull request: the terms a newcomer needs, the problem before the change and the change, each with a diagram or none. */
export type Account = WriterOutput['account'];
/** One case in which a finding breaks: a sentence and the lines that show it. */
export type CitedCase = z.infer<typeof explanationShape.cases.element>;
/** The lines a case cites: a range of a path at the head, or at the merge base for lines the change removed. */
export type CitedLines = CitedCase['lines'];

/** A finding the writer explained: the cause in one sentence, the problem as who meets what, the cases, a diagram or none, and its words on the decision. */
const explainedFindingSchema = z.strictObject({ id: z.string(), unexplained: z.literal(false), ...explanationShape });
export type ExplainedFinding = z.infer<typeof explainedFindingSchema>;
/** A finding the writer could not explain from its evidence and the code, with the reason: the review gives it in the ledger's words with the mark (R19). */
const unexplainedFindingSchema = z.strictObject({ id: z.string(), unexplained: z.literal(true), reason: z.string() });
export type UnexplainedFinding = z.infer<typeof unexplainedFindingSchema>;
export type FindingExplanation = ExplainedFinding | UnexplainedFinding;

/**
 * The writer's answer as the evidence store freezes it, the reference
 * `explanation.recorded@1` holds: each part that an answer passed, and
 * none that no answer passed, which the record lists as dropped. A
 * dropped conclusion or account is null, and a dropped finding has no
 * entry; each finding kept is in the rank of the findings.
 */
export const recordedAnswerSchema = z.strictObject({
  conclusion: writerOutputShape.conclusion.nullable(),
  account: writerOutputShape.account.nullable(),
  findings: z.array(z.discriminatedUnion('unexplained', [explainedFindingSchema, unexplainedFindingSchema])),
});
export type RecordedAnswer = z.infer<typeof recordedAnswerSchema>;

/** The recorded answer of an explanation, as the form reads it, or null when no answer passed any part. */
export function recordedAnswerOf(recorded: Pick<ExplanationRecorded, 'answer'>, evidence: Pick<EvidenceStore, 'read'>): RecordedAnswer | null {
  return recorded.answer === null ? null : recordedAnswerSchema.parse(JSON.parse(evidence.read(recorded.answer).toString('utf8')));
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

/** A part of the answer as `explanation.recorded@1` names a dropped one: the conclusion, the account, or `finding <id>`. */
export type PartName = 'conclusion' | 'account' | `finding ${string}`;

/** One part of an answer with the failures of its checks: kept when it has a value and no failure. */
export interface CheckedPart<T> {
  readonly value: T | null;
  readonly failures: readonly string[];
}

/** An answer checked part by part (TD9): its conclusion, its account, and its explanation of each finding to explain, by id. */
export interface CheckedAnswer {
  readonly conclusion: CheckedPart<Conclusion>;
  readonly account: CheckedPart<Account>;
  readonly findings: ReadonlyMap<string, CheckedPart<FindingExplanation>>;
  /** The ids of the entries of `findings` that name no finding to explain: refused, so never kept, and they cost no part. */
  readonly strays: readonly string[];
}

/** What the checks read beyond the answer: the findings to explain, and the count of lines of a path at a side, or null when its commit holds no such file. */
export interface AnswerCheckInput {
  readonly ids: readonly string[];
  readonly lineCount: (side: CitedSide, path: string) => number | null;
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
  if (to > count) return [`${what} cites ${path}:${from === to ? String(from) : `${String(from)}-${String(to)}`}, which has ${String(count)} line${count === 1 ? '' : 's'} at ${sideWords[side]}`];
  return [];
}

/** The conclusion checked: a why; a sentence for each finding to explain, by its id, and for no other; no verdict; and its diagram. */
function checkConclusion(conclusion: Conclusion, ids: readonly string[]): string[] {
  const named = conclusion.actions.map((action) => action.id);
  const sentenceFor = (id: string): string => (named.filter((name) => name === id).length > 1 ? `the conclusion has more than one sentence for ${id}` : '');
  return [
    ...(blank(conclusion.why) ? ['the conclusion says no why'] : []),
    ...[...new Set(named)].filter((id) => !ids.includes(id)).map((id) => `the conclusion names ${JSON.stringify(id)}, which is no finding of the run that asks a person to act`),
    ...ids.map(sentenceFor).filter((failure) => failure !== ''),
    ...ids.filter((id) => !named.includes(id)).map((id) => `the conclusion has no sentence for ${id}`),
    ...conclusion.actions.filter((action) => ids.includes(action.id) && blank(action.sentence)).map((action) => `the conclusion's sentence for ${action.id} is empty`),
    ...verdictFailures('the conclusion', [conclusion.why, ...conclusion.actions.map((action) => action.sentence), conclusion.diagram ?? '']),
    ...diagramFailuresOf('the conclusion\'s diagram', conclusion.diagram),
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

type FindingEntry = WriterOutput['findings'][number];

/** The explanation of one finding checked, from the entries the answer gives for its id: one entry, explained or unexplained and not both; and for an explanation, its texts, at least one case, the lines of each, no verdict, and its diagram. */
function checkFinding(id: string, entries: readonly FindingEntry[], lineCount: AnswerCheckInput['lineCount']): CheckedPart<FindingExplanation> {
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
  const failures = [
    ...(blank(title) ? [`${id} has no title`] : []),
    ...(blank(problem) ? [`${id} says no problem`] : []),
    ...(blank(decision) ? [`${id} says nothing of its decision`] : []),
    ...(cases.length === 0 ? [`${id} has no case`] : []),
    ...cases.flatMap((cited, index) => {
      const what = `case ${String(index + 1)} of ${id}`;
      return [...(blank(cited.sentence) ? [`${what} has no sentence`] : []), ...linesFailures(what, cited.lines, lineCount)];
    }),
    ...verdictFailures(`the explanation of ${id}`, [title, problem, decision, diagram ?? '', ...cases.map((cited) => cited.sentence)]),
    ...diagramFailuresOf(`the diagram of ${id}`, diagram),
  ];
  return { value: { id, unexplained: false, title, problem, cases, diagram, decision }, failures };
}

/**
 * An answer checked part by part, with what the engine can count (TD9):
 * each id is a finding to explain, the conclusion has a sentence for each
 * and for no other, each cited path is in the commit of its side and each
 * range within its lines, no part holds a verdict of the review, and each
 * diagram is one GitHub draws. Whether a case follows from its lines is
 * left to the gate (PD11).
 */
export function checkAnswer(output: WriterOutput, input: AnswerCheckInput): CheckedAnswer {
  const entries = new Map(input.ids.map((id): [string, FindingEntry[]] => [id, []]));
  const strays: string[] = [];
  for (const entry of output.findings) {
    const of = entries.get(entry.id);
    if (of === undefined) strays.push(entry.id);
    else of.push(entry);
  }
  return {
    conclusion: { value: output.conclusion, failures: checkConclusion(output.conclusion, input.ids) },
    account: { value: output.account, failures: checkAccount(output.account) },
    findings: new Map(input.ids.map((id) => [id, checkFinding(id, entries.get(id)!, input.lineCount)])),
    strays,
  };
}

/** The most failures a dropped part records, as `explanation.recorded@1` holds them. */
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
 * TD9): each part is taken from the first answer that passed it, so a
 * retry replaces only the parts that failed, and a part that passed the
 * first time is kept; a part that no answer passed is dropped, with the
 * failures of the latest answer that gave it and `extra`, such as why no
 * other answer came. A finding kept is in the order of `ids`.
 */
export function mergeAnswers(answers: readonly CheckedAnswer[], ids: readonly string[], extra: readonly string[] = []): MergedAnswer {
  const dropped: DroppedPart[] = [];
  const pick = <T>(parts: readonly CheckedPart<T>[], drop: (failures: string[]) => DroppedPart): T | null => {
    const passed = parts.find((part) => part.value !== null && part.failures.length === 0);
    if (passed !== undefined) return passed.value;
    dropped.push(drop(recordedFailures(parts.at(-1)?.failures ?? [], extra)));
    return null;
  };
  const conclusion = pick(answers.map((answer) => answer.conclusion), (failures) => ({ part: 'conclusion', failures }));
  const account = pick(answers.map((answer) => answer.account), (failures) => ({ part: 'account', failures }));
  const findings = ids.flatMap((id) => {
    const kept = pick(answers.map((answer) => answer.findings.get(id)!), (failures) => ({ part: 'finding', finding: id, failures }));
    return kept === null ? [] : [kept];
  });
  return { answer: { conclusion, account, findings }, dropped };
}

/** Whether the merge kept any part. */
const keptAny = (merged: MergedAnswer): boolean => merged.answer.conclusion !== null || merged.answer.account !== null || merged.answer.findings.length > 0;

/** A dropped part by its name, as the reason of a refused answer and the next writer's task give it: `conclusion`, `account` or `finding <id>`. */
const partNameOf = (part: DroppedPart): PartName => (part.part === 'finding' ? `finding ${part.finding}` : part.part);

/**
 * What `explanation.recorded@1` records of a merge: the writer whose
 * answer completed the unit, or null when the phase degraded without one;
 * the kept answer frozen in the evidence store, always for a writer that
 * completed the unit and otherwise when it keeps any part; each part
 * dropped with its failures; and the findings marked unexplained.
 */
export function explanationRecord(workerId: string | null, merged: MergedAnswer, evidence: Pick<EvidenceStore, 'put'>): ExplanationRecorded {
  const answer: ArtifactReference | null = workerId !== null || keptAny(merged) ? evidence.put(`${JSON.stringify(merged.answer)}\n`) : null;
  return {
    workerId,
    answer,
    dropped: [...merged.dropped],
    unexplained: merged.answer.findings.filter((finding) => finding.unexplained).map((finding) => finding.id),
  };
}

/** What recording or retrying the writer's answer needs beyond the fold: the worktree git reads the commits in, and the evidence store the earlier answers are read from and the kept answer is frozen in. */
export interface ExplanationContext {
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'put' | 'read'>;
}

/** The review of a run that explains it, configured at `review.configured@10`. */
function requireReview(state: RunState): ReviewState {
  if (state.review === null || !state.review.explanationStep) throw new Error(`Run ${state.id} does not explain its review`);
  return state.review;
}

/** The failures of the writer's unit in the phase's current attempt, which a re-entered phase clears. */
const writerFailures = (review: ReviewState): readonly UnitFailure[] => review.units.explanation[singleUnitKey('explanation')]?.failures ?? [];

/**
 * The answers of the writers whose attempts at the unit failed in the
 * phase's current attempt, in order, as the evidence store froze them: the
 * earlier answers a later one is merged with. An attempt that ended with
 * no answer, or one a re-entered phase cleared, gives none.
 */
function earlierAnswers(state: RunState, review: ReviewState, evidence: Pick<EvidenceStore, 'read'>): WriterOutput[] {
  return writerFailures(review).flatMap((failure) => {
    const worker = Object.hasOwn(state.workers, failure.workerId) ? state.workers[failure.workerId] : undefined;
    if (worker?.status !== 'finished' || worker.finish.output === null) return [];
    const parsed = writerOutputSchema.safeParse(JSON.parse(evidence.read(worker.finish.output).toString('utf8')));
    return parsed.success ? [parsed.data] : [];
  });
}

/** The answers of the unit's earlier attempts and `latest`, checked against the run, in order, the lines of every path their cases cite read at once. */
function checkedAnswers(state: RunState, review: ReviewState, context: { readonly worktree: string; readonly evidence: Pick<EvidenceStore, 'read'> }, ids: readonly string[], latest: WriterOutput | null): CheckedAnswer[] {
  if (state.scope === null) throw new Error(`Run ${state.id} has no scope`);
  const answers = [...earlierAnswers(state, review, context.evidence), ...(latest === null ? [] : [latest])];
  const cited = answers.flatMap((answer) => answer.findings.flatMap((entry) => entry.explanation?.cases ?? []).map((cited) => cited.lines));
  const citedAt = (side: CitedSide): string[] => cited.filter((lines) => lines.side === side).map((lines) => lines.path);
  const input: AnswerCheckInput = { ids, lineCount: gitLineCounts(context.worktree, state.scope, { head: citedAt('head'), base: citedAt('base') }) };
  return answers.map((answer) => checkAnswer(answer, input));
}

/** The failures of the parts a merge dropped, as one reason of an attempt that failed and as the task of the next names them. */
function droppedWords(dropped: readonly DroppedPart[]): string {
  return dropped.map((part) => `${partNameOf(part)}: ${part.failures.join('; ')}`).join('. ');
}

/**
 * The record of the writer's answer (R18, R19, TD9): the answer merged
 * with the earlier answers of its unit in this attempt of the phase. When
 * every part passed in some answer, it is recorded; when one did not and
 * the unit has an attempt left, the answer is refused with the failures of
 * each part, and the next writer is given them (`writerTask`); on the
 * unit's last attempt, a part that still fails is dropped, and the answer
 * completes the unit. An attempt after one lost with its engine or stopped
 * from outside is no last attempt: that unit blocks and is given fresh
 * attempts, as every unit is, so an interruption never drops a part.
 * Throws `StructuralCheckError` for an answer refused.
 */
export function writerContribution(state: RunState, receipt: { readonly workerId: string; readonly output: unknown }, context: ExplanationContext & { readonly log: (line: string) => void }): { readonly kind: 'explanation.recorded'; readonly version: 1; readonly payload: ExplanationRecorded } {
  const review = requireReview(state);
  const ids = findingsToExplain(review);
  const answers = checkedAnswers(state, review, context, ids, receipt.output as WriterOutput);
  const strays = answers.at(-1)!.strays;
  if (strays.length > 0) context.log(`the answer explains ${strays.join(', ')}, which ${strays.length === 1 ? 'is no finding' : 'are no findings'} of the run that asks a person to act; not kept`);
  const merged = mergeAnswers(answers, ids);
  const failures = writerFailures(review);
  const lastAttempt = failures.length + 1 >= maxAttempts && failures.every((failure) => failure.cause === 'unit');
  if (merged.dropped.length > 0 && !lastAttempt) throw new StructuralCheckError(`the answer fails the engine's checks: ${droppedWords(merged.dropped)}`);
  return { kind: 'explanation.recorded', version: 1, payload: explanationRecord(receipt.workerId, merged, context.evidence) };
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
  const merged = mergeAnswers(checkedAnswers(state, review, context, ids, null), ids, [reason]);
  return { kind: 'explanation.recorded', version: 1, payload: explanationRecord(null, merged, context.evidence) };
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

/** What a decision says, as the writer's task gives it, each text of the decider cleaned. */
function decisionLines(decision: RecordedDecision | undefined, clean: (text: string) => string): string[] {
  if (decision === undefined) return ['    decision: none recorded'];
  const grounds = `        grounds: ${clean(decision.grounds)}`;
  switch (decision.decision) {
    case 'fix':
      return [
        `    decision: fix${decision.departure === null ? '' : ', against a written rule'}`,
        grounds,
        `        approach: ${clean(decision.fix.approach)}`,
        ...decision.fix.rejected.map((option) => `        rejected: ${clean(option.option)}, because ${clean(option.reason)}`),
        ...(decision.departure === null ? [] : [`        departs from the rule "${clean(decision.departure.rule)}" (${clean(decision.departure.source)}): ${clean(decision.departure.reason)}`]),
      ];
    case 'ask':
      return [
        '    decision: ask the author',
        grounds,
        `        question: ${clean(decision.ask.question)}`,
        ...decision.ask.options.map((option, index) => `        option ${String(index + 1)}: ${clean(option.option)}; cost: ${clean(option.cost)}; rule: ${clean(option.rule)}${index === decision.ask.recommended ? '; recommended' : ''}${index === decision.ask.applied ? '; the default deep-review would apply' : ''}`),
      ];
    case 'leave':
      return ['    decision: leave it as it is', grounds, `        reason: ${decision.leave.reason}${decision.leave.supersededBy === null ? '' : `, superseded by ${decision.leave.supersededBy}`}`];
  }
}

/** A candidate of a finding as the writer's task gives it: its place and claim, its verdict, and the evidence and runs of its verifier, cleaned. */
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
  ];
}

/** One ranked finding as the writer's task gives it: its number and id, whether the writer explains it, its severity and verdict, its summary and reason, its decision, and each candidate with its evidence. */
function findingLines(entry: ReportFinding, number: number, explained: boolean, decision: RecordedDecision | undefined, clean: (text: string) => string, fence: (text: string) => string): string[] {
  const verdict = entry.resolution.unverified ? `${entry.resolution.verdict}, which no verifier examined` : entry.resolution.verdict;
  return [
    `#### ${String(number)}. ${entry.finding.id}: ${explained ? 'explain it' : 'context only, not to explain'}`,
    '',
    `    severity: ${entry.finding.severity}; verdict: ${verdict}`,
    `    summary: ${clean(entry.finding.summary)}`,
    `    reason: ${clean(entry.finding.reason)}`,
    ...decisionLines(decision, clean),
    '    candidates:',
    ...[entry.primary, ...entry.members].flatMap((candidate, index) => candidateLines(candidate, index === 0, clean, fence)),
  ];
}

/**
 * The writer's task (R18, R20, TD8): the language the run recorded; the
 * findings it explains; the brief of the run in its report form; every
 * ranked finding with its decision, its evidence and the runs its verdict
 * cites; and, after a refused answer, the parts that still fail with their
 * failures. Each text of a worker is cleaned as the review cleans the
 * text it posts (R11), and the brief and each printed output are fenced.
 * The scope block that follows the task carries the patch. Neither the
 * title nor the body of the pull request is in it (PD8).
 */
export function writerTask(state: RunState, input: WriterTaskInput): string {
  const review = requireReview(state);
  const ids = findingsToExplain(review);
  const clean = (text: string): string => inlineText(publicWords(text, input.machine).text);
  // Cleaned as code, so its places and secrets give way to their marks and nothing in it is escaped, then fenced longer than any run of backticks the cleaning left.
  const quote = (text: string, info = ''): string => fenced(publicCode(text, input.machine).text, info);
  const numbers = findingNumbers(review);
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const ranked = rankedFindings(review);
  const answers = checkedAnswers(state, review, input, ids, null);
  const dropped = answers.length === 0 ? [] : mergeAnswers(answers, ids).dropped;
  return [
    `Write every text of your answer in the language ${languageWords(reviewLanguage(review))}.`,
    '',
    ids.length === 0
      ? 'No finding of this review asks a person to act, so you explain none: give the conclusion with no action, the account, and no entry in `findings`.'
      : `Explain these ${String(ids.length)} finding${ids.length === 1 ? '' : 's'}, each by its id, with an action of the conclusion and an entry of \`findings\`: ${ids.join(', ')}. Every other finding below is context, which you explain nowhere.`,
    '',
    '### The brief of the run',
    '',
    'The engine\'s account of the run, as its report gives it. The review on the pull request carries its facts in the engine\'s own words.',
    '',
    quote(briefMarkdown(briefOf(state), 'report').join('\n'), 'markdown'),
    '',
    '### The findings',
    '',
    `The review's ${String(ranked.length)} finding${ranked.length === 1 ? '' : 's'}, in rank order, each with its decision, every candidate merged into it and its verifier's evidence.`,
    '',
    ...ranked.flatMap((entry) => [...findingLines(entry, numbers.get(entry.finding.id) ?? 0, ids.includes(entry.finding.id), decided.get(entry.finding.id), clean, quote), '']),
    ...(dropped.length === 0 ? [] : [
      '### What failed in the earlier answer',
      '',
      'An earlier writer\'s answer failed the engine\'s checks in these parts, and the engine keeps every other part of it. Give your whole answer again: the engine takes from it only these parts, and drops each that fails again.',
      '',
      ...dropped.map((part) => `- ${partNameOf(part)}: ${part.failures.map((failure) => inlineText(failure)).join('; ')}`),
      '',
    ]),
    'Return `conclusion`, `account` and `findings` as your role prompt defines them.',
  ].join('\n');
}
