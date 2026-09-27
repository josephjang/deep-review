// Run real workers through each installed runtime CLI and print what every
// receipt says (R12). It calls real models, costs money and needs each CLI to
// be signed in, so it is run by hand, never by `npm run check`:
//   npm run smoke -- --claude <path> --codex <path> --codex-model <model> [--codex-windows-sandbox elevated]
// Either runtime may be left out. Per runtime there are three workers:
//   first         read-only, asked to create probe.txt in the repository with its shell
//   continuation  the first one's session continued, asked the same again
//   editor        edit access, asked to create edit.txt in the repository and
//                 scratch.txt in the directory TEMP names
// The read-only steps show whose read-only mode stops a write, fresh and
// continued; that differs by runtime, so it is reported, not judged. The
// editor must write both files: an editor that cannot is a broken runtime
// setup. The temporary repository and its checkpoint are kept and their path
// printed, so every byte can be inspected afterwards.
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
if (!windowsSandboxes.includes(windowsSandbox)) throw new Error(`--codex-windows-sandbox must be ${windowsSandboxes.join(' or ')}`);
const effort = effortSchema.parse(values.effort);
const runtimes = defaultRuntimes({ codex: { windowsSandbox } });

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-smoke-')));
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Smoke');
git(repo, 'config', 'user.email', 'smoke@example.invalid');
git(repo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), '# smoke\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'initial');

const location = locateCheckpoint(repo);
const checkpoint = Checkpoint.open(location.root, { engine: engineVersion() });
const probe = join(repo, 'probe.txt');
const edited = join(repo, 'edit.txt');
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
  const cost = (receipt.runtime.usage as { total_cost_usd?: unknown } | null)?.total_cost_usd;
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
        costUsd: cost ?? null,
        usage: receipt.runtime.usage,
      },
      null,
      2,
    ),
  );
}

async function smoke(runtime: 'claude' | 'codex', executable: string, model: string): Promise<boolean> {
  const run = checkpoint.createRun({ worktree: location.worktree });
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
    const receipt = await runWorker(checkpoint, run.id, invocation, { runtimes });
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

let passed = true;
try {
  if (values.claude !== undefined) passed = (await smoke('claude', values.claude, values['claude-model'])) && passed;
  if (values.codex !== undefined) passed = (await smoke('codex', values.codex, values['codex-model']!)) && passed;
} finally {
  checkpoint.close();
}
console.log(`repository and checkpoint kept at ${repo}`);
console.log(passed ? 'smoke passed: every worker completed and every editor wrote its files' : 'smoke FAILED: see the lines above');
process.exitCode = passed ? 0 : 1;
