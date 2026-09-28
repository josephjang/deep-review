/**
 * One engine per run (TD6 of the read-only review). Two engines would
 * both plan the same step and launch it twice before either append
 * failed, so each run has a lock that one engine holds while it runs the
 * run, and a second lock, the start lock, covers finding or creating the
 * run until its run lock is taken, so two engines started together
 * cannot both find no run and create one each.
 *
 * A lock is an empty SQLite database file that the holder keeps open
 * inside a `BEGIN EXCLUSIVE` transaction for as long as it holds the
 * lock. SQLite takes the operating system's file locks for that, so a
 * second holder is refused whether it is another process or another
 * connection in this one, and the operating system drops the lock when
 * the holding process ends, however it ends, even by a hard kill. No
 * process id is checked and nothing is taken over, so two holders at
 * once cannot happen, and neither can a reused pid that looks alive.
 *
 * The lock file is never deleted: a holder's lock lives on the file it
 * opened, so an engine that deleted the file and made a new one would
 * hold a lock nobody else sees. Nothing but the lock may open the file
 * either, since on POSIX closing any other descriptor of it drops every
 * lock this process holds on it. Beside each lock, `<lock>.pid` names
 * the holder's pid for the refusal's message; it is written after the
 * lock is taken and removed before it is released, so it is best effort:
 * absent for an instant after a take, and stale after a hard kill until
 * the next holder writes its own.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blockerActions } from './vocabulary.ts';
import { ReviewRefusedError } from './errors.ts';

/** The directory under the checkpoint root that holds run locks. */
export const locksDirectoryName = 'runs';

/** SQLite's primary result codes for a lock another connection holds, and for a file that is no database; an extended code keeps its primary one in its low byte. */
const sqliteBusy = 5;
const sqliteNotADatabase = 26;

/** Where the start lock lives: at the checkpoint root, where no run's lock can be named like it. */
export function startLockPath(checkpointRoot: string): string {
  return join(checkpointRoot, 'start.lock');
}

/** Where a run's lock lives. */
export function lockPath(checkpointRoot: string, runId: string): string {
  return join(checkpointRoot, locksDirectoryName, `${runId}.lock`);
}

/** The side file beside the lock at `path` that names its holder's pid. */
export function holderPath(path: string): string {
  return `${path}.pid`;
}

/**
 * The pid the side file of the lock at `path` names, or null when there is
 * none or it names no pid. While the lock is held this is its holder, save
 * for the instant between the take and the write; once a holder was
 * killed outright it names that process until the next holder writes.
 */
export function lockHolder(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(holderPath(path), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const pid = Number(text);
  return text !== '' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** What holding a lock gives back: the function that releases it. */
export type ReleaseLock = () => void;

/** Take the run's lock for this engine, or refuse with the `lock-held` blocker while another engine, in this process or another, holds it (see `acquireLock`). */
export function acquireRunLock(checkpointRoot: string, runId: string): ReleaseLock {
  mkdirSync(join(checkpointRoot, locksDirectoryName), { recursive: true });
  return acquireLock(lockPath(checkpointRoot, runId), `is running run ${runId}`);
}

/**
 * Take the checkpoint's start lock for this engine, held while a command
 * finds or creates the run it acts on and takes that run's lock, or refuse
 * with the `lock-held` blocker while another engine holds it.
 */
export function acquireStartLock(checkpointRoot: string): ReleaseLock {
  mkdirSync(checkpointRoot, { recursive: true });
  return acquireLock(startLockPath(checkpointRoot), 'is starting or ending a run in this repository');
}

/** The primary SQLite result code of an error `node:sqlite` threw, or null for any other error. */
function sqliteCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : null;
}

/**
 * Take the lock at `path`, or refuse with the `lock-held` blocker while
 * any other connection holds it; `holding` says what the holder is doing.
 * The transaction is taken without waiting, so a held lock refuses at
 * once, naming the holder the side file names. A file that is no SQLite
 * database is no lock this engine made, and is refused with its path.
 * The returned release removes the side file, then ends the transaction
 * and closes the connection; it releases at most once.
 */
function acquireLock(path: string, holding: string): ReleaseLock {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    const code = sqliteCode(error);
    if (code === sqliteBusy) {
      const holder = lockHolder(path);
      throw new ReviewRefusedError(`${holder === null ? 'another engine' : `engine ${String(holder)}`} ${holding} (lock ${path}); ${blockerActions['lock-held']}`, 'lock-held');
    }
    if (code === sqliteNotADatabase) {
      throw new ReviewRefusedError(`${path} is not a lock this engine made, perhaps one an older engine left; delete it once no engine runs in this repository, then run the command again`);
    }
    throw error;
  }
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    try {
      rmSync(holderPath(path), { force: true });
    } finally {
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
  };
  try {
    writeFileSync(holderPath(path), `${String(process.pid)}\n`);
  } catch (error) {
    release();
    throw error;
  }
  return release;
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
 * the process. The operating system would drop the lock itself as the
 * process ends; releasing it here also removes the side file, so no pid
 * of an ended engine is left behind. Node runs no exit listener for a
 * death by signal, so the signal listener releases the lock itself and
 * then ends the process with `end`. It owns the ending while it listens: the launcher's own signal
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
