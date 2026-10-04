/**
 * The report's account of the survey (R10, R15 of the repository survey),
 * rendered from the fold alone like the rest of the report: the
 * convention sources the run held the change to, each with what it
 * governs, the decision on each of the reviewer's own rules files and
 * why, where each check's command came from, and what the operator chose
 * for a check the project defines and this machine could not run. A run
 * configured before the survey existed has none of these, and its report
 * renders as it did before.
 */
import type { ConventionSource, UserRuleDecision } from '../checkpoint/events.ts';
import type { PlannedCheck } from '../checkpoint/fix-state.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { conventionsKnown, type SurveyState } from '../checkpoint/survey-state.ts';
import { inlineText, tableCell } from './markdown.ts';
import type { UnavailableCheck } from './survey.ts';

/**
 * The surveyed command of a kind whose tool was missing, or null: read
 * from the latest answer that names the kind, which is the survey the
 * run's plan stands on for it. A re-survey leaves out a kind a flag
 * already settled, so an older answer can be the latest to name it; an
 * older answer that found the tool missing never outweighs a later one
 * that found it present or found no command.
 */
function missingToolOf(survey: SurveyState, kind: PlannedCheck['kind']): UnavailableCheck | null {
  const entry = survey.answers.findLast((answer) => answer.checks?.some((check) => check.kind === kind) === true)?.checks?.find((check) => check.kind === kind);
  return entry === undefined || entry.command === null || entry.missingTool === null ? null : { kind, command: entry.command, source: entry.source.path, missingTool: entry.missingTool };
}

/** What the project defines for a kind whose tool was missing, as a phrase: its command, its source and the tool. */
const definedPhrase = (defined: UnavailableCheck): string => `the project defines \`${defined.command}\` (${defined.source}), ${defined.missingTool} not found`;

/**
 * Where a surveyed run's check came from, as its cell in the Checks
 * table: the survey's file and what the command stood on, a flag, or the
 * survey finding none. A --check that names a command in place of one
 * the project defines and this machine could not run says which (R15).
 */
export function checkSourceCell(survey: SurveyState, check: PlannedCheck): string {
  if (check.origin === 'survey' && check.source !== null) return tableCell(`${check.source.path} (${check.source.basis})`);
  if (check.origin === 'flag' && check.command === null) return '--no-check';
  if (check.origin === 'flag') {
    const defined = missingToolOf(survey, check.kind);
    return tableCell(defined === null ? '--check' : `--check, in place of what ${definedPhrase(defined)}`);
  }
  return check.origin === 'none' ? 'survey: none' : tableCell(check.origin);
}

/**
 * Why a kind has no command when the operator chose that (R15): dropped
 * with --no-check after the survey found the tool of the project's check
 * missing, naming the check; null for every other kind with no command,
 * whose recorded reason says why.
 */
export function droppedByOperator(survey: SurveyState | null, check: PlannedCheck): string | null {
  const defined = survey === null || check.origin !== 'flag' || check.command !== null ? null : missingToolOf(survey, check.kind);
  return defined === null ? null : `dropped by the operator; ${definedPhrase(defined)}`;
}

/** A kind with no command, as the Checks table names it: dropped by the operator, or not available with who decided and the reason. */
export function unavailableCell(survey: SurveyState | null, check: PlannedCheck): string {
  const dropped = droppedByOperator(survey, check);
  return dropped === null ? `not available (${tableCell(check.origin)}: ${tableCell(check.reason ?? 'no command')})` : tableCell(dropped);
}

/** The Conventions section of a surveyed run: the sources, the user-level decisions under the pinned policy, and the surveyor's note; none for a run configured before the survey. */
export function conventionsReportSection(review: ReviewState): string[] | null {
  const survey = review.survey;
  if (survey === null) return null;
  // A survey that exists is surveyed, failed or pending; only a run configured before it is 'predates-survey', and that returned above.
  const known = conventionsKnown(survey);
  const setting = review.configuration.survey.userRules;
  const lines = ['## Conventions', ''];
  let sources: readonly ConventionSource[] = [];
  let userRules: readonly UserRuleDecision[] = [];
  switch (known.status) {
    case 'surveyed':
      ({ sources, userRules } = known);
      lines.push(sources.length === 0
        ? 'The survey found no file that states conventions a change here must follow, so CONVENTIONS had no rule to hold the change to.'
        : 'The survey named these files as stating the conventions the change was held to:');
      break;
    case 'failed':
      ({ sources, userRules } = known);
      lines.push(`The survey failed: ${inlineText(known.reason)}.${sources.length === 0 ? ' The run went on with no convention source.' : ' The run went on with the user-level rules files the policy applies:'}`);
      break;
    case 'pending':
      lines.push('The survey has not answered, so no convention source is known.');
      break;
  }
  if (sources.length > 0) {
    lines.push('', '| Source | Level | Governs | Applies to |', '|---|---|---|---|');
    for (const source of sources) {
      const level = source.level === 'user' ? `user: ${source.grounds ?? 'no grounds recorded'}` : 'repository';
      lines.push(`| ${tableCell(source.path)} | ${tableCell(level)} | ${tableCell(source.governs)} | ${source.appliesTo === null ? 'the whole repository' : tableCell(source.appliesTo.join(', '))} |`);
    }
  }
  lines.push('');
  if (userRules.length === 0) lines.push(`No user-level rules file of the reviewer's existed on this machine; the policy value was \`${setting}\`.`);
  else {
    lines.push(`The reviewer's own rules files, under the policy value \`${setting}\`:`, '');
    for (const rule of userRules) lines.push(`- ${inlineText(rule.path)}: ${rule.applied ? 'applied' : 'not applied'}, ${inlineText(rule.reason)}`);
  }
  const answers = survey.answers;
  // Answers multiply after a check-unavailable block, and also when an invocation dies between an answer and its plan and the next one's flags leave a kind uncovered; the fold keeps only the survey's last block, so only that is named.
  if (answers.length > 1) {
    const blocked = survey.lastBlock?.code === 'check-unavailable' ? '; it last blocked on a check this machine could not run, and' : ';';
    lines.push('', `The survey answered ${String(answers.length)} times${blocked} the last answer is shown.`);
  }
  const note = answers.at(-1)?.note.trim() ?? '';
  if (note !== '') lines.push('', `Surveyor's note: ${inlineText(note)}`);
  return lines;
}

/** The line the survey adds to Limitations: a survey that failed; a check the run went without is among the checks not available (fix-report.ts). */
export function surveyLimitations(review: ReviewState): string[] {
  const failure = review.survey?.failure ?? null;
  if (failure === null) return [];
  return [`- The survey failed: ${inlineText(failure.reason)}. No repository convention source was known${review.fix === null ? '' : ', and every check was the flags\''}.`];
}
