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
 * for removed lines. A body over the limit is cut in the order of
 * `bodyCuts`, and a body that still does not fit, or a comment that does
 * not, is a refusal with its size and parts, before anything is recorded.
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
import type { DecisionValue, LineNote, PullRequestWords, RecordedSpeaker, WriterPart } from './pull-request-words.ts';
import { formViewOf, type FindingLocation, type FindingPlacement, type FindingView, type FormView, type PullRequestFormInput } from './pull-request-view.ts';
import { shortRunId } from './runs.ts';
import { choicesShown } from './state.ts';
import { asksToAct, changeConditions, type ChangeConditionName, type FindingPlace, type PlaceReason } from './vocabulary.ts';

/** The most characters of a body or a comment, a margin under the 65,536 people report GitHub takes (R12). */
export const maxPostedLength = 60_000;

/** A commit as the form names it, by its first 8 characters, as the brief names a run. */
const shortCommit = (commit: string): string => commit.slice(0, 8);

/**
 * What a body over the limit is cut of, in this order (TD5 of the review
 * that reads as a report): the refuted candidates, then the findings left
 * as is whose verifiers named no choice for the author, since a cut keeps
 * those whose verifiers named one (R4 of the settled choice), then the
 * table of the minor findings, each of which has its comment on its line
 * or its text in full above, then the diagrams of the areas. What needs a
 * person, the areas and the findings in full are never cut.
 */
export const bodyCuts = ['refuted', 'left', 'minor-table', 'area-diagrams'] as const;
export type BodyCut = (typeof bodyCuts)[number];

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

/** The review as the form renders it: the body with its marker last, a comment for each finding on its line, each place, the count of secrets the cleaning replaced, and each cut the body needed. */
export interface PullRequestForm {
  readonly kind: 'rendered';
  readonly body: string;
  readonly comments: readonly FormComment[];
  readonly places: readonly RecordedPlace[];
  readonly secrets: number;
  readonly cuts: readonly BodyCut[];
}

/** One part of a text that does not fit, with its size in characters. */
export interface PartSize {
  readonly part: string;
  readonly size: number;
}

/** A body that does not fit after every cut, or a comment over the limit (R12): what it is, its size and the size of each part. */
export interface FormRefusal {
  readonly kind: 'refused';
  readonly text: { readonly kind: 'body' } | { readonly kind: 'comment'; readonly finding: string; readonly path: string; readonly line: number };
  readonly size: number;
  readonly limit: number;
  readonly parts: readonly PartSize[];
}

/** A refusal of the form as one sentence, for the command that refuses it. */
export function formRefusalWords(refusal: FormRefusal): string {
  const what = refusal.text.kind === 'body' ? 'the body of the review, after every cut,' : `the comment of ${refusal.text.finding} on ${refusal.text.path}:${String(refusal.text.line)}`;
  const parts = refusal.parts.map((part) => `${part.part} ${String(part.size)}`).join(', ');
  return `${what} is ${String(refusal.size)} characters, over the ${String(refusal.limit)} a review posts: ${parts}`;
}

/** Whether a finding asks a person to act: a decided fix or a question, which goes on its line or in full in the body. */
const acts = (view: FindingView): boolean => asksToAct(view.decision?.decision);

/** Whether a finding is minor; critical findings count with the major ones. */
const isMinor = (view: FindingView): boolean => view.finding.severity === 'minor';

