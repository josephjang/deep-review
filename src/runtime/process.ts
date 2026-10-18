import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One worker process: what to run, where, and the files its standard streams are bound to. */
export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Opened as stdin, so a process that never reads its input cannot race a pipe (TD11). */
  readonly stdinFile: string;
  /** Created for stdout; must not exist yet. */
  readonly stdoutFile: string;
  /** Created for stderr; must not exist yet. */
  readonly stderrFile: string;
  readonly timeoutMs: number;
  /**
   * On Windows, pass `args` to the process exactly as given, joined with
   * spaces and without Node's quoting, for an executable that parses its
   * own command line the way `cmd.exe /s /c` does. Ignored elsewhere,
   * where arguments are never joined into one line.
   */
  readonly verbatimArguments?: boolean;
}

/** How the process ended: on its own, killed at the timeout (with its tree, unless `treeKillError` says why not), or never started. */
export type ProcessResult =
  | {
      readonly termination: 'exited';
      /**
       * The exit code, or the signal, the child ended with. Both are null
       * when its guard ended with no result (R8 of resumable runs): a kill
       * from outside the engine ended the guard, and how the child ended is
       * unknown. Node never reports an exit with neither, so the two nulls
       * say it in the ledger too.
       */
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly startedAt: string;
      readonly endedAt: string;
    }
  | {
      readonly termination: 'killed';
      readonly exitCode: number | null;
      readonly signal: string | null;
      /**
       * Null when the kill reached the whole tree. Otherwise why it did not:
       * only the root was ended, and descendants may still be running.
       */
      readonly treeKillError: string | null;
      readonly startedAt: string;
      readonly endedAt: string;
    }
  | {
      readonly termination: 'not-started';
      readonly exitCode: null;
      readonly signal: null;
      /** Why the spawn failed. */
      readonly error: string;
      readonly startedAt: string;
      readonly endedAt: string;
    };

/**
 * The exit codes a kill from outside the engine leaves on a child (R4,
 * PD5, TD4 of resumable runs): 128 plus the number of SIGHUP, SIGINT,
 * SIGQUIT, SIGKILL or SIGTERM, which a shell gives a process that signal
 * ended, and 3221225786, STATUS_CONTROL_C_EXIT, which Windows gives a
 * process Ctrl-C ended. Exit code 1 is no mark: `taskkill` leaves it, and
 * so does a check that fails by itself.
 */
export const killMarkCodes: readonly number[] = [129, 130, 131, 137, 143, 3221225786];

/** The end of a child as a kill mark reads it, live or as the ledger recorded it. */
type ChildEnd = { readonly termination: ProcessResult['termination'] | null; readonly exitCode: number | null; readonly signal: string | null };

/**
 * Whether a child that exited was ended by a kill from outside the engine:
 * a signal, one of `killMarkCodes`, or no result from its guard (R4, R8 of
 * resumable runs). Checks and workers read this one list, so the two
 * cannot disagree on a mark. A child the engine killed at its timeout is no
 * mark: its termination is `killed`.
 */
export function endedByKill(end: ChildEnd): boolean {
  if (end.termination !== 'exited') return false;
  return end.signal !== null || end.exitCode === null || killMarkCodes.includes(end.exitCode);
}

/** How a child a kill from outside ended, as a log line or an error names it: the signal or the exit code it left, or no result from its guard. */
export function killMarkWords(end: ChildEnd): string {
  if (end.signal !== null) return `signal ${end.signal}, a kill mark`;
  if (end.exitCode === null) return 'no result from its guard';
  return `exit code ${String(end.exitCode)}, a kill mark`;
}

/** The result for a process that never existed, and why; it ended when the attempt did, `endedAt` by default now. */
export function notStarted(error: string, startedAt: string, endedAt: string = new Date().toISOString()): Extract<ProcessResult, { termination: 'not-started' }> {
  return { termination: 'not-started', exitCode: null, signal: null, error, startedAt, endedAt };
}

/**
 * Whether a preflight probe is spawned detached. On POSIX it leads a
 * process group of its own, which `killTree` addresses; on Windows it
 * stays attached to the engine's console, so Ctrl-C ends it with the
 * engine. The guard of a worker or a check is detached on both systems
 * (`runProcess`), and so is a synchronous git call on Windows
 * (src/runtime/git-sync.ts says why).
 */
