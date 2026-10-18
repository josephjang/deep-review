/**
 * Running one check (R9, TD4, TD10 of the fix pass): the repository's
 * command, as one verbatim argument to the platform shell, a child of the
 * engine in the worktree with the workers' build-server pins and the
 * non-interactive ones, stdin at EOF, stdout and stderr streamed to files
 * and frozen as evidence, and its process tree killed at the timeout and
 * when the engine ends, as a worker's is. A check passes by its exit code
 * alone; nothing reads its output (PD8).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceStore, ArtifactReference } from '../../evidence/store.ts';
import { pinVariables, workerEnvironment } from '../../runtime/environment.ts';
import { endedByKill, notStarted, runProcess, type ProcessResult } from '../../runtime/process.ts';
import type { CheckOutcome } from '../vocabulary.ts';

/** How a check that ran ended: its command exited 0, a kill from outside ended it, it exited otherwise, ran past its timeout, or never started. `skipped` is recorded for a check the planner never ran. */
export type RunOutcome = Exclude<CheckOutcome, 'skipped'>;

/** The shell a check runs through, and the arguments that hand it the command. */
export interface ShellInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  /** Whether the arguments go to the process as written, which `cmd.exe /s /c` needs to see its quotes. */
  readonly verbatimArguments: boolean;
}

/**
 * The platform shell's invocation for a command written for a shell (TD4):
 * `cmd.exe /d /s /c "<command>"` on Windows, by absolute path so the
 * caller's PATH cannot substitute another, with no AutoRun commands (`/d`)
 * and the outer quotes stripped as `/s` says; `/bin/sh -c <command>`
 * elsewhere. `shell` names another executable in the same role, which a
 * test uses to reach a shell that cannot start.
 */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform, shell?: string): ShellInvocation {
  if (platform === 'win32') {
    const cmd = shell ?? join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe');
    return { executable: cmd, args: ['/d', '/s', '/c', `"${command}"`], verbatimArguments: true };
  }
  return { executable: shell ?? '/bin/sh', args: ['-c', command], verbatimArguments: false };
}

/**
 * The variables a check runs with beyond the workers' pins (TD10): CI
 * makes test runners such as vitest and jest run once instead of
 * watching, and the rest keep a tool from prompting, colouring its output
 * or asking git for credentials.
 */
export const checkPins: Readonly<Record<string, string>> = {
  CI: 'true',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  TERM: 'dumb',
  GIT_TERMINAL_PROMPT: '0',
};

/** A check's environment: the caller's, with the build-server pins every worker gets, `checkPins` over every spelling the platform reads as theirs, and the directories of `tools.path` first on PATH, as a worker has them (R11, TD10 of the configuration). */
export function checkEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, toolsPath: readonly string[] = []): NodeJS.ProcessEnv {
  return pinVariables(workerEnvironment(environment, null, platform, toolsPath), checkPins, platform);
}

export interface CheckRequest {
  readonly command: string;
  /** The working directory: the worktree under review. */
  readonly worktree: string;
  /** The environment the check inherits before its pins. */
  readonly environment: NodeJS.ProcessEnv;
  /** The directories of `tools.path`, first on the check's PATH; none by default. */
  readonly toolsPath?: readonly string[];
  readonly timeoutMs: number;
  /** A directory that must not exist yet; the check's process files live there until they are frozen, and it is removed after. */
  readonly ioDirectory: string;
  /** Another shell executable, for a test; the platform's by default. */
  readonly shell?: string;
}

/** What one check did, with its output frozen. */
export interface CheckResult {
  readonly outcome: RunOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly termination: ProcessResult['termination'];
  /** Wall-clock start and end, so a suspended machine's gap is visible later. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly stdout: ArtifactReference;
  readonly stderr: ArtifactReference;
  /** Why it never started, why its tree could not all be killed at the timeout, or null. */
  readonly error: string | null;
}

