// A stand-in worker for the process tests, run as
//   node process-engine.ts worker <pidFile>
// It starts a grandchild, writes {"worker","grandchild"} pids to pidFile,
// and never exits, so a test can see whether a kill reached the whole tree.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The pids a worker writes once its grandchild is running. */
export interface WorkerPids {
  readonly worker: number;
  readonly grandchild: number;
}

export const processEngine = import.meta.filename;

/** Where a worker started in `directory` writes its pids. */
export const workerPidFile = (directory: string): string => join(directory, 'pids.json');

/**
 * Start a grandchild that never exits, write both pids, and never exit.
 * As in fake-runtime.ts, the grandchild is detached on Windows so the job
 * libuv puts the worker in cannot end it: only a real tree kill does.
 */
function worker(pidFile: string): void {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  const pids: WorkerPids = { worker: process.pid, grandchild: grandchild.pid! };
  writeFileSync(pidFile, JSON.stringify(pids));
  setInterval(() => {}, 1000);
}

const [role, ...rest] = process.argv.slice(2);
if (role === 'worker') worker(rest[0]!);
