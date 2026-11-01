/**
 * The engine's own words in a review on the pull request (R20 of the
 * review on the pull request): the headings and labels, the line of what
 * the pull request needs, the status line, the lines of a finding's block,
 * who answers a question or a departure and how, the legend, and the notes
 * of a cut or of a fallback, one table for each language this change
 * writes. A language with no table takes English. Every table is a
 * `PullRequestWords`, so a table that lacks a key does not compile.
 * Verdicts, severities, identifiers, paths and commands are given to these
 * words as they are and never translated; the words of the workers and the
 * gaps of the brief, which the brief holds as English text, are not here.
 */
import type { BriefStatus, FindingStatus } from './brief.ts';
import type { Layer } from '../config/settings.ts';
import { capitalized, counted, findingWords, listed } from './markdown.ts';
import type { LeaveReason, Severity, Verdict, VerdictBasis } from './vocabulary.ts';

/** The counts of a read-only run's findings the status line says, as the brief counts them. */
export type StatusCounts = Pick<BriefStatus, 'findings' | 'toFix' | 'againstRule' | 'questions' | 'answered' | 'left'>;

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

/** Each text of the form that the engine writes, in one language. A function takes what the sentence names, already cleaned and formatted. */
export interface PullRequestWords {
  /** The heading of the body: the review as deep-review's, with the run and the head, each a code span. */
  readonly heading: (run: string, head: string) => string;
  /** The line of what the pull request needs before a merge: the fixes and the questions it counts. */
  readonly needsLine: (fixes: number, questions: number) => string;
  /** A finding by its number, as a link or a heading names it. */
  readonly findingName: (number: number) => string;
  /** Findings by their numbers, as a sentence names them. */
  readonly findingList: (numbers: readonly number[]) => string;
  /** The engine's sentence of an action when the writer gave none: a fix, a fix against a written rule, or a question, each with the decider's words. */
  readonly actionFix: (approach: string) => string;
  readonly actionDeparture: (approach: string) => string;
  readonly actionAsk: (question: string) => string;

  /** "What this pull request does", and the core of the change as the brief gives it. */
  readonly changeHeading: string;
  /** The title of a change the triage gave no account of, from its merge base to its head, each a code span. */
  readonly changeTitle: (base: string, head: string) => string;
  readonly why: (why: string) => string;
  readonly noWhy: string;
  readonly publicInterface: (detail: string) => string;
  readonly wideEffect: (detail: string) => string;
  readonly noJudgment: string;
  readonly accountWhose: string;
  readonly missingAccount: Readonly<Record<'none' | 'unrecorded', string>>;
  /** The writer's account, folded under the core. */
  readonly accountSummary: string;
  readonly termsHeading: string;
  readonly problemHeading: string;
  readonly changeTextHeading: string;
  readonly accountDiagramsCut: string;
  readonly accountCut: string;

  /** The line that says deep-review reviewed the pull request at its head, with the counts of its findings. */
  readonly statusLine: (head: string, counts: StatusCounts) => string;

  /** "What to know before the merge", the notes before the gaps, and the notes of the explanation. */
  readonly gapsHeading: string;
  readonly noCheck: string;
  readonly allExamined: string;
  readonly gapsLead: string;
  readonly conclusionDropped: string;
  readonly accountDropped: string;
  readonly findingsDropped: (findings: string, count: number) => string;
  readonly noExplanation: string;
  readonly predates: (findings: string) => string;

  /** The table of the findings. */
  readonly tableHeading: string;
  readonly columns: readonly [number: string, severity: string, verdict: string, status: string, summary: string, place: string];
  readonly statuses: Readonly<Record<FindingStatus, string>>;
  readonly noPlace: string;
  readonly unverifiedMark: string;
  readonly unexplainedMark: string;
  readonly noFindings: string;

