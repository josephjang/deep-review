// What the fake runtime CLIs share. A fake is run as `node fake-<runtime>.ts
// <args>`, so the launcher spawns it exactly as it spawns a real CLI, and
// is steered by environment variables the test sets:
//   FAKE_VERSION     version output instead of the runtime's usual one
//   FAKE_HELP_OMIT   a flag to leave out of every help text
//   FAKE_RECORD      file to write what the fake received as JSON
//   FAKE_WAIT_FOR    file to wait for before answering
//   FAKE_STDOUT      stdout to print instead of a successful answer; {session} becomes the session id
//   FAKE_STDERR      stderr to print
//   FAKE_EXIT        exit code
//   FAKE_HUGE        print this many bytes to stdout instead of an answer
//   FAKE_HANG        start a grandchild, write its pid to this file, and never exit
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const environment = process.env;

/** The thread id fake-codex.ts reports for a fresh worker, unless FAKE_THREAD names another. */
export const freshThread = '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

/** Print a help text listing every flag but FAKE_HELP_OMIT. */
export function printHelp(flags: readonly string[]): void {
  const omit = environment.FAKE_HELP_OMIT;
  process.stdout.write(`Usage: fake [options]\n\nOptions:\n${flags.filter((flag) => flag !== omit).map((flag) => `  ${flag} <value>  a flag\n`).join('')}`);
}

/** Write a file whole, under a temporary name and then renamed, so a polling test never reads it empty or half written. */
function writeWhole(file: string, text: string): void {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Write what the fake was given, for the test to assert on. */
export function record(argv: readonly string[], stdin: string): void {
  const file = environment.FAKE_RECORD;
  if (file === undefined) return;
  const pinned = ['TEMP', 'TMP', 'TMPDIR', 'MSBUILDDISABLENODEREUSE', 'DOTNET_CLI_USE_MSBUILD_SERVER', 'UseSharedCompilation', 'UseRazorBuildServer', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'Path', 'PATH'];
  const seen = Object.fromEntries(Object.entries(process.env).filter(([name]) => pinned.some((pin) => pin.toUpperCase() === name.toUpperCase())));
  writeWhole(file, JSON.stringify({ argv, stdin, cwd: process.cwd(), environment: seen }));
}

/** Block until the marker file exists. */
export async function waitForMarker(): Promise<void> {
  const marker = environment.FAKE_WAIT_FOR;
  if (marker === undefined) return;
  while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Start a grandchild that never exits, write its pid, and never exit either.
 * On Windows the grandchild is detached: libuv otherwise puts it in a job
 * that dies with the fake, so it would die even if the launcher killed only
 * the fake, and the test could not tell a tree kill from a root kill. On
 * POSIX it stays in the fake's process group, which is what the launcher kills.
 */
export function hangWithGrandchild(pidFile: string): void {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  if (grandchild.pid === undefined) throw new Error('The grandchild did not start');
  writeWhole(pidFile, String(grandchild.pid));
  setInterval(() => {}, 1000);
}

/** Read all of stdin: the prompt the launcher wrote to a file. */
export function readStdin(): string {
  return readFileSync(0, 'utf8');
}

/** The value after `flag` in argv, or undefined. */
export function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Do what the environment asks after the fake has received its input:
 * hang, print a huge stream, or print the scripted or default answer,
 * then exit with the scripted code.
 */
export async function answer(defaultStdout: () => string, session: string): Promise<void> {
  await waitForMarker();
  if (environment.FAKE_HANG !== undefined) {
    hangWithGrandchild(environment.FAKE_HANG);
    return;
  }
  if (environment.FAKE_STDERR !== undefined) process.stderr.write(environment.FAKE_STDERR);
  if (environment.FAKE_HUGE !== undefined) {
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    let left = Number(environment.FAKE_HUGE);
    while (left > 0) {
      const part = chunk.subarray(0, Math.min(left, chunk.length));
      await new Promise<void>((resolve, reject) => process.stdout.write(part, (error) => (error ? reject(error) : resolve())));
      left -= part.length;
    }
  } else {
    process.stdout.write((environment.FAKE_STDOUT ?? defaultStdout()).replaceAll('{session}', session));
  }
  process.exitCode = Number(environment.FAKE_EXIT ?? '0');
}
