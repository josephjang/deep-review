import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { countLines, matchScopePath, normalizeFileName, normalizeLocations, worktreeLookup, type RepoLookup } from '../../src/review/locations.ts';
import { freezeLimitBytes } from '../../src/scope/capture.ts';

const reference = { sha256: 'a'.repeat(64), bytes: 1 };
const blob = { blob: reference };

/** A scope over four files: two with the same tail, one deleted, one oversized; the worktree holds their after bytes. */
const scope: ScopeState = {
  mode: 'worktree',
  request: { paths: [] },
  base: '1'.repeat(40),
  head: '2'.repeat(40),
  files: [
    { path: 'lib/src/a.ts', status: 'modified', symlink: false, before: blob, after: blob },
    { path: 'src/a.ts', status: 'modified', symlink: false, before: blob, after: blob },
    { path: 'src/gone.ts', status: 'deleted', symlink: false, before: blob, after: null },
    { path: 'assets/huge.bin', status: 'added', symlink: false, before: null, after: { oversized: { sha256: 'b'.repeat(64), size: freezeLimitBytes + 1 } } },
    { path: 'docs/Guide.md', status: 'added', symlink: false, before: null, after: blob },
  ],
  patch: reference,
};
const paths = scope.files.map((file) => file.path);

/** A lookup over a fixed set of repo-relative paths, standing in for the worktree; like it, it ignores case. */
const repoOf =
  (...files: string[]): RepoLookup =>
  (path) =>
    files.some((file) => file.toLowerCase() === path.toLowerCase());
const emptyRepo = repoOf();