/**
 * The outcome a process result gives a check: 0 after an exit of its own
 * passes; an exit with a kill mark, a signal or a code a shell or Windows
 * gives a process a kill ended, or with no result from its guard, is cut,
 * which has no result of its own and runs again (R4, R8 of resumable
 * runs); any other exit fails. A check the
 * engine killed at its timeout timed out. A kill with no mark, such as
 * `taskkill`'s exit code 1, still reads as a failure, the risk PD5 of
 * resumable runs accepts.
 */
export function checkOutcomeOf(result: ProcessResult): RunOutcome {
  switch (result.termination) {
    case 'not-started':
      return 'not-started';
    case 'killed':
      return 'timeout';
    case 'exited':
      if (result.exitCode === 0 && result.signal === null) return 'passed';
      return endedByKill(result) ? 'cut' : 'failed';
  }
}

/** The error a check records with its outcome: the spawn's failure, a timeout's partial kill, a guard that left no result, or null. */
function checkError(result: ProcessResult, timeoutMs: number): string | null {
  if (result.termination === 'not-started') return result.error;
  if (result.termination === 'killed') {
    return result.treeKillError === null ? null : `The check ran past its timeout of ${String(timeoutMs)} ms and was killed, but only its root: ${result.treeKillError}; descendants may still run`;
  }
  if (result.exitCode === null && result.signal === null) return 'The check ended with no result from its guard: a kill from outside the engine ended the guard';
  return null;
}

/**
 * Run one check to its end and freeze its output. Never throws for what
 * the check did; a failure of the engine's own (a directory it cannot
 * create, evidence it cannot write) is thrown, since nothing was run or
 * nothing can be recorded.
 */
export async function runCheck(evidence: Pick<EvidenceStore, 'put'>, request: CheckRequest): Promise<CheckResult> {
  // Not recursive at the leaf: a directory already there is another check's.
  mkdirSync(join(request.ioDirectory, '..'), { recursive: true });
  mkdirSync(request.ioDirectory);
  // Set when the output could not be frozen: its process files are then the only copy, and stay.
  let keep = false;
  try {
    const stdinFile = join(request.ioDirectory, 'stdin');
    const stdoutFile = join(request.ioDirectory, 'stdout');
    const stderrFile = join(request.ioDirectory, 'stderr');
    // An empty file, so a check that prompts reads end of input instead of waiting.
    writeFileSync(stdinFile, '', { flag: 'wx' });
    const shell = shellInvocation(request.command, process.platform, request.shell);
    let result: ProcessResult;
    try {
      result = await runProcess({
        executable: shell.executable,
        args: shell.args,
        verbatimArguments: shell.verbatimArguments,
        cwd: request.worktree,
        environment: checkEnvironment(request.environment, process.platform, request.toolsPath ?? []),
        stdinFile,
        stdoutFile,
        stderrFile,
        timeoutMs: request.timeoutMs,
      });
    } catch (error) {
      const now = new Date().toISOString();
      result = notStarted(`the engine could not start it: ${(error as Error).message}`, now, now);
    }
    let stdout: ArtifactReference;
    let stderr: ArtifactReference;
    try {
      stdout = evidence.put(readOutput(stdoutFile));
      stderr = evidence.put(readOutput(stderrFile));
    } catch (error) {
      keep = true;
      throw new Error(`The check's output could not be frozen and is kept in ${request.ioDirectory}: ${(error as Error).message}`, { cause: error });
    }
    return {
      outcome: checkOutcomeOf(result),
      exitCode: result.exitCode,
      signal: result.signal,
      termination: result.termination,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      stdout,
      stderr,
      error: checkError(result, request.timeoutMs),
    };
  } finally {
    if (!keep) rmSync(request.ioDirectory, { recursive: true, force: true });
  }
}

/** A process file's bytes, or none when the process never got far enough to have it written. */
function readOutput(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}
