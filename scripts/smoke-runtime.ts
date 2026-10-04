// Run real workers through each installed runtime CLI and print what every
// receipt says (R12). It calls real models, costs money and needs each CLI to
// be signed in, so it is run by hand, never by `npm run check`:
//   npm run smoke -- --claude <path> --codex <path> --codex-model <model> [--codex-windows-sandbox unelevated|elevated|none]
// Either runtime may be left out. Per runtime there are three workers:
//   first         read-only, asked to create probe.txt in the repository with its shell
//   continuation  the first one's session continued, asked the same again
//   editor        edit access, asked to create edit.txt in the repository and
//                 scratch.txt in the directory TEMP names
// The read-only steps show whose read-only mode stops a write, fresh and
// continued; that differs by runtime, so it is reported, not judged. The
// editor must write both files: an editor that cannot is a broken runtime
// setup. A worker that throws instead of returning a receipt (a refused
// invocation, such as an effort level the runtime lacks) fails its runtime
// and is reported; the other runtime still runs. The temporary repository and
// its checkpoint are kept and their path printed whatever happened, so every
// byte can be inspected afterwards.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Checkpoint } from '../src/checkpoint/checkpoint.ts';
import { effortSchema } from '../src/checkpoint/events.ts';
import { locateCheckpoint } from '../src/checkpoint/locate.ts';
import { engineVersion } from '../src/engine.ts';
import { windowsSandboxes, type WindowsSandbox } from '../src/runtime/codex.ts';
import type { InvocationInput } from '../src/runtime/contract.ts';
import { runWorker, type WorkerReceipt } from '../src/runtime/launcher.ts';
import { defaultRuntimes } from '../src/runtime/runtimes.ts';

const { values } = parseArgs({
  options: {
    claude: { type: 'string' },
    codex: { type: 'string' },
    'claude-model': { type: 'string', default: 'haiku' },
    'codex-model': { type: 'string' },
    'codex-windows-sandbox': { type: 'string', default: 'unelevated' },
    effort: { type: 'string', default: 'low' },
  },
  strict: true,
});
if (values.claude === undefined && values.codex === undefined) throw new Error('Name at least one runtime: --claude <path> and/or --codex <path>');
if (values.codex !== undefined && values['codex-model'] === undefined) throw new Error('--codex needs --codex-model; Codex has no model this script can assume');
const windowsSandbox = values['codex-windows-sandbox'] as WindowsSandbox;
if (!windowsSandboxes.includes(windowsSandbox)) throw new Error(`--codex-windows-sandbox must be one of ${windowsSandboxes.join(', ')}`);
const effort = effortSchema.parse(values.effort);
const runtimes = defaultRuntimes({ codex: { windowsSandbox } });

type Runtime = 'claude' | 'codex';

interface Target {
  readonly runtime: Runtime;
  readonly executable: string;
  readonly model: string;
}

// The runtimes named on the command line, in the order they run.
const targets: readonly Target[] = [
  ...(values.claude === undefined ? [] : [{ runtime: 'claude' as const, executable: values.claude, model: values['claude-model'] }]),
  ...(values.codex === undefined || values['codex-model'] === undefined
    ? []
    : [{ runtime: 'codex' as const, executable: values.codex, model: values['codex-model'] }]),
];

