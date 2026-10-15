import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithBufferEncoding, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** How long a detached git call may run before it is ended, unless the caller gives its own `timeout`. */
export const gitTimeoutMs = 60_000;

/** The options the runner receives: the caller's, with the console settings `runGitSync` adds and, for a detached git, its timeout. */
export type GitSyncSpawnOptions = ExecFileSyncOptions & { readonly windowsHide: true; readonly detached: boolean };

/** What starts the child and waits for it: `execFileSync`, or a stand-in in a test. */
export type GitSyncRunner = (file: string, args: readonly string[], options: GitSyncSpawnOptions) => string | Buffer;

/** What `runGitSync` runs with; a test replaces part of it. */
export interface GitSyncHost {
  readonly run: GitSyncRunner;
  readonly platform: NodeJS.Platform;
  /** The program to start: the git `installedGit` names unless given, or another program in a test of the timeout. */
  readonly file: string;
}

/**
 * A Windows path that names its drive or share. `win32.isAbsolute` also
 * accepts a path rooted on no drive, such as the `/usr/lib/git-core` an
 * MSYS2 or Cygwin git prints, which resolves against the drive of the cwd.
 */
const onDriveOrShare = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

/**
 * The git binary itself, by its absolute path, as the git on PATH names it:
 * `git.exe` in the directory `git --exec-path` prints, or plain `git` when
 * that directory names no drive or share, holds no `git.exe`, or git cannot
 * be run. The fallback starts git as before, so a failure to run it
 * surfaces in the call that needed it, not here.
 *
 * On Windows the git on PATH is usually a launcher: Git for Windows puts
 * `cmd\git.exe` on PATH (`bin\git.exe` on the hosted CI runner), a small
 * program that starts the real binary (`mingw64\bin\git.exe` in Git for
 * Windows 2.55) and waits for it. The real binary sets up the environment
 * the launcher would (MSYSTEM, whose value depends on the release, HOME,
 * PLINK_PROTOCOL, and its own `bin` directory and `usr\bin` on PATH), which
 * test/runtime/git-sync.test.ts checks; the exec path holds a copy of it,
 * and asking git for that directory works through any launcher or shim.
 */
