/**
 * The controller (R1, R5, R6, R7 of the read-only review; TD1, TD5, TD6;
 * R1, R6, R7, R9 of the fix pass; R1, R6, R7 of the repository survey;
 * R1 to R3 of the Codex sandbox): find or create the run, take its lock,
 * record the workers a previous engine lost, then loop over fold, plan,
 * execute and append until the report is written or the run blocks. It
 * launches workers with the runtime options the run pinned, plans the
 * checks when the survey completes, runs them one at a time, and records
 * every edit as a revision of the tree. Every fact the planner needs is an
 * event, or this invocation's check flags, so a resumed run continues
 * from the last step the ledger holds.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import type { Blocker, CheckRan, ClaimsLost, DecisionsRecorded, FilesClaimed, PlannedCheckV2, ReviewConfiguration, ReviewLimits, ScopeRequest, SurveyRecorded, TreeRevised } from '../checkpoint/events.ts';
import { claimsOfRound, revisionMessageOf, roundOf, settledClusters } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { conventionsKnown, lastSurvey, type SurveyState } from '../checkpoint/survey-state.ts';
import { assembleRoles, type AssembledRole } from '../roles/assemble.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { PreflightError } from '../runtime/errors.ts';
import { ioDirectoryName, runWorker, type WorkerReceipt } from '../runtime/launcher.ts';
import { preflight, type PreflightOptions } from '../runtime/preflight.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import type { PinnedRuntimeOptions } from '../runtime/runtimes.ts';
import { checkpointScratchKey, defaultScratchRoot } from '../runtime/scratch.ts';
import { captureScope } from '../scope/capture.ts';
import { objectFormat } from '../scope/git.ts';
import { hintChecks, isSettled, noCheckFlags, readRootManifests, unsettledKinds, type CheckFlags } from './checks/discover.ts';
import { caseInsensitiveFileSystem, claimsDirectoryFor, ClaimsDirectoryLostError, prepareClaims, readClaims, type Held } from './claims.ts';
import { runCheck } from './checks/run.ts';
import { gitContent } from './content.ts';
import { existingUserRulesFiles, reviewerAuthorship } from './conventions.ts';
import { drifted, expectedTreeOf, findDrift, phaseCheck, worktreeChecked, type DriftFound } from './drift.ts';
import { isFile, sameDirectory } from '../paths.ts';
import { ReviewRefusedError } from './errors.ts';
import { attemptRevisionEvents, checkRevision, type RevisionContext } from './fix-events.ts';
import { parseUnitLabel } from './labels.ts';
import { acquireRunLock, acquireStartLock, releaseOnExit, type ReleaseLock } from './lock.ts';
import { patchSeries } from './patch.ts';
import { contributionOf, invocationFor, type ClaimsContext, type PhaseContext } from './phases.ts';
import { editorsUnderUnelevatedSandbox, pinnedWindowsSandbox, readPolicy, refuseInvocationFlags, resolvePolicy, rolesDigest, type PolicyFlags } from './policy.ts';
import { scopeBlock, surveyScopeBlock, type PresurveyRulesFile, type ScopeConventions } from './prompts.ts';
import { renderReport } from './report.ts';
import { prepareSnapshots, snapshotsDirectoryName } from './snapshot.ts';
import { budgetSpendOf, statisticsOf } from './spend.ts';
import { currentPhase, reviewStatus } from './state.ts';
import { nextStep, truncated, type DueCheck, type Live, type Unit } from './steps.ts';
import { surveyFailure, type SurveyInputs } from './survey.ts';
import { claimPathPlaceholder, snapshotIndexPlaceholder } from './tasks.ts';
import { blockerActions, checkKinds, decisionCounts, decisionCountWords, isEditingPhase, maxRecordedTextLength, pinnedRuntimeAction, unitName, type CheckKind, type CheckPhase, type Phase } from './vocabulary.ts';

/**
 * The scope a command asks for. It is resolved only when the run it acts
 * on has none captured (a new run, or one whose capture failed), and a run
 * that has one keeps it, so the request is not even checked against a tree
 * that may have moved on.
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
   * that resolves it, called only for such a run. A configured run
   * preflights and launches the executable it pinned, so the command's is
   * then neither resolved nor refused: a run started with `--executable`
   * resumes without it, even where the runtime's name finds a shim on PATH.
   */
  readonly executable: string | (() => string);
  /** The arguments a run not yet configured pins before every worker's own; a configured run keeps its pinned ones. */
  readonly executableArgs?: readonly string[];
  readonly rolesRoot: string;
  readonly flags: PolicyFlags;
  /** The scope of a new run, or of an active one that has none yet; a run that captured one keeps it. */
  readonly scope: ScopeSource;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  /** The home directory the reviewer's own rules files are looked for under; the user's by default. */
  readonly home?: string;
  /** Progress, one line at a time; stderr by default. */
  readonly log?: (line: string) => void;
  readonly preflightOptions?: PreflightOptions;
  /**
   * The fix pass a run not yet configured pins (R1 of the fix pass): null
   * or absent for the read-only review, else the `--check` and
   * `--no-check` flags that settle their kinds over the survey (R5 of the
   * repository survey). Whether a run fixes is pinned at configuration;
   * the flags apply to every invocation until the checks are planned, and
   * are named as ignored after.
   */
  readonly fix?: CheckFlags | null;
  /**
   * The script a fixer's snapshot command runs with `node`: the engine's
   * own entry, the bundle or `src/cli.ts`. `process.argv[1]` by default,
   * which is that entry when the engine runs as the command.
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

/** The active runs a review may resume: those without a report. */
export function resumableRuns(checkpoint: Checkpoint): RunState[] {
  return checkpoint.listRuns().filter(isResumable);
}

