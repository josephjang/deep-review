import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import { RunClosedError, StaleRevisionError } from '../checkpoint/errors.ts';
import { sessionIdSchema, type DeniedTool, type WorkerFinish, type WorkerLaunch, type WorkerOutcome } from '../checkpoint/events.ts';
import type { RunState, WorkerState } from '../checkpoint/fold.ts';
import { sha256Hex, type ArtifactReference } from '../evidence/store.ts';
import { maxDecodeBytes, outputLines, type Decoded, type DecodedResult, type LaunchPlan, type RuntimeAdapter, type WorkerOutputs } from './adapter.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from './contract.ts';
import { workerEnvironment } from './environment.ts';
import { InvalidInvocationError, UnsupportedCapabilityError } from './errors.ts';
import { preflight } from './preflight.ts';
import { notStarted, runProcess, type ProcessResult } from './process.ts';
import type { RuntimeRegistry } from './registry.ts';
import { defaultRuntimes } from './runtimes.ts';
import { checkpointScratchKey, chooseScratch, defaultScratchRoot } from './scratch.ts';

/** Longest error text the ledger records; the full story is in the frozen stdout and stderr. */
const maxErrorLength = 4000;

/** How many times an append is re-folded and retried when another writer got there first. */
const appendAttempts = 50;

/** Directory under the checkpoint root that holds each worker's process files until they are frozen. */
export const ioDirectoryName = 'io';

/** Everything the engine learns from one worker, the same shape for every runtime (R1, R5). */
export interface WorkerReceipt {
  readonly workerId: string;
  readonly outcome: WorkerOutcome;
  /** Why the outcome is not `completed`, or null. */
  readonly error: string | null;
  readonly process: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly termination: ProcessResult['termination'];
    readonly startedAt: string;
    readonly endedAt: string;
  };
  readonly runtime: {
    readonly name: string;
    readonly version: string;
    readonly sessionIds: readonly string[];
    /** Usage as the runtime reported it, or null. */
    readonly usage: unknown;
  };
  /** Refused tool calls, or null when the runtime gives no evidence either way. Never changes the outcome. */
  readonly denials: readonly DeniedTool[] | null;
  /** The answer, validated against the output schema; null unless the outcome is `completed`. */
  readonly output: unknown;
  readonly evidence: {
    readonly prompt: ArtifactReference;
    readonly schema: ArtifactReference;
    readonly stdout: ArtifactReference;
    readonly stderr: ArtifactReference;
    readonly finalMessage: ArtifactReference | null;
    readonly output: ArtifactReference | null;
  };
}

export interface RunWorkerOptions {
  /** The runtimes to choose from; the engine's own by default. */
  readonly runtimes?: RuntimeRegistry;
  /** The environment the worker inherits; this process's by default. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Source of worker ids and pinned session ids; random UUIDs by default. */
  readonly ids?: () => string;
  /**
   * Replaces the preflight and returns the version to record. Tests use it
   * to reach a spawn failure, which the real preflight would stop first.
   */
  readonly qualify?: (adapter: RuntimeAdapter, invocation: Invocation, environment: NodeJS.ProcessEnv) => Promise<string>;
  /** Where a worker's scratch directory is created when the invocation names none; `defaultScratchRoot()` by default. */
  readonly scratchRoot?: string;
}

/**
 * Run one worker to its end and record it (R1, R3, R6). In order: refuse a
 * closed run, a malformed invocation or a missing capability; build the
 * command; qualify the executable; freeze the prompt and schema; create the
 * scratch directory; append `worker.launched`; spawn; decode; freeze every
 * output; append `worker.finished`; return the receipt.
 *
 * Nothing is appended unless every check before the launch passes. Once
 * the launch is appended, a finish is appended for it whatever happens to
 * the process, so the ledger holds no launched worker without a finish from
 * this launcher; the one exception is a run abandoned while its worker ran,
 * which accepts no finish and makes this function throw `RunClosedError`
 * with the worker's evidence already frozen.
 *
 * A refused launch leaves no process files, and removes the scratch
 * directory it created for the worker; the roots above it may be shared
 * and stay. After a finish the process files are removed, unless the
 * launcher could not freeze them; then they are the only copy, and stay.
 */
