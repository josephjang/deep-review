/**
 * The engine's own words in a review on the pull request (R20 of the
 * review on the pull request; R1, R7, R9, TD4 of the review in the
 * writer's words): the headings, the label of each fact, the name of each
 * value of a closed list, and the fixed notices that are the same in
 * every review, one table for each language this change writes. A
 * language with no table takes English. Every entry is a string, or a
 * record of strings keyed by a closed list, so no entry can take a number
 * or a text and build a sentence of the run around it: the writer writes
 * every sentence that says something of the run or of the change, and
 * the form shows each fact beside it as data (`markdown.ts`). `naming` is
 * the one exception: it gives a finding its name inside a worker's own
 * sentence and builds none of its own (NG3). Verdicts, severities,
 * identifiers, paths and commands are shown as they are and never
 * translated.
 */
import type { Layer } from '../config/settings.ts';
import type { FindingStatus, GapFacts } from './brief.ts';
import { koreanParticle, type FindingNaming, type IdName } from './finding-names.ts';
import { capitalized } from './markdown.ts';
import type { FixPass } from './pull-request-view.ts';
import { leaveReasonWords, settleStepWords, type ChangeConditionName, type FindingKind, type LeaveReason, type SettleStep, type VerdictBasis } from './vocabulary.ts';

/** The kinds of a gap of what the review did not examine, as the form labels each. */
export type GapKind = GapFacts['kind'];

/** Whose recorded words the review shows under a label where the writer's text is missing (R8 of the review in the writer's words). */
export type RecordedSpeaker = 'triage' | 'finder' | 'ranking' | 'decider' | 'verifier';

/** The parts of the writer's answer, as the review names one that is missing. */
export type WriterPart = 'core' | 'conditions' | 'summary' | 'areas' | 'findings' | 'left' | 'refuted' | 'not-examined';

/** What the pull request does to a finding's line, as its facts line names it; nothing for an added line. */
export type LineNote = 'line-not-changed' | 'file-not-changed' | 'no-patch' | 'no-place';

/** Where the next step of the review is: the fix pass still to come, the fix pass the run went on into, or no step, since deep-review asks for no change. */
export type NextStep = FixPass | 'nothing';

/** The decision on a finding as its facts name it, a fix against a written rule apart. */
export type DecisionValue = 'fix' | 'fix-against-rule' | 'ask' | 'leave';

/** The labels of the counts of the run that the review shows as tables. */
export interface CountLabels {
  readonly findings: string;
  readonly critical: string;
  readonly major: string;
  readonly minor: string;
  readonly fix: string;
  readonly ask: string;
  readonly leave: string;
  readonly candidates: string;
  readonly groups: string;
  readonly refuted: string;
  readonly kept: string;
  readonly merged: string;
}

/** The node texts of the fixed diagram of how the review worked; the form adds the pull request's number as a value. */
export interface DiagramNodes {
  readonly finders: string;
  readonly verifier: string;
  readonly decider: string;
  readonly writer: string;
  readonly done: string;
  readonly publish: string;
  readonly answer: string;
  readonly fixers: string;
  readonly continued: string;
}

/** The words of a review on the pull request in one language (R9, TD4 of the review in the writer's words). */
export interface PullRequestWords {
  readonly heading: string;
  readonly headLabel: string;
  readonly baseLabel: string;
  readonly filesLabel: string;
  readonly afterLabel: string;
  readonly afterValues: Readonly<Record<FixPass, string>>;
  readonly continuedNotice: string;

  readonly coreHeading: string;
  readonly whyLabel: string;
  readonly reasonLabel: string;
  readonly noReason: string;
  readonly sourcesLabel: string;
  readonly coreWhoseWriter: string;
  readonly coreWhoseTriage: string;
  readonly coreNone: Readonly<Record<'none' | 'unrecorded', string>>;
  readonly recorded: Readonly<Record<RecordedSpeaker, string>>;

  readonly summaryHeading: string;
  readonly counts: CountLabels;
  readonly nextNotices: Readonly<Record<NextStep, string>>;
  readonly fixCommandLabel: string;

  readonly needsHeading: string;
  readonly findingLabel: string;
  readonly questionItem: string;
  readonly departureItem: string;
  readonly recommendedLabel: string;
  readonly standingLabel: string;
  readonly editsLabel: string;
  readonly statusLabel: string;
  readonly answeredLabel: string;
  readonly answeredOnLabel: string;
  readonly yesNo: Readonly<Record<'yes' | 'no', string>>;
  readonly questionStatus: Readonly<Record<'open' | 'answered', string>>;
  readonly departureStatus: Readonly<Record<'stands' | 'accepted' | 'rejected', string>>;
  readonly conditionLabels: Readonly<Record<ChangeConditionName, string>>;
  readonly writerUnexplainedLabel: string;
  readonly filesShowLabel: string;
  readonly plausibleFixesLabel: string;
  readonly questionsLabel: string;
  readonly departuresLabel: string;
  readonly conditionsLabel: string;
  readonly none: string;
  readonly notJudged: string;
  readonly answerNotices: Readonly<Record<FixPass, string>>;
  readonly commandLabel: string;
  readonly flagsLabel: string;
  readonly looksNotice: string;

  readonly notExaminedHeading: string;
  readonly checksRunLabel: string;
  readonly noCheckContinued: string;
  readonly gapLabels: Readonly<Record<GapKind, string>>;
  readonly mergedUnverifiedLabel: string;
  readonly otherCandidatesLabel: string;
  readonly pathsLabel: string;
  readonly setByLabel: string;
  readonly gapsLabel: string;
  readonly layers: Readonly<Record<Layer, string>>;
  readonly refutedLabel: string;
  readonly refutedSummary: string;
  readonly refutedWhyLabel: string;
  readonly evidenceLabel: string;
  readonly inReport: string;
  readonly noPlace: string;
  readonly refutedCut: string;
  readonly notListedLabel: string;

  readonly howHeading: string;
  readonly rolesNotice: string;
  readonly diagram: DiagramNodes;
  readonly verdictMeanings: string;
  readonly unverifiedMeaning: string;
  readonly severityMeanings: string;
  readonly severityValues: string;

  readonly areasHeading: string;
  readonly findingsArea: string;
  readonly noMajor: string;
  readonly areaDiagramsCut: string;

