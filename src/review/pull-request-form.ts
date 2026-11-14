/**
 * The form of the pull request (R9, R10, R12, TD6 of the review on the
 * pull request; R1 to R10, TD3, TD4 of the review in the writer's words):
 * the body and the comments of the one review `publish` posts, rendered
 * from one view of the run (`FormView`) that `formViewOf` in
 * `pull-request-view.ts` builds once, and nothing else. Pure: the caller
 * reads GitHub, the evidence store and the commits, places each finding
 * (`placeFindings`), and this module only renders.
 *
 * Every sentence that says something of the run or of the change is the
 * writer's, from its answer of any version read into one shape. Code
 * shows each fact as data, a labeled value, a facts line or a facts table
 * (`markdown.ts`), with its labels and the names of its values from the
 * table of the run's language (`pull-request-words.ts`), and adds the
 * fixed notices of that table. Where a part of the writer's is missing,
 * the form shows the facts and the other workers' recorded words, each
 * under a label that names its worker, and never joins one to a text of
 * the writer's. Each text of a worker, the writer among them, passes the
 * Speaker, which cleans it (R11 of the review on the pull request). Every
 * link to code is a permalink at the reviewed head, or at the merge base
 * for removed lines. A body over the limit leaves out its pieces in the
 * order of `fitOrder` (`pull-request-fit.ts`) until it fits, the floor
 * last, and a comment over the limit leaves out its record, then all but
 * its facts, so every review is posted (R1 of the review that always
 * posts).
 */
import { standingAnswers } from '../checkpoint/answer-state.ts';
import type { PullRequestFacts } from '../checkpoint/events.ts';
import { repositoryLocation } from '../checkpoint/review-fold.ts';
import { firstSentence, type FindingStatus, type GapFacts } from './brief.ts';
import { diagramFailures, resolveCommitSource } from './explanation-checks.ts';
import type { CitedLines, ConditionSentence } from './explanation.ts';
import { namedFindings, namedInDiagram, type NamedId } from './finding-names.ts';
import { capitalized, codeSpan, factsLine, factsTable, findingAnchor, inlineText, labeledValue, paragraphText, sentenceText, valueList } from './markdown.ts';
import { findingMarker, markerLine, publicationMarker } from './markers.ts';
import { answerArguments, answerCommand } from './needs.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicProse, publicWords, withoutSecrets, type MachineContext } from './public-text.ts';
import { firstFit, fitOrder, leftOutOf, nothingLeftOut, takes, unsettledChoices, type FitStep, type LeftOut } from './pull-request-fit.ts';
import type { DecisionValue, LeftOutKind, LineNote, PullRequestWords, RecordedSpeaker, WholePiece, WriterPart } from './pull-request-words.ts';
import { acts, formViewOf, inFull, isMinor, leftAsIs, majorActing, minorActing, type FindingLocation, type FindingPlacement, type FindingView, type FormView, type PullRequestFormInput } from './pull-request-view.ts';
import { shortRunId } from './runs.ts';
import { choicesShown } from './state.ts';
import { changeConditions, type ChangeConditionName, type FindingPlace, type PlaceReason } from './vocabulary.ts';

/** The most characters of a body or a comment, a margin under the 65,536 people report GitHub takes (R12). */
export const maxPostedLength = 60_000;

/** A commit as the form names it, by its first 8 characters, as the brief names a run. */
const shortCommit = (commit: string): string => commit.slice(0, 8);

