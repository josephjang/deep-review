/**
 * The form of the pull request (R9, R10, R12, TD6 of the review on the
 * pull request; R1 to R5, R12 to R16 of the review that reads as a
 * report): the body and the comments of the one review `publish` posts,
 * rendered from one view of the run (`FormView`) that `formViewOf` builds
 * once from the brief value, the ranked findings with their decisions, the
 * place of each finding, the counts of the run and the writer's
 * explanation, and nothing else. Pure: the caller reads GitHub, the
 * evidence store and the commits, and this module only renders.
 *
 * `placeFindings` puts each finding on its line or in the body
 * ("The place of a finding" of the design, TD4). `pullRequestForm`
 * renders the body in the order of R1, with the engine's own words from
 * the table of the run's language (pull-request-words.ts, R15), each text
 * of a worker, the runtime's version and the models and the patterns the
 * settings name through `publicWords` or `publicCode`, each of the writer
 * through `publicProse` (R11), and a comment on its line for each fix and
 * each question that has one (R5). Every link to code is a permalink at
 * the reviewed head, or at the merge base for removed lines (R14). A body
 * over the limit is cut in the order of `bodyCuts`, and a body that still
 * does not fit, or a comment that does not, is a refusal with its size and
 * parts, before anything is recorded. The texts that say what follows the
 * review are chosen once, by whether the run went on into its fix pass
 * (`followingOf`, R6 of the review of a fix run).
 */
import { standingAnswers } from '../checkpoint/answer-state.ts';
import type { CandidateChoice, ExplanationRecorded, PullRequestFacts, RecordedDecision, ScopeState, Unconfirmed } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { repositoryLocation, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { NewLineKind, PullRequestFile } from '../github/pull-request.ts';
import { newLinesOf } from '../github/pull-request.ts';
import { briefOf, firstSentence, type Brief, type BriefDeparture, type BriefFinding, type BriefQuestion } from './brief.ts';
import { diagramFailures, reviewLanguage, type ExplainedFinding, type RecordedAnswer as WriterAnswer } from './explanation.ts';
import { namedFindings, namedInDiagram, type NamedId } from './finding-names.ts';
import { capitalized, codeSpan, findingAnchor, inlineText, paragraphText, sentenceText, tableCell } from './markdown.ts';
import { findingMarker, markerLine, publicationMarker } from './markers.ts';
import { answerArguments, answerCommand } from './needs.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicProse, publicWords, withoutSecrets, type MachineContext } from './public-text.ts';
import { pullRequestWords, type FollowingWords, type PullRequestWords, type ReviewCounts } from './pull-request-words.ts';
import { shortRunId } from './runs.ts';
import { choicesShown, mergeRankInput, rankedFindings, refuted, type ReportFinding } from './state.ts';
import { asksToAct, verdictBases, type FindingKind, type FindingPlace, type PlaceReason, type VerdictBasis } from './vocabulary.ts';

/** The most characters of a body or a comment, a margin under the 65,536 people report GitHub takes (R12). */
export const maxPostedLength = 60_000;

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
}

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

/** How a finding is explained: by the writer, not explained (marked by the writer with its reason, dropped by the checks, or not asked of the writer), or by no explanation the run recorded. */
type Explained =
  | { readonly kind: 'explained'; readonly value: ExplainedFinding }
  | { readonly kind: 'unexplained'; readonly reason: string | null }
  | { readonly kind: 'none' };

/**
 * A ranked finding with all the form reads of it: the ledger's facts, and
 * the parts that the writer's and the verifier's answers give, each null
 * when the answer has none, which the form then replaces with the engine's
 * words (R16).
 */
interface FindingView {
  readonly finding: BriefFinding;
  readonly entry: ReportFinding;
  readonly decision: RecordedDecision | null;
  readonly placement: FindingPlacement;
  readonly explained: Explained;
  readonly question: BriefQuestion | null;
  readonly departure: BriefDeparture | null;
  /** The writer's sentence of what deep-review would do (`conclusion.actions`); null falls back to the first sentence of the decided approach. */
  readonly action: string | null;
  /** The writer's line of how the verifier checked it (R10); null falls back to the words of the verdict's basis. */
  readonly checked: string | null;
  /** The writer's kind of a minor finding (R13); null lists it with the code. */
  readonly kind: FindingKind | null;
  /** The verifier's reason for a PLAUSIBLE verdict (R7); null says that it gave none. */
  readonly unconfirmed: Unconfirmed | null;
  /** Every candidate, primary first, with the choice its verifier left to the author or null (R9), which the review shows beside the decision (PD8, PD9 of the settled choice). */
  readonly choices: readonly CandidateChoice[];
}

/** An area of the major findings that ask a person to act, as the writer gives it (R4): its title, its intro, a diagram or none, and its findings by id. */
interface AreaView {
  readonly title: string;
  readonly intro: string;
  readonly diagram: string | null;
  readonly findings: readonly string[];
}