export const detachedChild = process.platform !== 'win32';

/** What the guard of one child runs (src/runtime/guard.ts): the request file `runProcess` writes. */
export interface GuardRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdinFile: string;
  readonly verbatimArguments: boolean;
}

/** How the guard's child ended, as the guard's result file holds it: on its own, or never started. */
export type GuardResult =
  | { readonly termination: 'exited'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly termination: 'not-started'; readonly error: string };

/** Where the guard of `requestFile` writes its result: beside the request. */
export const guardResultFile = (requestFile: string): string => `${requestFile}.result`;

/** The request a guard reads, checked field by field, since a guard that misread it would run the wrong command. */
export function parseGuardRequest(text: string): GuardRequest {
  const value = JSON.parse(text) as Partial<Record<keyof GuardRequest, unknown>> | null;
  const strings = (field: unknown): field is readonly string[] => Array.isArray(field) && field.every((entry) => typeof entry === 'string');
  if (value === null || typeof value !== 'object' || typeof value.executable !== 'string' || !strings(value.args) || typeof value.cwd !== 'string' || typeof value.stdinFile !== 'string' || typeof value.verbatimArguments !== 'boolean') {
    throw new Error('the guard request does not hold an executable, its arguments, a directory, a standard input file and whether the arguments are verbatim');
  }
  return { executable: value.executable, args: value.args, cwd: value.cwd, stdinFile: value.stdinFile, verbatimArguments: value.verbatimArguments };
}

/** The guard's result, read once its process closed, or null when it left none. */
function readGuardResult(resultFile: string): GuardResult | null {
  if (!existsSync(resultFile)) return null;
  const value = JSON.parse(readFileSync(resultFile, 'utf8')) as Partial<GuardResult> | null;
  if (value?.termination === 'exited') return { termination: 'exited', exitCode: value.exitCode ?? null, signal: value.signal ?? null };
  if (value?.termination === 'not-started' && typeof value.error === 'string') return { termination: 'not-started', error: value.error };
  throw new Error(`The guard's result file ${resultFile} holds no end of its child`);
}

/**
 * The script the guard runs as, which is the engine's own entry. In the
 * bundle every module is `main.mjs`, the entry itself; from the sources
 * this module is `src/runtime/process.ts`, beside `src/cli.ts`. Both
 * dispatch `guard` before they load the command.
 */
const guardEntry = import.meta.filename.endsWith('.ts') ? join(import.meta.dirname, '..', 'cli.ts') : import.meta.filename;

