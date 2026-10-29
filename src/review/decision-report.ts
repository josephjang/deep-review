/**
 * The report's account of the decision step (R8 of the decision step; R6
 * of the report for the person), rendered from the fold alone like the
 * rest of the report, in the block of each finding: what it decided and
 * why, the plan of a fix and the rule it goes against, the options of a
 * question, and the answer a person gave (R10 of answers) or the command
 * that answers. A run configured before the decision step has none of
 * these.
 */
import { answerWords, madeTheEdit, passOf, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { RecordedDecision } from '../checkpoint/events.ts';
import { appliedOptionOf, lastFixesAnswerOf } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { codeSpan, inlineText, quoted, sentenceText as sentence } from './markdown.ts';
import { terminalQuoted } from './shell.ts';
import { answerCommand } from './needs.ts';
import type { LeaveReason } from './vocabulary.ts';

/** Why a finding was left, as the report words it. */
export const leaveReasonWords: Readonly<Record<LeaveReason, string>> = {
  'outside-change-not-regression': 'outside the change, and not a regression',
  superseded: 'superseded',
  intended: 'intended, as the repository states',
};

/** The words for a left finding's reason, naming the finding that supersedes one. */
export const leftAs = (leave: NonNullable<RecordedDecision['leave']>): string => (leave.supersededBy === null ? leaveReasonWords[leave.reason] : `${leaveReasonWords[leave.reason]} by ${leave.supersededBy}`);

/** A standing answer as the report says it after its label: the answer, when it was recorded, what applied it, `held` when the tree held it, and its note. */
function answerSummary(review: Pick<ReviewState, 'answerPasses'>, standing: RecordedAnswer, held: string): string {
  return `${answerWords(standing.answer)} on ${standing.at}; ${appliedWords(review, standing, held)}${standing.note === null ? '' : `. Note: ${inlineText(standing.note)}`}`;
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

/** The answer command's arguments after the program, for a finding and a choice such as `--accept`: the one spelling of its flags that the line of the facts of the run is built from. */
export const answerArguments = (finding: string, choice: string): string => `answer --finding ${finding} ${choice}`;


/**
 * How a person runs the answer command (R9, PD5 of the skill surface
 * corrections): at a terminal, `deep-review` is the engine this report's
 * writer ran, named by its path, since no executable of that name is
 * installed; through the skill, the agent runs it. Said once, in the
 * facts of the run, so each command of the brief keeps the short name a
 * reader cites and no other part names a local path.
 */
export const answerAtTerminal = (engineEntry: string): string =>
  `At a terminal, type a command of this report from the repository with the engine that wrote the report in place of \`deep-review\`: ${codeSpan(`node ${terminalQuoted(engineEntry)} ${answerArguments('<number>', '--option <n>')}`)}, with \`--accept\` or \`--reject\` in place of \`--option <n>\` for a departure. Through the deep-review skill, ask the agent to answer the finding with the option you choose.`;

/** What a decision's text can name, for its quotes: the run its commands name and the number of each finding. */
export interface DecisionQuote {
  readonly run: string;
  readonly numbers: ReadonlyMap<string, number>;
  readonly own: number;
}

/**
 * The lines of a finding's block on its decision (R6 of the report for the
 * person; R8 of the decision step): what was decided and on what grounds;
 * for a fix, its plan, the options it rejected and the rule it goes
 * against; for a question, why it asks, each option with its cost, the
 * rule it makes and its marks, and where deep-review looked; and the
 * answer a person gave, with what applied it, or the command that answers.
 * A decider's text is quoted with the numbers of the findings it names.
 */
export function decisionBlockLines(review: ReviewState, decision: RecordedDecision, quote: DecisionQuote): string[] {
  const said = (text: string): string => inlineText(quoted(text, { numbers: quote.numbers, own: quote.own }));
  const standing = standingAnswer(review, decision.id);
  switch (decision.decision) {
    case 'leave': {
      const by = decision.leave.supersededBy === null ? '' : ` by finding ${String(quote.numbers.get(decision.leave.supersededBy) ?? decision.leave.supersededBy)}`;
      return [`Decision: left, ${leaveReasonWords[decision.leave.reason]}${by}: ${said(decision.grounds)}`];
    }
    case 'fix': {
      const { fix, departure } = decision;
      const reviewed = departure === null ? [] : standing === null
        ? [`To review: \`${answerCommand(quote.run, quote.own, '--accept')}\` keeps the fix and changes the rule, \`${answerCommand(quote.run, quote.own, '--reject')}\` follows the rule`]
        : [`Answer: ${answerSummary(review, standing, standing.answer.kind === 'reject' ? 'the rule-following fix the tree held' : 'the departure the tree held')}`];
      return [
        `Decision: fix: ${said(decision.grounds)}`,
        `Plan: ${sentence(said(fix.approach))}`,
        ...fix.rejected.map((option) => `Rejected: ${said(option.option)}: ${said(option.reason)}`),
        ...(departure === null ? [] : [`Against a written rule: ${said(departure.rule)} (${said(departure.source)}): ${said(departure.reason)}`]),
        ...reviewed,
      ];
    }
    case 'ask': {
      const { ask } = decision;
      // A default is in place only when the tree holds it (R7 of the brief of a run).
      const held = defaultInPlace(review, decision) ? 'in place now' : 'which the tree does not hold';
      const marks = (index: number): string => [`Option ${String(index + 1)}`, ...(index === ask.applied ? [`the default, ${held}`] : []), ...(index === ask.recommended ? ['deep-review\'s choice'] : [])].join(', ');
      return [
        `Decision: ask you; why it asks: ${said(decision.grounds)}`,
        `Question: ${said(ask.question)}`,
        ...ask.options.map((option, index) => `${marks(index)}: ${sentence(said(option.option))} Cost: ${sentence(said(option.cost))} Rule: ${sentence(said(option.rule))}`),
        `Where deep-review looked: ${ask.searched.map(said).join('; ')}`,
        standing === null ? `To answer: \`${answerCommand(quote.run, quote.own, '--option <n>')}\`, with the number of the option` : `Answer: ${answerSummary(review, standing, 'the option the tree held')}`,
      ];
    }
  }
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