export function realGit(run: GitSyncRunner = execFileSync, exists: (path: string) => boolean = existsSync): string {
  let execPath: string;
  try {
    // Through runGitSync with git named, so the git on PATH is asked with the console settings of every other call.
    execPath = runGitSync(['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: gitTimeoutMs }, { run, file: 'git' }).trim();
  } catch {
    return 'git';
  }
  if (!onDriveOrShare.test(execPath)) return 'git';
  const binary = win32.join(execPath, 'git.exe');
  return exists(binary) ? binary : 'git';
}

/**
 * A function that names the git `runGitSync` starts on `platform`: the
 * real binary on Windows, which `resolve` finds on the first call that
 * asks for it and the function keeps, and `git` from PATH elsewhere,
 * resolving nothing.
 */
export function gitLocator(resolve: () => string = realGit): (platform?: NodeJS.Platform) => string {
  let resolved: string | undefined;
  return (platform = process.platform) => {
    if (platform !== 'win32') return 'git';
    resolved ??= resolve();
    return resolved;
  };
}

/** The git `runGitSync` starts on `platform`, by `gitLocator`: on Windows the real binary, resolved once per process. */
export const installedGit = gitLocator();

/**
 * Run git synchronously with `args` and the caller's options, and return
 * what `execFileSync` returns; a non-zero exit throws its error, with
 * `status`, `stdout` and `stderr`, as `execFileSync` does. Every
 * synchronous git call of the engine and of the test helpers starts here.
 *
 * On Windows the real git binary (`installedGit`) is started detached, so
 * it has no console. A console process started with a hidden window still
 * gets a console host (`conhost.exe`) of its own, and the launcher Git for
 * Windows puts on PATH is a second process in front of git: three
 * processes per call where one does, at about 40 ms a call where one takes
 * 16 (docs/reports/2026-10-14-test-and-ci-time.md, lever E, and the change
 * proposal of 2026-10-15). A git found on PATH, when the real one could not
 * be resolved, may be such a launcher, which starts git in a console of
 * its own when it has none and is slower detached, so it is started
 * attached as before.
 *
 * Workers and probes stay attached on Windows (`src/runtime/process.ts`).
 * An attached child is in libuv's job object, which ends it when the
 * engine exits. A worker, whose stdio is the files the engine opened, also
 * shares the engine's console and so gets Ctrl-C; a child with piped
 * stdio, such as a probe or a git found on PATH, has a hidden console host
 * of its own, which Ctrl-C does not reach. A synchronous git call ends in
 * milliseconds and the engine waits for it, so it needs neither the job
 * object nor a console; elsewhere it stays in the engine's process group,
 * where a terminal's signals reach it.
 *
 * Node documents `detached` for `spawn` only, but `execFileSync` and
 * `spawnSync` pass it through the same option normalizer to the same libuv
 * spawn, which maps it to `DETACHED_PROCESS`. test/runtime/git-sync.test.ts
 * checks that a child started here has no console host, so a Node release
 * that stops passing it through fails there.
 *
 * What a detached child loses is the job object: libuv puts no detached
 * child in it, so a git still running when the engine exits outlives it.
 * The timeout bounds that for git itself: a detached git that waits on a
 * lock or a remote is ended with `TerminateProcess` after `gitTimeoutMs`,
 * console or not. An attached git, which the job object ends with the
 * engine on Windows and which a terminal's signals reach elsewhere, runs
 * unbounded as before, so a long capture of a large scope still finishes.
 * A caller's own `timeout` holds either way, and ends git with SIGTERM
 * outside Windows. A git ended at a timeout makes the call throw with
 * `status` null, `signal` 'SIGTERM', `code` 'ETIMEDOUT' and the stderr git
 * wrote so far.
 * The timeout ends git alone: a hook, filter or credential helper git
 * started keeps running on its own. `TerminateProcess` runs none of git's
 * cleanup either, so a git that writes, such as `update-ref` or `reset`,
 * can leave its `index.lock` or `<ref>.lock` behind, and every later git
 * that needs that lock fails with "File exists" until the user removes it
 * by hand. Nothing here removes it, since a lock the killed git left
 * cannot be told from one another git holds in the same repository.
 */
export function runGitSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding, host?: Partial<GitSyncHost>): string;
export function runGitSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding, host?: Partial<GitSyncHost>): Buffer;
export function runGitSync(args: readonly string[], options: ExecFileSyncOptions = {}, host: Partial<GitSyncHost> = {}): string | Buffer {
  const run = host.run ?? execFileSync;
  const platform = host.platform ?? process.platform;
  const file = host.file ?? installedGit(platform);
  // Only a program named by its absolute path is detached: a bare name is looked up on PATH, where git may be a launcher.
  const detached = platform === 'win32' && win32.isAbsolute(file);
  const timeout = options.timeout ?? (detached ? gitTimeoutMs : undefined);
  return run(file, args, { ...options, windowsHide: true, detached, ...(timeout === undefined ? {} : { timeout }) });
}

/** Whether `error`, as `runGitSync` threw it, is that of a git ended at its timeout, not of one that exited non-zero or failed to start. */
export function gitTimedOut(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'ETIMEDOUT';
}

/**
 * What a caller reports after the git command for the `error`
 * `runGitSync` threw: for a git ended at its `timeout`, that it timed out,
 * then any stderr it wrote before, which would otherwise hide the timeout;
 * else git's stderr, or the runner's own message when git wrote none, as
 * for a failed spawn.
 */
export function gitFailureDetail(error: unknown, timeout = gitTimeoutMs): string {
  const failure = error as { stderr?: string | Buffer; message: string };
  const stderr = (typeof failure.stderr === 'string' ? failure.stderr : (failure.stderr?.toString('utf8') ?? '')).trim();
  if (gitTimedOut(error)) return `timed out after ${timeout / 1000} s and was ended${stderr === '' ? '' : `: ${stderr}`}`;
  return stderr || failure.message;
}
