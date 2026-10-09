/**
 * Writing a file whole, for a file another process may read at any moment:
 * the round's `held.json`, which a fixer's claim command reads while the
 * engine rewrites it at a launch (`src/review/claims.ts`).
 */
import { renameSync, writeFileSync } from 'node:fs';

/** The codes Windows raises for a rename over a file another process has open, or antivirus is scanning; the replace goes through once that handle closes. */
const busyReplace = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** How long a refused replace is retried before its error is thrown. */
const replaceBudgetMs = 500;

/** The longest single wait between two tries. */
const longestWaitMs = 50;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write `text` to `file` whole: to a temporary name beside it, then renamed
 * over it, so a reader never sees half of it. A rename refused as busy is
 * tried again, waiting a little longer each time, for a bounded time;
 * `rename` stands in for the file system's in tests.
 */
export function writeFileAtomic(file: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  const deadline = Date.now() + replaceBudgetMs;
  for (let wait = 1; ; wait = Math.min(wait * 2, longestWaitMs)) {
    try {
      rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !busyReplace.has(code) || Date.now() >= deadline) throw error;
    }
    Atomics.wait(sleeper, 0, 0, wait);
  }
}
