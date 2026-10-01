import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StructuralCheckError } from '../../src/review/errors.ts';
import { requireOwnedReported, resolveFixerAnswer, resolveReportedPath } from '../../src/review/fix-answer.ts';
import { worktreeLookup, type RepoLookup } from '../../src/review/locations.ts';
import type { FixerOutput } from '../../src/review/schemas.ts';
import { write } from '../helpers/repository.ts';

describe('the fixer\'s answer against the tree', () => {
  let directory: string;
  let worktree: string;
  let lookup: RepoLookup;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-fix-answer-')));
    worktree = join(directory, 'repo');
    write(worktree, 'src/Parser.ts', 'x');
    write(worktree, 'src/b.ts', 'x');
    lookup = worktreeLookup(worktree);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  describe('resolveReportedPath', () => {
    it('gives the worktree\'s own spelling of a file it holds, however the fixer spelled it', () => {
      assert.equal(resolveReportedPath(worktree, lookup, 'src/Parser.ts'), 'src/Parser.ts');
      assert.equal(resolveReportedPath(worktree, lookup, './src//Parser.ts'), 'src/Parser.ts');
      assert.equal(resolveReportedPath(worktree, lookup, 'src\\Parser.ts'), 'src/Parser.ts');
      assert.equal(resolveReportedPath(worktree, lookup, 'SRC/parser.ts'), 'src/Parser.ts', 'a spelling that differs only in case');
      assert.equal(resolveReportedPath(worktree, lookup, join(worktree, 'src', 'b.ts')), 'src/b.ts', 'an absolute path inside the worktree');
    });

    it('keeps a path the worktree does not hold as written, for a file deleted or created', () => {
      assert.equal(resolveReportedPath(worktree, lookup, 'test/new.test.ts'), 'test/new.test.ts');
      assert.equal(resolveReportedPath(worktree, lookup, join(worktree, 'test', 'deep', 'new.ts')), 'test/deep/new.ts');
      // A bare name is never taken for a changed path it ends with.
      assert.equal(resolveReportedPath(worktree, lookup, 'b.ts'), 'b.ts');
    });

    it('refuses a path outside the worktree, through .., into the git directory, or empty', () => {
      for (const raw of [join(directory, 'outside.ts'), '../outside.ts', 'src/../../x.ts', '.git/config', 'src/.GIT/hooks/pre-commit', '/', '.', worktree]) {
        assert.throws(() => resolveReportedPath(worktree, lookup, raw), StructuralCheckError, raw);
      }
    });
  });

  const answer = (findings: { files: string[]; requiredFiles?: string[]; status?: 'applied' | 'blocked' }[]): FixerOutput => ({
    findings: findings.map((finding, index) => ({
      index,
      status: finding.status ?? 'applied',
      file: 'src/b.ts',
      line: 1,
      note: 'n',
      message: finding.status === 'blocked' ? null : { subject: 'fix: x', body: '' },
      files: finding.files,
      corrections: [],
      validation: [],
      requiredFiles: finding.requiredFiles ?? [],
    })),
    drift: [],
    tests: [],
    suite: { result: 'pass', command: '', failures: '' },
  });

  describe('resolveFixerAnswer', () => {
    const context = (): Parameters<typeof resolveFixerAnswer>[1] => ({ worktree, lookup, owned: ['src/b.ts'], othersOwned: new Map([['src/Parser.ts', 'c2']]) });

    it('resolves every finding\'s files once and names every file the answer reports', () => {
      const resolved = resolveFixerAnswer(answer([{ files: ['src/b.ts', './src/b.ts'] }, { files: ['test/b.test.ts'] }]), context());
      assert.deepEqual(resolved.findings.map((finding) => finding.files), [['src/b.ts'], ['test/b.test.ts']]);
      assert.deepEqual([...resolved.named].sort(), ['src/b.ts', 'test/b.test.ts']);
      assert.deepEqual(resolved.violations, []);
    });

    it('records a reported file another cluster owns as a violation, and keeps the answer', () => {
      const resolved = resolveFixerAnswer(answer([{ files: ['src/b.ts', 'SRC/PARSER.TS'] }]), context());
      assert.deepEqual(resolved.violations, ['src/Parser.ts']);
    });

    it('refuses a blocked finding that requires a file its own cluster owns, and accepts one another cluster owns', () => {
      assert.throws(() => resolveFixerAnswer(answer([{ files: [], requiredFiles: ['src/b.ts'], status: 'blocked' }]), context()), /blocked on src\/b\.ts, which its own cluster owns/);
      assert.deepEqual(resolveFixerAnswer(answer([{ files: [], requiredFiles: ['src/parser.ts'], status: 'blocked' }]), context()).findings[0]!.requiredFiles, ['src/Parser.ts']);
    });

    it('refuses an answer that reports a path outside the repository', () => {
      assert.throws(() => resolveFixerAnswer(answer([{ files: ['../escape.ts'] }]), context()), StructuralCheckError);
    });
  });

  describe('requireOwnedReported', () => {
    it('passes when every changed owned file is named, and names each one left out', () => {
      assert.doesNotThrow(() => requireOwnedReported(['src/b.ts'], new Set(['src/b.ts', 'test/x.ts'])));
      assert.doesNotThrow(() => requireOwnedReported([], new Set()));
      assert.throws(() => requireOwnedReported(['src/a.ts', 'src/b.ts'], new Set(['src/b.ts'])), /names no finding for the owned file src\/a\.ts, whose bytes changed/);
      assert.throws(() => requireOwnedReported(['src/a.ts', 'src/c.ts'], new Set()), /owned files src\/a\.ts, src\/c\.ts/);
    });
  });
});
