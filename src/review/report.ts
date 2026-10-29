/**
 * The report (R9, PD8 of the read-only review; R13 of the fix pass; R7
 * of the Codex sandbox; R7 of fix pass continuation; R10 of answers; R1,
 * R6, R8 of the report for the person): Markdown rendered by the engine
 * from the fold alone, so two engines render the same report from the
 * same ledger and no model rewrites a finding. It starts with the brief
 * (brief.ts), which ends at Findings; each finding has one block there, by
 * its number; the evidence follows: for a fix run Documentation updates,
 * Checks and Patches (fix-report.ts), then What the review covered,
 * Refuted at verification, and last About this run, the only part that
 * names a local path the engine writes (R15 of the brief of a run). The
 * statistics, the angles, the digest of the roles and the clusters of the
 * fix pass are in `report --stats` (stats-report.ts).
 */
import { evidenceDirectoryName, storeNameOf } from '../checkpoint/checkpoint.ts';
import type { RecordedDecision, ReviewConfiguration, ScopeState, Spend, TreeRevised } from '../checkpoint/events.ts';
import { standingAnswers } from '../checkpoint/answer-state.ts';
import { budgetStoppedUnits, lastRestorationAt } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { isAnswered, rawLocation, repositoryLocation, unverifiedGroupsOf, type CandidateState, type ReviewState } from '../checkpoint/review-fold.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import { briefMarkdown, briefOf, firstSentence, passNames, type Brief, type BriefFinding, type FindingStatus } from './brief.ts';
import { answeringLine, decisionBlockLines } from './decision-report.ts';
import { baseWorktreeLines, fixBlockLines, fixHeaderLine, fixLimitations, fixSections, stopLimitations } from './fix-report.ts';
import { endedByKill, killMarkWords } from '../runtime/kill-marks.ts';
import { matchRepositoryPath, type RepoLookup } from './locations.ts';
import { capitalized, codeSpan, findingAnchor, inlineText, listed, localPathWords, quoted } from './markdown.ts';
import { findingNumbers, ranAgain, rankedFindings, refuted, type ReportFinding } from './state.ts';
import { excludedLines, settingsHeaderLine, settingsNotes } from './settings-report.ts';
import { budgetSpendNote, type BudgetSpend } from './spend.ts';
import { conventionsReportSection, surveyLimitations } from './survey-report.ts';
import { angles, triageUnitKey, type Angle, type Phase } from './vocabulary.ts';

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

/** What became of a finding, as the first line of its block says it (R6 of the report for the person). */
const statusWords: Readonly<Record<FindingStatus, string>> = {
  question: 'A question for you',
  fixed: 'Fixed',
  'fixed-against-rule': 'Fixed against a written rule',
  'not-fixed': 'Not fixed',
  left: 'Left as is',
  planned: 'To fix when the fix pass runs',
  'planned-against-rule': 'To fix against a written rule when the fix pass runs',
};

/**
 * A finding's block under Findings (R6 of the report for the person): the
 * anchor by its number, the heading with the number and the first sentence
 * of its summary, the line of its status, its severity and the verdict as
 * the verifier gave it, then each field that has content: where, the
 * summary when it says more, the reason and the evidence of the verifier,
 * the decision (decision-report.ts), and the fix (fix-report.ts). The text
 * of a worker is quoted with the number added after an id of another
 * finding, and escaped.
 */
function findingBlock(state: RunState, finding: BriefFinding, entry: ReportFinding, decision: RecordedDecision | null, numbers: ReadonlyMap<string, number>): string[] {
  const review = state.review!;
  const { primary, members, resolution } = entry;
  const own = finding.number;
  const said = (text: string): string => inlineText(quoted(text, { numbers, own }));
  const merged = members.length === 0 ? '' : `; merged into it: ${members.map((member) => `${member.id} at ${shortLocation(member)}${marks(member, false)}`).join(', ')}`;
  const fields = [
    `Where: ${shortLocation(primary)}${marks(primary, resolution.unverified)} (${finding.id}${merged})`,
    ...(firstSentence(entry.finding.summary) === inlineText(entry.finding.summary).trim() ? [] : [`Summary: ${said(entry.finding.summary)}`]),
    `Reason: ${said(entry.finding.reason)}`,
    `Evidence: ${resolution.evidence === null ? 'none; the verifier of this group failed twice' : said(resolution.evidence)}`,
    ...(decision === null ? [] : decisionBlockLines(review, decision, { run: state.id, numbers, own })),
    ...(review.fix === null ? [] : fixBlockLines(review, review.fix, finding.id, { numbers, own })),
  ];
  return [
    `<a id="${findingAnchor(own)}"></a>`,
    '',
    `### ${String(own)}. ${said(firstSentence(entry.finding.summary))}`,
    '',
    `${statusWords[finding.status]}. ${capitalized(finding.severity)}, ${resolution.verdict}${resolution.unverified ? ', which no verifier examined' : ''}.`,
    '',
    ...fields.map((field) => `- ${field}`),
  ];
}

