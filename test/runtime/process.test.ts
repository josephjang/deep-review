import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { killMarkWords, killTree, notStarted, runProcess, type ProcessRequest } from '../../src/runtime/process.ts';
import { isAlive, until } from '../helpers/launcher.ts';
import { probeGrandchildPidFile, processEngine, workerPidFile, type WorkerPids } from '../helpers/process-engine.ts';

const posix = process.platform !== 'win32';

/** End a process the test started, if it is still there. */
function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** A process that runs until it is killed, outside any process group the code under test would address. */
function victim(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
}

describe('runProcess', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-process-'));
    writeFileSync(join(directory, 'stdin'), 'the prompt');
  });
  afterEach(() => {
    // A process killed by a test may hold the directory's files a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const request = (args: string[], overrides: Partial<ProcessRequest> = {}): ProcessRequest => ({
    executable: process.execPath,
    args,
    cwd: directory,
    environment: process.env,
    stdinFile: join(directory, 'stdin'),
    stdoutFile: join(directory, 'stdout'),
    stderrFile: join(directory, 'stderr'),
    timeoutMs: 60_000,
    ...overrides,
  });

  it('runs a process to its own end, with stdin from the file and both streams captured', async () => {
    const script = 'process.stdout.write(require("fs").readFileSync(0, "utf8").toUpperCase()); process.stderr.write("err"); process.exit(3)';
    const result = await runProcess(request(['-e', script]));
    assert.equal(result.termination, 'exited');
    assert.equal(result.exitCode, 3);
    assert.equal(result.signal, null);
    assert.ok(result.startedAt <= result.endedAt);
    assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'THE PROMPT');
    assert.equal(readFileSync(join(directory, 'stderr'), 'utf8'), 'err');
  });

  it('reports a process that could not be started, with the reason', async () => {
    const result = await runProcess(request([], { executable: join(directory, 'no-such-executable') }));
    assert.equal(result.termination, 'not-started');
    assert.match(result.termination === 'not-started' ? result.error : '', /ENOENT/);
  });

  it('reports a process whose working directory does not exist as one that could not be started', async () => {
    const result = await runProcess(request(['-e', ''], { cwd: join(directory, 'missing') }));
    assert.equal(result.termination, 'not-started');
    assert.match(result.termination === 'not-started' ? result.error : '', /ENOENT/);
  });

  it('runs the process under a guard, and leaves none of the guard\'s files behind (R8 of resumable runs)', async () => {
    const result = await runProcess(request(['-e', 'process.stdout.write(String(process.ppid))']));
    assert.equal(result.termination, 'exited');
    assert.equal(result.exitCode, 0);
    const parent = Number(readFileSync(join(directory, 'stdout'), 'utf8'));
    assert.ok(parent > 0 && parent !== process.pid, `the parent of the process is its guard, not the engine: ${String(parent)}`);
    assert.deepEqual(readdirSync(directory).sort(), ['stderr', 'stdin', 'stdout']);
  });

  it('gives a process whose guard a kill from outside ended no exit code and no signal, and ends what the guard held (R8 of resumable runs)', async () => {
    const pidFile = workerPidFile(directory);
    const running = runProcess(request([processEngine, 'worker', pidFile]));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 'the worker to start');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as WorkerPids;
    try {
      process.kill(pids.parent, 'SIGKILL');
      const result = await running;
      assert.deepEqual([result.termination, result.exitCode, result.signal], ['exited', null, null]);
      // Windows ends a process killed by its pid with exit code 1, and reports no signal.
      assert.deepEqual(result.termination === 'exited' ? result.guardEnd : 'not exited', posix ? { exitCode: null, signal: 'SIGKILL' } : { exitCode: 1, signal: null });
      assert.equal(killMarkWords(result), posix ? 'no result from its guard, which ended by signal SIGKILL' : 'no result from its guard, which exited with code 1');
      // The guard's job ends the worker on Windows; on POSIX the engine kills the group the guard led, the grandchild with it.
      await until(() => !isAlive(pids.worker), `worker ${String(pids.worker)} to die`, 10_000);
      if (posix) await until(() => !isAlive(pids.grandchild), `grandchild ${String(pids.grandchild)} to die`, 10_000);
      assert.deepEqual(readdirSync(directory).sort(), ['pids.json', 'stderr', 'stdin', 'stdout']);
    } finally {
      reap(pids.worker);
      reap(pids.grandchild);
    }
  });

  it('keeps the exit of a guard that exited by itself with no result, such as one whose preload cannot load (R8 of resumable runs)', async () => {
    const missing = join(directory, 'no-such-preload.cjs').replaceAll('\\', '/');
    const result = await runProcess(request(['-e', ''], { environment: { ...process.env, NODE_OPTIONS: `--require ${missing}` } }));
    assert.deepEqual([result.termination, result.exitCode, result.signal], ['exited', null, null], 'still read as no result from its guard');
    assert.deepEqual(result.termination === 'exited' ? result.guardEnd : 'not exited', { exitCode: 1, signal: null });
    assert.equal(killMarkWords(result), 'no result from its guard, which exited with code 1');
    assert.match(readFileSync(join(directory, 'stderr'), 'utf8'), /no-such-preload\.cjs/);
  });

  it('starts the guard in the engine\'s directory, so a relative preload of NODE_OPTIONS resolves for it as for the engine', async () => {
    const engineDirectory = join(directory, 'engine');
    mkdirSync(engineDirectory);
    writeFileSync(join(engineDirectory, 'preload.cjs'), 'globalThis.preloaded = true;\n');
    const before = process.cwd();
    process.chdir(engineDirectory);
    try {
      // The child runs in the same directory, so the preload resolves for it too; only the guard's directory is under test.
      const result = await runProcess(request(['-e', 'process.stdout.write(String(globalThis.preloaded))'], { cwd: engineDirectory, environment: { ...process.env, NODE_OPTIONS: '--require ./preload.cjs' } }));
      assert.deepEqual([result.termination, result.exitCode, result.signal], ['exited', 0, null], readFileSync(join(directory, 'stderr'), 'utf8'));
      assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'true');
    } finally {
      process.chdir(before);
    }
  });

  it('records no guard end for a process whose guard left a result', async () => {
    const result = await runProcess(request(['-e', 'process.exit(143)']));
    assert.deepEqual([result.termination, result.exitCode, result.signal], ['exited', 143, null]);
    assert.equal(result.termination === 'exited' ? result.guardEnd : 'not exited', undefined);
  });

  it('kills the process with its whole tree at the timeout and says the whole tree was reached', async () => {
    const pidFile = workerPidFile(directory);
    const result = await runProcess(request([processEngine, 'worker', pidFile], { timeoutMs: 1500 }));
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as WorkerPids;
    try {
      assert.equal(result.termination, 'killed');
      assert.equal(result.termination === 'killed' ? result.treeKillError : 'not killed', null);
      await until(() => !isAlive(pids.grandchild), `grandchild ${String(pids.grandchild)} to die`, 10_000);
    } finally {
      reap(pids.grandchild);
    }
  });

  it('listens for the engine ending only while a worker is live', async () => {
    const signals = posix ? (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) : [];
    const before = { exit: process.listenerCount('exit'), signals: signals.map((signal) => process.listenerCount(signal)) };
    const marker = join(directory, 'go');
    const running = runProcess(request(['-e', `const fs = require("fs"); const wait = () => fs.existsSync(${JSON.stringify(marker)}) || setTimeout(wait, 20); wait()`]));
    await until(() => process.listenerCount('exit') === before.exit + 1, 'the exit listener');
    assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before.signals.map((count) => count + 1));
    writeFileSync(marker, '');
    assert.equal((await running).termination, 'exited');
    assert.equal(process.listenerCount('exit'), before.exit);
    assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before.signals);
  });

  it('refuses output files that already exist, before anything runs', async () => {
    writeFileSync(join(directory, 'stdout'), 'earlier');
    await assert.rejects(runProcess(request(['-e', ''])), /EEXIST/);
    assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'earlier');
  });
});

