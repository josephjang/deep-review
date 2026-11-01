/**
 * The form of the pull request (R9, R10, R12, TD6 of the review on the
 * pull request): the body and the comments of the one review `publish`
 * posts, rendered from the brief value, the ranked findings with their
 * decisions, the place of each finding and the writer's explanation, and
 * nothing else. Pure: the caller reads GitHub, the evidence store and the
 * commits, and this module only renders.
 *
 * `placeFindings` puts each finding on its line or in the body
 * ("The place of a finding" of the design, TD4). `pullRequestForm`
 * renders the body in the order of R9, with the engine's own words from
 * the table of the run's language (pull-request-words.ts, R20), each text
 * of a worker through `publicWords` and each of the writer through
 * `publicProse` (R11), and a comment on its line for each fix and each
 * question that has one (R10). A body over the limit is cut in the order
 * of R12, and a body that still does not fit, or a comment that does not,
 * is a refusal with its size and parts, before anything is recorded.
 */
import { createHash } from 'node:crypto';
import { standingAnswers } from '../checkpoint/answer-state.ts';
import type { ExplanationRecorded, PullRequestFacts, RecordedDecision, ScopeState } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { repositoryLocation, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { NewLineKind, PullRequestFile } from '../github/pull-request.ts';
import { newLinesOf } from '../github/pull-request.ts';
import { briefOf, firstSentence, type Brief, type BriefDeparture, type BriefFinding, type BriefQuestion, type FindingStatus } from './brief.ts';
import { reviewLanguage, type Account, type ExplainedFinding, type RecordedAnswer as WriterAnswer } from './explanation.ts';
import { codeSpan, findingAnchor, inlineText, paragraphText, sentenceText, tableCell } from './markdown.ts';
import { answerCommand } from './needs.ts';
import { fenceFor } from './prompts.ts';
import { publicProse, publicWords, type MachineContext } from './public-text.ts';
import { pullRequestWords, type PullRequestWords } from './pull-request-words.ts';
import { shortRunId } from './runs.ts';
import { rankedFindings, refuted, type ReportFinding } from './state.ts';
import type { FindingPlace, PlaceReason } from './vocabulary.ts';

/** The most characters of a body or a comment, a margin under the 65,536 people report GitHub takes (R12). */
export const maxPostedLength = 60_000;

/** The README of deep-review's repository, which the legend links (R9). */
export const readmeUrl = 'https://github.com/josephjang/deep-review#readme';

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
    if (decision !== 'fix' && decision !== 'ask') return { finding: finding.id, place: 'body', reason: 'left', location, diff };
    if (location === null || diff === null) return { finding: finding.id, place: 'body', reason: 'no-place', location: null, diff: null };
    if (diff === 'added' || diff === 'context') return { finding: finding.id, place: 'line', reason: 'on-the-diff', location, diff };
    return { finding: finding.id, place: 'body', reason: diff === 'no-patch' ? 'no-patch' : 'outside-the-diff', location, diff };
  });
}

/** The marker of a publication, which the body carries on its last line (TD5). */
export const publicationMarker = (run: string, serial: number): string => `deep-review publication ${run} ${String(serial)}`;

/** The marker of a finding's comment, which the comment carries on its last line, so a settle matches it to its finding. */
export const findingMarker = (run: string, finding: string): string => `deep-review finding ${run} ${finding}`;

const markerLine = (marker: string): string => `<!-- ${marker} -->`;

/** A commit as the form names it, by its first 8 characters, as the brief names a run. */
const shortCommit = (commit: string): string => commit.slice(0, 8);

/**
 * What a body over the limit is cut of, in this order (R12): the diagrams
 * of the writer's account of the pull request, then the account itself,
 * then the refuted candidates down to their summaries and places, then the
 * findings left as is down to their rows in the table. The evidence of a
 * fix or a question is never cut.
 */
export const bodyCuts = ['account-diagrams', 'account', 'refuted', 'left'] as const;
export type BodyCut = (typeof bodyCuts)[number];

