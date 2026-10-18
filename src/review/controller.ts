/**
 * The controller (R1, R5, R6, R7 of the read-only review; TD1, TD5, TD6;
 * R1, R6, R7, R9 of the fix pass; R1, R6, R7 of the repository survey;
 * R1 to R3 of the Codex sandbox; R1 to R5 of fix pass continuation): find
 * the run, continue a finished read-only run into the fix pass, or create
 * one, take its lock,
 * record the workers a previous engine lost, then loop over fold, plan,
 * execute and append until the report is written or the run blocks. It
 * launches workers with the runtime options the run pinned, plans the
 * checks when the survey completes, runs them one at a time, and records
 * every edit as a revision of the tree. Every fact the planner needs is an
 * event, or this invocation's check flags, so a resumed run continues
 * from the last step the ledger holds.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import type { Blocker, CheckRan, CheckStarted, ClaimsLost, DecisionsRecorded, FilesClaimed, FixPinnedV2, PlannedCheckV3, ReviewConfiguration, ReviewConfigurationV6, ReviewLimits, ScopeRequest, SurveyRecorded, TreeRestored, TreeRevised } from '../checkpoint/events.ts';
import { reviewConfiguredV6 } from '../checkpoint/events.ts';
import { fixSettingsRecordOf, settingOf, settingsRecordOf } from '../config/record.ts';
import { resolvedValue, withChangedPaths, type ResolvedSettings } from '../config/resolve.ts';
import { isConfiguredRuntime, runtimeSettingNames } from '../config/settings.ts';
import type { ConfigurationSource } from '../config/source.ts';
import { standingAnswer } from '../checkpoint/answer-state.ts';
import { batchPosition, revisionMessageOf, routeOf, type CutShortCheck } from '../checkpoint/fix-state.ts';
import { UnreadableRunError } from '../checkpoint/errors.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { conventionsKnown, lastSurvey, type SurveyState } from '../checkpoint/survey-state.ts';
import { assembleRoles, type AssembledRole } from '../roles/assemble.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { withPathFirst } from '../runtime/environment.ts';
import { PreflightError } from '../runtime/errors.ts';
import { ioDirectoryName, runWorker, type WorkerReceipt } from '../runtime/launcher.ts';
import { endedByKill, killMarkWords } from '../runtime/process.ts';
import { preflight, type PreflightOptions } from '../runtime/preflight.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import type { PinnedRuntimeOptions } from '../runtime/runtimes.ts';
import { checkpointScratchKey, defaultScratchRoot } from '../runtime/scratch.ts';
import { captureScope, resolveScopeRequest, scopeBase, type ResolvedScope } from '../scope/capture.ts';
import { EmptyChangeError, InvalidScopeRequestError } from '../scope/errors.ts';
import { scopeMismatch } from '../scope/compare.ts';
import { objectFormat } from '../scope/git.ts';
import { hintChecks, isSettled, readRootManifests, unsettledKinds, type CheckSettings } from './checks/discover.ts';
import { claimsDirectories } from './claims-directories.ts';
import { checkSettingsInForce, checkSettingsOfResolved, configuredLines, executableOf, policyOverridesOf, recordedCheckSettings, refuseOldNode, unappliedLines, unconfiguredSource } from './configuration.ts';
import { caseInsensitiveFileSystem } from './claims.ts';
import { runCheck } from './checks/run.ts';
import { gitContent } from './content.ts';
import { existingUserRulesFiles, reviewerAuthorship } from './conventions.ts';
import { drifted, expectedTreeOf, findDrift, phaseCheck, restoredFiles, worktreeChecked, writeBack, type DriftFound, type RestoredFile } from './drift.ts';
import { isFile, sameDirectory } from '../paths.ts';
import { ReviewRefusedError } from './errors.ts';
import { attemptRevisionEvents, checkRevision, type RevisionContext } from './fix-events.ts';
import { parseUnitLabel } from './labels.ts';
import { acquireRunLock, acquireStartLock, releaseOnExit, type ReleaseLock } from './lock.ts';
import { patchSeries } from './patch.ts';
import { contributionOf, invocationFor, type PhaseContext } from './phases.ts';
import { editorsUnderUnelevatedSandbox, pinnedWindowsSandbox, readPolicy, refuseInvocationFlags, resolvePolicy, rolesDigest, type PolicyFlags } from './policy.ts';
import { scopeBlock, surveyScopeBlock, type PresurveyRulesFile, type ScopeConventions } from './prompts.ts';
import { renderReport } from './report.ts';
import { passedOverLine, readableRuns } from './runs.ts';
import { shellQuoted } from './shell.ts';
import { prepareCheckManifest, prepareSnapshots, snapshotsDirectoryName } from './snapshot.ts';
import { budgetSpendOf, progressWords, spendWords, statisticsOf, type BudgetSpend } from './spend.ts';
import { currentPhase, reviewStatus } from './state.ts';
import { budgetBlocker, nextStep, truncated, type DueCheck, type Live, type Unit } from './steps.ts';
import { checkSettingWords, resolveChecks, surveyFailure, type SurveyInputs } from './survey.ts';
import { claimPathPlaceholder, snapshotIndexPlaceholder } from './tasks.ts';
import type { ExpectedMatch } from './tree.ts';
import { blockerActions, checkKinds, decisionCounts, decisionCountWords, isEditingPhase, lostClaimWords, maxRecordedTextLength, pinnedRuntimeAction, unitName, wayOut, type CheckKind, type CheckPhase, type Phase, type PinnedUse } from './vocabulary.ts';

/**
 * The scope a command asks for. It is resolved when the run it acts on
 * has none captured (a new run, or one whose capture failed), and when a
 * `--fix` compares it with a finished run's before continuing that run; an
 * active run that has one keeps it, so the request is not even checked
 * against a tree that may have moved on.
 */
export interface ScopeSource {
  /** Whether the command named a scope, so a resumed run that ignores it can say so. */
  readonly named: boolean;
  /** The request to capture; throws, creating nothing, when the command names none or one the tree refutes. */
  readonly request: () => ScopeRequest;
}

export interface ReviewOptions {
  readonly checkpoint: Checkpoint;
  /** The worktree the review runs in; workers use it as their working directory. */
  readonly worktree: string;
  /**
   * The runtimes the run's workers launch on: `defaultRuntimes()` for the
   * engine's own, built with whatever options the caller needs, such as a
   * provider. What the run pinned, such as the Codex Windows sandbox, is
   * passed to every launch and wins over the options the runtimes were
   * built with (R2 of the Codex sandbox).
   */
  readonly runtimes: RuntimeRegistry;
  readonly runtime: string;
  /**
   * The platform a run is configured for, which decides whether it pins a
   * Codex Windows sandbox, and the one every worker's command and
   * environment are built for; this process's by default, the one its
   * workers run on. Another is a test's: the workers still spawn on this
   * process's.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * The executable a run not yet configured pins: its path, or a function
   * that resolves it, with the value of the runtime's `executable`
   * setting, or null when no layer gives one (R12 of the configuration). A
   * configured run preflights and launches the executable it pinned, so
   * the command's is then not refused: a run started with `--executable`
   * resumes without it, even where the runtime's name finds a shim on
   * PATH. A resume calls the function only to name a setting that now
   * resolves to another path, and names a refusal it throws (R6).
   */
  readonly executable: string | ((configured: string | null) => string);
  /** The arguments a run not yet configured pins before every worker's own, when no configuration source is given; a configured run keeps its pinned ones. */
  readonly executableArgs?: readonly string[];
  readonly rolesRoot: string;
  readonly flags: PolicyFlags;
  /**
   * The invocation's configuration (R2 to R6 of the configuration): its
   * files and its flag layer, which give a new run its settings and a
   * continuation its fix side, and against which a resumed run is
   * compared. Without one, the run reads no operator's, clone's or
   * invocation file, and its flag layer is `flags`, `fix`, `executable`
   * and `executableArgs`; the repository's file is still read at the
   * base, as a run started from the command line reads it.
   */
  readonly configuration?: ConfigurationSource;
  /** The scope of a new run, or of an active one that has none yet; a run that captured one keeps it. */
  readonly scope: ScopeSource;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  /** The home directory the reviewer's own rules files are looked for under; the user's by default. */
  readonly home?: string;
  /** Progress, one line at a time; stderr by default. */
  readonly log?: (line: string) => void;
  /** The limits of the preflight's probes, at startup and before every worker; the preflight's own by default. */
  readonly preflightOptions?: PreflightOptions;
  /**
   * The fix pass a run not yet configured pins (R1 of the fix pass): null
   * or absent for the read-only review, else the `--check` and
   * `--no-check` flags that settle their kinds over the survey (R5 of the
   * repository survey). Whether a run fixes is pinned at configuration;
   * the flags apply to every invocation until the checks are planned, and
   * are named as ignored after.
   */
  readonly fix?: CheckSettings | null;
  /**
   * Whether `--fresh` declines a continuation (R2 of fix pass
   * continuation): with `fix` and no active run, a finished read-only run
   * of the same change is continued into the fix pass unless this is true,
   * when a new run is created. An active run is resumed either way.
   */
  readonly fresh?: boolean;
  /**
   * The script a fixer's snapshot and claim commands run with `node`, and
   * the report names for a person who answers at a terminal (R9 of the
   * skill surface corrections): the engine's own entry, the bundle or
   * `src/cli.ts`. `process.argv[1]` by default, which is that entry when
   * the engine runs as the command.
   */
  readonly engineEntry?: string;
}

export type ReviewOutcome =
  | { readonly kind: 'report'; readonly runId: string; readonly reportPath: string }
  | { readonly kind: 'blocked'; readonly runId: string; readonly blocker: Blocker & { readonly phase: Phase } };

/** How a launched worker settles: with its receipt, or with the error the launcher threw instead of one. */
type Settled = { readonly unit: Unit; readonly receipt: WorkerReceipt } | { readonly unit: Unit; readonly error: unknown };

/**
 * How a running worker is remembered until it settles. The promise never
 * rejects, so a launcher error is handled when the controller awaits it
 * and is never an unhandled rejection while another worker is awaited.
 */
interface InFlight {
  readonly unit: Unit;
  readonly startedAt: number;
  readonly promise: Promise<Settled>;
}

/** Whether a review may resume the run: it is active and has no report. A run created by another tool has no review; one that crashed before its scope or configuration is resumed by completing them. */
export function isResumable(run: RunState): boolean {
  return run.status === 'active' && (run.review === null || run.review.report === null);
}

/**
 * The one run to resume, or null when there is none; two are refused,
 * naming them. The candidates are the active runs a review may resume:
 * those without a report. A run holding an event this engine does not
 * declare is passed over with a line on `log` and takes no part in the
 * choice. It is never called closed: whether the unknown event closed it,
 * this engine cannot know. If it is in fact active, the engine that can
 * read it meets it beside any run started here, and refuses the two by
 * this guard.
 */
export function findActiveRun(checkpoint: Checkpoint, log: (line: string) => void): RunState | null {
  return activeRunAmong(readableRuns(checkpoint, log));
}

