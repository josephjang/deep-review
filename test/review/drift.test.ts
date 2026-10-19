import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FrozenFile } from '../../src/checkpoint/events.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { writeBack, type RestoredFile } from '../../src/review/drift.ts';
import { repositoryWith, write } from '../helpers/repository.ts';

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

  it('leaves a file whose expected bytes were too large to keep', () => {
    write(repo, 'src/a.ts', 'cut\n');
    const file: RestoredFile = { ...restored('src/a.ts', 'cut\n', null), expected: { oversized: { sha256: '0'.repeat(64), size: 9 * 1024 * 1024 } } };
    assert.deepEqual(writeBackIn([file]), [{ path: 'src/a.ts', reason: 'its expected bytes were too large to have been kept' }]);
    assert.equal(read('src/a.ts'), 'cut\n');
  });
});