describe('notStarted', () => {
  it('describes a process that never existed, ending now unless told when', () => {
    const startedAt = '2026-09-27T00:00:00.000Z';
    assert.deepEqual(notStarted('spawn ENOENT', startedAt, startedAt), { termination: 'not-started', exitCode: null, signal: null, error: 'spawn ENOENT', startedAt, endedAt: startedAt });
    const before = new Date().toISOString();
    const now = notStarted('refused', startedAt);
    assert.ok(now.endedAt >= before && now.endedAt <= new Date().toISOString(), now.endedAt);
  });
});

describe('killTree', () => {
  it('does not kill by a pid whose process already exited, since the pid may name another process by now', async () => {
    // The victim stands for an unrelated process that was given the exited worker's pid.
    const unrelated = victim();
    try {
      let rootKills = 0;
      const exited = { pid: unrelated.pid, exitCode: 0, signalCode: null, kill: () => ++rootKills > 0 };
      assert.deepEqual(await killTree(exited), { status: 'not-running' });
      assert.deepEqual(await killTree({ ...exited, exitCode: null, signalCode: 'SIGTERM' }), { status: 'not-running' });
      assert.equal(rootKills, 0);
      assert.equal(isAlive(unrelated.pid!), true);
    } finally {
      reap(unrelated.pid);
    }
  });

  it('does nothing for a process that never got a pid', async () => {
    assert.deepEqual(await killTree({ pid: undefined, exitCode: null, signalCode: null, kill: () => true }), { status: 'not-running' });
  });

  it('ends the root and records why when the tree kill fails', async () => {
    // POSIX: a child outside its own process group has no group to kill.
    // Windows: taskkill cannot be found under a SystemRoot without it.
    const root = victim();
    await new Promise((resolve) => root.once('spawn', resolve));
    const systemRoot = process.env.SystemRoot;
    const empty = mkdtempSync(join(tmpdir(), 'deep-review-no-taskkill-'));
    if (!posix) process.env.SystemRoot = empty;
    try {
      const closed = new Promise((resolve) => root.once('close', resolve));
      const result = await killTree(root);
      assert.equal(result.status, 'root-only');
      assert.match(result.status === 'root-only' ? result.error : '', posix ? /ESRCH/ : /taskkill/);
      // The fallback ended the root: it closes, and its pid no longer names a live process.
      await closed;
      assert.equal(isAlive(root.pid!), false);
    } finally {
      if (!posix) process.env.SystemRoot = systemRoot;
      rmSync(empty, { recursive: true, force: true });
      reap(root.pid);
    }
  });
});