  /** The block of a finding, in its comment or in full in the body. */
  readonly inFullHeading: string;
  readonly statusSentences: Readonly<Record<FindingStatus, string>>;
  readonly grade: (severity: Severity, verdict: Verdict, marks: readonly string[]) => string;
  readonly lineNotChanged: string;
  readonly fileNotChanged: string;
  readonly noPatch: string;
  readonly noPlaceNote: string;
  readonly unexplained: (reason: string | null) => string;
  readonly decidedFix: (approach: string) => string;
  readonly rejected: (option: string, reason: string) => string;
  readonly departure: (rule: string, source: string, fact: string) => string;
  readonly answerDeparture: (accept: string, reject: string) => string;
  readonly question: (question: string) => string;
  readonly choice: (choice: number, fallback: number) => string;
  readonly option: (number: number, option: string, cost: string, rule: string) => string;
  readonly answerQuestion: (command: string) => string;
  readonly answeredOption: (option: number, at: string) => string;
  readonly answeredAccept: (at: string) => string;
  readonly answeredReject: (at: string) => string;
  readonly evidenceVerified: string;
  readonly evidenceUnverified: string;
  readonly summaryLabel: string;
  readonly reasonLabel: string;
  readonly evidenceLabel: string;
  readonly noEvidence: string;
  readonly basis: (words: string) => string;
  readonly basisWords: Readonly<Record<VerdictBasis, string>>;
  readonly citedRun: (command: string, printed: string, exit: string) => string;
  readonly exitCode: (code: number | null) => string;

  /** The findings left as is, folded. */
  readonly leftHeading: (count: number) => string;
  readonly leaveReasons: Readonly<Record<LeaveReason, string>>;
  readonly leftBecause: (reason: string, by: string | null) => string;
  readonly groundsLabel: string;
  readonly leftCut: string;

  /** The candidates verification refuted, folded. */
  readonly refutedHeading: (count: number) => string;
  readonly refutedLead: string;
  readonly refutedCut: string;

  /** The patterns that left paths out of the run. */
  readonly excludedHeading: string;
  readonly excluded: (patterns: string, count: number, layer: string | null) => string;
  readonly layers: Readonly<Record<Layer, string>>;

  /** The legend, in the words of the role prompts that define each verdict, severity and status. */
  readonly legendHeading: string;
  readonly verdicts: Readonly<Record<Verdict, string>>;
  readonly severities: Readonly<Record<Severity, string>>;
  readonly statusLegend: Readonly<Record<FindingStatus, string>>;
  readonly unverifiedLegend: string;
  readonly unexplainedLegend: string;
  readonly modelLine: (readme: string) => string;

  /** The last visible line. */
  readonly lastLine: (facts: LastLineFacts) => string;
}

