/**
 * The checks of the writer's answer (R19, TD9 of the review on the pull
 * request; R4, R10, R11, R13 of the review that reads as a report; R2,
 * R3, R5, R8, TD3, TD6 of the core of the change on the pull request):
 * what the engine can count in an answer, part by part, against what the
 * run holds it to. `explanation.ts` merges the checked answers and
 * records them, and the writer's task tells the next writer what failed.
 */
import type { ScopeState } from '../checkpoint/events.ts';
import { changeReadingOf, type ExplanationVersion, type ReviewState } from '../checkpoint/review-fold.ts';
import { blobsRaw, treeEntries, type TreeEntry } from '../scope/git.ts';
import type { Account, AnyWriterOutput, Area, CitedLines, ConditionSentence, Conclusion, Core, FindingExplanation, RefutedLine } from './explanation.ts';
import { idsIn } from './finding-names.ts';
import { counted } from './markdown.ts';
import type { CitedSide } from './schemas.ts';
import { truncated } from './steps.ts';
import { changeConditions, verdicts, type ChangeConditionName } from './vocabulary.ts';

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

/** One part of an answer with the failures of its checks: kept when it has a value and no failure. */
export interface CheckedPart<T> {
  readonly value: T | null;
  readonly failures: readonly string[];
}

/**
 * An answer checked part by part (TD9): its conclusion; the account of an
 * answer of version 1, or the areas and the refuted lines of one of
 * version 2 or 3, each null in the other; the core and the conditions of
 * an answer of version 3, null in any other; and its explanation of each
 * finding to explain, by id.
 */
export interface CheckedAnswer {
  readonly conclusion: CheckedPart<Conclusion>;
  readonly account: CheckedPart<Account> | null;
  readonly areas: CheckedPart<Area[]> | null;
  readonly refuted: CheckedPart<RefutedLine[]> | null;
  readonly core: CheckedPart<Core> | null;
  readonly conditions: CheckedPart<ConditionSentence[]> | null;
  readonly findings: ReadonlyMap<string, CheckedPart<FindingExplanation>>;
  /** The ids of the entries of `findings` that name no finding to explain: refused, so never kept, and they cost no part. */
  readonly strays: readonly string[];
}

/**
 * A condition of principle 8 that the triage judged to hold (R4 of the
 * brief of a run; R6, R8 of the core of the change on the pull request):
 * its name, the triage's sentence of what, or null when it gave none, and
 * the files that show it.
 */
export interface HeldCondition {
  readonly condition: ChangeConditionName;
  readonly what: string | null;
  readonly files: readonly string[];
}

/** The conditions the run's triage judged to hold, in the order public interface, wide effect; none for a run whose triage gave no account or recorded none. */
export function heldConditions(review: Pick<ReviewState, 'change'>): HeldCondition[] {
  const reading = changeReadingOf(review.change);
  if (reading === null) return [];
  const judged = { 'public-interface': reading.publicInterface, 'wide-effect': reading.wideEffect };
  return changeConditions.flatMap((condition) => (judged[condition].holds ? [{ condition, what: judged[condition].what, files: judged[condition].files }] : []));
}

/**
 * What an answer of version 3 is held to beyond version 2 (R3, R5, R8,
 * TD3, TD6 of the core of the change on the pull request): the full ids
 * of the change's commits, which a source of the core's reason names by a
 * prefix, or null when git could not read them; the paths of the change's files, which a source names whole; the
 * ids of the run's candidates, which the core names none of; and the
 * conditions the triage judged to hold, which the conditions explain.
 */
export interface CoreCheckInput {
  readonly commits: readonly string[] | null;
  readonly files: readonly string[];
  readonly candidates: readonly string[];
  readonly held: readonly HeldCondition[];
}

