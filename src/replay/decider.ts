/**
 * Replaying a recorded run's decider, for the second gate of the settled
 * choice (R8): the run's ledger is read up to the decision, the decider's
 * task is built again by this engine with the current roles, one decider
 * is launched on the runtime named, and its answer is checked as the
 * decision phase checks it. A refused answer gets one more decider whose
 * task names what the refusal said (R9). From the accepted decisions the
 * replay renders the review as `publish --dry-run` prints it, with no
 * writer, and writes the facts the gate's metrics read (M1 to M3).
 *
 * A measurement tool, not part of a review: it reads a copy of the
 * recorded ledger and never writes to the recorded checkpoint, records its
 * own workers in a checkpoint of its own under the output directory, and
 * calls real models when given a real runtime.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Checkpoint, evidenceDirectoryName } from '../checkpoint/checkpoint.ts';
import type { RecordedDecision, ScopeFile, ScopeState, WorkerLaunch } from '../checkpoint/events.ts';
import { applyEvent, firstUnknownEvent, foldRun, type DecodedEvent, type RunState } from '../checkpoint/fold.ts';
import { busyTimeoutMs, Ledger, ledgerFileName } from '../checkpoint/ledger.ts';
import { locateCheckpoint } from '../checkpoint/locate.ts';
import { changeReadingOf } from '../checkpoint/review-fold.ts';
import { conventionsKnown } from '../checkpoint/survey-state.ts';
import { EvidenceStore } from '../evidence/store.ts';
import { ghTokenVariables } from '../github/gh.ts';
import type { PullRequestFile, PullRequestFileStatus } from '../github/pull-request.ts';
import { briefOf } from '../review/brief.ts';
import { StructuralCheckError, structuralCheckPrefix } from '../review/errors.ts';
import { parseUnitLabel, unitLabel } from '../review/labels.ts';
import { deciderFindings, recordedDecisions } from '../review/phases.ts';
import { pinnedRole, readPolicy, resolvePolicy, type ResolvedPolicy } from '../review/policy.ts';
import { composeWorkerPrompt, scopeBlock } from '../review/prompts.ts';
import { machineContextOf } from '../review/public-text.ts';
import { dryRunLines } from '../review/publish.ts';
import { formRefusalWords, placeFindings, pullRequestForm } from '../review/pull-request-form.ts';
import { checkDecisions, deciderOutputSchema, type DeciderOutput } from '../review/schemas.ts';
import { settledWorkers, spendOf } from '../review/spend.ts';
import { rankedFindings, type ReportFinding } from '../review/state.ts';
import { truncated } from '../review/steps.ts';
import { deciderTask } from '../review/tasks.ts';
import { maxRecordedTextLength, singleUnitKey } from '../review/vocabulary.ts';
import { assembleRoles } from '../roles/assemble.ts';
import { withoutVariables } from '../runtime/environment.ts';
import { runWorker, type WorkerReceipt } from '../runtime/launcher.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import type { WindowsSandbox } from '../runtime/codex.ts';
import type { RuntimeRegistry } from '../runtime/registry.ts';
import { defaultRuntimes } from '../runtime/runtimes.ts';
import { ReplayRefusedError } from './errors.ts';
import { canonicalPath, isWithin, replayCheckpointDirectoryName, treeDifferences, writeWhole } from './run.ts';

/** The deciders a replay launches at most, as the decision phase gives its unit: one and one more after a failure. */
export const deciderAttempts = 2;

/** The file of the output directory that holds what the gate's metrics read. */
export const factsFileName = 'facts.json';

/** The file of the output directory that holds the accepted decisions, as the fold holds them. */
export const decisionsFileName = 'decisions.json';

/** The file of the output directory that holds the review as `publish --dry-run` prints it. */
export const reviewFileName = 'review.md';

/** The file of the output directory that holds the prompt of an attempt, its task included. */
export const promptFileName = (attempt: number): string => `attempt-${String(attempt)}-prompt.md`;

/** The file of the output directory that holds the answer of an attempt as the decider gave it. */
export const answerFileName = (attempt: number): string => `attempt-${String(attempt)}-answer.json`;

/** The role and the unit the replayed decider runs as, those of the decision phase. */
const role = 'decider';
const unitKey = singleUnitKey('decision');

/** The events of one run of a ledger, read from a copy. */
export interface RecordedRun {
  readonly runId: string;
  readonly events: readonly DecodedEvent[];
}