/** The one resumable run among readable runs, or null; two are refused, naming them (`findActiveRun`). */
function activeRunAmong(readable: readonly RunState[]): RunState | null {
  const runs = readable.filter(isResumable);
  if (runs.length > 1) {
    throw new ReviewRefusedError(`${String(runs.length)} runs are active (${runs.map((run) => run.id).join(', ')}); abandon all but one with \`deep-review abandon --run <id> --reason <text>\``);
  }
  return runs[0] ?? null;
}

/**
 * The found run folded again under its lock, or null when an engine that
 * declares events this one does not appended one to it since the find: the
 * run is then passed over, with the same line the find gives such a run.
 */
function refoldUnderLock(checkpoint: Checkpoint, runId: string, log: (line: string) => void): RunState | null {
  try {
    return checkpoint.fold(runId);
  } catch (error) {
    if (!(error instanceof UnreadableRunError)) throw error;
    log(passedOverLine(runId, error.unknown, error.reader));
    return null;
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Why a check runs again, as its log line names the run it replaces (R3, R4, R7 of resumable runs). */
function rerunWords(replaces: NonNullable<DueCheck['replaces']>): string {
  const { run, why } = replaces;
  const took = seconds(Date.parse(run.endedAt) - Date.parse(run.startedAt));
  switch (why) {
    case 'cut-attempt': {
      const ended = run.outcome === 'skipped' ? 'skipped it' : run.outcome === 'not-started' ? 'could not start it' : `${run.outcome === 'timeout' ? 'timed out' : run.outcome === 'cut' ? 'was cut' : 'failed'} in ${took}`;
      return `attempt ${String(run.attempt)} ${ended} before the phase started again`;
    }
    case 'timeout':
      return `it timed out after ${took} at its first run in this attempt`;
    case 'cut':
      return `its run of attempt ${String(run.attempt)} was cut after ${took}, with no result of its own`;
  }
}
const usd = (value: number | null): string => (value === null ? '' : `, ${value.toFixed(2)} USD`);

/** A function that reads its value the first time it is called and returns that value after; a read that throws is tried again on the next call. */
function once<T>(read: () => T): () => T {
  // Boxed, so a value that is itself null or undefined is remembered too.
  let memo: { readonly value: T } | null = null;
  return (): T => (memo ??= { value: read() }).value;
}

/** Where a fixer's batch stands in its round, as its start line names it (R7 of the skill surface corrections); nothing for another phase's unit, an answer pass's fixer among them, whose phase is `answer`. */
function batchWords(state: RunState, unit: Pick<Unit, 'phase' | 'key'>): string {
  const fix = state.review?.fix ?? null;
  const position = unit.phase === 'fixes' && fix !== null ? batchPosition(fix, unit.key) : null;
  return position === null ? '' : `; batch ${String(position.index)} of ${String(position.count)}`;
}

/** A count of files, as the log names it. */
const fileCount = (count: number): string => `${String(count)} file${count === 1 ? '' : 's'}`;

/**
 * What a settle recorded of the claims, as the log names it (R3, R6 of
 * commit series integrity): each claiming unit's claims, its late claims
 * apart, and each marker left out of the ledger, with who holds its path.
 */
function claimLines(event: NewEvent): string[] {
  if (event.kind === 'files.claimed') {
    const { key, files } = event.payload as FilesClaimed;
    const timed = files.filter((file) => file.claimedAt !== null).map((file) => file.path);
    const late = files.filter((file) => file.claimedAt === null).map((file) => file.path);
    return [
      ...(timed.length === 0 ? [] : [`worker fixer fixes:${key}: claimed ${fileCount(timed.length)}: ${timed.join(', ')}`]),
      ...(late.length === 0 ? [] : [`worker fixer fixes:${key}: claimed late, edited before it was claimed: ${late.join(', ')}`]),
    ];
  }
  if (event.kind === 'claims.lost') {
    const { unit, files } = event.payload as ClaimsLost;
    return files.map((file) => `phase fixes: claim lost: ${file.path} by ${unit} ${lostClaimWords(file.holder)}`);
  }
  return [];
}

/**
 * What a worker's revision did, as the log names it: the findings it
 * serves, or, for the revision of what a failed attempt left after its last
 * snapshot, which names none, that (R27 of the fix pass).
 */
const revisionSummary = (revision: TreeRevised): string => {
  const files = fileCount(revision.files.length);
  return revision.change.findings.length === 0 ? `revised ${files} after its last snapshot` : `revised ${files} for ${revision.change.findings.join(', ')}`;
};

/** One planned check as the log names it: its command and who decided it, with the survey's source or the setting's layer, as `flag` for a flag as before the settings, or why it has none. */
const checkLine = (check: PlannedCheckV3): string => {
  const origin = check.origin === 'survey' ? `survey, ${check.source.basis} in ${check.source.path}` : check.origin === 'setting' ? (check.layer === 'flag' ? 'flag' : checkSettingWords(check.kind, check.layer, false)) : check.origin;
  return check.command === null ? `not available (${origin}: ${check.reason})` : `${check.command} (${origin})`;
};

/** What `resolve` returns, or, for a change with no path left to review, the refusal that creates nothing and exits 2 (R10 of the configuration). */
function refusingEmptyChange<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof EmptyChangeError) throw new ReviewRefusedError(`${error.message}; nothing to review`);
    throw error;
  }
}

/** What the survey recorded, as the log names it: each convention source and each user-level decision (R10 of the repository survey). */
function surveyLines(runId: string, survey: Pick<SurveyRecorded, 'conventions' | 'userRules'>): string[] {
  return [
    ...(survey.conventions.length === 0 ? [`run ${runId}: survey: no convention source`] : survey.conventions.map((source) => `run ${runId}: convention source ${source.path} (${source.level}): ${source.governs}`)),
    ...survey.userRules.map((rule) => `run ${runId}: user-level rules ${rule.path}: ${rule.applied ? 'applied' : 'not applied'}, ${rule.reason}`),
  ];
}

/** The rules files a directory may hold, as the engine looked for them before the survey existed, in the order it listed them. */
const presurveyRulesFileNames = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const;

/** Every directory from the repository root down to each changed file's own, repository-relative, the root as ``, by depth then path and without repeats. */
function ancestorDirectories(changedPaths: readonly string[]): string[] {
  const directories = new Set<string>(['']);
  for (const path of changedPaths) {
    const parts = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) directories.add(parts.slice(0, depth).join('/'));
  }
  return [...directories].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The rules files the engine lists for a run configured before the survey
 * existed, found as the engine found them then (R12, TD11 of the
 * read-only review): the user-level ones that exist, then `CLAUDE.md`,
 * `CLAUDE.local.md` and `AGENTS.md` in the repository root and every
 * ancestor directory of a changed path, by depth and path. Such a run
 * recorded no convention source, and resumes with the role prompts it
 * pinned, which tell its workers the scope block lists these files.
 */
export function presurveyRulesFiles(worktree: string, changedPaths: readonly string[], home?: string): PresurveyRulesFile[] {
  const repository = ancestorDirectories(changedPaths)
    .flatMap((directory) => presurveyRulesFileNames.map((name) => (directory === '' ? name : `${directory}/${name}`)))
    .filter((path) => isFile(join(worktree, ...path.split('/'))));
  return [...existingUserRulesFiles(home).map((path): PresurveyRulesFile => ({ level: 'user', path })), ...repository.map((path): PresurveyRulesFile => ({ level: 'repository', path }))];
}

/** What a drifted check found, as the log names it. */
export const driftList = (found: { readonly files: readonly { readonly path: string; readonly outcome: string }[]; readonly head: DriftFound['head'] }): string =>
  [...(found.head === null ? [] : [`HEAD (${found.head.actual}, expected ${found.head.expected})`]), ...found.files.map((file) => `${file.path} (${file.outcome})`)].join(', ');

/**
 * The command a fixer runs to snapshot into a directory: `node` on the
 * worker's PATH, which every shell a runtime gives runs the same way, the
 * engine's entry, and the index placeholder the task asks the fixer to
 * fill in.
 */
export function snapshotCommandFor(engineEntry: string, into: string): string {
  return `node "${engineEntry}" snapshot --finding ${snapshotIndexPlaceholder} --into "${into}"`;
}

/**
 * The command a fixer runs to claim a file for its cluster (R1, R2 of
 * commit series integrity): `node` as for the snapshot command, the
 * engine's entry and the round's claims directory each quoted by
 * `shellQuoted`, the unit's key, and the path placeholder the task asks the
 * fixer to fill in, single-quoted so a path with a space stays one argument.
 * A path the fixer puts there that holds a `'` must have it escaped as the
 * fixer's shell requires, which the engine, not knowing that shell, cannot.
 */
export function claimCommandFor(engineEntry: string, unit: string, into: string): string {
  return `node ${shellQuoted(engineEntry)} claim --path '${claimPathPlaceholder}' --unit ${unit} --in ${shellQuoted(into)}`;
}

