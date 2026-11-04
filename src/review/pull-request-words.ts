/**
 * The engine's own words in a review on the pull request (R20 of the
 * review on the pull request, R15 of the review that reads as a report):
 * the headings and labels, the summary and its counts, what needs a
 * person, how the review worked and its diagram, the lines of a finding's
 * block, who answers a question or a departure and how, how far to trust
 * the review, and the notes of a cut or of a fallback, one table for each
 * language this change writes. A language with no table takes English.
 * Every table is a `PullRequestWords`, so a table that lacks a key does
 * not compile. Verdicts, severities, identifiers, paths and commands are
 * given to these words as they are and never translated; the words of the
 * workers and the gaps of the brief, which the brief holds as English
 * text, are not here.
 */
import type { FindingStatus } from './brief.ts';
import type { Layer } from '../config/settings.ts';
import { capitalized, counted, findingWords, listed } from './markdown.ts';
import type { LeaveReason, Severity, Verdict, VerdictBasis } from './vocabulary.ts';

/** What the last visible line of the body names: the engine, the runtime and its models, the run, and the commits it reviewed. */
export interface LastLineFacts {
  readonly engine: string;
  readonly runtime: string;
  readonly version: string;
  readonly strong: string;
  readonly fast: string;
  readonly run: string;
  readonly base: string;
  readonly head: string;
}

/**
 * The counts of a run that the body states (R3, R12 of the review that
 * reads as a report), each from the run's state: the candidates recorded,
 * the groups deduplication left, the candidates the verifiers refuted and
 * kept, the members merged into another finding and the findings ranked;
 * over the findings, the major ones (critical counted with them, and
 * apart), the minor ones, the verdicts, the major ones CONFIRMED and of
 * those the ones reproduced by running them, and how each was checked.
 */
export interface ReviewCounts {
  readonly candidates: number;
  readonly groups: number;
  readonly refuted: number;
  readonly kept: number;
  readonly merged: number;
  readonly findings: number;
  readonly major: number;
  readonly critical: number;
  readonly minor: number;
  readonly confirmed: number;
  readonly plausible: number;
  readonly unverified: number;
  readonly majorConfirmed: number;
  readonly majorConfirmedRan: number;
  readonly bases: Readonly<Record<VerdictBasis, number>>;
  /** The findings whose verdict gives no basis: unverified, or of a run configured before runs on the record. */
  readonly noBasis: number;
}

/** The findings by what deep-review decided, as the summary counts them. */
export interface DecisionCounts {
  readonly fixes: number;
  readonly questions: number;
  readonly left: number;
}

/** Why a verdict is PLAUSIBLE and not CONFIRMED, as its verifier gave it (R7): a fact it could not settle, or a choice that remains; its text already cleaned. */
export interface UnconfirmedWords {
  readonly kind: 'fact' | 'choice';
  readonly text: string;
}

/** The counts of the minor findings that the section on them states (R13): all of them, the ones that reach what a user sees, the others, and the ones in a comment on their line. */
export interface MinorCounts {
  readonly total: number;
  readonly user: number;
  readonly code: number;
  readonly onLine: number;
}

/** Each text of the form that the engine writes, in one language. A function takes what the sentence names, already cleaned and formatted. */
export interface PullRequestWords {
  /** The heading of the body, and the line on what the run reviewed: the head and the merge base, each a code span, and the count of files. */
  readonly heading: string;
  readonly reviewed: (head: string, files: number, base: string) => string;
  /** A finding by its number, as a sentence names it. */
  readonly findingList: (numbers: readonly number[]) => string;

  /** The summary: the counts of the findings, then, after the writer's sentence on the areas, what deep-review decided and what happens next with the command that fixes. */
  readonly summaryHeading: string;
  readonly summaryCounts: (counts: ReviewCounts) => string;
  readonly summaryNext: (counts: DecisionCounts, fix: string) => string;

  /** What needs a person (R2): a question with its tail, a fix against a written rule with its tail, a finding left as is whose verifier leaves a choice to the author, the one command that answers, or that nothing does. */
  readonly needsHeading: string;
  readonly needsQuestion: (finding: number, href: string, question: string, tail: string) => string;
  readonly needsDeparture: (finding: number, href: string, rule: string, tail: string) => string;
  readonly departureStands: string;
  readonly needsAuthor: (finding: number, href: string, choice: string) => string;
  readonly needsAnswer: (command: string, flags: readonly string[]) => string;
  readonly needsNothing: string;

  /** How the review worked (R3): the roles and the counts, the fixed diagram for the pull request's number, and what each verdict, the unverified mark and the severities mean. */
  readonly howHeading: string;
  readonly howWorked: (counts: ReviewCounts) => string;
  readonly howDiagram: (pullRequest: number) => string;
  readonly verdictMeanings: string;
  readonly unverifiedMeaning: string;
  readonly severityMeanings: string;

  /** The major findings by area (R4): the area of an older run, the line when no major finding acts, what deep-review would do, what a question recommends, and the mark of a fix against a written rule. */
  readonly areasHeading: string;
  readonly findingsArea: string;
  readonly noMajor: string;
  readonly wouldDo: (sentence: string) => string;
  readonly recommends: (option: number, text: string) => string;
  readonly againstRule: string;

