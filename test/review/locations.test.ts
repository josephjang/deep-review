import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { countLines, matchRepositoryPath, normalizeFileName, normalizeLocations, worktreeLookup, type PathMatch, type RepoLookup } from '../../src/review/locations.ts';
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

/** A lookup over a fixed set of repo-relative paths, standing in for the worktree; like it, it ignores case and gives each entry's own spelling. */
const repoOf =
  (...files: string[]): RepoLookup =>
  (path) =>
    files.filter((file) => file.toLowerCase() === path.toLowerCase());
const emptyRepo = repoOf();

/** A match on a changed path of the scope. */
const changed = (path: string): PathMatch => ({ path, inScope: true });
/** A match on an unchanged entry of the repository, outside the change. */
const outside = (path: string): PathMatch => ({ path, inScope: false });
const unlocated = { file: null, line: null, located: false, inScope: false };

/** Whether the file system under `directory` tells names apart by case alone. */
function caseSensitive(directory: string): boolean {
  writeFileSync(join(directory, 'case-probe'), '');
  const sensitive = !existsSync(join(directory, 'CASE-PROBE'));
  rmSync(join(directory, 'case-probe'));
  return sensitive;
}

describe('normalizeFileName', () => {
  it('turns backslashes into slashes and drops a leading ./ and repeated slashes', () => {
    assert.equal(normalizeFileName('src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeFileName('./src//a.ts'), 'src/a.ts');
    assert.equal(normalizeFileName('././a.ts'), 'a.ts');
    assert.equal(normalizeFileName('C:\\repo\\src\\a.ts'), 'C:/repo/src/a.ts');
  });
});

describe('matchRepositoryPath', () => {
  it('matches the exact path, with backslashes, and with an absolute prefix', () => {
    assert.deepEqual(matchRepositoryPath(paths, 'src/a.ts', emptyRepo), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(paths, 'src\\a.ts', emptyRepo), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(paths, '/home/me/repo/src/a.ts', emptyRepo), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(paths, 'C:\\Users\\me\\repo\\src\\a.ts', emptyRepo), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(paths, './src/a.ts', emptyRepo), changed('src/a.ts'));
  });

  it('prefers the longest scope path when two share a suffix', () => {
    assert.deepEqual(matchRepositoryPath(paths, '/repo/lib/src/a.ts', emptyRepo), changed('lib/src/a.ts'));
    assert.deepEqual(matchRepositoryPath(paths, 'lib/src/a.ts', emptyRepo), changed('lib/src/a.ts'));
  });

  it('matches a bare tail only when exactly one scope path ends with it', () => {
    assert.deepEqual(matchRepositoryPath(paths, 'gone.ts', emptyRepo), changed('src/gone.ts'));
    assert.equal(matchRepositoryPath(paths, 'a.ts', emptyRepo), null, 'two scope paths end with a.ts');
    assert.deepEqual(matchRepositoryPath(paths, 'huge.bin', emptyRepo), changed('assets/huge.bin'));
  });

  it('falls back to a match without regard to case, exact spelling first', () => {
    assert.deepEqual(matchRepositoryPath(paths, 'docs/guide.md', emptyRepo), changed('docs/Guide.md'));
    assert.deepEqual(matchRepositoryPath(paths, 'SRC/A.TS', emptyRepo), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(['a/B.ts', 'a/b.ts'], 'a/b.ts', emptyRepo), changed('a/b.ts'), 'the exact spelling wins over the case-insensitive one');
  });

  it('matches nothing for a path the repository does not hold, an empty name, or a partial segment', () => {
    assert.equal(matchRepositoryPath(paths, 'src/b.ts', emptyRepo), null);
    assert.equal(matchRepositoryPath(paths, '', emptyRepo), null);
    assert.equal(matchRepositoryPath(paths, 'rc/a.ts', emptyRepo), null, 'a suffix must start at a segment');
    assert.equal(matchRepositoryPath(paths, 'xsrc/a.ts', emptyRepo), null);
    assert.equal(matchRepositoryPath(paths, 'src/', emptyRepo), null, 'a directory names no file');
  });

  it('matches an unchanged file of the repository outside the change, never the changed path it ends with', () => {
    assert.deepEqual(matchRepositoryPath(['index.ts'], 'src/index.ts', repoOf('index.ts', 'src/index.ts')), outside('src/index.ts'));
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], 'test/src/a.ts', repoOf('src/a.ts', 'test/src/a.ts')), outside('test/src/a.ts'));
    assert.deepEqual(matchRepositoryPath(['index.ts'], '/home/me/repo/src/index.ts', repoOf('index.ts', 'src/index.ts')), outside('src/index.ts'), 'an absolute path of an unchanged file');
    assert.deepEqual(matchRepositoryPath(['index.ts'], 'C:\\repo\\src\\index.ts', repoOf('index.ts', 'src/index.ts')), outside('src/index.ts'));
    assert.deepEqual(matchRepositoryPath([], 'src/caller.ts', repoOf('src/caller.ts')), outside('src/caller.ts'), 'with no changed path at all');
  });

  it('gives an unchanged file in the repository\'s own spelling, whatever case the finder used', () => {
    assert.deepEqual(matchRepositoryPath(['README.md'], 'docs/readme.md', repoOf('README.md', 'docs/README.md')), outside('docs/README.md'));
    assert.deepEqual(matchRepositoryPath(['README.md'], 'docs/readme.md', emptyRepo), changed('README.md'), 'no such file: a prefixed spelling of the changed one');
    assert.deepEqual(matchRepositoryPath(['index.ts'], 'src/index.ts', repoOf('index.ts', 'Src/index.ts')), outside('Src/index.ts'), 'the unchanged file spelled in another case');
    assert.deepEqual(matchRepositoryPath(['docs/Guide.md'], 'docs/guide.md', repoOf('docs/Guide.md')), changed('docs/Guide.md'), 'the changed file itself in another case');
    assert.deepEqual(matchRepositoryPath(['docs/Guide.md'], 'docs/guide.md', repoOf('docs/guide.md')), changed('docs/Guide.md'), 'a changed path wins over the worktree\'s spelling of the same file');
  });

  it('matches nothing when the repository holds two entries that differ only in case and the name spells neither exactly', () => {
    const variants = repoOf('Src/a.ts', 'src/A.ts');
    assert.equal(matchRepositoryPath([], 'SRC/a.ts', variants), null);
    assert.equal(matchRepositoryPath(['a.ts'], 'SRC/a.ts', variants), null, 'nor falls back to a changed path its shorter tail names');
    assert.deepEqual(matchRepositoryPath([], 'src/A.ts', variants), outside('src/A.ts'), 'the exact spelling picks one');
  });

  it('matches a bare name to its one changed path only when the repository holds no file of that name at its root', () => {
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], 'a.ts', repoOf('a.ts', 'src/a.ts')), outside('a.ts'));
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], 'a.ts', repoOf('src/a.ts')), changed('src/a.ts'));
  });

  it('still matches a changed path the repository holds, and a prefixed spelling no file of the repository has', () => {
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], 'src/a.ts', repoOf('src/a.ts')), changed('src/a.ts'));
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], 'b/src/a.ts', repoOf('src/a.ts')), changed('src/a.ts'), 'a git diff prefix');
    assert.deepEqual(matchRepositoryPath(['src/a.ts'], '../threadfin/src/a.ts', repoOf('src/a.ts')), changed('src/a.ts'), 'a path through the parent directory');
    assert.deepEqual(matchRepositoryPath(['lib/src/a.ts', 'src/a.ts'], '/repo/lib/src/a.ts', repoOf('lib/src/a.ts', 'src/a.ts')), changed('lib/src/a.ts'));
  });

  it('matches nothing when two changed paths differ only in case and the name matches both without regard to case', () => {
    assert.equal(matchRepositoryPath(['a/B.ts', 'a/b.ts'], 'A/b.TS', emptyRepo), null);
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

  it('finds a file or a directory by any case of its path, in the worktree\'s own spelling', () => {
    const inRepo = worktreeLookup(worktree);
    assert.deepEqual(inRepo('docs/README.md'), ['docs/README.md']);
    assert.deepEqual(inRepo('docs'), ['docs']);
    assert.deepEqual(inRepo('DOCS/readme.md'), ['docs/README.md']);
    assert.deepEqual(inRepo('index.ts'), ['index.ts']);
  });

  it('finds nothing that is not there, under a missing directory, or through a file', () => {
    const inRepo = worktreeLookup(worktree);
    assert.deepEqual(inRepo('docs/guide.md'), []);
    assert.deepEqual(inRepo('src/index.ts'), []);
    assert.deepEqual(inRepo('index.ts/a.ts'), []);
  });

  it('follows every directory whose name matches without regard to case', () => {
    mkdirSync(join(worktree, 'Lib'));
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'only-lower.ts'), 'x');
    const found = worktreeLookup(worktree)('LIB/only-lower.ts');
    assert.equal(found.length, 1, 'only one of the directories holds the file');
    assert.equal(found[0]!.toLowerCase(), 'lib/only-lower.ts');
  });

  it('gives every spelling a case-sensitive file system holds', (context) => {
    if (!caseSensitive(worktree)) {
      context.skip('this file system does not tell names apart by case alone');
      return;
    }
    writeFileSync(join(worktree, 'Index.ts'), 'x');
    assert.deepEqual([...worktreeLookup(worktree)('INDEX.TS')].sort(), ['Index.ts', 'index.ts']);
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

  it('locates a candidate whose file matches a changed path and whose line is within the after state, in scope', () => {
    const [a, b] = normalizeLocations(scope, worktree, [{ file: '/repo/lib/src/a.ts', line: 3 }, { file: 'src\\a.ts', line: 2 }]);
    assert.deepEqual(a, { file: 'lib/src/a.ts', line: 3, located: true, inScope: true });
    assert.deepEqual(b, { file: 'src/a.ts', line: 2, located: true, inScope: true });
  });

  it('leaves a candidate unlocated past the end of its file, on a deleted file, or on a path the repository does not hold', () => {
    const results = normalizeLocations(scope, worktree, [{ file: 'src/a.ts', line: 3 }, { file: 'src/gone.ts', line: 1 }, { file: 'src/b.ts', line: 1 }, { file: 'a.ts', line: 1 }]);
    for (const result of results) assert.deepEqual(result, unlocated);
    assert.equal(results.length, 4, 'no candidate is dropped');
  });

  it('measures an oversized file from the worktree, the one place its lines can be counted', () => {
    const [inside, past] = normalizeLocations(scope, worktree, [{ file: 'assets/huge.bin', line: 1 }, { file: 'assets/huge.bin', line: 2 }]);
    assert.deepEqual(inside, { file: 'assets/huge.bin', line: 1, located: true, inScope: true });
    assert.deepEqual(past, unlocated);
  });

  it('locates a candidate on an unchanged file of the repository outside the change, in the tree\'s spelling, with its line checked', () => {
    const rooted: ScopeState = { ...scope, files: [{ path: 'index.ts', status: 'modified', symlink: false, before: blob, after: blob }] };
    writeFileSync(join(worktree, 'index.ts'), 'one\ntwo\n');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'index.ts'), 'one\ntwo\nthree');
    const [unchanged, absolute, folded, past, inChange] = normalizeLocations(rooted, worktree, [
      { file: 'src/index.ts', line: 1 },
      { file: join(worktree, 'src', 'index.ts'), line: 3 },
      { file: 'SRC\\INDEX.TS', line: 2 },
      { file: 'src/index.ts', line: 4 },
      { file: join(worktree, 'index.ts'), line: 2 },
    ]);
    assert.deepEqual(unchanged, { file: 'src/index.ts', line: 1, located: true, inScope: false });
    assert.deepEqual(absolute, { file: 'src/index.ts', line: 3, located: true, inScope: false }, 'an absolute path of the unchanged file, never the changed index.ts it ends with');
    assert.deepEqual(folded, { file: 'src/index.ts', line: 2, located: true, inScope: false }, 'another case gives the tree\'s own spelling');
    assert.deepEqual(past, unlocated, 'a line past the end of an unchanged file');
    assert.deepEqual(inChange, { file: 'index.ts', line: 2, located: true, inScope: true });
  });

  it('leaves unlocated a path that names a directory or nothing the repository holds', () => {
    const [directory, missing, missingUnder] = normalizeLocations(scope, worktree, [{ file: 'lib/src', line: 1 }, { file: 'lib/src/b.ts', line: 1 }, { file: 'nowhere/b.ts', line: 1 }]);
    assert.deepEqual(directory, unlocated);
    assert.deepEqual(missing, unlocated);
    assert.deepEqual(missingUnder, unlocated);
  });

  it('counts the lines of an unchanged file of any size from the worktree', () => {
    const big = Buffer.concat([Buffer.alloc(200 * 1024, 0x61), Buffer.from('\n'), Buffer.alloc(70 * 1024, 0x62)]);
    writeFileSync(join(worktree, 'big.txt'), big);
    const [last, past] = normalizeLocations(scope, worktree, [{ file: 'big.txt', line: 2 }, { file: 'big.txt', line: 3 }]);
    assert.deepEqual(last, { file: 'big.txt', line: 2, located: true, inScope: false }, 'a last line without a line feed, past a chunk boundary');
    assert.deepEqual(past, unlocated);
  });

  it('leaves unlocated a name that matches two unchanged files differing only in case', (context) => {
    if (!caseSensitive(worktree)) {
      context.skip('this file system does not tell names apart by case alone');
      return;
    }
    writeFileSync(join(worktree, 'Readme.md'), 'one\n');
    writeFileSync(join(worktree, 'README.md'), 'one\n');
    const [ambiguous, exact] = normalizeLocations(scope, worktree, [{ file: 'readme.md', line: 1 }, { file: 'README.md', line: 1 }]);
    assert.deepEqual(ambiguous, unlocated);
    assert.deepEqual(exact, { file: 'README.md', line: 1, located: true, inScope: false });
  });

  it('reads each file once however many candidates point at it', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ file: 'lib/src/a.ts', line: (index % 3) + 1 }));
    const results = normalizeLocations(scope, worktree, many);
    assert.equal(results.length, 50);
    assert.ok(results.every((result) => result.located));
  });
});
