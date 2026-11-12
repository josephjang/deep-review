/**
 * The writer's task (R18, R20, TD8 of the review on the pull request;
 * R4, R10, R11, R13, TD2 of the review that reads as a report; R2, R3,
 * R8, PD4, TD7 of the core of the change on the pull request): what a
 * writer is given to explain the review, at the version of the run's
 * answer, and, after a refused answer, what still fails.
 */
import type { CandidateChoice, RecordedDecision } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { changeReadingOf, explanationVersionOf, type CandidateState, type ExplanationVersion, type ReviewState } from '../checkpoint/review-fold.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { briefMarkdown, briefOf } from './brief.ts';
import { heldConditions, type ReportCheckInput } from './explanation-checks.ts';
import { checkedAnswers, findingsToExplain, isMajor, mergeAnswers, partNameOf, reportCheckInputOf, requireReview, reviewLanguage } from './explanation.ts';
import { counted, inlineText } from './markdown.ts';
import { fenceFor } from './prompts.ts';
import { publicCode, publicWords, type MachineContext } from './public-text.ts';
import { findingNumbers, rankedFindings, refuted, resolutionOf, shownChoiceLines, type ReportFinding } from './state.ts';
import { commitMessagesSection, describeLocation, type ChangeMessages } from './tasks.ts';
import { verdictBasisWords, type ChangeConditionName } from './vocabulary.ts';

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