/** Run a review to its report or its blocker. */
export async function runReview(options: ReviewOptions): Promise<ReviewOutcome> {
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const adapter = options.runtimes.get(options.runtime);
  const roles = assembleRoles(options.rolesRoot);
  const rolesByKey = new Map(roles.map((role) => [role.key, role]));

  const { checkpoint } = options;
  // Every comparison with what the run expects, and every patch, sees a file as git would store it (R22 of the fix pass).
  const content = gitContent(options.worktree, (reference) => checkpoint.evidence.read(reference));
  const source = options.configuration ?? unconfiguredSource(options);
  const opened = await openRun({ ...options, log, environment, platform, adapter, roles, match: content.match, source });
  let state = opened.state;
  const runId = state.id;
  const { release, capture, configure, continuation } = opened;
  const inFlight = new Map<string, InFlight>();
  /**
   * The check settings the planner and the survey read, once the run is
   * configured: the ones the run recorded (R11 of the configuration), with
   * this invocation's check flags over them, which settle their kinds until
   * the checks are planned (TD6 of the repository survey); on a run
   * configured before the settings, the flags alone.
   */
  const runCheckSettings = (): CheckSettings => checkSettingsInForce(state.review === null ? null : recordedCheckSettings(state.review.configuration), options.fix ?? null);
  const userFiles = once(() => existingUserRulesFiles(options.home));
  const hints = once(() => (state.review?.configuration.fix === true ? hintChecks(readRootManifests(options.worktree), unsettledKinds(runCheckSettings())) : []));
  const authorship = once(() => reviewerAuthorship(options.worktree));
  /**
   * What this invocation knows for the survey: the platform and the check
   * flags, and three parts each read once, when first asked for. The
   * user-level rules files that exist are read by the surveyor's task, the
   * check of its answer and a run going on without the survey; in a fix
   * run the manifest rules' hint for each kind no flag settles only by the
   * task and the check; the reviewer's authorship of the recent history
   * (two git commands) only by the task. So a run going on without its
   * survey reads the user-level files alone, and a root manifest or a git
   * history it cannot read does not stop it there.
   */
  const surveyed: SurveyInputs = {
    platform,
    get checkSettings() {
      return runCheckSettings();
    },
    get userFiles() {
      return userFiles();
    },
    get hints() {
      return hints();
    },
    get authorship() {
      return authorship();
    },
  };
  const surveyInputs = (): SurveyInputs => surveyed;
  const engineEntry = options.engineEntry ?? process.argv[1] ?? 'deep-review';
  const scratchBase = join(options.scratchRoot ?? defaultScratchRoot(), checkpointScratchKey(checkpoint));
  // Whether the worktree's file system folds case, which every claim's marker name follows (TD4 of commit series integrity); probed once, when the first claims directory is read or prepared.
  const caseInsensitive = once(() => caseInsensitiveFileSystem(options.worktree));
  const directories = claimsDirectories({ scratchBase, runId, worktree: options.worktree, state: () => state, caseInsensitive, command: (key, directory) => claimCommandFor(engineEntry, key, directory), log });
  const { claims } = directories;
  /** What turning a worker's work into events reads, from the fold as it is now. */
  const revisionContext = (): RevisionContext => ({ state, worktree: options.worktree, evidence: checkpoint.evidence, match: content.match, claims });
  /**
   * Log a settled worker and append its finish with what it contributes,
   * in one append, so a stop cannot record the one without the other (R6
   * of resumable runs). An answer set aside because the tree of a phase
   * that only reads drifted is no contribution, so its finish goes alone,
   * and the worker is not lost at the next start. A contribution that
   * cannot be built, or that the fold refuses, leaves the finish alone on
   * the ledger and is thrown. A launcher error is thrown, since nothing was
   * recorded for its unit.
   */
  const record = (settled: Settled, startedAt: number): void => {
    const name = unitName(settled.unit.phase, settled.unit.key);
    // The launcher threw instead of returning a receipt (a run abandoned meanwhile, an invocation it refused, a runtime that no longer qualifies): the review cannot go on.
    if ('error' in settled) throw settled.error;
    const summary = adapter.summarizeUsage(settled.receipt.runtime.usage);
    log(`worker ${settled.unit.role} ${name}: ${settled.receipt.outcome} in ${seconds(Date.now() - startedAt)}${usd(summary.costUsd)}${settled.receipt.error === null ? '' : `: ${settled.receipt.error}`}`);
    state = checkpoint.fold(runId);
    const { phase } = settled.unit;
    const { finish } = settled.receipt;
    const withFinish = (events: readonly NewEvent[]): NewEvent[] => [...(finish === null ? [] : [finish]), ...events];
    // The finish alone, after a failure to record it with a contribution; a failure of this append too leaves the first error to surface.
    const finishAlone = (): void => {
      if (finish === null) return;
      try {
        state = append(checkpoint, state, [finish]);
      } catch (error) {
        log(`worker ${settled.unit.role} ${name}: its finish is not recorded either: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // An answer of a reading phase is recorded only while the tree is the one the run expects (PD10): once it drifted in this attempt, every answer settling is set aside, neither recorded nor counted as a failure, and the attempt blocks when the workers in flight have settled. An editing phase's tree changes by design, and its end check judges it instead (TD2 of the fix pass).
    if (settled.receipt.outcome === 'completed' && !isEditingPhase(phase)) {
      const attempt = state.review!.phases[phase].attempt;
      const recorded = state.review!.checks.find((check) => check.phase === phase && check.attempt === attempt && check.drifted);
      if (recorded !== undefined) {
        log(`worker ${settled.unit.role} ${name}: answer set aside: the worktree drifted from what the run expects: ${driftList(recorded)}`);
        if (finish !== null) state = append(checkpoint, state, [finish]);
        return;
      }
      const found = findDrift(state, options.worktree, content.match);
      if (drifted(found)) {
        log(`worker ${settled.unit.role} ${name}: answer set aside: the worktree drifted from what the run expects: ${driftList(found)}`);
        state = append(checkpoint, state, withFinish([{ kind: 'worktree.checked', version: 5, payload: worktreeChecked(state, options.worktree, phase, attempt, 'answer', found).payload }]));
        return;
      }
    }
    const settling = phase === 'fixes' ? directories.settleReading(settled.unit.key) : { access: claims, lost: false };
    let events: NewEvent[];
    try {
      events = contributionOf(settled.unit, settled.receipt, { ...revisionContext(), claims: settling.access, survey: surveyInputs, claimsLost: settling.lost });
    } catch (error) {
      finishAlone();
      throw error;
    }
    for (const event of events) {
      for (const line of claimLines(event)) log(line);
      if (event.kind === 'attempt.failed') log(`worker ${settled.unit.role} ${name}: attempt failed: ${(event.payload as { reason: string }).reason}`);
      if (event.kind === 'tree.revised') log(`worker ${settled.unit.role} ${name}: ${revisionSummary(event.payload as TreeRevised)}`);
      if (event.kind === 'survey.recorded') for (const line of surveyLines(runId, event.payload as SurveyRecorded)) log(line);
      if (event.kind === 'decisions.recorded') log(`worker ${settled.unit.role} ${name}: decided ${decisionCountWords(decisionCounts((event.payload as DecisionsRecorded).decisions))}`);
    }
    try {
      state = append(checkpoint, state, withFinish(events));
    } catch (error) {
      finishAlone();
      throw error;
    }
    // The round's directory is prepared again at once, not at the next launch: a late claim just recorded holds its file there too, and a cluster that has just settled holds nothing more, before any sibling's next claim (R1, TD2 of commit series integrity). A directory found gone is lost, as at a launch.
    if (phase === 'fixes' && directories.lost() === null) directories.prepare(settled.unit.key);
  };
  try {
    if (capture !== null) {
      // At the base the configuration was read at, which the capture holds it to (R4 of the configuration).
      // A tree emptied since the run was opened is refused as the listing refused it, exit 2; the run, with no scope, resumes on the next command.
      state = refusingEmptyChange(() => captureScope(checkpoint, runId, capture.request, { exclude: capture.exclude, base: capture.base }));
      const excluded = state.scope!.excluded.count;
      log(`run ${runId}: scope captured, ${String(state.scope!.files.length)} files${excluded === 0 ? '' : `; scope.exclude left out ${String(excluded)} changed path${excluded === 1 ? '' : 's'}`}`);
    }
    if (configure !== null) {
      // The checks are planned when the survey completes, not here (R6 of the repository survey); the settings are recorded with the configuration, before the first worker (R6 of the configuration).
      state = append(checkpoint, state, [{ kind: 'review.configured', version: 6, payload: configure.payload }]);
      const pinnedNow = configure.payload;
      log(`run ${runId}: configured for ${pinnedNow.runtime} ${pinnedNow.version}, models ${pinnedNow.models.strong} and ${pinnedNow.models.fast}${pinnedNow.fix ? ', with the fix pass' : ''}${pinnedNow.codex === null ? '' : `, Codex Windows sandbox ${pinnedNow.codex.windowsSandbox}`}; the reviewer's own rules: ${pinnedNow.survey.userRules}`);
      for (const line of configuredLines(runId, configure.resolved)) log(line);
    }
    if (continuation !== null) {
      // Where a new run's configuration is pinned, before the limits are recorded, which the fold accepts again once the pin clears the report (R6 of fix pass continuation).
      // This is after openRun released the start lock, while the run is still complete, so another engine may create a second active run in between: https://github.com/josephjang/deep-review/issues/44
      state = append(checkpoint, state, [{ kind: 'fix.pinned', version: 2, payload: continuation.pin }]);
      log(`run ${runId}: continued into the fix pass; its read-only report is ${continuation.report}; ${spendWords(budgetSpendOf(state, adapter).usd, limitsInForce(state.review!.configuration, options.flags, adapter).runBudgetUsd)}`);
      for (const check of continuation.pin.plannedChecks ?? []) log(`run ${runId}: check ${check.kind}: ${checkLine(check)}`);
    }
    const configuration = state.review!.configuration;
    // What every worker launches with, from what the run pinned, however long ago it was configured.
    const pinned = pinnedRuntimeOptionsOf(configuration);
    // The directories every worker and check finds first on PATH (R11, TD10 of the configuration).
    const toolsPath = settingOf(configuration, 'tools.path').value ?? [];
    // Said before the first worker of every invocation, so the operator knows before paying for a fix run whose editors cannot run the build (R5 of the Codex sandbox).
    const unelevatedEditors = editorsUnderUnelevatedSandbox(configuration, platform);
    if (unelevatedEditors) log(unelevatedEditorsWarning(runId));
    state = recordLimits(checkpoint, state, limitsInForce(configuration, options.flags, adapter), log);
    state = recordLostWorkers(checkpoint, state, { worktree: options.worktree, match: content.match, claims }, log);
    state = reenterPhase(checkpoint, state, adapter, log);

    const scope = state.scope!;
    const blocks: { survey?: string; rest?: string } = {};
    /**
     * The scope block a phase's workers receive, each rendered once: the
     * surveyor's has neither the convention sources, which the survey is
     * there to name, nor the patch, which it does not read; every later
     * worker's lists the sources the survey recorded, so it is rendered
     * after the survey phase, and carries the patch (R7, TD10 of the
     * repository survey).
     */
    const scopeBlockFor = (phase: Phase): string => {
      if (phase === 'survey') return (blocks.survey ??= surveyScopeBlock({ worktree: options.worktree, scope, evidence: checkpoint.evidence }));
      if (blocks.rest === undefined) {
        const survey = state.review!.phases.survey.status;
        if (survey !== 'completed' && survey !== 'degraded' && survey !== 'skipped') throw new Error(`Run ${runId} renders the scope block of a ${phase} worker while its survey is ${survey}`);
        const known = conventionsKnown(state.review!.survey);
        // A run that predates the survey gets the rules files the engine listed when it was configured, which its pinned role prompts expect.
        const conventions: ScopeConventions = known.status === 'predates-survey' ? { status: 'predates-survey', rulesFiles: presurveyRulesFiles(options.worktree, scope.files.map((file) => file.path), options.home) } : known;
        blocks.rest = scopeBlock({ worktree: options.worktree, scope, evidence: checkpoint.evidence, conventions });
      }
      return blocks.rest;
    };
    /**
     * The run going on without its survey, as the event that records it and
     * logged with it: a read-only review whose surveyor failed twice, or a
     * fix run whose flags settle every check after its survey blocked. The
     * pinned policy alone decides the user-level files of such a run (R3,
     * R9 of the repository survey).
     */
    const surveyFailedEvent = (reason: string): NewEvent => {
      const failure = surveyFailure(reason, configuration.survey.userRules, userFiles());
      log(`phase survey: going on without the survey: ${failure.reason}`);
      for (const line of surveyLines(runId, failure)) log(line);
      return { kind: 'survey.failed', version: 1, payload: failure };
    };
    /**
     * Write back what a check a kill cut short left changed in the files the
     * run expects (R7, TD7 of resumable runs): `tree.restored` first, after
     * the events `before` gives, in one append, with what the tree held
     * frozen as evidence, then the expected bytes, then the check of the
     * tree, recorded with the moment `restored`. A stop between the record
     * and the writes leaves the drift, which the next start writes back
     * again.
     */
    const restore = (phase: CheckPhase, attempt: number, check: CutShortCheck, files: readonly RestoredFile[], before: readonly NewEvent[] = []): void => {
      state = append(checkpoint, state, [...before, { kind: 'tree.restored', version: 1, payload: { phase, attempt, check, files: [...files] } satisfies TreeRestored }]);
      writeBack(options.worktree, files, (reference) => checkpoint.evidence.read(reference));
      for (const file of files) log(`check ${check.kind} (${phase}): wrote back ${file.path}, which it changed before a kill cut it short in attempt ${String(check.attempt)}; the bytes before are ${file.before === null ? 'none, the file was absent' : 'blob' in file.before ? `at ${checkpoint.evidence.pathOf(file.before.blob)}` : `${file.before.oversized.sha256}, too large to have been kept`}`);
      const { payload } = phaseCheck(state, options.worktree, phase, attempt, 'restored', content.match);
      if (payload.drifted) log(`phase ${phase}: the worktree still differs from what the run expects after the write back: ${driftList(payload)}`);
      state = append(checkpoint, state, [{ kind: 'worktree.checked', version: 6, payload }]);
    };
    /**
     * Run one due check, or record it skipped, and append what it did: its
     * start before it runs (R7 of resumable runs), then its `check.ran@3`,
     * which names the run it replaces (R3), and a revision when it wrote
     * to files the run expects or to any other tracked file (R9, TD6 of the
     * fix pass; PD9 of commit series integrity), judged against a manifest
     * of the tracked files taken just before it into the run's own scratch.
     * A run the engine killed at its timeout records no revision: its
     * writes are no work of a complete check, so the files the run expects
     * are written back in the same step, and the check runs once more. The
     * engine runs at most one check, and no worker, at a time, so it awaits
     * the check here.
     */
    const runDueCheck = async (phase: CheckPhase, attempt: number, due: DueCheck): Promise<void> => {
      const replaces = due.replaces === null ? null : { attempt: due.replaces.run.attempt, outcome: due.replaces.run.outcome };
      if (due.skip !== null) {
        log(`check ${due.kind} (${phase}): skipped, ${due.skip}`);
        const now = new Date().toISOString();
        const skipped: CheckRan = { phase, attempt, kind: due.kind, command: due.command, outcome: 'skipped', exitCode: null, signal: null, termination: null, startedAt: now, endedAt: now, stdout: null, stderr: null, error: due.skip, replaces };
        state = append(checkpoint, state, [{ kind: 'check.ran', version: 3, payload: skipped }]);
        return;
      }
      if (due.replaces !== null) log(`check ${due.kind} (${phase}): running again; ${rerunWords(due.replaces)}`);
      log(`check ${due.kind} (${phase}): ${due.command}`);
      const timeoutMs = configuration.checks?.timeoutMs;
      if (timeoutMs === undefined) throw new Error(`Run ${runId} runs a check without the checks it pinned`);
      state = append(checkpoint, state, [{ kind: 'check.started', version: 1, payload: { phase, attempt, kind: due.kind, command: due.command } satisfies CheckStarted }]);
      const manifest = prepareCheckManifest(join(scratchBase, runId, 'checks', `${phase}-${due.kind}`), options.worktree);
      const result = await runCheck(checkpoint.evidence, { command: due.command, worktree: options.worktree, environment, toolsPath, timeoutMs, ioDirectory: join(checkpoint.root, ioDirectoryName, `check-${randomUUID()}`) });
      // The second cut of a kind in one attempt is its result, a failure that names both marks (R4 of resumable runs).
      const cutAgain = result.outcome === 'cut' && due.replaces?.why === 'cut' && due.replaces.run.attempt === attempt;
      const outcome = cutAgain ? 'failed' : result.outcome;
      const error = cutAgain ? `cut twice in attempt ${String(attempt)}: first by ${killMarkWords(due.replaces!.run)}, then by ${killMarkWords(result)}, each a kill mark` : result.error;
      log(`check ${due.kind} (${phase}): ${outcome} in ${seconds(Date.parse(result.endedAt) - Date.parse(result.startedAt))}${error === null ? '' : `: ${error}`}`);
      if (outcome === 'cut') log(`check ${due.kind} (${phase}): cut by ${killMarkWords(result)}, a kill mark; it runs again`);
      const ran: CheckRan = { phase, attempt, kind: due.kind, command: due.command, outcome, exitCode: result.exitCode, signal: result.signal, termination: result.termination, startedAt: result.startedAt, endedAt: result.endedAt, stdout: result.stdout, stderr: result.stderr, error: error === null ? null : truncated(error, maxRecordedTextLength), replaces };
      const recorded: NewEvent = { kind: 'check.ran', version: 3, payload: ran };
      // A run a kill ended, the engine's at the timeout or one from outside with a kill mark, records no revision: what it wrote is written back instead, read from the process result rather than the outcome, so a second cut, recorded failed, is written back too.
      if (result.termination === 'killed' || (result.termination === 'exited' && endedByKill(result))) {
        restore(phase, attempt, { kind: due.kind, attempt }, restoredFiles(state, options.worktree, content.match, checkpoint.evidence), [recorded]);
        return;
      }
      const revision = checkRevision(revisionContext(), phase, due.kind, due.command, manifest);
      if (revision !== null) {
        const expected = expectedTreeOf(state);
        const outside = (revision.payload as TreeRevised).files.filter((file) => !expected.has(file.path)).length;
        log(`check ${due.kind} (${phase}): rewrote ${fileCount((revision.payload as TreeRevised).files.length)}${outside === 0 ? ' the run expects' : `, ${String(outside)} of them outside what the run expects`}; recorded as its revision`);
      }
      state = append(checkpoint, state, [recorded, ...(revision === null ? [] : [revision])]);
    };

    for (;;) {
      const review = state.review!;
      const live: Live = { running: new Set(inFlight.keys()), spend: budgetSpendOf(state, adapter), evidencePath: (reference) => checkpoint.evidence.pathOf(reference), checkSettings: runCheckSettings(), claimsLost: directories.lost() };
      const step = nextStep(review, live);
      switch (step.kind) {
        case 'blocked':
          log(`run ${runId}: blocked in ${step.blocker.phase} (${step.blocker.code}): ${step.blocker.detail}`);
          return { kind: 'blocked', runId, blocker: step.blocker };
        case 'complete':
          return { kind: 'report', runId, reportPath: checkpoint.evidence.pathOf(review.report!.report) };
        case 'start-phase':
          log(`phase ${step.phase}: started (attempt ${String(step.attempt)}); ${progressWords(state, adapter, Date.now())}`);
          state = append(checkpoint, state, [{ kind: 'phase.started', version: 5, payload: { phase: step.phase, attempt: step.attempt } }]);
          break;
        case 'check-worktree': {
          // A drifted check blocks the attempt at the next step, through the planner's one drift rule.
          const { payload: check, unlisted } = phaseCheck(state, options.worktree, step.phase, step.attempt, step.moment, content.match);
          if (check.drifted) log(`phase ${step.phase}: the worktree drifted from what the run expects: ${driftList(check)}`);
          if (check.strays.length > 0) log(`phase ${step.phase}: files no worker accounts for: ${check.strays.join(', ')}${unlisted === 0 ? '' : `, and ${String(unlisted)} more the check does not list`}`);
          // Only version 6 records the check after a write back; every other check stays at version 5, which a read-only run's older reader declares.
          state = append(checkpoint, state, [{ kind: 'worktree.checked', version: step.moment === 'restored' ? 6 : 5, payload: check }]);
          break;
        }
        case 'restore-tree': {
          // A drift at the start of the attempt that a check a kill cut short explains (R7 of resumable runs): written back rather than blocked on.
          log(`phase ${step.phase}: the ${step.check.kind} check was cut short in attempt ${String(step.check.attempt)}; writing back the files it left changed: ${driftList({ files: step.files, head: null })}`);
          restore(step.phase, step.attempt, step.check, restoredFiles(state, options.worktree, content.match, checkpoint.evidence, new Set(step.files.map((file) => file.path))));
          break;
        }
        case 'plan-verification':
          log(`phase ${step.phase}: ${String(step.groups.length)} group${step.groups.length === 1 ? '' : 's'} planned`);
          state = append(checkpoint, state, [{ kind: 'verification.planned', version: 1, payload: { phase: step.phase, groups: step.groups } }]);
          break;
        case 'plan-fixes': {
          const held = step.plan.routes.filter((route) => route.route === 'held').length;
          log(`phase fixes: ${String(step.plan.clusters.length)} cluster${step.plan.clusters.length === 1 ? '' : 's'} in ${String(step.plan.batches.length)} batch${step.plan.batches.length === 1 ? '' : 'es'} planned; ${String(held)} finding${held === 1 ? '' : 's'} no fixer sees, as decided`);
          state = append(checkpoint, state, [{ kind: 'fixes.planned', version: 1, payload: step.plan }]);
          break;
        }
        case 'plan-second-round': {
          const { blocked, clusters, batches } = step.plan;
          log(blocked.length === 0 ? 'phase fixes: no finding for a second round' : `phase fixes: second round for ${blocked.map((finding) => finding.id).join(', ')}, in ${String(clusters.length)} cluster${clusters.length === 1 ? '' : 's'} and ${String(batches.length)} batch${batches.length === 1 ? '' : 'es'}`);
          state = append(checkpoint, state, [{ kind: 'fixes.replanned', version: 1, payload: step.plan }]);
          break;
        }
        case 'plan-checks': {
          // The flags of this invocation and the recorded survey, kind by kind, pinned before the triage (R6 of the repository survey); a run going on without its survey records that with the plan, in one append (R9).
          const failed = step.without === null ? [] : [surveyFailedEvent(step.without)];
          for (const check of step.checks) log(`run ${runId}: check ${check.kind}: ${checkLine(check)}`);
          state = append(checkpoint, state, [...failed, { kind: 'checks.planned', version: 3, payload: { checks: [...step.checks] } }]);
          break;
        }
        case 'run-check':
          await runDueCheck(step.phase, step.attempt, step.check);
          break;
        case 'degrade': {
          /** Log one degradation of the phase, by what it gives up, with its reason. */
          const degraded = (what: string, reason: string): void => log(`phase ${step.phase}: ${what}: ${reason}`);
          state = append(checkpoint, state, step.degradations.map((degradation): NewEvent => {
            switch (degradation.kind) {
              case 'survey.failed':
                return surveyFailedEvent(degradation.reason);
              case 'angle.failed':
                degraded(`angle ${degradation.angle} not run`, degradation.reason);
                return { kind: 'angle.failed', version: 1, payload: { angle: degradation.angle, reason: degradation.reason } };
              case 'group.unverified':
                degraded(`group ${degradation.groupId} unverified`, degradation.reason);
                return { kind: 'group.unverified', version: 1, payload: { phase: degradation.phase, groupId: degradation.groupId, reason: degradation.reason } };
              case 'unit.unattempted':
                degraded(`${degradation.key} not attempted${degradation.cause === 'budget' ? ' (budget)' : ''}`, degradation.reason);
                // What failed workers left is already recorded, with each failure (R20 of the fix pass).
                return { kind: 'unit.unattempted', version: 1, payload: { phase: degradation.phase, key: degradation.key, cause: degradation.cause, reason: degradation.reason } };
            }
          }));
          break;
        }
        case 'launch': {
          const context: PhaseContext = {
            state,
            worktree: options.worktree,
            roles: rolesByKey,
            configuration,
            scopeBlock: scopeBlockFor,
            survey: surveyInputs,
            evidence: checkpoint.evidence,
            newScratch: () => join(scratchBase, randomUUID()),
            snapshotCommand: (into) => snapshotCommandFor(engineEntry, into),
            unelevatedEditors,
            claims,
          };
          for (const unit of step.units) {
            // A fixer's claims directory is ready before its task reads the live markers and before the fixer can run the claim command into it; one this engine prepared and finds gone launches nothing more (R12).
            if (unit.phase === 'fixes' && !directories.prepare(unit.key)) break;
            const invocation = invocationFor(unit, context);
            // An editing worker's snapshots compare with the tree as it is now, from a manifest taken here, outside its sandbox (R23, TD20).
            if (invocation.scratch !== undefined) prepareSnapshots(join(invocation.scratch, snapshotsDirectoryName), options.worktree, expectedTreeOf(state).keys());
            log(`worker ${unit.role} ${unit.phase}:${unit.key}: started${batchWords(state, unit)}`);
            const startedAt = Date.now();
            const promise: Promise<Settled> = runWorker(checkpoint, runId, invocation, {
              // The finish is appended with the worker's contribution, in record (R6 of resumable runs).
              deferFinish: true,
              runtimes: options.runtimes,
              pinned,
              environment,
              toolsPath,
              platform,
              ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
              ...(options.preflightOptions === undefined ? {} : { preflightOptions: options.preflightOptions }),
            })
              .then((receipt): Settled => ({ unit, receipt }), (error: unknown): Settled => ({ unit, error }));
            inFlight.set(unitName(unit.phase, unit.key), { unit, startedAt, promise });
          }
          break;
        }
        case 'await': {
          const { settled, startedAt } = await nextSettled(inFlight);
          record(settled, startedAt);
          break;
        }
        case 'finish-phase':
          log(`phase ${step.phase}: ${step.outcome}${step.blocker === null ? '' : ` (${step.blocker.code}): ${step.blocker.detail}`}`);
          state = append(checkpoint, state, [{ kind: 'phase.finished', version: 6, payload: { phase: step.phase, attempt: step.attempt, outcome: step.outcome, blocker: step.blocker } }]);
          break;
        case 'write-report': {
          // One patch per revision, rendered from the frozen bytes in ledger order, each with the message its commit would carry (R13, R20, TD12 of the fix pass).
          const fixState = state.review!.fix;
          const revisions = fixState === null ? [] : fixState.revisions.map((revision) => ({ ...revision, change: { ...revision.change, message: revisionMessageOf(fixState, revision) } }));
          const patches = revisions.length === 0 ? [] : patchSeries(revisions, (reference) => checkpoint.evidence.read(reference), objectFormat(options.worktree), content.stored).map((patch) => checkpoint.evidence.put(patch));
          const statistics = statisticsOf(state, adapter);
          const fix = state.review!.fix === null ? {} : { fix: { evidencePath: (reference: { sha256: string; bytes: number }) => checkpoint.evidence.pathOf(reference), patches: patches.map((patch) => checkpoint.evidence.pathOf(patch)) } };
          const report = checkpoint.evidence.put(renderReport(state, { engine: checkpoint.engine, engineEntry, statistics, ...fix }));
          state = append(checkpoint, state, [
            { kind: 'report.written', version: 5, payload: { report, statistics, patches } },
            { kind: 'phase.finished', version: 6, payload: { phase: 'report', attempt: state.review!.phases.report.attempt, outcome: 'completed', blocker: null } },
          ]);
          log(`run ${runId}: report written to ${checkpoint.evidence.pathOf(report)}${patches.length === 0 ? '' : `, with ${String(patches.length)} patch${patches.length === 1 ? '' : 'es'}`}`);
          break;
        }
      }
    }
  } catch (error) {
    // A worker's own preflight failed: the runtime stopped qualifying mid-run (an update, a removed binary), which is refused as at startup, with the action for the executable the run pinned; the run is active, a continued one too once pinned, so it can be abandoned.
    const configuration = state.review?.configuration ?? null;
    throw refusalOf(error, configuration === null ? null : { runId, executable: configuration.executable, use: 'resume' });
  } finally {
    // No way out of the loop leaves a worker running: after a launcher error,
    // a failed append or any other throw, the rest are awaited and their
    // answers recorded, so every finish reaches the ledger before the lock
    // is released and the caller closes the checkpoint. A failure to record
    // one is logged; the error that ended the loop is the one that surfaces.
    if (inFlight.size > 0) log(`run ${runId}: waiting for ${String(inFlight.size)} worker${inFlight.size === 1 ? '' : 's'} in flight`);
    while (inFlight.size > 0) {
      const { settled, startedAt } = await nextSettled(inFlight);
      try {
        record(settled, startedAt);
      } catch (error) {
        log(`worker ${settled.unit.role} ${unitName(settled.unit.phase, settled.unit.key)}: not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    release();
  }
}

/**
 * A failed preflight as the `runtime-unqualified` refusal, with the
 * operator's action; any other error as it is. The action depends on
 * whether the executable was pinned: `pinned` names the configured run, its
 * executable and whether it is resumed or continued, which names another
 * way out (`wayOut`), or is null for a run not yet configured, whose
 * `--executable` still applies. A probe that only ran past its timeout is
 * refused the same way, with the reinstall action, although nothing showed
 * the executable stopped qualifying:
 * https://github.com/josephjang/deep-review/issues/34
 */
function refusalOf(error: unknown, pinned: { readonly runId: string; readonly executable: string; readonly use: PinnedUse } | null): unknown {
  if (!(error instanceof PreflightError)) return error;
  const action = pinned === null ? blockerActions['runtime-unqualified'] : pinnedRuntimeAction(pinned.runId, pinned.executable, pinned.use);
  return new ReviewRefusedError(`${error.message}; ${action}`, 'runtime-unqualified');
}

/** The first worker in flight to settle, taken off the map, with the time it started. */
async function nextSettled(inFlight: Map<string, InFlight>): Promise<{ settled: Settled; startedAt: number }> {
  const settled = await Promise.race([...inFlight.values()].map((entry) => entry.promise));
  const name = unitName(settled.unit.phase, settled.unit.key);
  const entry = inFlight.get(name)!;
  inFlight.delete(name);
  return { settled, startedAt: entry.startedAt };
}

/**
 * The warning a fix run whose editors work in Codex's unelevated Windows
 * sandbox prints at the start of every invocation (R5 of the Codex
 * sandbox): what its editors cannot run, and the two settings a run can
 * be started with instead. The run is configured before the warning, on
 * its first invocation as on a resume, and a resume refuses a sandbox
 * other than the pinned one (`resumePinned`), so the warning says the
 * run must be abandoned before another sandbox can apply.
 */
export function unelevatedEditorsWarning(runId: string): string {
  return `run ${runId}: warning: its fixers and repair worker run in Codex's unelevated Windows sandbox, where a Node process cannot start a child whose output it captures, so they cannot run tools that start processes through Node, which includes most build and test commands; the sandbox is pinned on the run, so to run them abandon it with \`deep-review abandon --run ${runId} --reason <text>\` and start a new run with --codex-windows-sandbox elevated, which needs Codex's elevated setup, or none, which runs them in no sandbox`;
}

/**
 * The runtime options a run's configuration pins: the Codex Windows
 * sandbox, or none for a run that pins none (R2 of the Codex sandbox),
 * passed to every launch so a resumed run's workers are confined as its
 * first ones were, whatever runtimes the caller passed.
 */
function pinnedRuntimeOptionsOf(configuration: Pick<ReviewConfiguration, 'codex'>): PinnedRuntimeOptions {
  return configuration.codex === null ? {} : { codex: { windowsSandbox: configuration.codex.windowsSandbox } };
}

/** What opening a run needs beyond the review's options. */
interface OpenContext extends ReviewOptions {
  readonly log: (line: string) => void;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly adapter: RuntimeAdapter;
  readonly roles: readonly AssembledRole[];
  /** How the run compares a file with what it expects, as git would store each (R22 of the fix pass), which a finished run's files are compared by before it is continued. */
  readonly match: ExpectedMatch;
  /** The invocation's configuration: the caller's, or the one of its flags alone (`unconfiguredSource`). */
  readonly source: ConfigurationSource;
}

/** What holding a configured run to its pin reads beside the run (`resumePinned`): the configuration only to compare a resumed run with what it recorded. */
type PinnedContext = Pick<OpenContext, 'roles' | 'rolesRoot' | 'adapter' | 'flags' | 'fix' | 'platform' | 'environment' | 'preflightOptions' | 'log'> & { readonly source?: ConfigurationSource | undefined; readonly executable?: OpenContext['executable'] };

/** What `requirePinned` reads beside the run: the review's options a resume holds the run with, and the adapter of the run's runtime. */
export interface PinnedOptions extends Pick<ReviewOptions, 'rolesRoot' | 'platform' | 'environment' | 'preflightOptions'> {
  readonly adapter: RuntimeAdapter;
  readonly flags: PolicyFlags;
  readonly log: (line: string) => void;
}

/**
 * Hold a complete run to what resuming it for an answer pass checks,
 * before the pass reopens it (R6 of answers): its roles must digest as
 * pinned, the flags must agree with its pin and its pinned executable
 * must qualify, each refused as `resumePinned` refuses a resume, naming
 * the answer applied by hand as the way out. The run is still complete
 * then, so a refusal leaves it complete with its report.
 */
export async function requirePinned(run: RunState, options: PinnedOptions): Promise<void> {
  const context: PinnedContext = { ...options, roles: assembleRoles(options.rolesRoot), platform: options.platform ?? process.platform, environment: options.environment ?? process.env };
  await resumePinned(run, run.review!.configuration, context, 'answer', settingOf(run.review!.configuration, 'tools.path').value ?? []);
}

/** An open run: its state, the release of its lock, and what it still needs before its first step. */
interface OpenedRun {
  readonly state: RunState;
  readonly release: ReleaseLock;
  /** The scope to capture, for a run that has none yet, with the patterns `scope.exclude` leaves out and the base its configuration was read at; null for one that captured it. */
  readonly capture: { readonly request: ScopeRequest; readonly exclude: readonly string[]; readonly base: string } | null;
  /** The configuration to pin, for a run not yet configured, with the settings it was resolved from; null for one whose configuration is pinned. */
  readonly configure: { readonly payload: ReviewConfigurationV6; readonly resolved: ResolvedSettings } | null;
  /** The continuation to pin, for a finished read-only run this command continues into the fix pass, with where its read-only report is; null otherwise (R1 of fix pass continuation). */
  readonly continuation: { readonly pin: FixPinnedV2; readonly report: string } | null;
}

/**
 * The finished runs a `review --fix` may continue (R2 of fix pass
 * continuation), newest first: the finished read-only runs of this
 * worktree that `notContinuable` gives no reason against, so never
 * continued and configured with the decision step, whose decisions a fix
 * run routes its findings by.
 */
function continuable(runs: readonly RunState[], worktree: string): RunState[] {
  return finishedReadOnly(runs, worktree).filter((run) => notContinuable(run) === null);
}

/** The complete runs of this worktree configured without the fix pass, continued since or not, newest first: the ones a `review --fix` names when it continues none. */
function finishedReadOnly(runs: readonly RunState[], worktree: string): RunState[] {
  return runs
    .filter((run) => reviewStatus(run) === 'complete' && run.review !== null && (run.review.fix === null || run.review.continuedFrom !== null) && sameDirectory(run.worktree, worktree))
    .reverse();
}

/** Why a finished read-only run is not a candidate for a continuation at all, or null when it is one: it was continued already, or configured before the decision step. */
function notContinuable(run: RunState): string | null {
  if (run.review?.continuedFrom !== null && run.review?.continuedFrom !== undefined) return 'it was continued into the fix pass already';
  if (run.review?.phases.decision.status === 'skipped') return 'it was configured before the decision step, which a fix run routes its findings by';
  return null;
}

/**
 * The counts of a run's decisions that route no finding to a fixer, as a
 * continuation refuses them (R5, PD6 of fix pass continuation), or null
 * when some finding routes to one, by its decision or by a person's answer
 * that owes an edit (R4 of answers).
 */
function nothingToFix(run: RunState): string | null {
  const review = run.review;
  const decisions = review?.decisions ?? [];
  if (review !== null && decisions.some((decision) => routeOf(decision, standingAnswer(review, decision.id)) === 'fixer')) return null;
  if (decisions.length === 0) return 'its review ranked no finding';
  const counts = decisionCounts(decisions);
  return `${String(counts.fix)} decided fix, ${String(counts.leave)} left, ${String(counts.ask)} asked with the code kept`;
}

/**
 * Find the active run or create one, and take its run lock, all under the
 * checkpoint's start lock: two engines started together would otherwise
 * both find no run and create one each. A found run is read again once its
 * lock is held, since the engine that held the lock until a moment ago may
 * have appended after the find (a late worker finish, its report); one no
 * longer resumable is let go, and the command goes on as if none had been
 * found, with that run as it is now among the runs a `--fix` may
 * continue. Everything that depends on the run is decided from that one read:
 *
 * - A run with no scope yet, new or left by a capture that failed, gets
 *   the command's scope request, resolved before a new run is created so
 *   a refused request creates nothing; a run that has one ignores the
 *   command's, and says so.
 * - A configured run reads its pinned configuration, not the policy file
 *   or the flags (R3, design: role policy): its roles must still digest
 *   as pinned, and its pinned executable is what is preflighted. Only
 *   `--concurrency` and `--budget-usd` apply per invocation, and the
 *   limits they put in force are recorded when they change; `--check` and
 *   `--no-check` apply until the checks are planned. A run not yet
 *   configured resolves the policy and the command's executable and
 *   preflights it, before a new run is created so a refusal creates
 *   nothing.
 *
 * The run lock is taken before the preflight for a found run, so an
 * engine running it refuses this one at once, and is released on every
 * way out: the caller's release, the process's exit, and a signal that
 * ends it (design, run lifecycle step 2).
 *
 * With no active run, `--fix` and no `--fresh`, a finished read-only run
 * of this change is continued instead of a run created (R1, R2 of fix
 * pass continuation): the newest that qualifies and whose scope the
 * command names as it is (`chooseContinuation`), taken under its lock
 * and read again, as a found run is. One that another engine continued
 * meanwhile is resumable now and is resumed; one that no longer qualifies
 * for another reason is let go, and a run is created.
 */
async function openRun(context: OpenContext): Promise<OpenedRun> {
  const { checkpoint, log } = context;
  const releaseStart = releaseOnExit(acquireStartLock(checkpoint.root));
  let release: ReleaseLock | null = null;
  try {
    let runs = readableRuns(checkpoint, log);
    let found = activeRunAmong(runs);
    // With --fix and no active run, a finished read-only run may be continued rather than a run created.
    const fixing = (context.fix ?? null) !== null;
    // The checkpoint is shared by every worktree of the repository, while a run's scope, worktree checks and workers belong to the worktree it was created in.
    if (found !== null && !sameDirectory(found.worktree, context.worktree)) {
      throw new ReviewRefusedError(`run ${found.id} is active in worktree ${found.worktree}, not ${context.worktree}; run the command there, or abandon the run with \`deep-review abandon --run ${found.id} --reason <text>\``);
    }
    if (found !== null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, found.id));
      // Read again under the lock: what the find returned may predate the last appends of the engine that held it, which may be a build that declares events this one does not.
      found = refoldUnderLock(checkpoint, found.id, log);
      if (found !== null && !isResumable(found)) {
        // The run as it is now replaces what the find read, so a run another engine just finished is one a --fix may continue.
        const refolded = found;
        runs = runs.map((run) => (run.id === refolded.id ? refolded : run));
        log(`run ${found.id}: ${reviewStatus(found)} before its lock was taken${fixing ? '' : '; a new run is created'}`);
        found = null;
      }
      if (found === null) {
        release();
        release = null;
      }
    }
    // An active run is resumed first, --fresh or not (R2 of fix pass continuation).
    if (found !== null && context.fresh === true) log(`run ${found.id} is active and resumes; --fresh is ignored`);
    const scopeRequestOf = once(() => context.scope.request());
    if (found === null && fixing) {
      const chosen = chooseContinuation(runs, context, scopeRequestOf);
      if (chosen !== null) {
        release = releaseOnExit(acquireRunLock(checkpoint.root, chosen.id));
        const refolded = refoldUnderLock(checkpoint, chosen.id, log);
        if (refolded !== null && reviewStatus(refolded) === 'complete' && refolded.review?.fix === null) {
          // The pin is returned, not appended under the start lock as a new run is created: https://github.com/josephjang/deep-review/issues/44
          return { state: refolded, release, capture: null, configure: null, continuation: await continuationOf(refolded, context) };
        }
        // Another engine continued it between the find and the lock: it is this worktree's active run now, and is resumed rather than joined by a second.
        if (refolded !== null && isResumable(refolded)) found = refolded;
        else {
          // Abandoned, or continued and finished, by another engine; one this engine cannot read was passed over with its line.
          if (refolded !== null) log(`run ${refolded.id}: ${refolded.status === 'abandoned' ? 'abandoned' : 'continued into the fix pass by another engine'} before its lock was taken; a new run is created`);
          release();
          release = null;
        }
      }
    }
    const pinned = found?.review?.configuration ?? null;
    if (found !== null && pinned !== null) refuseOtherRuntime(found.id, pinned, context.runtime, 'abandon it');
    if (found !== null) {
      log(`run ${found.id}: resuming${found.scope === null ? '; it has no scope yet and captures the one this command names' : ''}`);
      if (found.scope !== null && context.scope.named) log(`run ${found.id} is active; its scope flags are ignored and the run continues`);
    }
    const scopeRequest = found === null || found.scope === null ? scopeRequestOf() : null;
    let configure: OpenedRun['configure'] = null;
    let capture: OpenedRun['capture'] = null;
    if (found !== null && pinned !== null) {
      // Compared only with a configuration the caller gave: one that gives none, as an answer pass, reads no file for it (R6 of the configuration).
      await resumePinned(found, pinned, { ...context, source: context.configuration }, 'resume', settingOf(pinned, 'tools.path').value ?? []);
    } else {
      const policy = readPolicy(context.rolesRoot);
      // Pass 2, at the base of the change: the one a run that captured its scope recorded, else the one the request names now (R4 of the configuration).
      const base = found?.scope?.base ?? scopeBase(context.worktree, scopeRequest!);
      let resolved = context.source.resolve({ base, policy, runtime: context.adapter.name, costInUsd: context.adapter.capabilities.costInUsd });
      if (scopeRequest !== null) {
        const exclude = resolvedValue(resolved, 'scope.exclude') ?? [];
        // The change is listed with its exclusions before the run exists, so one with no path left to review creates nothing (R10 of the configuration).
        const listed = refusingEmptyChange(() => resolveScopeRequest(context.worktree, scopeRequest, exclude));
        resolved = withChangedPaths(resolved, [...listed.changes.map((change) => change.path), ...listed.excluded]);
        capture = { request: scopeRequest, exclude, base };
      } else if (found?.scope !== null && found?.scope !== undefined) {
        // A run stopped between its capture and its configuration records the patterns its scope was cut with, whose layer the capture did not record, so other patterns are refused rather than recorded beside it.
        const captured = found.scope.request.exclude;
        const exclude = resolvedValue(resolved, 'scope.exclude') ?? [];
        if (exclude.length !== captured.length || exclude.some((pattern, index) => pattern !== captured[index])) {
          throw new ReviewRefusedError(`run ${found.id} captured its scope with scope.exclude ${JSON.stringify(captured)}, but this command's settings give ${JSON.stringify(exclude)}; run it with settings that give the captured patterns, as --set 'scope.exclude=${JSON.stringify(captured)}', or ${wayOut(found.id, 'resume')}`);
        }
        resolved = withChangedPaths(resolved, [...found.scope.files.map((file) => file.path), ...found.scope.excluded.paths]);
      }
      const policyResolved = resolvePolicy(policy, context.roles, context.adapter, context.flags, context.platform, policyOverridesOf(resolved));
      if (context.flags.codexWindowsSandbox !== undefined && policyResolved.codex === null) log(`--codex-windows-sandbox applies on Windows only; it is ignored on ${context.platform}, where every Codex worker runs as without it`);
      const fix = context.fix ?? null;
      // A fix run's fixers run the engine's own commands with the first node on PATH, which tools.path comes first on; the files are on this machine, whatever platform the run is configured for.
      const toolsPath = resolvedValue(resolved, 'tools.path') ?? [];
      if (fix !== null) refuseOldNode(toolsPath, process.platform);
      const configured = executableOf(resolved);
      const executable = typeof context.executable === 'function' ? context.executable(configured.executable) : context.executable;
      const executableArgs = [...configured.args];
      const version = await qualify(context.adapter, executable, executableArgs, toolsPath, context, null);
      const { checks, fixes, survey, ...rest } = policyResolved;
      const payload = { ...rest, roles: [...policyResolved.roles], executable, executableArgs, version, fix: fix !== null, checks: fix === null ? null : checks, fixes: fix === null ? null : fixes, survey };
      configure = { payload: { ...payload, settings: settingsRecordOf(resolved, payload) }, resolved };
      // Checked before the run exists: a configuration the ledger would refuse must not leave a run with its scope and no configuration behind.
      const recordable = reviewConfiguredV6.safeParse(configure.payload);
      if (!recordable.success) throw new Error(`The engine built a configuration its ledger refuses, so no run is created: ${recordable.error.message}`);
    }
    const state = found ?? checkpoint.createRun({ worktree: context.worktree });
    if (found === null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, state.id));
      log(`run ${state.id}: created`);
    }
    return { state, release: release!, capture, configure, continuation: null };
  } catch (error) {
    release?.();
    throw error;
  } finally {
    releaseStart();
  }
}

