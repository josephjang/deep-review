import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GuardEnd } from './kill-marks.ts';

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
      /**
       * How the guard itself ended when it left no result: the exit code
       * or the signal Node reported for it, so an error can say whether a
       * kill ended it or it exited by itself. Absent when the guard left a
       * result, and in a ledger record, which never holds it.
       */
      readonly guardEnd?: GuardEnd;
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

/** Where the guard of `requestFile` writes when its child started, in milliseconds since the epoch: beside the request. */
export const guardStartFile = (requestFile: string): string => `${requestFile}.started`;

/** When the guard's child started, from its start file, or null while the guard has written none it finished. */
function readChildStart(startFile: string): number | null {
  try {
    const at = Number(readFileSync(startFile, 'utf8'));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/** The request a guard reads, checked field by field, since a guard that misread it would run the wrong command. */
export function parseGuardRequest(text: string): GuardRequest {
  const value = JSON.parse(text) as Partial<Record<keyof GuardRequest, unknown>> | null;
  const strings = (field: unknown): field is readonly string[] => Array.isArray(field) && field.every((entry) => typeof entry === 'string');
  if (value === null || typeof value !== 'object' || typeof value.executable !== 'string' || !strings(value.args) || typeof value.cwd !== 'string' || typeof value.stdinFile !== 'string' || typeof value.verbatimArguments !== 'boolean') {
    throw new Error('the guard request does not hold an executable, its arguments, a directory, a standard input file and whether the arguments are verbatim');
  }
  return { executable: value.executable, args: value.args, cwd: value.cwd, stdinFile: value.stdinFile, verbatimArguments: value.verbatimArguments };
}

/**
 * The guard's result, read once its process closed, or null when it left
 * none it could finish: no file, or one that holds no end of its child.
 * The guard writes the file whole through a rename, so only a guard ended
 * mid-write leaves a part of one, under another name; a result read as
 * none is a guard a kill from outside ended, whose child ran, which the
 * caller records as cut rather than as a process that never started.
 */
export function readGuardResult(resultFile: string): GuardResult | null {
  if (!existsSync(resultFile)) return null;
  let value: Partial<GuardResult> | null;
  try {
    value = JSON.parse(readFileSync(resultFile, 'utf8')) as Partial<GuardResult> | null;
  } catch {
    return null;
  }
  if (value?.termination === 'exited' && (typeof value.exitCode === 'number' || value.exitCode === null) && (typeof value.signal === 'string' || value.signal === null)) return { termination: 'exited', exitCode: value.exitCode, signal: value.signal };
  if (value?.termination === 'not-started' && typeof value.error === 'string') return { termination: 'not-started', error: value.error };
  return null;
}

/**
 * The script the guard runs as, which is the engine's own entry. In the
 * bundle every module is `main.mjs`, the entry itself; from the sources
 * this module is `src/runtime/process.ts`, beside `src/cli.ts`. Both
 * dispatch `guard` before they load the command.
 */
const guardEntry = import.meta.filename.endsWith('.ts') ? join(import.meta.dirname, '..', 'cli.ts') : import.meta.filename;

/**
 * How long past its timeout a child's guard may take to write the end of a
 * child that ended by then, before the kill: the guard writes and renames
 * its result only after its child closes, and a child that ended at its
 * deadline is not a timeout. A child still running gets only this more.
 */
const resultGraceMs = 250;

/** How often the result file is looked for during `resultGraceMs`. */
const resultPollMs = 25;

/**
 * Run one process to its end through its guard (R8 of resumable runs,
 * src/runtime/guard.ts), killing it with its whole tree at the timeout
 * (PD2, TD13) once its guard has left no result `resultGraceMs` past it.
 * The timeout counts from the child's start, which the guard writes in its
 * start file (`guardStartFile`), so the guard's own start is not charged
 * to the child. No shell is involved, so no argument is ever reinterpreted.
 *
 * The guard is `node <engine entry> guard <request file>`, detached on both
 * systems: on POSIX it leads a process group, which holds the child and
 * which the kill addresses; on Windows it leaves the job object libuv puts
 * the engine's children in, and `taskkill /T` walks its tree. It holds a
 * pipe from the engine on its standard input and kills the child's tree
 * when that pipe closes, so a child does not outlive an engine killed
 * outright. The end of the child comes from the guard's result file; a
 * guard that left none, and that the engine did not kill, was killed from
 * outside, and the result says so with an exit code and a signal both null,
 * and keeps how the guard itself ended in `guardEnd`, since a guard that
 * crashed or could not load leaves no result either.
 *
 * While it runs it is also killed with its tree if the engine exits or,
 * on POSIX, is interrupted by a signal: its own process group keeps a
 * terminal's signals from reaching it, so nothing else would end it.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const descriptors: number[] = [];
  const startedAt = new Date().toISOString();
  // Absolute, since the guard starts in the engine's directory, not the request's.
  const requestFile = resolve(`${request.stdoutFile}.guard.json`);
  const resultFile = guardResultFile(requestFile);
  const startFile = guardStartFile(requestFile);
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
        // The engine's own directory, so a relative path the environment gives Node, such as a NODE_OPTIONS preload, resolves for the guard as it did for the engine. A missing working directory of the child is its spawn error, which the guard reports.
        cwd: process.cwd(),
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
    return await new Promise<ProcessResult>((resolve) => {
      let started = false;
      let kill: TreeKill | undefined;
      // A result there is a child that ended on its own, and its guard is exiting. Read only before the kill, since `taskkill /T` ends the child before its guard, which may write the child's end in between: that end is the kill's.
      const expire = (graceLeftMs: number): void => {
        if (existsSync(resultFile)) kill = { status: 'not-running' };
        else if (graceLeftMs > 0) timer = setTimeout(() => expire(graceLeftMs - resultPollMs), resultPollMs);
        else kill = killTreeNow(guard);
      };
      // The child's time runs from its own start, which its guard writes once it spawned the child, not from the guard's, which loads Node first. A guard that wrote no start by a whole timeout past the deadline is past its own, and is killed as it stands.
      const guardDeadline = Date.now() + 2 * request.timeoutMs;
      const due = (): void => {
        const childStart = readChildStart(startFile);
        const leftMs = childStart === null ? Math.min(resultPollMs, guardDeadline - Date.now()) : childStart + request.timeoutMs - Date.now();
        if (leftMs > 0) timer = setTimeout(due, leftMs);
        else expire(resultGraceMs);
      };
      let timer = setTimeout(due, request.timeoutMs);
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
        const result = readGuardResult(resultFile);
        // A child that ended on its own just as the timer fired was not killed.
        if (kill !== undefined && kill.status !== 'not-running') resolve({ termination: 'killed', exitCode: code, signal, treeKillError: kill.status === 'root-only' ? kill.error : null, startedAt, endedAt });
        else if (result?.termination === 'exited') resolve({ termination: 'exited', exitCode: result.exitCode, signal: result.signal, startedAt, endedAt });
        else if (result?.termination === 'not-started') resolve(notStarted(result.error, startedAt, endedAt));
        else {
          endLeftGroup(guard.pid!);
          resolve({ termination: 'exited', exitCode: null, signal: null, guardEnd: { exitCode: code, signal }, startedAt, endedAt });
        }
      });
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(requestFile, { force: true });
    rmSync(resultFile, { force: true });
    rmSync(startFile, { force: true });
    // What a guard ended mid-write left of its result or its start.
    rmSync(`${resultFile}.partial`, { force: true });
    rmSync(`${startFile}.partial`, { force: true });
  }
}

/**
 * End what a guard killed from outside left of its process group, so a
 * child it no longer guards does not run beside the rerun (R8 of
 * resumable runs). On POSIX the group's id cannot name another group
 * while any member lives, so the kill reaches only what the guard left.
 * A group with no member left, such as that of a guard that died before
 * its child started, frees its id once the guard is reaped, and a process
 * that has since become a group leader under that id is killed in its
 * place: a window from the reap to this kill, which the design accepts.
 * On Windows the descendants of the child leave the guard's job, and
 * nothing reaches them, which the design accepts too.
 */
function endLeftGroup(guardPid: number): void {
  if (process.platform === 'win32') return;
  // False is ESRCH: no member of the group is left.
  killGroup(guardPid);
}

/**
 * Kill the POSIX process group `pid` leads, and tell whether it could be
 * addressed: false when no member of it is left (ESRCH) or the signal was
 * refused, which each caller answers in its own way.
 */
export function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
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
