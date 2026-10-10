/**
 * Writing a file whole, for a file another process may read at any moment:
 * the round's `held.json`, which a fixer's claim command reads while the
 * engine rewrites it at a launch, and a claim's marker, which a sibling's
 * command reads while it is created (`src/review/claims.ts`).
 */
import { randomBytes } from 'node:crypto';
import { linkSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** The codes Windows raises for a rename over a file another process has open, or antivirus is scanning; the replace goes through once that handle closes. */
const busyReplace = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Error codes a filesystem without hard links raises from linkSync, with
 * EACCES and EISDIR, what a sandbox or a volume refusing link() raises
 * (EISDIR is libuv's name for Windows' ERROR_INVALID_FUNCTION). Where the
 * directory itself is unwritable, the fallback throws that error again.
 */
export const noHardLinks: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EACCES', 'EISDIR']);

/** How long a refused replace is retried before its error is thrown. */
const replaceBudgetMs = 500;

/** The longest single wait between two tries. */
const longestWaitMs = 50;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** A replace still refused as busy once its retries ran out: the file keeps what it held, and `code` is the last refusal's. */
export class ReplaceBusyError extends Error {
  override readonly name = 'ReplaceBusyError';
  readonly code: string;
  constructor(file: string, cause: NodeJS.ErrnoException & { code: string }) {
    super(`${file} could not be replaced, still busy after ${String(replaceBudgetMs)} ms: ${cause.message}`, { cause });
    this.code = cause.code;
  }
}

/**
 * A fresh temporary name beside `file` to write it under: no reader takes it
 * for `file`, since it does not end as `file` does. The random part keeps
 * two writers apart even when they share a pid, as claim commands in
 * sandboxes with their own PID namespaces can.
 */
const temporaryFor = (file: string): string => `${file}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;

/**
 * Write `text` to `file` whole: to a temporary name beside it, then renamed
 * over it, so a reader never sees half of it. A rename refused as busy is
 * tried again, waiting a little longer each time, for a bounded time, and
 * throws `ReplaceBusyError` once that time is out; a rename that fails
 * removes the temporary file as far as the file system lets it. `rename`
 * stands in for the file system's in tests.
 */
export function writeFileAtomic(file: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const temporary = temporaryFor(file);
  writeFileSync(temporary, text);
  const deadline = Date.now() + replaceBudgetMs;
  for (let wait = 1; ; wait = Math.min(wait * 2, longestWaitMs)) {
    try {
      rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !busyReplace.has(code)) {
        removeIfAble(temporary);
        throw error;
      }
      if (Date.now() >= deadline) {
        removeIfAble(temporary);
        throw new ReplaceBusyError(file, error as NodeJS.ErrnoException & { code: string });
      }
    }
    Atomics.wait(sleeper, 0, 0, wait);
  }
}

/**
 * Remove a temporary file, leaving it where Windows refuses while antivirus
 * or an indexer holds it: it only tidies, and no reader takes it for the
 * file it was written for, so its removal must not turn a created file
 * into a failure.
 */
function removeIfAble(temporary: string): void {
  try {
    rmSync(temporary, { force: true });
  } catch {
    // Left behind under its temporary name.
  }
}

/**
 * Create `file` holding `text`, only if no file of that name exists, and
 * whole: written under a temporary name beside it, then hard-linked to its
 * name, so a process killed or a disk filled while writing leaves no file
 * under the name, and a reader never sees it before its content. False
 * when `file` exists already. Where the file system has no hard links, it
 * is created under `wx` and written, which a kill can still tear. The
 * temporary file is removed whatever happened, as far as the file system
 * lets it be, and its removal never decides the outcome; `link` stands in
 * for the file system's in tests.
 */
export function createFileExclusive(file: string, text: string, link: (from: string, to: string) => void = linkSync): boolean {
  const temporary = temporaryFor(file);
  try {
    writeFileSync(temporary, text);
    try {
      link(temporary, file);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === undefined || !noHardLinks.has(code)) throw error;
    }
  } finally {
    removeIfAble(temporary);
  }
  try {
    writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