/** What the checks read beyond the answer: the findings to explain, the count of lines of a path at a side, or null when its commit holds no such file, for an answer of version 2 or 3 what the run holds it to, and for one of version 3 what it holds the core and the conditions to. */
export interface AnswerCheckInput {
  readonly ids: readonly string[];
  readonly lineCount: (side: CitedSide, path: string) => number | null;
  readonly report?: ReportCheckInput;
  readonly core?: CoreCheckInput;
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
function checkConclusion(conclusion: Conclusion, ids: readonly string[], version: ExplanationVersion, asks: readonly string[]): string[] {
  const held = (id: string): boolean => version === 1 || !asks.includes(id);
  const posted = ids.filter(held);
  const named = conclusion.actions.map((action) => action.id);
  const sentenceFor = (id: string): string => (named.filter((name) => name === id).length > 1 ? `the conclusion has more than one sentence for ${id}` : '');
  const diagram = version === 1 ? conclusion.diagram : null;
  const postedActions = conclusion.actions.filter((action) => held(action.id));
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

/** The shortest and the longest prefix of a commit's id that names it as a source of the core's reason (TD3 of the core of the change on the pull request): the 7 characters git shows by default, and the 64 of a whole id in a repository of SHA-256 ids, in either case, as git takes it. */
const commitPrefix = /^[0-9a-f]{7,64}$/i;

/** What a source of a reason names among the commits of the change: no commit, for a source no prefix of an id; none of them; the one it begins alone, by its full id; or how many it begins. */
export type CommitSource =
  | { readonly kind: 'not-a-commit' }
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly commit: string }
  | { readonly kind: 'many'; readonly count: number };

/**
 * The commit of the change a source of a reason names (R3, TD3, TD4 of the
 * core of the change on the pull request), the one rule both the check of
 * the core and the form's link follow: a prefix of its id that begins no
 * other of `commits`, the full ids of the change's commits, which git
 * writes in lower case, so the prefix is compared in lower case.
 */
export function resolveCommitSource(source: string, commits: readonly string[]): CommitSource {
  if (!commitPrefix.test(source)) return { kind: 'not-a-commit' };
  const prefix = source.toLowerCase();
  const begun = commits.filter((commit) => commit.startsWith(prefix));
  if (begun.length === 0) return { kind: 'none' };
  return begun.length === 1 ? { kind: 'one', commit: begun[0]! } : { kind: 'many', count: begun.length };
}

/** The failure of one source of the core's reason, or null when it is a file of the change, or a commit of the change named by a prefix of its id that begins no other commit of the change (R3, TD3). */
function sourceFailure(source: string, input: CoreCheckInput): string | null {
  if (input.files.includes(source)) return null;
  const named = JSON.stringify(source);
  const resolved = resolveCommitSource(source, input.commits ?? []);
  if (resolved.kind === 'not-a-commit') return `the core's reason names ${named}, which is neither a file the change adds, edits or removes nor a commit of the change named by 7 to 64 characters of its id`;
  if (input.commits === null) return `the core's reason names ${named}, a commit, and the engine could not read the commits of the change to check it; name the files of the change that state the reason instead`;
  if (resolved.kind === 'none') return `the core's reason names ${named}, which begins no commit of the change`;
  if (resolved.kind === 'many') return `the core's reason names ${named}, which begins ${String(resolved.count)} commits of the change; name the commit by more characters of its id`;
  return null;
}

/**
 * The core of the change checked (R2, R3, R5, TD3, TD6 of the core of the
 * change on the pull request): a title and what the change does; a reason
 * with a source, or no reason and no source; each source a commit or a
 * file of the change; no verdict of the review and no id of a candidate
 * of the run in any text or the diagram; and the diagram one GitHub
 * draws. Whether the core is true of the code and its sources state its
 * reason is left to the gate (PD5).
 */
export function checkCore(core: Core, input: CoreCheckInput): string[] {
  const texts = [core.title, core.what, core.why ?? '', core.diagram ?? ''];
  return [
    ...(blank(core.title) ? ['the core has no title'] : []),
    ...(blank(core.what) ? ['the core says nothing of what the change does'] : []),
    ...(core.why !== null && blank(core.why) ? ['the core\'s reason is empty; give null when the change states no reason'] : []),
    ...(core.why === null && core.whyFrom.length > 0 ? ['the core gives no reason and names where the reason comes from'] : []),
    ...(core.why !== null && !blank(core.why) && core.whyFrom.length === 0 ? ['the core gives a reason and names no commit or file it comes from'] : []),
    ...core.whyFrom.flatMap((source) => sourceFailure(source, input) ?? []),
    ...verdictFailures('the core', texts),
    ...idsIn(texts.join('\n'), input.candidates).map((id) => `the core names ${id}, an id of this review; the core is about the change as submitted, and names no finding or candidate`),
    ...diagramFailuresOf('the core\'s diagram', core.diagram),
  ];
}

/**
 * The conditions checked (R8 of the core of the change on the pull
 * request): one entry for each condition the triage judged to hold and
 * for no other, each with its explanation or the sentence of what the
 * writer found instead, not both and not neither, no empty text, and no
 * verdict of the review.
 */
export function checkConditions(conditions: readonly ConditionSentence[], held: readonly HeldCondition[]): string[] {
  const { missing, repeated, stray } = idCoverage(conditions.map((entry) => entry.condition), held.map((entry) => entry.condition));
  return [
    ...stray.map((condition) => `the conditions give ${condition}, which the triage did not judge to hold`),
    ...repeated.map(([condition, count]) => `the conditions give ${condition} ${String(count)} times, and a condition has one entry`),
    ...missing.map((condition) => `the conditions give no entry for ${condition}, which the triage judged to hold`),
    ...conditions.flatMap((entry) => {
      const { condition, explanation, unexplained } = entry;
      if (explanation === null && unexplained === null) return [`the entry for ${condition} has neither an explanation nor what the code shows instead`];
      if (explanation !== null && unexplained !== null) return [`the entry for ${condition} has both an explanation and what the code shows instead`];
      const text = explanation ?? unexplained ?? '';
      return [...(blank(text) ? [`the entry for ${condition} is empty`] : []), ...verdictFailures(`the entry for ${condition}`, [text])];
    }),
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
    return { conclusion, account: { value: output.account, failures: checkAccount(output.account) }, areas: null, refuted: null, core: null, conditions: null, findings: new Map(input.ids.map((id) => [id, checkFinding(id, entries.get(id)!, input.lineCount, null)])), strays };
  }
  if (input.report === undefined) throw new Error('An answer in the form of the review that reads as a report is checked against the major findings and the refuted candidates of its run');
  const { major, refuted: refutedIds } = input.report;
  const cored = 'core' in output ? output : null;
  if (cored !== null && input.core === undefined) throw new Error('An answer with the core of the change is checked against the commits, the files and the candidates of its run and the conditions its triage judged');
  return {
    conclusion,
    account: null,
    areas: { value: output.areas, failures: checkAreas(output.areas, input.ids, major) },
    refuted: { value: output.refuted, failures: checkRefuted(output.refuted, refutedIds) },
    core: cored === null ? null : { value: cored.core, failures: checkCore(cored.core, input.core!) },
    conditions: cored === null ? null : { value: cored.conditions, failures: checkConditions(cored.conditions, input.core!.held) },
    findings: new Map(input.ids.map((id) => [id, checkFinding(id, entries.get(id)!, input.lineCount, major.includes(id))])),
    strays,
  };
}
