// Appends `count` test.note events to one run, retrying on every race, and
// prints what happened. Spawned by the concurrency test, once per process.
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { StaleRevisionError } from '../../src/checkpoint/errors.ts';
import { testModel } from './model.ts';

const [root, runId, countText, label] = process.argv.slice(2);
if (root === undefined || runId === undefined || countText === undefined || label === undefined) {
  throw new Error('usage: append-worker <root> <runId> <count> <label>');
}
const count = Number(countText);
const checkpoint = Checkpoint.open(root, { engine: `worker-${label}`, model: testModel });
let appended = 0;
let stale = 0;
let busy = 0;
try {
  while (appended < count) {
    const state = checkpoint.fold(runId);
    try {
      checkpoint.append(runId, state.lastSequence, [{ kind: 'test.note', version: 1, payload: { text: `${label}-${String(appended)}` } }]);
      appended += 1;
    } catch (error) {
      if (error instanceof StaleRevisionError) stale += 1;
      else if (/database is locked|SQLITE_BUSY/i.test((error as Error).message)) busy += 1;
      else throw error;
    }
  }
} finally {
  checkpoint.close();
}
console.log(JSON.stringify({ label, appended, stale, busy }));
