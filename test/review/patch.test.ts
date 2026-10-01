import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EvidenceStore, sha256Hex } from '../../src/evidence/store.ts';
import { gitBlobId, renderMail, renderPatch } from '../../src/review/patch.ts';
import { applyRevision, expectedTree, type ExpectedFile, type RevisedFile } from '../../src/review/tree.ts';
import { freezeBytes, freezeLimitBytes } from '../../src/scope/capture.ts';
import { git, repositoryWith } from '../helpers/repository.ts';

describe('renderPatch', () => {
  let directory: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deep-review-patch-'));
    evidence = new EvidenceStore(join(directory, 'evidence'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const read = (reference: { sha256: string; bytes: number }): Buffer => evidence.read(reference);
  const frozen = (content: string | Buffer, symlink = false): ExpectedFile => ({ frozen: freezeBytes(evidence, Buffer.from(content)), symlink });
  const tree = (files: Record<string, ExpectedFile | null>): Map<string, ExpectedFile | null> => new Map(Object.entries(files));

  it('writes a modification as git does: headers, a full index line and hunks with three lines of context', () => {
    const before = tree({ 'src/a.ts': frozen('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n') });
    const after = tree({ 'src/a.ts': frozen('1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n') });
    assert.equal(renderPatch(before, after, ['src/a.ts'], read), [
      'diff --git a/src/a.ts b/src/a.ts\n',
      `index ${gitBlobId(Buffer.from('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'), 'sha1')}..${gitBlobId(Buffer.from('1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n'), 'sha1')} 100644\n`,
      '--- a/src/a.ts\n',
      '+++ b/src/a.ts\n',
      '@@ -2,7 +2,7 @@\n',
      ' 2\n', ' 3\n', ' 4\n', '-5\n', '+five\n', ' 6\n', ' 7\n', ' 8\n',
    ].join(''));
  });

  it('writes a creation and a deletion with their modes and /dev/null, and the missing final line feed', () => {
    const before = tree({ gone: frozen('bye\n') });
    const after = tree({ gone: null, fresh: frozen('no newline') });
    const patch = renderPatch(before, after, ['gone', 'fresh'], read);
    assert.equal(patch, [
      'diff --git a/fresh b/fresh\n', 'new file mode 100644\n', `index ${'0'.repeat(40)}..${gitBlobId(Buffer.from('no newline'), 'sha1')}\n`, '--- /dev/null\n', '+++ b/fresh\n', '@@ -0,0 +1,1 @@\n', '+no newline\n', '\\ No newline at end of file\n',
      'diff --git a/gone b/gone\n', 'deleted file mode 100644\n', `index ${gitBlobId(Buffer.from('bye\n'), 'sha1')}..${'0'.repeat(40)}\n`, '--- a/gone\n', '+++ /dev/null\n', '@@ -1,1 +0,0 @@\n', '-bye\n',
    ].join(''));
  });

  it('gives nothing for a path both trees hold the same, or neither holds', () => {
    const same = frozen('x\n');
    assert.equal(renderPatch(tree({ a: same }), tree({ a: same }), ['a', 'b'], read), '');
  });

  it('writes a file that is not UTF-8 text as a literal binary patch, and one frozen by hash and size as a line that names it', () => {
    const binary = renderPatch(tree({ 'img.bin': frozen(Buffer.from([0xff, 0x00, 0x01])) }), tree({ 'img.bin': frozen(Buffer.from([0xff, 0x00, 0x02, 0x03])) }), ['img.bin'], read);
    assert.match(binary, /^diff --git a\/img\.bin b\/img\.bin\nindex [0-9a-f]{40}\.\.[0-9a-f]{40} 100644\nGIT binary patch\nliteral 4\n.+\n\nliteral 3\n.+\n\n$/);
    const big = Buffer.alloc(freezeLimitBytes + 1, 1);
    const oversized: ExpectedFile = { frozen: { oversized: { sha256: sha256Hex(big), size: big.length } }, symlink: false };
    assert.equal(renderPatch(tree({}), tree({ 'big.bin': oversized }), ['big.bin'], read), 'diff --git a/big.bin b/big.bin\nnew file mode 100644\nBinary files /dev/null and b/big.bin differ\n');
  });

  it('writes a symlink with its mode, and a change between a file and a symlink as a deletion and a creation', () => {
    const patch = renderPatch(tree({ p: frozen('old target\n') }), tree({ p: frozen('target', true) }), ['p'], read);
    assert.match(patch, /^diff --git a\/p b\/p\ndeleted file mode 100644\n[\s\S]*\ndiff --git a\/p b\/p\nnew file mode 120000\n[\s\S]*\+target\n\\ No newline at end of file\n$/);
  });

  it('replaces the whole file in one hunk when the edit is past the search limit, which still applies', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `old ${String(index)}\n`).join('');
    const after = Array.from({ length: 2500 }, (_, index) => `new ${String(index)}\n`).join('');
    const patch = renderPatch(tree({ f: frozen(before) }), tree({ f: frozen(after) }), ['f'], read);
    assert.match(patch, /\n@@ -1,2500 \+1,2500 @@\n/);
  });

  describe('a series applied with git am', () => {
    it('applies in order to a checkout at the scope, and leaves the tree equal to the final revisions byte for byte', () => {
      const initial: Record<string, Buffer> = {
        'modified.txt': Buffer.from(Array.from({ length: 40 }, (_, index) => `line ${String(index)}\n`).join('')),
        'deleted.txt': Buffer.from('to be deleted\n'),
        'crlf.txt': Buffer.from('one\r\ntwo\r\nthree\r\n'),
        'binary.bin': Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80]),
        'noeol.txt': Buffer.from('last line without a newline'),
        'many.txt': Buffer.from(Array.from({ length: 600 }, (_, index) => `row ${String(index)}\n`).join('')),
      };
      const repo = repositoryWith(join(directory, 'repo'), initial);
      // The scope is the committed tree; three revisions follow it.
      const scope = { files: Object.entries(initial).map(([path, bytes]) => ({ path, status: 'modified' as const, symlink: false, before: null, after: freezeBytes(evidence, bytes) })) };
      const change = (path: string, bytes: Buffer | null): RevisedFile => (bytes === null ? { path, status: 'deleted', symlink: false, after: null } : { path, status: 'modified', symlink: false, after: freezeBytes(evidence, bytes) });
      const revisions: RevisedFile[][] = [
        [
          change('modified.txt', Buffer.from(initial['modified.txt']!.toString().replace('line 3\n', 'line three\n').replace('line 30\n', 'line thirty\nline thirty-one\n'))),
          { path: 'new/created.txt', status: 'created', symlink: false, after: freezeBytes(evidence, Buffer.from('created\n')) },
          change('deleted.txt', null),
        ],
        [
          change('crlf.txt', Buffer.from('one\r\nTWO\r\nthree\r\n')),
          change('binary.bin', Buffer.from([0x00, 0xff, 0xfe, 0x11, 0x80, 0x81])),
          change('noeol.txt', Buffer.from('last line without a newline\nand one more')),
        ],
        [change('many.txt', Buffer.from(Array.from({ length: 600 }, (_, index) => (index % 7 === 0 ? `ROW ${String(index)}\n` : `row ${String(index)}\n`)).join('')))],
      ];
      const state = expectedTree(scope, []);
      const patches = revisions.map((files, index) => {
        const before = new Map(state);
        applyRevision(state, files);
        return renderMail({ subject: `fix: revision ${String(index + 1)}`, body: index === 0 ? 'Why it changed.\n\n---\nA line that would end the message.' : '' }, index + 1, revisions.length, renderPatch(before, state, files.map((file) => file.path), read));
      });
      const files = patches.map((text, index) => {
        const file = join(directory, `${String(index + 1).padStart(4, '0')}.patch`);
        writeFileSync(file, text);
        return file;
      });
      execFileSync('git', ['am', '--keep-cr', '--whitespace=nowarn', ...files], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const [path, expected] of state) {
        const bytes = expected === null ? null : read((expected.frozen as { blob: { sha256: string; bytes: number } }).blob);
        if (bytes === null) assert.throws(() => readFileSync(join(repo, path)), /ENOENT/, path);
        else assert.deepEqual(readFileSync(join(repo, path)), bytes, path);
      }
      assert.equal(git(repo, 'status', '--porcelain'), '', 'every change was committed by git am');
      assert.deepEqual(git(repo, 'log', '--format=%s', '-3').split('\n'), ['fix: revision 3', 'fix: revision 2', 'fix: revision 1']);
      assert.match(git(repo, 'log', '--format=%B', '-1', 'HEAD~2'), /Why it changed\.\n\n ---\nA line that would end the message\./);
    });
  });
});