/** The block of one finding by its id or a merged one, as `report --finding` prints it (R7 of the report for the person); null for an id the run does not hold. */
export function findingBlockOf(state: RunState, id: string): string[] | null {
  const review = state.review;
  if (review === null) return null;
  const numbers = findingNumbers(review);
  const number = numbers.get(id);
  if (number === undefined) return null;
  const finding = briefOf(state).findings.find((entry) => entry.number === number)!;
  const entry = entriesById(review).get(finding.id)!;
  return findingBlock(state, finding, entry, review.decisions?.find((decision) => decision.id === finding.id) ?? null, numbers);
}

/** The ranked findings of a review by the id of each, so a finding of the brief finds its entry by its id rather than by its place in either list. */
function entriesById(review: ReviewState): ReadonlyMap<string, ReportFinding> {
  return new Map(rankedFindings(review).map((entry) => [entry.finding.id, entry]));
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
 * The part "What the review covered" (R8 of the report for the person):
 * the review passes that ran by their plain names, each that did not with
 * why, the conventions the change was held to for a surveyed run, what the
 * run did not examine as the brief says it, and the evidence behind it:
 * each group no verifier examined with its phase and why, the candidates
 * outside the change and the unlocated ones, and what the survey could not
 * do.
 */
function coveredSection(state: RunState, scope: ScopeState, review: ReviewState, brief: Brief, conventions: string[] | null): string[] {
  const ran = angles.filter((angle) => (angle === 'SCAN' ? isAnswered(review, 'triage', triageUnitKey) : review.anglesNotRun[angle] === undefined && isAnswered(review, 'finders', angle)));
  const lines = [
    `The review passes that ran: ${ran.length === 0 ? 'none' : listed(ran.map((angle) => `${passNames[angle]} (${angle})`))}.`,
    '',
    // A pass that did not run says why here, where the brief names it by its plain name alone.
    ...(Object.entries(review.anglesNotRun) as [Angle, string][]).map(([angle, reason]) => `- The ${passNames[angle]} review pass (${angle}) did not run: ${inlineText(reason)}. A later pass looked for what it would have found.`),
    ...brief.notExamined.filter((gap) => !gap.includes(' review pass did not run')).map((gap) => `- ${gap}`),
  ];
  for (const group of unverifiedGroupsOf(review)) lines.push(`- Group ${group.groupId} of ${group.phase} was not verified (${inlineText(group.reason)}): its candidates are ${group.candidateIds.join(', ')}.`);
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
  if (lines.at(-1) === '') lines.pop();
  const shifted = conventions === null ? [] : ['', ...conventions.map((line) => (line.startsWith('## ') ? `#${line}` : line))];
  return ['## What the review covered', '', ...lines, ...shifted];
}

/**
 * The notes of "About this run": the checks of the worktree, the run
 * budget and the cost not reported, what the fix pass left in the tree and
 * the suites its fixers ran, and what a stop did and what the resumed run
 * did about it (R15 of resumable runs).
 */
function aboutNotes(state: RunState, review: ReviewState, input: ReportInput): string[] {
  const lines: string[] = [];
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

/** The total spend of a run as one line of "About this run": its workers, their wall seconds and cost; `report --stats` gives each phase. */
function totalsLine(statistics: ReportInput['statistics']): string {
  const { total } = statistics;
  return `Totals: ${String(total.workers)} worker${total.workers === 1 ? '' : 's'}, ${total.seconds.toFixed(1)} wall seconds, ${usd(total.costUsd)} USD; \`deep-review report --stats\` gives each phase`;
}

/** The map of the numbers of the findings to the ids of the engine, which the ledger, the commits and earlier copies use (R7 of the report for the person). */
function numbersLine(findings: readonly ReportFinding[]): string[] {
  if (findings.length === 0) return [];
  return [`Findings by number: ${findings.map((entry, index) => `${String(index + 1)} ${entry.finding.id}${entry.members.length === 0 ? '' : ` (also ${entry.members.map((member) => member.id).join(', ')})`}`).join('; ')}`];
}

/**
 * The last part, "About this run" (R8 of the report for the person; R12,
 * R15 of the brief of a run): its repository, its commits, its engine, its
 * runtime, its models and its settings, the earlier reports by their names
 * in the store, the counts, the totals, the error for a worktree of the base
 * that could not be made (R5 of the facts before a merge), where the
 * evidence store is, the map of the numbers of the findings to their ids,
 * the notes of the run, how a person at a terminal types a command of the
 * report, and the command that continues a fix pass the run budget
 * stopped. It is the one part that names a local path the engine writes,
 * so a later publication can leave it out.
 */
function aboutSection(state: RunState, scope: ScopeState, review: ReviewState, input: ReportInput): string[] {
  const { configuration } = review;
  const findings = rankedFindings(review);
  const confirmed = findings.filter((entry) => entry.resolution.verdict === 'CONFIRMED').length;
  const stopped = review.fix === null ? [] : budgetStoppedUnits(review.fix);
  const command = input.fix?.continueCommand ?? null;
  const continuing = stopped.length > 0 && command !== null ? ['', `The run budget stopped the fix pass: ${stoppedUnitWords(stopped)} did not start. ${codeSpan(command)} continues it and reviews nothing again.`] : [];
  const answering = answeringLine(review, input.engineEntry);
  return [
    '## About this run',
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
    ...numbersLine(findings),
    ...[fixHeaderLine(review)].filter((line) => line !== null),
    totalsLine(input.statistics),
    ...baseWorktreeLines(review),
    `Evidence store: ${inlineText(input.store)}; a name such as ${codeSpan(`${evidenceDirectoryName}/<hash>`)} in this report is the file ${codeSpan('<hash>')} in it.`,
    '',
    ...aboutNotes(state, review, input),
    ...(answering.length === 0 ? [] : ['', ...answering]),
    ...continuing,
  ];
}

/**
 * Render the report from the fold (R1, R6, R8 of the report for the
 * person): the brief, which ends at Findings; one block per finding, in
 * rank order; then the evidence: for a fix run Documentation updates,
 * Checks and Patches, then What the review covered, Refuted at
 * verification, and About this run. The run must be configured for review
 * and have its scope.
 */
export function renderReport(state: RunState, input: ReportInput): string {
  const review = state.review;
  const scope = state.scope;
  if (review === null || scope === null) throw new Error(`Run ${state.id} has no review to report on`);
  const places = { worktree: state.worktree, home: input.home };
  const brief = briefOf(state);
  const entries = entriesById(review);
  const numbers = findingNumbers(review);
  const decidedFor = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  const refutedList = refuted(review);
  const said = (text: string): string => inlineText(quoted(text, { numbers }));
  const findingsSection = [
    '## Findings',
    '',
    ...(brief.findings.length === 0 ? ['No finding survived verification.'] : brief.findings.flatMap((finding) => [...findingBlock(state, finding, entries.get(finding.id)!, decidedFor.get(finding.id) ?? null, numbers), ''])),
  ];
  // The verifiers' prompt names this part, so it keeps its name and its form (R8 of the report for the person).
  const refutedSection = [
    '## Refuted at verification',
    '',
    ...(refutedList.length === 0 ? ['None.'] : refutedList.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle})  ${shortLocation(candidate)}${marks(candidate, false)}  ${said(candidate.summary)}\n  Evidence: ${said(evidence)}`)),
  ];
  // A surveyed run says which conventions the change was held to; a run configured before the survey has none.
  const conventions = conventionsReportSection(review, (path) => localPathWords(path, places));
  const fixed = input.fix === undefined ? [] : fixSections(state, storeNameOf, input.fix.patches.map(storeNameOf), numbers);
  return [
    briefMarkdown(brief),
    findingsSection,
    ...fixed,
    coveredSection(state, scope, review, brief, conventions),
    refutedSection,
    aboutSection(state, scope, review, input),
  ].map((section) => section.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n';
}
