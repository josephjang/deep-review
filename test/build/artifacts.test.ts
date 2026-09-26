import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  artifactTargets,
  assembleArtifact,
  assertUnderDist,
  compareTrees,
  digestTree,
  publishArtifact,
  type ArtifactTarget,
} from '../../src/build/artifacts.ts';

/** Bytes a naive text copy would damage: CRLF, a NUL, and non-ASCII. */
const awkwardBytes = Buffer.from('line one\r\nline two\n\0é\n', 'utf8');

const write = (root: string, path: string, content: Buffer | string): void => {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
};

describe('digestTree', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deep-review-digest-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists every file with forward-slash paths, sorted, hashed by content', () => {
    write(root, 'b.txt', 'b');
    write(root, 'nested/deeper/a.txt', 'a');
    write(root, 'nested/z.bin', awkwardBytes);
    const digest = digestTree(root);
    assert.deepEqual([...digest.keys()], ['b.txt', 'nested/deeper/a.txt', 'nested/z.bin']);
    // sha256 of the single byte "a"
    assert.equal(digest.get('nested/deeper/a.txt'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    assert.notEqual(digest.get('b.txt'), digest.get('nested/deeper/a.txt'));
  });

  it('returns an empty digest for an empty directory', () => {
    assert.equal(digestTree(root).size, 0);
  });

  it('ignores empty directories, which an install cannot represent', () => {
    mkdirSync(join(root, 'empty'));
    assert.equal(digestTree(root).size, 0);
  });

  it('throws when the root does not exist', () => {
    assert.throws(() => digestTree(join(root, 'absent')), /does not exist/);
  });

  it('refuses a symlink instead of guessing what it would be after install', (t) => {
    write(root, 'real.txt', 'x');
    try {
      symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    } catch (error) {
      // Windows without Developer Mode denies symlink creation; nothing to test then.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    assert.throws(() => digestTree(root), /Unsupported entry/);
  });
});

describe('compareTrees', () => {
  const digest = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

  it('reports nothing for identical trees', () => {
    assert.deepEqual(compareTrees(digest({ 'a': '1', 'b': '2' }), digest({ 'b': '2', 'a': '1' })), []);
  });

  it('reports nothing for two empty trees', () => {
    assert.deepEqual(compareTrees(digest({}), digest({})), []);
  });

  it('classifies missing, extra and changed paths, sorted by path', () => {
    const differences = compareTrees(digest({ 'z': '1', 'a': '1', 'm': '1' }), digest({ 'z': '1', 'a': '2', 'q': '1' }));
    assert.deepEqual(differences, [
      { path: 'a', kind: 'changed' },
      { path: 'm', kind: 'missing' },
      { path: 'q', kind: 'extra' },
    ]);
  });

  it('treats an empty expected tree as making every actual file extra', () => {
    assert.deepEqual(compareTrees(digest({}), digest({ 'x': '1' })), [{ path: 'x', kind: 'extra' }]);
  });
});

describe('assembleArtifact and publishArtifact', () => {
  let repository: string;
  let staging: string;
  const target: ArtifactTarget = { name: 'sample', source: 'skill/sample', destination: 'dist/sample' };

  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), 'deep-review-repo-'));
    staging = join(repository, '.staging');
  });
  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  it('copies the source tree byte for byte into staging', () => {
    write(repository, 'skill/sample/SKILL.md', awkwardBytes);
    write(repository, 'skill/sample/agents/openai.yaml', 'interface: {}\n');
    const staged = assembleArtifact(repository, target, staging);
    assert.equal(staged, join(staging, 'sample'));
    assert.deepEqual(readFileSync(join(staged, 'SKILL.md')), awkwardBytes);
    assert.deepEqual(compareTrees(digestTree(join(repository, 'skill/sample')), digestTree(staged)), []);
  });

  it('stages an empty source as an empty artifact', () => {
    mkdirSync(join(repository, 'skill/sample'), { recursive: true });
    const staged = assembleArtifact(repository, target, staging);
    assert.equal(digestTree(staged).size, 0);
  });

  it('refuses a missing source and an already used staging directory', () => {
    assert.throws(() => assembleArtifact(repository, target, staging), /source does not exist/);
    write(repository, 'skill/sample/SKILL.md', 'x');
    assembleArtifact(repository, target, staging);
    assert.throws(() => assembleArtifact(repository, target, staging), /already exists/);
  });

  it('replaces the destination wholesale, so a stale file does not survive a rebuild', () => {
    write(repository, 'skill/sample/SKILL.md', 'new');
    write(repository, 'dist/sample/SKILL.md', 'old');
    write(repository, 'dist/sample/stale.md', 'gone');
    const staged = assembleArtifact(repository, target, staging);
    publishArtifact(repository, target, staged);
    assert.equal(readFileSync(join(repository, 'dist/sample/SKILL.md'), 'utf8'), 'new');
    assert.equal(existsSync(join(repository, 'dist/sample/stale.md')), false);
    assert.equal(existsSync(staged), false, 'the staged tree is moved, not copied');
  });

  it('creates dist when it does not exist yet', () => {
    write(repository, 'skill/sample/SKILL.md', 'x');
    const staged = assembleArtifact(repository, target, staging);
    publishArtifact(repository, target, staged);
    assert.equal(readFileSync(join(repository, 'dist/sample/SKILL.md'), 'utf8'), 'x');
  });

  it('refuses to publish a staged tree that does not exist', () => {
    assert.throws(() => publishArtifact(repository, target, join(staging, 'sample')), /Staged artifact does not exist/);
  });

  it('never deletes outside dist, whatever the target says', () => {
    write(repository, 'skill/sample/SKILL.md', 'x');
    write(repository, 'precious.txt', 'keep');
    const staged = assembleArtifact(repository, target, staging);
    for (const destination of ['.', 'dist', 'dist/../precious.txt', 'skill', '../elsewhere', 'dist/..']) {
      assert.throws(() => publishArtifact(repository, { ...target, destination }, staged), /must be a directory under/, destination);
    }
    assert.equal(readFileSync(join(repository, 'precious.txt'), 'utf8'), 'keep');
  });
});

describe('assertUnderDist', () => {
  const repository = join(tmpdir(), 'repo');

  it('accepts a directory strictly inside dist', () => {
    assertUnderDist(repository, join(repository, 'dist', 'claude'));
    assertUnderDist(repository, join(repository, 'dist', 'a', 'b'));
  });

  it('rejects dist itself, its parents, siblings and absolute escapes', () => {
    for (const destination of [join(repository, 'dist'), repository, join(repository, 'skill'), join(repository, 'dist', '..', 'skill'), '/']) {
      assert.throws(() => assertUnderDist(repository, destination), /must be a directory under/, destination);
    }
  });
});

describe('artifactTargets', () => {
  it('declares one target per runtime with distinct names and destinations under dist', () => {
    const names = artifactTargets.map((target) => target.name);
    assert.deepEqual(names, ['claude', 'codex']);
    assert.equal(new Set(artifactTargets.map((target) => target.destination)).size, names.length);
    for (const target of artifactTargets) {
      assert.match(target.source, /^skill\/[a-z]+$/, target.name);
      assert.match(target.destination, /^dist\/[a-z]+$/, target.name);
      assert.doesNotThrow(() => assertUnderDist('/repo', join('/repo', target.destination)));
    }
  });
});
