import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFileAtomic } from '../src/atomic-write.ts';

describe('writeFileAtomic', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-atomic-')));
    file = join(directory, 'held.json');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  /** A rename that fails with `code` its first `failures` calls, then renames, counting every call. */
  const failing = (code: string, failures: number) => {
    const calls = { count: 0 };
    const rename = (from: string, to: string): void => {
      calls.count += 1;
      if (calls.count <= failures) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      renameSync(from, to);
    };
    return { calls, rename };
  };

  it('writes a new file and replaces an existing one whole, leaving no temporary file', () => {
    writeFileAtomic(file, 'one\n');
    assert.equal(readFileSync(file, 'utf8'), 'one\n');
    writeFileAtomic(file, 'two\n');
    assert.equal(readFileSync(file, 'utf8'), 'two\n');
    assert.deepEqual(readdirSync(directory), ['held.json']);
  });

  it('retries a replace Windows refuses while another process reads the file, until it goes through', () => {
    writeFileSync(file, 'old\n');
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const { calls, rename } = failing(code, 3);
      writeFileAtomic(file, `${code}\n`, rename);
      assert.equal(calls.count, 4, code);
      assert.equal(readFileSync(file, 'utf8'), `${code}\n`, code);
    }
    assert.deepEqual(readdirSync(directory), ['held.json']);
  });

  it('throws a refusal that outlasts the retries, and any other error at once', () => {
    writeFileSync(file, 'old\n');
    const lasting = failing('EPERM', Number.POSITIVE_INFINITY);
    const started = Date.now();
    assert.throws(() => writeFileAtomic(file, 'new\n', lasting.rename), { code: 'EPERM' });
    assert.ok(lasting.calls.count > 1, 'retried before giving up');
    assert.ok(Date.now() - started < 5000, 'within a bounded time');
    const other = failing('EXDEV', Number.POSITIVE_INFINITY);
    assert.throws(() => writeFileAtomic(file, 'new\n', other.rename), { code: 'EXDEV' });
    assert.equal(other.calls.count, 1);
    assert.equal(readFileSync(file, 'utf8'), 'old\n');
  });
});