/**
 * The finished read-only run a `review --fix` continues (R2, TD8 of fix
 * pass continuation): the newest that qualifies (`continuable`) whose
 * scope the command names, its files as git would store them what the run
 * froze and `HEAD` at its head (`scopeMismatch`), the change as the run's
 * own `scope.exclude` leaves it. The request is resolved once per set of
 * patterns, from the first candidate on, and none is resolved when no run
 * qualifies. A candidate whose patterns refuse the change, leaving it
 * empty or a `--path` with only what they leave out, is passed over with
 * that refusal as its reason; a request the tree refutes with no pattern
 * throws there. None with `--fresh`,
 * which says so. When none matches, the log says a new run is created,
 * and names the newest finished read-only run of this worktree with the
 * first reason it was not continued. Either way, it names each run passed
 * over whose answers do not carry to the new run.
 */
function chooseContinuation(runs: readonly RunState[], context: OpenContext, request: () => ScopeRequest): RunState | null {
  if (context.fresh === true) {
    context.log('--fresh: no finished run is considered; a new run is created');
    logAnswersNotCarried(runs, context);
    return null;
  }
  // Each candidate is compared with the change as its own patterns leave it, so a run that left dist/ out is the same change today; the request is resolved once per set of patterns.
  const resolutions = new Map<string, ResolvedScope | { readonly refused: string }>();
  const resolved = (exclude: readonly string[]): ResolvedScope | { readonly refused: string } => {
    const key = JSON.stringify(exclude);
    const known = resolutions.get(key);
    if (known !== undefined) return known;
    const scopeRequest = request();
    let made: ResolvedScope | { readonly refused: string };
    if (exclude.length === 0) made = refusingEmptyChange(() => resolveScopeRequest(context.worktree, scopeRequest, exclude));
    else {
      try {
        made = resolveScopeRequest(context.worktree, scopeRequest, exclude);
      } catch (error) {
        if (!(error instanceof EmptyChangeError || error instanceof InvalidScopeRequestError)) throw error;
        // A refusal the request meets with no pattern ends the command there; one only this run's patterns cause passes the run over.
        resolved([]);
        made = { refused: `its scope.exclude refuses the change named: ${error.message}` };
      }
    }
    resolutions.set(key, made);
    return made;
  };
  const reasons = new Map<string, string>();
  for (const run of continuable(runs, context.worktree)) {
    const listed = resolved(run.scope!.request.exclude);
    const reason = 'refused' in listed ? listed.refused : scopeMismatch(listed, run.scope!, () => findDrift(run, context.worktree, context.match).files.map((file) => file.path));
    if (reason === null) return run;
    reasons.set(run.id, reason);
  }
  context.log('--fix: no finished read-only run of this worktree reviewed this change as it is; a new run is created');
  const newest = finishedReadOnly(runs, context.worktree)[0];
  if (newest !== undefined) {
    const reason = notContinuable(newest) ?? reasons.get(newest.id);
    if (reason === undefined) throw new Error(`Run ${newest.id} was neither tried nor ruled out as a continuation`);
    context.log(`run ${newest.id}: not continued: ${reason}`);
  }
  logAnswersNotCarried(runs, context);
  return null;
}

