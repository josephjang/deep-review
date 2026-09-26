// Runs one fake Claude worker on a run and prints its outcome. Spawned by the
// concurrency test, once per process, so several launchers finish at once.
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { runWorker } from '../../src/runtime/launcher.ts';
import { answerSchema, baseEnvironment, fakeClaude } from './launcher.ts';

const [root, runId, marker] = process.argv.slice(2);
if (root === undefined || runId === undefined || marker === undefined) throw new Error('usage: launch-worker <root> <runId> <marker>');
const checkpoint = Checkpoint.open(root, { engine: 'launch-worker' });
try {
  const receipt = await runWorker(
    checkpoint,
    runId,
    {
      runtime: 'claude',
      executable: process.execPath,
      executableArgs: [fakeClaude],
      model: 'fake-model',
      effort: 'high',
      access: 'read-only',
      shell: true,
      prompt: 'Answer ok.',
      outputSchema: answerSchema,
      timeoutMs: 60_000,
    },
    { environment: { ...baseEnvironment, FAKE_WAIT_FOR: marker } },
  );
  console.log(JSON.stringify({ workerId: receipt.workerId, outcome: receipt.outcome, error: receipt.error }));
} finally {
  checkpoint.close();
}