export async function runWorker(checkpoint: Checkpoint, runId: string, input: InvocationInput, options: RunWorkerOptions = {}): Promise<WorkerReceipt> {
  const invocation = parseInvocation(input);
  const state = checkpoint.fold(runId);
  if (state.status !== 'active') throw new RunClosedError(`Run ${runId} is ${state.status} and cannot launch a worker`);
  const adapter = (options.runtimes ?? defaultRuntimes()).get(invocation.runtime);
  refuseMissingCapabilities(adapter, invocation);
  const schema = compileOutputSchema(invocation.outputSchema);
  const schemaDigest = sha256Hex(Buffer.from(schema.text, 'utf8'));
  const continued = invocation.resume === undefined ? null : continuedWorker(state, invocation, schemaDigest);
  requireDirectory(state.worktree);

  const ids = options.ids ?? randomUUID;
  const workerId = ids();
  const scratch = chooseScratch(checkpoint, state, adapter, invocation, continued, join(options.scratchRoot ?? defaultScratchRoot(), checkpointScratchKey(checkpoint), workerId));
  const sessionId = invocation.resume ?? (adapter.capabilities.assignsSessionId ? ids() : null);
  const io = join(checkpoint.root, ioDirectoryName, workerId);
  const inherited = options.environment ?? process.env;
  const plan: LaunchPlan = {
    sessionId,
    resume: invocation.resume ?? null,
    scratch,
    schema,
    schemaFile: join(io, 'schema.json'),
    finalMessageFile: join(io, 'final-message'),
    platform: process.platform,
    environment: inherited,
  };
  const command = adapter.command(invocation, plan);
  const environment = workerEnvironment(command.environment, scratch, plan.platform);
  const version = await (options.qualify ?? qualify)(adapter, invocation, inherited);

  const prompt = composePrompt(invocation.prompt, scratch);
  const promptReference = checkpoint.evidence.put(prompt);
  const schemaReference = checkpoint.evidence.put(schema.text);
  // What a finish records for an output the launcher could not freeze. Frozen
  // now, while a failure still launches nothing, so recording a finish never
  // has to write to an evidence store that may be the very thing that failed.
  const emptyReference = checkpoint.evidence.put('');
  // Only a directory this call created is removed when nothing launches: a caller's or a continued worker's may hold files.
  const createdScratch = scratch !== null && mkdirSync(scratch, { recursive: true }) !== undefined ? scratch : null;
  const stdinFile = join(io, 'prompt');

  const launch: WorkerLaunch = {
    workerId,
    label: invocation.label ?? null,
    runtime: adapter.name,
    executable: invocation.executable,
    executableArgs: invocation.executableArgs,
    version,
    model: invocation.model,
    effort: invocation.effort,
    access: invocation.access,
    shell: invocation.shell,
    sessionId,
    resumes: invocation.resume ?? null,
    scratch,
    budgetUsd: invocation.budgetUsd ?? null,
    timeoutMs: invocation.timeoutMs,
    prompt: promptReference,
    schema: schemaReference,
  };
  let createdIo = false;
  try {
    mkdirSync(join(checkpoint.root, ioDirectoryName), { recursive: true });
    // Not recursive: a directory already there is another worker's, never to be shared or removed.
    mkdirSync(io);
    createdIo = true;
    writeFileSync(stdinFile, prompt, { flag: 'wx' });
    writeFileSync(plan.schemaFile, schema.text, { flag: 'wx' });
    appendFresh(checkpoint, runId, { kind: 'worker.launched', version: 1, payload: launch }, (fresh) => {
      // Another launcher may have continued the same session since the first fold.
      if (invocation.resume !== undefined) continuedWorker(fresh, invocation, schemaDigest);
    });
  } catch (error) {
    // Nothing will run: the process files and a scratch directory made for it have no use. The frozen prompt and schema stay, unreferenced.
    if (createdIo) rmSync(io, { recursive: true, force: true });
    if (createdScratch !== null) rmSync(createdScratch, { recursive: true, force: true });
    throw error;
  }

  // From here on a finish is appended whatever fails: the launcher's own
  // failures (a full disk, a vanished directory) are recorded with what is
  // known rather than leaving the launch open. Neither runProcess nor settle
  // throws, so nothing stands between the launch and the finish's append.
  let result: ProcessResult;
  try {
    result = await runProcess({
      executable: invocation.executable,
      args: [...invocation.executableArgs, ...command.args],
      cwd: state.worktree,
      environment,
      stdinFile,
      stdoutFile: join(io, 'stdout'),
      stderrFile: join(io, 'stderr'),
      timeoutMs: invocation.timeoutMs,
    });
  } catch (error) {
    const now = new Date().toISOString();
    result = notStarted(`the launcher could not start it: ${describeError(error)}`, now, now);
  }
  const settled = settle(checkpoint, adapter, invocation, plan, result, io, emptyReference);
  // The pinned or continued session is on every finish, whatever the outputs named, so its transcript is never unnamed.
  const finish: WorkerFinish = { workerId, ...settled.finish, sessionIds: withPinnedSession(plan.sessionId, settled.observedSessionIds) };
  try {
    appendFresh(checkpoint, runId, { kind: 'worker.finished', version: 1, payload: finish });
  } finally {
    // Once every process file is evidence the directory goes, whether or not
    // the finish could be appended (a run abandoned meanwhile accepts none).
    // Files the launcher could not freeze are their only copy: they stay,
    // and the finish's error names the directory.
    if (!settled.keepProcessFiles) rmSync(io, { recursive: true, force: true });
  }

  return {
    workerId,
    outcome: finish.outcome,
    error: finish.error,
    process: { exitCode: finish.exitCode, signal: finish.signal, termination: finish.termination, startedAt: finish.startedAt, endedAt: finish.endedAt },
    runtime: { name: adapter.name, version, sessionIds: finish.sessionIds, usage: settled.usage },
    denials: finish.denials,
    output: settled.output,
    evidence: { prompt: promptReference, schema: schemaReference, stdout: finish.stdout, stderr: finish.stderr, finalMessage: finish.finalMessage, output: finish.output },
  };
}

