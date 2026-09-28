import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { acquireRunLock, acquireStartLock, holderPath, lockHolder, lockPath, releaseOnExit, startLockPath } from '../../src/review/lock.ts';
import { blockerActions } from '../../src/review/vocabulary.ts';
import { until } from '../helpers/launcher.ts';

const lockHeld = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && error.code === 'lock-held' && pattern.test(error.message);

/** Whether the run lock is free: this process can take it, and it is let go again at once. */
function runLockFree(root: string, runId: string): boolean {
  try {
    acquireRunLock(root, runId)();
    return true;
  } catch (error) {
    if (error instanceof ReviewRefusedError) return false;
    throw error;
  }
}

describe('the run lock', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-lock-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a second holder in this same process, naming this process, and is free again once released', () => {
    const release = acquireRunLock(root, 'r1');
    try {
      assert.equal(lockHolder(lockPath(root, 'r1')), process.pid, 'the side file names the holder');
      assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(new RegExp(`^engine ${String(process.pid)} is running run r1 \\(lock .*r1\\.lock\\); ${blockerActions['lock-held']}$`)));
      assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/is running run r1/), 'a refusal leaves the lock held');
    } finally {
      release();
    }
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the release removed the side file');
    assert.equal(existsSync(lockPath(root, 'r1')), true, 'the lock file itself is never deleted');
    assert.equal(statSync(lockPath(root, 'r1')).size, 0, 'the lock file holds nothing');
    assert.equal(runLockFree(root, 'r1'), true);
  });

  it('releases at most once: a second call leaves a later holder alone', () => {
    const first = acquireRunLock(root, 'r1');
    first();
    const second = acquireRunLock(root, 'r1');
    try {
      first();
      assert.equal(lockHolder(lockPath(root, 'r1')), process.pid, 'the later holder keeps its side file');
      assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/is running run r1/), 'the later holder keeps its lock');
    } finally {
      second();
    }
    assert.equal(runLockFree(root, 'r1'), true);
  });

  it('names another engine when the side file is missing or names no pid', () => {
    const release = acquireRunLock(root, 'r1');
    try {
      rmSync(holderPath(lockPath(root, 'r1')));
      assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/^another engine is running run r1 \(lock /));
      for (const text of ['', '\n', 'not a pid\n', '-5\n', '0\n', '1.5\n']) {
        writeFileSync(holderPath(lockPath(root, 'r1')), text);
        assert.equal(lockHolder(lockPath(root, 'r1')), null, JSON.stringify(text));
        assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/^another engine is running run r1 /), JSON.stringify(text));
      }
    } finally {
      release();
    }
  });

  it('takes the start lock apart from any run lock, and refuses it while another holder has it', () => {
    const run = acquireRunLock(root, 'r1');
    const start = acquireStartLock(root);
    try {
      assert.equal(lockHolder(startLockPath(root)), process.pid, 'a held run lock does not stop the start lock');
      assert.throws(() => acquireStartLock(root), lockHeld(new RegExp(`^engine ${String(process.pid)} is starting or ending a run in this repository`)));
      const other = acquireRunLock(root, 'r2');
      other();
    } finally {
      start();
    }
    assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/is running run r1/), 'releasing the start lock leaves the run lock held');
    run();
    acquireStartLock(root)();
    assert.equal(lockHolder(startLockPath(root)), null);
  });

  it('refuses a file that is no lock this engine made, and leaves it as it is', () => {
    writeFileSync(startLockPath(root), '12345\n');
    assert.throws(() => acquireStartLock(root), (error: unknown) => error instanceof ReviewRefusedError && error.code === null && /start\.lock is not a lock this engine made/.test(error.message));
    assert.equal(lockHolder(startLockPath(root)), null, 'no side file was written');
    assert.equal(readFileSync(startLockPath(root), 'utf8'), '12345\n', 'the file is left as it was');
    rmSync(startLockPath(root));
    acquireStartLock(root)();
  });
});

/**
 * A process that takes run r1's lock under `root`, hooks its release to the
 * process's end unless `hooked` is false, says "held" and waits. With a
 * signal as `end`, it then emits that signal's event itself, which is how a
 * Windows console's Ctrl-C reaches it; with `exit`, it exits without
 * releasing the lock itself; with null, it waits until it is killed.
 */
