/**
 * The report (R9, PD8 of the read-only review; R13 of the fix pass; R7
 * of the Codex sandbox; R7 of fix pass continuation; R10 of answers):
 * Markdown rendered by the engine from the fold alone, so two engines
 * render the same report from the same ledger and no model rewrites a
 * finding. It starts with the brief of the run (brief.ts; R12 of the
 * brief of a run), and the evidence follows in order: for a run with the
 * decision step Decisions (decision-report.ts), Findings, each with its
 * anchor, for a fix run Fixes, Checks and Changed files (fix-report.ts),
 * for a surveyed run Conventions (survey-report.ts), Refuted at
 * verification, the notes of the run, and last the facts of the run, the
 * only section that names a local path the engine writes (R15). The
 * statistics, the angles and the digest of the roles are in
 * `report --stats` (stats-report.ts; R9 of the report for the person).
 */
import { evidenceDirectoryName, storeNameOf } from '../checkpoint/checkpoint.ts';
import type { RecordedDecision, ReviewConfiguration, ScopeState, Spend, TreeRevised } from '../checkpoint/events.ts';
import { standingAnswers } from '../checkpoint/answer-state.ts';
import { budgetStoppedUnits, lastRestorationAt } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { rawLocation, repositoryLocation, unverifiedGroupsOf, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import { briefMarkdown, briefOf } from './brief.ts';
import { answeringLine, decisionLine, decisionsSection } from './decision-report.ts';
import { baseWorktreeLines, fixHeaderLine, fixLimitations, fixSections, stopLimitations } from './fix-report.ts';
import { endedByKill, killMarkWords } from '../runtime/kill-marks.ts';
import { matchRepositoryPath, type RepoLookup } from './locations.ts';
import { codeSpan, findingAnchor, inlineText, listed, localPathWords, paragraphText } from './markdown.ts';
import { ranAgain, rankedFindings, refuted, type ReportFinding } from './state.ts';
import { excludedLines, settingsHeaderLine, settingsNotes } from './settings-report.ts';
import { budgetSpendNote, type BudgetSpend } from './spend.ts';
import { conventionsReportSection, surveyLimitations } from './survey-report.ts';
import type { Phase } from './vocabulary.ts';

/** A Codex Windows sandbox as the ledger records it, which the report renders from rather than from the adapter's vocabulary. */
type PinnedWindowsSandbox = NonNullable<ReviewConfiguration['codex']>['windowsSandbox'];

/** How the facts of the run name the Codex Windows sandbox a run pinned; `none` says what it means for each kind of worker, since it differs. */
const codexSandboxWords: Readonly<Record<PinnedWindowsSandbox, string>> = {
  unelevated: 'unelevated',
  elevated: 'elevated',
  none: 'none (workers that edit ran in no sandbox, workers that read under unelevated)',
};

export interface ReportInput {
  /** The identity of the engine writing the report. */
  readonly engine: string;
  /** The absolute path of the engine's own entry, its `main.mjs` or `src/cli.ts`, which a person at a terminal runs `answer` with (R9 of the skill surface corrections). */
  readonly engineEntry: string;
  /** One row per phase the run did not skip, and the total. */
  readonly statistics: { readonly phases: readonly (Spend & { readonly phase: Phase })[]; readonly total: Spend; readonly budgetApplied: boolean };
  /** The spend as the budget check counted it (`budgetSpendOf`), which the line of the run budget names beside the reported spend when they differ, or null when no budget check ran (R15 of resumable runs). */
  readonly budgetCheck: BudgetSpend | null;
  /** The directory of the evidence store, which the facts of the run name once; the rest of the report names a file of it by its name in the store (R15 of the brief of a run). */
  readonly store: string;
  /** The home directory, under which the report names a path with `~` (R15 of the brief of a run). */
  readonly home: string;
  /**
   * For a fix run: the patch series in ledger order, and the command that
   * continues a fix pass the run budget stopped (`continueCommand`), else
   * null (R15 of resumable runs).
   */
  readonly fix?: { readonly patches: readonly ArtifactReference[]; readonly continueCommand: string | null };
}

const usd = (value: number | null): string => (value === null ? '-' : value.toFixed(2));

/** The finder's own file and line, as one line of text whatever the file's name holds. */
const rawAt = (candidate: CandidateState): string => inlineText(rawLocation(candidate));

/** Whether a candidate is located on an unchanged file of the repository, outside the reviewed change. */
const outsideChange = (candidate: CandidateState): boolean => repositoryLocation(candidate) !== null && !candidate.inScope;

/** The marks a candidate carries after its location. */
function marks(candidate: CandidateState, unverified: boolean): string {
  const where = repositoryLocation(candidate) === null ? [`unlocated: ${rawAt(candidate)}`] : outsideChange(candidate) ? ['outside the change'] : [];
  const list = [...where, ...(unverified ? ['unverified'] : [])];
  return list.length === 0 ? '' : ` (${list.join('; ')})`;
}

/** The location a finding prints: the repository path and line, or the raw one for an unlocated candidate. */
const shortLocation = (candidate: CandidateState): string => inlineText(repositoryLocation(candidate) ?? rawLocation(candidate));

/** A finding's block under Findings, closed in a run with the decision step by the decision made for it. */
function findingBlock(position: number, entry: ReportFinding, decision: RecordedDecision | null): string {
  const { finding, primary, members, resolution } = entry;
  const also = members.length === 0 ? '' : ` (also ${members.map((member) => member.id).join(', ')})`;
  const lines = [
    // A fixed anchor by the number, so each mention of the finding links to it (R6 of the report for the person).
    `<a id="${findingAnchor(position)}"></a>`,
    '',
    `### ${String(position)}. [${finding.severity}] ${resolution.verdict}  ${finding.id}${also}  ${shortLocation(primary)}${marks(primary, resolution.unverified)}`,
    '',
    paragraphText(finding.summary),
    '',
    `Reason: ${inlineText(finding.reason)}`,
    `Evidence: ${resolution.evidence === null ? 'none; the verifier of this group failed twice' : inlineText(resolution.evidence)}`,
    `Angle: ${[primary, ...members].map((candidate) => candidate.angle).filter((angle, index, all) => all.indexOf(angle) === index).join(', ')}`,
  ];
  if (members.length > 0) lines.push(`Also at: ${members.map((member) => `${member.id} ${shortLocation(member)}${marks(member, false)}`).join('; ')}`);
  if (decision !== null) lines.push(decisionLine(decision));
  return lines.join('\n');
}

/** The units the run budget left, as the line that names how to continue them says them: the batches by their count, the documentation step, then the repair. */
export function stoppedUnitWords(units: readonly { readonly phase: 'fixes' | 'documentation' | 'repair' }[]): string {
  const batches = units.filter((unit) => unit.phase === 'fixes').length;
  const words = [
    ...(batches === 0 ? [] : [`${String(batches)} batch${batches === 1 ? '' : 'es'}`]),
    ...(units.some((unit) => unit.phase === 'documentation') ? ['the documentation step'] : []),
    ...(units.some((unit) => unit.phase === 'repair') ? ['the repair'] : []),
  ];
  return listed(words);
}

/** What bounded the run's spend: the run budget in force at the end, or why there was none. */
function budgetLine(review: ReviewState, statistics: ReportInput['statistics'], budgetCheck: BudgetSpend | null): string {
  const budget = review.limits.runBudgetUsd;
  const spent = usd(statistics.total.costUsd);
  if (statistics.budgetApplied && budget !== null) {
    // A worker charged at its cap or lost makes the check's spend differ from the reported one; the line then names both, as `status` does.
    const note = budgetCheck === null || budgetCheck.usd === null ? null : budgetSpendNote(budgetCheck);
    const checked = note === null ? '' : `; the budget check counted ${usd(budgetCheck!.usd)} USD, ${note}`;
    return `- Run budget: ${usd(budget)} USD, checked before every launch; spent ${spent} USD${checked}.`;
  }
  if (statistics.total.costUnreported === null) {
    return `- The run budget did not apply: runtime ${review.configuration.runtime} reports no cost in USD, so only the per-worker timeouts and the worker count bounded this run.`;
  }
  return `- No run budget was set, so only the per-worker budgets and timeouts bounded this run; spent ${spent} USD.`;
}

/**
 * Why a candidate is unlocated, in the order the report lists them: its
 * path names no changed file, and no file of the repository that has such
 * a line; or it names a changed file the change deletes, or one whose after
 * state has no such line; or it only ends with a changed path, and the
 * ledger alone cannot tell which of the two it named.
 */
const unlocatedReasons = ['absent', 'deleted', 'past-end', 'ends-with-changed'] as const;
type UnlocatedReason = (typeof unlocatedReasons)[number];
const unlocatedWording: Readonly<Record<UnlocatedReason, string>> = {
  absent: 'on a path the repository does not hold, or on a line past the end of an unchanged file',
  deleted: 'on a file the change deletes, which has no after state for a line to point into',
  'past-end': 'on a line past the end of the changed file',
  'ends-with-changed': 'on a path that ends with a changed path, naming either that changed file or an unchanged path of the repository, neither with such a line',
};

/** A repository holding no path: every tail of a finder's path, and its bare name, may still name a changed file. */
const holdsNoPath: RepoLookup = () => [];
/** A repository holding every path: a finder's whole path, past any root, names a changed file or an unchanged one. */
const holdsEveryPath: RepoLookup = (path) => [path];

/**
 * Why an unlocated candidate is unlocated, from the ledger alone, so that
 * two engines give the same reason. `normalizeLocations` matched the raw
 * file with a lookup over the worktree, which the ledger does not record,
 * so the two extreme lookups bound what it found. A path that names no
 * changed path even when the repository holds no path named none, so it
 * named nothing the repository holds, or an unchanged file without such a
 * line. A path that names a changed path even when the repository holds
 * every path named that changed path, which is deleted or too short. A
 * path between the two only ends with a changed path, and named either
 * that changed file or an unchanged path of the repository.
 */
function whyUnlocated(scope: ScopeState, candidate: CandidateState): UnlocatedReason {
  const paths = scope.files.map((file) => file.path);
  if (matchRepositoryPath(paths, candidate.rawFile, holdsNoPath) === null) return 'absent';
  const match = matchRepositoryPath(paths, candidate.rawFile, holdsEveryPath);
  if (match === null || !match.inScope) return 'ends-with-changed';
  return scope.files.find((file) => file.path === match.path)?.after === null ? 'deleted' : 'past-end';
}

/**
 * Each worker a kill from outside the engine ended with a kill mark, or
 * whose guard left no result, and whether its unit ran again (R15 of
 * resumable runs), as bare sentences that the notes of the run and
 * `status` each prefix: its failure uses an attempt but never degrades its unit, so a
 * later worker of the same label is its rerun.
 */
export function cutWorkerLines(workers: RunState['workers']): string[] {
  const all = Object.values(workers);
  return all.flatMap((worker) => {
    if (worker.status !== 'finished' || !endedByKill(worker.finish)) return [];
    return [`Cut: the worker of ${workerLabel(worker)} ended with ${killMarkWords(worker.finish)}, and ${ranAgainWords(all, worker)}.`];
  });
}

/**
 * Each worker a stop of the engine lost, whether its unit ran again, and
 * whether its edits are in a revision of its unfinished attempt (R10, R15
 * of resumable runs), as bare sentences that the notes of the run and
 * `status` each prefix. A loss uses an attempt but never degrades its unit, so a later
 * worker of the same label is its rerun.
 */
export function lostWorkerLines(workers: RunState['workers'], revisions: readonly TreeRevised[]): string[] {
  const all = Object.values(workers);
  return all.flatMap((worker) => {
    if (worker.status !== 'lost') return [];
    const kept = revisions.some((revision) => revision.source.kind === 'attempt' && revision.source.workerId === worker.launch.workerId);
    return [`Lost with the engine: the worker of ${workerLabel(worker)}, and ${ranAgainWords(all, worker)}${kept ? '; its edits are in a revision of its unfinished attempt' : ''}.`];
  });
}

type WorkerState = RunState['workers'][string];

const workerLabel = (worker: WorkerState): string => worker.launch.label ?? worker.launch.workerId;

/** Whether a later worker of the same label, its unit's rerun, was launched, in words, by `ranAgain`. */
const ranAgainWords = (all: readonly WorkerState[], worker: WorkerState): string => (ranAgain(all, worker) ? 'ran again' : 'did not run again');

/**
 * Each block for the provider's usage limit that the run resumed after
 * (R14, R15 of resumable runs), as bare sentences that the notes of the
 * run and `status` each prefix: the re-entry that resumed the phase cleared the
 * failure and the blocker that named it, so only these lines still do.
 */
export function limitBlockLines(review: Pick<ReviewState, 'limitBlocks'>): string[] {
  return review.limitBlocks.map((block) => `Usage limit: ${block.phase} blocked at attempt ${String(block.attempt)}, and the run resumed after it: ${inlineText(block.detail)}.`);
}

/**
 * The notes of the run: what Limitations said before the brief, less what
 * the brief names as a gap (R10, R12 of the brief of a run): the angles
 * that did not run, the paths the settings left out, the files too large
 * to freeze, the checks not available and the work the run budget did not
 * start, whose command is in the facts of the run; and less the settings'
 * lines, which the facts of the run give beside the `Settings:` line. A
 * group no verifier examined keeps its line, since the brief's gap names
 * its candidates but not the group or its phase.
 */
function notesOfRun(state: RunState, scope: ScopeState, review: ReviewState, input: ReportInput): string[] {
  const lines: string[] = [];
  // The brief names the candidates no verifier examined, never the group or its phase, which the evidence keeps (R12 of the brief of a run).
  // The brief says that a review pass did not run, by its plain name; why is evidence, which the brief leaves here (R10 of the report for the person).
  for (const [angle, reason] of Object.entries(review.anglesNotRun)) lines.push(`- The ${angle} angle did not run (${inlineText(reason)}).`);
  for (const group of unverifiedGroupsOf(review)) lines.push(`- Group ${group.groupId} of ${group.phase} was not verified (${inlineText(group.reason)}): its candidates (${group.candidateIds.join(', ')}) are a gap of the brief.`);
  const drifted = review.checks.map((check, index) => ({ check, index })).filter(({ check }) => check.drifted);
  // A fix run's tree is compared with what the run expected, the change and every revision since; a read-only run's with the change alone.
  const against = review.fix === null ? 'the reviewed change' : 'what the run expected';
  const headMoved = (check: (typeof review.checks)[number]): string[] => (check.head === null ? [] : [`HEAD moved to ${check.head.actual}`]);
  // A drift a later write back of its attempt resolved came from a check a kill cut short (R7 of resumable runs); every other one blocked the run.
  const writtenBack = ({ check, index }: (typeof drifted)[number]): boolean => index < lastRestorationAt(review.fix, check.phase, check.attempt);
  const blocked = drifted.filter((entry) => !writtenBack(entry)).length;
  const fate = blocked === drifted.length ? 'each blocked the run until the tree was restored' : blocked === 0 ? 'each was written back after a check a kill cut short' : `${String(drifted.length - blocked)} ${drifted.length - blocked === 1 ? 'was' : 'were'} written back after a check a kill cut short, and each other blocked the run until the tree was restored`;
  lines.push(`- Worktree checks: ${String(review.checks.length)}, ${drifted.length === 0 ? `none found a difference from ${against}` : `${String(drifted.length)} found a difference in ${drifted.map(({ check }) => `${check.phase} (attempt ${String(check.attempt)}: ${[...headMoved(check), ...check.files.map((file) => `${inlineText(file.path)} ${file.outcome}`)].join(', ')})`).join('; ')}; ${fate}`}.`);
  lines.push(budgetLine(review, input.statistics, input.budgetCheck));
  const unreported = input.statistics.total.costUnreported;
  if (unreported !== null && unreported > 0) {
    lines.push(`- Workers with no reported cost: ${String(unreported)}. A worker that times out, fails before the runtime prints its usage, or is lost with its engine reports none; the costs above leave such workers out, so the run cost more than the totals show.${input.statistics.budgetApplied ? ' The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out.' : ''}`);
  }
  const standing = Object.values(review.candidates).filter((candidate) => candidate.duplicateOf === null);
  const outside = standing.filter(outsideChange);
  if (outside.length > 0) {
    lines.push(`- Candidates on files outside the reviewed change: ${outside.map((candidate) => `${candidate.id} (${shortLocation(candidate)})`).join(', ')}. Each points at an unchanged file of the repository, its line checked against the file as the worktree held it; no worktree check covers such a file.`);
  }
  const unlocated = standing.filter((candidate) => repositoryLocation(candidate) === null);
  for (const reason of unlocatedReasons) {
    const matching = unlocated.filter((candidate) => whyUnlocated(scope, candidate) === reason);
    if (matching.length > 0) lines.push(`- Unlocated candidates ${unlocatedWording[reason]}: ${matching.map((candidate) => `${candidate.id} (${rawAt(candidate)})`).join(', ')}.`);
  }
  lines.push(...surveyLimitations(review));
  lines.push(...fixLimitations(review));
  // What a stop did, and what the resumed run did about it (R15 of resumable runs).
  const stops = [...cutWorkerLines(state.workers), ...lostWorkerLines(state.workers, review.fix?.revisions ?? []), ...limitBlockLines(review), ...stopLimitations(review, storeNameOf)];
  lines.push(...stops.map((line) => `- ${line}`));
  return lines;
}

/**
 * The line of the facts of the run for a read-only run continued into the
 * fix pass (R7 of fix pass continuation): when, and its read-only report
 * by its name in the store, beside this one; none for a run never
 * continued.
 */
function continuedLine(review: ReviewState): string[] {
  if (review.continuedFrom === null) return [];
  return [`Continued: into the fix pass on ${review.continuedFrom.at}, after the read-only report ${storeNameOf(review.continuedFrom.report.report)}`];
}

/**
 * The lines of the facts of a run a person answered (R10 of answers): how
 * many answered findings it holds and how many of their answers the tree
 * holds, and after an answer pass, when the last pass was opened and the
 * report it replaced by its name in the store. None for a run nobody
 * answered.
 */
function answersLines(review: ReviewState): string[] {
  const standing = [...standingAnswers(review).values()];
  if (standing.length === 0) return [];
  const applied = standing.filter((answer) => answer.appliedBy !== null).length;
  const lines = [`Answers: ${String(standing.length)} recorded, ${String(applied)} applied`];
  const last = review.answerPasses.at(-1);
  if (last !== undefined) lines.push(`Answered: the last pass on ${last.at}, after the report ${storeNameOf(last.reportBefore.report)}`);
  return lines;
}

/**
 * The line of the facts of a fix pass the run budget stopped and the same
 * command reopened (R15 of resumable runs): when it was last reopened, how
 * many times when more than one, and the report it replaced by its name in
 * the store. None for a run never reopened.
 */
function reopenedLine(review: ReviewState): string[] {
  const reopenings = review.fix?.reopenings ?? [];
  const last = reopenings.at(-1);
  if (last === undefined) return [];
  const when = reopenings.length === 1 ? `on ${last.at}` : `${String(reopenings.length)} times, the last on ${last.at}`;
  return [`Reopened: the fix pass past the run budget ${when}, after the report ${storeNameOf(last.reportBefore.report)}`];
}

/**
 * The last section, the facts of the run (R12, R15 of the brief of a
 * run): its repository, its commits, its engine, its runtime, its models,
 * the digest of its roles and its settings, the earlier reports by their
 * names in the store, the counts, the error for a worktree of the base
 * that could not be made (R5 of the facts before a merge), where the
 * evidence store is, how a
 * person at a terminal types a command of the report, and the command that
 * continues a fix pass the run budget stopped. It is the one section that
 * names a local path the engine writes, so a later publication can leave
 * it out.
 */
function factsOfRun(state: RunState, scope: ScopeState, review: ReviewState, input: ReportInput): string[] {
  const { configuration } = review;
  const findings = rankedFindings(review);
  const confirmed = findings.filter((entry) => entry.resolution.verdict === 'CONFIRMED').length;
  const stopped = review.fix === null ? [] : budgetStoppedUnits(review.fix);
  const command = input.fix?.continueCommand ?? null;
  const continuing = stopped.length > 0 && command !== null ? ['', `The run budget stopped the fix pass: ${stoppedUnitWords(stopped)} did not start. ${codeSpan(command)} continues it and reviews nothing again.`] : [];
  const answering = answeringLine(review, input.engineEntry);
  return [
    '## The run',
    '',
    `Repository: ${inlineText(state.worktree)}`,
    `Base: ${scope.base}`,
    `Head: ${scope.head}`,
    `Mode: ${scope.mode}`,
    `Run: ${state.id}`,
    `Engine: ${input.engine}${state.engine === input.engine ? '' : ` (run created by ${state.engine})`}`,
    `Runtime: ${configuration.runtime} ${inlineText(configuration.version)} at ${inlineText(configuration.executable)}`,
    ...(configuration.codex === null ? [] : [`Codex Windows sandbox: ${codexSandboxWords[configuration.codex.windowsSandbox]}`]),
    `Models: strong ${configuration.models.strong}, fast ${configuration.models.fast}`,
    // A run configured before the settings renders no line of them; status says it is older than them (R17 of the configuration).
    ...(configuration.settings === null && configuration.fixSettings === null ? [] : [inlineText(settingsHeaderLine(configuration))]),
    // What the settings left unexamined or unfollowed, beside the line that names them: each path left out, each value not followed and each setting ignored, whose file may be a local path (R7 of the configuration; R15 of the brief of a run).
    ...[...excludedLines(scope), ...settingsNotes(configuration)].map(inlineText),
    ...continuedLine(review),
    ...answersLines(review),
    ...reopenedLine(review),
    `Findings: ${String(findings.length)} (${String(confirmed)} CONFIRMED, ${String(findings.length - confirmed)} PLAUSIBLE); ${String(refuted(review).length)} refuted at verification`,
    ...[fixHeaderLine(review)].filter((line) => line !== null),
    ...baseWorktreeLines(review),
    `Evidence store: ${inlineText(input.store)}; a name such as ${evidenceDirectoryName}/<hash> in this report is the file <hash> in it.`,
    ...(answering.length === 0 ? [] : ['', ...answering]),
    ...continuing,
  ];
}

/** Render the report from the fold: the brief, then the evidence. The run must be configured for review and have its scope. */
export function renderReport(state: RunState, input: ReportInput): string {
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null) throw new Error(`Run ${state.id} has no review to report on`);
  const places = { worktree: state.worktree, home: input.home };
  const findings = rankedFindings(review);
  const refutedList = refuted(review);
  const brief = [...briefMarkdown(briefOf(state)), '', '---', '', 'The evidence for each statement above follows.'];
  // A run with the decision step says what it decided first in the evidence; one configured before the step has no such section.
  const decisions = decisionsSection(review, state.id);
  const decidedFor = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  // A surveyed run says which conventions the change was held to; a run configured before the survey has no such section.
  const conventions = conventionsReportSection(review, (path) => localPathWords(path, places));
  const findingsSection = [
    '## Findings',
    '',
    ...(findings.length === 0 ? ['No finding survived verification.'] : findings.flatMap((entry, index) => [findingBlock(index + 1, entry, decidedFor.get(entry.finding.id) ?? null), ''])),
  ];
  const refutedSection = [
    '## Refuted at verification',
    '',
    ...(refutedList.length === 0 ? ['None.'] : refutedList.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle})  ${shortLocation(candidate)}${marks(candidate, false)}  ${inlineText(candidate.summary)}\n  Evidence: ${inlineText(evidence)}`)),
  ];
  const notesSection = ['## Notes of the run', '', ...notesOfRun(state, scope, review, input)];
  // A fix run's sections follow its findings; a run without the fix pass has none.
  const fixed = input.fix === undefined ? [] : fixSections(state, storeNameOf, input.fix.patches.map(storeNameOf));
  return [
    brief,
    ...(decisions === null ? [] : [decisions]),
    findingsSection,
    ...fixed,
    ...(conventions === null ? [] : [conventions]),
    refutedSection,
    notesSection,
    factsOfRun(state, scope, review, input),
  ].map((section) => section.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n';
}