/**
 * The real preflight, against the caller's environment: what it checks, the
 * executable's version and flags, does not depend on the worker's pins, and
 * the worker's temporary directory is not created until the launch is
 * certain.
 */
function qualify(adapter: RuntimeAdapter, invocation: Invocation, environment: NodeJS.ProcessEnv): Promise<string> {
  return preflight(adapter, invocation.executable, invocation.executableArgs, environment);
}

/** Refuse, by name, anything the invocation needs that the runtime cannot do (R2, TD4). */
function refuseMissingCapabilities(adapter: RuntimeAdapter, invocation: Invocation): void {
  const { capabilities } = adapter;
  if (!capabilities.effortLevels.includes(invocation.effort)) {
    throw new UnsupportedCapabilityError(adapter.name, 'effortLevels', `run at effort ${invocation.effort}; it has ${capabilities.effortLevels.join(', ')}`);
  }
  if (invocation.budgetUsd !== undefined && !capabilities.budgetCap) throw new UnsupportedCapabilityError(adapter.name, 'budgetCap', 'stop a worker at a budget');
  if (!invocation.shell && !capabilities.withholdShell) throw new UnsupportedCapabilityError(adapter.name, 'withholdShell', 'run a worker without a shell');
  if (invocation.resume !== undefined && !capabilities.resume) throw new UnsupportedCapabilityError(adapter.name, 'resume', 'continue a session');
  if (invocation.scratch !== undefined && invocation.access === 'read-only' && !capabilities.readOnlyScratch) {
    throw new UnsupportedCapabilityError(adapter.name, 'readOnlyScratch', 'let a read-only worker write to a scratch directory');
  }
}

/** How a continuation checks a field it keeps from the worker it continues. */
interface KeptField {
  /** What a refusal calls the field. */
  readonly name: string;
  /** The value the invocation asks for, in the form compared; undefined when the invocation leaves it to the worker continued. */
  readonly requested: (invocation: Invocation, schemaDigest: string) => unknown;
  /** The recorded value in that form; the launch's own field by default. */
  readonly recorded?: (launch: WorkerLaunch) => unknown;
}

