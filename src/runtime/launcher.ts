import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Checkpoint, NewEvent } from '../checkpoint/checkpoint.ts';
import { RunClosedError, StaleRevisionError } from '../checkpoint/errors.ts';
import { sessionIdSchema, type DeniedTool, type WorkerFinish, type WorkerLaunch, type WorkerOutcome } from '../checkpoint/events.ts';
import type { RunState, WorkerState } from '../checkpoint/fold.ts';
import { sha256Hex, type ArtifactReference } from '../evidence/store.ts';
import type { Decoded, LaunchPlan, RuntimeAdapter, WorkerOutputs } from './adapter.ts';
import { compileOutputSchema, parseInvocation, type Invocation, type InvocationInput } from './contract.ts';
import { workerEnvironment } from './environment.ts';
import { InvalidInvocationError, UnsupportedCapabilityError } from './errors.ts';
import { preflight } from './preflight.ts';
import { notStarted, runProcess, type ProcessResult } from './process.ts';
import type { RuntimeRegistry } from './registry.ts';
import { defaultRuntimes } from './runtimes.ts';
import { checkpointScratchKey, chooseScratch, defaultScratchRoot } from './scratch.ts';

/** stdout, stderr or a final message above this is not decoded; it is still frozen as evidence. */
export const maxDecodeBytes = 16 * 1024 * 1024;

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
  if (scratch !== null) mkdirSync(scratch, { recursive: true });
  mkdirSync(io, { recursive: true });
  const stdinFile = join(io, 'prompt');
  writeFileSync(stdinFile, prompt, { flag: 'wx' });
  writeFileSync(plan.schemaFile, schema.text, { flag: 'wx' });

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
  try {
    appendFresh(checkpoint, runId, { kind: 'worker.launched', version: 1, payload: launch }, (fresh) => {
      // Another launcher may have continued the same session since the first fold.
      if (invocation.resume !== undefined) continuedWorker(fresh, invocation, schemaDigest);
    });
  } catch (error) {
    // Nothing will run: the process files have no use. The frozen prompt and schema stay, unreferenced.
    rmSync(io, { recursive: true, force: true });
    throw error;
  }

  // From here on a finish is appended whatever fails: the launcher's own
  // failures (a full disk, a vanished directory) are recorded with what is
  // known rather than leaving the launch open.
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
    result = notStarted(`the launcher could not start it: ${(error as Error).message}`, now, now);
  }
  let settled: Settled;
  try {
    settled = settle(checkpoint, adapter, invocation, plan, result, io);
  } catch (error) {
    settled = launcherFailure(checkpoint, plan, result, error);
  }
  const finish: WorkerFinish = { workerId, ...settled.finish };
  appendFresh(checkpoint, runId, { kind: 'worker.finished', version: 1, payload: finish });
  rmSync(io, { recursive: true, force: true });

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

/** The real preflight, against the caller's environment. */
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

/**
 * The finished worker whose session the invocation continues (R9). The
 * session must be one a worker of this run ran under, no worker may still
 * be running in it, and the continuation keeps that worker's runtime,
 * model, effort, permissions and schema. The budget and timeout are the
 * continuation's own: it is a new process with its own spend.
 */