/**
 * A copy of the ledger at `path` in the directory `copy`, taken by SQLite
 * as one snapshot (`VACUUM INTO`) through a read-only connection, so a run
 * still writing the ledger, or a checkpoint of its write-ahead log, can
 * neither tear the copy nor leave it without events the ledger already held.
 */
function snapshotLedger(path: string, copy: string): void {
  const source = new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
  try {
    source.prepare('VACUUM INTO ?').run(join(copy, ledgerFileName));
  } finally {
    source.close();
  }
}

/**
 * The events of the run of `root` whose id is or starts with `run`, read
 * from a snapshot of the ledger in a temporary directory, which is removed
 * after: opening a ledger sets its journal mode, which writes. The runs are
 * listed by id with no fold, since a run of the first gate holds a
 * `decisions.recorded@2` of a shape this engine refuses.
 */
export function readRecordedRun(root: string, run: string): RecordedRun {
  const ledger = join(root, ledgerFileName);
  // Opening a ledger creates one where none is, so a mistyped path would read as a checkpoint with no run.
  if (!existsSync(ledger)) throw new ReplayRefusedError(`${root} holds no ${ledgerFileName}; --checkpoint names a deep-review-checkpoint directory`);
  const copy = mkdtempSync(join(tmpdir(), 'deep-review-replay-decider-'));
  try {
    snapshotLedger(ledger, copy);
    const copied = Ledger.open(copy);
    try {
      const ids = copied.listRuns().map((listed) => listed.id);
      const matching = ids.filter((id) => id.startsWith(run));
      if (matching.length !== 1) throw new ReplayRefusedError(`--run ${run} names ${matching.length === 0 ? 'no run' : `${String(matching.length)} runs`} of ${root}; it holds ${ids.join(', ')}`);
      const runId = matching[0]!;
      return { runId, events: copied.events(runId).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown })) };
    } finally {
      copied.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * The events of a run before its decision phase records anything: every
 * event before its first `decisions.recorded`, or before the first finish
 * of its decision phase when that comes first, as for a phase blocked
 * before any answer passed. The decider's own launches before the cut are
 * kept, and fold as workers of the run; their answers are not read.
 */
export function beforeDecisions(events: readonly DecodedEvent[]): DecodedEvent[] {
  const end = events.findIndex((event) => event.kind === 'decisions.recorded' || (event.kind === 'phase.finished' && (event.payload as { readonly phase?: unknown }).phase === 'decision'));
  return end === -1 ? [...events] : events.slice(0, end);
}

/** The run folded up to its decision, refused when it holds an event this engine cannot read there, or when its decision phase is not running at the cut, as for a run that never reached it. */
export function foldBeforeDecisions(run: RecordedRun): RunState {
  const prefix = beforeDecisions(run.events);
  const unknown = firstUnknownEvent(prefix);
  if (unknown !== null) throw new ReplayRefusedError(`Run ${run.runId} holds ${unknown.kind}@${String(unknown.version)} at sequence ${String(unknown.sequence)}, written by engine ${unknown.engine}, before its decisions, which this engine cannot read`);
  const state = foldRun(prefix);
  const decision = state.review?.phases.decision.status ?? null;
  if (decision !== 'running') throw new ReplayRefusedError(`Run ${run.runId} never reached the decision phase${decision === null ? ', since it is no review' : `: the phase is ${decision}`}, so it has no decider to replay`);
  return state;
}

/** The scope block the decision phase's worker receives (`scopeBlockFor` of the controller): the conventions the survey recorded, the triage's account of the change, and the patch. */
function scopeBlockOf(state: RunState, scope: ScopeState, tree: string, evidence: EvidenceStore): string {
  const review = state.review!;
  const conventions = conventionsKnown(review.survey);
  // A run with the decision step is surveyed, so its conventions never predate the survey.
  if (conventions.status === 'predates-survey') throw new Error(`Run ${state.id} has a decision phase and predates the survey`);
  return scopeBlock({ worktree: tree, scope, evidence, conventions, change: changeReadingOf(review.change) });
}

/** What became of an attempt's answer: accepted with its decisions, refused by the check with what it said, or failed with no answer to check. */
type Checked =
  | { readonly kind: 'accepted'; readonly decisions: readonly RecordedDecision[] }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * An attempt's answer checked as the decision phase checks it
 * (`contributionEvent`). A refusal is the text the phase records for it,
 * cut to the length the ledger keeps, without the prefix that marks a
 * structural check, which is what `refusedDecisions` names to the next
 * attempt (R9 of the settled choice).
 */
function checkedAnswer(receipt: WorkerReceipt, findings: readonly ReportFinding[]): Checked {
  if (receipt.outcome !== 'completed') return { kind: 'failed', reason: `${receipt.outcome}: ${receipt.error ?? 'no reason recorded'}` };
  const output = receipt.output as DeciderOutput;
  try {
    checkDecisions(output, findings.map((entry) => entry.choices));
  } catch (error) {
    if (error instanceof StructuralCheckError) return { kind: 'refused', reason: truncated(`${structuralCheckPrefix}${error.message}`, maxRecordedTextLength).slice(structuralCheckPrefix.length) };
    throw error;
  }
  return { kind: 'accepted', decisions: recordedDecisions(output, findings) };
}

/** The run with the decisions recorded after its prefix, through the fold's own rules, as the decision phase would record them for the worker that gave them. */
export function withDecisions(state: RunState, workerId: string, decisions: readonly RecordedDecision[], engine: string): RunState {
  const event: DecodedEvent = { sequence: state.lastSequence + 1, runId: state.id, kind: 'decisions.recorded', version: 2, payload: { workerId, decisions }, recordedAt: new Date().toISOString(), engine };
  return applyEvent(state, event);
}

/** A choice a candidate's verifier left to the author. */
interface VerifierChoice {
  readonly candidate: string;
  readonly choice: string;
}

/** What the gate's metrics read of a decided run (M1 to M3 of the settled choice). */
export interface DeciderFacts {
  /** What needs a person, split as R4 has it: the questions and the fixes that depart from a written rule. */
  readonly needsAPerson: {
    readonly questions: readonly { readonly finding: number; readonly id: string; readonly question: string }[];
    readonly departures: readonly { readonly finding: number; readonly id: string; readonly rule: string }[];
  };
  /** Each decision of `fix` with its approach, which M2 reads by hand for one that edits nothing. */
  readonly fixes: readonly { readonly finding: number; readonly id: string; readonly approach: string; readonly departure: boolean }[];
  /** Each finding a candidate's verifier named a choice for, with its decision, its settled choices and each such choice no settled choice names the candidate of (M3). */
  readonly choices: readonly {
    readonly finding: number;
    readonly id: string;
    readonly decision: RecordedDecision['decision'];
    readonly leave: string | null;
    readonly departure: boolean;
    readonly verifiers: readonly VerifierChoice[];
    readonly settled: RecordedDecision['settled'];
    readonly unanswered: readonly VerifierChoice[];
  }[];
}

/** The facts of a run whose decisions are recorded. */
export function deciderFacts(state: RunState): DeciderFacts {
  const review = state.review!;
  const brief = briefOf(state);
  const numberOf = (id: string): number => brief.numbers.get(id)!;
  const decided = new Map((review.decisions ?? []).map((decision) => [decision.id, decision]));
  return {
    needsAPerson: {
      questions: brief.questions.map(({ finding, id, question }) => ({ finding, id, question })),
      departures: brief.departures.map(({ finding, id, rule }) => ({ finding, id, rule })),
    },
    fixes: (review.decisions ?? []).flatMap((decision) => (decision.decision === 'fix' ? [{ finding: numberOf(decision.id), id: decision.id, approach: decision.fix.approach, departure: decision.departure !== null }] : [])),
    choices: rankedFindings(review).flatMap((entry) => {
      const verifiers = entry.choices.flatMap(({ id, choice }) => (choice === null ? [] : [{ candidate: id, choice }]));
      const decision = decided.get(entry.finding.id);
      if (verifiers.length === 0 || decision === undefined) return [];
      const named = new Set(decision.settled.flatMap((settled) => settled.for));
      return [{
        finding: numberOf(entry.finding.id),
        id: entry.finding.id,
        decision: decision.decision,
        leave: decision.leave?.reason ?? null,
        departure: decision.departure !== null,
        verifiers,
        settled: decision.settled,
        unanswered: verifiers.filter((verifier) => !named.has(verifier.candidate)),
      }];
    }),
  };
}

/** How a scope file's status reads as GitHub lists a file of a pull request. */
const listedStatus: Readonly<Record<ScopeState['files'][number]['status'], PullRequestFileStatus>> = { added: 'added', modified: 'modified', deleted: 'removed' };

/** The bytes git's C-style quoting of a path (`quote_c_style`) writes as a backslash and a letter, by that letter. */
const quotedLetters: Readonly<Record<string, number>> = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c };

