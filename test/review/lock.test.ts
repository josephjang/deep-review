import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { acquireRunLock, lockHolder, lockPath, releaseOnExit, unwrittenLockGraceMs } from '../../src/review/lock.ts';
import { until } from '../helpers/launcher.ts';

/** A pid no process has: above the largest pid Linux, macOS and Windows hand out. */
const deadPid = 999_999_999;

const lockHeld = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && error.code === 'lock-held' && pattern.test(error.message);

describe('the run lock', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-lock-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a second engine while a live process holds the lock, and replaces a lock whose process is gone', () => {
    // A lock held by a live process (this one) refuses another engine.
    const release = acquireRunLock(root, 'r1', process.pid);
    try {
      assert.throws(() => acquireRunLock(root, 'r1', deadPid), lockHeld(/is running run r1/));
    } finally {
      release();
    }
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the release removed the lock');
    // A lock whose process is gone is replaced.
    writeFileSync(lockPath(root, 'r1'), `${String(deadPid)}\n`);
    const taken = acquireRunLock(root, 'r1');
    assert.equal(lockHolder(lockPath(root, 'r1')), process.pid);
    taken();
    assert.equal(lockHolder(lockPath(root, 'r1')), null);
  });

  it('replaces a lock that holds no pid once it is older than the grace an engine has to write its pid', () => {
    const path = lockPath(root, 'r1');
    acquireRunLock(root, 'r1')();
    for (const text of ['', '\n', 'not a pid\n', '-5\n', '0\n']) {
      writeFileSync(path, text);
      const old = (Date.now() - unwrittenLockGraceMs - 60_000) / 1000;
      utimesSync(path, old, old);
      const taken = acquireRunLock(root, 'r1');
      assert.equal(lockHolder(path), process.pid, JSON.stringify(text));
      taken();
    }
  });

  it('refuses while a lock that holds no pid is younger than the grace, since an engine may be writing it', () => {
    const path = lockPath(root, 'r1');
    acquireRunLock(root, 'r1')();
    writeFileSync(path, '');
    assert.throws(() => acquireRunLock(root, 'r1'), lockHeld(/another engine is taking the lock of run r1/));
    assert.equal(lockHolder(path), null, 'the young lock is left alone');
  });
});

/**
 * A process that takes run r1's lock under `root`, hooks its release to the
 * process's end, says "held" and waits. With a signal as `end`, it then
 * emits that signal's event itself, which is how a Windows console's Ctrl-C
 * reaches it; with `exit`, it exits without releasing the lock itself.
 */
function lockHoldingProcess(root: string, end: NodeJS.Signals | 'exit' | null): { child: ReturnType<typeof spawn>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; held: Promise<void> } {
  const lock = pathToFileURL(resolve(import.meta.dirname, '../../src/review/lock.ts')).href;
  const code = [
    `import { acquireRunLock, releaseOnExit } from ${JSON.stringify(lock)};`,
    `releaseOnExit(acquireRunLock(${JSON.stringify(root)}, 'r1'));`,
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

  it('releases the lock when the process exits without releasing it', async () => {
    const holder = lockHoldingProcess(root, 'exit');
    await holder.held;
    assert.equal((await holder.closed).code, 0);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the lock is gone');
  });

  it('releases the lock and ends the process with 128 + the signal number when the signal event arrives', async () => {
    const holder = lockHoldingProcess(root, 'SIGINT');
    await holder.held;
    const { code } = await holder.closed;
    assert.equal(code, 130);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the lock is gone');
  });

  it('releases the lock when a real SIGTERM ends the engine', { skip: process.platform === 'win32' ? 'Windows delivers no SIGTERM to a process; it is terminated outright' : false }, async () => {
    const holder = lockHoldingProcess(root, null);
    await holder.held;
    await until(() => lockHolder(lockPath(root, 'r1')) === holder.child.pid, 'the child holding the lock');
    holder.child.kill('SIGTERM');
    const { code } = await holder.closed;
    assert.equal(code, 143);
    assert.equal(lockHolder(lockPath(root, 'r1')), null, 'the lock is gone');
  });
});
