/**
 * What the survey's events say about a run (R2, R3, R6, R9, R15 of the
 * repository survey): every answer the surveyor recorded, the last of
 * which is the run's; the run going on without a survey, when it did;
 * and the last blocker the survey's own work finished its phase with,
 * which tells a re-entered survey whether the operator's flags may stand
 * in for it. Facts as recorded; the planner reads what to do next from them.
 */
import type { Blocker, ConventionSource, SurveyFailed, SurveyRecorded, UserRuleDecision } from './events.ts';

export interface SurveyState {
  /** Every recorded answer, in ledger order; a survey blocked on a missing tool and surveyed again has more than one. */
  readonly answers: readonly SurveyRecorded[];
  /** The run going on without a survey, or null. */
  readonly failure: SurveyFailed | null;
  /**
   * The last blocker the survey's own work finished its phase with
   * (`surveyBlocker`), or null while it never blocked so. A drift or a
   * budget block, which says nothing of the survey, leaves it as it was,
   * so a survey that failed twice and then met a drift still reads as
   * failed to the invocation after.
   */
  readonly lastBlock: Blocker | null;
}

/**
 * Whether a blocker is the survey's own outcome, which a re-entered
 * survey reads: its surveyor failing twice (`worker-failed`) or its
 * answer naming a check this machine cannot run (`check-unavailable`).
 * A drift at the attempt's start or the run budget reached before the
 * launch blocks the phase too, but says nothing of the survey.
 */
export function surveyBlocker(blocker: Blocker): boolean {
  switch (blocker.code) {
    case 'worker-failed':
    case 'check-unavailable':
      return true;
    case 'drift':
    case 'budget':
    case 'claims-lost':
      return false;
  }
}

/** The survey state of a run just configured with the survey. */
export function emptySurveyState(): SurveyState {
  return { answers: [], failure: null, lastBlock: null };
}

/** The run's survey: its last recorded answer, or null while none is. */
export function lastSurvey(survey: SurveyState): SurveyRecorded | null {
  return survey.answers.at(-1) ?? null;
}

/**
 * What the run knows of its conventions: surveyed, with the sources the
 * last answer named; failed, with the sources the policy alone gave;
 * pending, while the survey has neither answered nor failed; or none for
 * a run configured before the survey existed.
 */
export type ConventionsKnown =
  | { readonly status: 'surveyed'; readonly sources: readonly ConventionSource[]; readonly userRules: readonly UserRuleDecision[] }
  | { readonly status: 'failed'; readonly reason: string; readonly sources: readonly ConventionSource[]; readonly userRules: readonly UserRuleDecision[] }
  | { readonly status: 'pending' }
  | { readonly status: 'predates-survey' };

export function conventionsKnown(survey: SurveyState | null): ConventionsKnown {
  if (survey === null) return { status: 'predates-survey' };
  const answer = lastSurvey(survey);
  if (answer !== null) return { status: 'surveyed', sources: answer.conventions, userRules: answer.userRules };
  if (survey.failure !== null) return { status: 'failed', reason: survey.failure.reason, sources: survey.failure.conventions, userRules: survey.failure.userRules };
  return { status: 'pending' };
}
