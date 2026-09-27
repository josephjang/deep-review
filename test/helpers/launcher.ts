import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import type { WorkerState } from '../../src/checkpoint/fold.ts';
import type { InvocationInput } from '../../src/runtime/contract.ts';
import { withoutVariables } from '../../src/runtime/environment.ts';
import { checkpointScratchKey, runWorker, type RunWorkerOptions, type WorkerReceipt } from '../../src/runtime/launcher.ts';

export const fakeClaude = resolve(import.meta.dirname, 'fake-claude.ts');
export const fakeCodex = resolve(import.meta.dirname, 'fake-codex.ts');
/** The thread id fake-codex.ts reports for a fresh worker. */
export const freshThread = '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

export const answerSchema = z.strictObject({ answer: z.string() });

/**
 * This process's environment without anything that would steer a fake or
 * be refused by an adapter, so a developer's shell cannot change a result.
 */
export const baseEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(withoutVariables(process.env, ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'])).filter(
    ([name]) => !name.toUpperCase().startsWith('FAKE_'),
  ),
);

/** What a fake wrote to FAKE_RECORD. */
export interface Recorded {
  readonly argv: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly environment: Record<string, string>;
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Poll until `condition` holds, failing after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The pid a hanging fake writes to `file` (see FAKE_HANG), once the file holds one. */
export async function waitForPid(file: string, timeoutMs = 15_000): Promise<number> {
  let pid = 0;
  await until(
    () => {
      pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
      return Number.isSafeInteger(pid) && pid > 0;
    },
    `a pid in ${file}`,
    timeoutMs,
  );
  return pid;
}

/** Whether a process exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A temporary worktree, a checkpoint beside it and one active run, with helpers to launch fakes into it. */
export class LauncherSandbox {
  readonly directory: string;
  readonly repo: string;
  readonly checkpoint: Checkpoint;
  readonly runId: string;
  readonly recordFile: string;
  /** Where this sandbox's workers get their scratch directories, instead of the system's temporary directory. */
  readonly scratchRoot: string;

  constructor() {
    // Canonical, as locateCheckpoint makes a real worktree: on macOS the temporary
    // directory is under /var, a symlink to /private/var, and a worker's own
    // cwd reports the resolved path.
    this.directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-launcher-')));
    this.repo = join(this.directory, 'repo');
    mkdirSync(this.repo);
    this.checkpoint = Checkpoint.open(join(this.directory, 'checkpoint'), { engine: '0.0.0-test' });
    this.runId = this.checkpoint.createRun({ worktree: this.repo }).id;
    this.recordFile = join(this.directory, 'record.json');
    this.scratchRoot = join(this.directory, 'scratch-root');
  }

  close(): void {
    this.checkpoint.close();
    // A process killed at a timeout can hold its files for a moment on Windows.
    rmSync(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  claude(change: Partial<InvocationInput> = {}): InvocationInput {
    return {
      runtime: 'claude',
      executable: process.execPath,
      executableArgs: [fakeClaude],
      model: 'fake-model',
      effort: 'high',
      access: 'read-only',
      shell: true,
      prompt: 'Answer ok.',
      outputSchema: answerSchema,
      timeoutMs: 30_000,
      ...change,
    };
  }

  codex(change: Partial<InvocationInput> = {}): InvocationInput {
    return { ...this.claude(), runtime: 'codex', executableArgs: [fakeCodex], ...change };
  }

  /** Run a worker with the fake steered by `fake` on top of the clean environment. */
  run(invocation: InvocationInput, fake: Record<string, string> = {}, options: RunWorkerOptions = {}): Promise<WorkerReceipt> {
    return runWorker(this.checkpoint, this.runId, invocation, { environment: { ...baseEnvironment, FAKE_RECORD: this.recordFile, ...fake }, scratchRoot: this.scratchRoot, ...options });
  }

  /** The scratch directory the launcher creates by default for a worker of this sandbox. */
  scratchOf(workerId: string): string {
    return join(this.scratchRoot, checkpointScratchKey(this.checkpoint), workerId);
  }

  recorded(): Recorded {
    return JSON.parse(readFileSync(this.recordFile, 'utf8')) as Recorded;
  }

  /** The run's events as kind and parsed payload. */
  events(): [string, Record<string, unknown>][] {
    return this.checkpoint.ledger.events(this.runId).map((event) => [event.kind, JSON.parse(event.payload) as Record<string, unknown>]);
  }

  worker(workerId: string): WorkerState {
    const worker = this.checkpoint.fold(this.runId).workers[workerId];
    if (worker === undefined) throw new Error(`No worker ${workerId}`);
    return worker;
  }

  /** Nothing but the run's creation is on the ledger, and no evidence, scratch or process file exists. */
  untouched(): boolean {
    const kinds = this.events().map(([kind]) => kind);
    return (
      kinds.length === 1 &&
      kinds[0] === 'run.created' &&
      !existsSync(this.scratchRoot) &&
      !existsSync(join(this.checkpoint.root, 'io')) &&
      readdirSync(this.checkpoint.evidence.root).length === 0
    );
  }
}
