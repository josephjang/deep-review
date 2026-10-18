/**
 * The preload of the contract test of resumable runs (TD1 of resumable
 * runs): `node --import <this file> src/cli.ts ...` stops the engine at a
 * point of its work, with no hook in the engine. It wraps
 * `Checkpoint.prototype.append`, which `--import` loads into the same
 * module graph as the engine, and `execFileSync` of `node:child_process`,
 * through which the engine's git runs. It is steered by variables:
 *   RESUME_STOP_DIR   the directory of its marker files; nothing is stopped or recorded without it
 *   RESUME_STOP_AT    the point: the name of an append (see appendName), `child` while the child
 *                     FAKE_HOLD names holds (the fakes write `started.json` in FAKE_START_DIR),
 *                     `update-ref before` or `update-ref after`
 *   RESUME_STOP_WAY   `signal` to stop the process from inside, as a handled signal does; any
 *                     other way leaves the kill to the helper (resume-contract.ts)
 *   RESUME_RECORD     a file to append the name of every append to, in order, for a run with no stop
 * At the point it writes `stopped` in the directory. For `signal` it then
 * emits SIGINT in the process, which runs the path of `releaseOnExit`
 * (src/review/lock.ts) on every platform, or raises it when nothing
 * listens; for any other way it blocks the event loop until the helper
 * kills the process, so the engine records nothing after the point.
 */
import childProcess from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Checkpoint, type NewEvent } from '../../src/checkpoint/checkpoint.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';

const directory = process.env.RESUME_STOP_DIR;
const point = process.env.RESUME_STOP_AT;
const way = process.env.RESUME_STOP_WAY;
const record = process.env.RESUME_RECORD;

/** The fields of a payload that name what an event is about, in the order an append's name lists them. */
const namingFields = ['phase', 'key', 'groupId', 'angle', 'moment'] as const;

/**
 * The name of one event as the contract test names a point: its kind, then
 * the label of the worker it is about, when it names one the run launched,
 * else its phase and the unit, group or moment it names; a check's kind
 * after its phase. Names hold no count, since the order of the appends of
 * concurrent workers changes from one run to the next.
 */
export function eventName(event: NewEvent, state: RunState): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const workerId = typeof payload.workerId === 'string' ? payload.workerId : null;
  const label = workerId === null ? null : (state.workers[workerId]?.launch.label ?? null);
  const launched = event.kind === 'worker.launched' && typeof payload.label === 'string' ? payload.label : null;
  const parts = [event.kind];
  if (launched !== null || label !== null) parts.push((launched ?? label)!);
  else {
    for (const field of namingFields) if (typeof payload[field] === 'string') parts.push(payload[field]);
    if (event.kind === 'check.ran' && typeof payload.kind === 'string') parts.push(payload.kind);
  }
  return parts.join(' ');
}

/** The name of an append: the name of its first event. */
export const appendName = (events: readonly NewEvent[], state: RunState): string => eventName(events[0]!, state);

/** Stop the process here, as RESUME_STOP_WAY says, after writing the `stopped` marker. */
function stop(at: string): never {
  writeFileSync(join(directory!, 'stopped'), JSON.stringify({ point: at, pid: process.pid }));
  if (way === 'signal') {
    if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT', 'SIGINT');
    else process.kill(process.pid, 'SIGINT');
  }
  // The helper kills the process from outside; nothing runs meanwhile, so nothing more is recorded.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(pause, 0, 0, 1000);
}

if (directory !== undefined) {
  const original = Checkpoint.prototype.append;
  Checkpoint.prototype.append = function append(this: Checkpoint, runId: string, expectedLastSequence: number, events: readonly NewEvent[]): RunState {
    const state = original.call(this, runId, expectedLastSequence, events);
    const name = appendName(events, state);
    if (record !== undefined) appendFileSync(record, `${name}\n`);
    if (point === name) stop(name);
    return state;
  };

  if (point === 'update-ref before' || point === 'update-ref after') {
    const execFileSync = childProcess.execFileSync;
    const wrapped = ((file: string, args?: readonly string[], options?: unknown) => {
      const moves = Array.isArray(args) && args.includes('update-ref');
      if (moves && point === 'update-ref before') stop(point);
      const result = (execFileSync as (file: string, args?: readonly string[], options?: unknown) => unknown)(file, args, options);
      if (moves) stop(point);
      return result;
    }) as typeof childProcess.execFileSync;
    childProcess.execFileSync = wrapped;
    syncBuiltinESMExports();
  }

  const starts = process.env.FAKE_START_DIR;
  if (point === 'child' && way === 'signal' && starts !== undefined) {
    // A handled signal while the held child runs: the engine is idle in its event loop then, awaiting the child.
    const started = join(starts, 'started.json');
    setInterval(() => {
      if (existsSync(started)) stop('child');
    }, 20).unref();
  }
}
