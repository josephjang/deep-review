import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FrozenFile } from '../../src/checkpoint/events.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { writeBack, type RestoredFile } from '../../src/review/drift.ts';
import { commitAll, git, repositoryWith, write } from '../helpers/repository.ts';

describe('writeBack', () => {
  let directory: string;
  let repo: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'drift-'));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/gone.ts': 'g\n' });
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const frozen = (text: string): FrozenFile => ({ blob: evidence.put(text) });
  /** A file to write back from what the tree holds to `expected`, null for nothing. */
  const restored = (path: string, before: string | null, expected: string | null): RestoredFile => ({ path, before: before === null ? null : frozen(before), beforeSymlink: false, expected: expected === null ? null : frozen(expected), expectedSymlink: false });
  const writeBackIn = (files: readonly RestoredFile[]) => writeBack(repo, files, (reference) => evidence.read(reference));
  const read = (path: string): string => readFileSync(join(repo, ...path.split('/')), 'utf8');

  it('writes back each file the run expects and removes one it expects absent, leaving none', () => {
    write(repo, 'src/a.ts', 'cut\n');
    rmSync(join(repo, 'src', 'b.ts'));
    write(repo, 'src/new.ts', 'stray\n');
    assert.deepEqual(writeBackIn([restored('src/a.ts', 'cut\n', 'a\n'), restored('src/b.ts', null, 'b\n'), restored('src/new.ts', 'stray\n', null)]), []);
    assert.equal(read('src/a.ts'), 'a\n');
    assert.equal(read('src/b.ts'), 'b\n');
    assert.equal(existsSync(join(repo, 'src', 'new.ts')), false);
  });

  it('leaves a directory where a file is expected, with what it holds, and writes back the files after it', () => {
    rmSync(join(repo, 'src', 'a.ts'));
    write(repo, 'src/a.ts/inner.txt', 'built\n');
    write(repo, 'src/b.ts', 'cut\n');
    assert.deepEqual(writeBackIn([restored('src/a.ts', null, 'a\n'), restored('src/b.ts', 'cut\n', 'b\n')]), [{ path: 'src/a.ts', reason: 'a directory is there' }]);
    assert.equal(read('src/a.ts/inner.txt'), 'built\n');
    assert.equal(read('src/b.ts'), 'b\n');
  });

  it('leaves a file where a parent directory is expected, and writes back the files after it', () => {
    write(repo, 'lib', 'a file\n');
    write(repo, 'src/b.ts', 'cut\n');
    assert.deepEqual(writeBackIn([restored('lib/c.ts', null, 'c\n'), restored('src/b.ts', 'cut\n', 'b\n')]), [{ path: 'lib/c.ts', reason: 'lib is not a directory' }]);
    assert.equal(read('lib'), 'a file\n');
    assert.equal(read('src/b.ts'), 'b\n');
  });

  it('leaves a directory where a file is expected absent', () => {
    mkdirSync(join(repo, 'out', 'nested'), { recursive: true });
    writeFileSync(join(repo, 'out', 'nested', 'x'), 'x');
    assert.deepEqual(writeBackIn([restored('out', null, null)]), [{ path: 'out', reason: 'a directory is there' }]);
    assert.equal(lstatSync(join(repo, 'out')).isDirectory(), true);
  });

  it('writes a regular file the tree holds in place rather than recreating it', () => {
    write(repo, 'src/a.ts', 'cut\n');
    const { ino } = statSync(join(repo, 'src', 'a.ts'), { bigint: true });
    assert.deepEqual(writeBackIn([restored('src/a.ts', 'cut\n', 'a\n')]), []);
    assert.equal(read('src/a.ts'), 'a\n');
    assert.equal(statSync(join(repo, 'src', 'a.ts'), { bigint: true }).ino, ino);
  });

  it('keeps an executable file executable, written in place or written where none was', { skip: process.platform === 'win32' && 'POSIX file modes' }, () => {
    write(repo, 'bin/run.sh', 'run\n');
    write(repo, 'bin/gone.sh', 'gone\n');
    chmodSync(join(repo, 'bin', 'run.sh'), 0o755);
    chmodSync(join(repo, 'bin', 'gone.sh'), 0o755);
    commitAll(repo, 'scripts');
    write(repo, 'bin/run.sh', 'cut\n');
    rmSync(join(repo, 'bin', 'gone.sh'));
    assert.deepEqual(writeBackIn([restored('bin/gone.sh', null, 'gone\n'), restored('bin/run.sh', 'cut\n', 'run\n'), restored('src/b.ts', 'b\n', 'b2\n')]), []);
    assert.notEqual(statSync(join(repo, 'bin', 'gone.sh')).mode & 0o100, 0);
    assert.notEqual(statSync(join(repo, 'bin', 'run.sh')).mode & 0o100, 0);
    assert.equal(statSync(join(repo, 'src', 'b.ts')).mode & 0o111, 0);
    assert.equal(git(repo, 'status', '--porcelain', '--', 'bin'), '');
  });

  it('leaves a file it cannot write, and writes back the files after it', { skip: process.getuid?.() === 0 && 'root writes a read-only file' }, () => {
    const locked = join(repo, 'src', 'a.ts');
    write(repo, 'src/a.ts', 'cut\n');
    write(repo, 'src/b.ts', 'cut\n');
    chmodSync(locked, 0o444);
    try {
      const [left, ...rest] = writeBackIn([restored('src/a.ts', 'cut\n', 'a\n'), restored('src/b.ts', 'cut\n', 'b\n')]);
      assert.equal(left?.path, 'src/a.ts');
      assert.match(left?.reason ?? '', /^writing it failed: /);
      assert.deepEqual(rest, []);
      assert.equal(read('src/a.ts'), 'cut\n');
      assert.equal(read('src/b.ts'), 'b\n');
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it('leaves a file whose bytes in the tree were too large to keep, written over or removed', () => {
    write(repo, 'src/a.ts', 'large\n');
    write(repo, 'src/new.ts', 'large\n');
    const oversized: FrozenFile = { oversized: { sha256: '0'.repeat(64), size: 9 * 1024 * 1024 } };
    const reason = 'its bytes in the tree were too large to have been kept';
    assert.deepEqual(writeBackIn([{ ...restored('src/a.ts', null, 'a\n'), before: oversized }, { ...restored('src/new.ts', null, null), before: oversized }]), [{ path: 'src/a.ts', reason }, { path: 'src/new.ts', reason }]);
    assert.equal(read('src/a.ts'), 'large\n');
    assert.equal(read('src/new.ts'), 'large\n');
  });

  it('leaves a file whose expected bytes were too large to keep', () => {
    write(repo, 'src/a.ts', 'cut\n');
    const file: RestoredFile = { ...restored('src/a.ts', 'cut\n', null), expected: { oversized: { sha256: '0'.repeat(64), size: 9 * 1024 * 1024 } } };
    assert.deepEqual(writeBackIn([file]), [{ path: 'src/a.ts', reason: 'its expected bytes were too large to have been kept' }]);
    assert.equal(read('src/a.ts'), 'cut\n');
  });
});
