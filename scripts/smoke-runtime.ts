// Run one prompt and one continuation through each installed runtime CLI and
// print what every receipt says (R12). It calls real models, costs money and
// needs each CLI to be signed in, so it is run by hand, never by `npm run check`:
//   npm run smoke -- --claude <path> --codex <path> --codex-model <model>
// Either runtime may be left out. Both prompts ask the worker to try to
// create a file in the repository with its shell, so the output also shows
// which runtime's read-only mode stops it, fresh and continued. The temporary repository
// and its checkpoint are kept and their path printed, so every byte can be
// inspected afterwards.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Checkpoint } from '../src/checkpoint/checkpoint.ts';
import { effortSchema } from '../src/checkpoint/events.ts';
import { locateCheckpoint } from '../src/checkpoint/locate.ts';
import { engineVersion } from '../src/engine.ts';
import type { InvocationInput } from '../src/runtime/contract.ts';
import { runWorker, type WorkerReceipt } from '../src/runtime/launcher.ts';

const { values } = parseArgs({
  options: {
    claude: { type: 'string' },
    codex: { type: 'string' },
    'claude-model': { type: 'string', default: 'haiku' },
    'codex-model': { type: 'string' },
    effort: { type: 'string', default: 'low' },
  },
  strict: true,
});
if (values.claude === undefined && values.codex === undefined) throw new Error('Name at least one runtime: --claude <path> and/or --codex <path>');
if (values.codex !== undefined && values['codex-model'] === undefined) throw new Error('--codex needs --codex-model; Codex has no model this script can assume');
const effort = effortSchema.parse(values.effort);

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
const schema = z.strictObject({ answer: z.string(), commandSucceeded: z.boolean() });
const first =
  'This is a smoke test of a headless worker. Use your shell once to run a command that creates a file named probe.txt ' +
  'containing the word probe in the current directory. Do not try any other way. Then answer with answer set to "first" ' +
  'and commandSucceeded set to whether that command succeeded.';
const second =
  'probe.txt may have been removed since. Use your shell once more to run a command that creates it, the same way. ' +
  'Then answer with answer set to "second" and commandSucceeded set to whether that command succeeded.';

interface Line {
  readonly step: string;
  readonly receipt: WorkerReceipt;
  readonly probeExists: boolean;
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
        probeExists: line.probeExists,
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
  const step = async (name: string, invocation: InvocationInput): Promise<WorkerReceipt> => {
    rmSync(probe, { force: true });
    const receipt = await runWorker(checkpoint, run.id, invocation);
    const line = { step: name, receipt, probeExists: existsSync(probe) };
    lines.push(line);
    print(runtime, line);
    return receipt;
  };
  const opened = await step('first', base);
  const session = opened.runtime.sessionIds[0];
  if (session !== undefined) await step('continuation', { ...base, prompt: second, resume: session });
  else console.log(JSON.stringify({ runtime, step: 'continuation', skipped: 'the first worker reported no session to continue' }));
  return lines.length === 2 && lines.every((line) => line.receipt.outcome === 'completed');
}

let passed = true;
try {
  if (values.claude !== undefined) passed = (await smoke('claude', values.claude, values['claude-model'])) && passed;
  if (values.codex !== undefined) passed = (await smoke('codex', values.codex, values['codex-model']!)) && passed;
} finally {
  checkpoint.close();
}
console.log(`repository and checkpoint kept at ${repo}`);
console.log(passed ? 'smoke passed: every worker completed' : 'smoke FAILED: at least one worker did not complete');
process.exitCode = passed ? 0 : 1;
