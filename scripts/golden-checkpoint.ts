// Write a golden checkpoint fixture: a ledger and evidence store produced by
// this engine, with the fold results and identity a later engine must
// reproduce. Run it when the schema or the event registry changes:
//   npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>
// The serial advances whenever the registry changes; older fixtures stay and
// must still open, which is the forward-compatibility proof.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Checkpoint } from '../src/checkpoint/checkpoint.ts';
import type { ScopeState, WorkerFinish, WorkerLaunch } from '../src/checkpoint/events.ts';
import { checkpointIdentity } from '../src/checkpoint/identity.ts';
import { ledgerFileName } from '../src/checkpoint/ledger.ts';

const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
if (values.output === undefined) throw new Error('--output DIRECTORY is required');
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Fixture output must not exist yet: ${output}`);

// Deterministic time and ids, so the fixture's expected state is stable text.
let tick = 0;
let nextId = 0;
const checkpoint = Checkpoint.open(output, {
  engine: 'golden',
  clock: () => `2026-09-26T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  ids: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
});
try {
  const active = checkpoint.createRun({ worktree: '/fixture/active' });
  const closed = checkpoint.createRun({ worktree: '/fixture/abandoned' });
  // A synthetic scope, so the fixture needs no git repository: one modified
  // file with both states frozen, one added file too large to freeze, one
  // deleted file, and the patch a reader would see.
  const scope: ScopeState = {
    mode: 'worktree',
    request: { paths: [] },
    base: '1111111111111111111111111111111111111111',
    head: '2222222222222222222222222222222222222222',
    files: [
      { path: 'src/changed.ts', status: 'modified', symlink: false, before: { blob: checkpoint.evidence.put('before\n') }, after: { blob: checkpoint.evidence.put('after\n') } },
      { path: 'assets/huge.bin', status: 'added', symlink: false, before: null, after: { oversized: { sha256: '3'.repeat(64), size: 9_000_000 } } },
      { path: 'src/removed.ts', status: 'deleted', symlink: false, before: { blob: checkpoint.evidence.put('removed\n') }, after: null },
    ],
    patch: checkpoint.evidence.put('--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-before\n+after\n'),
  };
  const scoped = checkpoint.append(active.id, active.lastSequence, [{ kind: 'scope.captured', version: 1, payload: scope }]);
  // Two synthetic workers on the active run: one finished with every piece
  // of evidence a receipt holds, one launched and still running, as a worker
  // whose launcher died would be.
  const launch = (workerId: string, runtime: string, sessionId: string | null): WorkerLaunch => ({
    workerId,
    label: `golden ${runtime} worker`,
    runtime,
    executable: `/fixture/bin/${runtime}`,
    executableArgs: [],
    version: '1.2.3',
    model: 'fixture-model',
    effort: 'high',
    access: 'read-only',
    shell: true,
    sessionId,
    resumes: null,
    scratch: `/fixture/checkpoint/scratch/${workerId}`,
    budgetUsd: runtime === 'claude' ? 1.5 : null,
    timeoutMs: 600_000,
    prompt: checkpoint.evidence.put(`Review the change as ${runtime}.\n`),
    schema: checkpoint.evidence.put('{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'),
  });
  const finishedId = '00000000-0000-4000-8000-00000000f001';
  const runningId = '00000000-0000-4000-8000-00000000f002';
  const session = '11111111-2222-4333-8444-555555555555';
  const finish: WorkerFinish = {
    workerId: finishedId,
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    termination: 'exited',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:01:00.000Z',
    sessionIds: [session],
    usage: '{"input_tokens":12,"output_tokens":3}',
    denials: [{ tool: 'Bash', detail: 'rm -rf build' }],
    error: null,
    stdout: checkpoint.evidence.put('{"type":"result","subtype":"success"}\n'),
    stderr: checkpoint.evidence.put(''),
    finalMessage: null,
    output: checkpoint.evidence.put('{"answer":"ok"}'),
  };
  checkpoint.append(active.id, scoped.lastSequence, [
    { kind: 'worker.launched', version: 1, payload: launch(finishedId, 'claude', session) },
    { kind: 'worker.finished', version: 1, payload: finish },
    { kind: 'worker.launched', version: 1, payload: launch(runningId, 'codex', null) },
  ]);
  checkpoint.append(closed.id, closed.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'fixture run closed on purpose' } }]);
  const evidence = checkpoint.evidence.put('fixture evidence\r\nwith two lines\n');
  const expected = { runs: checkpoint.listRuns(), evidence: [evidence, scope.patch, finish.stdout, finish.stderr] };
  writeFileSync(join(output, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  writeFileSync(join(output, 'identity.json'), `${JSON.stringify(checkpointIdentity(), null, 2)}\n`);
} finally {
  checkpoint.close();
}
const leftovers = readdirSync(output).filter((name) => name.startsWith(ledgerFileName) && name !== ledgerFileName);
if (leftovers.length > 0) throw new Error(`Closing the ledger left ${leftovers.join(', ')}; the fixture must be a single file`);
console.log(`wrote ${output}`);