/** A comment on a line of the new side of the diff, with the finding it is for. */
export interface FormComment {
  readonly finding: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** What `publish.prepared@1` records of where a finding goes and why. */
export interface RecordedPlace {
  readonly finding: string;
  readonly place: FindingPlace;
  readonly reason: PlaceReason;
}

/** A comment that lost a piece to fit (R7 of the review that always posts): its record, or its text, which leaves its facts alone. */
export interface CommentLeftOut {
  readonly finding: string;
  readonly piece: 'record' | 'text';
}

/** What the form left out to fit (R9 of the review that always posts): the steps of the order taken from the body, in order, and each comment that lost a piece. */
export interface FormLeftOut {
  readonly body: readonly FitStep[];
  readonly comments: readonly CommentLeftOut[];
}

/** The review as the form renders it: the body with its marker last, a comment for each finding on its line, each place, the count of secrets the cleaning replaced, and what was left out to fit. */
export interface PullRequestForm {
  readonly kind: 'rendered';
  readonly body: string;
  readonly comments: readonly FormComment[];
  readonly places: readonly RecordedPlace[];
  readonly secrets: number;
  readonly leftOut: FormLeftOut;
}

/** A text as the cleaning gives it, with the secrets it replaced. */
interface Cleaned {
  readonly text: string;
  readonly secrets: number;
}

/**
 * The cleaning of each text the engine did not write, counting the
 * secrets it replaced (R11): a worker's words and the writer's prose, each
 * on one line, the writer's prose as paragraphs, a worker's text as a code
 * span, and a diagram. Each text is put in the shape it is posted in
 * before it is cleaned, on one line or split into paragraphs, and code is
 * delimited after, so nothing done to a cleaned text turns what the
 * cleaning read as code into Markdown: a fence joined onto one line, or
 * split at a blank line, would no longer be code, and its text would be
 * posted as it was written. A diagram is checked again once cleaned, since
 * a mark the cleaning wrote can break a diagram that passed the checks,
 * and one that no longer passes is left out with the line that says so
 * (R19).
 */
interface Speaker {
  readonly words: (text: string) => string;
  readonly prose: (text: string) => string;
  readonly paragraphs: (text: string) => string[];
  readonly code: (text: string) => string;
  /** A worker's text as a sentence, its first word capitalized when it is a plain lower-case word, alone or followed by a space, as a decider's approach or option often starts. */
  readonly sentence: (text: string) => string;
  readonly diagram: (text: string) => string;
  readonly secrets: () => number;
}

/**
 * The speaker of a review: each worker's text cleaned as it is posted,
 * each id of the run in `names` given the finding's name in the review's
 * language (R1 to R5 of the finding names in the review), in prose and in
 * what a diagram shows, once the text's secrets are marks, so that a name
 * splits no secret, and before the rest of the cleaning. Code a worker
 * quotes as code, given to `code`, keeps its ids.
 */
function speakerOf(machine: MachineContext, words: PullRequestWords, names: ReadonlyMap<string, NamedId>, cache: Map<string, Cleaned> = new Map()): Speaker {
  let secrets = 0;
  /** A text cleaned once for the form, its secrets counted each time it is posted (OQ1 of the review that always posts). */
  const once = (kind: string, text: string, clean: (count: (cleaned: Cleaned) => string) => string): string => {
    const key = `${kind}\u0000${text}`;
    let known = cache.get(key);
    if (known === undefined) {
      let found = 0;
      const cleaned = clean((part) => {
        found += part.secrets;
        return part.text;
      });
      known = { text: cleaned, secrets: found };
      cache.set(key, known);
    }
    secrets += known.secrets;
    return known.text;
  };
  // Named before its lines are joined, so a name that starts a paragraph or a list item reads as the start of a sentence.
  const named = (count: (cleaned: Cleaned) => string, text: string): string => inlineText(namedFindings(count(withoutSecrets(text.trim(), machine)), names, words.naming)).trim();
  const prose = (text: string): string => once('prose', text, (count) => count(publicProse(named(count, text), machine)));
  return {
    words: (text) => once('words', text, (count) => count(publicWords(named(count, text), machine))),
    prose,
    paragraphs: (text) => text.split(/\r?\n[ \t]*\r?\n/).map(prose).filter((paragraph) => paragraph !== '').map(paragraphText),
    code: (text) => once('code', text, (count) => codeSpan(count(publicCode(inlineText(text), machine)))),
    sentence: (text) => once('sentence', text, (count) => {
      const cleaned = count(publicWords(named(count, text), machine));
      return sentenceText(/^[a-z]+(?: |$)/.test(cleaned) ? capitalized(cleaned) : cleaned);
    }),
    // A diagram that cleaning broke is left out, so its secrets are counted only when it is posted.
    diagram: (text) => once('diagram', text, (count) => {
      const unsecret = withoutSecrets(text.replace(/\s+$/, ''), machine);
      const diagram = namedInDiagram(unsecret.text, names, words.naming);
      if (diagram === null) return words.diagramNamesIds;
      const cleaned = publicCode(diagram, machine);
      if (diagramFailures(cleaned.text).length > 0) return words.diagramBroken;
      return fenced(count({ text: cleaned.text, secrets: unsecret.secrets + cleaned.secrets }));
    }),
    secrets: () => secrets,
  };
}

/** A diagram in a Mermaid fence that no run of backticks in it closes. */
function fenced(diagram: string): string {
  const fence = fenceFor(diagram);
  return `${fence}mermaid\n${diagram}\n${fence}`;
}

/** Blocks of lines with one blank line between each two, an empty block left out. */
const blocks = (...parts: readonly (readonly string[])[]): string[] => parts.filter((part) => part.length > 0).flatMap((part, index) => (index === 0 ? [...part] : ['', ...part]));

/** A fold with its summary over blocks, the blank line after the summary that GitHub needs to read them as Markdown. */
const details = (summary: string, ...parts: readonly (readonly string[])[]): string[] => blocks([`<details><summary>${summary}</summary>`], ...parts, ['</details>']);

/** A path from the root of the repository as a URL path, each name percent-encoded, its parentheses too, so no `)` of a name closes the Markdown link the URL is put in. */
const urlPath = (path: string): string => path.split('/').map((name) => encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');

/** The repository of the pull request on its host, as every link of the review starts. */
const repositoryUrl = (pullRequest: PullRequestFacts): string => `https://${pullRequest.host}/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repository)}`;

/** The file `path` at `commit`, as GitHub shows it in the repository of the pull request: a permalink, which no later push moves (R14). */
const fileUrl = (pullRequest: PullRequestFacts, commit: string, path: string): string => `${repositoryUrl(pullRequest)}/blob/${commit}/${urlPath(path)}`;

/** The lines `from` to `to` of `path` at `commit`, a permalink as `fileUrl` is. */
function blobUrl(pullRequest: PullRequestFacts, commit: string, path: string, from: number, to: number): string {
  return `${fileUrl(pullRequest, commit, path)}#L${String(from)}${to === from ? '' : `-L${String(to)}`}`;
}

/** A file a worker named, as a permalink at the reviewed head, or at the merge base for one the change removed, which the head no longer holds. */
function fileSideUrl(view: FormView, path: string): string {
  const removed = view.scope.files.some((file) => file.path === path && file.status === 'deleted');
  return fileUrl(view.pullRequest, removed ? view.scope.base : view.scope.head, path);
}

/** A commit by its full id in the repository of the pull request (TD4 of the core of the change on the pull request): a permalink, which no later push moves. */
const commitUrl = (pullRequest: PullRequestFacts, commit: string): string => `${repositoryUrl(pullRequest)}/commit/${commit}`;

/**
 * A source of a reason (R3, TD4 of the core of the change on the pull
 * request), cleaned by the Speaker: a file of the change as code linked at
 * the reviewed head, or at the merge base for one the change removed, or
 * as code alone when its cleaning changed it, so no link carries what the
 * cleaning took out; a commit of the change, named as the check of the
 * core takes it (`resolveCommitSource`), linked at its permalink by its
 * full id; or code alone for a source that is neither, or a commit when
 * the caller could not read the commits.
 */
function sourceLink(view: FormView, source: string, say: Speaker): string {
  if (view.scope.files.some((entry) => entry.path === source)) {
    const shown = say.code(source);
    return shown === codeSpan(inlineText(source)) ? `[${shown}](${fileSideUrl(view, source)})` : shown;
  }
  const resolved = resolveCommitSource(source, view.input.commits ?? []);
  return resolved.kind === 'one' ? `[${codeSpan(shortCommit(resolved.commit))}](${commitUrl(view.pullRequest, resolved.commit)})` : say.code(source);
}

/** The line of a location at the reviewed head. */
const headUrl = (view: FormView, location: FindingLocation): string => blobUrl(view.pullRequest, view.scope.head, location.path, location.line, location.line);

/** A location as a link to its line at the head, its text on one line whatever line break its path holds. */
const locationLink = (view: FormView, location: FindingLocation): string => `[${codeSpan(inlineText(`${location.path}:${String(location.line)}`))}](${headUrl(view, location)})`;

/** The forms a finding takes in a body, as `shownAs` gives them. */
type ShownAs = 'block' | 'item' | 'line' | 'none';

/**
 * The form a finding takes under what is left out (R2, R6 of the review
 * that always posts), which the link to it, the section that lists it, its
 * line and the notice that a model wrote the sentences all read: `block`,
 * its block with its anchor, which a finding on its line has in its
 * comment; `item`, a minor finding in full whose text left, as an item
 * with its anchor and its line; `line`, a major finding in full whose text
 * left, as its line in its area with no anchor; `none`, a finding the body
 * no longer holds, a finding left as is that a `left` step took, a minor
 * finding whose line left, and every finding at the floor.
 */
function shownAs(view: Page, finding: FindingView): ShownAs {
  if (view.leftOut.floor) return 'none';
  const { id } = finding.finding;
  if (!acts(finding)) return takes(view.leftOut, id, 'left') ? 'none' : 'block';
  if (!takes(view.leftOut, id, 'text')) return 'block';
  if (!isMinor(finding)) return 'line';
  return takes(view.leftOut, id, 'line') ? 'none' : 'item';
}

/** Where the body links a finding (R14, TD4): the line its comment sits on, at the head, or its block or item in the body; none for a finding whose anchor the body no longer holds. */
const hrefOf = (view: Page, finding: FindingView): string | null => {
  if (finding.placement.place === 'line') return headUrl(view, finding.placement.location);
  const shown = shownAs(view, finding);
  return shown === 'block' || shown === 'item' ? `#${findingAnchor(finding.finding.number)}` : null;
};

/** The marks after a finding's verdict: no verifier examined it. */
const verdictMarks = (view: FormView, finding: FindingView): string[] => (finding.entry.resolution.unverified ? [view.words.unverifiedMark] : []);

/** A finding's verdict with its marks, as the areas and the minor table give it. */
const verdictText = (view: FormView, finding: FindingView): string => [finding.finding.verdict, ...verdictMarks(view, finding)].join(', ');

/** Recorded words of another worker under the label that names it (R8 of the review in the writer's words), already cleaned by the Speaker. */
const recordedWords = (view: FormView, speaker: RecordedSpeaker, text: string): string => `${view.words.recorded[speaker]}: ${text}`;

/** A finding's number as a link to where the body or its comment gives it, with the label that says finding; as text for a finding the body no longer holds. */
const findingRef = (view: Page, finding: FindingView): string => {
  const href = hrefOf(view, finding);
  const said = `${view.words.findingLabel} ${String(finding.finding.number)}`;
  return href === null ? said : `[${said}](${href})`;
};

/** The findings of `numbers` as links, each once, in ascending order, as `findingWords` names them; a number of no ranked finding as itself. */
function findingRefs(view: Page, numbers: readonly number[]): string {
  return valueList([...new Set(numbers)].sort((a, b) => a - b).map((number) => {
    const finding = view.findings.find((candidate) => candidate.finding.number === number);
    return finding === undefined ? String(number) : findingRef(view, finding);
  }));
}

/** The status the decision alone gives a finding in a run that only reviewed, so a status that differs is one an answer gave (R6 of the review in the writer's words). */
function decidedStatus(finding: FindingView): FindingStatus {
  const { decision } = finding;
  if (decision?.decision === 'fix') return decision.departure === null ? 'planned' : 'planned-against-rule';
  return decision?.decision === 'ask' ? 'question' : 'left';
}

/** The decision on a finding as its facts name it. */
function decisionValue(finding: FindingView): DecisionValue {
  const { decision } = finding;
  if (decision?.decision === 'fix') return decision.departure === null ? 'fix' : 'fix-against-rule';
  return decision?.decision === 'ask' ? 'ask' : 'leave';
}

/** What the pull request does to a finding's line, or that it has no place; none for an added line. */
function lineNoteOf(placement: FindingPlacement): LineNote | null {
  if (placement.reason === 'no-place') return 'no-place';
  switch (placement.diff) {
    case 'context':
    case 'outside-the-hunks':
      return 'line-not-changed';
    case 'not-in-the-pull-request':
      return 'file-not-changed';
    case 'no-patch':
      return placement.reason === 'no-patch' ? 'no-patch' : null;
    default:
      return null;
  }
}

/** The facts line of a finding (R5): its severity, its verdict with its marks, how its verifier checked it, its decision, what became of it when an answer changed it, and what the pull request does to its line, with `extra` facts after. */
function findingFacts(view: FormView, finding: FindingView, extra: readonly (readonly [string, string])[] = []): string {
  const { words } = view;
  const { basis } = finding.entry.resolution;
  const status = finding.finding.status === decidedStatus(finding) ? [] : [[words.statusLabel, words.statusValues[finding.finding.status]] as const];
  const note = lineNoteOf(finding.placement);
  return factsLine([
    [words.severityLabel, finding.finding.severity],
    [words.verdictLabel, verdictText(view, finding)],
    ...(basis === null ? [] : [[words.checkedByLabel, words.basisValues[basis]] as const]),
    [words.decisionLabel, words.decisionValues[decisionValue(finding)]],
    ...status,
    ...extra,
    ...(note === null ? [] : [[words.lineLabel, words.lineNotes[note]] as const]),
  ]);
}

/** The writer's title of a finding, from its entry left as is before its entry that acts; none where the writer gave neither. */
const writtenTitle = (finding: FindingView): string | undefined => finding.left?.title ?? finding.written?.title;

/** A finding's title as a line of its own: the writer's in bold, or the first sentence of its summary as the ranking's recorded words. */
function titleLine(view: FormView, finding: FindingView, say: Speaker): string {
  const text = titleText(view, finding, say);
  return writtenTitle(finding) === undefined ? text : `**${text}**`;
}

/** A finding's title inside a line or a cell: the writer's, or the ranking's recorded words under their label. */
function titleText(view: FormView, finding: FindingView, say: Speaker): string {
  const written = writtenTitle(finding);
  return written === undefined ? recordedWords(view, 'ranking', say.words(firstSentence(finding.entry.finding.summary))) : say.prose(written);
}

/** The heading of a finding's block, its comment or its text in full: the label and its number, then its title. */
const findingHeading = (view: FormView, finding: FindingView, say: Speaker): string[] => [`**${view.words.findingLabel} ${String(finding.finding.number)}**`, '', titleLine(view, finding, say)];

/** What deep-review would do about a finding that acts, as one text: the writer's `action`, or, as the decider's recorded words (R8 of the review in the writer's words), the first sentence of the decided approach of a fix or of the option a question recommends; none for a finding that does neither. */
function actionText(view: FormView, finding: FindingView, say: Speaker): string | null {
  const action = finding.written?.action ?? null;
  if (action !== null) return sentenceText(say.prose(action));
  if (finding.decision?.decision === 'fix') return recordedWords(view, 'decider', say.sentence(firstSentence(finding.decision.fix.approach)));
  const { question } = finding;
  const recommended = question?.options.find((option) => option.number === question.choice);
  return recommended === undefined ? null : recordedWords(view, 'decider', say.sentence(firstSentence(recommended.option)));
}

/** The facts of a question that stand beside its finding wherever it is listed: the option recommended, and the answer or the option that stands until one. */
function questionFacts(view: FormView, finding: FindingView): (readonly [string, string])[] {
  const { words } = view;
  const { question } = finding;
  if (question === null) return [];
  const given = question.answer;
  const answer = given !== null && given.option !== null
    ? [[words.statusLabel, words.questionStatus.answered], [words.answeredLabel, String(given.option)], [words.answeredOnLabel, given.at]] as const
    : [[words.standingLabel, String(question.default)], [words.editsLabel, question.options[question.default - 1]!.edits ? words.yesNo.yes : words.yesNo.no], [words.statusLabel, words.questionStatus.open]] as const;
  return [[words.recommendedLabel, String(question.choice)], ...answer];
}

/** The facts of a fix against a written rule: whether it stands, or the answer, and when. */
function departureFacts(view: FormView, finding: FindingView): (readonly [string, string])[] {
  const { words } = view;
  const given = finding.departure?.review ?? null;
  if (given === null) return [[words.statusLabel, words.departureStatus.stands]];
  return [[words.statusLabel, given.kind === 'reject' ? words.departureStatus.rejected : words.departureStatus.accepted], [words.answeredOnLabel, given.at]];
}

/** The mark of a finding the writer did not explain, with its reason (R19 of the review on the pull request); none for one it explained or a run with no explanation. */
function unexplainedBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const { explained } = finding;
  if (explained.kind !== 'unexplained') return [];
  return [[[view.words.unexplainedNotice, ...(explained.reason === null ? [] : [`${view.words.writerReasonLabel}: ${sentenceText(say.prose(explained.reason))}`])].join(' ')]];
}

/** What goes wrong: the writer's problem, its first paragraph under its label, or the finder's own account as its recorded words. */
function problemBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const written = finding.written;
  if (written === null) return [[recordedWords(view, 'finder', paragraphText(say.words(finding.entry.primary.detail)))]];
  const paragraphs = say.paragraphs(written.problem);
  return paragraphs.map((paragraph, index) => [index === 0 ? `${view.words.problemLabel} ${paragraph}` : paragraph]);
}

