import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { guardResultFile, parseGuardRequest, readGuardResult, type GuardRequest, type GuardResult } from '../../src/runtime/process.ts';
import { isAlive, until } from '../helpers/launcher.ts';
import { processEngine, workerPidFile, type WorkerPids } from '../helpers/process-engine.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');

/** End a process the test started, if it is still there. */
function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Start `node <entry> guard <request>` as `runProcess` does: detached, its
 * standard input a pipe the test holds and its output the files given.
 */
function startGuard(entry: string, requestFile: string, stdoutFile: string, stderrFile: string): { guard: ChildProcess; ended: Promise<number | null>; end: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const stdout = openSync(stdoutFile, 'wx');
  const stderr = openSync(stderrFile, 'wx');
  try {
    const guard = spawn(process.execPath, [entry, 'guard', requestFile], { stdio: ['pipe', stdout, stderr], windowsHide: true, detached: true });
    const end = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => guard.once('close', (code, signal) => done({ code, signal })));
    return { guard, ended: end.then(({ code }) => code), end };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

describe('the guard', { timeout: 120_000 }, () => {
  let directory: string;
  beforeEach(() => {
    // Real, so a child's working directory reads as the test spells it where the temp directory is a link, as on macOS.
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-guard-')));
    writeFileSync(join(directory, 'stdin'), 'the prompt');
  });
  afterEach(() => {
    // A process killed by a test may hold the directory's files a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const requestFile = (): string => join(directory, 'stdout.guard.json');
  const writeRequest = (request: Partial<GuardRequest>): string => {
    const file = requestFile();
    writeFileSync(file, JSON.stringify({ executable: process.execPath, args: [], cwd: directory, stdinFile: join(directory, 'stdin'), verbatimArguments: false, ...request }));
    return file;
  };
  const result = (): GuardResult => JSON.parse(readFileSync(guardResultFile(requestFile()), 'utf8')) as GuardResult;
  const start = (file: string): ReturnType<typeof startGuard> => startGuard(cli, file, join(directory, 'stdout'), join(directory, 'stderr'));

  it('runs the child with the request\'s input, writes how it ended, and exits with its code, or on POSIX ends with its process group', async () => {
    const file = writeRequest({ args: ['-e', 'process.stdout.write(require("fs").readFileSync(0, "utf8").toUpperCase() + " " + process.cwd()); process.exit(7)'] });
    const { end } = start(file);
    assert.deepEqual(await end, process.platform === 'win32' ? { code: 7, signal: null } : { code: null, signal: 'SIGKILL' });
    assert.deepEqual(result(), { termination: 'exited', exitCode: 7, signal: null });
    assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), `THE PROMPT ${directory}`);
    assert.equal(existsSync(`${guardResultFile(file)}.partial`), false, 'the result is written through a rename');
  });

  it('gives the child its own environment, so no variable goes to the request file', async () => {
    const file = writeRequest({ args: ['-e', 'process.stdout.write(process.env.GUARD_TEST_SECRET ?? "none")'] });
    const stdout = openSync(join(directory, 'stdout'), 'wx');
    const guard = spawn(process.execPath, [cli, 'guard', file], { stdio: ['pipe', stdout, 'ignore'], windowsHide: true, detached: true, env: { ...process.env, GUARD_TEST_SECRET: 'kept in memory' } });
    closeSync(stdout);
    await new Promise((done) => guard.once('close', done));
    assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'kept in memory');
    assert.ok(!readFileSync(file, 'utf8').includes('kept in memory'));
  });

  it('writes not-started for a child that cannot start, and for a request it cannot read', async () => {
    const missing = writeRequest({ executable: join(directory, 'no-such-executable') });
    const first = start(missing);
    assert.equal(await first.ended, 1);
    const spawnFailure = result();
    assert.equal(spawnFailure.termination, 'not-started');
    assert.match(spawnFailure.termination === 'not-started' ? spawnFailure.error : '', /ENOENT/);
    rmSync(guardResultFile(missing));
    rmSync(join(directory, 'stdout'));
    rmSync(join(directory, 'stderr'));
    writeFileSync(requestFile(), JSON.stringify({ executable: process.execPath }));
    const second = start(requestFile());
    assert.equal(await second.ended, 1);
    const unreadable = result();
    assert.equal(unreadable.termination, 'not-started');
    assert.match(unreadable.termination === 'not-started' ? unreadable.error : '', /^the guard could not prepare the child: the guard request does not hold/);
  });

  it('kills the child\'s tree and writes no result when its standard input closes before the child ends, as when the engine is killed', async () => {
    const pidFile = workerPidFile(directory);
    const { guard, ended } = start(writeRequest({ args: [processEngine, 'worker', pidFile] }));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 'the worker to start');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as WorkerPids;
    try {
      assert.equal(pids.parent, guard.pid);
      guard.stdin!.end();
      await ended;
      await until(() => !isAlive(pids.worker), `worker ${String(pids.worker)} to die`, 10_000);
      await until(() => !isAlive(pids.grandchild), `grandchild ${String(pids.grandchild)} to die`, 10_000);
      assert.equal(existsSync(guardResultFile(requestFile())), false);
    } finally {
      reap(pids.worker);
      reap(pids.grandchild);
    }
  });

  it('ends what the child left behind once the child ends, with its job object on Windows and its process group on POSIX (R8 of resumable runs)', async () => {
    const pidFile = join(directory, 'grandchild.pid');
    // The child starts a grandchild in its own job or group, as a test runner does, and exits.
    const leave = `const { spawn } = require("child_process"); const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid)); grandchild.unref();`;
    const { ended } = start(writeRequest({ args: ['-e', leave] }));
    await ended;
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    try {
      assert.deepEqual(result(), { termination: 'exited', exitCode: 0, signal: null });
      await until(() => !isAlive(grandchild), `grandchild ${String(grandchild)} to die`, 10_000);
    } finally {
      reap(grandchild);
    }
  });

  it('refuses to run with anything but one request file', () => {
    const refused = spawnSync(process.execPath, [cli, 'guard'], { encoding: 'utf8', windowsHide: true });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /one request file/);
  });
});