  readonly severityLabel: string;
  readonly verdictLabel: string;
  readonly checkedByLabel: string;
  readonly decisionLabel: string;
  readonly lineLabel: string;
  readonly unverifiedMark: string;
  readonly basisValues: Readonly<Record<VerdictBasis, string>>;
  readonly decisionValues: Readonly<Record<DecisionValue, string>>;
  readonly statusValues: Readonly<Record<FindingStatus, string>>;
  readonly lineNotes: Readonly<Record<LineNote, string>>;
  readonly unexplainedNotice: string;
  readonly writerReasonLabel: string;
  readonly problemLabel: string;
  readonly unconfirmedLabel: string;
  readonly unconfirmedKinds: Readonly<Record<'fact' | 'choice', string>>;
  readonly whyPlausibleLabel: string;
  readonly unconfirmedBefore: string;
  readonly unconfirmedUnverified: string;
  readonly actionLabel: string;
  readonly askLabel: string;
  readonly departureLabel: string;
  readonly ruleLabel: string;
  readonly sourceLabel: string;
  readonly factLabel: string;
  readonly departureNotices: Readonly<Record<FixPass, string>>;
  readonly acceptLabel: string;
  readonly rejectLabel: string;
  readonly questionLabel: string;
  readonly optionColumns: Readonly<Record<'number' | 'means' | 'cost' | 'rule' | 'edits', string>>;
  readonly recommendationLabel: string;
  readonly settledByLabel: string;
  readonly settleSteps: Readonly<Record<SettleStep, string>>;
  readonly checkedSummary: string;
  readonly basisNotices: Readonly<Record<VerdictBasis, string>>;
  readonly noBasis: string;
  readonly notVerified: string;
  readonly codeLabel: string;
  readonly atBaseLabel: string;
  readonly recordSummary: string;
  readonly recordNotice: string;
  readonly fixTextLabel: string;
  readonly approachLabel: string;
  readonly rejectedLabel: string;
  readonly rejectedWhyLabel: string;
  readonly optionLabel: string;
  readonly costLabel: string;
  readonly groundsLabel: string;
  readonly verifierChoiceLabel: string;
  readonly settledChoiceLabel: string;
  readonly notSettled: string;
  readonly runLabel: string;
  readonly diagramBroken: string;
  readonly diagramNamesIds: string;
  readonly naming: FindingNaming;

  readonly minorHeading: string;
  readonly minorLabels: Readonly<Record<'total' | 'user' | 'code' | 'onLine' | 'needs', string>>;
  readonly minorSummary: string;
  readonly minorColumns: Readonly<Record<'number' | 'finding' | 'kind' | 'verdict' | 'action', string>>;
  readonly kindValues: Readonly<Record<FindingKind | 'none', string>>;
  readonly minorCut: string;

  readonly leftHeading: string;
  readonly leftSummary: string;
  readonly leaveReasons: Readonly<Record<LeaveReason, string>>;
  readonly supersededByLabel: string;
  readonly leftWhyLabel: string;
  readonly leftCut: string;

  readonly trustHeading: string;
  readonly verdictColumns: Readonly<Record<'verdict' | 'findings' | 'major' | 'majorRan' | 'unverified', string>>;
  readonly basisColumns: Readonly<Record<'basis' | 'findings', string>>;
  readonly noBasisValue: string;
  readonly modelNotice: string;
  readonly noExplanation: string;
  readonly missingLabel: string;
  readonly writerParts: Readonly<Record<WriterPart, string>>;
  readonly answeredAfterLabel: string;

  readonly lastLabels: Readonly<Record<'engine' | 'runtime' | 'models' | 'run' | 'commits', string>>;
}

/** The end of a text before an id that already says finding: `finding` or `findings`, or a list of numbers after `findings` that goes on, as `findings 1 and `, so each number of the list is said alone. */
const englishFindingSaid = /\b(?:findings?\s+|findings\s+\d+(?:(?:\s*,\s*|\s+(?:and|or)\s+|,\s+(?:and|or)\s+)\d+)*(?:\s*,\s*|\s+(?:and|or)\s+|,\s+(?:and|or)\s+))$/i;

/** An English word that determines the noun after it, so a name after it takes no article of its own. */
const englishDeterminer = String.raw`\b(?:the|a|an|this|that|its|our|their|each|every|another|any|no)\s+`;

/** The article `a` or `an` that ends a text before an id, which a writer chose for the id's sound and not for the name's. */
const englishIndefinite = /(?<![\w-])an?\s+$/i;

/** The start of a text after an id that a hyphen joins to a word, as `-style fix` after `RIPPLE-2`: the id names what the word is like, and an article before the id is the word's. */
const englishCompound = /^-\p{L}/u;

/**
 * The English name of a numbered finding (R1, R5 of the finding names in
 * the review), `finding 3`, or its number alone after a text that already
 * says finding. A numbered finding takes no article, so the name takes in
 * an `a` or `an` right before the id, as `an ALTITUDE-6` names `finding
 * 10`, and a noun after the id that says finding, as `the RIPPLE-2
 * finding` names `the finding 3`. In a word that a hyphen joins to the id,
 * as `a RIPPLE-2-style fix`, the article is the word's: an `a` stays, and
 * an `an` becomes `a`, as `an ALTITUDE-6-style fix` names `a finding
 * 10-style fix`.
 */
function englishFinding(number: number, before: string, after: string): IdName {
  const said = englishFindingSaid.test(before);
  const plain = said ? String(number) : `finding ${String(number)}`;
  if (englishCompound.test(after)) {
    const an = said ? '' : /(?<![\w-])an\s+$/i.exec(before)?.[0] ?? '';
    return { name: an === '' ? plain : `a ${plain}`, before: an.length, after: 0 };
  }
  return {
    name: plain,
    before: said ? 0 : englishIndefinite.exec(before)?.[0].length ?? 0,
    after: /^\s+findings?\b/i.exec(after)?.[0].length ?? 0,
  };
}