  /** The block of a finding, in its comment or in full in the body (R5). */
  readonly inFullHeading: (finding: number, title: string) => string;
  readonly grade: (severity: Severity, verdict: Verdict, basis: string | null, marks: readonly string[]) => string;
  readonly basisWords: Readonly<Record<VerdictBasis, string>>;
  readonly unverifiedMark: string;
  readonly statusSentences: Readonly<Record<FindingStatus, string>>;
  readonly lineNotChanged: string;
  readonly fileNotChanged: string;
  readonly noPatch: string;
  readonly noPlaceNote: string;
  readonly unexplained: (reason: string | null) => string;
  readonly problemLabel: string;
  readonly whyPlausible: (unconfirmed: UnconfirmedWords | null) => string;
  readonly whyUnverified: string;
  readonly wouldDoLabel: string;
  readonly asDecided: string;
  readonly rejected: (option: string, reason: string) => string;
  readonly departure: (rule: string, source: string, fact: string, accept: string, reject: string, fix: string) => string;
  readonly answeredAccept: (at: string) => string;
  readonly answeredReject: (at: string) => string;
  readonly whyAsked: string;
  readonly question: (question: string) => string;
  readonly option: (number: number, option: string, cost: string) => string;
  readonly standing: (recommended: number, applied: number, edits: boolean, option: string | null) => string;
  readonly answerQuestion: (command: string, fix: string) => string;
  readonly answeredOption: (option: number, at: string) => string;
  readonly whyLeft: string;
  readonly whyLook: string;
  readonly authorChoice: (choice: string) => string;
  readonly howChecked: string;
  readonly basisSentences: Readonly<Record<VerdictBasis, string>>;
  readonly noBasis: string;
  readonly notVerified: string;
  readonly codeHeading: string;
  readonly atBase: (link: string) => string;
  readonly trace: (id: string, run: string) => string;
  /** The line in place of a diagram that passed the checks and that its cleaning broke (R11, R19 of the review on the pull request). */
  readonly diagramBroken: string;

  /** The minor findings, their table folded (R13). */
  readonly minorHeading: string;
  readonly minorLead: (counts: MinorCounts) => string;
  readonly minorNeeds: (findings: string, count: number) => string;
  readonly minorSummary: (count: number) => string;
  readonly minorOrder: (user: number) => string;
  readonly minorColumns: readonly [number: string, finding: string, verdict: string, action: string];
  readonly minorCut: string;

  /** The other findings left as is, folded. */
  readonly leftHeading: string;
  readonly leftSummary: (count: number) => string;
  readonly leaveReasons: Readonly<Record<LeaveReason, string>>;
  readonly leftBecause: (reason: string, by: string | null) => string;
  readonly groundsLabel: string;
  readonly leftCut: (count: number) => string;

  /** What the review did not examine (R11): no check, each gap, the patterns that left paths out, and the refuted candidates folded. */
  readonly notExaminedHeading: string;
  readonly noCheck: string;
  readonly allExamined: string;
  readonly gap: (text: string) => string;
  readonly excluded: (patterns: readonly string[], count: number, layer: string | null) => string;
  readonly layers: Readonly<Record<Layer, string>>;
  readonly refutedLine: (count: number) => string;
  readonly refutedSummary: (count: number) => string;
  readonly refutedItem: (claim: string, why: string) => string;
  readonly refutedInReport: string;
  readonly refutedCut: (count: number) => string;
  readonly noPlace: string;

  /** How far to trust the review (R12), and the notes of the explanation. */
  readonly trustHeading: string;
  readonly trust: (counts: ReviewCounts) => string;
  readonly modelLine: string;
  readonly conclusionDropped: string;
  readonly findingsDropped: (findings: string, count: number) => string;
  readonly noExplanation: string;
  readonly predates: (findings: string) => string;
  readonly areaDiagramsCut: string;

  /** The last visible line. */
  readonly lastLine: (facts: LastLineFacts) => string;
}