/** What the form renders from beyond the fold, each read by the caller. */
export interface PullRequestFormInput {
  /** The run, folded: a read-only run of a pull request with its report. */
  readonly state: RunState;
  /** The writer's answer as the evidence store froze it (`recordedAnswerOf`), or null when the run recorded no explanation or no answer passed any part. */
  readonly answer: WriterAnswer | null;
  /** The place of each finding (`placeFindings`), against the files of the pull request as `publish` read them. */
  readonly places: readonly FindingPlacement[];
  /** The count of lines of a path at the head, or null when it holds no such file, so a link to the lines around a finding stays within its file. */
  readonly lineCount: (path: string) => number | null;
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

/** How a finding is explained: by the writer, not explained (marked by the writer with its reason, or dropped by the checks), or by no explanation the run recorded. */
type Explained =
  | { readonly kind: 'explained'; readonly value: ExplainedFinding }
  | { readonly kind: 'unexplained'; readonly reason: string | null }
  | { readonly kind: 'none' };

/** A ranked finding with all the form reads of it. */
interface FindingFacts {
  readonly finding: BriefFinding;
  readonly entry: ReportFinding;
  readonly decision: RecordedDecision | null;
  readonly placement: FindingPlacement;
  readonly explained: Explained;
  readonly question: BriefQuestion | null;
  readonly departure: BriefDeparture | null;
}

/** Whether a finding asks a person to act: a decided fix or a question, which goes on its line or in full in the body. */
const acts = (facts: FindingFacts): boolean => facts.decision?.decision === 'fix' || facts.decision?.decision === 'ask';

/** What every part of the form reads, computed once. */
interface FormContext {
  readonly state: RunState;
  readonly review: ReviewState;
  readonly scope: ScopeState;
  readonly pullRequest: PullRequestFacts;
  readonly brief: Brief;
  readonly words: PullRequestWords;
  readonly findings: readonly FindingFacts[];
  readonly answer: WriterAnswer | null;
  readonly recorded: ExplanationRecorded | null;
  readonly refuted: readonly { readonly candidate: CandidateState; readonly evidence: string }[];
  readonly input: PullRequestFormInput;
}

/**
 * The cleaning of each text the engine did not write, counting the
 * secrets it replaced (R11): a worker's words and the writer's prose, each
 * on one line, the writer's prose as paragraphs, a worker's text as a code
 * span, and a diagram, fenced before it is cleaned so the cleaning reads
 * it as code.
 */
interface Speaker {
  readonly words: (text: string) => string;
  readonly prose: (text: string) => string;
  readonly paragraphs: (text: string) => string[];
  readonly code: (text: string) => string;
  readonly diagram: (text: string) => string;
  readonly secrets: () => number;
}

function speakerOf(machine: MachineContext): Speaker {
  let secrets = 0;
  const counted = (cleaned: { readonly text: string; readonly secrets: number }): string => {
    secrets += cleaned.secrets;
    return cleaned.text;
  };
  const prose = (text: string): string => counted(publicProse(text, machine));
  return {
    words: (text) => inlineText(counted(publicWords(text, machine))).trim(),
    prose: (text) => inlineText(prose(text)).trim(),
    paragraphs: (text) => prose(text).split(/\r?\n[ \t]*\r?\n/).map(paragraphText).filter((paragraph) => paragraph.trim() !== ''),
    code: (text) => counted(publicWords(codeSpan(inlineText(text)), machine)),
    diagram: (text) => {
      const body = text.replace(/\s+$/, '');
      const fence = fenceFor(body);
      return counted(publicProse(`${fence}mermaid\n${body}\n${fence}`, machine));
    },
    secrets: () => secrets,
  };
}

/** A path from the root of the repository as a URL path, each name percent-encoded. */
const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The lines `from` to `to` of `path` at `commit`, as GitHub shows them in the repository of the pull request. */
function blobUrl(pullRequest: PullRequestFacts, commit: string, path: string, from: number, to: number): string {
  return `https://${pullRequest.host}/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repository)}/blob/${commit}/${urlPath(path)}#L${String(from)}${to === from ? '' : `-L${String(to)}`}`;
}

/** A line of the new side in the files of the pull request, the anchor GitHub gives it: the SHA-256 of the path and the line. */
const lineUrl = (pullRequest: PullRequestFacts, location: FindingLocation): string =>
  `${pullRequest.url}/files#diff-${createHash('sha256').update(location.path).digest('hex')}R${String(location.line)}`;

/** The lines of a finding at the head, two before its line and two after, within its file, which GitHub shows as code on a line of its own. */
function aroundUrl(context: FormContext, location: FindingLocation): string {
  const count = context.input.lineCount(location.path);
  const to = Math.max(location.line, count === null ? location.line + 2 : Math.min(count, location.line + 2));
  return blobUrl(context.pullRequest, context.scope.head, location.path, Math.max(1, location.line - 2), to);
}

/** Where a finding is read: its comment's line in the files of the pull request, or its block in the body. */
const hrefOf = (context: FormContext, facts: FindingFacts): string => (facts.placement.place === 'line' ? lineUrl(context.pullRequest, facts.placement.location) : `#${findingAnchor(facts.finding.number)}`);

/** A location as a link's text. */
const locationText = (location: FindingLocation): string => codeSpan(`${location.path}:${String(location.line)}`);

/** The marks after a finding's verdict: no verifier examined it. */
const verdictMarks = (context: FormContext, facts: FindingFacts): string[] => (facts.entry.resolution.unverified ? [context.words.unverifiedMark] : []);

/** The marks after a finding's status: the writer did not explain it. */
const statusMarks = (context: FormContext, facts: FindingFacts): string[] => (facts.explained.kind === 'unexplained' ? [context.words.unexplainedMark] : []);

/** The note on what the pull request does to a finding's line, or that it has no place; none for an added line. */
function diffNote(context: FormContext, placement: FindingPlacement): string | null {
  const { words } = context;
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

/** The first paragraph of a finding's block: what became of it, or the sentence `status` gives in its place, its severity and verdict with their marks, and the note on its line. */
function statusParagraph(context: FormContext, facts: FindingFacts, status: string | null = null): string {
  const note = diffNote(context, facts.placement);
  const { finding } = facts;
  return [status ?? context.words.statusSentences[finding.status], context.words.grade(finding.severity, finding.verdict, verdictMarks(context, facts)), ...(note === null ? [] : [note])].join(' ');
}

/** A finding's title: the writer's, or the first sentence of its summary. */
const titleOf = (facts: FindingFacts, say: Speaker): string => (facts.explained.kind === 'explained' ? say.prose(facts.explained.value.title) : say.words(firstSentence(facts.entry.finding.summary)));

/** The parts of a finding's block, which a comment and the body share, and whose sizes a refusal names. */
interface FindingParts {
  readonly explanation: string[];
  readonly decision: string[];
  readonly evidence: string[];
}

/** The lines a case cites, as a link at the commit of its side: the head, or the merge base for lines the change removed. */
function caseLink(context: FormContext, cited: ExplainedFinding['cases'][number]['lines']): string {
  const range = cited.from === cited.to ? String(cited.from) : `${String(cited.from)}-${String(cited.to)}`;
  const commit = cited.side === 'head' ? context.scope.head : context.scope.base;
  return `[${codeSpan(`${cited.path}:${range}`)}](${blobUrl(context.pullRequest, commit, cited.path, cited.from, cited.to)})`;
}

/** The writer's problem, cases and diagram of a finding, or, without them, the mark and the finder's own account in its place (R18, R19). */
function explanationLines(context: FormContext, facts: FindingFacts, say: Speaker): string[] {
  const { words } = context;
  const { explained } = facts;
  if (explained.kind !== 'explained') {
    const mark = explained.kind === 'unexplained' ? [words.unexplained(explained.reason === null ? null : say.prose(explained.reason)), ''] : [];
    return [...mark, paragraphText(say.words(facts.entry.primary.detail))];
  }
  const { value } = explained;
  return [
    ...say.paragraphs(value.problem).flatMap((paragraph) => [paragraph, '']),
    ...value.cases.map((cited) => `- ${sentenceText(say.prose(cited.sentence))} (${caseLink(context, cited.lines)})`),
    ...(value.diagram === null ? [] : ['', say.diagram(value.diagram)]),
  ];
}

/** The engine's words on a finding's decision, then the writer's, then who answers a question or a departure and how, each a paragraph (R9, R10, PD7). */
function decisionLines(context: FormContext, facts: FindingFacts, say: Speaker): string[] {
  const { words } = context;
  const { decision, finding } = facts;
  const sentence = (text: string): string => sentenceText(say.words(text));
  const engine: string[][] = [];
  let answer: string | null = null;
  if (decision?.decision === 'fix') {
    engine.push([[words.decidedFix(sentence(decision.fix.approach)), ...decision.fix.rejected.map((option) => words.rejected(say.words(option.option), say.words(option.reason).replace(/[.]+$/, '')))].join(' ')]);
    const departure = facts.departure;
    if (departure !== null) {
      engine.push([words.departure(say.words(departure.rule), say.words(departure.source), sentence(departure.fact))]);
      const given = departure.review;
      answer = given === null
        ? words.answerDeparture(codeSpan(departure.accept), codeSpan(departure.reject))
        : given.kind === 'reject' ? words.answeredReject(given.at) : words.answeredAccept(given.at);
    }
  }
  const question = facts.question;
  if (decision?.decision === 'ask' && question !== null) {
    engine.push([words.question(sentence(question.question))], [words.choice(question.choice, question.default)], question.options.map((option) => `- ${words.option(option.number, sentence(option.option), sentence(option.cost), sentence(option.rule))}`));
    const given = question.answer;
    answer = given !== null && given.option !== null
      ? words.answeredOption(given.option, given.at)
      : words.answerQuestion(codeSpan(answerCommand(context.state.id, finding.number, '--option <k>')));
  }
  const writer = facts.explained.kind === 'explained' ? say.paragraphs(facts.explained.value.decision).map((paragraph) => [paragraph]) : [];
  return [...engine, ...writer, ...(answer === null ? [] : [[answer]])].flatMap((paragraph, index) => [...(index === 0 ? [] : ['']), ...paragraph]);
}

/** The evidence of a finding, folded under a heading that says whether a verifier checked it (PD6): its summary, the reason, the evidence line, and how the verifier established it with each run it cites. */
function evidenceLines(context: FormContext, facts: FindingFacts, say: Speaker): string[] {
  return ['<details><summary>' + (facts.entry.resolution.unverified ? context.words.evidenceUnverified : context.words.evidenceVerified) + '</summary>', '', ...evidenceItems(context, facts.entry, say), '', '</details>'];
}

/** The items of a finding's evidence, which the fold of a finding left as is gives unfolded. */
function evidenceItems(context: FormContext, entry: ReportFinding, say: Speaker): string[] {
  const { words } = context;
  const { resolution } = entry;
  const runs = resolution.basis === null ? [] : [[words.basis(words.basisWords[resolution.basis]), ...resolution.runs.map((run) => words.citedRun(say.code(run.command), run.printed.map((line) => `"${say.words(line)}"`).join(' / '), words.exitCode(run.exitCode)))].join(' ')];
  return [
    `- ${words.summaryLabel}: ${say.words(entry.finding.summary)}`,
    `- ${words.reasonLabel}: ${say.words(entry.finding.reason)}`,
    `- ${words.evidenceLabel}: ${resolution.evidence === null ? words.noEvidence : say.words(resolution.evidence)}`,
    ...runs.map((line) => `- ${line}`),
  ];
}

/** The parts of the block of a finding that asks a person to act, in a comment or in full in the body (R10). */
function findingParts(context: FormContext, facts: FindingFacts, say: Speaker): FindingParts {
  return {
    explanation: [statusParagraph(context, facts), '', ...explanationLines(context, facts, say)],
    decision: decisionLines(context, facts, say),
    evidence: evidenceLines(context, facts, say),
  };
}

const joinedParts = (parts: FindingParts): string[] => [...parts.explanation, '', ...parts.decision, '', ...parts.evidence];

/** The comment of a finding on its line, with its marker as its last line, or the refusal of one over the limit. */
function commentOf(context: FormContext, facts: FindingFacts & { readonly placement: Extract<FindingPlacement, { place: 'line' }> }): { readonly comment: FormComment; readonly secrets: number } | FormRefusal {
  const say = speakerOf(context.input.machine);
  const heading = `**${String(facts.finding.number)}. ${titleOf(facts, say)}**`;
  const parts = findingParts(context, facts, say);
  const body = [heading, '', ...joinedParts(parts), '', markerLine(findingMarker(context.state.id, facts.finding.id))].join('\n');
  const { location } = facts.placement;
  if (body.length > maxPostedLength) {
    const size = (lines: readonly string[]): number => lines.join('\n').length;
    return {
      kind: 'refused',
      text: { kind: 'comment', finding: facts.finding.id, path: location.path, line: location.line },
      size: body.length,
      limit: maxPostedLength,
      parts: [{ part: 'explanation', size: size([heading, ...parts.explanation]) }, { part: 'decision', size: size(parts.decision) }, { part: 'evidence', size: size(parts.evidence) }],
    };
  }
  return { comment: { finding: facts.finding.id, path: location.path, line: location.line, body }, secrets: say.secrets() };
}

/** The heading of a finding's block in the body, with its anchor, and the lines around it on a line of its own when it has a place. */
function bodyBlockHead(context: FormContext, facts: FindingFacts, say: Speaker): string[] {
  const { location } = facts.placement;
  return [`<a id="${findingAnchor(facts.finding.number)}"></a>`, '', `#### ${String(facts.finding.number)}. ${titleOf(facts, say)}`, '', ...(location === null ? [] : [aroundUrl(context, location), ''])];
}

/** One section of the body, by the name a refusal gives its size with. */
interface Section {
  readonly part: string;
  readonly lines: readonly string[];
}

/** The engine's line of what the pull request needs, then the writer's conclusion: its why, the actions the engine lists in rank order, each with its number, severity and verdict, and its diagram (R9, R18, PD13). */
function conclusionSection(context: FormContext, say: Speaker): Section {
  const { words, brief } = context;
  const fixes = brief.findings.filter((finding) => finding.status === 'planned' || finding.status === 'planned-against-rule').length;
  const questions = brief.findings.filter((finding) => finding.status === 'question').length;
  const conclusion = context.answer?.conclusion ?? null;
  const actions = context.findings.filter(acts).map((facts) => {
    const given = conclusion?.actions.find((action) => action.id === facts.finding.id);
    const sentence = given === undefined ? fallbackAction(context, facts, say) : sentenceText(say.prose(given.sentence));
    const grade = [facts.finding.severity, facts.finding.verdict, ...verdictMarks(context, facts), ...statusMarks(context, facts)].join(', ');
    return `- [${words.findingName(facts.finding.number)}](${hrefOf(context, facts)}), ${grade}: ${sentence}`;
  });
  return {
    part: 'conclusion',
    lines: [
      words.needsLine(fixes, questions),
      ...(conclusion === null ? [] : say.paragraphs(conclusion.why).flatMap((paragraph) => ['', paragraph])),
      ...(actions.length === 0 ? [] : ['', ...actions]),
      ...(conclusion?.diagram === null || conclusion === null ? [] : ['', say.diagram(conclusion.diagram)]),
    ],
  };
}

/** An action in the engine's own words, for a finding the writer's conclusion gives no sentence for. */
function fallbackAction(context: FormContext, facts: FindingFacts, say: Speaker): string {
  const { words } = context;
  const { decision } = facts;
  if (decision?.decision === 'ask') return words.actionAsk(sentenceText(say.words(decision.ask.question)));
  if (decision?.decision === 'fix') return (decision.departure === null ? words.actionFix : words.actionDeparture)(sentenceText(say.words(decision.fix.approach)));
  return '';
}

/** A judgment of the triage's: what, and the files that show it. */
const judgedDetail = (condition: { readonly what: string | null; readonly files: readonly string[] }, say: Speaker): string =>
  `${condition.what === null ? '' : `: ${say.words(condition.what).replace(/[.]+$/, '')}`}${condition.files.length === 0 ? '' : ` (${condition.files.map((file) => say.code(file)).join(', ')})`}`;

/** "What this pull request does": the title and the core of the change as the brief gives them, and the writer's account folded under them, less what a cut takes (R9, R12, R18, PD13). */
function changeSection(context: FormContext, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words, brief } = context;
  const { change } = brief;
  const core = change.state !== 'given' ? [words.missingAccount[change.state]] : [
    paragraphText(say.words(change.what)),
    '',
    paragraphText(change.why === null ? words.noWhy : words.why(say.words(change.why))),
    '',
    [
      ...(change.publicInterface.holds ? [words.publicInterface(judgedDetail(change.publicInterface, say))] : []),
      ...(change.wideEffect.holds ? [words.wideEffect(judgedDetail(change.wideEffect, say))] : []),
      ...(!change.publicInterface.holds && !change.wideEffect.holds ? [words.noJudgment] : []),
      words.accountWhose,
    ].join(' '),
  ];
  const account = context.answer?.account ?? null;
  // The brief titles a change the triage gave no account of in English, so the form titles it from the table.
  const title = change.state === 'given' ? say.words(brief.title) : words.changeTitle(codeSpan(shortCommit(context.scope.base)), codeSpan(shortCommit(context.scope.head)));
  return { part: 'change', lines: [words.changeHeading, '', `**${title}**`, '', ...core, ...accountLines(context, account, say, cuts)] };
}

/** The writer's account, folded, with the note of a cut that took its diagrams or the account itself; none when the run has no account. */
function accountLines(context: FormContext, account: Account | null, say: Speaker, cuts: ReadonlySet<BodyCut>): string[] {
  const { words } = context;
  if (account === null) return [];
  if (cuts.has('account')) return ['', words.accountCut];
  const diagrams = !cuts.has('account-diagrams');
  const told = (heading: string, part: Account['problem']): string[] => [
    '',
    `**${heading}**`,
    ...say.paragraphs(part.text).flatMap((paragraph) => ['', paragraph]),
    ...(part.diagram === null || !diagrams ? [] : ['', say.diagram(part.diagram)]),
  ];
  const cut = !diagrams && (account.problem.diagram !== null || account.change.diagram !== null);
  return [
    '',
    `<details><summary>${words.accountSummary}</summary>`,
    ...(account.terms.length === 0 ? [] : ['', `**${words.termsHeading}**`, '', ...account.terms.map((term) => `- ${say.prose(term.term)}: ${say.prose(term.meaning)}`)]),
    ...told(words.problemHeading, account.problem),
    ...told(words.changeTextHeading, account.change),
    '',
    '</details>',
    ...(cut ? ['', words.accountDiagramsCut] : []),
  ];
}

/** The line that says deep-review reviewed the pull request at its head, with the counts of its findings (R9). */
function statusSection(context: FormContext): Section {
  return { part: 'status', lines: [context.words.statusLine(codeSpan(shortCommit(context.scope.head)), context.brief.status)] };
}

/**
 * "What to know before the merge": that no check ran, each gap of the
 * brief as its English text (R20), or that the run examined everything;
 * then the notes of the explanation, each part the checks dropped, a run
 * with no explanation, and the findings whose answers the explanation
 * predates (R18).
 */
function gapsSection(context: FormContext): Section {
  const { words, brief, recorded } = context;
  const gaps = brief.notExamined;
  const numberOf = (id: string): number => brief.numbers.get(id)!;
  const notes: string[] = [];
  if (recorded === null) notes.push(words.noExplanation);
  else {
    const dropped = recorded.dropped;
    if (dropped.some((part) => part.part === 'conclusion')) notes.push(words.conclusionDropped);
    if (dropped.some((part) => part.part === 'account')) notes.push(words.accountDropped);
    const findings = dropped.flatMap((part) => (part.part === 'finding' ? [numberOf(part.finding)] : []));
    if (findings.length > 0) notes.push(words.findingsDropped(words.findingList(findings), findings.length));
    // An answer is recorded on a complete run, and the explanation before the report, so every standing answer of an explained run came after it.
    const answered = [...standingAnswers(context.review).keys()].map(numberOf);
    if (answered.length > 0) notes.push(words.predates(words.findingList(answered)));
  }
  return {
    part: 'before the merge',
    lines: [
      words.gapsHeading,
      '',
      gaps.length === 0 ? `${words.noCheck} ${words.allExamined}` : words.noCheck,
      ...(gaps.length === 0 ? [] : ['', words.gapsLead, '', ...gaps.map((gap) => `- ${gap.text}`)]),
      ...notes.flatMap((note) => ['', note]),
    ],
  };
}

/** The table of the findings: each with its number linked to where it is read, unless a cut left its block out, severity, verdict, status, summary and place (R9). */
function tableSection(context: FormContext, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = context;
  if (context.findings.length === 0) return { part: 'table', lines: [words.tableHeading, '', words.noFindings] };
  const rows = context.findings.map((facts) => {
    const { finding, placement } = facts;
    const { location } = placement;
    const place = location === null ? words.noPlace : `[${locationText(location)}](${placement.place === 'line' ? lineUrl(context.pullRequest, location) : aroundUrl(context, location)})`;
    const cells = [
      cuts.has('left') && !acts(facts) ? String(finding.number) : `[${String(finding.number)}](${hrefOf(context, facts)})`,
      finding.severity,
      [finding.verdict, ...verdictMarks(context, facts)].join(', '),
      [words.statuses[finding.status], ...statusMarks(context, facts)].join(', '),
      say.words(finding.summary),
      place,
    ];
    return `| ${cells.map(tableCell).join(' | ')} |`;
  });
  return { part: 'table', lines: [words.tableHeading, '', `| ${words.columns.join(' | ')} |`, `|${words.columns.map(() => '---').join('|')}|`, ...rows] };
}

/** Each fix and question with no line in the diff, in full, in the form of its comment (R9, R10). */
function inFullSection(context: FormContext, say: Speaker): Section {
  const blocks = context.findings.filter((facts) => acts(facts) && facts.placement.place === 'body');
  if (blocks.length === 0) return { part: 'findings in full', lines: [] };
  return { part: 'findings in full', lines: [context.words.inFullHeading, ...blocks.flatMap((facts) => ['', ...bodyBlockHead(context, facts, say), ...joinedParts(findingParts(context, facts, say))])] };
}

/** The findings left as is, folded, each with why and its evidence; or, cut, the note that the table holds their rows (R9, R12). */
function leftSection(context: FormContext, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words, brief } = context;
  const left = context.findings.filter((facts) => !acts(facts));
  if (left.length === 0) return { part: 'left as is', lines: [] };
  if (cuts.has('left')) return { part: 'left as is', lines: [words.leftCut] };
  const block = (facts: FindingFacts): string[] => {
    const leave = facts.decision?.decision === 'leave' ? facts.decision : null;
    const by = leave?.leave.supersededBy ?? null;
    const why = leave === null ? null : words.leftBecause(words.leaveReasons[leave.leave.reason], by === null ? null : words.findingName(brief.numbers.get(by)!));
    return [
      ...bodyBlockHead(context, facts, say),
      statusParagraph(context, facts, why),
      '',
      ...(leave === null ? [] : [`- ${words.groundsLabel}: ${say.words(leave.grounds)}`]),
      ...evidenceItems(context, facts.entry, say),
    ];
  };
  return { part: 'left as is', lines: [`<details><summary>${words.leftHeading(left.length)}</summary>`, ...left.flatMap((facts) => ['', ...block(facts)]), '', '</details>'] };
}