/**
 * The English name of a refuted candidate (R2, R5 of the finding names in
 * the review), which says each of its words once with the words around
 * the id: a noun `candidate` right before the id or right after it, or
 * `finding` right before it, is taken into the name, a `refuted` already written before it is not
 * written again, and the name takes the article `a` only when no
 * determiner comes before it and its noun is not plural, as `this
 * DESIGN-1` names `this refuted candidate` and `The candidate DESIGN-1`
 * names `The refuted candidate` and `DESIGN-1 candidate was` names
 * `A refuted candidate was`. An `an` before it, which a writer chose for
 * an id such as `EFFICIENCY-1`, is taken in and the name writes its own
 * article, as `an EFFICIENCY-1` names `a refuted candidate`. In a word
 * that a hyphen joins to the id, the article is the word's, so the name
 * writes none but the `a` in place of an `an`, as `DESIGN-1-based fixes`
 * names `refuted candidate-based fixes`.
 */
function englishRefuted(before: string, after: string): IdName {
  const preceding = /(?<![\w-])(?:candidate|finding)\s+$/i.exec(before)?.[0] ?? '';
  const unsaid = before.slice(0, before.length - preceding.length);
  const said = /\brefuted\s+$/i.test(unsaid);
  const an = said ? '' : /(?<![\w-])an\s+$/i.exec(unsaid)?.[0] ?? '';
  const rest = unsaid.slice(0, unsaid.length - an.length);
  const following = /^\s+(candidates?)\b/i.exec(after);
  const determined = new RegExp(`${englishDeterminer}${said ? String.raw`refuted\s+` : ''}$`, 'i').test(rest);
  const article = englishCompound.test(after) ? (an === '' ? '' : 'a') : determined || /s$/i.test(following?.[1] ?? '') ? '' : 'a';
  const words = [article, said ? '' : 'refuted', following?.[1] ?? 'candidate'].filter((word) => word !== '');
  return { name: words.join(' '), before: preceding.length + an.length, after: following?.[0].length ?? 0 };
}