/** A candidate a verifier refuted, with the writer's sentence of its claim and of why it was refuted (R11), each null when the writer gave none. */
interface RefutedView {
  readonly candidate: CandidateState;
  readonly claim: string | null;
  readonly why: string | null;
}

/** The run as every part of the form reads it, built once by `formViewOf`. */
interface FormView {
  readonly state: RunState;
  readonly review: ReviewState;
  readonly scope: ScopeState;
  readonly pullRequest: PullRequestFacts;
  readonly brief: Brief;
  readonly words: PullRequestWords;
  /** The words of what follows the review, for the run's fix pass (`followingOf`). */
  readonly following: FollowingWords;
  readonly findings: readonly FindingView[];
  /** The writer's areas; null puts every major finding that acts in one area named by the engine (R16). */
  readonly areas: readonly AreaView[] | null;
  readonly refuted: readonly RefutedView[];
  readonly counts: ReviewCounts;
  /** The writer's sentence that names the areas. */
  readonly conclusion: { readonly why: string } | null;
  readonly recorded: ExplanationRecorded | null;
  /** What each id of the run names in a worker's text: a finding by its number, merged candidates included, or a refuted candidate (R1, R2 of the finding names in the review). */
  readonly names: ReadonlyMap<string, NamedId>;
  readonly input: PullRequestFormInput;
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

/** The lines `from` to `to` of `path` at `commit`, as GitHub shows them in the repository of the pull request: a permalink, which no later push moves (R14). */
function blobUrl(pullRequest: PullRequestFacts, commit: string, path: string, from: number, to: number): string {
  return `https://${pullRequest.host}/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repository)}/blob/${commit}/${urlPath(path)}#L${String(from)}${to === from ? '' : `-L${String(to)}`}`;
}

/** The line of a location at the reviewed head. */
const headUrl = (view: FormView, location: FindingLocation): string => blobUrl(view.pullRequest, view.scope.head, location.path, location.line, location.line);

/** A location as a link to its line at the head, its text on one line whatever line break its path holds. */
const locationLink = (view: FormView, location: FindingLocation): string => `[${codeSpan(inlineText(`${location.path}:${String(location.line)}`))}](${headUrl(view, location)})`;

/** Where the body links a finding (R14, TD4): the line its comment sits on, at the head, or its block in the body. */
const hrefOf = (view: FormView, finding: FindingView): string => (finding.placement.place === 'line' ? headUrl(view, finding.placement.location) : `#${findingAnchor(finding.finding.number)}`);

/**
 * The words of what follows the review (R6 of the review of a fix run):
 * those of a run continued into its fix pass, or the read-only ones, which
 * name the command that continues the run into the fix pass, a code span.
 */
function followingOf(words: PullRequestWords, fixPass: FixPass, pullRequest: number): FollowingWords {
  if (fixPass === 'continued') return words.continued;
  const fix = codeSpan(`deep-review review --pr ${String(pullRequest)} --fix`);
  return {
    reviewed: words.reviewed,
    summaryNext: (counts) => words.summaryNext(counts, fix),
    departureStands: words.departureStands,
    departure: (rule, source, fact, accept, reject) => words.departure(rule, source, fact, accept, reject, fix),
    standing: words.standing,
    answerQuestion: (command) => words.answerQuestion(command, fix),
    howDiagram: words.howDiagram,
    noCheck: words.noCheck,
  };
}

/** The marks after a finding's verdict: no verifier examined it. */
const verdictMarks = (view: FormView, finding: FindingView): string[] => (finding.entry.resolution.unverified ? [view.words.unverifiedMark] : []);

/** A finding's verdict with its marks, as the areas and the minor table give it. */
const verdictText = (view: FormView, finding: FindingView): string => [finding.finding.verdict, ...verdictMarks(view, finding)].join(', ');

/** The note on what the pull request does to a finding's line, or that it has no place; none for an added line. */
function diffNote(view: FormView, placement: FindingPlacement): string | null {
  const { words } = view;
  if (placement.reason === 'no-place') return words.noPlaceNote;
  switch (placement.diff) {
    case 'context':
    case 'outside-the-hunks':
      return words.lineNotChanged;
    case 'not-in-the-pull-request':
      return words.fileNotChanged;
    case 'no-patch':
      return placement.reason === 'no-patch' ? words.noPatch : null;
    default:
      return null;
  }
}

/** The line under a finding's title (R5): its severity, its verdict with how it was checked, what became of it, or the sentence `status` gives in its place, and the note on its line. */
function gradeLine(view: FormView, finding: FindingView, status: string | null = null): string {
  const { words } = view;
  const { basis } = finding.entry.resolution;
  const note = diffNote(view, finding.placement);
  return [words.grade(finding.finding.severity, finding.finding.verdict, basis === null ? null : words.basisWords[basis], verdictMarks(view, finding)), status ?? words.statusSentences[finding.finding.status], ...(note === null ? [] : [note])].join(' ');
}

/** A finding's title: the writer's, or the first sentence of its summary. */
const titleOf = (finding: FindingView, say: Speaker): string => (finding.explained.kind === 'explained' ? say.prose(finding.explained.value.title) : say.words(firstSentence(finding.entry.finding.summary)));

/** What deep-review would do about a fix, as one sentence: the writer's, or the first sentence of the decided approach. */
function actionSentence(finding: FindingView, say: Speaker): string {
  if (finding.action !== null) return sentenceText(say.prose(finding.action));
  return finding.decision?.decision === 'fix' ? say.sentence(firstSentence(finding.decision.fix.approach)) : '';
}

/** The tail of a finding's line in an area or a row of the minor table: what deep-review would do, or what a question recommends. */
function actionTail(view: FormView, finding: FindingView, say: Speaker): string {
  const { words } = view;
  const { question } = finding;
  if (finding.decision?.decision === 'ask' && question !== null) return words.recommends(question.choice, say.sentence(question.options[question.choice - 1]!.option));
  return [words.wouldDo(actionSentence(finding, say)), ...(finding.departure === null ? [] : [words.againstRule])].join(' ');
}

/** Why a PLAUSIBLE verdict is not CONFIRMED (R7): its verifier's reason, that it gave none, or that no verifier examined it; none for a CONFIRMED one. */
function whyPlausible(view: FormView, finding: FindingView, say: Speaker): string[] {
  if (finding.finding.verdict !== 'PLAUSIBLE') return [];
  if (finding.entry.resolution.unverified) return [view.words.whyUnverified];
  const given = finding.unconfirmed;
  return [view.words.whyPlausible(given === null ? null : { kind: given.kind, text: sentenceText(say.words(given.text)) })];
}

/** The mark of a finding the writer did not explain, with its reason, as a paragraph of its own (R19 of the review on the pull request); none for one it explained or a run with no explanation. */
function unexplainedMark(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const { explained } = finding;
  return explained.kind === 'unexplained' ? [[view.words.unexplained(explained.reason === null ? null : say.prose(explained.reason))]] : [];
}

/** The paragraphs of what goes wrong: the writer's problem, or, without it, the finder's own account in its place. */
function problemParagraphs(finding: FindingView, say: Speaker): string[] {
  const { explained } = finding;
  return explained.kind === 'explained' ? say.paragraphs(explained.value.problem) : [paragraphText(say.words(finding.entry.primary.detail))];
}

/** What goes wrong, each paragraph a block after the mark of a finding not explained, the first under its label and the last with the reason of a PLAUSIBLE verdict, then the writer's diagram (R5, R7). */
function explanationBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const paragraphs = problemParagraphs(finding, say);
  const told = paragraphs.length === 0 ? [''] : paragraphs;
  const last = told.length - 1;
  const lines = told.map((paragraph, index) => [index === 0 ? `${view.words.problemLabel} ${paragraph}` : paragraph, ...(index === last ? whyPlausible(view, finding, say) : [])].join(' ').trim());
  const diagram = finding.explained.kind === 'explained' && finding.explained.value.diagram !== null ? [[say.diagram(finding.explained.value.diagram)]] : [];
  return [...unexplainedMark(view, finding, say), ...lines.map((line) => [line]), ...diagram];
}