/** Words in a list, the last two joined by `or`. */
const listedOr = (words: readonly string[]): string => (words.length <= 2 ? words.join(' or ') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)!}`);

/** How the findings were checked, in English: each basis with its count, then the findings with none. */
function basesEnglish(counts: ReviewCounts): string {
  const ways = ([['ran', 'by running code'], ['traced', 'by tracing it'], ['read', 'by reading it']] as const).filter(([basis]) => counts.bases[basis] > 0);
  const told = ways.map(([basis, how], index) => (index === 0 ? `${String(counts.bases[basis])} ${counts.bases[basis] === 1 ? 'was' : 'were'} checked ${how}` : `${String(counts.bases[basis])} ${how}`));
  const none = counts.noBasis === 0 ? [] : [`${String(counts.noBasis)} ${counts.noBasis === 1 ? 'has' : 'have'} no basis on record`];
  return told.length === 0 ? `no verdict records how it was checked` : `${listed(told)}${none.length === 0 ? '' : `, and ${none[0]!}`}`;
}

const english: PullRequestWords = {
  heading: '## deep-review\'s review of this pull request',
  reviewed: (head, files, base) => `deep-review reviewed this pull request at its head ${head}, ${files === 1 ? 'the 1 file' : `the ${String(files)} files`} changed from the merge base ${base}, and changed no file.`,
  findingList: (numbers) => findingWords(numbers),

  summaryHeading: '### Summary',
  summaryCounts: (counts) => {
    if (counts.findings === 0) return 'The review keeps no finding: the verifiers refuted every candidate, or the finders proposed none.';
    const critical = counts.critical === 0 ? '' : counts.major === 1 ? ', which is critical,' : `, ${String(counts.critical)} of them critical,`;
    const parts = [
      ...(counts.major === 0 ? [] : [`${counts.major === 1 ? 'the major one' : `the ${String(counts.major)} major ones`}${critical} ${counts.major === 1 ? 'is' : 'are'} what matters before the merge`]),
      ...(counts.minor === 0 ? [] : [counts.minor === 1 ? 'the minor one is smaller' : `the ${String(counts.minor)} minor ones are smaller`]),
    ];
    return `The review keeps ${counted(counts.findings, 'finding', 'findings')}. ${capitalized(parts.join('; '))}.`;
  },
  summaryNext: (counts, fix) => {
    const acting = [
      ...(counts.fixes === 0 ? [] : [`would fix ${counted(counts.fixes, 'finding', 'findings')}`]),
      ...(counts.questions === 0 ? [] : [`asks the author ${counted(counts.questions, 'question', 'questions')}`]),
    ];
    const left = counts.left === 0 ? '' : `${String(counts.left)} ${counts.left === 1 ? 'is' : 'are'} left as is`;
    if (acting.length === 0) return `deep-review leaves ${counted(counts.left, 'finding', 'findings')} as is, so nothing on this branch needs to change.`;
    return `deep-review ${acting.join(' and ')}${left === '' ? '' : `; ${left}`}. Nothing on this branch changes until the person who ran the review applies the fixes, and the answers given by then, with ${fix} in their clone and pushes them.`;
  },

  needsHeading: '### What needs a person',
  needsQuestion: (finding, href, question, tail) => `**[Question on finding ${String(finding)}](${href}).** ${question} ${tail}`,
  needsDeparture: (finding, href, rule, tail) => `**[Finding ${String(finding)}](${href}) is a fix against a written rule.** The rule: "${rule}" ${tail}`,
  departureStands: '`--fix` makes it as decided unless the person who ran the review rejects it first; a rejection after the fix sends that finding back to a fixer.',
  needsAuthor: (finding, href, choice) => `**[Finding ${String(finding)}](${href}) is left as is, but its verifier leaves a choice to the author.** ${choice}`,
  needsAnswer: (command, flags) => `The person who ran the review answers with ${command} and ${flags.length === 1 ? flags[0]! : `one of ${listedOr(flags)}`}. A reply on this pull request is not read yet.`,
  needsNothing: 'Nothing here needs a person: deep-review asks no question, and no fix goes against a written rule.',

  howHeading: '### How the review worked',
  howWorked: (counts) => `deep-review runs model sessions, called workers, each in one role. Finders propose candidate defects from several angles, a verifier checks each candidate by reading the code or running it, and a decider chooses to fix, to ask the author, or to leave as is. Here ${counted(counts.candidates, 'candidate', 'candidates')} became ${String(counts.groups)} after merging duplicates; the verifiers refuted ${String(counts.refuted)} and kept ${String(counts.kept)}, and ${counts.merged === 0 ? 'none' : String(counts.merged)} of those joined another finding, which leaves ${String(counts.findings)}.`,
  howDiagram: (pullRequest) => [
    'flowchart TD',
    `  subgraph RV["review --pr ${String(pullRequest)}, read-only: done"]`,
    '    F["Finders propose candidates"] --> V["A verifier runs or traces each one"]',
    '    V --> D["A decider chooses: fix, ask or leave"]',
    '    D --> W["The writer explains it in plain words"]',
    '  end',
    '  W --> P["publish cleans the text and posts this review"]',
    '  P --> A["The person who ran the review answers the questions"]',
    `  A --> X["review --pr ${String(pullRequest)} --fix: fixers apply and test each fix"]`,
  ].join('\n'),
  verdictMeanings: 'CONFIRMED means a verifier reproduced the problem by running it or traced the code path to the wrong result. PLAUSIBLE means the claim holds as far as it was checked but was not confirmed, either because a fact could not be settled or because a choice remains; each such finding says which, or that its verifier gave no reason.',
  unverifiedMeaning: 'A PLAUSIBLE finding marked unverified is one that no verifier examined, since its verifier failed twice.',
  severityMeanings: 'The severity is a worker\'s judgment: a critical or major finding is what matters before the merge, and a minor one is smaller, such as a wrong message or repeated code that the next change can let drift.',

  areasHeading: '### The major findings',
  findingsArea: 'The major findings that deep-review would fix or asks about',
  noMajor: 'No major finding asks for a fix or a question.',
  wouldDo: (sentence) => `Fix: ${sentence}`,
  recommends: (option, text) => `A question for the author; deep-review recommends option ${String(option)}: ${text}`,
  againstRule: 'Against a written rule.',

  inFullHeading: (finding, title) => `### Finding ${String(finding)}: ${title}`,
  grade: (severity, verdict, basis, marks) => `${capitalized(severity)}. ${[verdict, ...marks, ...(basis === null ? [] : [basis])].join(', ')}.`,
  basisWords: { ran: 'reproduced by running it', traced: 'traced through the code', read: 'read in the code' },
  unverifiedMark: 'unverified',
  statusSentences: {
    question: 'deep-review asks the author.',
    fixed: 'deep-review fixed this.',
    'fixed-against-rule': 'deep-review fixed this against a written rule.',
    'not-fixed': 'deep-review decided to fix this, and did not fix it.',
    left: 'Left as is.',
    planned: 'deep-review would fix this.',
    'planned-against-rule': 'deep-review would fix this against a written rule.',
  },
  lineNotChanged: 'This pull request does not change this line.',
  fileNotChanged: 'This pull request does not change this file.',
  noPatch: 'GitHub shows no diff of this file, so this finding has no comment on its line.',
  noPlaceNote: 'This finding names no place that the repository holds.',
  unexplained: (reason) => `deep-review's writer did not explain this finding, so it is given in deep-review's own words: look at it yourself.${reason === null ? '' : ` The writer's reason: ${reason}`}`,
  problemLabel: '**What goes wrong.**',
  whyPlausible: (unconfirmed) => {
    if (unconfirmed === null) return 'Why PLAUSIBLE: the verifier gave no reason.';
    return unconfirmed.kind === 'fact' ? `Why PLAUSIBLE: one fact is not settled: ${unconfirmed.text}` : `Why PLAUSIBLE: the defect is there, and a choice remains: ${unconfirmed.text}`;
  },
  whyUnverified: 'Why PLAUSIBLE: no verifier examined it, since its verifier failed twice.',
  wouldDoLabel: '**What deep-review would do.**',
  asDecided: 'The fix as decided',
  rejected: (option, reason) => `Rejected: ${option} ${reason}`,
  departure: (rule, source, fact, accept, reject, fix) => `**This fix goes against a written rule.** The rule: "${rule}" Its source: ${source} The fact against it: ${fact} The person who ran this review accepts the departure with ${accept} or rejects it with ${reject}, on the machine that holds the run; ${fix} makes the fix as decided unless it is rejected first.`,
  answeredAccept: (at) => `The person who ran this review accepted the departure, on ${at}.`,
  answeredReject: (at) => `The person who ran this review rejected the departure, so the fix follows the rule, on ${at}.`,
  whyAsked: '**Why it is a question.**',
  question: (question) => `**The question.** ${question}`,
  option: (number, option, cost) => `${String(number)}. **${option}** ${cost}`,
  standing: (recommended, applied, edits, option) => {
    const recommendation = option === null ? `deep-review recommends option ${String(recommended)}.` : `deep-review recommends option ${String(recommended)}: ${option}`;
    const result = edits ? '`--fix` applies it' : 'the code stays as it is';
    return recommended === applied
      ? `${recommendation} It also stands until someone answers: ${result}.`
      : `${recommendation} Until someone answers, option ${String(applied)} stands, the easiest to take back: ${result}.`;
  },
  answerQuestion: (command, fix) => `**How to answer.** The person who ran this review answers on the machine that holds the run, with ${command}, where \`<k>\` is the number of the option. ${fix} then applies the answer. A reply on this pull request is not read yet.`,
  answeredOption: (option, at) => `The person who ran this review answered it with option ${String(option)}, on ${at}.`,
  whyLeft: '**Why it is left as is.**',
  whyLook: '**Why a person should look anyway.**',
  authorChoice: (choice) => `Its verifier leaves a choice to the author: ${choice}`,
  howChecked: 'How the verifier checked it',
  basisSentences: {
    ran: 'The verifier ran code to check it; the report of the run holds what it ran and what it saw.',
    traced: 'The verifier traced the code to the result; the report of the run holds its evidence.',
    read: 'The verifier read the lines, which alone settle it; the report of the run holds its evidence.',
  },
  noBasis: 'The verifier\'s record gives no basis; the report of the run holds its evidence.',
  notVerified: 'No verifier examined it, since its verifier failed twice.',
  codeHeading: 'Code at the reviewed head:',
  atBase: (link) => `${link} (at the merge base)`,
  trace: (id, run) => `<sub>Finding ${id} of run ${run}.</sub>`,
  diagramBroken: 'A diagram is left out here, because cleaning it of secrets and of the places of the machine that ran this review broke it; the writer\'s answer on the machine that holds the run keeps it.',

  minorHeading: '### The minor findings',
  minorLead: (counts) => {
    const each = counts.total === 1 ? '' : 'each ';
    const where = counts.onLine === counts.total ? `, ${each}in a comment on its line` : counts.onLine === 0 ? `, ${each}in full above` : `: ${String(counts.onLine)} in a comment on its line and the rest in full above`;
    const kinds = counts.user === 0 ? '' : ` ${String(counts.user)} ${counts.user === 1 ? 'reaches' : 'reach'} what a user sees, and ${String(counts.code)} ${counts.code === 1 ? 'is' : 'are'} about the code.`;
    return `${capitalized(counted(counts.total, 'minor finding', 'minor findings'))}${where}.${kinds}`;
  },
  minorNeeds: (findings, count) => `${capitalized(findings)} among them ${count === 1 ? 'needs' : 'need'} a person, as "What needs a person" says.`,
  minorSummary: (count) => (count === 1 ? 'The minor finding' : `The ${String(count)} minor findings`),
  minorOrder: (user) => `The first ${user === 1 ? 'one reaches' : `${String(user)} reach`} what a user sees; the rest are about the code.`,
  minorColumns: ['#', 'Finding', 'Verdict', 'What deep-review would do'],
  minorCut: 'To fit the length GitHub takes, the table of the minor findings is left out; each has its comment on its line or its text above, and the report of the run holds them all.',

  leftHeading: '### The findings left as is',
  leftSummary: (count) => (count === 1 ? 'The finding left as is' : `The ${String(count)} findings left as is`),
  leaveReasons: {
    'outside-change-not-regression': 'outside the change, and not a regression',
    superseded: 'superseded',
    intended: 'intended, as the repository states',
  },
  leftBecause: (reason, by) => `deep-review leaves this as is: ${reason}${by === null ? '' : ` by ${by}`}.`,
  groundsLabel: 'Why:',
  leftCut: (count) => `To fit the length GitHub takes, ${count === 1 ? 'the finding left as is is' : `the ${String(count)} findings left as is are`} not listed here; the report of the run holds ${count === 1 ? 'it' : 'each'}.`,

  notExaminedHeading: '### What this review did not examine',
  noCheck: 'No check ran: this run only reviewed, so no test ran against the change.',
  allExamined: 'Every review pass ran, and a verifier examined each candidate.',
  gap: (text) => text,
  excluded: (patterns, count, layer) => `${capitalized(counted(count, 'changed path', 'changed paths'))} under ${listed(patterns)} ${count === 1 ? 'was' : 'were'} left out${layer === null ? '' : `, as ${layer} sets \`scope.exclude\``}, and no worker read ${count === 1 ? 'it' : 'them'}.`,
  layers: { default: 'the default', operator: 'the operator\'s file', repository: 'the repository\'s file', clone: 'the clone\'s file', invocation: 'the --config file', flag: 'a flag' },
  refutedLine: (count) => `${count === 1 ? 'The candidate that the verifiers refuted is' : `The ${String(count)} candidates that the verifiers refuted are`} listed below, so a point raised again can be answered from ${count === 1 ? 'it' : 'them'}.`,
  refutedSummary: (count) => (count === 1 ? 'The refuted candidate' : `The ${String(count)} refuted candidates`),
  refutedItem: (claim, why) => `${claim} Refuted: ${why}`,
  refutedInReport: 'The evidence that refuted it is in the report of the run.',
  refutedCut: (count) => `To fit the length GitHub takes, ${count === 1 ? 'the candidate that the verifiers refuted is' : `the ${String(count)} candidates that the verifiers refuted are`} not listed here; the report of the run holds each with its evidence.`,
  noPlace: 'no place in the repository',

  trustHeading: '### How far to trust this review',
  trust: (counts) => {
    const refuted = counts.refuted === 0 ? `The verifiers refuted none of the ${String(counts.candidates)} candidates.` : `The verifiers refuted ${String(counts.refuted)} of ${counted(counts.candidates, 'candidate', 'candidates')}, so the finders' claims did not pass unchecked.`;
    if (counts.findings === 0) return refuted;
    const unverified = counts.unverified === 0 ? '' : `, ${String(counts.unverified)} of them unverified`;
    const ran = counts.majorConfirmedRan === 0 ? '' : `, ${String(counts.majorConfirmedRan)} of them reproduced by running ${counts.majorConfirmedRan === 1 ? 'it' : 'them'}`;
    const major = counts.major === 0 ? '' : counts.major === 1 ? `; the major one is ${counts.majorConfirmed === 1 ? `CONFIRMED${counts.majorConfirmedRan === 1 ? ', reproduced by running it' : ''}` : 'PLAUSIBLE'}` : `; ${String(counts.majorConfirmed)} of the ${String(counts.major)} major ones ${counts.majorConfirmed === 1 ? 'is' : 'are'} CONFIRMED${ran}`;
    return `${String(counts.confirmed)} of the ${counted(counts.findings, 'finding', 'findings')} ${counts.confirmed === 1 ? 'is' : 'are'} CONFIRMED and ${String(counts.plausible)} PLAUSIBLE${unverified}${major}. Across all ${String(counts.findings)}, ${basesEnglish(counts)}. ${refuted}`;
  },
  modelLine: 'A model wrote the explanations from the evidence beneath each finding, and only that evidence was verified.',
  conclusionDropped: 'The writer gave no summary that passed deep-review\'s checks, so the summary and the actions are in deep-review\'s own words.',
  findingsDropped: (findings, count) => `The writer gave no explanation of ${findings} that passed deep-review's checks, so ${count === 1 ? 'it is' : 'each is'} given in deep-review's own words.`,
  noExplanation: 'deep-review recorded no explanation by its writer for this run, so the review is in deep-review\'s own words.',
  predates: (findings) => `The writer explained this review before the answers to ${findings} were recorded; deep-review's own words give each answer.`,
  areaDiagramsCut: 'To fit the length GitHub takes, the diagrams of the areas are left out.',

  lastLine: (facts) => `Reviewed by deep-review ${facts.engine} on ${facts.runtime} ${facts.version} with ${facts.strong} and ${facts.fast}, run ${facts.run}, commits ${facts.base}..${facts.head}.`,
};