describe('normalizeFileName', () => {
  it('turns backslashes into slashes and drops a leading ./ and repeated slashes', () => {
    assert.equal(normalizeFileName('src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeFileName('./src//a.ts'), 'src/a.ts');
    assert.equal(normalizeFileName('././a.ts'), 'a.ts');
    assert.equal(normalizeFileName('C:\\repo\\src\\a.ts'), 'C:/repo/src/a.ts');
  });
});

describe('matchScopePath', () => {
  it('matches the exact path, with backslashes, and with an absolute prefix', () => {
    assert.equal(matchScopePath(paths, 'src/a.ts', emptyRepo), 'src/a.ts');
    assert.equal(matchScopePath(paths, 'src\\a.ts', emptyRepo), 'src/a.ts');
    assert.equal(matchScopePath(paths, '/home/me/repo/src/a.ts', emptyRepo), 'src/a.ts');
    assert.equal(matchScopePath(paths, 'C:\\Users\\me\\repo\\src\\a.ts', emptyRepo), 'src/a.ts');
    assert.equal(matchScopePath(paths, './src/a.ts', emptyRepo), 'src/a.ts');
  });

  it('prefers the longest scope path when two share a suffix', () => {
    assert.equal(matchScopePath(paths, '/repo/lib/src/a.ts', emptyRepo), 'lib/src/a.ts');
    assert.equal(matchScopePath(paths, 'lib/src/a.ts', emptyRepo), 'lib/src/a.ts');
  });

  it('matches a bare tail only when exactly one scope path ends with it', () => {
    assert.equal(matchScopePath(paths, 'gone.ts', emptyRepo), 'src/gone.ts');
    assert.equal(matchScopePath(paths, 'a.ts', emptyRepo), null, 'two scope paths end with a.ts');
    assert.equal(matchScopePath(paths, 'huge.bin', emptyRepo), 'assets/huge.bin');
  });

  it('falls back to a match without regard to case, exact spelling first', () => {
    assert.equal(matchScopePath(paths, 'docs/guide.md', emptyRepo), 'docs/Guide.md');
    assert.equal(matchScopePath(paths, 'SRC/A.TS', emptyRepo), 'src/a.ts');
    assert.equal(matchScopePath(['a/B.ts', 'a/b.ts'], 'a/b.ts', emptyRepo), 'a/b.ts', 'the exact spelling wins over the case-insensitive one');
  });

  it('matches nothing for a file outside the scope, an empty name, or a partial segment', () => {
    assert.equal(matchScopePath(paths, 'src/b.ts', emptyRepo), null);
    assert.equal(matchScopePath(paths, '', emptyRepo), null);
    assert.equal(matchScopePath(paths, 'rc/a.ts', emptyRepo), null, 'a suffix must start at a segment');
    assert.equal(matchScopePath(paths, 'xsrc/a.ts', emptyRepo), null);
    assert.equal(matchScopePath(paths, 'src/', emptyRepo), null, 'a directory names no file');
  });

  it('never pins a path that names a different file of the repository to a changed path it ends with', () => {
    assert.equal(matchScopePath(['index.ts'], 'src/index.ts', repoOf('index.ts', 'src/index.ts')), null);
    assert.equal(matchScopePath(['src/a.ts'], 'test/src/a.ts', repoOf('src/a.ts', 'test/src/a.ts')), null);
    assert.equal(matchScopePath(['index.ts'], '/home/me/repo/src/index.ts', repoOf('index.ts', 'src/index.ts')), null, 'an absolute path of an unchanged file');
    assert.equal(matchScopePath(['index.ts'], 'C:\\repo\\src\\index.ts', repoOf('index.ts', 'src/index.ts')), null);
  });

  it('does not fold case to pin a path whose file the repository holds under another case', () => {
    assert.equal(matchScopePath(['README.md'], 'docs/readme.md', repoOf('README.md', 'docs/README.md')), null);
    assert.equal(matchScopePath(['README.md'], 'docs/readme.md', emptyRepo), 'README.md', 'no such file: a prefixed spelling of the changed one');
    assert.equal(matchScopePath(['index.ts'], 'src/index.ts', repoOf('index.ts', 'Src/index.ts')), null, 'the unchanged file spelled in another case');
    assert.equal(matchScopePath(['docs/Guide.md'], 'docs/guide.md', repoOf('docs/Guide.md')), 'docs/Guide.md', 'the changed file itself in another case');
  });

  it('matches a bare name to its one changed path only when the repository holds no file of that name at its root', () => {
    assert.equal(matchScopePath(['src/a.ts'], 'a.ts', repoOf('a.ts', 'src/a.ts')), null);
    assert.equal(matchScopePath(['src/a.ts'], 'a.ts', repoOf('src/a.ts')), 'src/a.ts');
  });

  it('still matches a changed path the repository holds, and a prefixed spelling no file of the repository has', () => {
    assert.equal(matchScopePath(['src/a.ts'], 'src/a.ts', repoOf('src/a.ts')), 'src/a.ts');
    assert.equal(matchScopePath(['src/a.ts'], 'b/src/a.ts', repoOf('src/a.ts')), 'src/a.ts', 'a git diff prefix');
    assert.equal(matchScopePath(['src/a.ts'], '../threadfin/src/a.ts', repoOf('src/a.ts')), 'src/a.ts', 'a path through the parent directory');
    assert.equal(matchScopePath(['lib/src/a.ts', 'src/a.ts'], '/repo/lib/src/a.ts', repoOf('lib/src/a.ts', 'src/a.ts')), 'lib/src/a.ts');
  });

  it('matches nothing when two changed paths differ only in case and the name matches both without regard to case', () => {
    assert.equal(matchScopePath(['a/B.ts', 'a/b.ts'], 'A/b.TS', emptyRepo), null);
  });
});

describe('worktreeLookup', () => {
  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'deep-review-lookup-'));
    mkdirSync(join(worktree, 'docs'));
    writeFileSync(join(worktree, 'docs', 'README.md'), 'x');
    writeFileSync(join(worktree, 'index.ts'), 'x');
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('finds a file or a directory by any case of its path', () => {
    const inRepo = worktreeLookup(worktree);
    assert.equal(inRepo('docs/README.md'), true);
    assert.equal(inRepo('docs'), true);
    assert.equal(inRepo('DOCS/readme.md'), true);
    assert.equal(inRepo('index.ts'), true);
  });

  it('finds nothing that is not there, under a missing directory, or through a file', () => {
    const inRepo = worktreeLookup(worktree);
    assert.equal(inRepo('docs/guide.md'), false);
    assert.equal(inRepo('src/index.ts'), false);
    assert.equal(inRepo('index.ts/a.ts'), false);
  });

  it('follows every directory whose name matches without regard to case', () => {
    mkdirSync(join(worktree, 'Lib'));
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'only-lower.ts'), 'x');
    assert.equal(worktreeLookup(worktree)('LIB/only-lower.ts'), true);
  });
});