/** Name each continuable run of this worktree a new run passes over whose person's answers stay with it, since the new run does not carry them (R4 of answers). */
function logAnswersNotCarried(runs: readonly RunState[], context: OpenContext): void {
  for (const run of continuable(runs, context.worktree)) {
    const answered = new Set(run.review?.answers.map((answer) => answer.id) ?? []).size;
    if (answered > 0) context.log(`run ${run.id}: its answers to ${String(answered)} finding${answered === 1 ? '' : 's'} stay recorded on it and do not carry to the new run`);
  }
}

/**
 * What continuing a finished read-only run pins (R3 to R6 of fix pass
 * continuation), or a refusal that leaves it complete, in this order: a
 * run whose decisions route no finding to a fixer is refused; the
 * settings are resolved at the run's base (R6 of the configuration), and
 * a run that went on without its survey is refused unless they settle
 * every check; the run is held to its runtime; one whose spend already
 * reaches the run budget in force is refused, naming `--budget-usd`; and
 * the run is held to its roles digest, Codex Windows sandbox and
 * executable as a resume holds a run, with `--fresh` as the way out. The
 * executable's preflight comes last, so a run refused anyway does not
 * spawn it. The pin carries the settings' per-check timeout, the
 * policy's batch size, the settings' plan of the checks when they settle
 * every kind, and the fix side of the settings with their layers.
 */