/** How the findings were checked, in Korean: each basis with its count, then the findings with none. */
function basesKorean(counts: ReviewCounts): string {
  const ways = ([['ran', '코드를 실행해'], ['traced', '코드를 따라가'], ['read', '코드를 읽어']] as const).filter(([basis]) => counts.bases[basis] > 0);
  const told = ways.length === 0 ? '확인 방법이 기록된 판정은 없습니다.' : `${ways.map(([basis, how]) => `${String(counts.bases[basis])}건은 ${how}`).join(', ')} 확인했습니다.`;
  return `${told}${counts.noBasis === 0 ? '' : ` ${String(counts.noBasis)}건은 확인 방법이 기록되지 않았습니다.`}`;
}

const korean: PullRequestWords = {
  heading: '## deep-review의 풀 리퀘스트 리뷰',
  reviewed: (head, files, base) => `deep-review가 이 풀 리퀘스트를 head ${head}에서 리뷰했습니다. merge base ${base}부터 바뀐 파일 ${String(files)}개를 보았으며, 파일은 하나도 바꾸지 않았습니다.`,
  findingList: (numbers) => `지적 사항 ${[...new Set(numbers)].sort((a, b) => a - b).map(String).join(', ')}`,

  summaryHeading: '### 요약',
  summaryCounts: (counts) => {
    if (counts.findings === 0) return '이 리뷰가 남긴 지적 사항은 없습니다. 검증자가 모든 후보를 반박했거나, 찾은 후보가 없었습니다.';
    const parts = [
      ...(counts.major === 0 ? [] : [`major ${String(counts.major)}건${counts.critical === 0 ? '' : `(그중 critical ${String(counts.critical)}건)`}은 병합 전에 살펴야 할 것`]),
      ...(counts.minor === 0 ? [] : [`minor ${String(counts.minor)}건은 그보다 가벼운 것`]),
    ];
    return `이 리뷰는 지적 사항 ${String(counts.findings)}건을 남깁니다. ${parts.length === 2 ? `${parts[0]!}이고, ${parts[1]!}입니다.` : `${parts[0]!}입니다.`}`;
  },
  summaryNext: (counts, fix) => {
    const parts = [
      ...(counts.fixes === 0 ? [] : [`고칠 것 ${String(counts.fixes)}건`]),
      ...(counts.questions === 0 ? [] : [`작성자에게 물을 것 ${String(counts.questions)}건`]),
      ...(counts.left === 0 ? [] : [`그대로 둘 것 ${String(counts.left)}건`]),
    ];
    const decided = `deep-review의 결정은 ${parts.join(', ')}입니다.`;
    if (counts.fixes + counts.questions === 0) return `${decided} 이 브랜치에서 바꿀 것은 없습니다.`;
    return `${decided} 이 리뷰를 실행한 사람이 ${fix} 명령으로 수정과 그때까지 받은 답을 자신의 클론에 적용하고 그 결과를 푸시하기 전까지, 이 브랜치에서는 아무것도 바뀌지 않습니다.`;
  },

  needsHeading: '### 사람이 해야 할 일',
  needsQuestion: (finding, href, question, tail) => `**[지적 사항 ${String(finding)}에 대한 질문](${href}).** ${question} ${tail}`,
  needsDeparture: (finding, href, rule, tail) => `**[지적 사항 ${String(finding)}](${href})의 수정은 명문화된 규칙과 다릅니다.** 규칙: "${rule}" ${tail}`,
  departureStands: '이 리뷰를 실행한 사람이 먼저 거부하지 않으면 `--fix`가 결정대로 고칩니다. 고친 뒤에 거부하면 그 지적 사항은 다시 수정 작업자에게 갑니다.',
  needsAuthor: (finding, href, choice) => `**[지적 사항 ${String(finding)}](${href})은 그대로 두지만, 검증자는 작성자가 정할 선택이 남았다고 봅니다.** ${choice}`,
  needsAnswer: (command, flags) => `이 리뷰를 실행한 사람이 ${command} 명령에 ${flags.length === 1 ? `${flags[0]!}를` : `${flags.join(', ')} 중 하나를`} 붙여 답합니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.`,
  needsNothing: '사람이 할 일은 없습니다. deep-review가 묻는 질문도, 명문화된 규칙과 다른 수정도 없습니다.',

  howHeading: '### 리뷰가 진행된 방식',
  howWorked: (counts) => `deep-review는 작업자라고 부르는 모델 세션을 역할마다 따로 실행합니다. 찾는 작업자는 여러 관점에서 결함 후보를 내고, 검증자는 코드를 읽거나 실행해 각 후보를 확인하며, 결정하는 작업자는 고칠지, 작성자에게 물을지, 그대로 둘지 정합니다. 이번에는 후보 ${String(counts.candidates)}개가 중복을 합친 뒤 ${String(counts.groups)}개가 되었고, 검증자가 그중 ${String(counts.refuted)}개를 반박하고 ${String(counts.kept)}개를 남겼으며, 남은 것 중 ${String(counts.merged)}개가 다른 지적 사항에 합쳐져 지적 사항 ${String(counts.findings)}건이 남았습니다.`,
  howDiagram: (pullRequest) => [
    'flowchart TD',
    `  subgraph RV["review --pr ${String(pullRequest)}, 읽기 전용: 완료"]`,
    '    F["찾는 작업자가 후보를 냅니다"] --> V["검증자가 각 후보를 실행하거나 따라가 봅니다"]',
    '    V --> D["결정하는 작업자가 고칠지, 물을지, 둘지 정합니다"]',
    '    D --> W["설명 모델이 쉬운 말로 설명합니다"]',
    '  end',
    '  W --> P["publish가 글을 정리해 이 리뷰를 올립니다"]',
    '  P --> A["리뷰를 실행한 사람이 질문에 답합니다"]',
    `  A --> X["review --pr ${String(pullRequest)} --fix: 수정 작업자가 각 수정을 적용하고 검사합니다"]`,
  ].join('\n'),
  verdictMeanings: 'CONFIRMED는 검증자가 문제를 실행해 재현했거나, 코드 경로를 따라가 잘못된 결과에 이르는 것을 확인했다는 뜻입니다. PLAUSIBLE은 확인한 범위에서는 주장이 맞지만 확정하지는 못했다는 뜻이며, 사실 하나를 확인하지 못했거나 선택이 남았기 때문입니다. 그런 지적 사항마다 어느 쪽인지, 또는 검증자가 이유를 밝히지 않았는지 적었습니다.',
  unverifiedMeaning: '검증 안 됨 표시가 붙은 PLAUSIBLE 지적 사항은 검증자가 두 번 실패해 아무도 검토하지 않은 것입니다.',
  severityMeanings: '심각도는 작업자의 판단입니다. critical이나 major 지적 사항은 병합 전에 살펴야 할 것이고, minor 지적 사항은 잘못된 메시지나 다음 변경에서 서로 어긋날 수 있는 중복 코드처럼 그보다 가벼운 것입니다.',

  areasHeading: '### major 지적 사항',
  findingsArea: 'deep-review가 고치거나 묻는 major 지적 사항',
  noMajor: '고치거나 물을 major 지적 사항은 없습니다.',
  wouldDo: (sentence) => `deep-review가 할 일: ${sentence}`,
  recommends: (option, text) => `작성자에게 묻는 질문이며, deep-review는 ${String(option)}번 선택지를 권합니다: ${text}`,
  againstRule: '명문화된 규칙과 다릅니다.',

  inFullHeading: (finding, title) => `### 지적 사항 ${String(finding)}: ${title}`,
  grade: (severity, verdict, basis, marks) => `심각도 ${severity}. ${[verdict, ...marks, ...(basis === null ? [] : [basis])].join(', ')}.`,
  basisWords: { ran: '실행해 재현함', traced: '코드를 따라가 확인함', read: '코드를 읽어 확인함' },
  unverifiedMark: '검증 안 됨',
  statusSentences: {
    question: 'deep-review가 작성자에게 묻습니다.',
    fixed: 'deep-review가 고쳤습니다.',
    'fixed-against-rule': 'deep-review가 명문화된 규칙과 다르게 고쳤습니다.',
    'not-fixed': 'deep-review가 고치기로 했지만 고치지 못했습니다.',
    left: '그대로 둡니다.',
    planned: 'deep-review가 고치려 합니다.',
    'planned-against-rule': 'deep-review가 명문화된 규칙과 다르게 고치려 합니다.',
  },
  lineNotChanged: '이 풀 리퀘스트는 이 줄을 바꾸지 않습니다.',
  fileNotChanged: '이 풀 리퀘스트는 이 파일을 바꾸지 않습니다.',
  noPatch: 'GitHub가 이 파일의 diff를 보여 주지 않아, 이 지적 사항은 해당 줄에 댓글로 달지 못했습니다.',
  noPlaceNote: '이 지적 사항이 가리키는 위치는 저장소에 없습니다.',
  unexplained: (reason) => `deep-review의 설명 모델이 이 지적 사항을 설명하지 못해, deep-review가 직접 쓴 문장으로 적었습니다. 직접 확인해 주세요.${reason === null ? '' : ` 설명 모델이 밝힌 이유: ${reason}`}`,
  problemLabel: '**무엇이 잘못되나.**',
  whyPlausible: (unconfirmed) => {
    if (unconfirmed === null) return 'PLAUSIBLE인 이유: 검증자가 이유를 밝히지 않았습니다.';
    return unconfirmed.kind === 'fact' ? `PLAUSIBLE인 이유: 확인하지 못한 사실이 하나 있습니다. ${unconfirmed.text}` : `PLAUSIBLE인 이유: 결함은 있지만 선택이 남았습니다. ${unconfirmed.text}`;
  },
  whyUnverified: 'PLAUSIBLE인 이유: 검증자가 두 번 실패해 아무도 검토하지 않았습니다.',
  wouldDoLabel: '**deep-review가 할 일.**',
  asDecided: '결정된 수정',
  rejected: (option, reason) => `택하지 않은 방법: ${option} ${reason}`,
  departure: (rule, source, fact, accept, reject, fix) => `**이 수정은 명문화된 규칙과 다릅니다.** 규칙: "${rule}" 출처: ${source} 규칙과 맞지 않는 사실: ${fact} 이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 ${accept} 명령으로 이 결정을 받아들이거나 ${reject} 명령으로 거부합니다. 먼저 거부하지 않으면 ${fix}가 결정대로 고칩니다.`,
  answeredAccept: (at) => `이 리뷰를 실행한 사람이 ${at}에 이 결정을 받아들였습니다.`,
  answeredReject: (at) => `이 리뷰를 실행한 사람이 ${at}에 이 결정을 거부했으므로, 수정은 규칙을 따릅니다.`,
  whyAsked: '**질문하는 이유.**',
  question: (question) => `**질문.** ${question}`,
  option: (number, option, cost) => `${String(number)}. **${option}** ${cost}`,
  standing: (recommended, applied, edits, option) => {
    const recommendation = option === null ? `deep-review는 ${String(recommended)}번 선택지를 권합니다.` : `deep-review는 ${String(recommended)}번 선택지를 권합니다: ${option}`;
    const result = edits ? '`--fix`가 이를 적용합니다.' : '코드는 지금 그대로입니다.';
    return recommended === applied
      ? `${recommendation} 누군가 답할 때까지도 이 선택지를 따릅니다. ${result}`
      : `${recommendation} 누군가 답할 때까지는 되돌리기 가장 쉬운 ${String(applied)}번 선택지를 따릅니다. ${result}`;
  },
  answerQuestion: (command, fix) => `**답하는 방법.** 이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 ${command} 명령으로 답합니다. \`<k>\`에는 고른 선택지의 번호를 씁니다. 그다음 ${fix}가 그 답을 적용합니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.`,
  answeredOption: (option, at) => `이 리뷰를 실행한 사람이 ${at}에 ${String(option)}번 선택지로 답했습니다.`,
  whyLeft: '**그대로 두는 이유.**',
  whyLook: '**그래도 사람이 봐야 하는 이유.**',
  authorChoice: (choice) => `검증자는 작성자가 정할 선택을 남겼습니다: ${choice}`,
  howChecked: '검증자가 확인한 방법',
  basisSentences: {
    ran: '검증자가 코드를 실행해 확인했습니다. 무엇을 실행하고 무엇을 보았는지는 실행 보고서에 있습니다.',
    traced: '검증자가 코드를 따라가 결과까지 확인했습니다. 근거는 실행 보고서에 있습니다.',
    read: '검증자가 해당 줄을 읽었고, 그것만으로 판단할 수 있었습니다. 근거는 실행 보고서에 있습니다.',
  },
  noBasis: '검증자의 기록에 확인 방법이 없습니다. 근거는 실행 보고서에 있습니다.',
  notVerified: '검증자가 두 번 실패해 아무도 검토하지 않았습니다.',
  codeHeading: '리뷰한 head의 코드:',
  atBase: (link) => `${link} (merge base의 코드)`,
  trace: (id, run) => `<sub>실행 ${run}의 지적 사항 ${id}.</sub>`,
  diagramBroken: '이 리뷰를 실행한 컴퓨터의 경로와 비밀 값을 지우는 과정에서 다이어그램이 깨져 여기서는 뺐습니다. 설명 모델의 원래 답은 실행 기록이 있는 컴퓨터에 남아 있습니다.',

  minorHeading: '### minor 지적 사항',
  minorLead: (counts) => {
    const where = counts.onLine === counts.total ? '모두 해당 줄의 댓글에 있습니다' : counts.onLine === 0 ? '모두 위에 전문을 적었습니다' : `${String(counts.onLine)}건은 해당 줄의 댓글에 있고, 나머지는 위에 전문을 적었습니다`;
    const kinds = counts.user === 0 ? '' : ` 그중 ${String(counts.user)}건은 사용자가 보는 것에 닿고, ${String(counts.code)}건은 코드에 관한 것입니다.`;
    return `minor 지적 사항은 ${String(counts.total)}건이며, ${where}.${kinds}`;
  },
  minorNeeds: (findings) => `그중 ${findings}는 "사람이 해야 할 일"에 적었듯 사람이 봐야 합니다.`,
  minorSummary: (count) => `minor 지적 사항 ${String(count)}건`,
  minorOrder: (user) => `처음 ${String(user)}건은 사용자가 보는 것에 닿고, 나머지는 코드에 관한 것입니다.`,
  minorColumns: ['#', '지적 사항', '판정', 'deep-review가 할 일'],
  minorCut: 'GitHub가 받는 길이에 맞추느라 minor 지적 사항의 표는 뺐습니다. 각 지적 사항은 해당 줄의 댓글이나 위의 전문에 있으며, 실행 보고서에 모두 있습니다.',

  leftHeading: '### 그대로 둔 지적 사항',
  leftSummary: (count) => `그대로 둔 지적 사항 ${String(count)}건`,
  leaveReasons: {
    'outside-change-not-regression': '변경 범위 밖이며 회귀가 아님',
    superseded: '다른 지적 사항의 수정으로 해결됨',
    intended: '저장소에 적힌 대로 의도된 동작임',
  },
  leftBecause: (reason, by) => `deep-review가 그대로 두는 이유: ${reason}${by === null ? '' : ` (${by})`}.`,
  groundsLabel: '판단 근거:',
  leftCut: (count) => `GitHub가 받는 길이에 맞추느라 그대로 둔 지적 사항 ${String(count)}건은 여기에 적지 않았습니다. 실행 보고서에 모두 있습니다.`,

  notExaminedHeading: '### 이 리뷰가 검토하지 않은 것',
  noCheck: '이 실행은 리뷰만 했으므로 어떤 검사도 돌리지 않았고, 변경에 대해 테스트도 실행하지 않았습니다.',
  allExamined: '모든 리뷰 단계가 실행되었고, 검증자가 모든 후보를 검토했습니다.',
  gap: (text) => `${text} (실행 기록의 원문 그대로 영어로 적습니다)`,
  excluded: (patterns, count, layer) => `${patterns.join(', ')} 패턴이 바뀐 경로 ${String(count)}개를 제외했으며, 어떤 작업자도 이 경로를 읽지 않았습니다.${layer === null ? '' : ` \`scope.exclude\`는 ${layer}에서 정했습니다.`}`,
  layers: { default: '기본값', operator: '운영자 설정 파일', repository: '저장소 설정 파일', clone: '클론 설정 파일', invocation: '--config 파일', flag: '명령줄 플래그' },
  refutedLine: (count) => `검증자가 반박한 후보 ${String(count)}개를 아래에 적었습니다. 같은 지적이 다시 나오면 여기서 답할 수 있습니다.`,
  refutedSummary: (count) => `반박된 후보 ${String(count)}개`,
  refutedItem: (claim, why) => `${claim} 반박된 이유: ${why}`,
  refutedInReport: '반박한 근거는 실행 보고서에 있습니다.',
  refutedCut: (count) => `GitHub가 받는 길이에 맞추느라 검증자가 반박한 후보 ${String(count)}개는 여기에 적지 않았습니다. 각 후보와 그 근거는 실행 보고서에 있습니다.`,
  noPlace: '저장소에 위치 없음',

  trustHeading: '### 이 리뷰를 얼마나 믿을 수 있나',
  trust: (counts) => {
    const refuted = counts.refuted === 0 ? `검증자는 후보 ${String(counts.candidates)}개 중 어느 것도 반박하지 않았습니다.` : `검증자가 후보 ${String(counts.candidates)}개 중 ${String(counts.refuted)}개를 반박했으므로, 찾는 작업자의 주장이 확인 없이 통과하지 않았습니다.`;
    if (counts.findings === 0) return refuted;
    const unverified = counts.unverified === 0 ? '' : `(그중 ${String(counts.unverified)}건은 검증 안 됨)`;
    const major = counts.major === 0 ? '' : ` major ${String(counts.major)}건 중 ${String(counts.majorConfirmed)}건이 CONFIRMED입니다${counts.majorConfirmedRan === 0 ? '' : `. 그중 ${String(counts.majorConfirmedRan)}건은 실행해 재현했습니다`}.`;
    return `지적 사항 ${String(counts.findings)}건 중 ${String(counts.confirmed)}건이 CONFIRMED, ${String(counts.plausible)}건이 PLAUSIBLE입니다${unverified}.${major} 전체 ${String(counts.findings)}건 중 ${basesKorean(counts)} ${refuted}`;
  },
  modelLine: '설명은 모델이 각 지적 사항 아래의 근거를 바탕으로 썼으며, 검증된 것은 그 근거뿐입니다.',
  conclusionDropped: '설명 모델이 deep-review의 검사를 통과한 요약을 내지 못해, 요약과 조치는 deep-review가 직접 쓴 문장으로 적었습니다.',
  findingsDropped: (findings) => `설명 모델이 ${findings}에 대해 deep-review의 검사를 통과한 설명을 내지 못해, deep-review가 직접 쓴 문장으로 적었습니다.`,
  noExplanation: '이 실행에는 설명 모델의 설명이 기록되지 않아, 리뷰 전체를 deep-review가 직접 쓴 문장으로 적었습니다.',
  predates: (findings) => `설명 모델의 설명은 ${findings}에 대한 답이 기록되기 전에 쓰였습니다. 각 답은 deep-review가 직접 쓴 문장으로 적었습니다.`,
  areaDiagramsCut: 'GitHub가 받는 길이에 맞추느라 영역의 다이어그램은 뺐습니다.',

  lastLine: (facts) => `deep-review ${facts.engine}, ${facts.runtime} ${facts.version} (모델 ${facts.strong}, ${facts.fast}), 실행 ${facts.run}, 리뷰한 커밋 ${facts.base}..${facts.head}.`,
};

/** The languages that have a table of the engine's words. */
export const pullRequestLanguages = ['en', 'ko'] as const;
export type PullRequestLanguage = (typeof pullRequestLanguages)[number];

/** The table of each language, which the test of the tables reads whole. */
export const pullRequestWordTables: Readonly<Record<PullRequestLanguage, PullRequestWords>> = { en: english, ko: korean };

/** The engine's words for a language tag, by its primary subtag, as `ko-KR` takes Korean; English for a language with no table (R20). */
export function pullRequestWords(language: string): PullRequestWords {
  const primary = language.split('-')[0]!.toLowerCase();
  return (pullRequestLanguages as readonly string[]).includes(primary) ? pullRequestWordTables[primary as PullRequestLanguage] : english;
}