/** A minor finding's one paragraph (R5) after the mark of one not explained: what goes wrong, why it is PLAUSIBLE, and what deep-review would do. */
function minorBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  const parts = [...problemParagraphs(finding, say), ...whyPlausible(view, finding, say), ...(finding.decision?.decision === 'fix' ? [view.words.wouldDo(actionSentence(finding, say))] : [])];
  return [...unexplainedMark(view, finding, say), [parts.join(' ')]];
}

/** The decided fix, folded, with each option rejected (R5). */
function decidedFixLines(view: FormView, decision: Extract<RecordedDecision, { decision: 'fix' }>, say: Speaker): string[] {
  const { words } = view;
  const rejected = decision.fix.rejected.map((option) => `- ${words.rejected(say.sentence(option.option), say.sentence(option.reason))}`);
  return details(words.asDecided, [paragraphText(say.sentence(decision.fix.approach))], rejected);
}

/** A fix against a written rule (R8): the rule, its source, the fact against it, and how its answer is given or was. */
function departureLines(view: FormView, departure: BriefDeparture, say: Speaker): string[] {
  const { words } = view;
  const sentence = (text: string): string => sentenceText(say.words(text));
  const paragraph = view.following.departure(sentence(departure.rule), sentence(departure.source), say.sentence(departure.fact), codeSpan(departure.accept), codeSpan(departure.reject));
  const given = departure.review;
  const answered = given === null ? [] : [given.kind === 'reject' ? words.answeredReject(given.at) : words.answeredAccept(given.at)];
  return [[paragraph, ...answered].join(' ')];
}