function lockHoldingProcess(root: string, end: NodeJS.Signals | 'exit' | null, hooked = true): { child: ReturnType<typeof spawn>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; held: Promise<void> } {
  const lock = pathToFileURL(resolve(import.meta.dirname, '../../src/review/lock.ts')).href;
  const take = `acquireRunLock(${JSON.stringify(root)}, 'r1')`;
  const code = [
    `import { acquireRunLock, releaseOnExit } from ${JSON.stringify(lock)};`,
    // Held on globalThis so the connection that holds the lock is never collected.
    `globalThis.release = ${hooked ? `releaseOnExit(${take})` : take};`,
    "process.stdout.write('held\\n');",
    'setInterval(() => {}, 1000);',
    ...(end === null ? [] : [end === 'exit' ? 'setTimeout(() => process.exit(0), 50);' : `setTimeout(() => process.emit(${JSON.stringify(end)}, ${JSON.stringify(end)}), 50);`]),
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const held = new Promise<void>((done) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('held')) done();
    });
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once('close', (exitCode, signal) => done({ code: exitCode, signal })));
  return { child, closed, held };
}

describe('the run lock held by another process', { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-lock-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses this process, naming the holder, and frees the lock when the holder is killed outright', async () => {
    const holder = lockHoldingProcess(root, null, false);
    try {
      await holder.held;
      assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(new RegExp(`^engine ${String(holder.child.pid)} is running run r1 `)));
    } finally {
      holder.child.kill('SIGKILL');
    }
    await holder.closed;
    assert.equal(lockHolder(lockPath(root, 'r1')), holder.child.pid, 'a killed holder leaves its side file, so the pid it names is only best effort');
    const release = acquireRunLock(root, 'r1');
    assert.equal(lockHolder(lockPath(root, 'r1')), process.pid, 'the next holder names itself');
    release();
  });
});

describe('releasing the run lock however the engine ends', { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-lock-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('releases once however often it is called, and removes its listeners', () => {
    const before = { exit: process.listenerCount('exit'), SIGINT: process.listenerCount('SIGINT') };
    let releases = 0;
    const ended: NodeJS.Signals[] = [];
    const release = releaseOnExit(() => {
      releases += 1;
    }, (signal) => ended.push(signal));
    assert.equal(process.listenerCount('exit'), before.exit + 1);
    assert.equal(process.listenerCount('SIGINT'), before.SIGINT + 1);
    release();
    release();
    assert.equal(releases, 1);
    assert.deepEqual(ended, []);
    assert.deepEqual({ exit: process.listenerCount('exit'), SIGINT: process.listenerCount('SIGINT') }, before, 'no listener is left behind');
  });

  it('releases a real lock through its hooks, after which the lock is free and no listener is left', () => {
    const before = { exit: process.listenerCount('exit'), SIGINT: process.listenerCount('SIGINT') };
    const release = releaseOnExit(acquireRunLock(root, 'r1'));
    assert.equal(runLockFree(root, 'r1'), false);
    release();
    release();
    assert.equal(runLockFree(root, 'r1'), true);
    assert.deepEqual({ exit: process.listenerCount('exit'), SIGINT: process.listenerCount('SIGINT') }, before, 'no listener is left behind');
  });

  it('releases the lock when the process exits without releasing it', async () => {
    const holder = lockHoldingProcess(root, 'exit');
    await holder.held;
    assert.equal((await holder.closed).code, 0);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the exit listener released the lock and removed the side file');
    assert.equal(runLockFree(root, 'r1'), true);
  });

  it('releases the lock and ends the process with 128 + the signal number when the signal event arrives', async () => {
    const holder = lockHoldingProcess(root, 'SIGINT');
    await holder.held;
    const { code } = await holder.closed;
    assert.equal(code, 130);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the signal listener released the lock and removed the side file');
    assert.equal(runLockFree(root, 'r1'), true);
  });

  it('releases the lock when a real SIGTERM ends the engine', { skip: process.platform === 'win32' ? 'Windows delivers no SIGTERM to a process; it is terminated outright' : false }, async () => {
    const holder = lockHoldingProcess(root, null);
    await holder.held;
    await until(() => lockHolder(lockPath(root, 'r1')) === holder.child.pid, 'the child holding the lock');
    holder.child.kill('SIGTERM');
    const { code } = await holder.closed;
    assert.equal(code, 143);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the signal listener released the lock and removed the side file');
    assert.equal(runLockFree(root, 'r1'), true);
  });
});