/**
 * What a continuation does with each field of the launch it continues (R9):
 * a kept field must equal the worker continued, an `own` one is the new
 * worker's. Every field is named, so a field added to the launch, such as a
 * new permission, fails to compile here until it is classified.
 */
export const continuationFields: { readonly [Field in keyof WorkerLaunch]-?: 'own' | KeptField } = {
  runtime: { name: 'runtime', requested: (invocation) => invocation.runtime },
  model: { name: 'model', requested: (invocation) => invocation.model },
  effort: { name: 'effort', requested: (invocation) => invocation.effort },
  access: { name: 'access', requested: (invocation) => invocation.access },
  shell: { name: 'shell', requested: (invocation) => invocation.shell },
  schema: { name: 'output schema digest', requested: (_invocation, schemaDigest) => schemaDigest, recorded: (launch) => launch.schema.sha256 },
  // The ledger holds the resolved path chooseScratch recorded; the caller's is compared in the same spelling, and may be left out.
  scratch: { name: 'scratch directory', requested: (invocation) => (invocation.scratch === undefined ? undefined : resolve(invocation.scratch)) },
  // A new process: its own id, label, prompt, spend and time, under the session it resumes.
  workerId: 'own',
  label: 'own',
  prompt: 'own',
  budgetUsd: 'own',
  timeoutMs: 'own',
  sessionId: 'own',
  resumes: 'own',
  // Any qualified binary of the same runtime may continue it, such as the one an auto-update installed; the launch records which ran (R4).
  executable: 'own',
  executableArgs: 'own',
  version: 'own',
};

/**
 * The finished worker whose session the invocation continues (R9). The
 * session must be one a worker of this run ran under, every worker in it
 * must have finished (none still running, none lost), and the
 * continuation keeps every field `continuationFields` marks kept: the
 * runtime, model, effort, permissions, schema and scratch directory. The
 * budget and timeout are the continuation's own: it is a new process with
 * its own spend.
 */
function continuedWorker(state: RunState, invocation: Invocation, schemaDigest: string): Extract<WorkerState, { status: 'finished' }> {
  const session = invocation.resume!;
  const inSession = Object.values(state.workers).filter(
    (worker) => worker.launch.sessionId === session || (worker.status === 'finished' && worker.finish.sessionIds.includes(session)),
  );
  if (inSession.length === 0) throw new InvalidInvocationError(`No worker of run ${state.id} ran session ${session}, so there is nothing to continue`);
  const running = inSession.find((worker) => worker.status === 'running');
  if (running !== undefined) throw new InvalidInvocationError(`Worker ${running.launch.workerId} is still running in session ${session}; continue it after it finishes`);
  // A lost worker's engine stopped while it ran (TD5 of the read-only review): its process may be an orphan still
  // writing to the session, or may never have been spawned, and nothing on the ledger tells which.
  const lost = inSession.find((worker) => worker.status === 'lost');
  if (lost !== undefined) {
    throw new InvalidInvocationError(`Worker ${lost.launch.workerId} was lost in session ${session}: whether its process still runs is unknown, so the session cannot be continued safely; start a fresh worker instead`);
  }
  const finished = inSession.filter((worker): worker is Extract<WorkerState, { status: 'finished' }> => worker.status === 'finished');
  // A pinned session id is on the ledger before the process exists; if no process ever did, the runtime holds no conversation.
  if (finished.every((worker) => worker.finish.termination === 'not-started')) {
    throw new InvalidInvocationError(`No worker of session ${session} ever started, so the runtime has no conversation to continue`);
  }
  // Workers fold in ledger order, so the last one is the latest word in the session.
  const previous = finished.at(-1)!;
  for (const [field, rule] of Object.entries(continuationFields) as [keyof WorkerLaunch, 'own' | KeptField][]) {
    if (rule === 'own') continue;
    const now = rule.requested(invocation, schemaDigest);
    if (now === undefined) continue;
    const before = rule.recorded === undefined ? previous.launch[field] : rule.recorded(previous.launch);
    if (before !== now) throw new InvalidInvocationError(`A continuation of session ${session} must keep its ${rule.name}: it was ${String(before)}, the invocation has ${String(now)}`);
  }
  return previous;
}