/** A question (R8): why it is one, the question, its options with their costs, then the option recommended and the one that stands with the command that answers, or the answer given. */
function questionBlocks(view: FormView, finding: FindingView, question: BriefQuestion, grounds: string, say: Speaker): string[][] {
  const { words } = view;
  const options = question.options.map((option) => words.option(option.number, say.sentence(option.option), say.sentence(option.cost)));
  const given = question.answer;
  const standing = given !== null && given.option !== null
    ? [[words.answeredOption(given.option, given.at)]]
    : [
      [view.following.standing(question.choice, question.default, question.options[question.default - 1]!.edits, null)],
      [view.following.answerQuestion(codeSpan(answerCommand(view.state.id, finding.finding.number, '--option <k>')))],
    ];
  return [[`${words.whyAsked} ${say.sentence(grounds)}`], [words.question(say.sentence(question.question))], options, ...standing];
}

/**
 * The choices beside a finding's decision, a paragraph each (R4, R5, PD8,
 * PD9 of the settled choice): each choice its decision settles, with the
 * step in the review's words and the source, after the choices of the
 * candidates' verifiers it answers; then each choice a verifier left to
 * the author that no settlement answers, with that deep-review did not
 * settle it; none when there is neither. Each is a block of its own, so
 * a blank line parts two choices.
 */
function choiceBlocks(view: FormView, finding: FindingView, say: Speaker): string[][] {
  return choicesShown(finding.choices, finding.decision?.settled ?? []).map((shown) => [view.words.choice({
    verifiers: shown.verifiers.map((choice) => say.sentence(choice)),
    settled: shown.settled === null ? null : { choice: say.sentence(shown.settled.choice), step: view.words.settleSteps[shown.settled.by], source: say.sentence(shown.settled.source) },
  })]);
}

/** The engine's words on why a finding is left as is, with the finding that supersedes it. */
function leftBecauseOf(view: FormView, leave: Extract<RecordedDecision, { decision: 'leave' }>): string {
  const by = leave.leave.supersededBy;
  return view.words.leftBecause(view.words.leaveReasons[leave.leave.reason], by === null ? null : view.words.findingList([view.brief.numbers.get(by)!]));
}

/** What deep-review would do about a finding of R5's order, each a block: the sentence, the choice it makes and the folded fix, with a departure between; or the question. */
function decisionBlocks(view: FormView, finding: FindingView, say: Speaker, minor: boolean): string[][] {
  const { decision, departure, question } = finding;
  if (decision?.decision === 'fix') {
    const would = minor ? [] : [[`${view.words.wouldDoLabel} ${actionSentence(finding, say)}`]];
    return [...would, ...choiceBlocks(view, finding, say), ...(departure === null ? [] : [departureLines(view, departure, say)]), decidedFixLines(view, decision, say)];
  }
  if (decision?.decision === 'ask' && question !== null) return questionBlocks(view, finding, question, decision.grounds, say);
  return [];
}

/** How the verifier checked a finding, folded (R10): the writer's line, or the words of the verdict's basis. */
function checkedLines(view: FormView, finding: FindingView, say: Speaker): string[] {
  const { words } = view;
  const { resolution } = finding.entry;
  const fallback = resolution.unverified ? words.notVerified : resolution.basis === null ? words.noBasis : words.basisSentences[resolution.basis];
  return details(words.howChecked, [finding.checked === null ? fallback : paragraphText(sentenceText(say.prose(finding.checked)))]);
}

/** The lines a case cites, as a link at the commit of its side: the head, or the merge base for lines the change removed (R14); its text is on one line whatever line break the path holds. */
function caseLink(view: FormView, cited: ExplainedFinding['cases'][number]['lines']): string {
  const range = cited.from === cited.to ? String(cited.from) : `${String(cited.from)}-${String(cited.to)}`;
  const link = `[${codeSpan(inlineText(`${cited.path}:${range}`))}](${blobUrl(view.pullRequest, cited.side === 'head' ? view.scope.head : view.scope.base, cited.path, cited.from, cited.to)})`;
  return cited.side === 'head' ? link : view.words.atBase(link);
}

/** The code a finding rests on (R5): each case the writer cites with its sentence, or, for a minor finding and one with no cases, its own line at the head; none for a finding with no place. */
function codeLines(view: FormView, finding: FindingView, say: Speaker, minor: boolean): string[] {
  const { words } = view;
  const cases = !minor && finding.explained.kind === 'explained' ? finding.explained.value.cases : [];
  if (cases.length > 0) return [words.codeHeading, ...cases.map((cited) => `- ${caseLink(view, cited.lines)} ${sentenceText(say.prose(cited.sentence))}`)];
  const { location } = finding.placement;
  return location === null ? [] : [`${words.codeHeading} ${locationLink(view, location)}.`];
}

/** The parts of a finding's block, which a comment and the body share, and whose sizes a refusal names. */
interface FindingParts {
  readonly explanation: string[];
  readonly decision: string[];
  readonly checked: string[];
  readonly code: string[];
}

