import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFileExclusive, writeFileAtomic } from '../src/atomic-write.ts';

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

  it('writes each replace under a temporary name of its own', () => {
    const temporaries: string[] = [];
    const rename = (from: string, to: string): void => {
      temporaries.push(from);
      renameSync(from, to);
    };
    writeFileAtomic(file, 'one\n', rename);
    writeFileAtomic(file, 'two\n', rename);
    assert.equal(temporaries.length, 2);
    assert.notEqual(temporaries[0], temporaries[1]);
    assert.ok(temporaries.every((temporary) => temporary.endsWith('.tmp')));
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

describe('createFileExclusive', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-exclusive-')));
    file = join(directory, 'marker.json');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  /** A link that fails with `code`, counting its calls. */
  const refusing = (code: string) => {
    const calls = { count: 0 };
    const link = (): void => {
      calls.count += 1;
      throw Object.assign(new Error(`${code}: link`), { code });
    };
    return { calls, link };
  };

  it('creates a file once and leaves an existing one as it is, leaving no temporary file', () => {
    assert.equal(createFileExclusive(file, 'one\n'), true);
    assert.equal(createFileExclusive(file, 'two\n'), false);
    assert.equal(readFileSync(file, 'utf8'), 'one\n');
    assert.deepEqual(readdirSync(directory), ['marker.json']);
  });

  it('gives the file its name only once its content is whole, so a writer killed before that leaves no file under the name', () => {
    const seen: { content: string; named: boolean }[] = [];
    const link = (from: string, to: string): void => {
      seen.push({ content: readFileSync(from, 'utf8'), named: existsSync(to) });
      linkSync(from, to);
    };
    assert.equal(createFileExclusive(file, '{"whole":true}\n', link), true);
    assert.deepEqual(seen, [{ content: '{"whole":true}\n', named: false }]);
    assert.deepEqual(readdirSync(directory), ['marker.json']);
  });

  it('creates the file under wx where the file system has no hard links, still once', () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
      rmSync(file, { force: true });
      const { calls, link } = refusing(code);
      assert.equal(createFileExclusive(file, `${code}\n`, link), true, code);
      assert.equal(createFileExclusive(file, 'again\n', link), false, code);
      assert.equal(calls.count, 2, code);
      assert.equal(readFileSync(file, 'utf8'), `${code}\n`, code);
      assert.deepEqual(readdirSync(directory), ['marker.json'], code);
    }
  });

  it('writes each creation under a temporary name of its own, so two claimants sharing a pid never share one', () => {
    const temporaries: string[] = [];
    const link = (from: string, to: string): void => {
      temporaries.push(from);
      linkSync(from, to);
    };
    assert.equal(createFileExclusive(file, 'one\n', link), true);
    rmSync(file);
    assert.equal(createFileExclusive(file, 'two\n', link), true);
    assert.equal(temporaries.length, 2);
    assert.notEqual(temporaries[0], temporaries[1]);
    for (const temporary of temporaries) assert.ok(temporary.startsWith(`${file}.${String(process.pid)}.`) && temporary.endsWith('.tmp'), temporary);
    assert.deepEqual(readdirSync(directory), ['marker.json']);
  });

  it('throws any other link error, creating nothing and removing the temporary file', () => {
    assert.throws(() => createFileExclusive(file, 'x\n', refusing('EIO').link), { code: 'EIO' });
    assert.deepEqual(readdirSync(directory), []);
  });
});