/** The run's worktree is the worker's working directory; a missing one would fail the spawn in a way indistinguishable from a missing executable. */
function requireDirectory(worktree: string): void {
  const stat = statSync(worktree, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) throw new InvalidInvocationError(`The run's worktree ${worktree} is not a directory`);
}

/** The prompt the worker receives: the caller's, then where it may write temporary files, or that it may write none (R7). */
export function composePrompt(prompt: string, scratch: string | null): string {
  const note =
    scratch === null
      ? 'No scratch directory is available to you: do not create temporary files anywhere.'
      : `Your scratch directory is ${scratch}. Write temporary files there and nowhere else; TEMP, TMP and TMPDIR point at it.`;
  return `${prompt}\n\n${note}\n`;
}

/**
 * Append one event to the run's latest state, re-folding and retrying when
 * another writer appended first; several launchers may finish on one run at
 * once. `check` runs against every fresh fold before the append.
 */
function appendFresh(checkpoint: Checkpoint, runId: string, event: NewEvent, check?: (state: RunState) => void): RunState {
  for (let attempt = 1; ; attempt += 1) {
    const state = checkpoint.fold(runId);
    check?.(state);
    try {
      return checkpoint.append(runId, state.lastSequence, [event]);
    } catch (error) {
      if (!(error instanceof StaleRevisionError) || attempt >= appendAttempts) throw error;
    }
  }
}

/** A finish without its worker id and session ids, what only the receipt carries, and whether the process files must stay. */
interface Settled {
  readonly finish: Omit<WorkerFinish, 'workerId' | 'sessionIds'>;
  /** The session ids the outputs named that the ledger can hold; `runWorker` adds the pinned one. */
  readonly observedSessionIds: readonly string[];
  readonly usage: unknown;
  readonly output: unknown;
  /** Some process file could not be frozen, so the io directory holds its only copy. */
  readonly keepProcessFiles: boolean;
}

/**
 * What settling a worker has established so far. A failure part-way through
 * records all of it, never less: the outputs already frozen and every session
 * id already decoded, so the ledger neither claims the worker printed nothing
 * nor loses the session a continuation needs.
 */
interface Known {
  stdout: ArtifactReference;
  stderr: ArtifactReference;
  finalMessage: ArtifactReference | null;
  /** stdout, stderr and the final message are all evidence now. */
  frozen: boolean;
  /** The session ids the outputs named that the ledger can hold; none until the outputs are decoded. */
  sessionIds: readonly string[];
}