/** The parts of the block of a finding in R5's order: a major one with its problem, diagram, decision and folded check; a minor one with its problem and action in one paragraph, a paragraph for each choice its verifiers named or its decision settles, its departure and its folded fix. */
function findingParts(view: FormView, finding: FindingView, say: Speaker): FindingParts {
  const minor = isMinor(finding);
  return {
    explanation: blocks([gradeLine(view, finding)], ...(minor ? minorBlocks(view, finding, say) : explanationBlocks(view, finding, say))),
    decision: blocks(...decisionBlocks(view, finding, say, minor)),
    checked: minor ? [] : checkedLines(view, finding, say),
    code: codeLines(view, finding, say, minor),
  };
}

const joinedParts = (parts: FindingParts): string[] => blocks(parts.explanation, parts.decision, parts.checked, parts.code);

/** The comment of a finding on its line, with the id of the finding and its marker as its last lines, or the refusal of one over the limit. */
function commentOf(view: FormView, finding: FindingView & { readonly placement: Extract<FindingPlacement, { place: 'line' }> }): { readonly comment: FormComment; readonly secrets: number } | FormRefusal {
  const say = speakerOf(view.input.machine, view.words, view.names);
  const heading = `**${String(finding.finding.number)}. ${titleOf(finding, say)}**`;
  const parts = findingParts(view, finding, say);
  const trace = view.words.trace(codeSpan(inlineText(finding.finding.id)), codeSpan(shortRunId(view.state.id)));
  const body = blocks([heading], joinedParts(parts), [trace], [markerLine(findingMarker(view.state.id, finding.finding.id))]).join('\n');
  const { location } = finding.placement;
  if (body.length > maxPostedLength) {
    const size = (lines: readonly string[]): number => lines.join('\n').length;
    return {
      kind: 'refused',
      text: { kind: 'comment', finding: finding.finding.id, path: location.path, line: location.line },
      size: body.length,
      limit: maxPostedLength,
      parts: [{ part: 'explanation', size: size([heading, ...parts.explanation]) }, { part: 'decision', size: size(parts.decision) }, { part: 'checked', size: size(parts.checked) }, { part: 'code', size: size(parts.code) }],
    };
  }
  return { comment: { finding: finding.finding.id, path: location.path, line: location.line, body }, secrets: say.secrets() };
}

/** One section of the body, by the name a refusal gives its size with. */
interface Section {
  readonly part: string;
  readonly lines: readonly string[];
}

/** The heading and the line on what the run reviewed and that it changed no file, or what it went on to do (R1; R6 of the review of a fix run). */
function headingSection(view: FormView): Section {
  const { words, scope } = view;
  return { part: 'heading', lines: [words.heading, '', view.following.reviewed(codeSpan(shortCommit(scope.head)), scope.files.length, codeSpan(shortCommit(scope.base)))] };
}

/** The writer's sentence on the areas that the summary posts: none when the answer kept no conclusion, or when the checks dropped the writer's areas, which the body then does not show. */
const postedWhy = (view: FormView): string | null => (view.conclusion === null || (view.recorded?.dropped.some((part) => part.part === 'areas') ?? false) ? null : view.conclusion.why);

/** The summary (R1): the counts of the findings with the writer's sentence on the areas (`postedWhy`), then what deep-review decided and what happens next. */
function summarySection(view: FormView, say: Speaker): Section {
  const { words, findings } = view;
  const given = postedWhy(view);
  const why = given === null ? [] : say.paragraphs(given);
  const decided = {
    fixes: findings.filter((finding) => finding.finding.status === 'planned' || finding.finding.status === 'planned-against-rule').length,
    questions: findings.filter((finding) => finding.finding.status === 'question').length,
    left: findings.filter((finding) => finding.finding.status === 'left').length,
  };
  const next = findings.length === 0 ? [] : [[view.following.summaryNext(decided)]];
  return { part: 'summary', lines: blocks([words.summaryHeading], [[words.summaryCounts(view.counts), ...why.slice(0, 1)].join(' ')], ...why.slice(1).map((paragraph) => [paragraph]), ...next) };
}

/** What needs a person (R2, R8; R4 of the settled choice): each question and each fix against a written rule, with a link to where it is read, then the one command that answers; or that nothing does. */
function needsSection(view: FormView, say: Speaker): Section {
  const { words } = view;
  const sentence = (text: string): string => sentenceText(say.words(text));
  const questions = view.findings.flatMap((finding) => {
    const { question } = finding;
    if (finding.decision?.decision !== 'ask' || question === null) return [];
    const given = question.answer;
    const tail = given !== null && given.option !== null
      ? words.answeredOption(given.option, given.at)
      : view.following.standing(question.choice, question.default, question.options[question.default - 1]!.edits, say.sentence(question.options[question.choice - 1]!.option));
    return [`- ${words.needsQuestion(finding.finding.number, hrefOf(view, finding), say.sentence(question.question), tail)}`];
  });
  const departures = view.findings.flatMap((finding) => {
    const { departure } = finding;
    if (departure === null) return [];
    const given = departure.review;
    const tail = given === null ? view.following.departureStands : given.kind === 'reject' ? words.answeredReject(given.at) : words.answeredAccept(given.at);
    return [`- ${words.needsDeparture(finding.finding.number, hrefOf(view, finding), sentence(departure.rule), tail)}`];
  });
  const items = [...questions, ...departures];
  if (items.length === 0) return { part: 'needs', lines: [words.needsHeading, '', words.needsNothing] };
  const flags = [...(questions.length === 0 ? [] : ['--option <k>']), ...(departures.length === 0 ? [] : ['--accept', '--reject'])].map(codeSpan);
  const answer = flags.length === 0 ? [] : [[words.needsAnswer(codeSpan(`deep-review ${answerArguments(view.state.id, '<n>', '').trimEnd()}`), flags)]];
  return { part: 'needs', lines: blocks([words.needsHeading], items, ...answer) };
}