/**
 * Run one process to its end through its guard (R8 of resumable runs,
 * src/runtime/guard.ts), killing it with its whole tree at the timeout
 * (PD2, TD13). No shell is involved, so no argument is ever reinterpreted.
 *
 * The guard is `node <engine entry> guard <request file>`, detached on both
 * systems: on POSIX it leads a process group, which holds the child and
 * which the kill addresses; on Windows it leaves the job object libuv puts
 * the engine's children in, and `taskkill /T` walks its tree. It holds a
 * pipe from the engine on its standard input and kills the child's tree
 * when that pipe closes, so a child does not outlive an engine killed
 * outright. The end of the child comes from the guard's result file; a
 * guard that left none, and that the engine did not kill, was killed from
 * outside, and the result says so with an exit code and a signal both null.
 *
 * While it runs it is also killed with its tree if the engine exits or,
 * on POSIX, is interrupted by a signal: its own process group keeps a
 * terminal's signals from reaching it, so nothing else would end it.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const descriptors: number[] = [];
  const startedAt = new Date().toISOString();
  const requestFile = `${request.stdoutFile}.guard.json`;
  const resultFile = guardResultFile(requestFile);
  try {
    // The guard opens the input; this fails as before when it is missing, and before an output file exists.
    closeSync(openSync(request.stdinFile, 'r'));
    descriptors.push(openSync(request.stdoutFile, 'wx'));
    descriptors.push(openSync(request.stderrFile, 'wx'));
    const guarded: GuardRequest = { executable: request.executable, args: request.args, cwd: request.cwd, stdinFile: request.stdinFile, verbatimArguments: request.verbatimArguments === true };
    writeFileSync(requestFile, JSON.stringify(guarded), { flag: 'wx' });
    let guard: ChildProcess;
    try {
      guard = spawn(process.execPath, [guardEntry, 'guard', requestFile], {
        // The request's directory exists, so a missing working directory is the child's spawn error, which the guard reports.
        cwd: dirname(requestFile),
        env: request.environment,
        stdio: ['pipe', descriptors[0]!, descriptors[1]!],
        shell: false,
        windowsHide: true,
        detached: true,
      });
    } catch (error) {
      // A synchronous refusal: the guard never existed, and neither did the process.
      return notStarted((error as Error).message, startedAt);
    }
    superviseChild(guard);
    return await new Promise<ProcessResult>((resolve, reject) => {
      let started = false;
      let kill: TreeKill | undefined;
      const timer = setTimeout(() => {
        kill = killTreeNow(guard);
      }, request.timeoutMs);
      guard.once('spawn', () => {
        started = true;
      });
      guard.on('error', (error) => {
        // After a successful spawn an error (such as a failed kill) is not the end; 'close' still follows.
        if (started) return;
        clearTimeout(timer);
        resolve(notStarted(`the guard did not start: ${error.message}`, startedAt));
      });
      // The pipe's own end is not the guard's: an error on it changes nothing the guard reports.
      guard.stdin?.on('error', () => {});
      guard.once('close', (code, signal) => {
        if (!started) return;
        clearTimeout(timer);
        guard.stdin?.destroy();
        const endedAt = new Date().toISOString();
        let result: GuardResult | null;
        try {
          result = readGuardResult(resultFile);
        } catch (error) {
          // A result the guard wrote whole but the engine cannot read is the engine's own fault, as an output file it cannot open is.
          reject(error as Error);
          return;
        }
        // A child that ended on its own just as the timer fired was not killed.
        if (result?.termination === 'exited') resolve({ termination: 'exited', exitCode: result.exitCode, signal: result.signal, startedAt, endedAt });
        else if (result?.termination === 'not-started') resolve(notStarted(result.error, startedAt, endedAt));
        else if (kill !== undefined && kill.status !== 'not-running') resolve({ termination: 'killed', exitCode: code, signal, treeKillError: kill.status === 'root-only' ? kill.error : null, startedAt, endedAt });
        else {
          endLeftGroup(guard.pid!);
          resolve({ termination: 'exited', exitCode: null, signal: null, startedAt, endedAt });
        }
      });
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(requestFile, { force: true });
    rmSync(resultFile, { force: true });
  }
}

/**
 * End what a guard killed from outside left of its process group, so a
 * child it no longer guards does not run beside the rerun (R8 of
 * resumable runs). On POSIX the group's id cannot name another group
 * while any member lives, so the kill is safe after the guard is reaped;
 * no group is no member left. On Windows the descendants of the child
 * leave the guard's job, and nothing reaches them, which the design
 * accepts.
 */
function endLeftGroup(guardPid: number): void {
  if (process.platform === 'win32') return;
  try {
    process.kill(-guardPid, 'SIGKILL');
  } catch {
    // ESRCH: no member of the group is left.
  }
}

/** The signals that end a POSIX engine by default and that a detached worker's group never receives. */
const interruptions: readonly NodeJS.Signals[] = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * The processes under supervision that have not closed yet (the guard of
 * every worker and check `runProcess` starts, and every preflight probe),
 * and the listeners that kill their trees when the engine ends. The
 * listeners exist only while a process is live, so an idle engine keeps
 * Node's own signal behavior untouched.
 *
 * On Windows no signal listener is needed: Ctrl-C reaches the engine and
 * every probe on the console, and libuv's job object ends the probes with
 * the engine. A guard has no console and is in no job of the engine's, so
 * Ctrl-C reaches none, and the guard ends its child when the engine's
 * pipe closes. The exit listener still runs there, because a descendant
 * that left the job survives the engine unless `taskkill /T` reaches it
 * first.
 *
 * An engine killed outright (SIGKILL, a crash of Node itself) runs no
 * listener; that case cannot be handled from inside the process, and the
 * guard of each child handles it (R8 of resumable runs). A probe has no
 * guard and may outlive it.
 */
class LiveProcesses {
  readonly #children = new Set<ChildProcess>();
  #listening = false;

