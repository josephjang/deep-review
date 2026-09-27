/**
 * One engine per run (TD6 of the read-only review): a lock file under the
 * checkpoint, holding the process id of the engine that runs the run. Two
 * engines would both plan the same step and launch it twice before either
 * append failed, so the second is refused while the first's process lives;
 * a lock whose process is gone is replaced.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { blockerActions } from './vocabulary.ts';
import { ReviewRefusedError } from './errors.ts';

/** The directory under the checkpoint root that holds run locks. */
export const locksDirectoryName = 'runs';

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

/** The pid a lock file holds, or null when the file is absent or holds no pid. */
export function lockHolder(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** What holding a lock gives back: the function that releases it. */
export type ReleaseLock = () => void;

/**
 * Take the run's lock for this process, or refuse with the `lock-held`
 * blocker while another live process holds it. A lock left by a process
 * that is gone, or one that holds no pid, is replaced. The lock is created
 * exclusively, so two engines racing for one run cannot both take it.
 */
export function acquireRunLock(checkpointRoot: string, runId: string, pid: number = process.pid): ReleaseLock {
  const path = lockPath(checkpointRoot, runId);
  mkdirSync(join(checkpointRoot, locksDirectoryName), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const holder = lockHolder(path);
    if (holder !== null && holder !== pid && processAlive(holder)) {
      throw new ReviewRefusedError(`engine ${String(holder)} is running run ${runId} (lock ${path}); ${blockerActions['lock-held']}`, 'lock-held');
    }
    if (holder !== null) rmSync(path, { force: true });
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
  throw new ReviewRefusedError(`another engine is taking the lock of run ${runId} (${path}); ${blockerActions['lock-held']}`, 'lock-held');
}