/** The candidates verification refuted, folded, each with its place, summary and the evidence that refuted it; or, cut, without the evidence (R9, R12, PD14). */
function refutedSection(context: FormContext, say: Speaker, cuts: ReadonlySet<BodyCut>): Section {
  const { words } = context;
  if (context.refuted.length === 0) return { part: 'refuted', lines: [] };
  const cut = cuts.has('refuted');
  const entries = context.refuted.flatMap(({ candidate, evidence }) => {
    const location = repositoryLocation(candidate) === null ? null : { path: candidate.file!, line: candidate.line! };
    const place = location === null ? words.noPlace : `[${locationText(location)}](${aroundUrl(context, location)})`;
    const lead = `- ${candidate.id} (${candidate.angle}), ${place}: ${say.words(candidate.summary)}`;
    if (cut) return [lead];
    const runs = candidate.verdict?.basis === null || candidate.verdict === null
      ? []
      : [[words.basis(words.basisWords[candidate.verdict.basis]), ...candidate.verdict.runs.map((run) => words.citedRun(say.code(run.command), run.printed.map((line) => `"${say.words(line)}"`).join(' / '), words.exitCode(run.exitCode)))].join(' ')];
    return [lead, `  - ${words.evidenceLabel}: ${say.words(evidence)}`, ...runs.map((line) => `  - ${line}`)];
  });
  return { part: 'refuted', lines: [`<details><summary>${words.refutedHeading(context.refuted.length)}</summary>`, '', cut ? words.refutedCut : words.refutedLead, '', ...entries, '', '</details>'] };
}