  track(child: ChildProcess): void {
    this.#children.add(child);
    if (!this.#listening) this.#listen(true);
  }

  untrack(child: ChildProcess): void {
    this.#children.delete(child);
    if (this.#children.size === 0 && this.#listening) this.#listen(false);
  }

  #killAll(): void {
    for (const child of this.#children) killTreeNow(child);
  }

  readonly #onExit = (): void => {
    this.#killAll();
  };

  readonly #onSignal = (signal: NodeJS.Signals): void => {
    this.#killAll();
    // Alone on this signal, the listener has displaced Node's default of
    // ending the process by it: stop listening, which restores that
    // default, and raise the signal again so the engine ends exactly as it
    // would have. Another listener owns the ending otherwise.
    if (process.listenerCount(signal) === 1) {
      this.#listen(false);
      process.kill(process.pid, signal);
    }
  };

  #listen(on: boolean): void {
    this.#listening = on;
    if (on) {
      process.on('exit', this.#onExit);
      for (const signal of interruptions) process.on(signal, this.#onSignal);
    } else {
      process.off('exit', this.#onExit);
      for (const signal of interruptions) process.off(signal, this.#onSignal);
    }
  }
}

const live = new LiveProcesses();

/**
 * Count `child` among the live processes whose trees the engine kills if it
 * exits or, on POSIX, is interrupted, until it closes or turns out never to
 * have started. `runProcess` does this for every worker; a process started
 * elsewhere, such as a preflight probe, calls it right after its spawn.
 */
export function superviseChild(child: ChildProcess): void {
  live.track(child);
  const release = (): void => {
    live.untrack(child);
  };
  child.once('close', release);
  child.once('error', () => {
    // After a successful spawn an error (a failed kill) is not the end; 'close' still follows.
    if (child.pid === undefined) release();
  });
}

/** What a tree kill did. */
export type TreeKill =
  /** The process never started or has already exited; nothing was signalled. */
  | { readonly status: 'not-running' }
  /** The process and every descendant the platform can reach were killed. */
  | { readonly status: 'tree' }
  /** The tree kill failed, for the reason given; only the root was killed directly. */
  | { readonly status: 'root-only'; readonly error: string };

/** What a tree kill needs of a child process. */
export type KillableProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;

/** The Windows tool that ends a process tree, by absolute path so the caller's PATH cannot substitute another. */
function taskkillPath(): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * Kill a process and every descendant the platform can reach. A process
 * that re-parented itself (Windows) or started its own session (POSIX)
 * escapes, which the design accepts.
 *
 * The kill is done before this returns, as `killTreeNow` does it; the
 * promise only lets a caller sequence work after it.
 */
export function killTree(child: KillableProcess): Promise<TreeKill> {
  return Promise.resolve(killTreeNow(child));
}

/**
 * `killTree`, synchronously, for the timeout and for the engine's exit and
 * signal listeners, none of which can wait.
 *
 * A pid is only safe to signal while Node has not yet seen the process
 * exit: until then Node holds it (an unreaped zombie on POSIX, an open
 * process handle on Windows), so the pid cannot name another process.
 * Once `exitCode` or `signalCode` is set that guarantee is gone, and
 * nothing is signalled. The kill is synchronous, `taskkill` included, so
 * the event loop cannot observe the exit and release the pid between that
 * check and the kill; the price is that the loop waits for `taskkill`,
 * at most its ten-second limit.
 */
export function killTreeNow(child: KillableProcess): TreeKill {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return { status: 'not-running' };
  if (process.platform === 'win32') {
    const taskkill = spawnSync(taskkillPath(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
    if (taskkill.error === undefined && taskkill.status === 0) return { status: 'tree' };
    // taskkill could not run, or could not end every process in the tree
    // (such as a descendant running as another user: access denied).
    const how = taskkill.status === null ? `signal ${String(taskkill.signal)}` : `code ${String(taskkill.status)}`;
    const reason = taskkill.error?.message ?? `it exited with ${how}: ${taskkill.stderr.trim()}`;
    return killRoot(child, `taskkill could not end the process tree: ${reason}`);
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return { status: 'tree' };
  } catch (error) {
    // The unreaped root keeps its group alive, so any failure here, ESRCH
    // included, means the group could not be addressed.
    return killRoot(child, `the process group could not be killed: ${(error as Error).message}`);
  }
}

/** The fallback when the tree cannot be reached: end at least the root, and say why the tree was not. */
function killRoot(child: KillableProcess, error: string): TreeKill {
  child.kill('SIGKILL');
  return { status: 'root-only', error };
}
