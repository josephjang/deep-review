import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

/** How the process ended: on its own, killed at the timeout with its tree, or never started. */
export type ProcessResult =
  | {
      readonly termination: 'exited' | 'killed';
      readonly exitCode: number | null;
      readonly signal: string | null;
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
 * Run one process to its end, killing it with its whole tree at the
 * timeout (PD2, TD13). On POSIX it is spawned as the leader of its own
 * process group, which the kill addresses; on Windows `taskkill /T` walks
 * the tree. No shell is involved, so no argument is ever reinterpreted.
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
      return { termination: 'not-started', exitCode: null, signal: null, error: (error as Error).message, startedAt, endedAt: new Date().toISOString() };
    }
    return await new Promise<ProcessResult>((resolve) => {
      let started = false;
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        void killTree(child);
      }, request.timeoutMs);
      child.once('spawn', () => {
        started = true;
      });
      child.on('error', (error) => {
        // After a successful spawn an error (such as a failed kill) is not the end; 'close' still follows.
        if (started) return;
        clearTimeout(timer);
        resolve({ termination: 'not-started', exitCode: null, signal: null, error: error.message, startedAt, endedAt: new Date().toISOString() });
      });
      child.once('close', (code, signal) => {
        if (!started) return;
        clearTimeout(timer);
        resolve({ termination: killed ? 'killed' : 'exited', exitCode: code, signal, startedAt, endedAt: new Date().toISOString() });
      });
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

/** The Windows tool that ends a process tree, by absolute path so the caller's PATH cannot substitute another. */
function taskkillPath(): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * Kill a process and every descendant the platform can reach. A process
 * that re-parented itself (Windows) or started its own session (POSIX)
 * escapes, which the design accepts.
 */
export async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync(taskkillPath(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    } catch {
      // taskkill fails when the root has already exited, and when it cannot
      // run at all; the direct kill ends the root in either case, and the
      // close event still arrives.
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    // ESRCH: the group is already gone. Anything else: at least end the root.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
  }
}