/**
 * The path a C-style quoted name of git's holds, read from `text` from the
 * quote at `start` to its closing quote, with the index past that quote; null
 * when `text` holds no well-formed quoted name there. git quotes a path that
 * holds a byte it cannot write as is, such as a quote, a control character
 * or, unless core.quotePath is false, a byte of a non-ASCII character, which
 * it writes as three octal digits; those bytes read as UTF-8.
 */
function quotedName(text: string, start: number): { readonly name: string; readonly end: number } | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  for (let index = start + 1; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    if (character === '"') return { name: Buffer.from(bytes).toString('utf8'), end: index + 1 };
    if (character !== '\\') {
      bytes.push(...Buffer.from(character, 'utf8'));
      index += character.length;
      continue;
    }
    const escaped = text[index + 1];
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(index + 1, index + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 4;
    } else if (escaped !== undefined && Object.hasOwn(quotedLetters, escaped)) {
      bytes.push(quotedLetters[escaped]!);
      index += 2;
    } else return null;
  }
  return null;
}

/** A name of a patch as git writes it, quoted or as is, read whole; null for a quoted name that is not well formed or does not fill `text`. */
function patchName(text: string): string | null {
  if (!text.startsWith('"')) return text;
  const quoted = quotedName(text, 0);
  return quoted !== null && quoted.end === text.length ? quoted.name : null;
}

