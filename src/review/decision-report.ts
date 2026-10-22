/**
 * The report's account of the decision step (R8 of the decision step),
 * rendered from the fold alone like the rest of the report: how each
 * question the decider asked stands, its default or once answered the
 * answer (R10 of answers), the question itself being in the brief; what it
 * decided to fix and how, with any rule it departed from and whether the
 * author accepted or rejected the departure, or the command that reviews
 * it; and what it left and why. A run configured before the decision step
 * has none of these.
 */
import { answerWords, madeTheEdit, passOf, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { RecordedDecision } from '../checkpoint/events.ts';
import { appliedOptionOf, lastFixesAnswerOf, type DecidedAsk } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { codeSpan, inlineText, sentenceText as sentence } from './markdown.ts';
import { terminalQuoted } from './shell.ts';
import { rankedFindings } from './state.ts';
import { decisionCounts, decisionCountWords, type LeaveReason } from './vocabulary.ts';

/** Why a finding was left, as the report words it. */
export const leaveReasonWords: Readonly<Record<LeaveReason, string>> = {
  'outside-change-not-regression': 'outside the change, and not a regression',
  superseded: 'superseded',
  intended: 'intended, as the repository states',
};

/** The words for a left finding's reason, naming the finding that supersedes one. */
export const leftAs = (leave: NonNullable<RecordedDecision['leave']>): string => (leave.supersededBy === null ? leaveReasonWords[leave.reason] : `${leaveReasonWords[leave.reason]} by ${leave.supersededBy}`);

/**
 * The line under a departure: whether the author accepted or rejected it,
 * when, and what applied the answer, or the command that reviews it (R10
 * of answers). A held acceptance is the departing fix the tree holds; a
 * held rejection is the fix that follows the rule, which an earlier
 * rejection a pass applied left in the tree.
 */
function reviewedLine(review: ReviewState, id: string): string {
  const standing = standingAnswer(review, id);
  if (standing === null) return `  - Review with: \`${reviewCommand(id)}\` or \`--reject\``;
  return `  - Reviewed: ${answerSummary(review, standing, standing.answer.kind === 'reject' ? 'the rule-following fix the tree held' : 'the departure the tree held')}`;
}

/** A standing answer as the report says it after its label: the answer, when it was recorded, what applied it, `held` when the tree held it, and its note. */
function answerSummary(review: Pick<ReviewState, 'answerPasses'>, standing: RecordedAnswer, held: string): string {
  return `${answerWords(standing.answer)} on ${standing.at}; ${appliedWords(review, standing, held)}${standing.note === null ? '' : `. Note: ${inlineText(standing.note)}`}`;
}

/** The option an ask takes as its default, and whether the default edits the code. */
function defaultOption(ask: DecidedAsk): string {
  const chosen = appliedOptionOf(ask);
  return `${inlineText(chosen.option)}${chosen.edits ? '' : ' (no edit)'}`;
}

/**
 * Whether the tree holds an ask's default (R7 of the brief of a run): one
 * that keeps the code does; one that edits it does once the fix pass
 * applied it or found it applied, and never in a run that only reviewed,
 * whatever an answer pass did with a person's answer after. An answer of
 * another option the tree holds took its place.
 */
export function defaultInPlace(review: Pick<ReviewState, 'answers' | 'fix'>, decision: Extract<RecordedDecision, { decision: 'ask' }>): boolean {
  const standing = standingAnswer(review, decision.id);
  if (standing !== null && standing.appliedBy !== null) return standing.answer.kind === 'option' && standing.answer.option === decision.ask.applied;
  if (!appliedOptionOf(decision.ask).edits) return true;
  const fixes = review.fix === null ? null : lastFixesAnswerOf(review.fix, decision.id);
  return fixes !== null && madeTheEdit(fixes.finding.status);
}

/** What applied a standing answer, as the report says it: the fix pass, an answer pass and when it was opened, the tree that held it already, or nothing yet. */
function appliedWords(review: Pick<ReviewState, 'answerPasses'>, answer: RecordedAnswer, held: string): string {
  const by = answer.appliedBy;
  if (by === null) return 'not yet applied';
  if (by === 'tree') return held;
  switch (by.phase) {
    case 'fixes':
      return 'applied by the fix pass';
    case 'answer': {
      const pass = passOf(review, by.key);
      if (pass === null) throw new Error(`Answer ${answer.id} is applied by ${by.key}, which no answer pass has`);
      return `applied by the answer pass of ${pass.at}`;
    }
  }
}

/** The answer command's arguments after the program, for a finding and a choice such as `--accept`: the one spelling of its flags that every command the report names is built from. */
export const answerArguments = (id: string, choice: string): string => `answer --finding ${id} ${choice}`;

/** The command that answers `id` with `choice`, such as `--option 2` or `--accept`, as the report and the brief name it: with no path, since no executable named deep-review is installed (R8 of the brief of a run). */
export const answerCommandOf = (id: string, choice: string): string => `deep-review ${answerArguments(id, choice)}`;

/** The command that reviews a departure, its finding filled in, as a reader runs it. */
export const reviewCommand = (id: string): string => answerCommandOf(id, '--accept');


/**
 * How a person runs the answer command (R9, PD5 of the skill surface
 * corrections): at a terminal, `deep-review` is the engine this report's
 * writer ran, named by its path, since no executable of that name is
 * installed; through the skill, the agent runs it. Said once, in the
 * facts of the run, so each command of the brief keeps the short name a
 * reader cites and no other part names a local path.
 */
export const answerAtTerminal = (engineEntry: string): string =>
  `At a terminal, type a command of this report from the repository with the engine that wrote the report in place of \`deep-review\`: ${codeSpan(`node ${terminalQuoted(engineEntry)} ${answerArguments('<id>', '--option <n>')}`)}, with \`--accept\` or \`--reject\` in place of \`--option <n>\` for a departure. Through the deep-review skill, ask the agent to answer the finding with the option you choose.`;

/** A finding's decision as one line of its block under Findings: what was decided and on what grounds. */
export function decisionLine(decision: RecordedDecision): string {
  const grounds = inlineText(decision.grounds);
  switch (decision.decision) {
    case 'leave':
      return `Decision: left, ${leftAs(decision.leave)}: ${grounds}`;
    case 'ask':
      return `Decision: ask the author, defaulting to ${defaultOption(decision.ask)}; see Questions for you: ${grounds}`;
    case 'fix':
      return `Decision: fix${decision.departure === null ? '' : ', departing from a rule'}: ${grounds}`;
  }
}

/**
 * The Decisions section, the evidence after the core of the change (R8
 * of the decision step; R12 of the brief of a run): a line counting the
 * decisions, what an answer does, then how each question stands, the
 * findings to fix with their approach, and the findings left with their
 * reason, each under the number and id the Findings section gives it. The
 * questions themselves, with their options, are in the brief. Null for a
 * run whose decision phase is skipped, and for one that ranked no
 * finding, which had nothing to decide.
 */
export function decisionsSection(review: ReviewState): string[] | null {
  if (review.phases.decision.status === 'skipped') return null;
  const findings = rankedFindings(review);
  if (findings.length === 0) return null;
  if (review.decisions === null) throw new Error('The report renders a run that ranked findings and decided none');
  const decidedFor = new Map(review.decisions.map((decision) => [decision.id, decision]));
  const numbered = findings.flatMap((entry, index) => {
    const decision = decidedFor.get(entry.finding.id);
    return decision === undefined ? [] : [{ number: index + 1, decision }];
  });
  const departures = numbered.filter((entry) => entry.decision.departure !== null).length;
  // The stop after the number is escaped, as paragraphText escapes it, so `- 1. ID` cannot open an ordered list inside its bullet.
  const label = (entry: (typeof numbered)[number]): string => `${String(entry.number)}\\. ${entry.decision.id}`;

  // Each question is in the brief, with its options, its rules, where the decider looked and its grounds (R8 of the brief of a run); this section keeps how it stands.
  const questions = numbered.flatMap((entry) => {
    const { decision } = entry;
    if (decision.decision !== 'ask') return [];
    const standing = standingAnswer(review, decision.id);
    return [`- ${label(entry)}: ${standing === null ? `not answered; the default in place is ${defaultOption(decision.ask)}` : `answered ${answerSummary(review, standing, 'the option the tree held')}`}`];
  });
  const fixes = numbered.flatMap((entry) => {
    const { decision } = entry;
    if (decision.decision !== 'fix') return [];
    const { fix, departure } = decision;
    return [
      `- ${label(entry)}: ${sentence(fix.approach)} Grounds: ${inlineText(decision.grounds)}`,
      ...fix.rejected.map((option) => `  - Rejected: ${inlineText(option.option)}: ${inlineText(option.reason)}`),
      ...(departure === null ? [] : [`  - Departs from: ${inlineText(departure.rule)} (${inlineText(departure.source)}): ${inlineText(departure.reason)}`, reviewedLine(review, decision.id)]),
    ];
  });
  const left = numbered.flatMap(({ number, decision }) => (decision.decision === 'leave' ? [`- ${label({ number, decision })}, ${leftAs(decision.leave)}: ${inlineText(decision.grounds)}`] : []));
  const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
  const defaults = review.fix === null ? 'This run does not fix: no fixer ran, and the tree is unchanged.' : 'A fixer edits a default that edits the code into the tree, and Fixes says whether it did; a default that keeps the code changes nothing.';
  // What an answer does, and that it is not yet carried to the next review (PD3 of answers); how a person types it at a terminal is in the facts of the run, which name the engine's path (R15 of the brief of a run).
  const answering = questions.length === 0 && departures === 0 ? [] : ['', 'An answer given with `deep-review answer` is recorded on this run and applied to it: on a run that fixed, by an answer pass whose edits `deep-review commit` commits, on top of any commits it already made for the run; on a run that only reviewed, by `review --fix`, which continues it. Nothing yet carries an answer to the next review, which may ask the same question again.'];
  return [
    '## Decisions',
    '',
    `Before any fix, the decision step decided each finding: ${decisionCountWords(decisionCounts(numbered.map((entry) => entry.decision)))}${departures === 0 ? '' : `; ${count(departures, 'fix departs', 'fixes depart')} from a rule the repository states`}. A fixer applies a finding to fix, and the default of a question that edits, when the run fixes; no fixer sees a finding left.`,
    ...answering,
    ...(questions.length === 0 ? [] : ['', '### Asked', '', `None of these held the run up: each has a default, and an answer is needed only to go another way. ${defaults} The brief at the top of this report gives each question with its options.`, '', ...questions]),
    ...(fixes.length === 0 ? [] : ['', '### To fix', '', ...fixes]),
    ...(left.length === 0 ? [] : ['', '### Left', '', ...left]),
  ];
}

/**
 * How a person at a terminal types a command of the report, for the facts
 * of the run (R9, PD5 of the skill surface corrections; R15 of the brief
 * of a run): no executable named `deep-review` is installed, so the line
 * names the engine that wrote the report by its path. None for a run with
 * no question and no departure, which offers no command to answer.
 */
export function answeringLine(review: ReviewState, engineEntry: string): string[] {
  const offers = (review.decisions ?? []).some((decision) => decision.decision === 'ask' || (decision.decision === 'fix' && decision.departure !== null));
  return offers ? [answerAtTerminal(engineEntry)] : [];
}
