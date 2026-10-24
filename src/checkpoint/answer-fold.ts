/**
 * The reducers of the answers' events (R1, R3, R5, R9 of answers),
 * registered by `fold.ts` beside the review's and the fix pass's. Each
 * refuses a history the engine could not have written: an answer before
 * the report, to a finding the run did not decide, that its decision does
 * not admit, or equal to the standing one; a pass on a run that does not
 * fix, before its report, or over a finding whose answer owes no edit.
 */
import { answerPhases, unitName, type Phase } from '../review/vocabulary.ts';
import { sameAnswer, standingAnswer, answerWords, madeTheEdit, type AnswerPass, type RecordedAnswer } from './answer-state.ts';
import type { Answer, AnswerPassed, AnswerRecorded, RecordedDecision } from './events.ts';
import { appliedOptionOf, lastFixesAnswerOf, passLeftEdits, type FixState } from './fix-state.ts';
import type { Reducer } from './fold.ts';
import { invalid, requireReview, withReview, type ReviewState } from './review-fold.ts';

/** Whether a decision is a fix that departs from a rule, which a person accepts or rejects (R3 of answers). */
export const departs = (decision: RecordedDecision): boolean => decision.decision === 'fix' && decision.departure !== null;

/** Whether a decision takes any answer (R3 of answers): an ask, or a fix that departs from a rule; `admits` says which. */
export const takesAnswer = (decision: RecordedDecision): boolean => decision.decision === 'ask' || departs(decision);

/**
 * Whether a decision admits an answer (R3 of answers): an option among an
 * ask's options; an acceptance or a rejection of a fix that departs from
 * a rule. A leave, and a fix that departs from nothing, admit none (PD9).
 */
export function admits(decision: RecordedDecision, answer: Answer): boolean {
  switch (answer.kind) {
    case 'option':
      return decision.decision === 'ask' && answer.option < decision.ask.options.length;
    case 'accept':
    case 'reject':
      return departs(decision);
  }
}

/** Whether a fixes-phase fixer made the edit a finding's decision asked for: its last fixes-phase answer applied it, or found it applied already. */
function fixesPhaseMadeIt(fix: FixState | null, id: string): boolean {
  const last = fix === null ? null : lastFixesAnswerOf(fix, id);
  return last !== null && madeTheEdit(last.finding.status);
}

/**
 * Whether the tree already holds what an answer says when it is recorded
 * (R3 of answers, PD6, PD12), so it owes no edit: never when an answer
 * pass left edits for the finding without applying its answer
 * (`passLeftEdits`), since the tree holds part of that answer; when an
 * earlier answer of the finding was applied, the tree holds that one,
 * and the new answer is held exactly when it says the same; otherwise, by
 * the answer's kind, an option is held when it is the default the ask
 * applied and that default keeps the code or a fixes-phase fixer made its
 * edit (a read-only run, or a fix run whose fixer did not, has not
 * applied an editing default), and any other option owes an edit, even
 * one that keeps the code as it is; an acceptance is held when a
 * fixes-phase fixer made the departing fix; a rejection never is, since
 * the departing fix, or the rule it amends, is not what the tree holds
 * until a fixer restores it.
 */
export function treeHolds(review: Pick<ReviewState, 'answers' | 'fix' | 'answerPasses'>, decision: RecordedDecision, answer: Answer): boolean {
  if (passLeftEdits(review, decision.id)) return false;
  const applied = review.answers.findLast((earlier) => earlier.id === decision.id && earlier.appliedBy !== null);
  if (applied !== undefined) return sameAnswer(applied.answer, answer);
  switch (answer.kind) {
    case 'option':
      return decision.decision === 'ask' && answer.option === decision.ask.applied && (!appliedOptionOf(decision.ask).edits || fixesPhaseMadeIt(review.fix, decision.id));
    case 'accept':
      return fixesPhaseMadeIt(review.fix, decision.id);
    case 'reject':
      return false;
  }
}

/**
 * A person's answer (R1, R3 of answers): on an active run whose report is
 * written, to a finding it decided, admitted by that decision, and not the
 * standing answer again. Nothing moves; the answer is kept with when it
 * was recorded and whether the tree already holds it (`treeHolds`).
 */
const answerRecorded: Reducer<AnswerRecorded> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  if (current.status !== 'active') throw invalid(event, `records an answer on a run that is ${current.status}`);
  if (review.report === null) throw invalid(event, 'records an answer while its report is not written');
  const decision = review.decisions?.find((candidate) => candidate.id === payload.id);
  if (decision === undefined) throw invalid(event, `answers ${payload.id}, which the run did not decide`);
  if (!admits(decision, payload.answer)) throw invalid(event, `answers ${payload.id} ${answerWords(payload.answer)}, which its ${decision.decision} decision does not admit`);
  const standing = standingAnswer(review, payload.id);
  if (standing !== null && sameAnswer(standing.answer, payload.answer)) throw invalid(event, `answers ${payload.id} ${answerWords(payload.answer)}, its standing answer, again`);
  const recorded: RecordedAnswer = { ...payload, at: event.recordedAt, appliedBy: treeHolds(review, decision, payload.answer) ? 'tree' : null };
  return withReview(current, { ...review, answers: [...review.answers, recorded] }, event);
};

/**
 * An answer pass (R5 of answers): on an active fix run whose report is
 * written, over findings whose standing answers owe an edit. The `answer`
 * and `answer-checks` phases and the report go back to `pending`, each at
 * its attempt, so its next start is its next attempt; the report is kept
 * with the pass and cleared, so the run is active again and the next
 * report takes its place. With `fix.pinned`, this is one of the two
 * reducers that move a phase out of `skipped` or `completed`.
 */
const answerPass: Reducer<AnswerPassed> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  if (current.status !== 'active') throw invalid(event, `opens an answer pass on a run that is ${current.status}`);
  if (review.fix === null) throw invalid(event, 'opens an answer pass on a run that does not fix, whose answers the continuation into the fix pass applies');
  if (review.report === null) throw invalid(event, 'opens an answer pass while its report is not written');
  for (const id of payload.ids) {
    const standing = standingAnswer(review, id);
    if (standing === null) throw invalid(event, `opens an answer pass over ${id}, which has no answer`);
    if (standing.appliedBy === 'tree') throw invalid(event, `opens an answer pass over ${id}, whose answer the tree held when it was recorded`);
    if (standing.appliedBy !== null) throw invalid(event, `opens an answer pass over ${id}, whose answer ${unitName(standing.appliedBy.phase, standing.appliedBy.key)} applied`);
  }
  const phaseStates = { ...review.phases };
  for (const phase of [...answerPhases, 'report'] as const satisfies readonly Phase[]) phaseStates[phase] = { status: 'pending', attempt: review.phases[phase].attempt };
  const pass: AnswerPass = { ids: payload.ids, at: event.recordedAt, reportBefore: review.report, openedAt: { answer: review.phases.answer.attempt, checks: review.phases['answer-checks'].attempt } };
  return withReview(current, { ...review, phases: phaseStates, report: null, reportSetAsideBy: 'answer-pass', answerPasses: [...review.answerPasses, pass] }, event);
};

/** The answers' reducers, registered by `fold.ts` beside the review's and the fix pass's. */
export const answerReducers = {
  'answer.recorded@1': answerRecorded,
  'answer.pass@1': answerPass,
} as const;