/**
 * The path a file's part of a patch changes, on its new side, or null when
 * the part does not say it plainly. A rename or a copy names it on its own
 * line, `rename to` or `copy to`, since the two sides of its header differ.
 * Otherwise the header names the path twice, `diff --git a/<path> b/<path>`:
 * a quoted new side is read up to its quote, and an unquoted header is read
 * as the two sides equal, so a path that holds ` b/` is not split there.
 */
export function newPathOfPatchPart(part: string): string | null {
  const [first, ...rest] = part.split('\n');
  if (!first!.startsWith('diff --git ')) return null;
  const header = first!.slice('diff --git '.length);
  for (const line of rest) {
    // The extended header lines end where the content of the part starts.
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('Binary files ') || line === 'GIT binary patch') break;
    const named = /^(?:rename|copy) to (.+)$/.exec(line);
    if (named !== null) return patchName(named[1]!);
  }
  if (header.endsWith('"')) {
    // Neither side holds a space before a quote: an unquoted name holds no quote, and a quoted one escapes it.
    const newSide = quotedName(header, header.lastIndexOf(' "') + 1);
    return newSide !== null && newSide.end === header.length && newSide.name.startsWith('b/') ? newSide.name.slice(2) : null;
  }
  if (header.startsWith('"')) {
    const oldSide = quotedName(header, 0);
    return oldSide !== null && header.startsWith(' b/', oldSide.end) ? header.slice(oldSide.end + 3) : null;
  }
  const path = header.slice(2, 2 + (header.length - 5) / 2);
  return header === `a/${path} b/${path}` ? path : null;
}

/**
 * The files of the change with their patches, in place of the list
 * `publish` reads from GitHub: each file of `files`, with the part of
 * `patch` whose new side is its path. A file `scope.exclude` left out is
 * not among them, so a finding on one reads as on a file the pull request
 * does not change, which places it in the body as GitHub's list would.
 */
export function patchFiles(files: readonly Pick<ScopeFile, 'path' | 'status'>[], patch: string): PullRequestFile[] {
  const parts = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const path = newPathOfPatchPart(part);
    if (path !== null && !parts.has(path)) parts.set(path, part);
  }
  return files.map((file) => ({ path: file.path, status: listedStatus[file.status], previousPath: null, patch: parts.get(file.path) ?? null }));
}

/** The files of the change with the patches the run captured, as `patchFiles` reads them. */
function capturedFiles(scope: ScopeState, evidence: EvidenceStore): PullRequestFile[] {
  return patchFiles(scope.files, evidence.read(scope.patch).toString('utf8'));
}