/** Why a PLAUSIBLE verdict is not CONFIRMED (R7 of the review that reads as a report; R5 of the review in the writer's words): the writer's text with the verifier's kind of it as a fact, or the kind with the verifier's reason as recorded words, or that no verifier examined it, or that the verdict predates the reason; none for a CONFIRMED one. */
function unconfirmedBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const { words } = view;
  if (finding.finding.verdict !== 'PLAUSIBLE') return [];
  if (finding.entry.resolution.unverified) return [[`${words.unconfirmedLabel} ${words.unconfirmedUnverified}`]];
  const written = finding.written?.unconfirmed ?? null;
  const given = finding.unconfirmed;
  const kind = given === null ? [] : [factsLine([[words.whyPlausibleLabel, words.unconfirmedKinds[given.kind]]])];
  if (written !== null) return [[[words.unconfirmedLabel, sentenceText(say.prose(written)), ...kind].join(' ')]];
  if (given === null) return [[`${words.unconfirmedLabel} ${words.unconfirmedBefore}`]];
  return [[[words.unconfirmedLabel, ...kind, recordedWords(view, 'verifier', sentenceText(say.words(given.text)))].join(' ')]];
}

/** The steps that settled the choices a decision makes, as a facts line; none for a decision that settles none. */
function settledFacts(view: FormView, finding: FindingView): string[][] {
  const settled = finding.decision?.settled ?? [];
  if (settled.length === 0) return [];
  return [[factsLine([[view.words.settledByLabel, valueList([...new Set(settled.map((entry) => view.words.settleSteps[entry.by]))])]])]];
}

/** A fix against a written rule (R8): the writer's text of it, or the decider's rule, source and fact as its recorded words; then its status and how it is answered. */
function departureBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const { words } = view;
  const { departure } = finding;
  if (departure === null) return [];
  const written = finding.written?.fix?.departure ?? null;
  const text = written !== null ? [[`${words.departureLabel} ${sentenceText(say.prose(written))}`]] : [[words.departureLabel], departureRecord(view, finding, say)];
  const commands = factsLine([[words.acceptLabel, codeSpan(departure.accept)], [words.rejectLabel, codeSpan(departure.reject)]]);
  return [...text, [factsLine(departureFacts(view, finding))], [`${words.departureNotices[view.fixPass]} ${commands}`]];
}

/** The decider's rule, source and fact of a departure, each its recorded words under its label. */
function departureRecord(view: FormView, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const { departure } = finding;
  if (departure === null) return [];
  const sentence = (text: string): string => sentenceText(say.words(text));
  return [`- ${words.ruleLabel}: ${sentence(departure.rule)}`, `- ${words.sourceLabel}: ${sentence(departure.source)}`, `- ${words.factLabel}: ${say.sentence(departure.fact)}`];
}

/**
 * A question (R8): the writer's question, or the decider's as its
 * recorded words; its options as a table, with the writer's words for
 * each, or the decider's, and whether each edits the code; the facts of
 * the option recommended and the one that stands or the answer; the
 * writer's reason for the recommendation; and how it is answered.
 */
function questionBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const { words } = view;
  const { question } = finding;
  if (question === null) return [];
  const ask = finding.written?.ask ?? null;
  const asked = ask === null ? recordedWords(view, 'decider', say.sentence(question.question)) : sentenceText(say.prose(ask.question));
  const columns = words.optionColumns;
  const rows = question.options.map((option) => {
    const given = ask?.options.find((entry) => entry.number === option.number);
    const text = (writer: string | undefined, recorded: string): string => (writer === undefined ? say.sentence(recorded) : sentenceText(say.prose(writer)));
    return [String(option.number), text(given?.means, option.option), text(given?.cost, option.cost), text(given?.rule, option.rule), option.edits ? words.yesNo.yes : words.yesNo.no];
  });
  const labels = [columns.number, ...(ask === null ? [words.recorded.decider] : [columns.means]), columns.cost, columns.rule, columns.edits];
  const recommendation = ask === null ? [] : [[`${words.recommendationLabel} ${sentenceText(say.prose(ask.recommendation))}`]];
  const command = factsLine([[words.commandLabel, codeSpan(answerCommand(view.state.id, finding.finding.number, '--option <k>'))]]);
  const answered = question.answer !== null && question.answer.option !== null;
  return [[`${words.questionLabel} ${asked}`], factsTable(labels, rows), [factsLine(questionFacts(view, finding))], ...recommendation, ...(answered ? [] : [[`${words.answerNotices[view.fixPass]} ${command}`]])];
}

/**
 * The decision as deep-review recorded it (R4 of the review in the
 * writer's words): the writer's text of the fix first, paragraph by
 * paragraph, its first under its label, then the recorded words, each under
 * its label, beside the notice that an answer and the fix pass apply them
 * for a fix or a question, and no notice for a finding left as is: the
 * approach and each option rejected, or each option of a
 * question with its cost and its rule, the departure's rule, source and
 * fact where the writer restated it, the grounds of the decision, and
 * each choice a verifier left to the author beside the choice that
 * settles it and its source, or that deep-review did not settle it.
 * Folded, whether it stands beside the writer's text or in for it, since
 * a block with no writer's text shows the decider's words in view.
 */
function recordBlocks(view: Page, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const { decision, question } = finding;
  if (decision === null) return [];
  const fixText = finding.written?.fix?.text ?? null;
  // Paragraph by paragraph, as the writer's problem is, since a text of a fix that covers several choices is long.
  const writerText = fixText === null ? [] : say.paragraphs(fixText).map((paragraph, index) => [index === 0 ? `${words.fixTextLabel} ${paragraph}` : paragraph]);
  if (takes(view.leftOut, finding.finding.id, 'record')) {
    // The record leaves the fold, which keeps the writer's text of a fix alone; the command that prints the record and each choice no one settled stand after it (R2, R4, R6 of the review that always posts).
    const fold = writerText.length === 0 ? [] : details(words.fixTextSummary, ...writerText);
    return blocks(fold, [`${words.recordLeftOut} ${factsLine([[words.printCommandLabel, codeSpan(reportCommand(view, finding))]])}`], choiceRecord(view, finding, say, 'open'));
  }
  const recorded: string[] = [];
  if (decision.decision === 'fix') {
    recorded.push(`- ${words.approachLabel}: ${say.sentence(decision.fix.approach)}`);
    for (const option of decision.fix.rejected) recorded.push(`- ${words.rejectedLabel}: ${say.sentence(option.option)} ${words.rejectedWhyLabel}: ${say.sentence(option.reason)}`);
    if (finding.written?.fix?.departure !== null && finding.written?.fix?.departure !== undefined) recorded.push(...departureRecord(view, finding, say));
  }
  if (decision.decision === 'ask' && question !== null) {
    for (const option of question.options) recorded.push(`- ${words.optionLabel} ${String(option.number)}: ${say.sentence(option.option)} ${words.costLabel}: ${say.sentence(option.cost)} ${words.ruleLabel}: ${say.sentence(option.rule)}`);
  }
  recorded.push(`- ${words.groundsLabel}: ${say.sentence(decision.grounds)}`, ...choiceRecord(view, finding, say));
  // A finding left as is takes no answer and the fix pass applies nothing to it, so its record carries no notice that they apply these words.
  const notice = decision.decision === 'leave' ? [] : [words.recordNotice];
  const parts = [...writerText, [`${words.recorded.decider}:`, ...recorded]];
  return details(words.recordSummary, notice, ...parts);
}

/** The command that prints a finding of the run from the ledger, with its evidence and its decision in the words of the workers that recorded them. */
const reportCommand = (view: FormView, finding: FindingView): string => `deep-review report --run ${shortRunId(view.state.id)} --finding ${String(finding.finding.number)}`;

/** What deep-review would do about a finding of R5's order, each a block: its action, the steps that settled its choices and its departure for a fix, or its question, then the decision as recorded. */
function decisionBlocks(view: Page, finding: FindingView, say: Speaker): string[][] {
  const { words } = view;
  const { decision } = finding;
  const action = actionText(view, finding, say);
  if (decision?.decision === 'fix') {
    return [...(action === null ? [] : [[`${words.actionLabel} ${action}`]]), ...settledFacts(view, finding), ...departureBlocks(view, finding, say), recordBlocks(view, finding, say)];
  }
  if (decision?.decision === 'ask') return [...(action === null ? [] : [[`${words.askLabel} ${action}`]]), ...questionBlocks(view, finding, say), recordBlocks(view, finding, say)];
  return [];
}

/** How the verifier checked a finding, folded (R10): the writer's line, or the notice of the verdict's basis. */
function checkedLines(view: FormView, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const { resolution } = finding.entry;
  const fallback = resolution.unverified ? words.notVerified : resolution.basis === null ? words.noBasis : words.basisNotices[resolution.basis];
  const written = finding.written?.checked ?? null;
  return details(words.checkedSummary, [written === null || written === '' ? fallback : paragraphText(sentenceText(say.prose(written)))]);
}

/** The lines a case cites, as a link at the commit of its side: the head, or the merge base for lines the change removed, under its label (R14); its text is on one line whatever line break the path holds. */
function caseLink(view: FormView, cited: CitedLines): string {
  const range = cited.from === cited.to ? String(cited.from) : `${String(cited.from)}-${String(cited.to)}`;
  const link = `[${codeSpan(inlineText(`${cited.path}:${range}`))}](${blobUrl(view.pullRequest, cited.side === 'head' ? view.scope.head : view.scope.base, cited.path, cited.from, cited.to)})`;
  return cited.side === 'head' ? link : labeledValue(view.words.atBaseLabel, link);
}

