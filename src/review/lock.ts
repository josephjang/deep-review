/**
 * One engine per run (TD6 of the read-only review): a lock file under the
 * checkpoint, holding the process id of the engine that runs the run. Two
 * engines would both plan the same step and launch it twice before either
 * append failed, so the second is refused while the first's process lives;
 * a lock whose process is gone is replaced.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { blockerActions } from './vocabulary.ts';
import { ReviewRefusedError } from './errors.ts';

/** The directory under the checkpoint root that holds run locks. */
export const locksDirectoryName = 'runs';

/**
 * How old a lock file that holds no pid must be before it is taken for a
 * leftover and replaced. An engine writes its pid right after creating the
 * file, so a younger one may be a lock another engine is taking right now.
 */
export const unwrittenLockGraceMs = 10_000;

/** Where a run's lock lives. */
export function lockPath(checkpointRoot: string, runId: string): string {
  return join(checkpointRoot, locksDirectoryName, `${runId}.lock`);
}

/** Whether a process with this id exists: a signal of 0 is delivered to none, and EPERM means it exists under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a lock file holds: nothing (no file), a pid, or no pid (empty or garbage), with the file's age. */
type LockFile = { readonly kind: 'absent' } | { readonly kind: 'held'; readonly pid: number } | { readonly kind: 'no-pid'; readonly ageMs: number };

function readLock(path: string): LockFile {
  let text: string;
  let modifiedMs: number;
  try {
    modifiedMs = statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  const pid = Number(text.trim());
  return text.trim() !== '' && Number.isSafeInteger(pid) && pid > 0 ? { kind: 'held', pid } : { kind: 'no-pid', ageMs: Date.now() - modifiedMs };
}

/** The pid a lock file holds, or null when the file is absent or holds no pid. */
export function lockHolder(path: string): number | null {
  const lock = readLock(path);
  return lock.kind === 'held' ? lock.pid : null;
}

/** What holding a lock gives back: the function that releases it. */
export type ReleaseLock = () => void;

/**
 * Take the run's lock for this process, or refuse with the `lock-held`
 * blocker while another live process holds it. A lock left by a process
 * that is gone is replaced, and so is one that holds no pid once it is
 * older than `unwrittenLockGraceMs`; a younger one may be another engine's
 * lock in the instant between its create and its write, and is refused.
 * The lock is created exclusively, so two engines racing to create it
 * cannot both take it.
 */
export function acquireRunLock(checkpointRoot: string, runId: string, pid: number = process.pid): ReleaseLock {
  const path = lockPath(checkpointRoot, runId);
  const taking = (): ReviewRefusedError => new ReviewRefusedError(`another engine is taking the lock of run ${runId} (${path}); ${blockerActions['lock-held']}`, 'lock-held');
  mkdirSync(join(checkpointRoot, locksDirectoryName), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = readLock(path);
    if (lock.kind === 'held' && lock.pid !== pid && processAlive(lock.pid)) {
      throw new ReviewRefusedError(`engine ${String(lock.pid)} is running run ${runId} (lock ${path}); ${blockerActions['lock-held']}`, 'lock-held');
    }
    if (lock.kind === 'no-pid' && lock.ageMs < unwrittenLockGraceMs) throw taking();
    if (lock.kind !== 'absent') rmSync(path, { force: true });
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${String(pid)}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(path, { force: true });
    } catch (error) {
      // Another engine created the lock between our read and our create; look at whose it is once more.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw taking();
}

/**
 * The signals that end the engine by default: those the launcher hooks on
 * POSIX (src/runtime/process.ts), and on Windows the console's Ctrl-C,
 * Ctrl-Break and close, the only ones Node delivers there.
 */
const endingSignals: readonly NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/** End the process as the signal would have, after the lock is released: the conventional 128 + its number, running the exit listeners that kill the workers' trees. */
function exitBySignal(signal: NodeJS.Signals): void {
  process.exit(128 + (constants.signals[signal] as number | undefined ?? 0));
}

/**
 * Hold a lock until the engine ends, however it ends: the returned function
 * releases it, and so do the process's exit and a signal that would end
 * the process. Node runs no exit listener for a death by signal, so the
 * signal listener releases the lock itself and then ends the process with
 * `end`. It owns the ending while it listens: the launcher's own signal
 * listener re-raises the signal only when it is the signal's sole
 * listener. The lock is released at most once, and releasing removes
 * every listener.
 */
export function releaseOnExit(release: ReleaseLock, end: (signal: NodeJS.Signals) => void = exitBySignal): ReleaseLock {
  let held = true;
  const dispose = (): void => {
    if (!held) return;
    held = false;
    process.off('exit', dispose);
    for (const signal of endingSignals) process.off(signal, onSignal);
    release();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    dispose();
    end(signal);
  };
  process.on('exit', dispose);
  for (const signal of endingSignals) process.on(signal, onSignal);
  return dispose;
}