/** The lines `publish --dry-run` prints for a decided run of a pull request, with no writer's answer, or the refusal of a form that does not fit. */
function renderedReview(state: RunState, scope: ScopeState, context: { readonly root: string; readonly tree: string; readonly evidence: EvidenceStore; readonly engine: string; readonly environment: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform }): string[] {
  const places = placeFindings(state.review!, capturedFiles(scope, context.evidence));
  const form = pullRequestForm({
    state,
    answer: null,
    places,
    machine: machineContextOf({ worktree: state.worktree, checkpoint: context.root, gitCommon: locateCheckpoint(context.tree).commonDir, engine: join(import.meta.dirname, '..'), workers: state.workers, environment: context.environment, platform: context.platform }),
    engine: context.engine,
    serial: state.publications.length + 1,
  });
  if (form.kind === 'refused') return [`The review cannot be posted: ${formRefusalWords(form)}`];
  return dryRunLines(state, places, form, []);
}

/** The settings a replayed decider runs with, and whether they are the recorded decider's launch's or the role policy's. */
export interface DeciderSettings {
  readonly from: 'recorded' | 'policy';
  readonly model: string;
  readonly effort: WorkerLaunch['effort'];
  readonly timeoutMs: number;
  readonly budgetUsd: number | null;
  readonly pinned: { readonly codex?: { readonly windowsSandbox: WindowsSandbox } };
}

/** The last decider the run launched before its decision phase recorded anything, or null when it launched none there. */
function recordedDeciderLaunch(state: RunState): WorkerLaunch | null {
  const launches = Object.values(state.workers).map((worker) => worker.launch).filter((launch) => {
    const unit = parseUnitLabel(launch.label);
    return unit?.role === role && unit.phase === 'decision';
  });
  return launches.at(-1) ?? null;
}

/**
 * The settings the replayed decider runs with, as `settingsOf` of the
 * verifier's replay takes them: on the runtime the run's decider ran on,
 * what that decider's launch recorded, so the replay differs from the
 * record in nothing but the roles' prompt; on another runtime, or for a run
 * that recorded no decider launch, the role policy's for the runtime.
 */
function deciderSettings(resolved: ResolvedPolicy, adapter: RuntimeAdapter, state: RunState): DeciderSettings {
  const policy = pinnedRole(resolved.roles, role);
  const recorded = recordedDeciderLaunch(state);
  const policyCodex = resolved.codex === null ? {} : { codex: resolved.codex };
  if (recorded === null || recorded.runtime !== adapter.name) return { from: 'policy', model: policy.model, effort: policy.effort, timeoutMs: policy.timeoutMs, budgetUsd: policy.budgetUsd, pinned: policyCodex };
  if (!adapter.capabilities.effortLevels.includes(recorded.effort)) throw new ReplayRefusedError(`The run's decider ran at effort ${recorded.effort}, which runtime ${adapter.name} no longer has; it has ${adapter.capabilities.effortLevels.join(', ')}`);
  const recordedCodex = state.review?.configuration.codex ?? null;
  return {
    from: 'recorded',
    model: recorded.model,
    effort: recorded.effort,
    timeoutMs: recorded.timeoutMs,
    budgetUsd: adapter.capabilities.budgetCap ? (recorded.budgetUsd ?? policy.budgetUsd) : null,
    pinned: recordedCodex === null ? policyCodex : { codex: recordedCodex },
  };
}

/** One decider launch of the replay: its worker, what became of its answer, and what it spent. */
export interface DeciderAttempt {
  readonly attempt: number;
  readonly workerId: string;
  readonly outcome: Checked['kind'];
  /** What the check refused the answer for, or why the worker gave none; null for an accepted answer. */
  readonly reason: string | null;
  /** The wall time of the worker's process, in seconds. */
  readonly seconds: number;
  /** What the worker cost, or null on a runtime that reports none. */
  readonly costUsd: number | null;
}