/** The code a finding rests on (R5): each case the writer cites with its sentence, or, for a minor finding and one with no cases, its own line at the head; none for a finding with no place. */
function codeLines(view: FormView, finding: FindingView, say: Speaker, minor: boolean): string[] {
  const { words } = view;
  const cases = !minor && finding.written !== null ? finding.written.cases : [];
  if (cases.length > 0) return [`${words.codeLabel}:`, ...cases.map((cited) => `- ${caseLink(view, cited.lines)} ${sentenceText(say.prose(cited.sentence))}`)];
  const { location } = finding.placement;
  return location === null ? [] : [factsLine([[words.codeLabel, locationLink(view, location)]])];
}

/** The parts of a finding's block, which a comment and the body share. */
interface FindingParts {
  readonly explanation: string[];
  readonly decision: string[];
  readonly checked: string[];
  readonly code: string[];
}

/** The parts of the block of a finding in R5's order: its facts, the mark of one not explained, what goes wrong, its diagram for a major one, why it is not CONFIRMED, then its decision, how it was checked for a major one, and its code. */
function findingParts(view: Page, finding: FindingView, say: Speaker): FindingParts {
  const minor = isMinor(finding);
  const diagram = !minor && finding.written?.diagram !== null && finding.written?.diagram !== undefined ? [[say.diagram(finding.written.diagram)]] : [];
  return {
    explanation: blocks([findingFacts(view, finding)], ...unexplainedBlocks(view, finding, say), ...problemBlocks(view, finding, say), ...diagram, ...unconfirmedBlocks(view, finding, say)),
    decision: blocks(...decisionBlocks(view, finding, say)),
    checked: minor ? [] : checkedLines(view, finding, say),
    code: codeLines(view, finding, say, minor),
  };
}

const joinedParts = (parts: FindingParts): string[] => blocks(parts.explanation, parts.decision, parts.checked, parts.code);

/** The line that traces a finding to the run, as labeled values. */
const traceLine = (view: FormView, finding: FindingView): string => `<sub>${factsLine([[view.words.findingLabel, codeSpan(inlineText(finding.finding.id))], [view.words.runLabel, codeSpan(shortRunId(view.state.id))]])}</sub>`;

/**
 * The comment of a finding on its line, with the id of the finding and its
 * marker as its last lines, and what it left out to fit (R7 of the review
 * that always posts): the comment in full; over the limit, without the
 * record of its decision; still over, its facts form, which holds the
 * label and the number of the finding, its facts, the notice that its
 * text did not fit and the command that prints it, then each choice its
 * verifiers left to the author that deep-review did not settle, labeled
 * as the verifier's, since what waits on a person stays in view (R4, R7).
 * Those choices are the one text of a worker in the facts form, so a
 * facts form they would carry over the limit leaves them out, and the
 * form always fits. A comment is fitted alone, so what it loses changes
 * no other comment.
 */
function commentOf(view: FormView, finding: FindingView & { readonly placement: Extract<FindingPlacement, { place: 'line' }> }, cache: Map<string, Cleaned>): { readonly comment: FormComment; readonly secrets: number; readonly leftOut: CommentLeftOut['piece'] | null } {
  const { location } = finding.placement;
  const trace = [[traceLine(view, finding)], [markerLine(findingMarker(view.state.id, finding.finding.id))]];
  const render = (leftOut: LeftOut): { readonly body: string; readonly secrets: number } => {
    const page: Page = { ...view, leftOut, commentsLeftOut: [] };
    const say = speakerOf(view.input.machine, view.words, view.names, cache);
    return { body: blocks(findingHeading(page, finding, say), joinedParts(findingParts(page, finding, say)), ...trace).join('\n'), secrets: say.secrets() };
  };
  const placed = (body: string): FormComment => ({ finding: finding.finding.id, path: location.path, line: location.line, body });
  const whole = render(nothingLeftOut);
  if (whole.body.length <= maxPostedLength) return { comment: placed(whole.body), secrets: whole.secrets, leftOut: null };
  const unrecorded = render(leftOutOf([{ piece: 'record', finding: finding.finding.id }]));
  if (unrecorded.body.length <= maxPostedLength) return { comment: placed(unrecorded.body), secrets: unrecorded.secrets, leftOut: 'record' };
  const { words } = view;
  const factsForm = (choices: readonly string[]): string => blocks([`**${words.findingLabel} ${String(finding.finding.number)}**`], [findingFacts(view, finding)], [`${words.commentFactsNotice} ${factsLine([[words.printCommandLabel, codeSpan(reportCommand(view, finding))]])}`], [...choices], ...trace).join('\n');
  const say = speakerOf(view.input.machine, view.words, view.names, cache);
  const open = factsForm(choiceRecord(view, finding, say, 'open'));
  if (open.length <= maxPostedLength) return { comment: placed(open), secrets: say.secrets(), leftOut: 'text' };
  return { comment: placed(factsForm([])), secrets: 0, leftOut: 'text' };
}

/** The view as the body renders it with a prefix of the order left out (`leftOutOf`). */
interface Page extends FormView {
  readonly leftOut: LeftOut;
  /** The comments that lost a piece to fit, which the notice under the heading counts. */
  readonly commentsLeftOut: readonly CommentLeftOut[];
}

/** One section of the body, as its lines; a section with none is left out of the body. */
interface Section {
  readonly lines: readonly string[];
}

/** The command that continues the run into its fix pass. */
const fixCommand = (view: FormView): string => codeSpan(`deep-review review --pr ${String(view.pullRequest.number)} --fix`);

/** The heading and the facts of what the run reviewed and what followed it (R1; R6 of the review of a fix run), with the notice of a run that went on into its fix pass, then the notice of what was left out to fit (R6, PD10 of the review that always posts). */
function headingSection(view: Page): Section {
  return { lines: blocks(...headingFacts(view), leftOutNotice(view)) };
}

/** The heading, the facts of what the run reviewed and what followed it, and the notice of a run that went on into its fix pass, as the body and the floor open. */
function headingFacts(view: FormView): string[][] {
  const { words, scope } = view;
  const facts = factsLine([[words.headLabel, codeSpan(shortCommit(scope.head))], [words.baseLabel, codeSpan(shortCommit(scope.base))], [words.filesLabel, String(scope.files.length)], [words.afterLabel, words.afterValues[view.fixPass]]]);
  return [[words.heading], [facts], view.fixPass === 'continued' ? [words.continuedNotice] : []];
}

/**
 * The notice of what was left out to fit (R6 of the review that always
 * posts), none when nothing was: the fixed notice, then as facts each
 * piece left out whole, the count of each kind taken one finding at a
 * time at the last state the order left it in, the count of the comments
 * that lost a piece, and the command that prints a finding.
 */
function leftOutNotice(view: Page): string[] {
  const { words, leftOut } = view;
  const whole = (['minor-table', 'refuted', 'diagrams'] as const satisfies readonly WholePiece[]).filter((piece) => (piece === 'minor-table' ? leftOut.minorTable : piece === 'refuted' ? leftOut.refuted : leftOut.diagrams));
  const states = [...leftOut.findings.values()];
  const counts: Readonly<Record<Exclude<LeftOutKind, 'whole'>, number>> = {
    records: states.filter((state) => state === 'record').length,
    left: states.filter((state) => state === 'left').length,
    texts: states.filter((state) => state === 'text').length,
    lines: states.filter((state) => state === 'line').length,
    commentRecords: view.commentsLeftOut.filter((comment) => comment.piece === 'record').length,
    commentTexts: view.commentsLeftOut.filter((comment) => comment.piece === 'text').length,
  };
  const counted = (Object.keys(counts) as (keyof typeof counts)[]).filter((kind) => counts[kind] > 0);
  if (whole.length === 0 && counted.length === 0) return [];
  const facts = factsLine([
    ...(whole.length === 0 ? [] : [[words.leftOutLabels.whole, valueList(whole.map((piece) => words.wholePieces[piece]))] as const]),
    ...counted.map((kind) => [words.leftOutLabels[kind], String(counts[kind])] as const),
    [words.reportCommandLabel, codeSpan(reportCommandOf(view))],
  ]);
  return [`${words.leftOutNotice} ${facts}`];
}

/** The command that prints a finding of the run, with the place of its number. */
const reportCommandOf = (view: FormView): string => `deep-review report --run ${shortRunId(view.state.id)} --finding <n>`;

/**
 * The floor (R5, TD6 of the review that always posts): the body a review
 * posts when nothing less fits, which holds no text of a worker and no
 * text whose length a run decides. In this order: the heading with what
 * the run reviewed; the notice in its form for the floor, with the count
 * of the comments that lost a piece and the command that prints a
 * finding; the table of the findings by severity and by decision with the
 * notice of what happens next; how many questions, fixes against a
 * written rule and choices that no one settled wait on a person, with the
 * command that answers a question or a fix; each condition that holds, as
 * its label, or, when none is listed, the fixed label that none holds or
 * that none was judged, and the number of fixes on a PLAUSIBLE verdict;
 * the fixed line that no check ran in the review, or that the fix pass
 * runs the checks, then each kind of gap the run has, as its label, or
 * that it has none; the tables of the verdicts and of how
 * the findings were checked, with the notice that a model wrote the
 * sentences when a comment posted with the floor holds a text of the
 * writer; the last line, with no version of the runtime and no model,
 * which are strings the form does not bound; and the marker of the
 * publication, by which a stopped publication is found again.
 */