/** How the review worked (R3): the roles and the counts of the run, the fixed diagram, and what the verdicts, the severities and the values a severity is read from mean. */
function howSection(view: FormView): Section {
  const { words, counts } = view;
  const meanings = [words.verdictMeanings, ...(counts.unverified === 0 ? [] : [words.unverifiedMeaning]), words.severityMeanings, words.severityValues].join(' ');
  return { part: 'how', lines: blocks([words.howHeading], [words.howWorked(counts)], [fenced(view.following.howDiagram(view.pullRequest.number))], [meanings]) };
}

/** The major findings that ask a person to act, in rank order. */
const majorActing = (view: FormView): FindingView[] => view.findings.filter((finding) => !isMinor(finding) && acts(finding));

/** The areas the body gives: the writer's, or, for an older run, one named by the engine with no diagram, since an older conclusion's diagram names findings by their ids (R16). */
function areasOf(view: FormView, say: Speaker): { readonly title: string; readonly intro: string | null; readonly diagram: string | null; readonly findings: readonly FindingView[] }[] {
  const major = majorActing(view);
  if (view.areas === null) return [{ title: view.words.findingsArea, intro: null, diagram: null, findings: major }];
  return view.areas.map((area) => ({ title: say.prose(area.title), intro: say.prose(area.intro), diagram: area.diagram, findings: major.filter((finding) => area.findings.includes(finding.finding.id)) }));
}

/** The major findings by area (R4): each area's title, intro and diagram, less what a cut takes, and one line for each of its findings. */
function areasSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  if (majorActing(view).length === 0) return { part: 'areas', lines: [words.areasHeading, '', words.noMajor] };
  const diagrams = !cuts.has('area-diagrams');
  // Once, since each call cleans the writer's titles and intros, and counts their secrets, again.
  const given = areasOf(view, say);
  const areas = given.flatMap((area) => {
    const lines = area.findings.map((finding) => `- **[${String(finding.finding.number)}. ${titleOf(finding, say)}](${hrefOf(view, finding)}).** ${verdictText(view, finding)}. ${actionTail(view, finding, say)}`);
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
      view.words.inFullHeading(finding.finding.number, titleOf(finding, say)),
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

/** The minor findings (R13): how many, what they reach and which need a person, then their table folded, or, cut, the note in its place. */
function minorSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  const minor = minorActing(view);
  if (minor.length === 0) return { part: 'minor', lines: [] };
  const user = minor.filter((finding) => finding.kind === 'user').length;
  const lead = words.minorLead({ total: minor.length, user, code: minor.length - user, onLine: minor.filter((finding) => finding.placement.place === 'line').length });
  const needing = minor.filter((finding) => finding.question !== null || finding.departure !== null).map((finding) => finding.finding.number);
  const intro = [lead, ...(needing.length === 0 ? [] : [words.minorNeeds(words.findingList(needing), needing.length)])].join(' ');
  if (cuts.has('minor-table')) return { part: 'minor', lines: blocks([words.minorHeading], [intro], [words.minorCut]) };
  const rows = minor.map((finding) => `| ${[String(finding.finding.number), `[${titleOf(finding, say)}](${hrefOf(view, finding)})`, verdictText(view, finding), actionTail(view, finding, say)].map(tableCell).join(' | ')} |`);
  const order = user > 0 && user < minor.length ? [[words.minorOrder(user)]] : [];
  const table = [`| ${words.minorColumns.join(' | ')} |`, `|${words.minorColumns.map(() => '---').join('|')}|`, ...rows];
  return { part: 'minor', lines: blocks([words.minorHeading], [intro], details(words.minorSummary(minor.length), ...order, table)) };
}

/**
 * The findings left as is, folded, each with why, the choice beside its
 * decision and its line (R4 of the settled choice); or, cut, those whose
 * verifier named a choice and the note in place of the others, or the
 * note in place of them all when none named one.
 */
function leftSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = view;
  const left = leftAsIs(view);
  if (left.length === 0) return { part: 'left as is', lines: [] };
  const shown = cuts.has('left') ? left.filter(keptByCut) : left;
  if (shown.length === 0) return { part: 'left as is', lines: [words.leftHeading, '', words.leftCut(left.length)] };
  const block = (finding: FindingView): string[] => {
    const leave = finding.decision?.decision === 'leave' ? finding.decision : null;
    const { location } = finding.placement;
    return blocks(
      [`<a id="${findingAnchor(finding.finding.number)}"></a>`],
      [`**${String(finding.finding.number)}. ${titleOf(finding, say)}**`],
      [gradeLine(view, finding, leave === null ? null : leftBecauseOf(view, leave))],
      leave === null ? [] : [`${words.groundsLabel} ${say.sentence(leave.grounds)}`],
      ...choiceBlocks(view, finding, say),
      location === null ? [] : [`${words.codeHeading} ${locationLink(view, location)}.`],
    );
  };
  const others = left.length - shown.length;
  return { part: 'left as is', lines: blocks([words.leftHeading], details(words.leftSummary(shown.length), ...shown.map(block)), others === 0 ? [] : [words.leftOthersCut(others)]) };
}

