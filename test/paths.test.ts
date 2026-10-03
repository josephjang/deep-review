import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { canonicalPath, isFile, isInside, linkTargetText } from '../src/paths.ts';

describe('path containment', () => {
  let sandbox: string;
  let parent: string;

  before(() => {
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-paths-')));
    parent = join(sandbox, 'roles');
    mkdirSync(join(parent, 'fragments'), { recursive: true });
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe('canonicalPath', () => {
    it('returns an existing directory as the file system names it', () => {
      assert.equal(canonicalPath(join(parent, 'fragments')), join(parent, 'fragments'));
    });

    it('appends a missing tail as written to its longest existing ancestor', () => {
      assert.equal(canonicalPath(join(parent, 'missing', 'deeper')), join(parent, 'missing', 'deeper'));
    });

    it('resolves a relative path against the working directory', () => {
      const spelled = relative(process.cwd(), join(parent, 'missing'));
      assert.equal(canonicalPath(spelled), join(parent, 'missing'));
    });

    it('resolves a link in an existing ancestor, even beneath a missing tail', () => {
      // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a symlink.
      const alias = join(sandbox, 'roles-link');
      symlinkSync(parent, alias, 'junction');
      assert.equal(canonicalPath(alias), parent);
      assert.equal(canonicalPath(join(alias, 'missing', 'deeper')), join(parent, 'missing', 'deeper'));
    });

    it('treats a path beneath a regular file as a missing tail under that file', () => {
      const file = join(sandbox, 'plain-file');
      writeFileSync(file, 'x');
      assert.equal(canonicalPath(join(file, 'child')), join(file, 'child'));
    });

    it('matches the case the file system stores on Windows', (t) => {
      if (process.platform !== 'win32') return t.skip('case-insensitive names are a Windows file system property');
      assert.equal(canonicalPath(join(sandbox, 'ROLES', 'Missing')), join(parent, 'Missing'));
    });
  });

  describe('isInside', () => {
    it('counts the parent itself as inside', () => {
      assert.equal(isInside(parent, parent), true);
    });

    it('counts an existing child and a missing nested child as inside', () => {
      assert.equal(isInside(parent, join(parent, 'fragments')), true);
      assert.equal(isInside(parent, join(parent, 'missing', 'deeper')), true);
    });

    it('does not count a sibling whose name starts with the parent name', () => {
      assert.equal(isInside(parent, join(sandbox, 'roles-assembled')), false);
      assert.equal(isInside(parent, join(sandbox, 'roles2', 'fragments')), false);
    });

    it('judges by whole segments, so a child named ..tmp is inside and the parent of the parent is not', () => {
      assert.equal(isInside(parent, join(parent, '..tmp')), true);
      assert.equal(isInside(parent, sandbox), false);
      assert.equal(isInside(parent, join(parent, '..', 'elsewhere')), false);
    });

    it('does not count the parent as inside its own child', () => {
      assert.equal(isInside(join(parent, 'fragments'), parent), false);
    });

    it('catches a child reached through a link into the parent', () => {
      const alias = join(sandbox, 'into-roles');
      symlinkSync(parent, alias, 'junction');
      assert.equal(isInside(parent, join(alias, 'fragments', 'prompts')), true);
      assert.equal(isInside(alias, join(parent, 'fragments')), true);
    });

    it('ignores case on Windows, as its file system does', (t) => {
      if (process.platform !== 'win32') return t.skip('case-insensitive names are a Windows file system property');
      assert.equal(isInside(parent, join(sandbox, 'ROLES', 'Fragments', 'prompts')), true);
      assert.equal(isInside(join(sandbox, 'Roles'), join(parent, 'missing')), true);
      assert.equal(isInside(parent, join(sandbox, 'ROLES-assembled')), false);
    });
  });
});

describe('isFile', () => {
  let sandbox: string;

  before(() => {
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-is-file-')));
    mkdirSync(join(sandbox, 'directory'));
    writeFileSync(join(sandbox, 'file'), 'x');
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('is true for a regular file', () => {
    assert.equal(isFile(join(sandbox, 'file')), true);
  });

  it('is false, without throwing, for a directory, a missing path and a path beneath a file', () => {
    assert.equal(isFile(join(sandbox, 'directory')), false);
    assert.equal(isFile(join(sandbox, 'missing')), false, 'ENOENT');
    assert.equal(isFile(join(sandbox, 'file', 'child')), false, 'ENOTDIR on POSIX, ENOENT on Windows');
  });

  it('follows a symlink to its target, so a link to a file is a file and a link to a directory or to nothing is not', (t) => {
    try {
      symlinkSync(join(sandbox, 'file'), join(sandbox, 'file-link'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    symlinkSync(join(sandbox, 'directory'), join(sandbox, 'directory-link'), 'dir');
    symlinkSync(join(sandbox, 'missing'), join(sandbox, 'dangling-link'), 'file');
    assert.equal(isFile(join(sandbox, 'file-link')), true);
    assert.equal(isFile(join(sandbox, 'directory-link')), false);
    assert.equal(isFile(join(sandbox, 'dangling-link')), false);
  });
});

describe('linkTargetText', () => {
  it('reads a Windows link target with forward slashes, as git records it', () => {
    assert.equal(linkTargetText('src\\a.ts', 'win32'), 'src/a.ts');
    assert.equal(linkTargetText('..\\up\\b.ts', 'win32'), '../up/b.ts');
  });

  it('keeps a target as written elsewhere, where a backslash is part of a name', () => {
    assert.equal(linkTargetText('src\\a.ts', 'linux'), 'src\\a.ts');
    assert.equal(linkTargetText('src/a.ts', 'darwin'), 'src/a.ts');
  });

  it('leaves a target with no separator alone on every platform', () => {
    assert.equal(linkTargetText('target.txt', 'win32'), 'target.txt');
    assert.equal(linkTargetText('', 'win32'), '');
  });
});