/** The patterns of `scope.exclude` that left paths out of the run, with the count of those paths and the layer that set them, as the run recorded them (R12). */
function excludedSection(context: FormContext): Section {
  const { words, scope } = context;
  if (scope.excluded.count === 0) return { part: 'excluded', lines: [] };
  const layer = context.review.configuration.settings?.layers['scope.exclude'] ?? null;
  return { part: 'excluded', lines: [words.excludedHeading, '', words.excluded(scope.request.exclude.map(codeSpan).join(', '), scope.excluded.count, layer === null ? null : words.layers[layer])] };
}

/** The legend, folded: each verdict and severity, each status the findings have, the two marks, and the line on what a model wrote, with the README (R9, R20). */
function legendSection(context: FormContext): Section {
  const { words } = context;
  const statuses = [...new Set(context.findings.map((facts) => facts.finding.status))] as FindingStatus[];
  return {
    part: 'legend',
    lines: [
      `<details><summary>${words.legendHeading}</summary>`,
      '',
      ...(Object.entries(words.verdicts) as [string, string][]).map(([verdict, meaning]) => `- ${verdict}: ${meaning}`),
      ...(Object.entries(words.severities) as [string, string][]).map(([severity, meaning]) => `- ${severity}: ${meaning}`),
      ...statuses.map((status) => `- ${words.statuses[status]}: ${words.statusLegend[status]}`),
      `- ${words.unverifiedMark}: ${words.unverifiedLegend}`,
      `- ${words.unexplainedMark}: ${words.unexplainedLegend}`,
      '',
      words.modelLine(readmeUrl),
      '',
      '</details>',
    ],
  };
}

