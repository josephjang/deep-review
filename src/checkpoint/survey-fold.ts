/**
 * The reducers of the survey's events (R2, R3, R6, R8, R9 of the
 * repository survey), registered by `fold.ts` beside the review's. Each
 * refuses a history the engine could not have written: a survey outside
 * its phase or on a run configured before the survey existed, a second
 * answer from one attempt, an answer after the checks were planned or
 * after the run went on without one, checks on a run that does not fix
 * or none on one that does, a user-level decision the pinned policy
 * rules out, and a repository path that is not one.
 */
import { singleUnitKey } from '../review/vocabulary.ts';
import type { ConventionSource, SurveyFailed, SurveyRecorded, UserRuleDecision } from './events.ts';
import type { DecodedEvent, FoldDrafts, Reducer } from './fold.ts';
import { answered, invalid, requireReview, requireRunning, requireUnanswered, withReview, type ReviewState, type UnitRef } from './review-fold.ts';
import type { SurveyState } from './survey-state.ts';

/** The survey's one unit. */
export const surveyUnit: UnitRef = { phase: 'survey', key: singleUnitKey('survey') };

/** The run's survey state, which a run configured before the survey existed does not have. */
function requireSurvey(review: ReviewState, event: DecodedEvent): SurveyState {
  if (review.survey === null) throw invalid(event, `has ${event.kind} on a run configured before the survey existed`);
  return review.survey;
}

/** Whether a path is spelled as a repository path: relative, forward slashes, no empty, `.` or `..` segment. */
const isRepositoryPath = (path: string): boolean => !path.includes('\\') && !/^([A-Za-z]:)?\//.test(path) && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/**
 * Hold the sources and the user-level decisions to the pinned policy and
 * to the spelling of paths: a repository source is a repository path, a
 * user-level one is a file the decisions name; under `apply` every
 * user-level file applies and under `ignore` none does.
 */
function requireConventions(review: ReviewState, event: DecodedEvent, conventions: readonly ConventionSource[], userRules: readonly UserRuleDecision[]): void {
  for (const source of conventions) {
    if (source.level === 'repository' && !isRepositoryPath(source.path)) throw invalid(event, `names the convention source ${JSON.stringify(source.path)}, which is not a repository path`);
  }
  const setting = review.configuration.survey.userRules;
  if (setting === 'apply' && userRules.some((rule) => !rule.applied)) throw invalid(event, 'leaves a user-level rules file out under the policy value apply');
  if (setting === 'ignore' && userRules.some((rule) => rule.applied)) throw invalid(event, 'applies a user-level rules file under the policy value ignore');
}

/** What every survey event requires: the phase running, no failure and no plan yet, and its unit not answered in this attempt. */
function requireOpenSurvey(review: ReviewState, event: DecodedEvent): SurveyState {
  const survey = requireSurvey(review, event);
  requireRunning(review, event, 'survey');
  if (survey.failure !== null) throw invalid(event, `has ${event.kind} after the run went on without its survey`);
  if ((review.fix?.checks.planned ?? null) !== null) throw invalid(event, `has ${event.kind} after its checks are planned`);
  requireUnanswered(review, event, surveyUnit);
  return survey;
}

const surveyRecorded: Reducer<SurveyRecorded> = (state, payload, event, drafts: FoldDrafts) => {
  const { current, review } = requireReview(state, event);
  const survey = requireOpenSurvey(review, event);
  if (review.fix === null && payload.checks !== null) throw invalid(event, 'records surveyed checks on a run without the fix pass');
  if (review.fix !== null && payload.checks === null) throw invalid(event, 'records a survey without checks on a run with the fix pass');
  requireConventions(review, event, payload.conventions, payload.userRules);
  const next: SurveyState = { ...survey, answers: [...survey.answers, payload] };
  return withReview(current, { ...review, survey: next, units: answered(review, drafts, surveyUnit, payload.workerId) }, event);
};

/**
 * The run goes on without its survey. With no convention source left,
 * not even a user-level file the policy applies, the `CONVENTIONS` angle
 * has nothing to hold the change to and is recorded as not run, so the
 * sweep is told to cover its territory (R9 of the repository survey).
 * Its decisions are the pinned policy's alone: under `judge` only the
 * surveyor applies a user-level file, so with no survey none applies.
 */
const surveyFailed: Reducer<SurveyFailed> = (state, payload, event) => {
  const { current, review } = requireReview(state, event);
  const survey = requireOpenSurvey(review, event);
  if (survey.answers.length > 0) throw invalid(event, 'goes on without its survey after recording an answer');
  requireConventions(review, event, payload.conventions, payload.userRules);
  if (review.configuration.survey.userRules === 'judge' && payload.userRules.some((rule) => rule.applied)) throw invalid(event, 'applies a user-level rules file with no survey to judge it under the policy value judge');
  const anglesNotRun = payload.conventions.length > 0 ? review.anglesNotRun : { ...review.anglesNotRun, CONVENTIONS: `the survey failed, so no convention source is known: ${payload.reason}` };
  return withReview(current, { ...review, survey: { ...survey, failure: payload }, anglesNotRun }, event);
};

/** The survey's reducers, registered by `fold.ts` beside the review's. */
export const surveyReducers = {
  'survey.recorded@1': surveyRecorded,
  'survey.failed@1': surveyFailed,
} as const;