export interface DeciderReplayOptions {
  /** The `deep-review-checkpoint` directory that holds the recorded run. Only a copy of its ledger is read, and its evidence. */
  readonly checkpoint: string;
  /** The id of the run, or the start of it. */
  readonly run: string;
  /** A checkout of the repository at the commit the run reviewed, holding no change: where the decider runs. */
  readonly tree: string;
  /** A directory that is absent or empty, for the replay's files and its own checkpoint. */
  readonly output: string;
  readonly runtime: string;
  readonly executable: string;
  readonly executableArgs?: readonly string[];
  /**
   * The roles directory whose decider prompt the replay runs with, in place
   * of the one the run pinned. Its policy gives the launch settings only on
   * another runtime than the run's decider ran on, or for a run that
   * recorded no decider launch; otherwise the recorded launch's are kept.
   */
  readonly rolesRoot: string;
  /** Write the first attempt's prompt and launch nothing. */
  readonly printTask?: boolean;
  /** The engine version the replay's own checkpoint and the rendered review name. */
  readonly engine: string;
  readonly log: (line: string) => void;
  readonly runtimes?: RuntimeRegistry;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scratchRoot?: string;
  readonly platform?: NodeJS.Platform;
}

export interface DeciderReplayOutcome {
  readonly runId: string;
  /** The launches in order; none when the task was only printed. */
  readonly attempts: readonly DeciderAttempt[];
  /** The accepted decisions in the ranking's order, or null when no answer was accepted or nothing was launched. */
  readonly decisions: readonly RecordedDecision[] | null;
}

/**
 * Replay the decider of a recorded run. In order: read the run up to its
 * decision and refuse one that never reached it; refuse a tree that is not
 * the reviewed commit, unchanged, and an output directory that is inside
 * it or holds anything; build the first attempt's prompt with the roles
 * given; then, unless only printing the task, launch up to
 * `deciderAttempts` deciders, the second told what the check refused the
 * first for, and from an accepted answer write the decisions, the review
 * and the facts. Each prompt and answer is written as it is made.
 */
