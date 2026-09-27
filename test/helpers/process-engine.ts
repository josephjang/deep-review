// A stand-in engine for the process tests: it runs one worker through
// runProcess, or one preflight whose probe hangs, and is then interrupted,
// crashes or exits, so a test can see whether the child's tree outlives it.
// One file plays every role:
//   node process-engine.ts worker <pidFile>
//     start a grandchild, write {"worker","grandchild"} pids to pidFile, never exit
//   node process-engine.ts engine <mode> <directory>
//     run the worker through runProcess, wait for its pid file, then end as <mode> says
//   node process-engine.ts probe-engine <mode> <directory>
//     run a preflight against fake-hanging-probe.ts, wait for its grandchild's
//     pid file, then end as <mode> says
// where <mode> is one of:
//       crash        throw an uncaught exception
//       exit         call process.exit(3)
//       wait         wait for a signal, with no handler of its own
//       own-handler  wait for SIGINT, which its own handler turns into exit code 42
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { preflight } from '../../src/runtime/preflight.ts';
import { runProcess } from '../../src/runtime/process.ts';

/** The pids a worker writes once its grandchild is running. */
export interface WorkerPids {
  readonly worker: number;
  readonly grandchild: number;
}

export const processEngine = import.meta.filename;

/** Where the worker of an engine run in `directory` writes its pids. */
export const workerPidFile = (directory: string): string => join(directory, 'pids.json');

/** Where the hanging probe of a probe-engine run in `directory` writes its grandchild's pid. */
export const probeGrandchildPidFile = (directory: string): string => join(directory, 'probe-grandchild.pid');

const fakeHangingProbe = resolve(import.meta.dirname, 'fake-hanging-probe.ts');

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

/** Wait until `file` holds something. */
async function waitForFile(file: string): Promise<void> {
  while (!(existsSync(file) && readFileSync(file, 'utf8').length > 0)) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** End the engine as `mode` says, while its child still runs; `wait` and `own-handler` leave it running until a signal. */
function endAs(mode: string): void {
  if (mode === 'crash') setTimeout(() => {
    throw new Error('the engine crashed');
  }, 0);
  else if (mode === 'exit') process.exit(3);
}

async function engine(mode: string, directory: string): Promise<void> {
  if (mode === 'own-handler') process.on('SIGINT', () => process.exit(42));
  const stdinFile = join(directory, 'stdin');
  writeFileSync(stdinFile, '');
  const pidFile = workerPidFile(directory);
  void runProcess({
    executable: process.execPath,
    args: [processEngine, 'worker', pidFile],
    cwd: directory,
    environment: process.env,
    stdinFile,
    stdoutFile: join(directory, 'stdout'),
    stderrFile: join(directory, 'stderr'),
    timeoutMs: 120_000,
  });
  await waitForFile(pidFile);
  endAs(mode);
}

async function probeEngine(mode: string, directory: string): Promise<void> {
  if (mode === 'own-handler') process.on('SIGINT', () => process.exit(42));
  const pidFile = probeGrandchildPidFile(directory);
  // The preflight's rejection, when the engine lives to see it, is not what the test is about.
  void preflight(claudeAdapter, process.execPath, [fakeHangingProbe], { ...process.env, FAKE_HANG: pidFile }, { timeoutMs: 120_000 }).catch(() => {});
  await waitForFile(pidFile);
  endAs(mode);
}

const [role, ...rest] = process.argv.slice(2);
if (role === 'worker') worker(rest[0]!);
else if (role === 'engine') await engine(rest[0]!, rest[1]!);
else if (role === 'probe-engine') await probeEngine(rest[0]!, rest[1]!);