async function continuationOf(run: RunState, context: OpenContext): Promise<{ pin: FixPinnedV2; report: string }> {
  const review = run.review!;
  // The refusals that read only the ledger come first, so a run refused anyway is not first refused for a configuration file, its executable, nor its preflight spawned.
  const nothing = nothingToFix(run);
  if (nothing !== null) throw new ReviewRefusedError(`run ${run.id} has no finding to fix: ${nothing}; nothing to continue; ${wayOut(run.id, 'continue')} to review it again`);
  // Pass 2 again, at the run's recorded base, so the repository's values are the ones its review had; the operator's files and the flags are this invocation's (R6 of the configuration).
  const policy = readPolicy(context.rolesRoot);
  const scope = run.scope!;
  // The change is the run's, so its paths, the ones left out among them, say whether it edits the repository's file (R4).
  const resolved = withChangedPaths(context.source.resolve({ base: scope.base, policy, runtime: context.adapter.name, costInUsd: context.adapter.capabilities.costInUsd }), [...scope.files.map((file) => file.path), ...scope.excluded.paths]);
  // The fix pass's workers run with the tools.path the pin records, this invocation's.
  const toolsPath = resolvedValue(resolved, 'tools.path') ?? [];
  refuseOldNode(toolsPath, process.platform);
  const settled = checkSettingsOfResolved(resolved);
  const unsettled = unsettledKinds(settled);
  if ((review.survey?.failure ?? null) !== null && unsettled.length > 0) {
    throw new ReviewRefusedError(`run ${run.id} went on without its survey, so a continuation needs every check settled: give --check <kind>=<command> or --no-check <kind>, or set checks.<kind>, for ${unsettled.join(', ')}, or ${wayOut(run.id, 'continue')}`);
  }
  refuseOtherRuntime(run.id, review.configuration, context.runtime, wayOut(run.id, 'continue'));
  // The run budget counts both passes (PD7), and a fixes phase that meets it marks every fixer unattempted rather than blocking, so a run already at its budget is refused while it can still be continued. Its spend is read with the adapter of the run's runtime, so after the runtime is held, and before the preflight.
  const reached = budgetReached(run, context.flags, context.adapter);
  if (reached !== null) {
    throw new ReviewRefusedError(`run ${run.id} ${budgetBlocker(reached.spend, reached.runBudgetUsd).detail}, so no fixer could launch; nothing to continue; run it again with --budget-usd above ${reached.spend.usd.toFixed(2)}, or ${wayOut(run.id, 'continue')}`);
  }
  await resumePinned(run, review.configuration, context, 'continue', toolsPath);
  const plannedChecks = unsettled.length === 0 ? [...resolveChecks(null, settled).checks] : null;
  // The settings' check timeout as a new run's policy takes it, so both passes pin it the same way.
  return {
    pin: { checks: { timeoutMs: policyOverridesOf(resolved).checksTimeoutMs ?? policy.checks.timeoutMs }, fixes: { batchSize: policy.fixes.batchSize }, plannedChecks, settings: fixSettingsRecordOf(resolved) },
    report: context.checkpoint.evidence.pathOf(review.report!.report),
  };
}