export async function replayDecider(options: DeciderReplayOptions): Promise<DeciderReplayOutcome> {
  const { log } = options;
  const platform = options.platform ?? process.platform;
  const root = resolve(options.checkpoint);
  const recorded = readRecordedRun(root, options.run);
  const state = foldBeforeDecisions(recorded);
  const scope = state.scope!;
  const evidence = new EvidenceStore(join(root, evidenceDirectoryName));

  const tree = locateCheckpoint(options.tree).worktree;
  const differences = treeDifferences(state, tree);
  if (differences.length > 0) throw new ReplayRefusedError(`${tree} is not the tree run ${state.id} reviewed: ${differences.join('; ')}`);
  const output = resolve(options.output);
  if (isWithin(tree, canonicalPath(output))) throw new ReplayRefusedError(`The output directory ${output} is inside the tree ${tree}, where the decider would read the replay's files and they would read as changes to the tree; give it an output directory outside the tree`);
  if (existsSync(output) && readdirSync(output).length > 0) throw new ReplayRefusedError(`The output directory ${output} is not empty; give each replay a directory of its own`);

  const runtimes = options.runtimes ?? defaultRuntimes();
  const adapter = runtimes.get(options.runtime);
  const roles = assembleRoles(options.rolesRoot);
  const assembled = roles.find((candidate) => candidate.key === role);
  if (assembled === undefined) throw new ReplayRefusedError(`The roles directory ${options.rolesRoot} assembles no ${role} role`);
  const settings = deciderSettings(resolvePolicy(readPolicy(options.rolesRoot), roles, adapter, {}, platform), adapter, state);
  const findings = rankedFindings(state.review!);
  const block = scopeBlockOf(state, scope, tree, evidence);
  const promptOf = (refused: readonly string[]): string => composeWorkerPrompt(assembled.prompt, { role, phase: 'decision', unitKey, task: deciderTask(deciderFindings(state.review!), refused) }, block);

  log(`replaying the decider of run ${state.id}: ${String(findings.length)} findings, read up to sequence ${String(state.lastSequence)}, before the decision phase recorded anything`);
  log(`the decider runs with this engine and the roles in ${options.rolesRoot}, not the roles the run pinned, on ${adapter.name} ${settings.model} at effort ${settings.effort}, ${settings.from === 'recorded' ? 'as the run\'s decider ran' : 'as the roles\' policy has it, since the run recorded no decider launch on this runtime'}`);
  mkdirSync(output, { recursive: true });
  const write = (name: string, text: string): string => {
    const path = join(output, name);
    writeWhole(path, text);
    return path;
  };

  if (options.printTask === true) {
    const prompt = promptOf([]);
    const path = write(promptFileName(1), prompt);
    log(`print task: the prompt of the first attempt, ${String(Buffer.byteLength(prompt, 'utf8'))} bytes, at ${path}; nothing was launched`);
    return { runId: state.id, attempts: [], decisions: null };
  }

  const replay = Checkpoint.open(join(output, replayCheckpointDirectoryName), { engine: options.engine });
  try {
    const run = replay.createRun({ worktree: tree });
    // Every worker of a run of a pull request is launched without the variables that hold a token for gh, as the review launched them (R15 of the review on the pull request).
    const environment = scope.pullRequest === null ? options.environment : withoutVariables(options.environment ?? process.env, ghTokenVariables, platform);
    const attempts: DeciderAttempt[] = [];
    const refused: string[] = [];
    let accepted: { readonly workerId: string; readonly decisions: readonly RecordedDecision[] } | null = null;
    for (let attempt = 1; attempt <= deciderAttempts && accepted === null; attempt += 1) {
      const prompt = promptOf(refused);
      write(promptFileName(attempt), prompt);
      const receipt = await runWorker(replay, run.id, {
        runtime: adapter.name,
        executable: options.executable,
        executableArgs: [...(options.executableArgs ?? [])],
        model: settings.model,
        effort: settings.effort,
        access: 'read-only',
        shell: true,
        prompt,
        outputSchema: deciderOutputSchema,
        timeoutMs: settings.timeoutMs,
        ...(settings.budgetUsd === null ? {} : { budgetUsd: settings.budgetUsd }),
        label: unitLabel(role, 'decision', unitKey),
      }, {
        runtimes,
        pinned: settings.pinned,
        platform,
        ...(environment === undefined ? {} : { environment }),
        ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
      });
      if (receipt.output !== null) write(answerFileName(attempt), `${JSON.stringify(receipt.output, null, 2)}\n`);
      const checked = checkedAnswer(receipt, findings);
      const settled = settledWorkers(replay.fold(run.id)).filter((worker) => worker.launch.workerId === receipt.workerId);
      const spend = spendOf(settled, adapter);
      attempts.push({ attempt, workerId: receipt.workerId, outcome: checked.kind, reason: checked.kind === 'accepted' ? null : checked.reason, seconds: spend.seconds, costUsd: spend.costUsd });
      log(`attempt ${String(attempt)} of ${String(deciderAttempts)}: ${checked.kind}${checked.kind === 'accepted' ? '' : `: ${checked.reason}`} (${String(spend.seconds)} s, ${spend.costUsd === null ? 'no cost reported' : `${spend.costUsd.toFixed(2)} USD`})`);
      if (checked.kind === 'accepted') accepted = { workerId: receipt.workerId, decisions: checked.decisions };
      // Only a refusal of the check is named to the next attempt, as the decision phase names only those (R9 of the settled choice).
      if (checked.kind === 'refused') refused.push(checked.reason);
    }

    const launch = {
      run: state.id,
      runtime: adapter.name,
      model: settings.model,
      effort: settings.effort,
      settingsFrom: settings.from,
      roles: options.rolesRoot,
      roleNote: `The decider ran with the role prompt above and this engine, not with the roles the run pinned, and with ${settings.from === 'recorded' ? 'the model, effort, timeout and budget of the recorded decider\'s launch' : 'the model, effort, timeout and budget of the roles\' policy, since the run recorded no decider launch on this runtime'}.`,
    };
    if (accepted === null) {
      write(factsFileName, `${JSON.stringify({ ...launch, attempts, accepted: false }, null, 2)}\n`);
      log(`no answer was accepted in ${String(deciderAttempts)} attempts, so nothing is rendered`);
      return { runId: state.id, attempts, decisions: null };
    }
    const decided = withDecisions(state, accepted.workerId, accepted.decisions, options.engine);
    const decisions = decided.review!.decisions!;
    write(decisionsFileName, `${JSON.stringify(decisions, null, 2)}\n`);
    if (scope.pullRequest === null) log(`run ${state.id} reviewed no pull request, so there is no review to render`);
    else write(reviewFileName, `${renderedReview(decided, scope, { root, tree, evidence, engine: options.engine, environment: options.environment ?? process.env, platform }).join('\n')}\n`);
    write(factsFileName, `${JSON.stringify({ ...launch, attempts, accepted: true, ...deciderFacts(decided) }, null, 2)}\n`);
    return { runId: state.id, attempts, decisions };
  } finally {
    replay.close();
  }
}
