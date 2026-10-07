/**
 * The report's account of the decision step (R8 of the decision step),
 * rendered from the fold alone like the rest of the report: the questions
 * the decider asked the author, each with the default it applied, what it
 * decided to fix and how, with any rule it departed from, and what it
 * left and why. A run configured before the decision step has none of
 * these, and its report renders as it did then.
 */
import type { RecordedDecision } from '../checkpoint/events.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { inlineText } from './markdown.ts';
import { rankedFindings } from './state.ts';
import type { LeaveReason } from './vocabulary.ts';

/** Why a finding was left, as the report words it. */
export const leaveReasonWords: Readonly<Record<LeaveReason, string>> = {
  'outside-change-not-regression': 'outside the change, and not a regression',
  superseded: 'superseded',
  intended: 'intended, as the repository states',
};

/** The words for a left finding's reason, naming the finding that supersedes one. */
export const leftAs = (leave: NonNullable<RecordedDecision['leave']>): string => (leave.supersededBy === null ? leaveReasonWords[leave.reason] : `${leaveReasonWords[leave.reason]} by ${leave.supersededBy}`);

/** A decider's text as one sentence of a line: inline, ending with a full stop unless it ends with a mark of its own. */
const sentence = (text: string): string => {
  const inline = inlineText(text).trimEnd();
  return /[.!?]$/.test(inline) ? inline : `${inline}.`;
};

/** The option an ask applied, and whether the default edits the code. */
function appliedOption(ask: NonNullable<RecordedDecision['ask']>): string {
  const applied = ask.options[ask.applied];
  if (applied === undefined) throw new Error(`An ask applies option ${String(ask.applied)} of ${String(ask.options.length)}`);
  return `${inlineText(applied.option)}${applied.edits ? '' : ' (no edit)'}`;
}

/** A finding's decision as one line of its block under Findings: what was decided and on what grounds. */
export function decisionLine(decision: RecordedDecision): string {
  const grounds = inlineText(decision.grounds);
  if (decision.leave !== null) return `Decision: left, ${leftAs(decision.leave)}: ${grounds}`;
  if (decision.ask !== null) return `Decision: ask the author, applying ${appliedOption(decision.ask)}; see Decisions: ${grounds}`;
  return `Decision: fix${decision.departure === null ? '' : ', departing from a rule'}: ${grounds}`;
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
  const of = (kind: RecordedDecision['decision']): typeof numbered => numbered.filter((entry) => entry.decision.decision === kind);
  const departures = numbered.filter((entry) => entry.decision.departure !== null).length;
  const label = (entry: (typeof numbered)[number]): string => `${String(entry.number)}. ${entry.decision.id}`;

  const questions = of('ask').flatMap((entry) => {
    const ask = entry.decision.ask!;
    return [
      `- [ ] ${label(entry)}: ${inlineText(ask.question)}`,
      `  - Applied: ${appliedOption(ask)}`,
      `  - Recommended: ${inlineText(ask.options[ask.recommended]?.option ?? '')}`,
      ...ask.options.map((option, position) => `  - Option ${String(position + 1)}: ${sentence(option.option)} Costs: ${sentence(option.cost)} Rule: ${inlineText(option.rule)}`),
      `  - Looked in: ${ask.searched.map(inlineText).join('; ')}`,
      `  - Grounds: ${inlineText(entry.decision.grounds)}`,
    ];
  });
  const fixes = of('fix').flatMap((entry) => {
    const { fix, departure } = entry.decision;
    return [
      `- ${label(entry)}: ${inlineText(fix!.approach)} Grounds: ${inlineText(entry.decision.grounds)}`,
      ...fix!.rejected.map((option) => `  - Rejected: ${inlineText(option.option)}: ${inlineText(option.reason)}`),
      ...(departure === null ? [] : [`  - Departs from: ${inlineText(departure.rule)} (${inlineText(departure.source)}): ${inlineText(departure.reason)}`]),
    ];
  });
  const left = of('leave').map((entry) => `- ${label(entry)}, ${leftAs(entry.decision.leave!)}: ${inlineText(entry.decision.grounds)}`);
  const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
  return [
    '## Decisions',
    '',
    `Before any fix, the decision step decided each finding: ${String(of('fix').length)} to fix, ${String(of('leave').length)} to leave, ${String(of('ask').length)} to ask the author${departures === 0 ? '' : `; ${count(departures, 'fix departs', 'fixes depart')} from a rule the repository states`}. A fixer applies a finding to fix, and the default of a question that edits, when the run fixes; no fixer sees a finding left.`,
    ...(questions.length === 0 ? [] : ['', '### Questions for the author', '', 'None of these held the run up: each has a default, applied as written, and an answer is needed only to go another way. Each option\'s rule is the line a convention source of the repository would state for it, so the next review settles the question alone.', '', ...questions]),
    ...(fixes.length === 0 ? [] : ['', '### To fix', '', ...fixes]),
    ...(left.length === 0 ? [] : ['', '### Left', '', ...left]),
  ];
}