/** Whether a finding is in full in the body: one that acts, with no comment on a line. */
const inFull = (view: FindingView): boolean => acts(view) && view.placement.place === 'body';

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
function speakerOf(machine: MachineContext, words: PullRequestWords, names: ReadonlyMap<string, NamedId>): Speaker {
  let secrets = 0;
  const counted = (cleaned: { readonly text: string; readonly secrets: number }): string => {
    secrets += cleaned.secrets;
    return cleaned.text;
  };
  // Named before its lines are joined, so a name that starts a paragraph or a list item reads as the start of a sentence.
  const named = (text: string): string => inlineText(namedFindings(counted(withoutSecrets(text.trim(), machine)), names, words.naming)).trim();
  const prose = (text: string): string => counted(publicProse(named(text), machine));
  return {
    words: (text) => counted(publicWords(named(text), machine)),
    prose,
    paragraphs: (text) => text.split(/\r?\n[ \t]*\r?\n/).map(prose).filter((paragraph) => paragraph !== '').map(paragraphText),
    code: (text) => codeSpan(counted(publicCode(inlineText(text), machine))),
    sentence: (text) => {
      const cleaned = counted(publicWords(named(text), machine));
      return sentenceText(/^[a-z]+(?: |$)/.test(cleaned) ? capitalized(cleaned) : cleaned);
    },
    // A diagram that cleaning broke is left out, so its secrets are counted only when it is posted.
    diagram: (text) => {
      const unsecret = withoutSecrets(text.replace(/\s+$/, ''), machine);
      const diagram = namedInDiagram(unsecret.text, names, words.naming);
      if (diagram === null) return words.diagramNamesIds;
      const cleaned = publicCode(diagram, machine);
      if (diagramFailures(cleaned.text).length > 0) return words.diagramBroken;
      return fenced(counted({ text: cleaned.text, secrets: unsecret.secrets + cleaned.secrets }));
    },
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

/** Where the body links a finding (R14, TD4): the line its comment sits on, at the head, or its block in the body. */
const hrefOf = (view: FormView, finding: FindingView): string => (finding.placement.place === 'line' ? headUrl(view, finding.placement.location) : `#${findingAnchor(finding.finding.number)}`);

/** The marks after a finding's verdict: no verifier examined it. */
const verdictMarks = (view: FormView, finding: FindingView): string[] => (finding.entry.resolution.unverified ? [view.words.unverifiedMark] : []);

/** A finding's verdict with its marks, as the areas and the minor table give it. */
const verdictText = (view: FormView, finding: FindingView): string => [finding.finding.verdict, ...verdictMarks(view, finding)].join(', ');

/** Recorded words of another worker under the label that names it (R8 of the review in the writer's words), already cleaned by the Speaker. */
const recordedWords = (view: FormView, speaker: RecordedSpeaker, text: string): string => `${view.words.recorded[speaker]}: ${text}`;

/** A finding's number as a link to where the body or its comment gives it, with the label that says finding. */
const findingRef = (view: FormView, finding: FindingView): string => `[${view.words.findingLabel} ${String(finding.finding.number)}](${hrefOf(view, finding)})`;

/** The findings of `numbers` as links, each once, in ascending order, as `findingWords` names them; a number of no ranked finding as itself. */
function findingRefs(view: FormView, numbers: readonly number[]): string {
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
 * Folded where it stands beside the writer's text, and given in full
 * where it stands in for it.
 */
function recordBlocks(view: FormView, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const { decision, question } = finding;
  if (decision === null) return [];
  const fixText = finding.written?.fix?.text ?? null;
  // Paragraph by paragraph, as the writer's problem is, since a text of a fix that covers several choices is long.
  const writerText = fixText === null ? [] : say.paragraphs(fixText).map((paragraph, index) => [index === 0 ? `${words.fixTextLabel} ${paragraph}` : paragraph]);
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
  return finding.written === null && finding.left === null ? blocks([`**${words.recordSummary}**`], notice, ...parts) : details(words.recordSummary, notice, ...parts);
}

/** What deep-review would do about a finding of R5's order, each a block: its action, the steps that settled its choices and its departure for a fix, or its question, then the decision as recorded. */
function decisionBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
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

/** The parts of a finding's block, which a comment and the body share, and whose sizes a refusal names. */
interface FindingParts {
  readonly explanation: string[];
  readonly decision: string[];
  readonly checked: string[];
  readonly code: string[];
}

/** The parts of the block of a finding in R5's order: its facts, the mark of one not explained, what goes wrong, its diagram for a major one, why it is not CONFIRMED, then its decision, how it was checked for a major one, and its code. */
function findingParts(view: FormView, finding: FindingView, say: Speaker): FindingParts {
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

/** The comment of a finding on its line, with the id of the finding and its marker as its last lines, or the refusal of one over the limit. */
function commentOf(view: FormView, finding: FindingView & { readonly placement: Extract<FindingPlacement, { place: 'line' }> }): { readonly comment: FormComment; readonly secrets: number } | FormRefusal {
  const say = speakerOf(view.input.machine, view.words, view.names);
  const heading = findingHeading(view, finding, say);
  const parts = findingParts(view, finding, say);
  const body = blocks(heading, joinedParts(parts), [traceLine(view, finding)], [markerLine(findingMarker(view.state.id, finding.finding.id))]).join('\n');
  const { location } = finding.placement;
  if (body.length > maxPostedLength) {
    const size = (lines: readonly string[]): number => lines.join('\n').length;
    return {
      kind: 'refused',
      text: { kind: 'comment', finding: finding.finding.id, path: location.path, line: location.line },
      size: body.length,
      limit: maxPostedLength,
      parts: [{ part: 'explanation', size: size([...heading, ...parts.explanation]) }, { part: 'decision', size: size(parts.decision) }, { part: 'checked', size: size(parts.checked) }, { part: 'code', size: size(parts.code) }],
    };
  }
  return { comment: { finding: finding.finding.id, path: location.path, line: location.line, body }, secrets: say.secrets() };
}

/** One section of the body, by the name a refusal gives its size with. */
interface Section {
  readonly part: string;
  readonly lines: readonly string[];
}

/** The command that continues the run into its fix pass. */
const fixCommand = (view: FormView): string => codeSpan(`deep-review review --pr ${String(view.pullRequest.number)} --fix`);

/** The heading and the facts of what the run reviewed and what followed it (R1; R6 of the review of a fix run), with the notice of a run that went on into its fix pass. */
function headingSection(view: FormView): Section {
  const { words, scope } = view;
  const facts = factsLine([[words.headLabel, codeSpan(shortCommit(scope.head))], [words.baseLabel, codeSpan(shortCommit(scope.base))], [words.filesLabel, String(scope.files.length)], [words.afterLabel, words.afterValues[view.fixPass]]]);
  return { part: 'heading', lines: blocks([words.heading], [facts], view.fixPass === 'continued' ? [words.continuedNotice] : []) };
}

/**
 * The core of the change (R1 to R4, R10, R11 of the core of the change on
 * the pull request), never cut: the writer's title, what the change does,
 * why, the sources of the reason as links, its diagram, and whose reading
 * it is; or the triage's title, account and reason as its recorded words,
 * with the sources, and that it is the triage's; or that the run has no
 * account, and why.
 */
function coreSection(view: FormView, say: Speaker): Section {
  const { words, core } = view;
  if (core.kind === 'none') return { part: 'core', lines: [words.coreHeading, '', words.coreNone[core.state]] };
  const sources = (given: readonly string[]): string[][] => (given.length === 0 ? [] : [[factsLine([[words.sourcesLabel, valueList(given.map((source) => sourceLink(view, source, say)))]])]]);
  const noReason = [[factsLine([[words.reasonLabel, words.noReason]])]];
  if (core.kind === 'writer') {
    const { title, what, why, whyFrom, diagram } = core.core;
    const reason = why === null ? noReason : [[`${words.whyLabel} ${sentenceText(say.prose(why))}`], ...sources(whyFrom)];
    return { part: 'core', lines: blocks([words.coreHeading], [`**${say.prose(title)}**`], ...say.paragraphs(what).map((paragraph) => [paragraph]), ...reason, diagram === null ? [] : [say.diagram(diagram)], [words.coreWhoseWriter]) };
  }
  const { title, change } = core;
  // The triage's title, account and reason are its recorded words, under its label once, as the notice after them says.
  const reason = change.why === null ? noReason : [[`${words.whyLabel} ${sentenceText(say.words(change.why))}`], ...sources(change.whyFrom)];
  return { part: 'core', lines: blocks([words.coreHeading], [`${words.recorded.triage}: **${say.words(title)}**`], [paragraphText(say.words(change.what))], ...reason, [words.coreWhoseTriage]) };
}

/** The summary (R1): the writer's summary, the table of the findings by severity and by decision, and the notice of what happens next with the command that applies the fixes. */
function summarySection(view: FormView, say: Speaker): Section {
  const { words, counts, decided } = view;
  const labels = words.counts;
  const table = factsTable([labels.findings, labels.critical, labels.major, labels.minor, labels.fix, labels.ask, labels.leave], [[counts.findings, counts.critical, counts.major - counts.critical, counts.minor, decided.fix, decided.ask, decided.leave].map(String)]);
  const acting = decided.fix + decided.ask > 0;
  const next = !acting ? [words.nextNotices.nothing] : view.fixPass === 'continued' ? [words.nextNotices.continued] : [`${words.nextNotices['to-come']} ${factsLine([[words.fixCommandLabel, fixCommand(view)]])}`];
  const written = view.summary === null ? [] : say.paragraphs(view.summary).map((paragraph) => [paragraph]);
  return { part: 'summary', lines: blocks([words.summaryHeading], ...written, table, ...(view.findings.length === 0 ? [] : [next])) };
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
function reasonsToLook(view: FormView, say: Speaker): string[] {
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
function needsSection(view: FormView, say: Speaker): Section {
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
  const flags = [...(questions.length === 0 ? [] : ['--option <k>']), ...(departures.length === 0 ? [] : ['--accept', '--reject'])].map(codeSpan);
  const answer = items.length === 0 || !open ? [] : [[`${words.answerNotices[view.fixPass]} ${factsLine([[words.commandLabel, codeSpan(`deep-review ${answerArguments(view.state.id, '<n>', '').trimEnd()}`)], [words.flagsLabel, valueList(flags)]])}`]];
  const none = items.length === 0 ? [[factsLine([[words.questionsLabel, words.none], [words.departuresLabel, words.none], ...(looks.length > 0 ? [] : [[words.conditionsLabel, view.brief.change.state === 'given' ? words.none : words.notJudged] as const])])]] : [];
  return { part: 'needs', lines: blocks([words.needsHeading], ...none, items, ...answer, ...(looks.length === 0 ? [] : [[words.looksNotice], looks])) };
}

/** A gap of what the review did not examine as facts under the label of its kind (R5, R8 of the review in the writer's words). */
function gapFacts(view: FormView, gap: GapFacts, say: Speaker): string {
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
function notExaminedSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  const gaps = view.brief.notExamined.map((gap) => gap.facts);
  const checks = view.fixPass === 'continued' ? words.noCheckContinued : factsLine([[words.checksRunLabel, words.none]]);
  const cut = cuts.has('refuted');
  const count = view.refuted.length;
  const refutedLine = count === 0 ? [] : [cut ? `${factsLine([[words.refutedLabel, String(count)], [words.notListedLabel, String(count)]])} ${words.refutedCut}` : factsLine([[words.refutedLabel, String(count)]])];
  const items = [checks, ...(gaps.length === 0 ? [factsLine([[words.gapsLabel, words.none]])] : gaps.map((gap) => gapFacts(view, gap, say))), ...refutedLine].map((line) => `- ${line}`);
  const written = view.notExamined === null ? [] : say.paragraphs(view.notExamined).map((paragraph) => [paragraph]);
  if (count === 0 || cut) return { part: 'not examined', lines: blocks([words.notExaminedHeading], ...written, items) };
  const entries = view.refuted.map(({ candidate, claim, why }) => {
    const location = repositoryLocation(candidate) === null ? null : { path: candidate.file!, line: candidate.line! };
    const place = location === null ? words.noPlace : locationLink(view, location);
    const said = claim === null ? recordedWords(view, 'finder', sentenceText(say.words(candidate.summary))) : sentenceText(say.prose(claim));
    const refutedBecause = why === null ? factsLine([[words.evidenceLabel, words.inReport]]) : `${words.refutedWhyLabel} ${sentenceText(say.prose(why))}`;
    return `- ${place}: ${said} ${refutedBecause}`;
  });
  return { part: 'not examined', lines: blocks([words.notExaminedHeading], ...written, items, details(words.refutedSummary, entries)) };
}

/** How the review worked (R3): what each role does, the counts of the run as a table, the fixed diagram, and what the verdicts, the severities and the values a severity is read from mean. */
function howSection(view: FormView): Section {
  const { words, counts } = view;
  const labels = words.counts;
  const table = factsTable([labels.candidates, labels.groups, labels.refuted, labels.kept, labels.merged, labels.findings], [[counts.candidates, counts.groups, counts.refuted, counts.kept, counts.merged, counts.findings].map(String)]);
  const meanings = [words.verdictMeanings, ...(counts.unverified === 0 ? [] : [words.unverifiedMeaning]), words.severityMeanings, words.severityValues].join(' ');
  return { part: 'how', lines: blocks([words.howHeading], [words.rolesNotice], table, [fenced(howDiagram(view))], [meanings]) };
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

/** The major findings that ask a person to act, in rank order. */
const majorActing = (view: FormView): FindingView[] => view.findings.filter((finding) => !isMinor(finding) && acts(finding));

/** The areas the body gives: the writer's, or one under the label of the table with no diagram, for an answer that has none (R16). */
function areasOf(view: FormView, say: Speaker): { readonly title: string; readonly intro: string | null; readonly diagram: string | null; readonly findings: readonly FindingView[] }[] {
  const major = majorActing(view);
  if (view.areas === null) return [{ title: view.words.findingsArea, intro: null, diagram: null, findings: major }];
  return view.areas.map((area) => ({ title: say.prose(area.title), intro: say.prose(area.intro), diagram: area.diagram, findings: major.filter((finding) => area.findings.includes(finding.finding.id)) }));
}

/** A finding's line in an area or a row's text: its title, its facts, and what deep-review would do or asks. */
function findingLine(view: FormView, finding: FindingView, say: Speaker): string {
  const { words } = view;
  const action = actionText(view, finding, say);
  const facts = factsLine([[words.verdictLabel, verdictText(view, finding)], [words.decisionLabel, words.decisionValues[decisionValue(finding)]], ...(finding.question === null ? [] : [[words.recommendedLabel, String(finding.question.choice)] as const])]);
  return [`**${findingRef(view, finding)}.** ${sentenceText(titleText(view, finding, say))}`, facts, ...(action === null ? [] : [action])].join(' ');
}

/** The major findings by area (R4): each area's title, intro and diagram, less what a cut takes, and one line for each of its findings. */
function areasSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  if (majorActing(view).length === 0) return { part: 'areas', lines: [words.areasHeading, '', words.noMajor] };
  const diagrams = !cuts.has('area-diagrams');
  // Once, since each call cleans the writer's titles and intros, and counts their secrets, again.
  const given = areasOf(view, say);
  const areas = given.flatMap((area) => {
    const lines = area.findings.map((finding) => `- ${findingLine(view, finding, say)}`);
    const intro = area.intro === null || area.intro === '' ? '' : ` ${sentenceText(area.intro)}`;
    return [[`**${sentenceText(area.title)}**${intro}`], ...(area.diagram === null || !diagrams ? [] : [[say.diagram(area.diagram)]]), lines];
  });
  const cut = !diagrams && given.some((area) => area.diagram !== null);
  return { part: 'areas', lines: blocks([words.areasHeading], ...areas, ...(cut ? [[words.areaDiagramsCut]] : [])) };
}

/** Each finding with no comment that asks a person to act, in full, in the form of its comment (R1). */
function inFullSection(view: FormView, say: Speaker): Section {
  const full = view.findings.filter(inFull);
  return {
    part: 'findings in full',
    lines: full.flatMap((finding, index) => [
      ...(index === 0 ? [] : ['']),
      `<a id="${findingAnchor(finding.finding.number)}"></a>`,
      '',
      `### ${view.words.findingLabel} ${String(finding.finding.number)}`,
      '',
      titleLine(view, finding, say),
      '',
      ...joinedParts(findingParts(view, finding, say)),
    ]),
  };
}

/** The minor findings that ask a person to act: those that reach what a user sees first, then the others, each in rank order (R13). */
const minorActing = (view: FormView): FindingView[] => {
  const minor = view.findings.filter((finding) => isMinor(finding) && acts(finding));
  return [...minor.filter((finding) => finding.kind === 'user'), ...minor.filter((finding) => finding.kind !== 'user')];
};

/** The findings left as is, in rank order, whatever their verifiers named (R4 of the settled choice). */
const leftAsIs = (view: FormView): FindingView[] => view.findings.filter((finding) => !acts(finding));

/** Whether a cut of the findings left as is keeps a finding's lines: one whose verifier named a choice, so no such choice is missing from the review (R4 of the settled choice). */
const keptByCut = (finding: FindingView): boolean => finding.choices.some((candidate) => candidate.choice !== null);

/** The minor findings (R13): their counts as facts, those that need a person, then their table folded, or, cut, the notice in its place. */
function minorSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  const minor = minorActing(view);
  if (minor.length === 0) return { part: 'minor', lines: [] };
  const user = minor.filter((finding) => finding.kind === 'user').length;
  const needing = minor.filter((finding) => finding.question !== null || finding.departure !== null).map((finding) => finding.finding.number);
  const labels = words.minorLabels;
  const counts = factsLine([[labels.total, String(minor.length)], [labels.user, String(user)], [labels.code, String(minor.length - user)], [labels.onLine, String(minor.filter((finding) => finding.placement.place === 'line').length)], ...(needing.length === 0 ? [] : [[labels.needs, findingRefs(view, needing)] as const])]);
  if (cuts.has('minor-table')) return { part: 'minor', lines: blocks([words.minorHeading], [counts], [words.minorCut]) };
  const columns = words.minorColumns;
  const rows = minor.map((finding) => {
    const action = actionText(view, finding, say);
    // The decision as data only where the row would otherwise hide a departure from a written rule, as the area lines show it.
    const decided = decisionValue(finding) === 'fix-against-rule' ? [[words.decisionLabel, words.decisionValues['fix-against-rule']] as const] : [];
    const asked = finding.question === null ? [] : [[words.recommendedLabel, String(finding.question.choice)] as const];
    const facts = decided.length + asked.length === 0 ? [] : [factsLine([...decided, ...asked])];
    return [findingRef(view, finding), titleText(view, finding, say), words.kindValues[finding.kind ?? 'none'], verdictText(view, finding), [...(action === null ? [] : [action]), ...facts].join(' ')];
  });
  return { part: 'minor', lines: blocks([words.minorHeading], [counts], details(words.minorSummary, factsTable([columns.number, columns.finding, columns.kind, columns.verdict, columns.action], rows))) };
}

/**
 * The findings left as is, folded (R2 of the review in the writer's
 * words; R4 of the settled choice): each with the writer's title and
 * reason, or the ranking's summary and the decider's grounds as recorded
 * words; its facts with the reason of the closed list and the finding
 * that supersedes it; the steps that settled its choices; its line; and
 * the decision as recorded. Cut, those whose verifier named a choice and
 * the notice in place of the others.
 */
function leftSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  const left = leftAsIs(view);
  if (left.length === 0) return { part: 'left as is', lines: [] };
  const shown = cuts.has('left') ? left.filter(keptByCut) : left;
  const others = left.length - shown.length;
  const cutNotice = others === 0 ? [] : [`${factsLine([[words.notListedLabel, String(others)]])} ${words.leftCut}`];
  if (shown.length === 0) return { part: 'left as is', lines: blocks([words.leftHeading], cutNotice) };
  const block = (finding: FindingView): string[] => {
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
  };
  return { part: 'left as is', lines: blocks([words.leftHeading], details(words.leftSummary, ...shown.map(block)), cutNotice) };
}

/** The choices beside a decision, each verifier's choice and the one that settles it as recorded words under their labels, in its record or alone where the writer gave no text; none when its verifiers named none and it settles none. */
function choiceRecord(view: FormView, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  return choicesShown(finding.choices, finding.decision?.settled ?? []).map((shown) => {
    const settled = shown.settled === null
      ? labeledValue(words.settledChoiceLabel, words.notSettled)
      : `${words.settledChoiceLabel}: ${say.sentence(shown.settled.choice)} ${factsLine([[words.settledByLabel, words.settleSteps[shown.settled.by]]])} ${words.sourceLabel}: ${say.sentence(shown.settled.source)}`;
    return `- ${[...shown.verifiers.map((choice) => `${words.verifierChoiceLabel}: ${say.sentence(choice)}`), settled].join(' ')}`;
  });
}

/** The parts of the writer's answer that this review lacks, by the names of the table and each finding as a link: dropped by the checks, or absent from an older answer, and only where the review would show one. */
function missingParts(view: FormView): string[] {
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
 * Whether the body with the cuts given, or a comment, posts any text of
 * the writer (R7 of the review in the writer's words): the core, a
 * sentence on a condition, the summary, the areas when a major finding
 * acts, what the review did not examine, a refuted line or a finding left
 * as is the cuts keep, or a finding's text. A frozen answer can post
 * none: a writer that completed its unit has its answer frozen even when
 * the checks dropped every part.
 */
function postsWriterText(view: FormView, cuts: ReadonlySet<BodyCut>): boolean {
  return view.core.kind === 'writer'
    || heldConditionsOf(view).some((entry) => writerConditionOf(view, entry.condition) !== null)
    || view.summary !== null
    || view.notExamined !== null
    || (view.areas !== null && view.areas.length > 0 && majorActing(view).length > 0)
    || (!cuts.has('refuted') && view.refuted.some((line) => line.claim !== null || line.why !== null))
    || leftAsIs(view).some((finding) => finding.left !== null && (!cuts.has('left') || keptByCut(finding)))
    || view.findings.some((finding) => acts(finding) && (finding.written !== null || (finding.explained.kind === 'unexplained' && finding.explained.reason !== null)));
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
function trustSection(view: FormView, cuts: ReadonlySet<BodyCut>): Section {
  const { words, counts } = view;
  const columns = words.verdictColumns;
  const unverified = counts.unverified === 0 ? [] : [columns.unverified];
  const verdicts = factsTable([columns.verdict, columns.findings, columns.major, columns.majorRan, ...unverified], [
    ['CONFIRMED', String(counts.confirmed), String(counts.majorConfirmed), String(counts.majorConfirmedRan), ...(counts.unverified === 0 ? [] : ['0'])],
    ['PLAUSIBLE', String(counts.plausible), String(counts.major - counts.majorConfirmed), '', ...(counts.unverified === 0 ? [] : [String(counts.unverified)])],
  ]);
  const bases = (['ran', 'traced', 'read'] as const).filter((basis) => counts.bases[basis] > 0).map((basis) => [words.basisValues[basis], String(counts.bases[basis])]);
  const basisTable = counts.findings === 0 ? [] : factsTable([words.basisColumns.basis, words.basisColumns.findings], [...bases, ...(counts.noBasis === 0 ? [] : [[words.noBasisValue, String(counts.noBasis)]])]);
  const candidates = factsLine([[words.counts.candidates, String(counts.candidates)], [words.counts.refuted, String(counts.refuted)]]);
  const notes: string[][] = [];
  if (postsWriterText(view, cuts)) notes.push([words.modelNotice]);
  if (view.recorded === null) notes.push([words.noExplanation]);
  const missing = missingParts(view);
  if (missing.length > 0) notes.push([factsLine([[words.missingLabel, valueList(missing)]])]);
  // An answer is recorded on a complete run, and the explanation before the report, so every standing answer of an explained run came after it.
  if (view.recorded !== null) {
    const answered = [...standingAnswers(view.review).keys()].map((id) => view.brief.numbers.get(id)!);
    if (answered.length > 0) notes.push([factsLine([[words.answeredAfterLabel, findingRefs(view, [...new Set(answered)].sort((a, b) => a - b))]])]);
  }
  return { part: 'trust', lines: blocks([words.trustHeading], counts.findings === 0 ? [] : verdicts, basisTable, [candidates], ...notes) };
}

/** The last visible line, the engine, the runtime and its models, the run and the commits it reviewed, as facts, then the marker of the publication (R9, R13). The version the runtime gave and the models the settings name are no text of the engine's, so they are cleaned. */
function lastSection(view: FormView, say: Speaker): Section {
  const { configuration } = view.review;
  const labels = view.words.lastLabels;
  return {
    part: 'last line',
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
 * The body with the cuts given, and the secrets its cleaning replaced: the
 * heading, the core of the change, the summary, what needs a person, what
 * the review did not examine, how the review worked, the major findings by
 * area, the findings in full, the minor findings, the findings left as is,
 * how far to trust the review and the last line.
 */
function renderBody(view: FormView, cuts: ReadonlySet<BodyCut>): { readonly sections: readonly Section[]; readonly text: string; readonly secrets: number } {
  const say = speakerOf(view.input.machine, view.words, view.names);
  const sections = [
    headingSection(view),
    coreSection(view, say),
    summarySection(view, say),
    needsSection(view, say),
    notExaminedSection(view, say, cuts),
    howSection(view),
    areasSection(view, say, cuts),
    inFullSection(view, say),
    minorSection(view, say, cuts),
    leftSection(view, say, cuts),
    trustSection(view, cuts),
    lastSection(view, say),
  ].filter((section) => section.lines.length > 0);
  return { sections, text: sections.map((section) => section.lines.join('\n')).join('\n\n'), secrets: say.secrets() };
}

/** Whether a cut takes anything from this run's body, so a cut that changes nothing is neither made nor named. */
function cutApplies(view: FormView, cut: BodyCut): boolean {
  switch (cut) {
    case 'refuted':
      return view.refuted.length > 0;
    case 'left':
      return leftAsIs(view).some((finding) => !keptByCut(finding));
    case 'minor-table':
      return minorActing(view).length > 0;
    case 'area-diagrams':
      return majorActing(view).length > 0 && view.areas !== null && view.areas.some((area) => area.diagram !== null);
  }
}

/**
 * The review of a read-only run of a pull request, as `publish` posts it
 * (R9, R10, R12): the body, cut as `bodyCuts` orders when it does not fit,
 * with the marker of the publication as its last line; a comment on its
 * line for each fix and each question that has one, with the marker of its
 * finding as its last line; the place of each finding as the ledger
 * records it; the count of the secrets the cleaning replaced in what is
 * posted; and the cuts made. A comment over the limit, or a body over it
 * after every cut, is refused with its size and parts.
 */
export function pullRequestForm(input: PullRequestFormInput): PullRequestForm | FormRefusal {
  const view = formViewOf(input);
  const comments: FormComment[] = [];
  let secrets = 0;
  for (const finding of view.findings) {
    if (finding.placement.place !== 'line') continue;
    const rendered = commentOf(view, { ...finding, placement: finding.placement });
    if ('kind' in rendered) return rendered;
    comments.push(rendered.comment);
    secrets += rendered.secrets;
  }
  const applicable = bodyCuts.filter((cut) => cutApplies(view, cut));
  let body = renderBody(view, new Set());
  let made = 0;
  while (body.text.length > maxPostedLength && made < applicable.length) {
    made += 1;
    body = renderBody(view, new Set(applicable.slice(0, made)));
  }
  if (body.text.length > maxPostedLength) {
    return { kind: 'refused', text: { kind: 'body' }, size: body.text.length, limit: maxPostedLength, parts: body.sections.map((section) => ({ part: section.part, size: section.lines.join('\n').length })) };
  }
  return {
    kind: 'rendered',
    body: body.text,
    comments,
    places: input.places.map(({ finding, place, reason }) => ({ finding, place, reason })),
    secrets: secrets + body.secrets,
    cuts: applicable.slice(0, made),
  };
}
