import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

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
}

/** How the process ended: on its own, killed at the timeout (with its tree, unless `treeKillError` says why not), or never started. */
export type ProcessResult =
  | {
      readonly termination: 'exited';
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

/** The result for a process that never existed, and why; it ended when the attempt did, `endedAt` by default now. */
export function notStarted(error: string, startedAt: string, endedAt: string = new Date().toISOString()): Extract<ProcessResult, { termination: 'not-started' }> {
  return { termination: 'not-started', exitCode: null, signal: null, error, startedAt, endedAt };
}

/**
 * Run one process to its end, killing it with its whole tree at the
 * timeout (PD2, TD13). On POSIX it is spawned as the leader of its own
 * process group, which the kill addresses; on Windows `taskkill /T` walks
 * the tree. No shell is involved, so no argument is ever reinterpreted.
 *
 * While it runs it is also killed with its tree if the engine exits or,
 * on POSIX, is interrupted by a signal: its own process group keeps a
 * terminal's signals from reaching it, so nothing else would end it.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const descriptors: number[] = [];
  const startedAt = new Date().toISOString();
  try {
    descriptors.push(openSync(request.stdinFile, 'r'));
    descriptors.push(openSync(request.stdoutFile, 'wx'));
    descriptors.push(openSync(request.stderrFile, 'wx'));
    let child: ChildProcess;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        stdio: descriptors,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      // A synchronous refusal, such as an argument Node will not pass: the process never existed.
      return notStarted((error as Error).message, startedAt);
    }
    superviseChild(child);
    return await new Promise<ProcessResult>((resolve) => {
      let started = false;
      let kill: TreeKill | undefined;
      const timer = setTimeout(() => {
        kill = killTreeNow(child);
      }, request.timeoutMs);
      child.once('spawn', () => {
        started = true;
      });
      child.on('error', (error) => {
        // After a successful spawn an error (such as a failed kill) is not the end; 'close' still follows.
        if (started) return;
        clearTimeout(timer);
        resolve(notStarted(error.message, startedAt));
      });
      child.once('close', (code, signal) => {
        if (!started) return;
        clearTimeout(timer);
        const endedAt = new Date().toISOString();
        // A process that exited on its own just as the timer fired was not killed.
        if (kill === undefined || kill.status === 'not-running') resolve({ termination: 'exited', exitCode: code, signal, startedAt, endedAt });
        else resolve({ termination: 'killed', exitCode: code, signal, treeKillError: kill.status === 'root-only' ? kill.error : null, startedAt, endedAt });
      });
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

/** The signals that end a POSIX engine by default and that a detached worker's group never receives. */
const interruptions: readonly NodeJS.Signals[] = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * The processes under supervision that have not closed yet (every worker
 * `runProcess` starts and every preflight probe), and the listeners that
 * kill their trees when the engine ends. The listeners exist only while
 * a process is live, so an idle engine keeps Node's own signal behavior
 * untouched.
 *
 * On Windows no signal listener is needed: Ctrl-C reaches every process
 * on the console, and libuv's job object ends the workers and probes with
 * the engine. The exit listener still runs there, because a descendant that left the
 * job survives the engine unless `taskkill /T` reaches it first.
 *
 * An engine killed outright (SIGKILL, a crash of Node itself) runs no
 * listener; that case cannot be handled from inside the process.
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
function killTreeNow(child: KillableProcess): TreeKill {
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