const english: PullRequestWords = {
  heading: (run, head) => `## deep-review's review of this pull request (run ${run}, head ${head})`,
  needsLine: (fixes, questions) => (fixes + questions === 0
    ? '**Before the merge: nothing.** deep-review found no fix and no question for this pull request.'
    : `**Before the merge: ${listed([...(fixes === 0 ? [] : [counted(fixes, 'fix', 'fixes')]), ...(questions === 0 ? [] : [counted(questions, 'question', 'questions')])])}**`),
  findingName: (number) => `Finding ${String(number)}`,
  findingList: (numbers) => findingWords(numbers),
  actionFix: (approach) => `deep-review would fix it: ${approach}`,
  actionDeparture: (approach) => `deep-review would fix it against a written rule, which a person accepts or rejects: ${approach}`,
  actionAsk: (question) => `deep-review asks: ${question}`,

  changeHeading: '### What this pull request does',
  changeTitle: (base, head) => `The change from ${base} to ${head}`,
  why: (why) => `Why, in the change's own words: ${why}`,
  noWhy: 'The change states no reason.',
  publicInterface: (detail) => `It changes a public interface, in deep-review's judgment${detail}.`,
  wideEffect: (detail) => `It affects many files beyond those it changes, in deep-review's judgment${detail}.`,
  noJudgment: 'In deep-review\'s judgment, it changes no public interface and affects no file beyond its own.',
  accountWhose: 'deep-review wrote this account of the change as submitted, and no verifier examined it.',
  missingAccount: {
    none: 'deep-review gave no account of this change.',
    unrecorded: 'deep-review recorded no account of this change, because an engine before the account reviewed it.',
  },
  accountSummary: 'For a reader new to this change',
  termsHeading: 'Terms',
  problemHeading: 'Before this change',
  changeTextHeading: 'What the change does',
  accountDiagramsCut: 'The diagrams of this account are left out, so that the review fits the length GitHub takes.',
  accountCut: 'deep-review\'s account for a reader new to this change is left out, so that the review fits the length GitHub takes; the core of the change above stays.',

  statusLine: (head, counts) => {
    const parts = [
      ...(counts.toFix === 0 ? [] : [`would fix ${String(counts.toFix)}${counts.againstRule === 0 ? '' : ` (${String(counts.againstRule)} against a written rule)`}`]),
      ...(counts.questions === 0 ? [] : [`asks ${counted(counts.questions, 'question', 'questions')}`]),
      ...(counts.answered.length === 0 ? [] : [`follows the answers to ${findingWords(counts.answered)}`]),
      ...(counts.left === 0 ? [] : [`leaves ${String(counts.left)} as is`]),
    ];
    const findings = counts.findings === 0 ? 'It has no finding.' : `It has ${counted(counts.findings, 'finding', 'findings')}${parts.length === 0 ? '' : `: it ${listed(parts)}`}.`;
    return `deep-review reviewed this pull request at its head ${head}, and changed no file. ${findings}`;
  },

  gapsHeading: '### What to know before the merge',
  noCheck: 'No check ran: this run only reviewed.',
  allExamined: 'Every review pass ran, and a verifier examined each candidate.',
  gapsLead: 'What this run did not examine:',
  conclusionDropped: 'The writer gave no conclusion that passed deep-review\'s checks, so the actions above are in deep-review\'s own words.',
  accountDropped: 'The writer gave no account of the pull request that passed deep-review\'s checks, so this review has none.',
  findingsDropped: (findings, count) => `The writer gave no explanation of ${findings} that passed deep-review's checks, so ${count === 1 ? 'it is' : 'each is'} given in deep-review's own words.`,
  noExplanation: 'deep-review recorded no explanation by its writer for this run, so the review is in deep-review\'s own words.',
  predates: (findings) => `The writer explained this review before the answers to ${findings} were recorded; deep-review's own words give each answer.`,

  tableHeading: '### Findings',
  columns: ['Finding', 'Severity', 'Verdict', 'Status', 'Summary', 'Place'],
  statuses: {
    question: 'a question',
    fixed: 'fixed',
    'fixed-against-rule': 'fixed against a written rule',
    'not-fixed': 'not fixed',
    left: 'left as is',
    planned: 'to fix',
    'planned-against-rule': 'to fix against a written rule',
  },
  noPlace: 'no place in the repository',
  unverifiedMark: 'unverified',
  unexplainedMark: 'not explained',
  noFindings: 'No finding survived verification.',

  inFullHeading: '### Fixes and questions with no line in the diff',
  statusSentences: {
    question: 'deep-review asks a question about this.',
    fixed: 'deep-review fixed this.',
    'fixed-against-rule': 'deep-review fixed this against a written rule.',
    'not-fixed': 'deep-review decided to fix this, and did not fix it.',
    left: 'deep-review leaves this as is.',
    planned: 'deep-review would fix this.',
    'planned-against-rule': 'deep-review would fix this against a written rule.',
  },
  grade: (severity, verdict, marks) => `${capitalized(severity)}, ${verdict}${marks.map((mark) => `, ${mark}`).join('')}.`,
  lineNotChanged: 'This pull request does not change this line.',
  fileNotChanged: 'This pull request does not change this file.',
  noPatch: 'GitHub shows no diff of this file, so this finding has no comment on its line.',
  noPlaceNote: 'This finding names no place that the repository holds.',
  unexplained: (reason) => `deep-review's writer did not explain this finding, so it is given in deep-review's own words: look at it yourself.${reason === null ? '' : ` The writer's reason: ${reason}`}`,
  decidedFix: (approach) => `The fix deep-review decided: ${approach}`,
  rejected: (option, reason) => `Rejected: ${option} (${reason}).`,
  departure: (rule, source, fact) => `This fix goes against a written rule: ${rule} (${source}). Why deep-review departs from it: ${fact}`,
  answerDeparture: (accept, reject) => `The person who ran this review accepts or rejects the departure, on the machine that holds the run: ${accept} keeps the fix and changes the rule, and ${reject} follows the rule. A reply on this pull request is not read yet.`,
  question: (question) => `deep-review asks: ${question}`,
  choice: (choice, fallback) => `deep-review would apply option ${String(choice)}. Until someone answers, the default is option ${String(fallback)}, the easiest to take back.`,
  option: (number, option, cost, rule) => `Option ${String(number)}: ${option} Cost: ${cost} The rule it makes: ${rule}`,
  answerQuestion: (command) => `The person who ran this review answers it, on the machine that holds the run, with ${command}, where \`<k>\` is the number of the option. A reply on this pull request is not read yet.`,
  answeredOption: (option, at) => `The person who ran this review answered it with option ${String(option)}, on ${at}.`,
  answeredAccept: (at) => `The person who ran this review accepted the departure, on ${at}.`,
  answeredReject: (at) => `The person who ran this review rejected the departure, so the fix follows the rule, on ${at}.`,
  evidenceVerified: 'Evidence that the verifier checked',
  evidenceUnverified: 'Evidence that no verifier checked',
  summaryLabel: 'Summary',
  reasonLabel: 'Reason',
  evidenceLabel: 'Evidence',
  noEvidence: 'none; the verifier of this group failed twice',
  basis: (words) => `How the verifier established it: ${words}.`,
  basisWords: { ran: 'it ran code', traced: 'it traced the lines', read: 'the lines alone settle it' },
  citedRun: (command, printed, exit) => `The run ${command} printed ${printed}, ${exit}.`,
  exitCode: (code) => (code === null ? 'no exit code on record' : `exit ${String(code)}`),

  leftHeading: (count) => `Findings left as is (${String(count)})`,
  leaveReasons: {
    'outside-change-not-regression': 'outside the change, and not a regression',
    superseded: 'superseded',
    intended: 'intended, as the repository states',
  },
  leftBecause: (reason, by) => `deep-review leaves this as is: ${reason}${by === null ? '' : ` by ${by}`}.`,
  groundsLabel: 'Why',
  leftCut: 'To fit the length GitHub takes, the findings left as is are given only by their rows in the table above; the report of the run holds each in full.',

  refutedHeading: (count) => `Refuted at verification (${String(count)})`,
  refutedLead: 'The candidates a verifier refuted, each with the evidence that refuted it.',
  refutedCut: 'To fit the length GitHub takes, each refuted candidate is given by its summary and place; the report of the run holds its evidence.',

  excludedHeading: '### Paths this review left out',
  excluded: (patterns, count, layer) => `${patterns} left out ${counted(count, 'changed path', 'changed paths')}, which no worker reviewed${layer === null ? '' : `; ${layer} set scope.exclude`}.`,
  layers: { default: 'the default', operator: 'the operator\'s file', repository: 'the repository\'s file', clone: 'the clone\'s file', invocation: 'the --config file', flag: 'a flag' },

  legendHeading: 'The words of this review',
  verdicts: {
    CONFIRMED: 'a verifier ran or traced the named input to the wrong result, and found nothing that stops it.',
    PLAUSIBLE: 'the claim holds as far as a verifier could check it, and one condition it names could not be settled here.',
    REFUTED: 'a verifier found the claim false: the lines do not do what it says, nothing produces the state, or a guard stops it.',
  },
  severities: {
    critical: 'the most severe of the three severities; the review lists these first.',
    major: 'less severe than critical and more severe than minor.',
    minor: 'the least severe; the review lists these last.',
  },
  statusLegend: {
    question: 'deep-review asks a person to choose between options; its default stands until someone answers.',
    fixed: 'a fixer of deep-review applied the fix.',
    'fixed-against-rule': 'a fixer of deep-review applied the fix, against a written rule.',
    'not-fixed': 'deep-review decided to fix it, and no fixer applied the fix.',
    left: 'deep-review leaves it as is, for the reason it gives.',
    planned: 'deep-review would fix it, and `deep-review review --fix` applies the fix.',
    'planned-against-rule': 'deep-review would fix it against a written rule, and a person accepts or rejects the departure.',
  },
  unverifiedLegend: 'no verifier examined this finding, since its verifier failed twice, and it counts as PLAUSIBLE.',
  unexplainedLegend: 'deep-review\'s writer did not explain this finding from its evidence, so the review gives it in deep-review\'s own words; look at it yourself.',
  modelLine: (readme) => `A model wrote the explanations in this review from the evidence beneath each of them, and only that evidence was verified, except where the mark unverified says that no verifier examined it. [How deep-review works](${readme})`,

  lastLine: (facts) => `Reviewed by deep-review ${facts.engine} on ${facts.runtime} ${facts.version} with ${facts.strong} and ${facts.fast}, run ${facts.run}, commits ${facts.base}..${facts.head}.`,
};