describe('countLines', () => {
  it('counts line feeds, plus one for a last line without one, and none for an empty file', () => {
    assert.equal(countLines(Buffer.from('')), 0);
    assert.equal(countLines(Buffer.from('a')), 1);
    assert.equal(countLines(Buffer.from('a\n')), 1);
    assert.equal(countLines(Buffer.from('a\nb')), 2);
    assert.equal(countLines(Buffer.from('a\r\nb\r\n')), 2);
    assert.equal(countLines(Buffer.from('\n\n')), 2);
  });
});

describe('normalizeLocations', () => {
  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'deep-review-locations-'));
    for (const [path, content] of [['lib/src/a.ts', 'one\ntwo\nthree\n'], ['src/a.ts', 'one\ntwo'], ['docs/Guide.md', '# guide\n']] as const) {
      mkdirSync(join(worktree, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(worktree, ...path.split('/')), content);
    }
    mkdirSync(join(worktree, 'assets'));
    writeFileSync(join(worktree, 'assets', 'huge.bin'), Buffer.concat([Buffer.alloc(freezeLimitBytes, 0x61), Buffer.from('\n')]));
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('locates a candidate whose file matches and whose line is within the after state', () => {
    const [a, b] = normalizeLocations(scope, worktree, [{ file: '/repo/lib/src/a.ts', line: 3 }, { file: 'src\\a.ts', line: 2 }]);
    assert.deepEqual(a, { file: 'lib/src/a.ts', line: 3, located: true });
    assert.deepEqual(b, { file: 'src/a.ts', line: 2, located: true });
  });

  it('leaves a candidate unlocated past the end of its file, on a deleted file, or on a file outside the scope', () => {
    const results = normalizeLocations(scope, worktree, [{ file: 'src/a.ts', line: 3 }, { file: 'src/gone.ts', line: 1 }, { file: 'src/b.ts', line: 1 }, { file: 'a.ts', line: 1 }]);
    for (const result of results) assert.deepEqual(result, { file: null, line: null, located: false });
    assert.equal(results.length, 4, 'no candidate is dropped');
  });

  it('measures an oversized file from the worktree, the one place its lines can be counted', () => {
    const [inside, past] = normalizeLocations(scope, worktree, [{ file: 'assets/huge.bin', line: 1 }, { file: 'assets/huge.bin', line: 2 }]);
    assert.deepEqual(inside, { file: 'assets/huge.bin', line: 1, located: true });
    assert.deepEqual(past, { file: null, line: null, located: false });
  });

  it('leaves a candidate on an unchanged file of the repository unlocated, though its path ends with a changed one', () => {
    const rooted: ScopeState = { ...scope, files: [{ path: 'index.ts', status: 'modified', symlink: false, before: blob, after: blob }] };
    writeFileSync(join(worktree, 'index.ts'), 'one\ntwo\n');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'index.ts'), 'one\ntwo\n');
    const [unchanged, absolute, changed] = normalizeLocations(rooted, worktree, [
      { file: 'src/index.ts', line: 1 },
      { file: join(worktree, 'src', 'index.ts'), line: 1 },
      { file: join(worktree, 'index.ts'), line: 2 },
    ]);
    assert.deepEqual(unchanged, { file: null, line: null, located: false });
    assert.deepEqual(absolute, { file: null, line: null, located: false });
    assert.deepEqual(changed, { file: 'index.ts', line: 2, located: true });
  });

  it('reads each file once however many candidates point at it', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ file: 'lib/src/a.ts', line: (index % 3) + 1 }));
    const results = normalizeLocations(scope, worktree, many);
    assert.equal(results.length, 50);
    assert.ok(results.every((result) => result.located));
  });
});