// The temporary repository the workers run in and the checkpoint that
// records them.
interface Workspace {
  readonly repo: string;
  readonly worktree: string;
  readonly checkpoint: Checkpoint;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function initRepository(repo: string): void {
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Smoke');
  git(repo, 'config', 'user.email', 'smoke@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# smoke\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const schema = z.strictObject({ answer: z.string(), commandSucceeded: z.boolean() });
const first =
  'This is a smoke test of a headless worker. Use your shell once to run a command that creates a file named probe.txt ' +
  'containing the word probe in the current directory. Do not try any other way. Then answer with answer set to "first" ' +
  'and commandSucceeded set to whether that command succeeded.';
const second =
  'probe.txt may have been removed since. Use your shell once more to run a command that creates it, the same way. ' +
  'Then answer with answer set to "second" and commandSucceeded set to whether that command succeeded.';
const editor =
  'This is a smoke test of a headless worker that may edit. Use your shell to run exactly two commands: one that creates ' +
  'a file named edit.txt containing the word edit in the current directory, and one that creates a file named scratch.txt ' +
  'containing the word scratch in the directory the TEMP environment variable names. Then answer with answer set to the ' +
  'value of TEMP you saw and commandSucceeded set to whether both commands succeeded.';

interface Line {
  readonly step: string;
  readonly receipt: WorkerReceipt;
  readonly files: Readonly<Record<string, unknown>>;
}

function print(runtime: string, line: Line): void {
  const { receipt } = line;
  console.log(
    JSON.stringify(
      {
        runtime,
        step: line.step,
        workerId: receipt.workerId,
        outcome: receipt.outcome,
        error: receipt.error,
        version: receipt.runtime.version,
        sessionIds: receipt.runtime.sessionIds,
        exitCode: receipt.process.exitCode,
        seconds: (Date.parse(receipt.process.endedAt) - Date.parse(receipt.process.startedAt)) / 1000,
        output: receipt.output,
        denials: receipt.denials,
        files: line.files,
        usage: receipt.runtime.usage,
      },
      null,
      2,
    ),
  );
}

// Runs the three workers for one runtime and says whether all of them passed.
// A worker that throws instead of returning a receipt ends the runtime with
// that error, named after the step that threw.
async function smoke(workspace: Workspace, { runtime, executable, model }: Target): Promise<boolean> {
  const { checkpoint } = workspace;
  const probe = join(workspace.repo, 'probe.txt');
  const edited = join(workspace.repo, 'edit.txt');
  const run = checkpoint.createRun({ worktree: workspace.worktree });
  const base: InvocationInput = {
    runtime,
    executable,
    model,
    effort,
    access: 'read-only',
    shell: true,
    prompt: first,
    outputSchema: schema,
    timeoutMs: 5 * 60 * 1000,
    label: `smoke ${runtime}`,
    ...(runtime === 'claude' ? { budgetUsd: 0.5 } : {}),
  };
  const lines: Line[] = [];
  const step = async (name: string, invocation: InvocationInput): Promise<Line> => {
    rmSync(probe, { force: true });
    rmSync(edited, { force: true });
    let receipt: WorkerReceipt;
    try {
      receipt = await runWorker(checkpoint, run.id, invocation, { runtimes });
    } catch (error) {
      throw new Error(`the ${name} worker threw instead of returning a receipt: ${describe(error)}`, { cause: error });
    }
    const scratch = checkpoint.fold(run.id).workers[receipt.workerId]?.launch.scratch ?? null;
    const files = {
      'probe.txt': existsSync(probe),
      'edit.txt': existsSync(edited),
      scratch,
      scratchFiles: scratch !== null && existsSync(scratch) ? readdirSync(scratch) : null,
    };
    const line = { step: name, receipt, files };
    lines.push(line);
    print(runtime, line);
    return line;
  };
  const opened = await step('first', base);
  const session = opened.receipt.runtime.sessionIds[0];
  if (session !== undefined) await step('continuation', { ...base, prompt: second, resume: session });
  else console.log(JSON.stringify({ runtime, step: 'continuation', skipped: 'the first worker reported no session to continue' }));
  const edit = await step('editor', { ...base, access: 'edit', prompt: editor });
  const editorWrote = edit.files['edit.txt'] === true && Array.isArray(edit.files.scratchFiles) && edit.files.scratchFiles.includes('scratch.txt');
  if (!editorWrote) console.log(JSON.stringify({ runtime, step: 'editor', failed: 'the editor did not write both edit.txt and scratch.txt' }));
  return lines.length === 3 && lines.every((line) => line.receipt.outcome === 'completed') && editorWrote;
}

// Runs every target against one checkpoint. A runtime that throws is reported
// as a failed line and the next runtime still runs, so the workers already
// paid for are not wasted and every receipt stays on the ledger.
async function smokeAll(repo: string): Promise<boolean> {
  initRepository(repo);
  const location = locateCheckpoint(repo);
  const checkpoint = Checkpoint.open(location.root, { engine: engineVersion() });
  const workspace: Workspace = { repo, worktree: location.worktree, checkpoint };
  let passed = true;
  try {
    for (const target of targets) {
      try {
        passed = (await smoke(workspace, target)) && passed;
      } catch (error) {
        passed = false;
        console.log(JSON.stringify({ runtime: target.runtime, failed: describe(error) }));
      }
    }
  } finally {
    checkpoint.close();
  }
  return passed;
}

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-smoke-')));
let passed = false;
try {
  passed = await smokeAll(repo);
} catch (error) {
  // Setting up the repository or checkpoint, or closing the checkpoint, failed.
  console.log(JSON.stringify({ step: 'repository and checkpoint', failed: describe(error) }));
} finally {
  console.log(`repository and checkpoint kept at ${repo}`);
  console.log(passed ? 'smoke passed: every worker completed and every editor wrote its files' : 'smoke FAILED: see the lines above');
  process.exitCode = passed ? 0 : 1;
}
