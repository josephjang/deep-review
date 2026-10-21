// What a fake runtime CLI or stand-in check (fake-claude.ts, fake-codex.ts,
// fake-check.ts) sees of the process it runs as. Started as a script, a
// fake gets processHost(): its own process, as the engine spawns a real
// CLI. Run by the in-process runner (in-process-runner.ts), it gets a host
// over the request the engine would have spawned, inside the test's own
// process, which costs no process start. No fake reads `process` itself,
// so both ways run the same code. It also holds what the fakes share of
// the files they write: writeWhole, and the hold protocol (holdIfNamed)
// that a worker and a check both keep. This module imports only Node's
// own, so a fake that loads it still starts fast.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeHost {
  /** The arguments after the fake's script. */
  readonly args: readonly string[];
  /** The environment the engine gave the process. */
  readonly environment: NodeJS.ProcessEnv;
  /** The working directory the engine gave the process. */
  readonly cwd: string;
  /** The process the fake runs in, which a test that holds a fake kills (see holdIfNamed). */
  readonly pid: number;
  /** A name unique among the fakes running at once, for a temporary file's name. */
  readonly id: string;
  /** All of stdin: the prompt the launcher wrote to a file. */
  readStdin(): string;
  /** Write to stdout or stderr, resolved once the bytes are taken. */
  write(stream: 'stdout' | 'stderr', bytes: string | Uint8Array): Promise<void>;
  /** Never end by itself, as a hung CLI does: only a kill of the process, or the in-process runner at the fake's timeout, ends it. */
  hang(): Promise<never>;
  /**
   * Start a grandchild that runs `script` with `node -e` and give its pid:
   * detached on Windows, where libuv otherwise puts it in a job that dies
   * with the fake, so a test could not tell a tree kill from a root kill;
   * in the fake's process group on POSIX, which a tree kill addresses. Only
   * a fake in a process of its own has a tree for the engine to kill, so
   * the in-process host refuses.
   */
  startGrandchild(script: string): number;
  /** Resolve after `ms`; in the in-process host, reject once the runner has ended the fake. */
  sleep(ms: number): Promise<void>;
}

/** The host of a fake started as a script: this process. */
export function processHost(): FakeHost {
  return {
    args: process.argv.slice(2),
    environment: process.env,
    cwd: process.cwd(),
    pid: process.pid,
    id: String(process.pid),
    readStdin: () => readFileSync(0, 'utf8'),
    write: (stream, bytes) =>
      new Promise((resolve, reject) => {
        (stream === 'stdout' ? process.stdout : process.stderr).write(bytes, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    hang: () => {
      // A pending promise alone keeps no process alive; the interval does, until the kill.
      setInterval(() => {}, 1000);
      return new Promise<never>(() => {});
    },
    startGrandchild: (script) => {
      const grandchild = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
      if (grandchild.pid === undefined) throw new Error('The grandchild did not start');
      return grandchild.pid;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Wait until `marker` exists, looking every 20 ms. */
export async function waitForFile(host: FakeHost, marker: string): Promise<void> {
  while (!existsSync(marker)) await host.sleep(20);
}

/** Write a file whole, under a temporary name unique to the fake (`id`) and then renamed, so a polling test never reads it empty or half written. */
export function writeWhole(file: string, text: string, id: string): void {
  const temporary = `${file}.${id}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/**
 * When FAKE_START_DIR is set, record this start as `name` (a worker's
 * `<role> <phase>:<unit>`, as the engine labels its launch, or a check's
 * `check <kind>`) and, when FAKE_HOLD names it as `<name>#<n>`, the n-th
 * start of the name, hold: start a grandchild, write both pids to
 * `started.json` in the directory, and wait for its `release` file, with
 * the grandchild waiting for it too. The contract test of resumable runs
 * (resume-contract.ts) stops the engine while such a fake holds.
 */
export async function holdIfNamed(host: FakeHost, name: string): Promise<void> {
  const directory = host.environment.FAKE_START_DIR;
  if (directory === undefined) return;
  appendFileSync(join(directory, 'starts'), `${name}\n`);
  const hold = host.environment.FAKE_HOLD;
  const at = hold === undefined ? -1 : hold.lastIndexOf('#');
  if (hold === undefined || at === -1 || hold.slice(0, at) !== name) return;
  const counter = join(directory, 'held.count');
  const count = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeWhole(counter, String(count), host.id);
  if (count !== Number(hold.slice(at + 1))) return;
  const release = join(directory, 'release');
  const grandchild = host.startGrandchild(`const { existsSync } = require('node:fs'); setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`);
  writeWhole(join(directory, 'started.json'), JSON.stringify({ pid: host.pid, grandchild }), host.id);
  await waitForFile(host, release);
}
