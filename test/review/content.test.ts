import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EvidenceStore, sha256Hex } from '../../src/evidence/store.ts';
import { gitContent } from '../../src/review/content.ts';
import type { ExpectedFile, TreeEntry } from '../../src/review/tree.ts';
import { freezeBytes } from '../../src/scope/capture.ts';
import { git, repositoryWith, write } from '../helpers/repository.ts';

const lf = 'one\ntwo\nthree\n';
const crlf = 'one\r\ntwo\r\nthree\r\n';
const file = (text: string, symlink = false): TreeEntry => ({ bytes: Buffer.from(text), symlink });

describe('gitContent', () => {
  let directory: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-content-'));
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const frozen = (text: string, symlink = false): ExpectedFile => ({ frozen: freezeBytes(evidence, Buffer.from(text)), symlink });
  const contentIn = (repo: string) => gitContent(repo, (reference) => evidence.read(reference));

  it('counts a CRLF checkout rewritten to LF as no change under core.autocrlf, and an edit as one', () => {
    const repo = repositoryWith(join(directory, 'repo'), { 'a.txt': lf }, { autocrlf: true });
    const { match } = contentIn(repo);
    assert.equal(match('a.txt', frozen(crlf), file(lf)), true, 'git stores both as the same LF blob');
    assert.equal(match('a.txt', frozen(lf), file(crlf)), true, 'and the other way');
    assert.equal(match('a.txt', frozen(crlf), file('one\ntwo\nTHREE\n')), false);
    assert.equal(match('a.txt', frozen(crlf), null), false, 'a file gone is a change');
    assert.equal(match('a.txt', null, file(lf)), false, 'a file where none was expected is one');
    assert.equal(match('a.txt', null, null), true);
  });

  it('counts line endings as a change where git converts nothing: core.autocrlf off, or the path marked -text', () => {
    const off = repositoryWith(join(directory, 'off'), { 'a.txt': lf }, { autocrlf: false });
    assert.equal(contentIn(off).match('a.txt', frozen(crlf), file(lf)), false);
    const binary = repositoryWith(join(directory, 'binary'), { '.gitattributes': '*.txt -text\n', 'a.txt': crlf }, { autocrlf: true });
    assert.equal(contentIn(binary).match('a.txt', frozen(crlf), file(lf)), false, 'git stores a -text file as it is');
  });

  it('compares a symlink and a file frozen by hash and size as raw bytes only', () => {
    const repo = repositoryWith(join(directory, 'repo'), { 'a.txt': lf }, { autocrlf: true });
    const { match } = contentIn(repo);
    assert.equal(match('link', frozen(crlf, true), file(lf, true)), false, 'a symlink\'s target text is not converted');
    assert.equal(match('a.txt', frozen(crlf), file(lf, true)), false, 'a file turned symlink is a change');
    const big = { frozen: { oversized: { sha256: sha256Hex(Buffer.from(crlf)), size: crlf.length } }, symlink: false } satisfies ExpectedFile;
    assert.equal(match('a.txt', big, file(lf)), false, 'bytes never kept cannot be converted');
    assert.equal(match('a.txt', big, file(crlf)), true, 'but match by hash and size');
  });

  it('asks git only when the raw bytes differ', () => {
    // A directory that does not exist: any git question fails, so a match of equal bytes proves none was asked.
    const { match } = contentIn(join(directory, 'missing'));
    assert.equal(match('a.txt', frozen(lf), file(lf)), true);
    assert.equal(match('a.txt', null, null), true);
    assert.throws(() => match('a.txt', frozen(crlf), file(lf)), /hash-object|ENOENT/);
  });

  it('gives the bytes git would store: LF for a CRLF text under core.autocrlf, the same bytes when nothing converts them', () => {
    const repo = repositoryWith(join(directory, 'repo'), { 'a.txt': lf, 'b.bin': Buffer.from([0, 13, 10, 255]) }, { autocrlf: true });
    const { stored } = contentIn(repo);
    assert.equal(stored('a.txt', Buffer.from(crlf)).toString('utf8'), lf);
    const plainLf = Buffer.from(lf);
    assert.equal(stored('a.txt', plainLf), plainLf, 'unconverted bytes come back as they are, nothing written');
    const binary = Buffer.from([0, 13, 10, 255]);
    assert.deepEqual(stored('b.bin', binary), binary, 'a binary file is stored as it is');
    // The converted blob was written, unreferenced, to the object store; nothing in the tree or the index changed.
    assert.equal(git(repo, 'status', '--porcelain'), '');
    write(repo, 'a.txt', crlf);
    assert.equal(git(repo, 'diff', '--name-only'), '', 'git itself sees the CRLF file as unchanged');
  });
});