function floorBody(view: Page): string {
  const { words } = view;
  const comments = (['record', 'text'] as const).map((piece) => [piece === 'record' ? words.leftOutLabels.commentRecords : words.leftOutLabels.commentTexts, view.commentsLeftOut.filter((comment) => comment.piece === piece).length] as const).filter(([, count]) => count > 0);
  const notice = `${words.floorNotice} ${factsLine([...comments.map(([label, count]) => [label, String(count)] as const), [words.reportCommandLabel, codeSpan(reportCommandOf(view))]])}`;
  const questions = view.findings.filter((finding) => finding.question !== null && (finding.question.answer === null || finding.question.answer.option === null)).length;
  const departures = view.findings.filter((finding) => finding.departure !== null && finding.departure.review === null).length;
  const choices = view.findings.reduce((sum, finding) => sum + unsettledChoices(finding), 0);
  const waiting = factsLine([[words.waitingLabels.questions, String(questions)], [words.waitingLabels.departures, String(departures)], [words.waitingLabels.choices, String(choices)]]);
  const plausible = view.findings.filter((finding) => finding.decision?.decision === 'fix' && finding.finding.verdict === 'PLAUSIBLE').length;
  const held = heldConditionsOf(view);
  // With no condition listed, the fixed label says that none holds or that none was judged, as the full body says it, so a run whose conditions were never judged does not read as one where none hold.
  const conditions = held.length > 0 ? [] : [factsLine([[words.conditionsLabel, view.brief.change.state === 'given' ? words.none : words.notJudged]])];
  const looks = [...held.map(({ condition }) => words.conditionLabels[condition]), ...(plausible === 0 ? [] : [factsLine([[words.plausibleFixesLabel, String(plausible)]])])].map((item) => `- ${item}`);
  const kinds = [...new Set(view.brief.notExamined.map((gap) => gap.facts.kind))];
  // The fixed line that no check ran, or that the fix pass runs them, first, as the full body gives it, so the floor claims no coverage the run did not have.
  const checks = view.fixPass === 'continued' ? words.noCheckContinued : factsLine([[words.checksRunLabel, words.none]]);
  const gaps = [checks, ...(kinds.length === 0 ? [factsLine([[words.gapsLabel, words.none]])] : kinds.map((kind) => words.gapLabels[kind]))].map((item) => `- ${item}`);
  const labels = words.lastLabels;
  const { configuration } = view.review;
  const last = factsLine([[labels.engine, `deep-review ${inlineText(view.input.engine)}`], [labels.runtime, configuration.runtime], [labels.run, codeSpan(shortRunId(view.state.id))], [labels.commits, `${shortCommit(view.scope.base)}..${shortCommit(view.scope.head)}`]]);
  return blocks(
    ...headingFacts(view),
    [notice],
    [words.summaryHeading],
    ...summaryFacts(view),
    [words.needsHeading],
    [waiting],
    questions + departures === 0 ? [] : answerLine(view, questions > 0, departures > 0),
    conditions,
    looks,
    [words.notExaminedHeading],
    gaps,
    [words.trustHeading],
    ...trustTables(view),
    postsWriterText(view) ? [words.modelNotice] : [],
    [last],
    [markerLine(publicationMarker(view.state.id, view.input.serial))],
  ).join('\n');
}

/**
 * The core of the change (R1 to R4, R10, R11 of the core of the change on
 * the pull request): the writer's title, what the change does, why, the
 * sources of the reason as links, its diagram, and whose reading it is;
 * or the triage's title, account and reason as its recorded words, with
 * the sources, and that it is the triage's; or that the run has no
 * account, and why. Its text leaves only with the floor, and its diagram
 * with the step that leaves out the diagrams, where a notice of its own
 * stands in its place (R2 row 5 of the review that always posts).
 */
function coreSection(view: Page, say: Speaker): Section {
  const { words, core } = view;
  if (core.kind === 'none') return { lines: [words.coreHeading, '', words.coreNone[core.state]] };
  const sources = (given: readonly string[]): string[][] => (given.length === 0 ? [] : [[factsLine([[words.sourcesLabel, valueList(given.map((source) => sourceLink(view, source, say)))]])]]);
  const noReason = [[factsLine([[words.reasonLabel, words.noReason]])]];
  if (core.kind === 'writer') {
    const { title, what, why, whyFrom, diagram } = core.core;
    const reason = why === null ? noReason : [[`${words.whyLabel} ${sentenceText(say.prose(why))}`], ...sources(whyFrom)];
    const drawn = diagram === null ? [] : view.leftOut.diagrams ? [words.coreDiagramCut] : [say.diagram(diagram)];
    return { lines: blocks([words.coreHeading], [`**${say.prose(title)}**`], ...say.paragraphs(what).map((paragraph) => [paragraph]), ...reason, drawn, [words.coreWhoseWriter]) };
  }
  const { title, change } = core;
  // The triage's title, account and reason are its recorded words, under its label once, as the notice after them says.
  const reason = change.why === null ? noReason : [[`${words.whyLabel} ${sentenceText(say.words(change.why))}`], ...sources(change.whyFrom)];
  return { lines: blocks([words.coreHeading], [`${words.recorded.triage}: **${say.words(title)}**`], [paragraphText(say.words(change.what))], ...reason, [words.coreWhoseTriage]) };
}

/** The summary (R1): the writer's summary, the table of the findings by severity and by decision, and the notice of what happens next with the command that applies the fixes. */
function summarySection(view: Page, say: Speaker): Section {
  const written = view.summary === null ? [] : say.paragraphs(view.summary).map((paragraph) => [paragraph]);
  return { lines: blocks([view.words.summaryHeading], ...written, ...summaryFacts(view)) };
}

/** The table of the findings by severity and by decision, and the notice of what happens next with the command that applies the fixes, as the summary and the floor give them. */
function summaryFacts(view: FormView): string[][] {
  const { words, counts, decided } = view;
  const labels = words.counts;
  const table = factsTable([labels.findings, labels.critical, labels.major, labels.minor, labels.fix, labels.ask, labels.leave], [[counts.findings, counts.critical, counts.major - counts.critical, counts.minor, decided.fix, decided.ask, decided.leave].map(String)]);
  const acting = decided.fix + decided.ask > 0;
  const next = !acting ? [words.nextNotices.nothing] : view.fixPass === 'continued' ? [words.nextNotices.continued] : [`${words.nextNotices['to-come']} ${factsLine([[words.fixCommandLabel, fixCommand(view)]])}`];
  return [table, ...(view.findings.length === 0 ? [] : [next])];
}

/** A path as the repository names a file: relative, with forward slashes and no empty, `.` or `..` name, and no drive. */
const repositoryPathLike = (path: string): boolean => path !== '' && !path.includes('\\') && !/^[A-Za-z]:/.test(path) && path.split('/').every((name) => name !== '' && name !== '.' && name !== '..');

/** A file a worker named, as code linked at the reviewed head, or at the merge base for one the change removed; as code alone when it is no path of the repository, or its cleaning changed it, so no link carries what the cleaning took out. */
function fileLink(view: FormView, path: string, say: Speaker): string {
  const shown = say.code(path);
  if (!repositoryPathLike(path) || shown !== codeSpan(inlineText(path))) return shown;
  return `[${shown}](${fileSideUrl(view, path)})`;
}

/** The writer's sentences on a condition, or null when its answer kept none for it. */
const writerConditionOf = (view: FormView, condition: ChangeConditionName): ConditionSentence | null => view.conditions?.find((entry) => entry.condition === condition) ?? null;

/** For each condition, the judgment of the triage's account that holds it, so a condition added to the list has one or fails to type-check. */
const conditionJudgment: Record<ChangeConditionName, 'publicInterface' | 'wideEffect'> = { 'public-interface': 'publicInterface', 'wide-effect': 'wideEffect' };

/** The conditions the triage judged to hold, in the order of `changeConditions`; none for a run with no account. */
function heldConditionsOf(view: FormView): { readonly condition: ChangeConditionName; readonly what: string | null; readonly files: readonly string[] }[] {
  const { change } = view.brief;
  if (change.state !== 'given') return [];
  return changeConditions.flatMap((condition) => {
    const { holds, what, files } = change[conditionJudgment[condition]];
    return holds ? [{ condition, what, files }] : [];
  });
}

/**
 * The reasons to look (R6, R8 of the core of the change on the pull
 * request), each a list item that nothing waits on: each condition the
 * triage judged to hold, under its label, with the writer's sentence on
 * it; or, when the writer could not explain it from the code, the
 * writer's sentence under its label and the triage's recorded words; or
 * the triage's recorded words alone; then the files that show it. Then
 * the fixes whose verdict is PLAUSIBLE, as one labeled value.
 */
function reasonsToLook(view: Page, say: Speaker): string[] {
  const { words } = view;
  const conditions = heldConditionsOf(view).map(({ condition, what, files }) => {
    const triage = what === null ? [] : [recordedWords(view, 'triage', sentenceText(say.words(what)))];
    const given = writerConditionOf(view, condition);
    const text = given?.explanation !== null && given?.explanation !== undefined
      ? [sentenceText(say.prose(given.explanation))]
      : given?.unexplained !== null && given?.unexplained !== undefined
        ? [`${words.writerUnexplainedLabel}: ${sentenceText(say.prose(given.unexplained))}`, ...triage]
        : triage;
    return [words.conditionLabels[condition], ...text, ...(files.length === 0 ? [] : [factsLine([[words.filesShowLabel, valueList(files.map((file) => fileLink(view, file, say)))]])])].join(' ');
  });
  const plausible = view.findings.filter((finding) => finding.decision?.decision === 'fix' && finding.finding.verdict === 'PLAUSIBLE');
  const fixes = plausible.length === 0 ? [] : [factsLine([[words.plausibleFixesLabel, valueList(plausible.map((finding) => findingRef(view, finding)))]])];
  return [...conditions, ...fixes].map((item) => `- ${item}`);
}

/**
 * What needs a person (R2, R8; R6, R7 of the core of the change on the
 * pull request): each question and each fix against a written rule, with
 * a link to where it is read, the writer's text and its facts, then the
 * notice of how a person answers with the command; then the reasons to
 * look, which nothing waits on; or, when nothing is listed, the facts
 * that say so.
 */