describe('parseGuardRequest', () => {
  const valid: GuardRequest = { executable: 'node', args: ['-e', ''], cwd: '/tmp', stdinFile: '/tmp/stdin', verbatimArguments: false };

  it('reads a whole request, and nothing beyond its fields', () => {
    assert.deepEqual(parseGuardRequest(JSON.stringify({ ...valid, extra: 'ignored' })), valid);
  });

  it('refuses a request with a field missing or of the wrong type', () => {
    for (const broken of [null, [], { ...valid, executable: 1 }, { ...valid, args: ['-e', 2] }, { ...valid, args: '-e' }, { ...valid, cwd: undefined }, { ...valid, stdinFile: null }, { ...valid, verbatimArguments: 'no' }]) {
      assert.throws(() => parseGuardRequest(JSON.stringify(broken)), /the guard request does not hold/, JSON.stringify(broken));
    }
    assert.throws(() => parseGuardRequest('not json'), SyntaxError);
  });
});

describe('readGuardResult', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-guard-result-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads how the child ended, or that it never started', () => {
    const file = join(directory, 'result');
    writeFileSync(file, JSON.stringify({ termination: 'exited', exitCode: 3, signal: null }));
    assert.deepEqual(readGuardResult(file), { termination: 'exited', exitCode: 3, signal: null });
    writeFileSync(file, JSON.stringify({ termination: 'not-started', error: 'spawn ENOENT' }));
    assert.deepEqual(readGuardResult(file), { termination: 'not-started', error: 'spawn ENOENT' });
  });

  it('reads no result, as a guard a kill ended, from no file or one that holds no end of a child, rather than throw', () => {
    assert.equal(readGuardResult(join(directory, 'absent')), null);
    const file = join(directory, 'result');
    for (const text of ['', '{"termination":"exi', 'null', '[]', '{"termination":"exited"}', '{"termination":"exited","exitCode":"3","signal":null}', '{"termination":"not-started"}', '{"termination":"killed","exitCode":1,"signal":null}']) {
      writeFileSync(file, text);
      assert.equal(readGuardResult(file), null, text);
    }
  });
});
