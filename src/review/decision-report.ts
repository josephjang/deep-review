/**
 * The report's account of the decision step (R8 of the decision step),
 * rendered from the fold alone like the rest of the report: the questions
 * the decider asked the author, each with the default it names and, once
 * answered, the answer (R10 of answers), or the command that answers it;
 * what it decided to fix and how, with any rule it departed from and
 * whether the author accepted or rejected the departure, or the command
 * that reviews it; and what it left and why. A run configured before the
 * decision step has none of these, and its report renders as it did then.
 */
import { answerWords, passOf, standingAnswer, type RecordedAnswer } from '../checkpoint/answer-state.ts';
import type { RecordedDecision } from '../checkpoint/events.ts';
import { appliedOptionOf, type DecidedAsk } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { inlineText } from './markdown.ts';
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
 * A decider's text as one sentence of a line: inline, ending with a full
 * stop unless it ends with a mark of its own, closing brackets and quotes
 * after it included; a trailing colon, comma or semicolon becomes the stop.
 */
const sentence = (text: string): string => {
  const inline = inlineText(text).trimEnd();
  if (/[.!?][)\]"'”’]*$/.test(inline)) return inline;
  return `${inline.replace(/[:,;]$/, '')}.`;
};

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

/** The option of an ask at a position the ledger holds among its options. */
function optionAt(ask: DecidedAsk, position: number): DecidedAsk['options'][number] {
  const option = ask.options[position];
  if (option === undefined) throw new Error(`An ask names option ${String(position)} of ${String(ask.options.length)}`);
  return option;
}

/** The option an ask takes as its default, and whether the default edits the code. */
function defaultOption(ask: DecidedAsk): string {
  const chosen = appliedOptionOf(ask);
  return `${inlineText(chosen.option)}${chosen.edits ? '' : ' (no edit)'}`;
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

/** The command that answers a question, its finding and its options' numbers filled in, as a reader runs it. */
export const answerCommand = (id: string, options: number): string => `deep-review answer --finding ${id} --option <${options === 1 ? '1' : `1..${String(options)}`}>`;

/** The command that reviews a departure, its finding filled in, as a reader runs it. */
export const reviewCommand = (id: string): string => `deep-review answer --finding ${id} --accept`;

/** A finding's decision as one line of its block under Findings: what was decided and on what grounds. */
export function decisionLine(decision: RecordedDecision): string {
  const grounds = inlineText(decision.grounds);
  switch (decision.decision) {
    case 'leave':
      return `Decision: left, ${leftAs(decision.leave)}: ${grounds}`;
    case 'ask':
      return `Decision: ask the author, defaulting to ${defaultOption(decision.ask)}; see Decisions: ${grounds}`;
    case 'fix':
      return `Decision: fix${decision.departure === null ? '' : ', departing from a rule'}: ${grounds}`;
  }
}

/**
 * The Decisions section, after the header (R8 of the decision step): a
 * line counting the decisions, then the questions for the author as a
 * checklist, the findings to fix with their approach, and the findings
 * left with their reason, each under the number and id the Findings
 * section gives it. Null for a run whose decision phase is skipped, and
 * for one that ranked no finding, which had nothing to decide.
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

  const questions = numbered.flatMap((entry) => {
    const { decision } = entry;
    if (decision.decision !== 'ask') return [];
    const { ask } = decision;
    const standing = standingAnswer(review, decision.id);
    return [
      `- [${standing === null ? ' ' : 'x'}] ${label(entry)}: ${inlineText(ask.question)}`,
      `  - Default: ${defaultOption(ask)}`,
      `  - Recommended: ${inlineText(optionAt(ask, ask.recommended).option)}`,
      ...ask.options.map((option, position) => `  - Option ${String(position + 1)}: ${sentence(option.option)} Costs: ${sentence(option.cost)} Rule: ${inlineText(option.rule)}`),
      `  - Looked in: ${ask.searched.map(inlineText).join('; ')}`,
      `  - Grounds: ${inlineText(decision.grounds)}`,
      standing === null
        ? `  - Answer with: \`${answerCommand(decision.id, ask.options.length)}\``
        : `  - Answered: ${answerSummary(review, standing, 'the option the tree held')}`,
    ];
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
  // Said once, where the section first offers a way to answer: what an answer does, and that it is not yet carried to the next review (PD3 of answers).
  const answering = questions.length === 0 && departures === 0 ? [] : ['', `An answer given with \`deep-review answer\` is recorded on this run and applied to it: on a run that fixed, by an answer pass whose edits \`deep-review commit\` commits, on top of any commits it already made for the run; on a run that only reviewed, by \`review --fix\`, which continues it. Nothing yet carries an answer to the next review, which may ask the same question again.`];
  return [
    '## Decisions',
    '',
    `Before any fix, the decision step decided each finding: ${decisionCountWords(decisionCounts(numbered.map((entry) => entry.decision)))}${departures === 0 ? '' : `; ${count(departures, 'fix departs', 'fixes depart')} from a rule the repository states`}. A fixer applies a finding to fix, and the default of a question that edits, when the run fixes; no fixer sees a finding left.`,
    ...answering,
    ...(questions.length === 0 ? [] : ['', '### Questions for the author', '', `None of these held the run up: each has a default, and an answer is needed only to go another way. ${defaults} Each option's rule is the line a convention source of the repository would state for it.`, '', ...questions]),
    ...(fixes.length === 0 ? [] : ['', '### To fix', '', ...fixes]),
    ...(left.length === 0 ? [] : ['', '### Left', '', ...left]),
  ];
}