function needsSection(view: Page, say: Speaker): Section {
  const { words } = view;
  const item = (label: string, finding: FindingView, text: readonly string[], facts: readonly (readonly [string, string])[]): string => `- ${[`**${label}: ${findingRef(view, finding)}.**`, ...text, factsLine(facts)].join(' ')}`;
  const questions = view.findings.flatMap((finding) => {
    const { question } = finding;
    if (finding.decision?.decision !== 'ask' || question === null) return [];
    const action = finding.written?.action ?? null;
    const text = action === null ? [recordedWords(view, 'decider', say.sentence(question.question))] : [sentenceText(say.prose(action))];
    return [item(words.questionItem, finding, text, questionFacts(view, finding))];
  });
  const departures = view.findings.flatMap((finding) => {
    const { departure } = finding;
    if (departure === null) return [];
    const written = finding.written?.fix?.departure ?? null;
    const text = written === null ? [`${words.ruleLabel}: ${recordedWords(view, 'decider', sentenceText(say.words(departure.rule)))}`] : [sentenceText(say.prose(written))];
    return [item(words.departureItem, finding, text, departureFacts(view, finding))];
  });
  const items = [...questions, ...departures];
  const looks = reasonsToLook(view, say);
  const open = view.findings.some((finding) => (finding.question !== null && (finding.question.answer === null || finding.question.answer.option === null)) || (finding.departure !== null && finding.departure.review === null));
  const answer = items.length === 0 || !open ? [] : [answerLine(view, questions.length > 0, departures.length > 0)];
  const none = items.length === 0 ? [[factsLine([[words.questionsLabel, words.none], [words.departuresLabel, words.none], ...(looks.length > 0 ? [] : [[words.conditionsLabel, view.brief.change.state === 'given' ? words.none : words.notJudged] as const])])]] : [];
  return { lines: blocks([words.needsHeading], ...none, items, ...answer, ...(looks.length === 0 ? [] : [[words.looksNotice], looks])) };
}

/** The notice of who answers a question or a departure and how, with the command and the flags of the kinds the review lists. */
function answerLine(view: FormView, questions: boolean, departures: boolean): string[] {
  const { words } = view;
  const flags = [...(questions ? ['--option <k>'] : []), ...(departures ? ['--accept', '--reject'] : [])].map(codeSpan);
  return [`${words.answerNotices[view.fixPass]} ${factsLine([[words.commandLabel, codeSpan(`deep-review ${answerArguments(view.state.id, '<n>', '').trimEnd()}`)], [words.flagsLabel, valueList(flags)]])}`];
}

/** A gap of what the review did not examine as facts under the label of its kind (R5, R8 of the review in the writer's words). */
function gapFacts(view: Page, gap: GapFacts, say: Speaker): string {
  const { words } = view;
  const labels = words.gapLabels;
  switch (gap.kind) {
    case 'angle':
      return factsLine([[labels.angle, codeSpan(gap.pass)]]);
    case 'unverified':
      return factsLine([
        ...(gap.findings.length === 0 ? [] : [[labels.unverified, findingRefs(view, gap.findings)] as const]),
        ...(gap.merged.length === 0 ? [] : [[words.mergedUnverifiedLabel, findingRefs(view, gap.merged)] as const]),
        ...(gap.others === 0 ? [] : [[words.otherCandidatesLabel, String(gap.others)] as const]),
      ]);
    case 'excluded': {
      const layer = view.review.configuration.settings?.layers['scope.exclude'] ?? null;
      return factsLine([[labels.excluded, String(gap.count)], [words.pathsLabel, valueList(gap.patterns.map((pattern) => say.code(pattern)))], ...(layer === null ? [] : [[words.setByLabel, words.layers[layer]] as const])]);
    }
    case 'oversized':
      return factsLine([[labels.oversized, valueList(gap.paths.map((path) => say.code(path)))]]);
    case 'check':
      return factsLine([[labels.check, codeSpan(gap.check)]]);
    case 'budget':
      return factsLine([[labels.budget, valueList(gap.steps.map((step) => codeSpan(step)))]]);
    case 'series':
      return factsLine([[labels.series, words.yesNo.yes]]);
    case 'documentation':
      return factsLine([[labels.documentation, codeSpan(gap.cause)]]);
    case 'workers':
      return factsLine([[labels.workers, String(gap.count)]]);
  }
}

/**
 * What the review did not examine (R11; R5 of the review in the writer's
 * words): the writer's text; that no check ran; each gap of the brief as
 * facts under the label of its kind, or that it has none; the count of
 * the refuted candidates; then the refuted candidates, folded, each with
 * its place, the writer's claim and reason or the finder's summary as its
 * recorded words, or, cut, the notice in their place.
 */
function notExaminedSection(view: Page, say: Speaker): Section {
  const { words } = view;
  const gaps = view.brief.notExamined.map((gap) => gap.facts);
  const checks = view.fixPass === 'continued' ? words.noCheckContinued : factsLine([[words.checksRunLabel, words.none]]);
  const cut = view.leftOut.refuted;
  const count = view.refuted.length;
  const refutedLine = count === 0 ? [] : [cut ? `${factsLine([[words.refutedLabel, String(count)], [words.notListedLabel, String(count)]])} ${words.refutedCut}` : factsLine([[words.refutedLabel, String(count)]])];
  const items = [checks, ...(gaps.length === 0 ? [factsLine([[words.gapsLabel, words.none]])] : gaps.map((gap) => gapFacts(view, gap, say))), ...refutedLine].map((line) => `- ${line}`);
  const written = view.notExamined === null ? [] : say.paragraphs(view.notExamined).map((paragraph) => [paragraph]);
  if (count === 0 || cut) return { lines: blocks([words.notExaminedHeading], ...written, items) };
  const entries = view.refuted.map(({ candidate, claim, why }) => {
    const location = repositoryLocation(candidate) === null ? null : { path: candidate.file!, line: candidate.line! };
    const place = location === null ? words.noPlace : locationLink(view, location);
    const said = claim === null ? recordedWords(view, 'finder', sentenceText(say.words(candidate.summary))) : sentenceText(say.prose(claim));
    const refutedBecause = why === null ? factsLine([[words.evidenceLabel, words.inReport]]) : `${words.refutedWhyLabel} ${sentenceText(say.prose(why))}`;
    return `- ${place}: ${said} ${refutedBecause}`;
  });
  return { lines: blocks([words.notExaminedHeading], ...written, items, details(words.refutedSummary, entries)) };
}

/** How the review worked (R3): what each role does, the counts of the run as a table, the fixed diagram, and what the verdicts, the severities and the values a severity is read from mean. */
function howSection(view: Page): Section {
  const { words, counts } = view;
  const labels = words.counts;
  const table = factsTable([labels.candidates, labels.groups, labels.refuted, labels.kept, labels.merged, labels.findings], [[counts.candidates, counts.groups, counts.refuted, counts.kept, counts.merged, counts.findings].map(String)]);
  const meanings = [words.verdictMeanings, ...(counts.unverified === 0 ? [] : [words.unverifiedMeaning]), words.severityMeanings, words.severityValues].join(' ');
  return { lines: blocks([words.howHeading], [words.rolesNotice], table, [fenced(howDiagram(view))], [meanings]) };
}

/** The fixed diagram of how the review worked, its node texts from the table of words, with the pull request's number in the command that names the review. */
function howDiagram(view: FormView): string {
  const nodes = view.words.diagram;
  const review = `review --pr ${String(view.pullRequest.number)}`;
  const following = view.fixPass === 'continued'
    ? [`  W --> X["${nodes.continued}"]`, `  W --> P["${nodes.publish}"]`, `  P --> A["${nodes.answer}"]`]
    : [`  W --> P["${nodes.publish}"]`, `  P --> A["${nodes.answer}"]`, `  A --> X["${review} --fix: ${nodes.fixers}"]`];
  return [
    'flowchart TD',
    `  subgraph RV["${review}, ${nodes.done}"]`,
    `    F["${nodes.finders}"] --> V["${nodes.verifier}"]`,
    `    V --> D["${nodes.decider}"]`,
    `    D --> W["${nodes.writer}"]`,
    '  end',
    ...following,
  ].join('\n');
}

/** The areas the body gives: the writer's, or one under the label of the table with no diagram, for an answer that has none (R16). */
function areasOf(view: FormView, say: Speaker): { readonly title: string; readonly intro: string | null; readonly diagram: string | null; readonly findings: readonly FindingView[] }[] {
  const major = majorActing(view);
  if (view.areas === null) return [{ title: view.words.findingsArea, intro: null, diagram: null, findings: major }];
  return view.areas.map((area) => ({ title: say.prose(area.title), intro: say.prose(area.intro), diagram: area.diagram, findings: major.filter((finding) => area.findings.includes(finding.finding.id)) }));
}

/** A finding's line in an area or a row's text: its title, its facts, and what deep-review would do or asks. */
function findingLine(view: Page, finding: FindingView, say: Speaker): string {
  const { words } = view;
  const action = actionText(view, finding, say);
  const facts = factsLine([[words.verdictLabel, verdictText(view, finding)], [words.decisionLabel, words.decisionValues[decisionValue(finding)]], ...(finding.question === null ? [] : [[words.recommendedLabel, String(finding.question.choice)] as const])]);
  // A finding whose text is left out gets the command that prints it after its line (R2, R6 of the review that always posts).
  const shown = shownAs(view, finding);
  const command = shown === 'item' || shown === 'line' ? [factsLine([[words.printCommandLabel, codeSpan(reportCommand(view, finding))]])] : [];
  return [`**${findingRef(view, finding)}.** ${sentenceText(titleText(view, finding, say))}`, facts, ...(action === null ? [] : [action]), ...command].join(' ');
}

/** The major findings by area (R4): each area's title, intro and diagram, less what a cut takes, and one line for each of its findings. */
function areasSection(view: Page, say: Speaker): Section {
  const { words } = view;
  if (majorActing(view).length === 0) return { lines: [words.areasHeading, '', words.noMajor] };
  const diagrams = !view.leftOut.diagrams;
  // Once, since each call cleans the writer's titles and intros, and counts their secrets, again.
  const given = areasOf(view, say);
  const areas = given.flatMap((area) => {
    const lines = area.findings.map((finding) => `- ${findingLine(view, finding, say)}`);
    const intro = area.intro === null || area.intro === '' ? '' : ` ${sentenceText(area.intro)}`;
    return [[`**${sentenceText(area.title)}**${intro}`], ...(area.diagram === null || !diagrams ? [] : [[say.diagram(area.diagram)]]), lines];
  });
  const cut = !diagrams && given.some((area) => area.diagram !== null);
  return { lines: blocks([words.areasHeading], ...areas, ...(cut ? [[words.areaDiagramsCut]] : [])) };
}

/** The block of a finding in full: its anchor, its heading, its title and the parts its comment would give (R1). */
function inFullBlock(view: Page, finding: FindingView, say: Speaker): string[] {
  return [`<a id="${findingAnchor(finding.finding.number)}"></a>`, '', `### ${view.words.findingLabel} ${String(finding.finding.number)}`, '', titleLine(view, finding, say), '', ...joinedParts(findingParts(view, finding, say))];
}