/** The one run to resume, or null when there is none; two are refused, naming them. */
export function findActiveRun(checkpoint: Checkpoint): RunState | null {
  const runs = resumableRuns(checkpoint);
  if (runs.length > 1) {
    throw new ReviewRefusedError(`${String(runs.length)} runs are active (${runs.map((run) => run.id).join(', ')}); abandon all but one with \`deep-review abandon --run <id> --reason <text>\``);
  }
  return runs[0] ?? null;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const usd = (value: number | null): string => (value === null ? '' : `, ${value.toFixed(2)} USD`);

/** A function that reads its value the first time it is called and returns that value after; a read that throws is tried again on the next call. */
function once<T>(read: () => T): () => T {
  // Boxed, so a value that is itself null or undefined is remembered too.
  let memo: { readonly value: T } | null = null;
  return (): T => (memo ??= { value: read() }).value;
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
    return files.map((file) => `phase fixes: claim lost: ${file.path} by ${unit} ${file.holder === null ? 'which no batch of the round has' : `to ${file.holder}`}`);
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

/** One planned check as the log names it: its command and who decided it, with the survey's source, or why it has none. */
const checkLine = (check: PlannedCheckV2): string => {
  const origin = check.origin === 'survey' ? `survey, ${check.source.basis} in ${check.source.path}` : check.origin;
  return check.command === null ? `not available (${origin}: ${check.reason})` : `${check.command} (${origin})`;
};

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
const driftList = (found: { readonly files: readonly { readonly path: string; readonly outcome: string }[]; readonly head: DriftFound['head'] }): string =>
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
 * commit series integrity): as the snapshot command is built, with the
 * unit's key, the round's claims directory and the path placeholder the
 * task asks the fixer to fill in, quoted so a path with a space stays one
 * argument.
 */
export function claimCommandFor(engineEntry: string, unit: string, into: string): string {
  return `node "${engineEntry}" claim --path "${claimPathPlaceholder}" --unit ${unit} --in "${into}"`;
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
  const opened = await openRun({ ...options, log, environment, platform, adapter, roles });
  let state = opened.state;
  const runId = state.id;
  const { release, scopeRequest, configure } = opened;
  const inFlight = new Map<string, InFlight>();
  const checkFlags = options.fix ?? noCheckFlags;
  const userFiles = once(() => existingUserRulesFiles(options.home));
  const hints = once(() => (state.review?.configuration.fix === true ? hintChecks(readRootManifests(options.worktree), unsettledKinds(checkFlags)) : []));
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
    flags: checkFlags,
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
  /** The claims directory of a fixes-phase unit's round, in this run's scratch. */
  const claimsDirectory = (key: string): string => claimsDirectoryFor(scratchBase, runId, roundOf(state.review!.fix!, key));
  /** The claims directories this engine prepared, whose absence is a loss. */
  const preparedClaims = new Set<string>();
  /** The claims directory this engine found removed while the fixes phase edited, which stops the phase (R12 of commit series integrity). */
  let claimsLost: string | null = null;
  const loseClaims = (directory: string): void => {
    if (claimsLost !== null) return;
    claimsLost = directory;
    log(`phase fixes: the claims directory ${directory} is gone; no more launches, the running units will be recorded as failed attempts`);
  };
  /** Whether a fixes-phase unit's claims directory is lost: found removed now, or before, by this engine. */
  const claimsGone = (key: string): boolean => {
    const directory = claimsDirectory(key);
    if (claimsLost === null && preparedClaims.has(directory) && !existsSync(directory)) loseClaims(directory);
    return claimsLost !== null;
  };
  const claims: ClaimsContext = {
    directoryOf: claimsDirectory,
    command: (key, directory) => claimCommandFor(engineEntry, key, directory),
    // A directory this engine has not prepared, as a resumed engine's before its first launch, has no claims to read; the next launch seeds it from the ledger (R3). One it prepared and finds gone is lost (R12).
    live: (key) => {
      const directory = claimsDirectory(key);
      try {
        if (existsSync(directory)) return { markers: readClaims(directory, caseInsensitive()), caseInsensitive: caseInsensitive() };
      } catch (error) {
        if (!(error instanceof ClaimsDirectoryLostError)) throw error;
      }
      if (preparedClaims.has(directory)) loseClaims(directory);
      return null;
    },
  };
  /** Prepare a fixes-phase unit's claims directory, or, when this engine prepared it before and it is gone, record the loss and say so. */
  const prepareOrLose = (key: string): boolean => {
    try {
      prepareClaimsFor(key);
      return true;
    } catch (error) {
      if (!(error instanceof ClaimsDirectoryLostError)) throw error;
      loseClaims(error.directory);
      return false;
    }
  };
  /** What turning a worker's work into events reads, from the fold as it is now. */
  const revisionContext = (): RevisionContext => ({ state, worktree: options.worktree, evidence: checkpoint.evidence, match: content.match, claims });
  /**
   * Prepare the claims directory of a fixes-phase unit's round before its
   * launch (R2, R3 of commit series integrity): the round's clusters,
   * batches and settled clusters as the fold has them now, and every claim
   * of the round the ledger holds, seeded back where the directory lost it.
   */
  const prepareClaimsFor = (key: string): void => {
    const fix = state.review!.fix!;
    const round = roundOf(fix, key);
    const plan = round === 1 ? fix.plan : fix.secondRound;
    if (plan === null) throw new Error(`Run ${runId} launches ${key} before its round is planned`);
    const held: Held = {
      worktree: options.worktree,
      clusters: Object.fromEntries(plan.clusters.map((cluster) => [cluster.id, [...cluster.files]])),
      units: Object.fromEntries(plan.batches.map((batch) => [batch.key, batch.cluster])),
      settled: [...settledClusters(fix, round)].sort(),
      caseInsensitive: caseInsensitive(),
    };
    const directory = claimsDirectory(key);
    prepareClaims(directory, held, claimsOfRound(fix, round).map((claim) => ({ path: claim.path, cluster: claim.cluster, unit: claim.key, claimedAt: claim.claimedAt })), preparedClaims.has(directory));
    preparedClaims.add(directory);
  };
  /** Log a settled worker and append what it contributes; a launcher error is thrown, since nothing was recorded for its unit. */
  const record = (settled: Settled, startedAt: number): void => {
    const name = unitName(settled.unit.phase, settled.unit.key);
    // The launcher threw instead of returning a receipt (a run abandoned meanwhile, an invocation it refused, a runtime that no longer qualifies): the review cannot go on.
    if ('error' in settled) throw settled.error;
    const summary = adapter.summarizeUsage(settled.receipt.runtime.usage);
    log(`worker ${settled.unit.role} ${name}: ${settled.receipt.outcome} in ${seconds(Date.now() - startedAt)}${usd(summary.costUsd)}${settled.receipt.error === null ? '' : `: ${settled.receipt.error}`}`);
    state = checkpoint.fold(runId);
    const { phase } = settled.unit;
    // An answer of a reading phase is recorded only while the tree is the one the run expects (PD10): once it drifted in this attempt, every answer settling is set aside, neither recorded nor counted as a failure, and the attempt blocks when the workers in flight have settled. An editing phase's tree changes by design, and its end check judges it instead (TD2 of the fix pass).
    if (settled.receipt.outcome === 'completed' && !isEditingPhase(phase)) {
      const attempt = state.review!.phases[phase].attempt;
      const recorded = state.review!.checks.find((check) => check.phase === phase && check.attempt === attempt && check.drifted);
      if (recorded !== undefined) {
        log(`worker ${settled.unit.role} ${name}: answer set aside: the worktree drifted from what the run expects: ${driftList(recorded)}`);
        return;
      }
      const found = findDrift(state, options.worktree, content.match);
      if (drifted(found)) {
        log(`worker ${settled.unit.role} ${name}: answer set aside: the worktree drifted from what the run expects: ${driftList(found)}`);
        state = append(checkpoint, state, [{ kind: 'worktree.checked', version: 4, payload: worktreeChecked(state, options.worktree, phase, attempt, 'answer', found) }]);
        return;
      }
    }
    const events = contributionOf(settled.unit, settled.receipt, { ...revisionContext(), survey: surveyInputs, claimsLost: phase === 'fixes' && claimsGone(settled.unit.key) });
    for (const event of events) {
      for (const line of claimLines(event)) log(line);
      if (event.kind === 'attempt.failed') log(`worker ${settled.unit.role} ${name}: attempt failed: ${(event.payload as { reason: string }).reason}`);
      if (event.kind === 'tree.revised') log(`worker ${settled.unit.role} ${name}: ${revisionSummary(event.payload as TreeRevised)}`);
      if (event.kind === 'survey.recorded') for (const line of surveyLines(runId, event.payload as SurveyRecorded)) log(line);
      if (event.kind === 'decisions.recorded') log(`worker ${settled.unit.role} ${name}: decided ${decisionCountWords(decisionCounts((event.payload as DecisionsRecorded).decisions))}`);
    }
    state = append(checkpoint, state, events);
  };
  try {
    if (scopeRequest !== null) {
      state = captureScope(checkpoint, runId, scopeRequest);
      log(`run ${runId}: scope captured, ${String(state.scope!.files.length)} files`);
    }
    if (configure !== null) {
      // The checks are planned when the survey completes, not here (R6 of the repository survey).
      state = append(checkpoint, state, [{ kind: 'review.configured', version: 5, payload: configure }]);
      log(`run ${runId}: configured for ${configure.runtime} ${configure.version}, models ${configure.models.strong} and ${configure.models.fast}${configure.fix ? ', with the fix pass' : ''}${configure.codex === null ? '' : `, Codex Windows sandbox ${configure.codex.windowsSandbox}`}; the reviewer's own rules: ${configure.survey.userRules}`);
    }
    const configuration = state.review!.configuration;
    // What every worker launches with, from what the run pinned, however long ago it was configured.
    const pinned = pinnedRuntimeOptionsOf(configuration);
    // Said before the first worker of every invocation, so the operator knows before paying for a fix run whose editors cannot run the build (R5 of the Codex sandbox).
    const unelevatedEditors = editorsUnderUnelevatedSandbox(configuration, platform);
    if (unelevatedEditors) log(unelevatedEditorsWarning(runId));
    state = recordLimits(checkpoint, state, limitsInForce(configuration, options.flags, adapter), log);
    state = recordLostWorkers(checkpoint, state, { worktree: options.worktree, match: content.match, claims }, log);
    state = reenterPhase(checkpoint, state, log);

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
     * Run one due check, or record it skipped, as the events to append: its
     * `check.ran`, and a revision when it wrote to files the run expects
     * (R9, TD6 of the fix pass). The engine runs at most one check, and no
     * worker, at a time, so it awaits the check here.
     */
    const runDueCheck = async (phase: CheckPhase, attempt: number, due: DueCheck): Promise<NewEvent[]> => {
      if (due.skip !== null) {
        log(`check ${due.kind} (${phase}): skipped, ${due.skip}`);
        const now = new Date().toISOString();
        const skipped: CheckRan = { phase, attempt, kind: due.kind, command: due.command, outcome: 'skipped', exitCode: null, signal: null, termination: null, startedAt: now, endedAt: now, stdout: null, stderr: null, error: due.skip };
        return [{ kind: 'check.ran', version: 1, payload: skipped }];
      }
      log(`check ${due.kind} (${phase}): ${due.command}`);
      const timeoutMs = configuration.checks?.timeoutMs;
      if (timeoutMs === undefined) throw new Error(`Run ${runId} runs a check without the checks it pinned`);
      const result = await runCheck(checkpoint.evidence, { command: due.command, worktree: options.worktree, environment, timeoutMs, ioDirectory: join(checkpoint.root, ioDirectoryName, `check-${randomUUID()}`) });
      log(`check ${due.kind} (${phase}): ${result.outcome} in ${seconds(Date.parse(result.endedAt) - Date.parse(result.startedAt))}${result.error === null ? '' : `: ${result.error}`}`);
      const ran: CheckRan = { phase, attempt, kind: due.kind, command: due.command, outcome: result.outcome, exitCode: result.exitCode, signal: result.signal, termination: result.termination, startedAt: result.startedAt, endedAt: result.endedAt, stdout: result.stdout, stderr: result.stderr, error: result.error === null ? null : truncated(result.error, maxRecordedTextLength) };
      const revision = checkRevision(revisionContext(), phase, due.kind, due.command);
      if (revision !== null) log(`check ${due.kind} (${phase}): rewrote ${fileCount((revision.payload as TreeRevised).files.length)} the run expects; recorded as its revision`);
      return [{ kind: 'check.ran', version: 1, payload: ran }, ...(revision === null ? [] : [revision])];
    };

    for (;;) {
      const review = state.review!;
      const live: Live = { running: new Set(inFlight.keys()), spend: budgetSpendOf(state, adapter), evidencePath: (reference) => checkpoint.evidence.pathOf(reference), checkFlags, claimsLost };
      const step = nextStep(review, live);
      switch (step.kind) {
        case 'blocked':
          log(`run ${runId}: blocked in ${step.blocker.phase} (${step.blocker.code}): ${step.blocker.detail}`);
          return { kind: 'blocked', runId, blocker: step.blocker };
        case 'complete':
          return { kind: 'report', runId, reportPath: checkpoint.evidence.pathOf(review.report!.report) };
        case 'start-phase':
          log(`phase ${step.phase}: started (attempt ${String(step.attempt)})`);
          state = append(checkpoint, state, [{ kind: 'phase.started', version: 4, payload: { phase: step.phase, attempt: step.attempt } }]);
          break;
        case 'check-worktree': {
          // A drifted check blocks the attempt at the next step, through the planner's one drift rule.
          const check = phaseCheck(state, options.worktree, step.phase, step.attempt, step.moment, content.match);
          if (check.drifted) log(`phase ${step.phase}: the worktree drifted from what the run expects: ${driftList(check)}`);
          if (check.strays.length > 0) log(`phase ${step.phase}: files no worker accounts for: ${check.strays.join(', ')}`);
          state = append(checkpoint, state, [{ kind: 'worktree.checked', version: 4, payload: check }]);
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
          state = append(checkpoint, state, [...failed, { kind: 'checks.planned', version: 2, payload: { checks: [...step.checks] } }]);
          break;
        }
        case 'run-check':
          state = append(checkpoint, state, await runDueCheck(step.phase, step.attempt, step.check));
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
            if (unit.phase === 'fixes' && !prepareOrLose(unit.key)) break;
            const invocation = invocationFor(unit, context);
            // An editing worker's snapshots compare with the tree as it is now, from a manifest taken here, outside its sandbox (R23, TD20).
            if (invocation.scratch !== undefined) prepareSnapshots(join(invocation.scratch, snapshotsDirectoryName), options.worktree, expectedTreeOf(state).keys());
            log(`worker ${unit.role} ${unit.phase}:${unit.key}: started`);
            const startedAt = Date.now();
            const promise: Promise<Settled> = runWorker(checkpoint, runId, invocation, { runtimes: options.runtimes, pinned, environment, platform, ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }) })
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
          state = append(checkpoint, state, [{ kind: 'phase.finished', version: 5, payload: { phase: step.phase, attempt: step.attempt, outcome: step.outcome, blocker: step.blocker } }]);
          break;
        case 'write-report': {
          // One patch per revision, rendered from the frozen bytes in ledger order, each with the message its commit would carry (R13, R20, TD12 of the fix pass).
          const fixState = state.review!.fix;
          const revisions = fixState === null ? [] : fixState.revisions.map((revision) => ({ ...revision, change: { ...revision.change, message: revisionMessageOf(fixState, revision) } }));
          const patches = revisions.length === 0 ? [] : patchSeries(revisions, (reference) => checkpoint.evidence.read(reference), objectFormat(options.worktree), content.stored).map((patch) => checkpoint.evidence.put(patch));
          const statistics = statisticsOf(state, adapter);
          const fix = state.review!.fix === null ? {} : { fix: { evidencePath: (reference: { sha256: string; bytes: number }) => checkpoint.evidence.pathOf(reference), patches: patches.map((patch) => checkpoint.evidence.pathOf(patch)) } };
          const report = checkpoint.evidence.put(renderReport(state, { engine: checkpoint.engine, statistics, ...fix }));
          state = append(checkpoint, state, [
            { kind: 'report.written', version: 4, payload: { report, statistics, patches } },
            { kind: 'phase.finished', version: 5, payload: { phase: 'report', attempt: state.review!.phases.report.attempt, outcome: 'completed', blocker: null } },
          ]);
          log(`run ${runId}: report written to ${checkpoint.evidence.pathOf(report)}${patches.length === 0 ? '' : `, with ${String(patches.length)} patch${patches.length === 1 ? '' : 'es'}`}`);
          break;
        }
      }
    }
  } catch (error) {
    // A worker's own preflight failed: the runtime stopped qualifying mid-run (an update, a removed binary), which is refused as at startup, with the action for the executable the run pinned.
    const configuration = state.review?.configuration ?? null;
    throw refusalOf(error, configuration === null ? null : { runId, executable: configuration.executable });
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
 * whether the executable was pinned: `pinned` names the configured run and
 * its executable, or is null for a run not yet configured, whose
 * `--executable` still applies.
 */
function refusalOf(error: unknown, pinned: { readonly runId: string; readonly executable: string } | null): unknown {
  if (!(error instanceof PreflightError)) return error;
  const action = pinned === null ? blockerActions['runtime-unqualified'] : pinnedRuntimeAction(pinned.runId, pinned.executable);
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
}

/** An open run: its state, the release of its lock, and what it still needs before its first step. */
interface OpenedRun {
  readonly state: RunState;
  readonly release: ReleaseLock;
  /** The scope to capture, for a run that has none yet; null for one that captured it. */
  readonly scopeRequest: ScopeRequest | null;
  /** The configuration to pin, for a run not yet configured; null for one whose configuration is pinned. */
  readonly configure: ReviewConfiguration | null;
}

/**
 * Find the active run or create one, and take its run lock, all under the
 * checkpoint's start lock: two engines started together would otherwise
 * both find no run and create one each. A found run is read again once its
 * lock is held, since the engine that held the lock until a moment ago may
 * have appended after the find (a late worker finish, its report); one no
 * longer resumable is let go, and a run is created as if none had been
 * found. Everything that depends on the run is decided from that one read:
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
 */
async function openRun(context: OpenContext): Promise<OpenedRun> {
  const { checkpoint, log } = context;
  const releaseStart = releaseOnExit(acquireStartLock(checkpoint.root));
  let release: ReleaseLock | null = null;
  try {
    let found = findActiveRun(checkpoint);
    // The checkpoint is shared by every worktree of the repository, while a run's scope, worktree checks and workers belong to the worktree it was created in.
    if (found !== null && !sameDirectory(found.worktree, context.worktree)) {
      throw new ReviewRefusedError(`run ${found.id} is active in worktree ${found.worktree}, not ${context.worktree}; run the command there, or abandon the run with \`deep-review abandon --run ${found.id} --reason <text>\``);
    }
    if (found !== null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, found.id));
      // Read again under the lock: what the find returned may predate the last appends of the engine that held it.
      found = checkpoint.fold(found.id);
      if (!isResumable(found)) {
        log(`run ${found.id}: ${reviewStatus(found)} before its lock was taken; a new run is created`);
        release();
        release = null;
        found = null;
      }
    }
    const pinned = found?.review?.configuration ?? null;
    if (found !== null && pinned !== null && pinned.runtime !== context.runtime) {
      throw new ReviewRefusedError(`run ${found.id} is pinned to runtime ${pinned.runtime}, not ${context.runtime}; run it with --runtime ${pinned.runtime}, or abandon it`);
    }
    if (found !== null) {
      log(`run ${found.id}: resuming${found.scope === null ? '; it has no scope yet and captures the one this command names' : ''}`);
      if (found.scope !== null && context.scope.named) log(`run ${found.id} is active; its scope flags are ignored and the run continues`);
    }
    const scopeRequest = found === null || found.scope === null ? context.scope.request() : null;
    let configure: OpenedRun['configure'] = null;
    if (found !== null && pinned !== null) {
      await resumePinned(found, pinned, context);
    } else {
      const resolved = resolvePolicy(readPolicy(context.rolesRoot), context.roles, context.adapter, context.flags, context.platform);
      if (context.flags.codexWindowsSandbox !== undefined && resolved.codex === null) log(`--codex-windows-sandbox applies on Windows only; it is ignored on ${context.platform}, where every Codex worker runs as without it`);
      const fix = context.fix ?? null;
      const executable = typeof context.executable === 'function' ? context.executable() : context.executable;
      const executableArgs = [...(context.executableArgs ?? [])];
      const version = await qualify(context.adapter, executable, executableArgs, context, null);
      const { checks, fixes, survey, ...rest } = resolved;
      configure = { ...rest, roles: [...resolved.roles], executable, executableArgs, version, fix: fix !== null, checks: fix === null ? null : checks, fixes: fix === null ? null : fixes, survey };
    }
    const state = found ?? checkpoint.createRun({ worktree: context.worktree });
    if (found === null) {
      release = releaseOnExit(acquireRunLock(checkpoint.root, state.id));
      log(`run ${state.id}: created`);
    }
    return { state, release: release!, scopeRequest, configure };
  } catch (error) {
    release?.();
    throw error;
  } finally {
    releaseStart();
  }
}