const english: PullRequestWords = {
  heading: '## deep-review\'s review of this pull request',
  headLabel: 'Head',
  baseLabel: 'Merge base',
  filesLabel: 'Files changed',
  afterLabel: 'After the review',
  afterValues: { 'to-come': 'no file changed', continued: 'the run went on into its fix pass' },
  continuedNotice: 'The fix pass ran on the machine of the person who ran the review. Its edits are not part of this review; once it ends, the report of the run on that machine says what each fix did.',

  coreHeading: '### What this change does',
  whyLabel: '**Why.**',
  reasonLabel: 'Reason',
  noReason: 'none stated in the change\'s commit messages or documents',
  sourcesLabel: 'Sources',
  coreWhoseWriter: 'This is deep-review\'s reading of the change, which a model wrote from its code and its commit messages; no verifier examined it.',
  coreWhoseTriage: 'This is the account of deep-review\'s triage, the first worker to read the change, written before the review in its own words; no verifier examined it.',
  coreNone: {
    none: 'deep-review has no account of this change: its triage, the first worker to read the change, gave none.',
    unrecorded: 'deep-review has no account of this change, because an engine before the account reviewed it.',
  },
  recorded: {
    triage: 'In the words of deep-review\'s triage',
    finder: 'In the words of the finder',
    ranking: 'In the words of deep-review\'s ranking',
    decider: 'In the words of deep-review\'s decider',
    verifier: 'In the words of its verifier',
  },

  summaryHeading: '### Summary',
  counts: {
    findings: 'Findings',
    critical: 'Critical',
    major: 'Major',
    minor: 'Minor',
    fix: 'To fix',
    ask: 'To ask the author',
    leave: 'Left as is',
    candidates: 'Candidates',
    groups: 'After merging duplicates',
    refuted: 'Refuted',
    kept: 'Kept',
    merged: 'Joined another finding',
  },
  nextNotices: {
    'to-come': 'Nothing on this branch changes until the person who ran the review applies the fixes, and the answers given by then, in their clone with the command below, and pushes them.',
    continued: 'What the fix pass changes reaches this branch only when the person who ran the review pushes it.',
    nothing: 'deep-review asks for no change, so nothing on this branch needs to change.',
  },
  fixCommandLabel: 'Command that applies the fixes',

  needsHeading: '### What needs a person',
  findingLabel: 'Finding',
  questionItem: 'Question',
  departureItem: 'Fix against a written rule',
  recommendedLabel: 'Recommended option',
  standingLabel: 'Option that stands until an answer',
  editsLabel: 'Edits the code',
  statusLabel: 'Status',
  answeredLabel: 'Answered with option',
  answeredOnLabel: 'Answered on',
  yesNo: { yes: 'yes', no: 'no' },
  questionStatus: { open: 'not answered', answered: 'answered' },
  departureStatus: { stands: 'stands', accepted: 'accepted', rejected: 'rejected, so the fix follows the rule' },
  conditionLabels: { 'public-interface': '**It changes a public interface.**', 'wide-effect': '**It affects many files beyond the ones it changes.**' },
  writerUnexplainedLabel: 'deep-review\'s writer could not explain it from the code',
  filesShowLabel: 'Files that show it',
  plausibleFixesLabel: 'Fixes on a PLAUSIBLE verdict',
  questionsLabel: 'Questions',
  departuresLabel: 'Fixes against a written rule',
  conditionsLabel: 'Reasons to look',
  none: 'none',
  notJudged: 'not judged for this run',
  answerNotices: {
    'to-come': 'The person who ran the review answers on the machine that holds the run, with the command below, and the fix pass then applies the answer. A reply on this pull request is not read yet.',
    continued: 'Once the fix pass of the run has ended, the person who ran the review answers on the machine that holds the run, with the command below, which applies the answer. A reply on this pull request is not read yet.',
  },
  commandLabel: 'Command',
  flagsLabel: 'With one of',
  looksNotice: 'A person should also look at the change for these reasons. Nothing waits on them, and no command answers them.',

  notExaminedHeading: '### What this review did not examine',
  checksRunLabel: 'Checks run in this review',
  noCheckContinued: 'No check ran in this review. The fix pass that followed runs the repository\'s checks on the machine that ran it, and once it ends, its report there holds their results.',
  gapLabels: {
    angle: 'A review pass that did not run',
    unverified: 'Findings no verifier examined',
    excluded: 'Changed paths left out by `scope.exclude`',
    oversized: 'Files too large to give a worker',
    check: 'A check that did not run',
    budget: 'Steps the run budget stopped',
    series: 'Commits not prepared',
    documentation: 'The documentation step did not run',
    workers: 'Workers a stop ended',
  },
  mergedUnverifiedLabel: 'Findings with a merged candidate no verifier examined',
  otherCandidatesLabel: 'Other candidates no verifier examined',
  pathsLabel: 'Patterns',
  setByLabel: 'Set by',
  gapsLabel: 'Gaps',
  layers: { default: 'the default', operator: 'the operator\'s file', repository: 'the repository\'s file', clone: 'the clone\'s file', invocation: 'the --config file', flag: 'a flag' },
  refutedLabel: 'Candidates the verifiers refuted',
  refutedSummary: 'The refuted candidates',
  refutedWhyLabel: '**Why it was refuted.**',
  evidenceLabel: 'Evidence',
  inReport: 'the report of the run',
  noPlace: 'no place in the repository',
  refutedCut: 'To fit the length GitHub takes, the refuted candidates are not listed here; the report of the run holds each with its evidence.',
  notListedLabel: 'Not listed here',

  howHeading: '### How the review worked',
  rolesNotice: 'deep-review runs model sessions, called workers, each in one role. Finders propose candidate defects from several angles, a verifier checks each candidate by reading the code or running it, a decider chooses to fix, to ask the author, or to leave as is, and a writer writes this review from their records.',
  diagram: {
    finders: 'Finders propose candidates',
    verifier: 'A verifier runs or traces each one',
    decider: 'A decider chooses: fix, ask or leave',
    writer: 'The writer writes the review',
    done: 'read-only: done',
    publish: 'publish cleans the text and posts this review',
    answer: 'The person who ran the review answers the questions',
    fixers: 'fixers apply and test each fix',
    continued: 'The fix pass started on the machine that ran the review, and once it ends, its report there holds what it changed',
  },
  verdictMeanings: 'CONFIRMED means a verifier reproduced the problem by running it or traced the code path to the wrong result. PLAUSIBLE means the claim holds as far as it was checked but was not confirmed, either because a fact could not be settled or because a choice remains; each such finding says which, or that its verdict was recorded before verifiers gave that reason on its own.',
  unverifiedMeaning: 'A PLAUSIBLE finding marked unverified is one that no verifier examined, since its verifier failed twice.',
  severityMeanings: 'The severity is a worker\'s judgment: a critical or major finding is what matters before the merge, and a minor one is smaller, such as a message that misleads its reader only a little or repeated code that the next change can let drift. A message that leads its reader into a serious mistake is graded by that mistake.',
  severityValues: 'A finding\'s severity is read from three values that its reason names, each with the fact that gives it. Its effect is `loss`, data lost or a secret exposed; `wrong`, a wrong result or a broken promise; `costly`, the right outcome reached at a cost; or `none`, a cost only to the next change. Its reach is `always`, every use; `common`, a use the documents or the code make; or `rare`, only an unusual input or a later change. Its recovery is `self-fixed`, the person who meets it sees it and can undo it; `needs-fix`, it is seen but needs a maintainer or a fix; or `unnoticed`, no one is told or it cannot be undone.',

  areasHeading: '### The major findings',
  findingsArea: 'The major findings that deep-review would fix or asks about',
  noMajor: 'No major finding asks for a fix or a question.',
  areaDiagramsCut: 'To fit the length GitHub takes, the diagrams of the areas are left out; the writer\'s answer on the machine that holds the run keeps them.',

  severityLabel: 'Severity',
  verdictLabel: 'Verdict',
  checkedByLabel: 'Checked by',
  decisionLabel: 'Decision',
  lineLabel: 'Its line',
  unverifiedMark: 'unverified',
  basisValues: { ran: 'running it', traced: 'tracing the code', read: 'reading the code' },
  decisionValues: { fix: 'fix', 'fix-against-rule': 'fix against a written rule', ask: 'ask the author', leave: 'leave as is' },
  statusValues: {
    question: 'asked',
    fixed: 'fixed',
    'fixed-against-rule': 'fixed against a written rule',
    'not-fixed': 'not fixed',
    left: 'left as is',
    planned: 'to fix',
    'planned-against-rule': 'to fix against a written rule',
  },
  lineNotes: {
    'line-not-changed': 'not changed by this pull request',
    'file-not-changed': 'in a file this pull request does not change',
    'no-patch': 'in a file GitHub shows no diff of',
    'no-place': 'no place in the repository',
  },
  unexplainedNotice: 'deep-review\'s writer did not explain this finding, so it is given in the other workers\' own words: look at it yourself.',
  writerReasonLabel: 'The writer\'s reason',
  problemLabel: '**What goes wrong.**',
  unconfirmedLabel: '**Why it is not CONFIRMED.**',
  unconfirmedKinds: { fact: 'a fact not settled', choice: 'a choice that remains' },
  whyPlausibleLabel: 'Why PLAUSIBLE',
  unconfirmedBefore: 'This verdict was recorded before verifiers gave their reason on its own; the report of the run holds its evidence.',
  unconfirmedUnverified: 'No verifier examined it, since its verifier failed twice.',
  actionLabel: '**What deep-review would do.**',
  askLabel: '**What deep-review asks.**',
  departureLabel: '**Against a written rule.**',
  ruleLabel: 'Rule',
  sourceLabel: 'Source',
  factLabel: 'The decider\'s reason',
  departureNotices: {
    'to-come': 'The person who ran the review accepts or rejects this departure on the machine that holds the run; `--fix` makes the fix as decided unless it is rejected first.',
    continued: 'Once the fix pass of the run has ended, the person who ran the review accepts or rejects this departure on the machine that holds the run; the fix pass sets out to make the fix as decided, and a rejection sends the finding back to a fixer.',
  },
  acceptLabel: 'Command to accept',
  rejectLabel: 'Command to reject',
  questionLabel: '**The question.**',
  optionColumns: { number: 'Option', means: 'What it means', cost: 'What it costs', rule: 'The rule from then on', edits: 'Edits the code' },
  recommendationLabel: '**Why deep-review recommends it.**',
  settledByLabel: 'Choices settled by',
  settleSteps: settleStepWords,
  checkedSummary: 'How the verifier checked it',
  basisNotices: {
    ran: 'The verifier ran code to check it; the report of the run holds what it ran and what it saw.',
    traced: 'The verifier traced the code to the result; the report of the run holds its evidence.',
    read: 'The verifier read the lines, which alone settle it; the report of the run holds its evidence.',
  },
  noBasis: 'The verifier\'s record gives no basis; the report of the run holds its evidence.',
  notVerified: 'No verifier examined it, since its verifier failed twice.',
  codeLabel: 'Code at the reviewed head',
  atBaseLabel: 'At the merge base',
  recordSummary: 'The decision as deep-review recorded it',
  recordNotice: 'These are the words an answer and the fix pass apply.',
  fixTextLabel: '**The fix.**',
  approachLabel: 'Approach',
  rejectedLabel: 'Rejected',
  rejectedWhyLabel: 'Why',
  optionLabel: 'Option',
  costLabel: 'Cost',
  groundsLabel: 'Grounds',
  verifierChoiceLabel: 'Choice its verifier left to the author',
  settledChoiceLabel: 'Settled as',
  notSettled: 'not settled by deep-review',
  runLabel: 'Run',
  diagramBroken: 'A diagram is left out here, because cleaning it of secrets and of the places of the machine that ran this review broke it; the writer\'s answer on the machine that holds the run keeps it.',
  diagramNamesIds: 'A diagram is left out here, because it names a finding or a candidate by deep-review\'s internal id where the review cannot put its name; the writer\'s answer on the machine that holds the run keeps it.',
  naming: {
    finding: englishFinding,
    refuted: englishRefuted,
    starting: capitalized,
    particle: (_name, particle) => particle,
  },

  minorHeading: '### The minor findings',
  minorLabels: { total: 'Minor findings', user: 'Reach what a user sees', code: 'About the code alone', onLine: 'In a comment on their line', needs: 'Need a person' },
  minorSummary: 'The minor findings',
  minorColumns: { number: '#', finding: 'Finding', kind: 'Reaches', verdict: 'Verdict', action: 'What deep-review would do' },
  kindValues: { user: 'what a user sees', code: 'the code', none: 'not given' },
  minorCut: 'To fit the length GitHub takes, the table of the minor findings is left out; each has its comment on its line or its text above, and the report of the run holds them all.',

  leftHeading: '### The findings left as is',
  leftSummary: 'The findings left as is',
  leaveReasons: leaveReasonWords,
  supersededByLabel: 'Superseded by',
  leftWhyLabel: '**Why deep-review leaves it.**',
  leftCut: 'To fit the length GitHub takes, the findings left as is whose verifiers named no choice for the author are not listed here; the report of the run holds each.',

  trustHeading: '### How far to trust this review',
  verdictColumns: { verdict: 'Verdict', findings: 'Findings', major: 'Of them major', majorRan: 'Of the major, reproduced by running', unverified: 'Of them unverified' },
  basisColumns: { basis: 'Checked by', findings: 'Findings' },
  noBasisValue: 'no basis on record',
  modelNotice: 'A model wrote the sentences of this review from the verifiers\' evidence, which the report of the run holds, and from deep-review\'s decisions; only that evidence was verified. The tables and the labeled values are deep-review\'s own record, and where a sentence differs from them, the tables and values stand.',
  noExplanation: 'deep-review recorded no explanation by its writer for this run, so the review gives the record and the other workers\' own words.',
  missingLabel: 'Parts of the writer\'s answer this review lacks',
  writerParts: { core: 'the core of the change', conditions: 'the reasons to look', summary: 'the summary', areas: 'the areas', findings: 'findings', left: 'the findings left as is', refuted: 'the refuted candidates', 'not-examined': 'what the review did not examine' },
  answeredAfterLabel: 'Answered after the writer wrote',

  lastLabels: { engine: 'Reviewed by', runtime: 'Runtime', models: 'Models', run: 'Run', commits: 'Commits' },
};

