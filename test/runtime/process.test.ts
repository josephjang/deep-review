import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { killTree, notStarted, runProcess, type ProcessRequest } from '../../src/runtime/process.ts';
import { isAlive, until } from '../helpers/launcher.ts';
import { processEngine, workerPidFile, type WorkerPids } from '../helpers/process-engine.ts';

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
    rmSync(directory, { recursive: true, force: true });
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