/**
 * What the review did not examine (R11): that no check ran; the patterns
 * of `scope.exclude` that left paths out, cleaned as code, with the count
 * and the layer that set them; each other gap of the brief, cleaned as a
 * worker's words are, since it quotes the paths of the change as they
 * are; or that the run examined everything; then the refuted candidates,
 * folded, each with its line, its claim and why it was refuted, or, cut,
 * the note in their place.
 */
function notExaminedSection(view: FormView, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words, scope } = view;
  const gaps = view.brief.notExamined.filter((gap) => gap.kind !== 'excluded');
  const layer = view.review.configuration.settings?.layers['scope.exclude'] ?? null;
  const excluded = scope.excluded.count === 0 ? [] : [words.excluded(scope.request.exclude.map((pattern) => say.code(pattern)), scope.excluded.count, layer === null ? null : words.layers[layer])];
  const cut = cuts.has('refuted');
  const count = view.refuted.length;
  const refutedLine = count === 0 ? [] : [cut ? words.refutedCut(count) : words.refutedLine(count)];
  const items = [view.following.noCheck, ...excluded, ...(gaps.length === 0 ? [words.allExamined] : gaps.map((gap) => words.gap(say.words(gap.text)))), ...refutedLine].map((item) => `- ${item}`);
  if (count === 0 || cut) return { part: 'not examined', lines: blocks([words.notExaminedHeading], items) };
  const entries = view.refuted.map(({ candidate, claim, why }) => {
    const location = repositoryLocation(candidate) === null ? null : { path: candidate.file!, line: candidate.line! };
    const place = location === null ? words.noPlace : locationLink(view, location);
    return `- ${place}: ${words.refutedItem(sentenceText(claim === null ? say.words(candidate.summary) : say.prose(claim)), why === null ? words.refutedInReport : sentenceText(say.prose(why)))}`;
  });
  return { part: 'not examined', lines: blocks([words.notExaminedHeading], items, details(words.refutedSummary(count), entries)) };
}

/**
 * Whether a finding's block posts text of the writer: the title and the
 * explanation of one it explained, wherever the finding is shown; and, in
 * the comment or the block in full of one that acts, the reason the writer
 * gave for not explaining it, or its sentence of what deep-review would do
 * about a fix. The writer's line of how it was checked and its kind come
 * only with an explanation, and its sentence for a question is not posted.
 */
function postsWriterFinding(finding: FindingView, cuts: ReadonlySet<BodyCut>): boolean {
  const { explained } = finding;
  if (!acts(finding)) return explained.kind === 'explained' && (!cuts.has('left') || keptByCut(finding));
  return explained.kind === 'explained'
    || (explained.kind === 'unexplained' && explained.reason !== null)
    || (finding.decision?.decision === 'fix' && finding.action !== null);
}

/**
 * Whether the body with the cuts given, or a comment, posts any text of
 * the writer (R12): the summary's sentence on the areas, the writer's
 * areas when a major finding acts, a refuted line the cuts keep, or a
 * finding's text (`postsWriterFinding`). A frozen answer can post none: a
 * writer that completed its unit has its answer frozen even when the
 * checks dropped every part, an answer of version 1 may keep only its
 * account, which the form does not post, and the parts it kept may be
 * ones the body leaves out.
 */
function postsWriterText(view: FormView, cuts: ReadonlySet<BodyCut>): boolean {
  return postedWhy(view) !== null
    || (view.areas !== null && view.areas.length > 0 && majorActing(view).length > 0)
    || (!cuts.has('refuted') && view.refuted.some((line) => line.claim !== null || line.why !== null))
    || view.findings.some((finding) => postsWriterFinding(finding, cuts));
}

