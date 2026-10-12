/**
 * What the answers' events say about a run (R1, R3, R5, R9 of answers):
 * every answer a person recorded, in ledger order, each with when it was
 * recorded and whether the tree holds it yet, and every answer pass. Facts
 * as recorded; the questions below are answered from this state alone.
 */
import type { Answer, AnswerRecorded, ReportWritten } from './events.ts';

/** An editing unit that can apply a person's answer: a fixes-phase batch or an answer pass, never the repair, which answers checks. */
export interface ApplyingUnit {
  readonly phase: 'fixes' | 'answer';
  readonly key: string;
}

/**
 * What applied an answer, which is whether it still owes an edit (TD4 of
 * answers): `'tree'` when the tree already held what it says when it was
 * recorded; the editing unit whose recorded answer applied its finding
 * after it; null while an edit is owed.
 */
export type AppliedBy = ApplyingUnit | 'tree' | null;

/** One answer as the fold holds it: the event's payload, when it was recorded, and what applied it. */
export interface RecordedAnswer extends AnswerRecorded {
  readonly at: string;
  readonly appliedBy: AppliedBy;
}

/**
 * One answer pass (R5 of answers): the findings it applies, when it was
 * recorded, the report it took the place of, and the attempts of the
 * `answer` and `answer-checks` phases when it opened them, so its own
 * attempts and its own runs of the checks are told from an earlier pass's.
 */
export interface AnswerPass {
  readonly ids: readonly string[];
  readonly at: string;
  readonly reportBefore: ReportWritten;
  readonly openedAt: { readonly answer: number; readonly checks: number };
}

/** The answers and passes a run's review state holds. */
export interface AnswerState {
  readonly answers: readonly RecordedAnswer[];
  readonly answerPasses: readonly AnswerPass[];
}

/** A finding's standing answer, the last one recorded for it, or null when it has none. */
export function standingAnswer(state: Pick<AnswerState, 'answers'>, id: string): RecordedAnswer | null {
  return state.answers.findLast((answer) => answer.id === id) ?? null;
}

/** Every answered finding's standing answer, by finding id. */
export function standingAnswers(state: Pick<AnswerState, 'answers'>): Map<string, RecordedAnswer> {
  return new Map(state.answers.map((answer) => [answer.id, answer]));
}

/** The answered findings whose standing answer owes an edit, in the order they were first answered. */
export function owedAnswers(state: Pick<AnswerState, 'answers'>): RecordedAnswer[] {
  return [...standingAnswers(state).values()].filter((answer) => answer.appliedBy === null);
}

/** Whether two answers say the same: the same kind, and for an option the same one. */
export function sameAnswer(a: Answer, b: Answer): boolean {
  switch (a.kind) {
    case 'option':
      return b.kind === 'option' && a.option === b.option;
    case 'accept':
    case 'reject':
      return a.kind === b.kind;
  }
}

/** The unit key of the answer pass numbered `n` from 1, as its one fixer is recorded under; no batch key spells it, so no fixes-phase reducer mistakes it (R5 of answers). */
export const passKey = (n: number): string => `pass-${String(n)}`;

/** The number from 1 of the answer pass whose unit key is `key`, as `passKey` spells it, or null for a key it does not spell. */
export function passNumber(key: string): number | null {
  const match = /^pass-([1-9][0-9]*)$/.exec(key);
  return match === null ? null : Number(match[1]);
}

/** The current answer pass, the last one recorded, with its key, or null for a run that has had none. */
export function currentPass(state: Pick<AnswerState, 'answerPasses'>): { readonly key: string; readonly pass: AnswerPass } | null {
  const pass = state.answerPasses.at(-1);
  return pass === undefined ? null : { key: passKey(state.answerPasses.length), pass };
}

/** The answer pass whose unit key is `key`, or null for a key no pass has. */
export function passOf(state: Pick<AnswerState, 'answerPasses'>, key: string): AnswerPass | null {
  const n = passNumber(key);
  return n === null ? null : (state.answerPasses[n - 1] ?? null);
}

/** Whether a fixer's status says the tree now holds what it was asked: it applied the finding, or found it applied already. */
export const madeTheEdit = (status: string): boolean => status === 'applied' || status === 'already-applied';

/**
 * The answers with the standing answer of each finding a fixer's recorded
 * answer applied marked applied by that unit (TD4 of answers): a finding
 * of a fixes-phase batch, which applies the answers a read-only run
 * recorded before its continuation, or of an answer pass. A standing
 * answer already applied, or one the fixer deferred or was blocked on,
 * stays as it is; an answer still owed is applied by a later pass. The
 * array is the same one when nothing changed.
 */
export function withApplied(answers: readonly RecordedAnswer[], unit: ApplyingUnit, findings: readonly { readonly id: string; readonly status: string }[]): readonly RecordedAnswer[] {
  let next: RecordedAnswer[] | null = null;
  for (const finding of findings) {
    if (!madeTheEdit(finding.status)) continue;
    const at = answers.findLastIndex((answer) => answer.id === finding.id);
    if (at === -1 || answers[at]!.appliedBy !== null) continue;
    next ??= [...answers];
    next[at] = { ...answers[at]!, appliedBy: { phase: unit.phase, key: unit.key } };
  }
  return next ?? answers;
}

/** An answer as the log, `status` and the report word it: the option's number from 1, or accepted or rejected. */
export function answerWords(answer: Answer): string {
  switch (answer.kind) {
    case 'option':
      return `option ${String(answer.option + 1)}`;
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
  }
}