describe('gitBlobId', () => {
  it('names a blob as git hash-object does', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deep-review-blob-'));
    try {
      const file = join(directory, 'x');
      writeFileSync(file, 'hello\r\n\0bytes');
      assert.equal(gitBlobId(readFileSync(file), 'sha1'), execFileSync('git', ['hash-object', '--no-filters', file], { encoding: 'utf8' }).trim());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('renderMail', () => {
  it('numbers the subject, encodes one that is not ASCII, and keeps a body line that would end the message', () => {
    const mail = renderMail({ subject: 'fix(ä): Résumé', body: '---\ndiff --git a/x b/x\nplain' }, 2, 5, 'DIFF\n');
    assert.match(mail, /^From 0{40} Mon Sep 17 00:00:00 2001\nFrom: deep-review <deep-review@deep-review\.invalid>\nSubject: \[PATCH 2\/5\] =\?UTF-8\?q\?fix=28=C3=A4=29=3A_R=C3=A9sum=C3=A9\?=\n/);
    assert.ok(mail.includes('\n\n ---\n diff --git a/x b/x\nplain\n---\nDIFF\n-- \n'), mail);
    assert.ok(renderMail({ subject: 'fix: plain', body: '' }, 1, 1, 'DIFF\n').includes('Content-Transfer-Encoding: 8bit\n\n---\nDIFF\n'));
  });
});
