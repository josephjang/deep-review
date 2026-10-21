// What a fake runtime CLI or stand-in check (fake-claude.ts, fake-codex.ts,
// fake-check.ts) sees of the process it runs as. Started as a script, a
// fake gets processHost(): its own process, as the engine spawns a real
// CLI. Run by the in-process runner (in-process-runner.ts), it gets a host
// over the request the engine would have spawned, inside the test's own
// process, which costs no process start. No fake reads `process` itself,
// so both ways run the same code. This module imports only Node's own, so
// a fake that loads it still starts fast.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface FakeHost {
  /** The arguments after the fake's script. */
  readonly args: readonly string[];
  /** The environment the engine gave the process. */
  readonly environment: NodeJS.ProcessEnv;
  /** The working directory the engine gave the process. */
  readonly cwd: string;
  /** The process the fake runs in, which a test that holds a fake kills (see holdIfNamed in fake-runtime.ts). */
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