/**
 * Each finding with no comment that asks a person to act, in full, in the
 * form of its comment (R1); then, under a label of their own, an item for
 * each minor finding whose text was left out, with its anchor, its line
 * and the command that prints it, apart from the blocks so no item falls
 * under the heading of another finding; then the count of those whose
 * line was left out too (R2, R6 of the review that always posts). A major
 * finding whose text was left out keeps its line in its area.
 */
function inFullSection(view: Page, say: Speaker): Section {
  const { words } = view;
  const full = view.findings.filter(inFull);
  const shown = full.filter((finding) => shownAs(view, finding) === 'block');
  const items = full.filter((finding) => shownAs(view, finding) === 'item');
  const unlisted = full.filter((finding) => shownAs(view, finding) === 'none').length;
  const blocksShown = shown.flatMap((finding, index) => [...(index === 0 ? [] : ['']), ...inFullBlock(view, finding, say)]);
  const list = items.length === 0 ? [] : [`${words.textsLeftLabel} ${words.textsLeftNotice}`, '', ...items.map((finding) => `- <a id="${findingAnchor(finding.finding.number)}"></a>${findingLine(view, finding, say)}`)];
  const count = unlisted === 0 ? [] : [`${factsLine([[words.notListedLabel, String(unlisted)]])} ${words.linesLeftNotice}`];
  return { lines: blocks(blocksShown, list, count) };
}


/** The minor findings (R13): their counts as facts, those whose reach is not given only when there are any, those that need a person, then their table folded, or, cut, the notice in its place. */
function minorSection(view: Page, say: Speaker): Section {
  const { words } = view;
  const minor = minorActing(view);
  if (minor.length === 0) return { lines: [] };
  const user = minor.filter((finding) => finding.kind === 'user').length;
  const code = minor.filter((finding) => finding.kind === 'code').length;
  // A finding whose kind the writer did not give is counted apart, as its row says, not with the code.
  const none = minor.length - user - code;
  const needing = minor.filter((finding) => finding.question !== null || finding.departure !== null).map((finding) => finding.finding.number);
  const labels = words.minorLabels;
  const counts = factsLine([[labels.total, String(minor.length)], [labels.user, String(user)], [labels.code, String(code)], ...(none === 0 ? [] : [[labels.none, String(none)] as const]), [labels.onLine, String(minor.filter((finding) => finding.placement.place === 'line').length)], ...(needing.length === 0 ? [] : [[labels.needs, findingRefs(view, needing)] as const])]);
  if (view.leftOut.minorTable) return { lines: blocks([words.minorHeading], [counts], [words.minorCut]) };
  const columns = words.minorColumns;
  const rows = minor.map((finding) => {
    const action = actionText(view, finding, say);
    // The decision as data only where the row would otherwise hide a departure from a written rule, as the area lines show it.
    const decided = decisionValue(finding) === 'fix-against-rule' ? [[words.decisionLabel, words.decisionValues['fix-against-rule']] as const] : [];
    const asked = finding.question === null ? [] : [[words.recommendedLabel, String(finding.question.choice)] as const];
    const facts = decided.length + asked.length === 0 ? [] : [factsLine([...decided, ...asked])];
    return [findingRef(view, finding), titleText(view, finding, say), words.kindValues[finding.kind ?? 'none'], verdictText(view, finding), [...(action === null ? [] : [action]), ...facts].join(' ')];
  });
  return { lines: blocks([words.minorHeading], [counts], details(words.minorSummary, factsTable([columns.number, columns.finding, columns.kind, columns.verdict, columns.action], rows))) };
}

/**
 * The findings left as is, folded (R2 of the review in the writer's
 * words; R4 of the settled choice): each with the writer's title and
 * reason, or the ranking's summary and the decider's grounds as recorded
 * words; its facts with the reason of the closed list and the finding
 * that supersedes it; the steps that settled its choices; its line; and
 * the decision as recorded. A finding that a `left` step of the order
 * took is not listed, and is counted, with the notice, in place of the
 * listed ones; one that waits on a person leaves last, in row 9 of R2 of
 * the review that always posts.
 */
function leftSection(view: Page, say: Speaker): Section {
  const { words } = view;
  const left = leftAsIs(view);
  if (left.length === 0) return { lines: [] };
  const shown = left.filter((finding) => shownAs(view, finding) === 'block');
  const others = left.length - shown.length;
  const cutNotice = others === 0 ? [] : [`${factsLine([[words.notListedLabel, String(others)]])} ${words.leftCut}`];
  if (shown.length === 0) return { lines: blocks([words.leftHeading], cutNotice) };
  return { lines: blocks([words.leftHeading], details(words.leftSummary, ...shown.map((finding) => leftBlock(view, finding, say))), cutNotice) };
}

/** The block of a finding left as is in its section (R2 of the review in the writer's words; R4 of the settled choice). */
function leftBlock(view: Page, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const leave = finding.decision?.decision === 'leave' ? finding.decision : null;
  const by = leave?.leave.supersededBy ?? null;
  const byFinding = by === null ? null : view.findings.find((candidate) => candidate.finding.id === by || candidate.finding.merged.includes(by)) ?? null;
  const reason = leave === null ? [] : [[words.reasonLabel, words.leaveReasons[leave.leave.reason]] as const, ...(byFinding === null ? [] : [[words.supersededByLabel, findingRef(view, byFinding)] as const])];
  const why = finding.left !== null ? [[`${words.leftWhyLabel} ${sentenceText(say.prose(finding.left.why))}`]] : leave === null ? [] : [[`${words.leftWhyLabel} ${recordedWords(view, 'decider', say.sentence(leave.grounds))}`]];
  const { location } = finding.placement;
  return blocks(
    [`<a id="${findingAnchor(finding.finding.number)}"></a>`],
    [`**${words.findingLabel} ${String(finding.finding.number)}**`],
    [titleLine(view, finding, say)],
    [findingFacts(view, finding, reason)],
    ...why,
    ...settledFacts(view, finding),
    location === null ? [] : [factsLine([[words.codeLabel, locationLink(view, location)]])],
    finding.left === null ? choiceRecord(view, finding, say) : recordBlocks(view, finding, say),
  );
}

/**
 * The choices beside a decision, each verifier's choice and the one that
 * settles it as recorded words under their labels, in its record or alone
 * where the writer gave no text; none when its verifiers named none and
 * it settles none. A settlement of one verifier's choice, or of none, is
 * one list item; one of several is the item, with each verifier's choice
 * an item nested under it.
 */
function choiceRecord(view: FormView, finding: FindingView, say: Speaker, only: 'all' | 'open' = 'all'): string[] {
  const { words } = view;
  return choicesShown(finding.choices, finding.decision?.settled ?? []).filter((shown) => only === 'all' || shown.settled === null).flatMap((shown) => {
    const settled = shown.settled === null
      ? labeledValue(words.settledChoiceLabel, words.notSettled)
      : `${words.settledChoiceLabel}: ${say.sentence(shown.settled.choice)} ${factsLine([[words.settledByLabel, words.settleSteps[shown.settled.by]]])} ${words.sourceLabel}: ${say.sentence(shown.settled.source)}`;
    const verifiers = shown.verifiers.map((choice) => `${words.verifierChoiceLabel}: ${say.sentence(choice)}`);
    return verifiers.length > 1 ? [`- ${settled}`, ...verifiers.map((choice) => `  - ${choice}`)] : [`- ${[...verifiers, settled].join(' ')}`];
  });
}

/** The parts of the writer's answer that this review lacks, by the names of the table and each finding as a link: dropped by the checks, or absent from an older answer, and only where the review would show one. */
function missingParts(view: Page): string[] {
  const { words } = view;
  const recorded = view.recorded;
  if (recorded === null) return [];
  const parts: WriterPart[] = [];
  if (view.core.kind !== 'writer') parts.push('core');
  if (heldConditionsOf(view).length > 0 && view.conditions === null) parts.push('conditions');
  if (view.summary === null) parts.push('summary');
  if (view.areas === null && majorActing(view).length > 0) parts.push('areas');
  if (leftAsIs(view).some((finding) => finding.left === null)) parts.push('left');
  if (view.refuted.some((line) => line.claim === null && line.why === null)) parts.push('refuted');
  if (view.notExamined === null) parts.push('not-examined');
  const findings = view.findings.filter((finding) => acts(finding) && finding.explained.kind !== 'explained');
  return [...parts.map((part) => words.writerParts[part]), ...findings.map((finding) => findingRef(view, finding))];
}

/**
 * Whether the body with what is left out, or a comment, posts any text of
 * the writer (R7 of the review in the writer's words): the core, a
 * sentence on a condition, the summary, the areas when a major finding
 * acts, what the review did not examine, a refuted line or a finding left
 * as is still listed, or a finding's text. A frozen answer can post
 * none: a writer that completed its unit has its answer frozen even when
 * the checks dropped every part.
 */
function postsWriterText(view: Page): boolean {
  if (view.leftOut.floor) return view.findings.some((finding) => finding.placement.place === 'line' && postsFindingText(view, finding));
  return view.core.kind === 'writer'
    || heldConditionsOf(view).some((entry) => writerConditionOf(view, entry.condition) !== null)
    || view.summary !== null
    || view.notExamined !== null
    || (view.areas !== null && view.areas.length > 0 && majorActing(view).length > 0)
    || (!view.leftOut.refuted && view.refuted.some((line) => line.claim !== null || line.why !== null))
    || leftAsIs(view).some((finding) => finding.left !== null && shownAs(view, finding) === 'block')
    || view.findings.some((finding) => postsNeedsText(finding) || (acts(finding) && postsFindingText(view, finding)));
}

/**
 * Whether the item of a finding under "What needs a person" posts a text
 * of the writer: a question's sentence of what it asks, or a departure's
 * text. `needsSection` lists every question and departure, wherever the
 * finding is and whatever the order took from it, until the floor.
 */
const postsNeedsText = (finding: FindingView): boolean => (finding.decision?.decision === 'ask' && finding.question !== null && (finding.written?.action ?? null) !== null)
  || (finding.departure !== null && (finding.written?.fix?.departure ?? null) !== null);