/** The last visible line, the engine, the runtime and its models, the run and the commits it reviewed, then the marker of the publication (R9, R13). */
function lastSection(context: FormContext): Section {
  const { configuration } = context.review;
  return {
    part: 'last line',
    lines: [
      context.words.lastLine({
        engine: inlineText(context.input.engine),
        runtime: configuration.runtime,
        version: inlineText(configuration.version),
        strong: inlineText(configuration.models.strong),
        fast: inlineText(configuration.models.fast),
        run: codeSpan(shortRunId(context.state.id)),
        base: shortCommit(context.scope.base),
        head: shortCommit(context.scope.head),
      }),
      '',
      markerLine(publicationMarker(context.state.id, context.input.serial)),
    ],
  };
}

/** The body with the cuts given, in the order of R9, and the secrets its cleaning replaced. */
function renderBody(context: FormContext, cuts: ReadonlySet<BodyCut>): { readonly sections: readonly Section[]; readonly text: string; readonly secrets: number } {
  const say = speakerOf(context.input.machine);
  const sections = [
    { part: 'heading', lines: [context.words.heading(codeSpan(shortRunId(context.state.id)), codeSpan(shortCommit(context.scope.head)))] },
    conclusionSection(context, say),
    changeSection(context, say, cuts),
    statusSection(context),
    gapsSection(context),
    tableSection(context, say, cuts),
    inFullSection(context, say),
    leftSection(context, say, cuts),
    refutedSection(context, say, cuts),
    excludedSection(context),
    legendSection(context),
    lastSection(context),
  ].filter((section) => section.lines.length > 0);
  return { sections, text: sections.map((section) => section.lines.join('\n')).join('\n\n'), secrets: say.secrets() };
}

