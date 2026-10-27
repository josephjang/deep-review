/**
 * The preload of the contract test of resumable runs (TD1 of resumable
 * runs): `node --import <this file> src/cli.ts ...` stops the engine at a
 * point of its work, with no hook in the engine. It wraps
 * `Checkpoint.prototype.append`, which `--import` loads into the same
 * module graph as the engine, and `execFileSync` of `node:child_process`,
 * through which the engine's git runs. It is steered by variables:
 *   RESUME_STOP_DIR   the directory of its marker files; nothing is stopped or recorded without it
 *   RESUME_STOP_AT    the point: the name of an append (see appendName), after it is written;
 *                     `before ` and that name, before it is written; `child` while the child
 *                     FAKE_HOLD names holds (the fakes write `started.json` in FAKE_START_DIR);
 *                     or a git call of `gitCalls` and `before` or `after`, such as
 *                     `update-ref before` or `worktree add after`
 *   RESUME_STOP_WAY   `signal` to stop the process from inside, as a handled signal does; any
 *                     other way leaves the kill to the helper (resume-contract.ts); with
 *                     `child` at the point `child`, the helper kills the held child first, and
 *                     the preload stops the engine at its next step after it recorded the
 *                     child's end: its next append that launches a worker, starts a check or
 *                     finishes a phase
 *   RESUME_RECORD     a file to append the name of every append to, in order, for a run with no stop,
 *                     and the points before and after each git call of `gitCalls`
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

/** The git calls a point can stop before or after, by the arguments that name each: `commit` moving the branch, and the phase `base-checks` making and removing a worktree of the base. */
const gitCalls: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  'update-ref': (args) => args.includes('update-ref'),
  'worktree add': (args) => args.includes('worktree') && args.includes('add'),
  'worktree remove': (args) => args.includes('worktree') && args.includes('remove'),
};

/** The git call `args` makes, by its name in `gitCalls`, or null for any other. */
const gitCallOf = (args: unknown): string | null => (Array.isArray(args) ? (Object.keys(gitCalls).find((call) => gitCalls[call]!(args as string[])) ?? null) : null);

/** The kinds of event that begin the engine's next step after the end of a child: a launch, the start of a check, the end of a phase. */
const nextStepKinds: ReadonlySet<string> = new Set(['worker.launched', 'check.started', 'phase.finished']);

if (directory !== undefined) {
  const starts = process.env.FAKE_START_DIR;
  const started = starts === undefined ? null : join(starts, 'started.json');
  // The fourth way: the first append after the held child started records its end, since the run has one worker at a time.
  let childEnded = false;
  const original = Checkpoint.prototype.append;
  Checkpoint.prototype.append = function append(this: Checkpoint, runId: string, expectedLastSequence: number, events: readonly NewEvent[]): RunState {
    if (point?.startsWith('before ') === true && point === `before ${appendName(events, this.fold(runId))}`) stop(point);
    const state = original.call(this, runId, expectedLastSequence, events);
    const name = appendName(events, state);
    if (record !== undefined) appendFileSync(record, `${name}\n`);
    if (point === name) stop(name);
    if (point === 'child' && way === 'child' && started !== null) {
      if (childEnded && events.some((event) => nextStepKinds.has(event.kind))) stop('child');
      else if (!childEnded && existsSync(started)) childEnded = true;
    }
    return state;
  };

  const atGitCall = point !== undefined && Object.keys(gitCalls).some((call) => point === `${call} before` || point === `${call} after`);
  if (atGitCall || record !== undefined) {
    const execFileSync = childProcess.execFileSync;
    /** At the moment around a git call: record its point, and stop there when it is the one asked for. */
    const around = (call: string | null, moment: 'before' | 'after'): void => {
      if (call === null) return;
      if (record !== undefined) appendFileSync(record, `${call} ${moment}\n`);
      if (point === `${call} ${moment}`) stop(point);
    };
    const wrapped = ((file: string, args?: readonly string[], options?: unknown) => {
      const call = gitCallOf(args);
      around(call, 'before');
      const result = (execFileSync as (file: string, args?: readonly string[], options?: unknown) => unknown)(file, args, options);
      around(call, 'after');
      return result;
    }) as typeof childProcess.execFileSync;
    childProcess.execFileSync = wrapped;
    syncBuiltinESMExports();
  }

  if (point === 'child' && way === 'signal' && started !== null) {
    // A handled signal while the held child runs: the engine is idle in its event loop then, awaiting the child.
    setInterval(() => {
      if (existsSync(started)) stop('child');
    }, 20).unref();
  }
}