describe('an engine that ends while a worker runs', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-engine-'));
  });
  afterEach(() => {
    // A process killed by a test may hold the directory's files a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Start the stand-in engine and wait until its worker and grandchild run. */
  async function start(mode: string): Promise<{ engine: ChildProcess; ended: Promise<[number | null, string | null]>; pids: WorkerPids }> {
    const engine = spawn(process.execPath, [processEngine, 'engine', mode, directory], { stdio: 'ignore', windowsHide: true });
    const ended = new Promise<[number | null, string | null]>((resolve) => engine.once('exit', (code, signal) => resolve([code, signal])));
    const pidFile = workerPidFile(directory);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 'the worker to start');
    return { engine, ended, pids: JSON.parse(readFileSync(pidFile, 'utf8')) as WorkerPids };
  }

  /** The worker, its grandchild and its guard all die; whatever is left is reaped so no test leaks a process. */
  async function assertTreeDies(pids: WorkerPids): Promise<void> {
    try {
      await until(() => !isAlive(pids.worker), `worker ${String(pids.worker)} to die`, 10_000);
      await until(() => !isAlive(pids.grandchild), `grandchild ${String(pids.grandchild)} to die`, 10_000);
      await until(() => !isAlive(pids.parent), `guard ${String(pids.parent)} to die`, 10_000);
    } finally {
      reap(pids.worker);
      reap(pids.grandchild);
      reap(pids.parent);
    }
  }

  it('kills the worker tree through its guard when the engine is killed outright, which runs no handler (R8 of resumable runs)', async () => {
    const { engine, ended, pids } = await start('wait');
    engine.kill('SIGKILL');
    assert.deepEqual(await ended, [null, 'SIGKILL']);
    await assertTreeDies(pids);
  });

  it('kills the worker tree when the engine crashes', async () => {
    const { ended, pids } = await start('crash');
    assert.deepEqual(await ended, [1, null]);
    await assertTreeDies(pids);
  });

  it('kills the worker tree when the engine exits while it runs', async () => {
    const { ended, pids } = await start('exit');
    assert.deepEqual(await ended, [3, null]);
    await assertTreeDies(pids);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    it(`kills the worker tree on ${signal} and still ends the engine by that signal`, { skip: !posix && 'POSIX signals only' }, async () => {
      const { engine, ended, pids } = await start('wait');
      engine.kill(signal);
      assert.deepEqual(await ended, [null, signal]);
      await assertTreeDies(pids);
    });
  }

  it('leaves the ending to an engine that handles the signal itself, and still kills the tree', { skip: !posix && 'POSIX signals only' }, async () => {
    const { engine, ended, pids } = await start('own-handler');
    engine.kill('SIGINT');
    assert.deepEqual(await ended, [42, null]);
    await assertTreeDies(pids);
  });
});

describe('an engine that ends while a preflight probe runs', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-probe-engine-'));
  });
  afterEach(() => {
    // A process killed by a test may hold the directory's files a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Start the stand-in engine and wait until its hanging probe has started a grandchild. */
  async function start(mode: string): Promise<{ engine: ChildProcess; ended: Promise<[number | null, string | null]>; grandchild: number }> {
    const engine = spawn(process.execPath, [processEngine, 'probe-engine', mode, directory], { stdio: 'ignore', windowsHide: true });
    const ended = new Promise<[number | null, string | null]>((resolve) => engine.once('exit', (code, signal) => resolve([code, signal])));
    const pidFile = probeGrandchildPidFile(directory);
    await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0, 'the probe to start its grandchild');
    return { engine, ended, grandchild: Number(readFileSync(pidFile, 'utf8')) };
  }

  /** The probe's grandchild, which escapes a kill that reaches only the probe, dies; it is reaped either way. */
  async function assertGrandchildDies(grandchild: number): Promise<void> {
    try {
      await until(() => !isAlive(grandchild), `grandchild ${String(grandchild)} to die`, 10_000);
    } finally {
      reap(grandchild);
    }
  }

  it('kills the probe tree when the engine exits while the probe hangs', async () => {
    const { ended, grandchild } = await start('exit');
    assert.deepEqual(await ended, [3, null]);
    await assertGrandchildDies(grandchild);
  });

  it('kills the probe tree on SIGINT and still ends the engine by that signal', { skip: !posix && 'POSIX signals only' }, async () => {
    const { engine, ended, grandchild } = await start('wait');
    engine.kill('SIGINT');
    assert.deepEqual(await ended, [null, 'SIGINT']);
    await assertGrandchildDies(grandchild);
  });
});