/** Read a process file, or null when it was never written. */
function readIfPresent(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

/** Cut an error to the length the ledger records, never between the two halves of a surrogate pair. */
function truncate(error: string): string {
  if (error.length <= maxErrorLength) return error;
  const last = error.charCodeAt(maxErrorLength - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maxErrorLength - 1 : maxErrorLength;
  return `${error.slice(0, end)} [truncated]`;
}

/** The message of anything thrown; even a value whose conversion to text throws gets one. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'a thrown value that cannot be shown as text';
  }
}

const usageText = (usage: unknown): string | null => (usage === null || usage === undefined ? null : (JSON.stringify(usage) ?? null));

/** The session ids a finish records: the one pinned or continued before launch, if any, then each one the outputs named, once. */
export const withPinnedSession = (pinned: string | null, observed: readonly string[]): string[] => [...new Set(pinned === null ? observed : [pinned, ...observed])];

/** A decode that has no answer to offer: the session ids the outputs named, and why. */
const undecoded = (sessionIds: readonly string[], error: string): Decoded => ({ sessionIds, usage: null, denials: null, result: { kind: 'failed', error } });

/** How a worker ended, as the ledger records it: an answer only when completed, and a reason otherwise. */
export type Verdict =
  | { readonly outcome: 'completed'; readonly error: null; readonly output: unknown }
  | { readonly outcome: Exclude<WorkerOutcome, 'completed'>; readonly error: string; readonly output: null };

const failedWith = (error: string): Verdict => ({ outcome: 'failed', error, output: null });

/**
 * Decide the outcome (R5, TD5). What happened to the process comes first: a
 * worker that never started failed, and one killed at its timeout timed out.
 * Then what the runtime said: a budget stop or a failure it reported; then
 * an exit that was not clean; then the answer, checked against the schema.
 * A schema whose check throws makes this throw.
 */
export function workerVerdict(invocation: Invocation, result: ProcessResult, decoded: DecodedResult): Verdict {
  if (result.termination === 'not-started') return failedWith(`The worker did not start: ${result.error}`);
  if (result.termination === 'killed') {
    const how = result.treeKillError === null ? 'was killed with its process tree' : `was killed, but only its root: ${result.treeKillError}; descendants may still run`;
    return { outcome: 'timeout', error: `The worker ran past its timeout of ${String(invocation.timeoutMs)} ms and ${how}`, output: null };
  }
  switch (decoded.kind) {
    case 'budget':
      return { outcome: 'budget', error: decoded.error, output: null };
    case 'failed':
      return failedWith(decoded.error);
    case 'answer': {
      if (result.signal !== null) return failedWith(`The worker was ended by signal ${result.signal}`);
      if (result.exitCode !== 0) return failedWith(`The worker exited with code ${String(result.exitCode)}`);
      const validated = invocation.outputSchema.safeParse(decoded.value);
      return validated.success ? { outcome: 'completed', error: null, output: validated.data } : failedWith(`The answer does not match the output schema: ${z.prettifyError(validated.error)}`);
    }
  }
}

/**
 * The verdict once the session ids the ledger cannot hold are named: an
 * answer is then not recorded, since the session it belongs to could not
 * be, and any other reason names them as well.
 */
export function withUnrecordableSessions(verdict: Verdict, unrecordable: readonly string[]): Verdict {
  if (unrecordable.length === 0) return verdict;
  const note = `the runtime reported session ids the ledger cannot hold: ${JSON.stringify(unrecordable).slice(0, 500)}`;
  return verdict.outcome === 'completed' ? failedWith(`The answer is not recorded because ${note}`) : { ...verdict, error: `${verdict.error}; ${note}` };
}

/**
 * Freeze every output, decode it through the adapter, and decide the outcome
 * (R5, TD5). Never throws: a failure of the launcher itself becomes a failed
 * finish holding everything learned before it.
 */
function settle(checkpoint: Checkpoint, adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, result: ProcessResult, io: string, empty: ArtifactReference): Settled {
  const known: Known = { stdout: empty, stderr: empty, finalMessage: null, frozen: false, sessionIds: [] };
  try {
    return settleOutputs(checkpoint, adapter, invocation, plan, result, io, known);
  } catch (error) {
    return launcherFailure(result, error, known, io);
  }
}

/** The work of `settle`, recording in `known` each fact as it is established. */
function settleOutputs(checkpoint: Checkpoint, adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, result: ProcessResult, io: string, known: Known): Settled {
  const stdout = readIfPresent(join(io, 'stdout')) ?? Buffer.alloc(0);
  known.stdout = checkpoint.evidence.put(stdout);
  const stderr = readIfPresent(join(io, 'stderr')) ?? Buffer.alloc(0);
  known.stderr = checkpoint.evidence.put(stderr);
  const finalMessage = readIfPresent(plan.finalMessageFile);
  known.finalMessage = finalMessage === null ? null : checkpoint.evidence.put(finalMessage);
  known.frozen = true;

  const decoded = decodeOutputs(adapter, invocation, plan, stdout, stderr, finalMessage);
  // A runtime may print anything as a session id; only what the ledger can hold is kept, and the rest is named.
  const sessionIds = decoded.sessionIds.filter((id) => sessionIdSchema.safeParse(id).success);
  const strange = decoded.sessionIds.filter((id) => !sessionIdSchema.safeParse(id).success);
  known.sessionIds = sessionIds;

  const { outcome, error, output } = withUnrecordableSessions(workerVerdict(invocation, result, decoded.result), strange);

  const outputJson = outcome === 'completed' ? JSON.stringify(output) : undefined;
  return {
    finish: {
      outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      termination: result.termination,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      usage: usageText(decoded.usage),
      // The capability table is the contract (TD4): a runtime without denial evidence states none, whatever its decoder returned.
      denials: !adapter.capabilities.denialEvidence || decoded.denials === null ? null : [...decoded.denials],
      error: error === null ? null : truncate(error),
      stdout: known.stdout,
      stderr: known.stderr,
      finalMessage: known.finalMessage,
      output: outputJson === undefined ? null : checkpoint.evidence.put(outputJson),
    },
    observedSessionIds: sessionIds,
    usage: decoded.usage ?? null,
    output,
    keepProcessFiles: false,
  };
}

/**
 * Decode the outputs through the adapter. stdout is offered whole, as null
 * when it is above the decode cap, and a line at a time whatever its size,
 * so a runtime that reads it by line (Codex) is judged however long its
 * stream ran, and one that reads it whole (Claude) refuses it by name. A
 * stderr or final message above the cap is not decoded, but the session ids
 * are still read from the outputs with those cut to the cap: a runtime names
 * its session first (Codex's `thread.started` opens its stream), and a worker
 * whose session is not recorded can never be continued.
 */
function decodeOutputs(adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, stdout: Buffer, stderr: Buffer, finalMessage: Buffer | null): Decoded {
  const stdoutLines = outputLines(stdout);
  // Decoded when first read, since an adapter that reads the lines never needs all of stdout as one text.
  let stdoutText: string | null | undefined;
  const outputs = (limit: number): WorkerOutputs => ({
    get stdout() {
      if (stdoutText === undefined) stdoutText = stdout.length > maxDecodeBytes ? null : stdout.toString('utf8');
      return stdoutText;
    },
    stdoutLines,
    stderr: stderr.subarray(0, limit).toString('utf8'),
    finalMessage: finalMessage?.subarray(0, limit).toString('utf8') ?? null,
  });
  const oversized = (
    [
      ['stderr', stderr],
      ['final message', finalMessage],
    ] as const
  ).find(([, bytes]) => bytes !== null && bytes.length > maxDecodeBytes);
  if (oversized === undefined) return decodeSafely(adapter, invocation, plan, outputs(Infinity));
  const partial = decodeSafely(adapter, invocation, plan, outputs(maxDecodeBytes));
  return undecoded(
    partial.sessionIds,
    `The worker's ${oversized[0]} is ${String(oversized[1]!.length)} bytes, above the ${String(maxDecodeBytes)} bytes the launcher decodes; it is frozen as evidence`,
  );
}

/** An adapter must not throw from decode, but one that does is a failed worker, not a lost finish. */
function decodeSafely(adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  try {
    return adapter.decode(invocation, plan, outputs);
  } catch (error) {
    // The adapter reported nothing; the session known before launch is still named, by runWorker.
    return undecoded([], `The ${adapter.name} adapter could not decode the worker's outputs: ${describeError(error)}`);
  }
}

/**
 * The finish recorded when the launcher, not the worker, failed while
 * settling; the process facts are still true. It writes nothing, so it cannot
 * fail the way settling did: an output never frozen is recorded as the empty
 * blob frozen at launch, and the error names the directory where its process
 * file is kept.
 */
function launcherFailure(result: ProcessResult, error: unknown, known: Known, io: string): Settled {
  const what = known.frozen ? "The launcher could not settle the worker's outputs" : `The launcher could not freeze the worker's outputs, whose process files are kept in ${io}`;
  return {
    finish: {
      outcome: 'failed',
      exitCode: result.exitCode,
      signal: result.signal,
      termination: result.termination,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      usage: null,
      denials: null,
      error: truncate(`${what}: ${describeError(error)}`),
      stdout: known.stdout,
      stderr: known.stderr,
      finalMessage: known.finalMessage,
      output: null,
    },
    observedSessionIds: known.sessionIds,
    usage: null,
    output: null,
    keepProcessFiles: !known.frozen,
  };
}