/** Refuse a run pinned to another runtime than the command's, naming the flag and `way` out. */
function refuseOtherRuntime(runId: string, pinned: Pick<ReviewConfiguration, 'runtime'>, runtime: string, way: string): void {
  if (pinned.runtime !== runtime) throw new ReviewRefusedError(`run ${runId} is pinned to runtime ${pinned.runtime}, not ${runtime}; run it with --runtime ${pinned.runtime}, or ${way}`);
}

/**
 * Hold a configured run to what it pinned before it resumes: a fix run
 * configured before the decision step that has not planned its fixes is
 * refused first, since it has no decision to route them by and no roles
 * make it one (R6 of the decision step); the role
 * prompts it ran must still digest as pinned, so the report's digest says
 * which prompts every worker got; the flags that apply per invocation are
 * checked as a new run's are, and the model flags, which do not apply,
 * are named as ignored as the invocation spelled them, as are the check flags once the checks are
 * planned; before then, a fix run is told the check flags must be given
 * again, and the kinds it can tell an earlier invocation's flags settled
 * and this one's do not are named; a `--codex-windows-sandbox` is named
 * as ignored when the run resumes off Windows, whatever it pinned, or
 * pinned none because it was configured off Windows, and is refused when
 * it names another value than the pinned one; the pinned executable, not
 * the command's, must still qualify, with `toolsPath`, the directories
 * the run's workers will find first on PATH, first on it.
 *
 * A finished read-only run continued into the fix pass is held the same
 * way (R3, TD6 of fix pass continuation), its refusals naming a new run
 * with `--fresh` where a resume's name abandoning it; whether it fixes and
 * its check flags are the continuation's to say, not a resume's. A complete
 * run an answer pass would reopen is held the same way before the pass
 * opens (`requirePinned`), its refusals naming the answer applied by hand.
 */
async function resumePinned(run: RunState, pinned: ReviewConfiguration, context: PinnedContext, use: PinnedUse, toolsPath: readonly string[]): Promise<void> {
  const runId = run.id;
  // A fix run routes its findings by their decisions (R6 of the decision step); one configured before the decision step has none to route by, so it cannot go on to plan its fixes, whatever roles it is given.
  if (pinned.fix && run.review?.phases.decision.status === 'skipped' && (run.review.fix?.plan ?? null) === null) {
    throw new ReviewRefusedError(`run ${runId} was configured before the decision step, which a fix run now routes its findings by, and has not planned its fixes; abandon it with \`deep-review abandon --run ${runId} --reason <text>\` and start a new run`);
  }
  const digest = rolesDigest(context.roles);
  if (digest !== pinned.rolesDigest) {
    throw new ReviewRefusedError(`run ${runId} was configured with roles digest ${pinned.rolesDigest}, and the roles at ${context.rolesRoot} now digest ${digest}; run it with the roles it started with (--roles <dir>), or ${wayOut(runId, use)}`);
  }
  refuseInvocationFlags(context.adapter, context.flags);
  // How the run's workers are confined is pinned at configuration (R3 of the Codex sandbox): a resume asking for another confinement is refused, not silently given the pinned one.
  // Off Windows no sandbox applies whatever the run pinned, so the flag is ignored there as a new run's is (R1); that includes a Codex run configured at version 3 or earlier from a Windows worktree, which folds to unelevated.
  const sandbox = context.flags.codexWindowsSandbox;
  if (sandbox !== undefined) {
    const applied = pinnedWindowsSandbox(pinned, context.platform);
    if (context.platform !== 'win32') {
      context.log(`--codex-windows-sandbox applies on Windows only; it is ignored on ${context.platform}, where every Codex worker of run ${runId} runs as without it`);
    } else if (applied === null) {
      context.log(`run ${runId} pins no Codex Windows sandbox, since it was not configured on Windows; --codex-windows-sandbox is ignored`);
    } else if (sandbox !== applied) {
      throw new ReviewRefusedError(`run ${runId} is pinned to the Codex Windows sandbox ${applied}, not ${sandbox}; run it with --codex-windows-sandbox ${applied} or without the flag, or ${wayOut(runId, use)}`);
    }
  }
  if (context.flags.strongModel !== undefined || context.flags.fastModel !== undefined) {
    context.log(`run ${runId} is pinned to models ${pinned.models.strong} and ${pinned.models.fast}; ${modelFlagsWords(pinned.runtime, context.source)} ignored`);
  }
  if (use === 'resume') resumedFixFlags(run, pinned, context);
  if (use === 'resume') unappliedSettings(run, pinned, context);
  await qualify(context.adapter, pinned.executable, pinned.executableArgs, toolsPath, context, { runId, use });
}

