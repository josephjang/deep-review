import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithBufferEncoding, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** How long a synchronous git call may run before it is ended, unless the caller gives its own `timeout`. */
export const gitTimeoutMs = 60_000;

/** The options the runner receives: the caller's, with the console and timeout settings `runGitSync` adds. */
export type GitSyncSpawnOptions = ExecFileSyncOptions & { readonly windowsHide: true; readonly detached: boolean; readonly timeout: number };

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
 * The git binary itself, by its absolute path, as the git on PATH names it:
 * `git.exe` in the directory `git --exec-path` prints, or plain `git` when
 * that directory holds none or git cannot be run. The fallback starts git as
 * before, so a failure to run it surfaces in the call that needed it, not
 * here.
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
  if (!win32.isAbsolute(execPath)) return 'git';
  const binary = win32.join(execPath, 'git.exe');
  return exists(binary) ? binary : 'git';
}

let resolvedGit: string | undefined;

/** The git `runGitSync` starts on `platform`: the real binary on Windows, resolved once per process, and `git` from PATH elsewhere. */
export function installedGit(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'git';
  resolvedGit ??= realGit();
  return resolvedGit;
}

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
 * Workers and probes stay attached to the console on Windows
 * (`src/runtime/process.ts`), because Ctrl-C reaches every process of the
 * console and so ends them with the engine. A synchronous git call ends in
 * milliseconds and the engine waits for it, so it needs no console of its
 * own; elsewhere it stays in the engine's process group, where a
 * terminal's signals reach it.
 *
 * Node documents `detached` for `spawn` only, but `execFileSync` and
 * `spawnSync` pass it through the same option normalizer to the same libuv
 * spawn, which maps it to `DETACHED_PROCESS`. test/runtime/git-sync.test.ts
 * checks that a child started here has no console host, so a Node release
 * that stops passing it through fails there.
 *
 * A detached child is the root of a new process group, which Ctrl-C does
 * not reach. The timeout stands in for it: a git that waits on a lock or a
 * remote is ended with `TerminateProcess` (SIGTERM elsewhere) after
 * `gitTimeoutMs`, console or not, and the call throws with `status` null,
 * `signal` 'SIGTERM', `code` 'ETIMEDOUT' and the stderr git wrote so far.
 */
export function runGitSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding, host?: Partial<GitSyncHost>): string;
export function runGitSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding, host?: Partial<GitSyncHost>): Buffer;
export function runGitSync(args: readonly string[], options: ExecFileSyncOptions = {}, host: Partial<GitSyncHost> = {}): string | Buffer {
  const run = host.run ?? execFileSync;
  const platform = host.platform ?? process.platform;
  const file = host.file ?? installedGit(platform);
  // Only a program named by its absolute path is detached: a bare name is looked up on PATH, where git may be a launcher.
  const detached = platform === 'win32' && win32.isAbsolute(file);
  return run(file, args, { ...options, windowsHide: true, detached, timeout: options.timeout ?? gitTimeoutMs });
}