/** The end of a text before an id that already says finding: 지적 사항, or a list of numbers after it that goes on, joined by 과, 와 or a comma, as `지적 사항 1과 `, so each number of the list is said alone. */
const koreanFindingSaid = /지적\s*사항\s*(?:\d+(?:(?:[과와]\s*|\s*,\s*)\d+)*(?:[과와]\s*|\s*,\s*))?$/;

/** A Korean noun right after an id that says finding, 지적 사항 or 지적, followed by a particle and then no Hangul, or by no Hangul at all, so that it is no part of a longer word such as 지적했다. */
const koreanFindingNoun = /^\s*지적(?:\s*사항)?(?!\s*사항)(?=(?:으로|로|은|는|이|가|을|를|과|와|의|에서|에|도|만)?(?!\p{Script=Hangul}))/u;

/**
 * The Korean name of a refuted candidate (R2, R5 of the finding names in
 * the review), 반박된 후보, which takes into itself a noun 후보 right
 * before the id or right after it, or 지적 사항 right before it, and writes 후보 alone after a 반박된
 * already written, as `후보 DESIGN-1은` names `반박된 후보는`.
 */
function koreanRefuted(before: string, after: string): IdName {
  const preceding = /(?<!\p{Script=Hangul})(?:후보|지적\s*사항)\s*$/u.exec(before)?.[0] ?? '';
  const said = /(?<!\p{Script=Hangul})반박된\s*$/u.test(before.slice(0, before.length - preceding.length));
  // 후보자 is a person who stands for something, not the noun the name says, so only a 후보 that 자 does not follow is taken in.
  return { name: said ? '후보' : '반박된 후보', before: preceding.length, after: /^\s*후보(?!자)/.exec(after)?.[0].length ?? 0 };
}


