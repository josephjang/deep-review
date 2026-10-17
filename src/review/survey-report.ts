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
import { layerWords } from '../config/settings.ts';
import type { ConventionSource, SurveyRecorded, UserRuleDecision } from '../checkpoint/events.ts';
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
 * Who settled a check that a setting gave (R11 of the configuration): the
 * flag, `--check` or `--no-check`, as the cell named it before the
 * settings, or the setting and the file whose layer gave it.
 */
const settingWords = (check: PlannedCheck): string => {
  if (check.layer === 'flag' || check.layer === null) return check.command === null ? '--no-check' : '--check';
  return `checks.${check.kind}${check.command === null ? ' = false' : ''} in ${layerWords[check.layer]}`;
};

/**
 * Where a surveyed run's check came from, as its cell in the Checks
 * table: the survey's file and what the command stood on, a setting, a
 * flag among them, or the survey finding none. A setting that names a
 * command in place of one the project defines and this machine could not
 * run says which (R15).
 */
export function checkSourceCell(survey: SurveyState, check: PlannedCheck): string {
  if (check.origin === 'survey' && check.source !== null) return tableCell(`${check.source.path} (${check.source.basis})`);
  if (check.origin === 'setting' && check.command === null) return tableCell(settingWords(check));
  if (check.origin === 'setting') {
    const defined = missingToolOf(survey, check.kind);
    return tableCell(defined === null ? settingWords(check) : `${settingWords(check)}, in place of what ${definedPhrase(defined)}`);
  }
  return check.origin === 'none' ? 'survey: none' : tableCell(check.origin);
}

/**
 * Why a kind has no command when the operator chose that (R15): dropped
 * with --no-check, or by a setting, after the survey found the tool of
 * the project's check missing, naming the check; null for every other
 * kind with no command, whose recorded reason says why.
 */
export function droppedByOperator(survey: SurveyState | null, check: PlannedCheck): string | null {
  const defined = survey === null || check.origin !== 'setting' || check.command !== null ? null : missingToolOf(survey, check.kind);
  return defined === null ? null : `dropped by ${check.layer === 'flag' || check.layer === null ? 'the operator' : settingWords(check)}; ${definedPhrase(defined)}`;
}

/** A kind with no command, as the Checks table names it: dropped by the operator, or not available with who decided and the reason. */
export function unavailableCell(survey: SurveyState | null, check: PlannedCheck): string {
  const dropped = droppedByOperator(survey, check);
  const origin = check.origin !== 'setting' ? check.origin : check.layer === 'flag' || check.layer === null ? 'flag' : settingWords(check);
  return dropped === null ? `not available (${tableCell(origin)}: ${tableCell(check.reason ?? 'no command')})` : tableCell(dropped);
}

/** The Conventions section of a surveyed run: the sources, the user-level decisions under the pinned policy, and the surveyor's note, or for a continued run the review's and the continuation's apart; none for a run configured before the survey. */
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
  if (review.continuedFrom !== null) return [...lines, ...continuedSurveyLines(survey)];
  const answers = survey.answers;
  // Answers multiply after a check-unavailable block, and also when an invocation dies between an answer and its plan and the next one's flags leave a kind uncovered; the fold keeps only the survey's last block, so only that is named.
  if (answers.length > 1) {
    const blocked = survey.lastBlock?.code === 'check-unavailable' ? '; it last blocked on a check this machine could not run, and' : ';';
    lines.push('', `The survey answered ${String(answers.length)} times${blocked} the last answer is shown.`);
  }
  lines.push(...noteLines('Surveyor\'s note', answers.at(-1)));
  return lines;
}

/** A surveyor's note under `label`, or nothing when the answer has none. */
function noteLines(label: string, answer: SurveyRecorded | undefined): string[] {
  const note = answer?.note.trim() ?? '';
  return note === '' ? [] : ['', `${label}: ${inlineText(note)}`];
}

/**
 * The survey's answers of a read-only run continued into the fix pass
 * (R4, PD5 of fix pass continuation), counted and noted apart: the
 * review's, which chose no check as a read-only run's answers do and
 * named the conventions the review was held to, and the continuation's,
 * which chose the checks alone. The review's count is named only when it
 * answered more than once; the continuation's, which is planned, is not
 * a repeated survey. Only the continuation can block on a check this
 * machine could not run, since only it asks for checks.
 */
function continuedSurveyLines(survey: SurveyState): string[] {
  const reviewed = survey.answers.filter((answer) => answer.checks === null);
  const continued = survey.answers.filter((answer) => answer.checks !== null);
  const lines: string[] = [];
  if (reviewed.length > 1) lines.push('', `The review's survey answered ${String(reviewed.length)} times; the conventions of its last answer are shown.`);
  if (continued.length > 0) {
    const times = continued.length === 1 ? 'once' : `${String(continued.length)} times`;
    const blocked = survey.lastBlock?.code === 'check-unavailable' ? '; it last blocked on a check this machine could not run' : '';
    lines.push('', `The continuation into the fix pass asked the survey for the checks alone ${times}, the conventions standing${blocked}.`);
  }
  lines.push(...noteLines('Surveyor\'s note on the conventions', reviewed.at(-1)), ...noteLines('Surveyor\'s note on the checks', continued.at(-1)));
  return lines;
}

/** The line the survey adds to Limitations: a survey that failed; a check the run went without is among the checks not available (fix-report.ts). */
export function surveyLimitations(review: ReviewState): string[] {
  const failure = review.survey?.failure ?? null;
  if (failure === null) return [];
  // A setting from a configuration file settles a check as a flag does (R11 of the configuration).
  const byFlags = (review.fix?.checks.planned?.checks ?? []).every((check) => check.layer === null || check.layer === 'flag');
  return [`- The survey failed: ${inlineText(failure.reason)}. No repository convention source was known${review.fix === null ? '' : byFlags ? ', and every check was the flags\'' : ', and every check was a setting\'s'}.`];
}