/**
 * Whether the review posts a text of the writer in the block, the line or
 * the comment of a finding that acts: its comment, unless only its facts
 * fit; its block in full, which gives the writer's reason for leaving it
 * unexplained; or, once its text is left out, its line, which holds the
 * writer's title and sentence of what deep-review would do, until its
 * line leaves too. Its item under "What needs a person", which stays
 * after its line leaves, is counted apart, by `postsNeedsText` in
 * `postsWriterText`.
 */
function postsFindingText(view: Page, finding: FindingView): boolean {
  const { id } = finding.finding;
  if (finding.placement.place === 'line') return !view.commentsLeftOut.some((comment) => comment.finding === id && comment.piece === 'text') && (finding.written !== null || (finding.explained.kind === 'unexplained' && finding.explained.reason !== null));
  const shown = shownAs(view, finding);
  if (finding.written !== null) return shown !== 'none';
  return finding.explained.kind === 'unexplained' && finding.explained.reason !== null && shown === 'block';
}

/**
 * How far to trust the review (R12; R7 of the review in the writer's
 * words): the verdicts, with how many of the major CONFIRMED ones were
 * reproduced by running them, and how the findings were checked, as
 * tables; the candidates and the refuted ones; the notice that a model
 * wrote the sentences and the data is the ledger's, when the review posts
 * any text of the writer; the notice of a run with no explanation; the
 * parts of the writer's answer the review lacks; and the findings
 * answered after the writer wrote.
 */
function trustSection(view: Page): Section {
  const { words, counts } = view;
  const candidates = factsLine([[words.counts.candidates, String(counts.candidates)], [words.counts.refuted, String(counts.refuted)]]);
  const notes: string[][] = [];
  if (postsWriterText(view)) notes.push([words.modelNotice]);
  if (view.recorded === null) notes.push([words.noExplanation]);
  const missing = missingParts(view);
  if (missing.length > 0) notes.push([factsLine([[words.missingLabel, valueList(missing)]])]);
  // An answer is recorded on a complete run, and the explanation before the report, so every standing answer of an explained run came after it.
  if (view.recorded !== null) {
    const answered = [...standingAnswers(view.review).keys()].map((id) => view.brief.numbers.get(id)!);
    if (answered.length > 0) notes.push([factsLine([[words.answeredAfterLabel, findingRefs(view, [...new Set(answered)].sort((a, b) => a - b))]])]);
  }
  return { lines: blocks([words.trustHeading], ...trustTables(view), [candidates], ...notes) };
}

/** The tables of the verdicts, with how many of the major CONFIRMED ones were reproduced by running, and of how the findings were checked, as how far to trust the review and the floor give them; none for a run with no finding. */
function trustTables(view: FormView): string[][] {
  const { words, counts } = view;
  if (counts.findings === 0) return [];
  const columns = words.verdictColumns;
  const unverified = counts.unverified === 0 ? [] : [columns.unverified];
  const verdicts = factsTable([columns.verdict, columns.findings, columns.major, columns.majorRan, ...unverified], [
    ['CONFIRMED', String(counts.confirmed), String(counts.majorConfirmed), String(counts.majorConfirmedRan), ...(counts.unverified === 0 ? [] : ['0'])],
    ['PLAUSIBLE', String(counts.plausible), String(counts.major - counts.majorConfirmed), '', ...(counts.unverified === 0 ? [] : [String(counts.unverified)])],
  ]);
  const bases = (['ran', 'traced', 'read'] as const).filter((basis) => counts.bases[basis] > 0).map((basis) => [words.basisValues[basis], String(counts.bases[basis])]);
  return [verdicts, factsTable([words.basisColumns.basis, words.basisColumns.findings], [...bases, ...(counts.noBasis === 0 ? [] : [[words.noBasisValue, String(counts.noBasis)]])])];
}

/** The last visible line, the engine, the runtime and its models, the run and the commits it reviewed, as facts, then the marker of the publication (R9, R13). The version the runtime gave and the models the settings name are no text of the engine's, so they are cleaned. */
function lastSection(view: Page, say: Speaker): Section {
  const { configuration } = view.review;
  const labels = view.words.lastLabels;
  return {
    lines: [
      factsLine([
        [labels.engine, `deep-review ${inlineText(view.input.engine)}`],
        [labels.runtime, `${configuration.runtime} ${say.words(configuration.version)}`],
        [labels.models, valueList([say.words(configuration.models.strong), say.words(configuration.models.fast)])],
        [labels.run, codeSpan(shortRunId(view.state.id))],
        [labels.commits, `${shortCommit(view.scope.base)}..${shortCommit(view.scope.head)}`],
      ]),
      '',
      markerLine(publicationMarker(view.state.id, view.input.serial)),
    ],
  };
}

/**
 * The body with what `leftOut` names left out, and the secrets its cleaning replaced: the
 * heading, the core of the change, the summary, what needs a person, what
 * the review did not examine, how the review worked, the major findings by
 * area, the findings in full, the minor findings, the findings left as is,
 * how far to trust the review and the last line.
 */
function renderBody(view: FormView, leftOut: LeftOut, commentsLeftOut: readonly CommentLeftOut[], cache: Map<string, Cleaned>): { readonly text: string; readonly secrets: number } {
  const say = speakerOf(view.input.machine, view.words, view.names, cache);
  const page: Page = { ...view, leftOut, commentsLeftOut };
  if (leftOut.floor) return { text: floorBody(page), secrets: 0 };
  const sections = [
    headingSection(page),
    coreSection(page, say),
    summarySection(page, say),
    needsSection(page, say),
    notExaminedSection(page, say),
    howSection(page),
    areasSection(page, say),
    inFullSection(page, say),
    minorSection(page, say),
    leftSection(page, say),
    trustSection(page),
    lastSection(page, say),
  ].filter((section) => section.lines.length > 0);
  return { text: sections.map((section) => section.lines.join('\n')).join('\n\n'), secrets: say.secrets() };
}


/**
 * What the next step of the order can take from the body at most, the
 * bound by which `firstFit` renders no prefix it can prove over the limit
 * (OQ1 of the review that always posts): for a step that takes a piece of
 * a finding, its block in the body with nothing left out and its line,
 * the links to it that the body gives, each of which loses its target, and
 * what a step changes elsewhere, the counts and notices that a step can
 * drop (`stepElsewhere`); for a piece that leaves whole, no bound, so the
 * body is rendered after it.
 */
function stepBounds(view: FormView, order: readonly FitStep[], whole: string, cache: Map<string, Cleaned>): (step: number) => number {
  const say = speakerOf(view.input.machine, view.words, view.names, cache);
  const page: Page = { ...view, leftOut: nothingLeftOut, commentsLeftOut: [] };
  const links = new Map<string, number>();
  for (const [, number] of whole.matchAll(/\]\(#finding-(\d+)\)/g)) links.set(number!, (links.get(number!) ?? 0) + 1);
  const size = (lines: readonly string[]): number => lines.join('\n').length + 2;
  const bounds = new Map(view.findings.filter((finding) => finding.placement.place === 'body').map((finding) => {
    const block = acts(finding) ? inFullBlock(page, finding, say) : leftBlock(page, finding, say);
    const link = (links.get(String(finding.finding.number)) ?? 0) * `[](#${findingAnchor(finding.finding.number)})`.length;
    return [finding.finding.id, size(block) + size([findingLine(page, finding, say)]) + link + stepElsewhere] as const;
  }));
  return (step) => {
    const taken = order[step]!;
    return 'finding' in taken ? bounds.get(taken.finding) ?? Infinity : Infinity;
  };
}

/**
 * The most that a step on one finding shortens the body beyond its block,
 * its line and the links to it: the facts of the notice under the heading
 * whose count falls to none, the notice that a model wrote the sentences,
 * the label and the notice of the findings whose text is left out, the
 * blank lines of a section that empties, and the record line and the
 * command a step adds to a block before a later step takes the block. Each
 * is under a few hundred characters in each table of words, so this bound
 * is far above their sum.
 */
const stepElsewhere = 4_000;

/**
 * The review of a read-only run of a pull request, as `publish` posts it
 * (R9, R10, R12; R1, R2, R7 of the review that always posts): the body,
 * with the first prefix of `fitOrder` after which it fits left out, the
 * floor at the last, and the marker of the publication as its last line;
 * a comment on its line for each fix and each question that has one,
 * fitted alone, with the marker of its finding as its last line; the place
 * of each finding as the ledger records it; the count of the secrets the
 * cleaning replaced in what is posted; and what was left out to fit.
 */
export function pullRequestForm(input: PullRequestFormInput): PullRequestForm {
  const view = formViewOf(input);
  // The cleaned texts are kept between renders, which changes no result (OQ1 of the review that always posts).
  const cache = new Map<string, Cleaned>();
  const comments: FormComment[] = [];
  const commentsLeftOut: CommentLeftOut[] = [];
  let secrets = 0;
  // Each comment is fitted alone and before the body, whose notice counts the comments that lost a piece (R7, TD5 of the review that always posts).
  for (const finding of view.findings) {
    if (finding.placement.place !== 'line') continue;
    const rendered = commentOf(view, { ...finding, placement: finding.placement }, cache);
    comments.push(rendered.comment);
    if (rendered.leftOut !== null) commentsLeftOut.push({ finding: finding.finding.id, piece: rendered.leftOut });
    secrets += rendered.secrets;
  }
  // The order, the floor last, whose first prefix after which the body fits the form posts (R2, TD3 of the review that always posts).
  const order = fitOrder(view);
  const whole = renderBody(view, nothingLeftOut, commentsLeftOut, cache);
  const most = stepBounds(view, order, whole.text, cache);
  let body = whole;
  const made = firstFit(order.length, (prefix) => {
    body = prefix === 0 ? whole : renderBody(view, leftOutOf(order.slice(0, prefix)), commentsLeftOut, cache);
    return body.text.length;
  }, most, maxPostedLength);
  // The floor holds no text whose length a run decides, so a floor over the limit is a defect of the form (TD7 of the review that always posts).
  if (body.text.length > maxPostedLength) throw new Error(`The floor of the review of run ${view.state.id} is ${String(body.text.length)} characters, over the ${String(maxPostedLength)} a review posts`);
  return {
    kind: 'rendered',
    body: body.text,
    comments,
    places: input.places.map(({ finding, place, reason }) => ({ finding, place, reason })),
    secrets: secrets + body.secrets,
    leftOut: { body: order.slice(0, made), comments: commentsLeftOut },
  };
}