function continuedWorker(state: RunState, invocation: Invocation, schemaDigest: string): Extract<WorkerState, { status: 'finished' }> {
  const session = invocation.resume!;
  const inSession = Object.values(state.workers).filter(
    (worker) => worker.launch.sessionId === session || (worker.status === 'finished' && worker.finish.sessionIds.includes(session)),
  );
  if (inSession.length === 0) throw new InvalidInvocationError(`No worker of run ${state.id} ran session ${session}, so there is nothing to continue`);
  const running = inSession.find((worker) => worker.status === 'running');
  if (running !== undefined) throw new InvalidInvocationError(`Worker ${running.launch.workerId} is still running in session ${session}; continue it after it finishes`);
  // Workers fold in ledger order, so the last one is the latest word in the session.
  const previous = inSession.at(-1) as Extract<WorkerState, { status: 'finished' }>;
  const kept: [string, unknown, unknown][] = [
    ['runtime', previous.launch.runtime, invocation.runtime],
    ['model', previous.launch.model, invocation.model],
    ['effort', previous.launch.effort, invocation.effort],
    ['access', previous.launch.access, invocation.access],
    ['shell', previous.launch.shell, invocation.shell],
    ['output schema digest', previous.launch.schema.sha256, schemaDigest],
  ];
  for (const [field, before, now] of kept) {
    if (before !== now) throw new InvalidInvocationError(`A continuation of session ${session} must keep its ${field}: it was ${String(before)}, the invocation has ${String(now)}`);
  }
  if (invocation.scratch !== undefined && invocation.scratch !== previous.launch.scratch) {
    throw new InvalidInvocationError(`A continuation of session ${session} keeps its scratch directory ${String(previous.launch.scratch)}`);
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

/** A finish without its worker id, and what only the receipt carries. */
interface Settled {
  readonly finish: Omit<WorkerFinish, 'workerId'>;
  readonly usage: unknown;
  readonly output: unknown;
}

/** Read a process file, or null when it was never written. */
function readIfPresent(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

const truncate = (error: string): string => (error.length <= maxErrorLength ? error : `${error.slice(0, maxErrorLength)} [truncated]`);

const usageText = (usage: unknown): string | null => (usage === null || usage === undefined ? null : (JSON.stringify(usage) ?? null));

/** Freeze every output, decode it through the adapter, and decide the outcome (R5, TD5). */
function settle(checkpoint: Checkpoint, adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, result: ProcessResult, io: string): Settled {
  const stdout = readIfPresent(join(io, 'stdout')) ?? Buffer.alloc(0);
  const stderr = readIfPresent(join(io, 'stderr')) ?? Buffer.alloc(0);
  const finalMessage = readIfPresent(plan.finalMessageFile);
  const references = {
    stdout: checkpoint.evidence.put(stdout),
    stderr: checkpoint.evidence.put(stderr),
    finalMessage: finalMessage === null ? null : checkpoint.evidence.put(finalMessage),
  };

  const oversized = (
    [
      ['stdout', stdout],
      ['stderr', stderr],
      ['final message', finalMessage],
    ] as const
  ).find(([, bytes]) => bytes !== null && bytes.length > maxDecodeBytes);
  const decoded: Decoded =
    oversized === undefined
      ? decodeSafely(adapter, invocation, plan, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), finalMessage: finalMessage?.toString('utf8') ?? null })
      : {
          sessionIds: plan.sessionId === null ? [] : [plan.sessionId],
          usage: null,
          denials: null,
          answer: null,
          budgetStop: false,
          error: `The worker's ${oversized[0]} is ${String(oversized[1]!.length)} bytes, above the ${String(maxDecodeBytes)} bytes the launcher decodes; it is frozen as evidence`,
        };

  // A runtime may print anything as a session id; only what the ledger can hold is kept, and the rest is named.
  const sessionIds = decoded.sessionIds.filter((id) => sessionIdSchema.safeParse(id).success);
  const strange = decoded.sessionIds.filter((id) => !sessionIdSchema.safeParse(id).success);

  let outcome: WorkerOutcome;
  let error: string | null;
  let output: unknown = null;
  if (result.termination === 'not-started') [outcome, error] = ['failed', `The worker did not start: ${result.error}`];
  else if (result.termination === 'killed') {
    const how = result.treeKillError === null ? 'was killed with its process tree' : `was killed, but only its root: ${result.treeKillError}; descendants may still run`;
    [outcome, error] = ['timeout', `The worker ran past its timeout of ${String(invocation.timeoutMs)} ms and ${how}`];
  }
  else if (decoded.budgetStop) [outcome, error] = ['budget', decoded.error ?? 'The runtime stopped at its budget'];
  else if (decoded.error !== null) [outcome, error] = ['failed', decoded.error];
  else if (result.exitCode !== 0 || result.signal !== null) {
    [outcome, error] = ['failed', result.signal !== null ? `The worker was ended by signal ${result.signal}` : `The worker exited with code ${String(result.exitCode)}`];
  } else if (decoded.answer === null) [outcome, error] = ['failed', 'The runtime reported no error and no answer'];
  else {
    const validated = invocation.outputSchema.safeParse(decoded.answer.value);
    if (validated.success) [outcome, error, output] = ['completed', null, validated.data];
    else [outcome, error] = ['failed', `The answer does not match the output schema: ${z.prettifyError(validated.error)}`];
  }

  if (strange.length > 0) {
    const note = `the runtime reported session ids the ledger cannot hold: ${JSON.stringify(strange).slice(0, 500)}`;
    if (outcome === 'completed') [outcome, error, output] = ['failed', `The answer is not recorded because ${note}`, null];
    else error = `${error ?? ''}; ${note}`;
  }

  const outputJson = outcome === 'completed' ? JSON.stringify(output) : undefined;
  return {
    finish: {
      outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      termination: result.termination,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      sessionIds,
      usage: usageText(decoded.usage),
      denials: decoded.denials === null ? null : [...decoded.denials],
      error: error === null ? null : truncate(error),
      ...references,
      output: outputJson === undefined ? null : checkpoint.evidence.put(outputJson),
    },
    usage: decoded.usage ?? null,
    output: outcome === 'completed' ? output : null,
  };
}

/** An adapter must not throw from decode, but one that does is a failed worker, not a lost finish. */
function decodeSafely(adapter: RuntimeAdapter, invocation: Invocation, plan: LaunchPlan, outputs: WorkerOutputs): Decoded {
  try {
    return adapter.decode(invocation, plan, outputs);
  } catch (error) {
    return {
      sessionIds: plan.sessionId === null ? [] : [plan.sessionId],
      usage: null,
      denials: null,
      answer: null,
      budgetStop: false,
      error: `The ${adapter.name} adapter could not decode the worker's outputs: ${(error as Error).message}`,
    };
  }
}

/** The finish recorded when the launcher, not the worker, failed to read or freeze the outputs; the process facts are still true. */
function launcherFailure(checkpoint: Checkpoint, plan: LaunchPlan, result: ProcessResult, error: unknown): Settled {
  const empty = checkpoint.evidence.put('');
  return {
    finish: {
      outcome: 'failed',
      exitCode: result.exitCode,
      signal: result.signal,
      termination: result.termination,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      sessionIds: plan.sessionId === null ? [] : [plan.sessionId],
      usage: null,
      denials: null,
      error: truncate(`The launcher could not read or freeze the worker's outputs: ${error instanceof Error ? error.message : String(error)}`),
      stdout: empty,
      stderr: empty,
      finalMessage: null,
      output: null,
    },
    usage: null,
    output: null,
  };
}