const korean: PullRequestWords = {
  heading: '## deep-review의 풀 리퀘스트 리뷰',
  headLabel: 'Head',
  baseLabel: 'Merge base',
  filesLabel: '바뀐 파일',
  afterLabel: '리뷰 뒤',
  afterValues: { 'to-come': '바꾼 파일 없음', continued: '같은 실행의 수정 단계로 넘어감' },
  continuedNotice: '수정 단계는 이 리뷰를 실행한 사람의 컴퓨터에서 진행되었습니다. 그 수정은 이 리뷰에 포함되지 않으며, 수정 단계가 끝나면 각 수정이 한 일은 그 컴퓨터에 있는 실행 보고서에 있습니다.',

  coreHeading: '### 이 변경이 하는 일',
  whyLabel: '**이유.**',
  reasonLabel: '이유',
  noReason: '변경의 커밋 메시지나 문서에 밝힌 것 없음',
  sourcesLabel: '출처',
  coreWhoseWriter: '이 내용은 모델이 변경의 코드와 커밋 메시지를 읽고 쓴 deep-review의 해석이며, 어떤 검증자도 검토하지 않았습니다.',
  coreWhoseTriage: '이 내용은 변경을 가장 먼저 읽는 deep-review의 분류 작업자(triage)가 리뷰 전에 자기 말로 쓴 설명이며, 어떤 검증자도 검토하지 않았습니다.',
  coreNone: {
    none: 'deep-review에는 이 변경에 대한 설명이 없습니다. 변경을 가장 먼저 읽는 분류 작업자(triage)가 설명을 내지 않았습니다.',
    unrecorded: 'deep-review에는 이 변경에 대한 설명이 없습니다. 변경 설명을 쓰기 전의 엔진이 이 실행을 리뷰했기 때문입니다.',
  },
  recorded: {
    triage: 'deep-review 분류 작업자(triage)의 원문',
    finder: '찾는 작업자의 원문',
    ranking: 'deep-review 순위 작업자의 원문',
    decider: 'deep-review 결정 작업자의 원문',
    verifier: '검증자의 원문',
  },

  summaryHeading: '### 요약',
  counts: {
    findings: '지적 사항',
    critical: 'Critical',
    major: 'Major',
    minor: 'Minor',
    fix: '고칠 것',
    ask: '작성자에게 물을 것',
    leave: '그대로 둘 것',
    candidates: '후보',
    groups: '중복을 합친 뒤',
    refuted: '반박됨',
    kept: '남음',
    merged: '다른 지적 사항에 합쳐짐',
  },
  nextNotices: {
    'to-come': '이 리뷰를 실행한 사람이 아래 명령으로 수정과 그때까지 받은 답을 자신의 클론에 적용하고 푸시하기 전까지, 이 브랜치에서는 아무것도 바뀌지 않습니다.',
    continued: '수정 단계가 바꾼 내용은 이 리뷰를 실행한 사람이 푸시해야 이 브랜치에 반영됩니다.',
    nothing: 'deep-review가 바꾸자는 것이 없으므로, 이 브랜치에서 바꿀 것은 없습니다.',
  },
  fixCommandLabel: '수정을 적용하는 명령',

  needsHeading: '### 사람이 해야 할 일',
  findingLabel: '지적 사항',
  questionItem: '질문',
  departureItem: '명문화된 규칙과 다른 수정',
  recommendedLabel: '권하는 선택지',
  standingLabel: '답하기 전까지 유지되는 선택지',
  editsLabel: '코드를 고침',
  statusLabel: '상태',
  answeredLabel: '고른 선택지',
  answeredOnLabel: '답한 때',
  yesNo: { yes: '예', no: '아니오' },
  questionStatus: { open: '답하지 않음', answered: '답함' },
  departureStatus: { stands: '유지됨', accepted: '받아들임', rejected: '거부함, 수정은 규칙을 따름' },
  conditionLabels: { 'public-interface': '**공개 인터페이스를 바꿉니다.**', 'wide-effect': '**바꾼 파일 밖의 많은 파일에 영향을 줍니다.**' },
  writerUnexplainedLabel: 'deep-review 설명 모델이 코드에서 설명하지 못함',
  filesShowLabel: '이를 보여 주는 파일',
  plausibleFixesLabel: 'PLAUSIBLE 판정에 기대는 수정',
  questionsLabel: '질문',
  departuresLabel: '명문화된 규칙과 다른 수정',
  conditionsLabel: '살펴볼 이유',
  none: '없음',
  notJudged: '이 실행에서는 판단하지 않음',
  answerNotices: {
    'to-come': '이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 아래 명령으로 답하며, 그다음 수정 단계가 그 답을 적용합니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.',
    continued: '그 실행의 수정 단계가 끝난 뒤, 이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 아래 명령으로 답하며, 그 명령이 답을 적용합니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.',
  },
  commandLabel: '명령',
  flagsLabel: '함께 붙일 것 중 하나',
  looksNotice: '다음 이유로도 사람이 변경을 살펴봐야 합니다. 이를 기다리는 것은 없으며, 답하는 명령도 없습니다.',

  notExaminedHeading: '### 이 리뷰가 검토하지 않은 것',
  checksRunLabel: '이 리뷰에서 돌린 검사',
  noCheckContinued: '이 리뷰에서는 어떤 검사도 돌리지 않았습니다. 이어진 수정 단계가 그 컴퓨터에서 저장소의 검사를 실행하며, 수정 단계가 끝나면 그 결과는 실행 보고서에 있습니다.',
  gapLabels: {
    angle: '실행되지 않은 리뷰 단계',
    unverified: '검증자가 검토하지 않은 지적 사항',
    excluded: '`scope.exclude`가 제외한 바뀐 경로',
    oversized: '작업자에게 주기에 너무 큰 파일',
    check: '실행되지 않은 검사',
    budget: '실행 예산 때문에 멈춘 단계',
    series: '준비하지 못한 커밋',
    documentation: '실행되지 않은 문서화 단계',
    workers: '중단으로 끝난 작업자',
  },
  mergedUnverifiedLabel: '합쳐진 후보를 검증자가 검토하지 않은 지적 사항',
  otherCandidatesLabel: '검증자가 검토하지 않은 다른 후보',
  pathsLabel: '패턴',
  setByLabel: '정한 곳',
  gapsLabel: '빠진 곳',
  layers: { default: '기본값', operator: '운영자 설정 파일', repository: '저장소 설정 파일', clone: '클론 설정 파일', invocation: '--config 파일', flag: '명령줄 플래그' },
  refutedLabel: '검증자가 반박한 후보',
  refutedSummary: '반박된 후보',
  refutedWhyLabel: '**반박된 이유.**',
  evidenceLabel: '근거',
  inReport: '실행 보고서',
  noPlace: '저장소에 위치 없음',
  refutedCut: 'GitHub가 받는 길이에 맞추느라 반박된 후보는 여기에 적지 않았습니다. 각 후보와 그 근거는 실행 보고서에 있습니다.',
  notListedLabel: '여기에 적지 않음',

  howHeading: '### 리뷰가 진행된 방식',
  rolesNotice: 'deep-review는 작업자라고 부르는 모델 세션을 역할마다 따로 실행합니다. 찾는 작업자는 여러 관점에서 결함 후보를 내고, 검증자는 코드를 읽거나 실행해 각 후보를 확인하며, 결정 작업자는 고칠지, 작성자에게 물을지, 그대로 둘지 정하고, 설명 모델은 이들의 기록으로 이 리뷰를 씁니다.',
  diagram: {
    finders: '찾는 작업자가 후보를 냅니다',
    verifier: '검증자가 각 후보를 실행하거나 따라가 봅니다',
    decider: '결정 작업자가 고칠지, 물을지, 그대로 둘지 정합니다',
    writer: '설명 모델이 리뷰를 씁니다',
    done: '읽기 전용: 완료',
    publish: 'publish가 글을 정리해 이 리뷰를 올립니다',
    answer: '리뷰를 실행한 사람이 질문에 답합니다',
    fixers: '수정 작업자가 각 수정을 적용하고 검사합니다',
    continued: '리뷰를 실행한 컴퓨터에서 수정 단계가 시작되었습니다. 수정 단계가 끝나면 바꾼 내용은 그 실행 보고서에 있습니다',
  },
  verdictMeanings: 'CONFIRMED는 검증자가 문제를 실행해 재현했거나, 코드 경로를 따라가 잘못된 결과에 이르는 것을 확인했다는 뜻입니다. PLAUSIBLE은 확인한 범위에서는 주장이 맞지만 확정하지는 못했다는 뜻이며, 사실 하나를 확인하지 못했거나 선택이 남았기 때문입니다. 그런 지적 사항마다 어느 쪽인지, 또는 그 판정이 검증자가 이유를 따로 밝히기 전에 기록되었는지 적었습니다.',
  unverifiedMeaning: '검증 안 됨 표시가 붙은 PLAUSIBLE 지적 사항은 검증자가 두 번 실패해 아무도 검토하지 않은 것입니다.',
  severityMeanings: '심각도는 작업자의 판단입니다. critical이나 major 지적 사항은 병합 전에 살펴야 할 것이고, minor 지적 사항은 읽는 사람을 조금 헷갈리게 하는 메시지나 다음 변경에서 서로 어긋날 수 있는 중복 코드처럼 그보다 가벼운 것입니다. 읽는 사람을 큰 실수로 이끄는 메시지는 그 실수에 따라 심각도가 매겨집니다.',
  severityValues: '지적 사항의 심각도는 그 이유가 밝히는 세 값으로 정하며, 이유는 값마다 그 값을 준 사실을 함께 적습니다. 결과(effect)는 `loss`(데이터를 잃거나 비밀이 드러남), `wrong`(잘못된 결과나 깨진 약속), `costly`(대가를 치르지만 올바른 결과에 이름), `none`(다음 변경에만 비용이 듦) 가운데 하나입니다. 범위(reach)는 `always`(모든 사용), `common`(문서나 코드가 하는 사용), `rare`(드문 입력이나 이후의 변경에서만) 가운데 하나입니다. 회복(recovery)은 `self-fixed`(마주친 사람이 바로 알아채고 되돌릴 수 있음), `needs-fix`(보이지만 관리자나 수정이 필요함), `unnoticed`(아무도 알지 못하거나 되돌릴 수 없음) 가운데 하나입니다.',

  areasHeading: '### major 지적 사항',
  findingsArea: 'deep-review가 고치거나 묻는 major 지적 사항',
  noMajor: '고치거나 물을 major 지적 사항은 없습니다.',
  areaDiagramsCut: 'GitHub가 받는 길이에 맞추느라 영역의 다이어그램은 뺐습니다. 설명 모델의 원래 답은 실행 기록이 있는 컴퓨터에 남아 있습니다.',

  severityLabel: '심각도',
  verdictLabel: '판정',
  checkedByLabel: '확인 방법',
  decisionLabel: '결정',
  lineLabel: '해당 줄',
  unverifiedMark: '검증 안 됨',
  basisValues: { ran: '실행해 재현함', traced: '코드를 따라가 확인함', read: '코드를 읽어 확인함' },
  decisionValues: { fix: '고침', 'fix-against-rule': '명문화된 규칙과 다르게 고침', ask: '작성자에게 물음', leave: '그대로 둠' },
  statusValues: {
    question: '물음',
    fixed: '고침',
    'fixed-against-rule': '명문화된 규칙과 다르게 고침',
    'not-fixed': '고치지 못함',
    left: '그대로 둠',
    planned: '고칠 예정',
    'planned-against-rule': '명문화된 규칙과 다르게 고칠 예정',
  },
  lineNotes: {
    'line-not-changed': '이 풀 리퀘스트가 바꾸지 않은 줄',
    'file-not-changed': '이 풀 리퀘스트가 바꾸지 않은 파일',
    'no-patch': 'GitHub가 diff를 보여 주지 않는 파일',
    'no-place': '저장소에 위치 없음',
  },
  unexplainedNotice: 'deep-review의 설명 모델이 이 지적 사항을 설명하지 못해, 다른 작업자의 원문으로 적었습니다. 직접 확인해 주세요.',
  writerReasonLabel: '설명 모델이 밝힌 이유',
  problemLabel: '**무엇이 잘못되나.**',
  unconfirmedLabel: '**CONFIRMED가 아닌 이유.**',
  unconfirmedKinds: { fact: '확인하지 못한 사실', choice: '남은 선택' },
  whyPlausibleLabel: 'PLAUSIBLE인 이유',
  unconfirmedBefore: '이 판정은 검증자가 이유를 따로 밝히기 전에 기록되었습니다. 근거는 실행 보고서에 있습니다.',
  unconfirmedUnverified: '검증자가 두 번 실패해 아무도 검토하지 않았습니다.',
  actionLabel: '**deep-review가 할 일.**',
  askLabel: '**deep-review가 묻는 것.**',
  departureLabel: '**명문화된 규칙과 다른 수정.**',
  ruleLabel: '규칙',
  sourceLabel: '출처',
  factLabel: '결정 작업자의 이유',
  departureNotices: {
    'to-come': '이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 이 결정을 받아들이거나 거부합니다. 먼저 거부하지 않으면 `--fix`가 결정대로 고칩니다.',
    continued: '그 실행의 수정 단계가 끝난 뒤, 이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 이 결정을 받아들이거나 거부합니다. 수정 단계는 결정대로 고치려 하며, 거부하면 그 지적 사항은 다시 수정 작업자에게 갑니다.',
  },
  acceptLabel: '받아들이는 명령',
  rejectLabel: '거부하는 명령',
  questionLabel: '**질문.**',
  optionColumns: { number: '선택지', means: '뜻', cost: '대가', rule: '그 뒤로 따를 규칙', edits: '코드를 고침' },
  recommendationLabel: '**deep-review가 권하는 이유.**',
  settledByLabel: '선택을 정한 근거',
  settleSteps: {
    intent: '변경이 밝힌 의도',
    contract: '저장소에 적힌 규칙',
    before: '변경 전의 동작',
    kept: '원래 있던 동작을 유지함',
    shape: '주변 코드가 이미 쓰는 형태, 없으면 덜 더하는 형태',
    scope: '수정을 변경 범위 안으로 한정함',
    none: '실제로 남은 선택이 없음, 고치는 방법이 하나뿐임',
  },
  checkedSummary: '검증자가 확인한 방법',
  basisNotices: {
    ran: '검증자가 코드를 실행해 확인했습니다. 무엇을 실행하고 무엇을 보았는지는 실행 보고서에 있습니다.',
    traced: '검증자가 코드를 따라가 결과까지 확인했습니다. 근거는 실행 보고서에 있습니다.',
    read: '검증자가 해당 줄을 읽었고, 그것만으로 판단할 수 있었습니다. 근거는 실행 보고서에 있습니다.',
  },
  noBasis: '검증자의 기록에 확인 방법이 없습니다. 근거는 실행 보고서에 있습니다.',
  notVerified: '검증자가 두 번 실패해 아무도 검토하지 않았습니다.',
  codeLabel: '리뷰한 head의 코드',
  atBaseLabel: 'merge base의 코드',
  recordSummary: 'deep-review가 기록한 결정',
  recordNotice: '답과 수정 단계가 적용하는 것은 이 원문입니다.',
  fixTextLabel: '**수정.**',
  approachLabel: '방법',
  rejectedLabel: '택하지 않은 방법',
  rejectedWhyLabel: '이유',
  optionLabel: '선택지',
  costLabel: '대가',
  groundsLabel: '판단 근거',
  verifierChoiceLabel: '검증자가 작성자에게 남긴 선택',
  settledChoiceLabel: '정한 내용',
  notSettled: 'deep-review가 정하지 않음',
  runLabel: '실행',
  diagramBroken: '이 리뷰를 실행한 컴퓨터의 경로와 비밀 값을 지우는 과정에서 다이어그램이 깨져 여기서는 뺐습니다. 설명 모델의 원래 답은 실행 기록이 있는 컴퓨터에 남아 있습니다.',
  diagramNamesIds: '이 다이어그램은 지적 사항이나 후보를 deep-review 내부 id로 가리키는데, 그 자리에는 리뷰가 그 이름을 쓸 수 없어 여기서는 뺐습니다. 설명 모델의 원래 답은 실행 기록이 있는 컴퓨터에 남아 있습니다.',
  naming: {
    finding: (number, before, after) => ({
      name: koreanFindingSaid.test(before) ? String(number) : `지적 사항 ${String(number)}`,
      before: 0,
      // A noun after the id that says finding, 지적 사항 or 지적 as in `RIPPLE-2 지적은`, is said by the name; the particle after it then follows the name.
      after: koreanFindingNoun.exec(after)?.[0].length ?? 0,
    }),
    refuted: koreanRefuted,
    starting: (name) => name,
    particle: koreanParticle,
  },

  minorHeading: '### minor 지적 사항',
  minorLabels: { total: 'minor 지적 사항', user: '사용자가 보는 것에 닿음', code: '코드에만 관한 것', onLine: '해당 줄의 댓글에 있음', needs: '사람이 봐야 함' },
  minorSummary: 'minor 지적 사항',
  minorColumns: { number: '#', finding: '지적 사항', kind: '닿는 곳', verdict: '판정', action: 'deep-review가 할 일' },
  kindValues: { user: '사용자가 보는 것', code: '코드', none: '정하지 않음' },
  minorCut: 'GitHub가 받는 길이에 맞추느라 minor 지적 사항의 표는 뺐습니다. 각 지적 사항은 해당 줄의 댓글이나 위의 전문에 있으며, 실행 보고서에 모두 있습니다.',

  leftHeading: '### 그대로 둔 지적 사항',
  leftSummary: '그대로 둔 지적 사항',
  leaveReasons: {
    'outside-change-not-regression': '변경 범위 밖이며 회귀가 아님',
    superseded: '다른 지적 사항의 수정으로 해결됨',
    intended: '저장소에 적힌 대로 의도된 동작임',
    settled: '코드 형태의 선택이며, 지금 코드를 유지하는 쪽으로 정함',
  },
  supersededByLabel: '해결하는 지적 사항',
  leftWhyLabel: '**deep-review가 그대로 두는 이유.**',
  leftCut: 'GitHub가 받는 길이에 맞추느라, 검증자가 작성자에게 남긴 선택이 없는 그대로 둔 지적 사항은 여기에 적지 않았습니다. 실행 보고서에 모두 있습니다.',

  trustHeading: '### 이 리뷰를 얼마나 믿을 수 있나',
  verdictColumns: { verdict: '판정', findings: '지적 사항', major: '그중 major', majorRan: 'major 중 실행해 재현함', unverified: '그중 검증 안 됨' },
  basisColumns: { basis: '확인 방법', findings: '지적 사항' },
  noBasisValue: '기록된 확인 방법 없음',
  modelNotice: '이 리뷰의 문장은 모델이 검증자의 근거와 deep-review의 결정을 바탕으로 썼으며, 그 근거는 실행 보고서에 있습니다. 검증된 것은 그 근거뿐입니다. 표와 이름 붙은 값은 deep-review 자신의 기록이며, 문장이 그와 다를 때는 표와 값이 기준입니다.',
  noExplanation: '이 실행에는 설명 모델의 설명이 기록되지 않아, 리뷰는 기록과 다른 작업자의 원문으로 적었습니다.',
  missingLabel: '이 리뷰에 없는 설명 모델의 답',
  writerParts: { core: '변경의 핵심', conditions: '살펴볼 이유', summary: '요약', areas: '영역', findings: '지적 사항', left: '그대로 둔 지적 사항', refuted: '반박된 후보', 'not-examined': '검토하지 않은 것' },
  answeredAfterLabel: '설명 모델이 쓴 뒤에 답한 것',

  lastLabels: { engine: '리뷰한 엔진', runtime: '런타임', models: '모델', run: '실행', commits: '커밋' },
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