/** Whether a cut takes anything from this run's body, so a cut that changes nothing is neither made nor named. */
function cutApplies(context: FormContext, cut: BodyCut): boolean {
  const account = context.answer?.account ?? null;
  switch (cut) {
    case 'account-diagrams':
      return account !== null && (account.problem.diagram !== null || account.change.diagram !== null);
    case 'account':
      return account !== null;
    case 'refuted':
      return context.refuted.length > 0;
    case 'left':
      return context.findings.some((facts) => !acts(facts));
  }
}

/** How the writer explained a finding, from the recorded explanation and its frozen answer. */
function explainedOf(recorded: ExplanationRecorded | null, answer: WriterAnswer | null, id: string): Explained {
  if (recorded === null) return { kind: 'none' };
  if (recorded.dropped.some((part) => part.part === 'finding' && part.finding === id)) return { kind: 'unexplained', reason: null };
  const given = answer?.findings.find((finding) => finding.id === id);
  if (given === undefined) return { kind: 'none' };
  return given.unexplained ? { kind: 'unexplained', reason: given.reason } : { kind: 'explained', value: given };
}

/**
 * The review of a read-only run of a pull request, as `publish` posts it
 * (R9, R10, R12): the body, cut as R12 orders when it does not fit, with
 * the marker of the publication as its last line; a comment on its line
 * for each fix and each question that has one, with the marker of its
 * finding as its last line; the place of each finding as the ledger
 * records it; the count of the secrets the cleaning replaced in what is
 * posted; and the cuts made. A comment over the limit, or a body over it
 * after every cut, is refused with its size and parts.
 */
