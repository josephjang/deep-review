import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ancestorDirectories, conventionFileNames, conventionFiles, userConventionFiles } from '../../src/review/conventions.ts';

describe('ancestorDirectories', () => {
  it('gives the root and every ancestor of each changed path, shallowest first, without repeats', () => {
    assert.deepEqual(ancestorDirectories([]), ['']);
    assert.deepEqual(ancestorDirectories(['a.ts']), ['']);
    assert.deepEqual(ancestorDirectories(['src/x/a.ts', 'src/b.ts', 'lib/c.ts', 'src/x/d.ts']), ['', 'lib', 'src', 'src/x']);
  });
});

describe('conventionFiles', () => {
  let sandbox: string;
  let home: string;
  let worktree: string;
  const write = (root: string, path: string): void => {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split('/')), `# ${path}\n`);
  };
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-conventions-'));
    home = join(sandbox, 'home');
    worktree = join(sandbox, 'repo');
    mkdirSync(home);
    mkdirSync(worktree);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('lists nothing when no rules file exists', () => {
    assert.deepEqual(conventionFiles(worktree, ['src/a.ts'], home), []);
  });

  it('lists the user files first, then the root and each ancestor directory of a changed file, in depth order', () => {
    write(home, '.claude/CLAUDE.md');
    write(home, '.codex/AGENTS.md');
    write(worktree, 'AGENTS.md');
    write(worktree, 'CLAUDE.local.md');
    write(worktree, 'src/CLAUDE.md');
    write(worktree, 'src/deep/AGENTS.md');
    write(worktree, 'other/CLAUDE.md');
    assert.deepEqual(conventionFiles(worktree, ['src/deep/a.ts', 'src/b.ts'], home), [
      { level: 'user', path: join(home, '.claude', 'CLAUDE.md') },
      { level: 'user', path: join(home, '.codex', 'AGENTS.md') },
      { level: 'repository', path: 'CLAUDE.local.md' },
      { level: 'repository', path: 'AGENTS.md' },
      { level: 'repository', path: 'src/CLAUDE.md' },
      { level: 'repository', path: 'src/deep/AGENTS.md' },
    ]);
  });

  it('passes over a directory named like a rules file', () => {
    mkdirSync(join(worktree, 'CLAUDE.md'));
    write(worktree, 'src/AGENTS.md');
    assert.deepEqual(conventionFiles(worktree, ['src/a.ts'], home), [{ level: 'repository', path: 'src/AGENTS.md' }]);
  });

  it('names the three files and the two user paths the angle text names', () => {
    assert.deepEqual(conventionFileNames, ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
    assert.deepEqual(userConventionFiles, ['.claude/CLAUDE.md', '.codex/AGENTS.md']);
  });
});