/**
 * Hold a configured run to what it pinned before it resumes: a fix run
 * configured before the decision step that has not planned its fixes is
 * refused first, since it has no decision to route them by and no roles
 * make it one (R6 of the decision step); the role
 * prompts it ran must still digest as pinned, so the report's digest says
 * which prompts every worker got; the flags that apply per invocation are
 * checked as a new run's are, and the model flags, which do not apply,
 * are named as ignored, as are the check flags once the checks are
 * planned; before then, a fix run is told the check flags must be given
 * again, and the kinds it can tell an earlier invocation's flags settled
 * and this one's do not are named; a `--codex-windows-sandbox` is named
 * as ignored when the run resumes off Windows, whatever it pinned, or
 * pinned none because it was configured off Windows, and is refused when
 * it names another value than the pinned one; the pinned executable, not
 * the command's, must still qualify.
 */
async function resumePinned(run: RunState, pinned: ReviewConfiguration, context: OpenContext): Promise<void> {
  const runId = run.id;
  // A fix run routes its findings by their decisions (R6 of the decision step); one configured before the decision step has none to route by, so it cannot go on to plan its fixes, whatever roles it is given.
  if (pinned.fix && run.review?.phases.decision.status === 'skipped' && (run.review.fix?.plan ?? null) === null) {
    throw new ReviewRefusedError(`run ${runId} was configured before the decision step, which a fix run now routes its findings by, and has not planned its fixes; abandon it with \`deep-review abandon --run ${runId} --reason <text>\` and start a new run`);
  }
  const digest = rolesDigest(context.roles);
  if (digest !== pinned.rolesDigest) {
    throw new ReviewRefusedError(`run ${runId} was configured with roles digest ${pinned.rolesDigest}, and the roles at ${context.rolesRoot} now digest ${digest}; run it with the roles it started with (--roles <dir>), or abandon it with \`deep-review abandon --run ${runId} --reason <text>\``);
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
      throw new ReviewRefusedError(`run ${runId} is pinned to the Codex Windows sandbox ${applied}, not ${sandbox}; run it with --codex-windows-sandbox ${applied} or without the flag, or abandon it with \`deep-review abandon --run ${runId} --reason <text>\``);
    }
  }
  if (context.flags.strongModel !== undefined || context.flags.fastModel !== undefined) {
    context.log(`run ${runId} is pinned to models ${pinned.models.strong} and ${pinned.models.fast}; --strong-model and --fast-model are ignored`);
  }
  // Whether the run fixes is pinned at configuration (R1 of the fix pass); the check flags settle their kinds until the checks are planned (TD6 of the repository survey), and are named and ignored after.
  const fix = context.fix ?? null;
  const checkFlags = fix !== null && checkKinds.some((kind) => isSettled(fix, kind));
  if (!pinned.fix && fix !== null) context.log(`run ${runId} is pinned without the fix pass; --fix${checkFlags ? ', --check and --no-check are' : ' is'} ignored`);
  if (pinned.fix && fix === null) context.log(`run ${runId} is pinned to the fix pass and continues it; the absence of --fix is ignored`);
  const planned = (run.review?.fix?.checks.planned ?? null) !== null;
  if (pinned.fix && checkFlags && planned) context.log(`run ${runId} keeps the checks it pinned; --check and --no-check are ignored`);
  if (pinned.fix && !planned) {
    // The flags are not on the ledger until the plan records them, so an invocation that omits one an earlier invocation gave drops it.
    context.log(`run ${runId} has not planned its checks yet; --check and --no-check apply to each invocation until it does, so give again every one an earlier invocation gave`);
    const unsettled = droppedSinceSurvey(run.review?.survey ?? null, fix);
    if (unsettled.length > 0) {
      context.log(`run ${runId}: its survey was asked with --check or --no-check settling ${unsettled.join(', ')}, which this invocation leaves unsettled, so the survey is asked again for ${unsettled.length === 1 ? 'it' : 'them'}; give those flags again to keep them`);
    }
  }
  await qualify(context.adapter, pinned.executable, pinned.executableArgs, context, runId);
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
function droppedSinceSurvey(survey: SurveyState | null, flags: CheckFlags | null): CheckKind[] {
  const checks = survey === null ? null : (lastSurvey(survey)?.checks ?? null);
  if (checks === null) return [];
  return checkKinds.filter((kind) => !checks.some((check) => check.kind === kind) && (flags === null || !isSettled(flags, kind)));
}