/** The model flags an invocation gave, as it spelled them, `--set` or the dedicated flag, with their verb; `--strong-model and --fast-model` when it gives no source to tell. */
function modelFlagsWords(runtime: string, source: ConfigurationSource | undefined): string {
  const names = isConfiguredRuntime(runtime) ? runtimeSettingNames(runtime) : null;
  const given = source === undefined || names === null ? [] : [names.strong, names.fast].flatMap((name) => source.flags.get(name)?.flag ?? []);
  if (given.length === 0) return '--strong-model and --fast-model are';
  return `${given.join(' and ')} ${given.length === 1 ? 'is' : 'are'}`;
}

/**
 * What a resumed run says of `--fix`, `--check` and `--no-check`: whether
 * the run fixes is pinned at configuration (R1 of the fix pass), so a
 * read-only run names `--fix` ignored and, when it was configured with the
 * decision step and so can be continued (`continuable`), how it is
 * continued once its report is written (R10 of fix pass continuation);
 * the check flags settle their kinds until the checks are planned (TD6 of
 * the repository survey), and are named and ignored after.
 */
function resumedFixFlags(run: RunState, pinned: ReviewConfiguration, context: PinnedContext): void {
  const runId = run.id;
  const fix = context.fix ?? null;
  const checkFlags = fix !== null && checkKinds.some((kind) => isSettled(fix, kind));
  const howContinued = run.review?.phases.decision.status === 'skipped' ? '' : '; once its report is written, run again with --fix to continue it into the fix pass';
  if (!pinned.fix && fix !== null) context.log(`run ${runId} is pinned without the fix pass; --fix${checkFlags ? ', --check and --no-check are' : ' is'} ignored${howContinued}`);
  if (pinned.fix && fix === null) context.log(`run ${runId} is pinned to the fix pass and continues it; the absence of --fix is ignored`);
  const planned = (run.review?.fix?.checks.planned ?? null) !== null;
  // A run that recorded its check settings keeps them, so only the flags of a later invocation need giving again (R11 of the configuration).
  const recorded = recordedCheckSettings(pinned) !== null;
  if (pinned.fix && checkFlags && planned) context.log(`run ${runId} keeps the checks it pinned; --check and --no-check are ignored`);
  if (pinned.fix && !planned) {
    // The flags are not on the ledger until the plan records them, so an invocation that omits one an earlier invocation gave drops it.
    context.log(recorded
      ? `run ${runId} has not planned its checks yet; it keeps the check settings it recorded, and --check and --no-check apply over them to each invocation until it plans them, so give again every one an earlier resume gave`
      : `run ${runId} has not planned its checks yet; --check and --no-check apply to each invocation until it does, so give again every one an earlier invocation gave`);
    const unsettled = droppedSinceSurvey(run.review?.survey ?? null, checkSettingsInForce(recordedCheckSettings(pinned), fix));
    if (unsettled.length > 0) {
      context.log(`run ${runId}: its survey was asked with --check or --no-check settling ${unsettled.join(', ')}, which this invocation leaves unsettled, so the survey is asked again for ${unsettled.length === 1 ? 'it' : 'them'}; give those flags again to keep them`);
    }
  }
}

/**
 * What a resumed run says of the settings as they are now (R6 of the
 * configuration): it keeps the ones it recorded, so the files are read
 * again only to name what changed and is not applied. A file the engine
 * cannot read now is named the same way and does not stop the resume.
 * The executable setting is resolved as a new run's would be, to compare
 * the path with the pinned one. A run recorded before the settings has
 * nothing to compare, unless a continuation recorded its fix side since.
 */
function unappliedSettings(run: RunState, pinned: ReviewConfiguration, context: PinnedContext): void {
  if ((pinned.settings === null && pinned.fixSettings === null) || run.scope === null || context.source === undefined || context.executable === undefined) return;
  let now: ResolvedSettings;
  try {
    now = context.source.resolve({ base: run.scope.base, policy: readPolicy(context.rolesRoot), runtime: context.adapter.name, costInUsd: context.adapter.capabilities.costInUsd });
  } catch (error) {
    context.log(`run ${run.id}: the configuration cannot be read now, so the run keeps the settings it recorded: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const line of unappliedLines(run.id, pinned, now, context.source.flags, context.executable)) context.log(line);
}

/**
 * The kinds a flag settled when the survey's last answer was asked for,
 * and which this invocation's flags leave unsettled. The flags of an
 * invocation are recorded only with the plan, but a fix run's answer
 * chooses a check for exactly the kinds no flag settled (R8 of the
 * repository survey), so a kind it has no check for was settled by a flag
 * then. None while the survey has not answered, or for a run that does
 * not fix.
 */
function droppedSinceSurvey(survey: SurveyState | null, flags: CheckSettings | null): CheckKind[] {
  const checks = survey === null ? null : (lastSurvey(survey)?.checks ?? null);
  if (checks === null) return [];
  return checkKinds.filter((kind) => !checks.some((check) => check.kind === kind) && (flags === null || !isSettled(flags, kind)));
}

/**
 * Preflight the executable with `toolsPath` first on PATH, as every worker
 * runs it, and return its version, or refuse with `runtime-unqualified`;
 * `pinnedBy` names the configured run that pinned it and how it is held to
 * it, or is null for a new run.
 */
async function qualify(adapter: RuntimeAdapter, executable: string, executableArgs: readonly string[], toolsPath: readonly string[], context: Pick<OpenContext, 'environment' | 'platform' | 'preflightOptions'>, pinnedBy: { readonly runId: string; readonly use: PinnedUse } | null): Promise<string> {
  try {
    return await preflight(adapter, executable, [...executableArgs], withPathFirst(context.environment, toolsPath, context.platform), context.preflightOptions ?? {});
  } catch (error) {
    throw refusalOf(error, pinnedBy === null ? null : { ...pinnedBy, executable });
  }
}

/**
 * Append with the state's sequence, once. While it holds the run lock the
 * controller is the run's one writer: another engine and `abandon` take
 * that lock first; a found run is read again once its lock is held; and
 * the launchers of the workers in flight append only while the controller
 * awaits them, after which `record` folds afresh. So the events were
 * planned from the ledger as it is, and a `StaleRevisionError` means
 * another writer broke in: it is thrown, never retried, since a retry would
 * re-send events planned without what that writer appended.
 */
function append(checkpoint: Checkpoint, state: RunState, events: readonly NewEvent[]): RunState {
  return checkpoint.append(state.id, state.lastSequence, events);
}

/**
 * The concurrency and the run budget this invocation puts in force: each
 * flag when given, else the pinned value. Both are per invocation, since a
 * higher budget is how a budget blocker is cleared and a smaller
 * concurrency is how a machine is spared. A runtime that reports no cost
 * has no budget to check.
 */
function limitsInForce(configuration: ReviewConfiguration, flags: Pick<PolicyFlags, 'concurrency' | 'budgetUsd'>, adapter: Pick<RuntimeAdapter, 'capabilities'>): ReviewLimits {
  return {
    concurrency: flags.concurrency ?? configuration.concurrency,
    runBudgetUsd: adapter.capabilities.costInUsd ? (flags.budgetUsd ?? configuration.runBudgetUsd) : null,
  };
}

/**
 * The spend of a reviewed run and the run budget this invocation puts in
 * force (`limitsInForce`) when the spend has reached it, else null: the
 * check that refuses reopening a finished run for more fixer work, by a
 * continuation or an answer pass, since the fixes phase would launch no
 * fixer. `adapter` is the one of the run's runtime, which prices its spend.
 */
export function budgetReached(run: RunState, flags: Pick<PolicyFlags, 'budgetUsd'>, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>): { spend: BudgetSpend & { readonly usd: number }; runBudgetUsd: number } | null {
  const spend = budgetSpendOf(run, adapter);
  const { runBudgetUsd } = limitsInForce(run.review!.configuration, flags, adapter);
  return spend.usd !== null && runBudgetUsd !== null && spend.usd >= runBudgetUsd ? { spend: { ...spend, usd: spend.usd }, runBudgetUsd } : null;
}

/** Record the limits this invocation puts in force when they differ from the ones the run has, so the planner, `status` and the report read the ones in force. */
function recordLimits(checkpoint: Checkpoint, state: RunState, limits: ReviewLimits, log: (line: string) => void): RunState {
  const current = state.review!.limits;
  if (current.concurrency === limits.concurrency && current.runBudgetUsd === limits.runBudgetUsd) return state;
  log(`run ${state.id}: limits in force: concurrency ${String(limits.concurrency)}, ${limits.runBudgetUsd === null ? 'no run budget' : `run budget ${limits.runBudgetUsd.toFixed(2)} USD`}`);
  return append(checkpoint, state, [{ kind: 'limits.changed', version: 1, payload: limits }]);
}

/**
 * Every worker still running on the ledger died with the engine that
 * launched it, or was orphaned by a hard kill: record each lost (TD5).
 * A lost fixer's work is recorded with its loss, from its snapshots and
 * the files it left (R20 of the fix pass), after the claims its round's
 * directory holds that the ledger does not, when the directory is still
 * there (R3 of commit series integrity); one worker per append so each is
 * read against the tree the one before it left.
 */
function recordLostWorkers(checkpoint: Checkpoint, state: RunState, context: Pick<RevisionContext, 'worktree' | 'match' | 'claims'>, log: (line: string) => void): RunState {
  const reason = 'the engine exited while the worker ran';
  for (const worker of Object.values(state.workers).filter((candidate) => candidate.status === 'running')) {
    const unit = parseUnitLabel(worker.launch.label);
    log(`worker ${worker.launch.label ?? worker.launch.workerId}: lost with the previous engine`);
    const lost: NewEvent = { kind: 'worker.lost', version: 5, payload: { workerId: worker.launch.workerId, phase: unit?.phase ?? null, key: unit?.key ?? null, reason } };
    const edits = unit !== null && isEditingPhase(unit.phase) ? attemptRevisionEvents({ ...context, state, evidence: checkpoint.evidence }, unit.phase, unit.key, worker.launch.workerId, reason) : { claims: [], revisions: [] };
    for (const line of edits.claims.flatMap(claimLines)) log(line);
    if (edits.revisions.length > 0) log(`worker ${worker.launch.label ?? worker.launch.workerId}: its edits recorded in ${String(edits.revisions.length)} revision${edits.revisions.length === 1 ? '' : 's'}`);
    state = append(checkpoint, state, [...edits.claims, lost, ...edits.revisions]);
  }
  return state;
}

/** A phase left running or blocked by a previous engine is re-entered at the next attempt, which checks the worktree again and clears a blocker; its line says how far the run has come, as a started phase's does. */
function reenterPhase(checkpoint: Checkpoint, state: RunState, adapter: Pick<RuntimeAdapter, 'summarizeUsage' | 'capabilities'>, log: (line: string) => void): RunState {
  const review = state.review!;
  const phase = currentPhase(review);
  if (phase === null) return state;
  const attempt = review.phases[phase].attempt + 1;
  log(`phase ${phase}: re-entered (attempt ${String(attempt)})${review.blocker === null ? '' : `, clearing the ${review.blocker.code} blocker`}; ${progressWords(state, adapter, Date.now())}`);
  return append(checkpoint, state, [{ kind: 'phase.started', version: 5, payload: { phase, attempt } }]);
}
