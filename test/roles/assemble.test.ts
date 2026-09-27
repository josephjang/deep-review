import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { sha256Hex } from '../../src/evidence/store.ts';
import { assembleRoles, fragmentsDirectoryName, manifestFileName, readRoleFragment, readRoleManifest } from '../../src/roles/assemble.ts';
import { InvalidRoleFragmentError, InvalidRoleManifestError } from '../../src/roles/errors.ts';

/** Write a roles directory: the manifest as given (an object is serialized, a string is written as is) and each fragment's bytes. */
const seed = (root: string, manifest: object | string, fragments: Record<string, Buffer | string>): void => {
  mkdirSync(join(root, fragmentsDirectoryName), { recursive: true });
  writeFileSync(join(root, manifestFileName), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, content] of Object.entries(fragments)) writeFileSync(join(root, fragmentsDirectoryName, name), content);
};

describe('assembleRoles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deep-review-roles-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('joins each role\'s fragments in manifest order with one blank line and hashes the result', () => {
    seed(root, { schemaVersion: 1, roles: { second: ['b.md', 'a.md'], first: ['a.md'] } }, { 'a.md': 'alpha\nline two\n', 'b.md': 'beta\n' });
    const roles = assembleRoles(root);
    assert.deepEqual(roles.map((role) => role.key), ['second', 'first']);
    assert.equal(roles[0]!.prompt, 'beta\n\nalpha\nline two\n');
    assert.equal(roles[1]!.prompt, 'alpha\nline two\n');
    assert.deepEqual(roles[0]!.fragments, [
      { name: 'b.md', sha256: sha256Hex(Buffer.from('beta\n')) },
      { name: 'a.md', sha256: sha256Hex(Buffer.from('alpha\nline two\n')) },
    ]);
    assert.equal(roles[0]!.sha256, sha256Hex(Buffer.from('beta\n\nalpha\nline two\n')));
    assert.notEqual(roles[0]!.sha256, roles[1]!.sha256);
  });

  it('hashes non-ASCII text by its UTF-8 bytes', () => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': Buffer.from('café\n', 'utf8') });
    const [role] = assembleRoles(root);
    assert.equal(role!.sha256, sha256Hex(Buffer.from('café\n', 'utf8')));
    assert.equal(role!.prompt, 'café\n');
  });

  it('gives every role that shares a fragment the same hash for it', () => {
    seed(root, { schemaVersion: 1, roles: { x: ['a.md'], y: ['a.md', 'b.md'] } }, { 'a.md': 'a\n', 'b.md': 'b\n' });
    const [x, y] = assembleRoles(root);
    assert.equal(x!.fragments[0]!.sha256, y!.fragments[0]!.sha256);
    assert.equal(y!.prompt, 'a\n\nb\n');
  });

  const rejectsManifest = (name: string, manifest: object | string, fragments: Record<string, Buffer | string>, pattern: RegExp): void => {
    it(name, () => {
      seed(root, manifest, fragments);
      assert.throws(() => assembleRoles(root), (error: unknown) => error instanceof InvalidRoleManifestError && pattern.test(error.message));
    });
  };
  rejectsManifest('refuses a manifest that is not JSON', '{ not json', {}, /is not JSON/);
  rejectsManifest('refuses a manifest that fails the schema', { schemaVersion: 1, roles: {} }, {}, /at least one role/);
  rejectsManifest('refuses files under fragments/ that no role names, listing them', { schemaVersion: 1, roles: { r: ['a.md'] } },
    { 'a.md': 'a\n', 'orphan.md': 'o\n', 'notes.txt': 'n\n' }, /no role names: notes\.txt, orphan\.md$/);

  it('refuses a missing manifest', () => {
    assert.throws(() => assembleRoles(root), (error: unknown) => error instanceof InvalidRoleManifestError && /Cannot read the role manifest/.test(error.message));
  });

  it('refuses a missing fragments directory by the first fragment it cannot find', () => {
    writeFileSync(join(root, manifestFileName), JSON.stringify({ schemaVersion: 1, roles: { r: ['a.md'] } }));
    assert.throws(() => assembleRoles(root), (error: unknown) => error instanceof InvalidRoleFragmentError && /a\.md does not exist/.test(error.message));
  });

  it('reports a fragment path that cannot be examined by the failure, not as missing', () => {
    // A NUL in the path makes lstat itself refuse it, a failure that is not ENOENT on every platform.
    assert.throws(() => readRoleFragment(`${root}\0`, 'a.md'), (error: unknown) =>
      error instanceof InvalidRoleFragmentError && error.fragment === 'a.md'
      && /a\.md cannot be read: .*null bytes/.test(error.message) && !/does not exist/.test(error.message));
  });

  it('reports a fragments/ that is a file by the lstat failure, not as missing', (t) => {
    // Windows reports a path through a file as ENOENT; POSIX says ENOTDIR.
    if (process.platform === 'win32') return t.skip('Windows reports a path through a file as missing');
    writeFileSync(join(root, manifestFileName), JSON.stringify({ schemaVersion: 1, roles: { r: ['a.md'] } }));
    writeFileSync(join(root, fragmentsDirectoryName), 'not a directory\n');
    assert.throws(() => assembleRoles(root), (error: unknown) =>
      error instanceof InvalidRoleFragmentError && /a\.md cannot be read: ENOTDIR/.test(error.message));
  });

  it('reports a fragment that cannot be opened by the read failure, not as not UTF-8', (t) => {
    // Windows has no unreadable mode bits and root reads through them; nothing to test then.
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('file modes do not deny reading here');
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'a\n' });
    chmodSync(join(root, fragmentsDirectoryName, 'a.md'), 0o000);
    assert.throws(() => assembleRoles(root), (error: unknown) =>
      error instanceof InvalidRoleFragmentError && /a\.md cannot be read: EACCES/.test(error.message) && !/UTF-8/.test(error.message));
  });

  it('refuses a fragment name that could reach outside fragments/, before touching the file system', () => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'a\n' });
    // Valid fragment text outside fragments/, so only the name check can refuse it.
    writeFileSync(join(root, 'outside.md'), 'outside\n');
    mkdirSync(join(root, fragmentsDirectoryName, 'sub'));
    writeFileSync(join(root, fragmentsDirectoryName, 'sub', 'a.md'), 'a\n');
    for (const name of ['../outside.md', `..${sep}outside.md`, 'sub/a.md', join(root, 'outside.md'), 'A.md', '']) {
      assert.throws(() => readRoleFragment(root, name), (error: unknown) =>
        error instanceof InvalidRoleFragmentError && error.fragment === name && /is not a valid fragment name: a fragment name is lower-case/.test(error.message), name);
    }
  });

  it('refuses a subdirectory under fragments/', () => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'a\n' });
    mkdirSync(join(root, fragmentsDirectoryName, 'nested'));
    assert.throws(() => assembleRoles(root), /no role names: nested$/);
  });

  it('refuses a fragment that is a directory named like a file', () => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, {});
    mkdirSync(join(root, fragmentsDirectoryName, 'a.md'));
    assert.throws(() => assembleRoles(root), (error: unknown) => error instanceof InvalidRoleFragmentError && /a\.md is not a regular file/.test(error.message));
  });

  it('refuses a fragment that is a symlink, even to a valid file', (t) => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'real.md': 'a\n' });
    try {
      symlinkSync(join(root, fragmentsDirectoryName, 'real.md'), join(root, fragmentsDirectoryName, 'a.md'));
    } catch (error) {
      // Windows without Developer Mode denies symlink creation; nothing to test then.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    assert.throws(() => readRoleFragment(root, 'a.md'), /a\.md is not a regular file/);
  });

  describe('fragment invariants', () => {
    const rejectsFragment = (name: string, content: Buffer | string, pattern: RegExp): void => {
      it(`refuses a fragment that ${name}`, () => {
        seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': content });
        assert.throws(() => assembleRoles(root), (error: unknown) =>
          error instanceof InvalidRoleFragmentError && error.fragment === 'a.md' && pattern.test(error.message));
      });
    };
    rejectsFragment('is empty', '', /is empty/);
    rejectsFragment('is not UTF-8', Buffer.from([0x61, 0xff, 0x0a]), /is not UTF-8/);
    rejectsFragment('starts with a byte order mark', '﻿text\n', /byte order mark/);
    rejectsFragment('has CRLF line endings', 'one\r\ntwo\n', /carriage return/);
    rejectsFragment('contains a NUL', 'one\0two\n', /NUL/);
    rejectsFragment('does not end with a newline', 'text', /does not end with a newline/);
    rejectsFragment('ends with a blank line', 'text\n\n', /ends with a blank line/);
    rejectsFragment('ends with a line of spaces', 'text\n  \n', /ends with a blank line/);
    rejectsFragment('ends with a line of tabs and spaces', 'text\n\t \n', /ends with a blank line/);
    rejectsFragment('starts with a blank line', '\ntext\n', /starts with a blank line/);
    rejectsFragment('starts with a line of spaces', '  \ntext\n', /starts with a blank line/);
    rejectsFragment('starts with a line of a tab', '\t\ntext\n', /starts with a blank line/);
    rejectsFragment('is one line of spaces', ' \n', /starts with a blank line/);

    it('accepts leading and trailing spaces on a line that has text', () => {
      seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': '  indented\ntext  \n' });
      assert.equal(assembleRoles(root)[0]!.prompt, '  indented\ntext  \n');
    });
    rejectsFragment('starts with front matter', '---\nmodel: opus\n---\ntext\n', /front matter/);
    rejectsFragment('contains an include marker at a line start', 'text\n<!-- include: references/x.md -->\nmore\n', /include marker/);

    it('accepts an include marker that is not at a line start, which is prose about markers', () => {
      seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'the old <!-- include: x --> syntax\n' });
      assert.equal(assembleRoles(root)[0]!.prompt, 'the old <!-- include: x --> syntax\n');
    });

    it('accepts a fragment whose text has a three-dash line after the first line', () => {
      seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'text\n---\nmore\n' });
      assert.equal(assembleRoles(root)[0]!.prompt, 'text\n---\nmore\n');
    });
  });

  it('exposes readRoleManifest for a caller that needs only the composition', () => {
    seed(root, { schemaVersion: 1, roles: { r: ['a.md'] } }, { 'a.md': 'a\n' });
    assert.deepEqual(readRoleManifest(root).roles, { r: ['a.md'] });
  });
});