const korean: PullRequestWords = {
  heading: (run, head) => `## deep-review의 풀 리퀘스트 리뷰 (실행 ${run}, head ${head})`,
  needsLine: (fixes, questions) => (fixes + questions === 0
    ? '**병합 전에 필요한 것: 없음.** deep-review가 이 풀 리퀘스트에서 고칠 것도, 물어볼 것도 찾지 못했습니다.'
    : `**병합 전에 필요한 것: ${[...(fixes === 0 ? [] : [`수정 ${String(fixes)}건`]), ...(questions === 0 ? [] : [`질문 ${String(questions)}건`])].join(', ')}**`),
  findingName: (number) => `지적 사항 ${String(number)}`,
  findingList: (numbers) => `지적 사항 ${[...new Set(numbers)].sort((a, b) => a - b).map(String).join(', ')}`,
  actionFix: (approach) => `deep-review가 정한 수정 방법: ${approach}`,
  actionDeparture: (approach) => `deep-review가 명문화된 규칙과 다르게 고치려 하며, 사람이 이를 받아들이거나 거부합니다. 수정 방법: ${approach}`,
  actionAsk: (question) => `deep-review의 질문: ${question}`,

  changeHeading: '### 이 풀 리퀘스트가 하는 일',
  changeTitle: (base, head) => `${base}부터 ${head}까지의 변경`,
  why: (why) => `변경이 스스로 밝힌 이유: ${why}`,
  noWhy: '변경에 이유가 적혀 있지 않습니다.',
  publicInterface: (detail) => `deep-review가 보기에 이 변경은 공개 인터페이스를 바꿉니다${detail}.`,
  wideEffect: (detail) => `deep-review가 보기에 이 변경은 직접 바꾼 파일 밖의 여러 파일에 영향을 줍니다${detail}.`,
  noJudgment: 'deep-review가 보기에 이 변경은 공개 인터페이스를 바꾸지 않으며, 직접 바꾼 파일 밖에는 영향을 주지 않습니다.',
  accountWhose: '이 설명은 deep-review가 제출된 변경을 읽고 쓴 것이며, 검증자가 확인하지 않았습니다.',
  missingAccount: {
    none: 'deep-review가 이 변경에 대한 설명을 남기지 않았습니다.',
    unrecorded: '이 변경을 리뷰한 엔진은 변경 설명을 기록하기 전의 버전이어서, 이 변경에는 설명이 없습니다.',
  },
  accountSummary: '이 변경을 처음 보는 분을 위한 설명',
  termsHeading: '용어',
  problemHeading: '변경 전의 문제',
  changeTextHeading: '변경 내용',
  accountDiagramsCut: 'GitHub가 받는 길이에 맞추느라 이 설명의 다이어그램은 뺐습니다.',
  accountCut: 'GitHub가 받는 길이에 맞추느라 변경을 처음 보는 분을 위한 deep-review의 설명은 뺐습니다. 위의 변경 요지는 그대로 두었습니다.',

  statusLine: (head, counts) => {
    const parts = [
      ...(counts.toFix === 0 ? [] : [`고칠 대상 ${String(counts.toFix)}건${counts.againstRule === 0 ? '' : `(그중 명문화된 규칙과 다르게 고칠 것 ${String(counts.againstRule)}건)`}`]),
      ...(counts.questions === 0 ? [] : [`질문 ${String(counts.questions)}건`]),
      ...(counts.answered.length === 0 ? [] : [`답을 따르는 것: 지적 사항 ${counts.answered.map(String).join(', ')}`]),
      ...(counts.left === 0 ? [] : [`그대로 둘 것 ${String(counts.left)}건`]),
    ];
    const findings = counts.findings === 0 ? '지적 사항은 없습니다.' : `지적 사항은 모두 ${String(counts.findings)}건입니다${parts.length === 0 ? '.' : `. ${parts.join(', ')}.`}`;
    return `deep-review가 이 풀 리퀘스트를 head ${head}에서 리뷰했으며, 파일은 바꾸지 않았습니다. ${findings}`;
  },

  gapsHeading: '### 병합 전에 알아둘 것',
  noCheck: '이 실행은 리뷰만 했으므로 어떤 검사도 돌리지 않았습니다.',
  allExamined: '모든 리뷰 단계가 실행되었고, 검증자가 모든 후보를 검토했습니다.',
  gapsLead: '이 실행이 검토하지 못한 부분입니다. 원문 그대로 영어로 적습니다.',
  conclusionDropped: '설명 모델이 deep-review의 검사를 통과한 결론을 내지 못해, 위의 조치는 deep-review가 직접 쓴 문장으로 적었습니다.',
  accountDropped: '설명 모델이 deep-review의 검사를 통과한 풀 리퀘스트 설명을 내지 못해, 이 리뷰에는 그 설명이 없습니다.',
  findingsDropped: (findings) => `설명 모델이 ${findings}에 대해 deep-review의 검사를 통과한 설명을 내지 못해, deep-review가 직접 쓴 문장으로 적었습니다.`,
  noExplanation: '이 실행에는 설명 모델의 설명이 기록되지 않아, 리뷰 전체를 deep-review가 직접 쓴 문장으로 적었습니다.',
  predates: (findings) => `설명 모델의 설명은 ${findings}에 대한 답이 기록되기 전에 쓰였습니다. 각 답은 deep-review가 직접 쓴 문장으로 적었습니다.`,

  tableHeading: '### 지적 사항',
  columns: ['번호', '심각도', '판정', '상태', '요약', '위치'],
  statuses: {
    question: '질문',
    fixed: '수정됨',
    'fixed-against-rule': '규칙과 다르게 수정됨',
    'not-fixed': '수정되지 않음',
    left: '그대로 둠',
    planned: '수정 예정',
    'planned-against-rule': '규칙과 다르게 수정 예정',
  },
  noPlace: '저장소에 위치 없음',
  unverifiedMark: '검증 안 됨',
  unexplainedMark: '설명 없음',
  noFindings: '검증을 통과한 지적 사항이 없습니다.',

  inFullHeading: '### diff에 줄이 없는 수정과 질문',
  statusSentences: {
    question: 'deep-review가 이 지적 사항에 대해 질문합니다.',
    fixed: 'deep-review가 고친 지적 사항입니다.',
    'fixed-against-rule': 'deep-review가 명문화된 규칙과 다르게 고친 지적 사항입니다.',
    'not-fixed': 'deep-review가 고치기로 했지만 고치지 못한 지적 사항입니다.',
    left: 'deep-review가 그대로 두는 지적 사항입니다.',
    planned: 'deep-review가 고칠 지적 사항입니다.',
    'planned-against-rule': 'deep-review가 명문화된 규칙과 다르게 고칠 지적 사항입니다.',
  },
  grade: (severity, verdict, marks) => `심각도 ${severity}, 판정 ${verdict}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}.`,
  lineNotChanged: '이 풀 리퀘스트는 이 줄을 바꾸지 않습니다.',
  fileNotChanged: '이 풀 리퀘스트는 이 파일을 바꾸지 않습니다.',
  noPatch: 'GitHub가 이 파일의 diff를 보여 주지 않아, 이 지적 사항은 해당 줄에 댓글로 달지 못했습니다.',
  noPlaceNote: '이 지적 사항이 가리키는 위치는 저장소에 없습니다.',
  unexplained: (reason) => `deep-review의 설명 모델이 이 지적 사항을 설명하지 못해, deep-review가 직접 쓴 문장으로 적었습니다. 직접 확인해 주세요.${reason === null ? '' : ` 설명 모델이 밝힌 이유: ${reason}`}`,
  decidedFix: (approach) => `deep-review가 정한 수정 방법: ${approach}`,
  rejected: (option, reason) => `택하지 않은 방법: ${option} (${reason}).`,
  departure: (rule, source, fact) => `이 수정은 명문화된 규칙과 다릅니다. 규칙: ${rule} (${source}). deep-review가 규칙과 다르게 고치는 이유: ${fact}`,
  answerDeparture: (accept, reject) => `이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 이 결정을 받아들이거나 거부합니다. ${accept} 명령은 수정을 유지하고 규칙을 바꾸며, ${reject} 명령은 규칙을 따릅니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.`,
  question: (question) => `deep-review의 질문: ${question}`,
  choice: (choice, fallback) => `deep-review가 적용하려는 선택지는 ${String(choice)}번입니다. 답이 오기 전까지의 기본값은 되돌리기 가장 쉬운 ${String(fallback)}번입니다.`,
  option: (number, option, cost, rule) => `선택지 ${String(number)}: ${option} 비용: ${cost} 이 선택이 정하는 규칙: ${rule}`,
  answerQuestion: (command) => `이 리뷰를 실행한 사람이 실행 기록이 있는 컴퓨터에서 ${command} 명령으로 답합니다. \`<k>\`에는 고른 선택지의 번호를 씁니다. 이 풀 리퀘스트에 단 답글은 아직 읽지 않습니다.`,
  answeredOption: (option, at) => `이 리뷰를 실행한 사람이 ${at}에 ${String(option)}번 선택지로 답했습니다.`,
  answeredAccept: (at) => `이 리뷰를 실행한 사람이 ${at}에 이 결정을 받아들였습니다.`,
  answeredReject: (at) => `이 리뷰를 실행한 사람이 ${at}에 이 결정을 거부했으므로, 수정은 규칙을 따릅니다.`,
  evidenceVerified: '검증자가 확인한 근거',
  evidenceUnverified: '검증자가 확인하지 않은 근거',
  summaryLabel: '요약',
  reasonLabel: '이유',
  evidenceLabel: '근거',
  noEvidence: '없음. 이 그룹의 검증자가 두 번 실패했습니다',
  basis: (words) => `검증자가 판정한 방법: ${words}.`,
  basisWords: { ran: '코드를 실행해 확인함', traced: '코드를 줄 단위로 따라가며 확인함', read: '해당 줄만 읽어도 판단할 수 있음' },
  citedRun: (command, printed, exit) => `${command} 실행 결과: ${printed}, ${exit}.`,
  exitCode: (code) => (code === null ? '기록된 종료 코드 없음' : `종료 코드 ${String(code)}`),

  leftHeading: (count) => `그대로 둔 지적 사항 (${String(count)}건)`,
  leaveReasons: {
    'outside-change-not-regression': '변경 범위 밖이며 회귀가 아님',
    superseded: '다른 지적 사항의 수정으로 해결됨',
    intended: '저장소에 적힌 대로 의도된 동작임',
  },
  leftBecause: (reason, by) => `deep-review가 그대로 두는 이유: ${reason}${by === null ? '' : ` (${by})`}.`,
  groundsLabel: '판단 근거',
  leftCut: 'GitHub가 받는 길이에 맞추느라 그대로 둔 지적 사항은 위 표의 행으로만 적었습니다. 전체 내용은 실행 보고서에 있습니다.',

  refutedHeading: (count) => `검증에서 반박된 후보 (${String(count)}건)`,
  refutedLead: '검증자가 반박한 후보와, 반박의 근거입니다.',
  refutedCut: 'GitHub가 받는 길이에 맞추느라 반박된 후보는 요약과 위치만 적었습니다. 반박의 근거는 실행 보고서에 있습니다.',

  excludedHeading: '### 이 리뷰가 제외한 경로',
  excluded: (patterns, count, layer) => `${patterns} 패턴이 바뀐 경로 ${String(count)}개를 제외했으며, 어떤 작업자도 이 경로를 리뷰하지 않았습니다.${layer === null ? '' : ` scope.exclude는 ${layer}에서 정했습니다.`}`,
  layers: { default: '기본값', operator: '운영자 설정 파일', repository: '저장소 설정 파일', clone: '클론 설정 파일', invocation: '--config 파일', flag: '명령줄 플래그' },

  legendHeading: '이 리뷰에 쓰인 말',
  verdicts: {
    CONFIRMED: '검증자가 지목된 입력이 잘못된 결과로 이어지는 것을 실행하거나 추적해 확인했고, 이를 막는 장치를 찾지 못했습니다.',
    PLAUSIBLE: '검증자가 확인할 수 있는 범위에서는 주장이 맞지만, 주장이 기대는 조건 하나를 여기서 확인하지 못했습니다.',
    REFUTED: '검증자가 주장이 틀렸음을 확인했습니다. 코드가 주장대로 동작하지 않거나, 그 상태를 만드는 곳이 없거나, 이를 막는 장치가 있습니다.',
  },
  severities: {
    critical: '세 단계 심각도 중 가장 심각한 단계이며, 리뷰에서 가장 먼저 나옵니다.',
    major: 'critical보다는 덜하고 minor보다는 심각한 단계입니다.',
    minor: '가장 가벼운 단계이며, 리뷰에서 가장 나중에 나옵니다.',
  },
  statusLegend: {
    question: 'deep-review가 사람에게 선택지 중 하나를 고르도록 묻습니다. 누군가 답할 때까지는 기본값을 따릅니다.',
    fixed: 'deep-review의 수정 작업자가 수정을 적용했습니다.',
    'fixed-against-rule': 'deep-review의 수정 작업자가 명문화된 규칙과 다르게 수정을 적용했습니다.',
    'not-fixed': 'deep-review가 고치기로 했지만, 어떤 수정 작업자도 수정을 적용하지 못했습니다.',
    left: 'deep-review가 밝힌 이유로 그대로 둡니다.',
    planned: 'deep-review가 고칠 대상이며, `deep-review review --fix`가 수정을 적용합니다.',
    'planned-against-rule': 'deep-review가 명문화된 규칙과 다르게 고칠 대상이며, 사람이 이 결정을 받아들이거나 거부합니다.',
  },
  unverifiedLegend: '검증자가 두 번 실패해 아무도 이 지적 사항을 검토하지 않았으며, PLAUSIBLE로 취급합니다.',
  unexplainedLegend: 'deep-review의 설명 모델이 근거만으로 이 지적 사항을 설명하지 못해, deep-review가 직접 쓴 문장으로 적었습니다. 직접 확인해 주세요.',
  modelLine: (readme) => `이 리뷰의 설명은 모델이 각 설명 아래에 있는 근거를 바탕으로 쓴 것입니다. 검증된 것은 그 근거뿐이며, '검증 안 됨' 표시가 붙은 지적 사항은 검증자도 검토하지 않았습니다. [deep-review가 일하는 방식](${readme})`,

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
