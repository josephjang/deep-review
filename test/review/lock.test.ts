import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { acquireRunLock, lockHolder, lockPath, unwrittenLockGraceMs } from '../../src/review/lock.ts';

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