export function pullRequestForm(input: PullRequestFormInput): PullRequestForm | FormRefusal {
  const { state } = input;
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null || scope.pullRequest === null) throw new Error(`Run ${state.id} reviewed no pull request`);
  const brief = briefOf(state);
  const placements = new Map(input.places.map((placement) => [placement.finding, placement]));
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const entries = new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
  const recorded = state.explanation;
  const findings = brief.findings.map((finding): FindingFacts => {
    const placement = placements.get(finding.id);
    if (placement === undefined) throw new Error(`Finding ${finding.id} of run ${state.id} has no place`);
    return {
      finding,
      entry: entries.get(finding.id)!,
      decision: decided.get(finding.id) ?? null,
      placement,
      explained: explainedOf(recorded, input.answer, finding.id),
      question: brief.questions.find((question) => question.id === finding.id) ?? null,
      departure: brief.departures.find((departure) => departure.id === finding.id) ?? null,
    };
  });
  const context: FormContext = { state, review, scope, pullRequest: scope.pullRequest, brief, words: pullRequestWords(reviewLanguage(review)), findings, answer: input.answer, recorded, refuted: refuted(review), input };
  const comments: FormComment[] = [];
  let secrets = 0;
  for (const facts of findings) {
    if (facts.placement.place !== 'line') continue;
    const rendered = commentOf(context, { ...facts, placement: facts.placement });
    if ('kind' in rendered) return rendered;
    comments.push(rendered.comment);
    secrets += rendered.secrets;
  }
  const applicable = bodyCuts.filter((cut) => cutApplies(context, cut));
  let body = renderBody(context, new Set());
  let made = 0;
  while (body.text.length > maxPostedLength && made < applicable.length) {
    made += 1;
    body = renderBody(context, new Set(applicable.slice(0, made)));
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