/** Preflight the executable and return its version, or refuse with `runtime-unqualified`; `runId` names the configured run that pinned it, or is null for a new run. */
async function qualify(adapter: RuntimeAdapter, executable: string, executableArgs: readonly string[], context: OpenContext, runId: string | null): Promise<string> {
  try {
    return await preflight(adapter, executable, [...executableArgs], context.environment, context.preflightOptions ?? {});
  } catch (error) {
    throw refusalOf(error, runId === null ? null : { runId, executable });
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
function limitsInForce(configuration: ReviewConfiguration, flags: PolicyFlags, adapter: RuntimeAdapter): ReviewLimits {
  return {
    concurrency: flags.concurrency ?? configuration.concurrency,
    runBudgetUsd: adapter.capabilities.costInUsd ? (flags.budgetUsd ?? configuration.runBudgetUsd) : null,
  };
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
    const lost: NewEvent = { kind: 'worker.lost', version: 4, payload: { workerId: worker.launch.workerId, phase: unit?.phase ?? null, key: unit?.key ?? null, reason } };
    const edits = unit !== null && isEditingPhase(unit.phase) ? attemptRevisionEvents({ ...context, state, evidence: checkpoint.evidence }, unit.phase, unit.key, worker.launch.workerId, reason) : { claims: [], revisions: [] };
    for (const line of edits.claims.flatMap(claimLines)) log(line);
    if (edits.revisions.length > 0) log(`worker ${worker.launch.label ?? worker.launch.workerId}: its edits recorded in ${String(edits.revisions.length)} revision${edits.revisions.length === 1 ? '' : 's'}`);
    state = append(checkpoint, state, [...edits.claims, lost, ...edits.revisions]);
  }
  return state;
}

/** A phase left running or blocked by a previous engine is re-entered at the next attempt, which checks the worktree again and clears a blocker. */
function reenterPhase(checkpoint: Checkpoint, state: RunState, log: (line: string) => void): RunState {
  const review = state.review!;
  const phase = currentPhase(review);
  if (phase === null) return state;
  const attempt = review.phases[phase].attempt + 1;
  log(`phase ${phase}: re-entered (attempt ${String(attempt)})${review.blocker === null ? '' : `, clearing the ${review.blocker.code} blocker`}`);
  return append(checkpoint, state, [{ kind: 'phase.started', version: 4, payload: { phase, attempt } }]);
}