/** How far to trust the review (R12): the counts of the verdicts and of how each finding was checked, what a model wrote when the review posts any text of its writer (`postsWriterText`), then the notes of the explanation: a run with no explanation, each part the checks dropped, and the findings whose answers the explanation predates. */
function trustSection(view: FormView, cuts: ReadonlySet<BodyCut>): Section {
  const { words, brief, recorded } = view;
  const numberOf = (id: string): number => brief.numbers.get(id)!;
  const notes: string[] = [];
  if (recorded === null) notes.push(words.noExplanation);
  else {
    if (recorded.dropped.some((part) => part.part === 'conclusion')) notes.push(words.conclusionDropped);
    if (recorded.dropped.some((part) => part.part === 'areas')) notes.push(words.areasDropped);
    if (recorded.dropped.some((part) => part.part === 'refuted')) notes.push(words.refutedDropped);
    const findings = recorded.dropped.flatMap((part) => (part.part === 'finding' ? [numberOf(part.finding)] : []));
    if (findings.length > 0) notes.push(words.findingsDropped(words.findingList(findings), findings.length));
    // An answer is recorded on a complete run, and the explanation before the report, so every standing answer of an explained run came after it.
    const answered = [...standingAnswers(view.review).keys()].map(numberOf);
    if (answered.length > 0) notes.push(words.predates(words.findingList(answered)));
  }
  // With no text of the writer posted, the review is in the engine's words alone, and the notes say so.
  const wrote = postsWriterText(view, cuts) ? [words.modelLine] : [];
  return { part: 'trust', lines: blocks([words.trustHeading], [[words.trust(view.counts), ...wrote].join(' ')], ...notes.map((note) => [note])) };
}

/** The last visible line, the engine, the runtime and its models, the run and the commits it reviewed, then the marker of the publication (R9, R13). The version the runtime gave and the models the settings name are no text of the engine's, so they are cleaned. */
function lastSection(view: FormView, say: Speaker): Section {
  const { configuration } = view.review;
  return {
    part: 'last line',
    lines: [
      view.words.lastLine({
        engine: inlineText(view.input.engine),
        runtime: configuration.runtime,
        version: say.words(configuration.version),
        strong: say.words(configuration.models.strong),
        fast: say.words(configuration.models.fast),
        run: codeSpan(shortRunId(view.state.id)),
        base: shortCommit(view.scope.base),
        head: shortCommit(view.scope.head),
      }),
      '',
      markerLine(publicationMarker(view.state.id, view.input.serial)),
    ],
  };
}

/** The body with the cuts given, in the order of R1, and the secrets its cleaning replaced. */
function renderBody(view: FormView, cuts: ReadonlySet<BodyCut>): { readonly sections: readonly Section[]; readonly text: string; readonly secrets: number } {
  const say = speakerOf(view.input.machine, view.words, view.names);
  const sections = [
    headingSection(view),
    summarySection(view, say),
    needsSection(view, say),
    howSection(view),
    areasSection(view, say, cuts),
    inFullSection(view, say),
    minorSection(view, say, cuts),
    leftSection(view, say, cuts),
    notExaminedSection(view, say, cuts),
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
 * How the writer explained a finding, from the recorded explanation and its
 * frozen answer. A finding the answer does not hold is one the writer was
 * not asked about, or whose explanation no answer passed, which the body
 * marks as given in deep-review's own words.
 */
function explainedOf(recorded: ExplanationRecorded | null, answer: WriterAnswer | null, id: string): Explained {
  if (recorded === null) return { kind: 'none' };
  if (recorded.dropped.some((part) => part.part === 'finding' && part.finding === id)) return { kind: 'unexplained', reason: null };
  const given = answer?.findings.find((finding) => finding.id === id);
  if (given === undefined) return { kind: 'unexplained', reason: null };
  return given.unexplained ? { kind: 'unexplained', reason: given.reason } : { kind: 'explained', value: given };
}

/** The counts of the run that the body states (R3, R12, TD3), from its state: the candidates through each step, and the verdicts and bases of the ranked findings. */
function reviewCountsOf(review: ReviewState): ReviewCounts {
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
function formViewOf(input: PullRequestFormInput): FormView {
  const { state } = input;
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null || scope.pullRequest === null) throw new Error(`Run ${state.id} reviewed no pull request`);
  const brief = briefOf(state);
  const words = pullRequestWords(reviewLanguage(review));
  const placements = new Map(input.places.map((placement) => [placement.finding, placement]));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const entries = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const recorded = state.explanation;
  const conclusion = input.answer?.conclusion ?? null;
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
      action: conclusion?.actions.find((action) => action.id === finding.id)?.sentence ?? null,
      checked: explained.kind === 'explained' ? explained.value.checked : null,
      kind: explained.kind === 'explained' ? explained.value.kind : null,
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
    following: followingOf(words, input.fixPass, scope.pullRequest.number),
    findings,
    areas: input.answer?.areas ?? null,
    refuted: refuted(review).map(({ candidate }) => {
      const line = input.answer?.refuted?.find((given) => given.id === candidate.id);
      return { candidate, claim: line?.claim ?? null, why: line?.why ?? null };
    }),
    counts: reviewCountsOf(review),
    conclusion: conclusion === null ? null : { why: conclusion.why },
    recorded,
    names: new Map<string, NamedId>([
      ...refuted(review).map(({ candidate }): [string, NamedId] => [candidate.id, { kind: 'refuted' }]),
      ...[...brief.numbers].map(([id, number]): [string, NamedId] => [id, { kind: 'finding', number }]),
    ]),
    input,
  };
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
