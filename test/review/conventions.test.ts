import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existingUserRulesFiles, userConventionFiles } from '../../src/review/conventions.ts';

describe('existingUserRulesFiles', () => {
  let home: string;
  const write = (path: string): void => {
    mkdirSync(join(home, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(home, ...path.split('/')), `# ${path}\n`);
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'deep-review-conventions-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists nothing when neither user-level rules file exists', () => {
    assert.deepEqual(existingUserRulesFiles(home), []);
  });

  it('lists each that exists, absolute, Claude Code\'s before Codex\'s', () => {
    write('.codex/AGENTS.md');
    assert.deepEqual(existingUserRulesFiles(home), [join(home, '.codex', 'AGENTS.md')]);
    write('.claude/CLAUDE.md');
    assert.deepEqual(existingUserRulesFiles(home), [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md')]);
  });

  it('passes over a directory named like a rules file, and a rules file\'s name anywhere else under home', () => {
    mkdirSync(join(home, '.claude', 'CLAUDE.md'), { recursive: true });
    write('AGENTS.md');
    write('.codex/rules/AGENTS.md');
    assert.deepEqual(existingUserRulesFiles(home), []);
  });

  it('names the two user-level paths the role text names', () => {
    assert.deepEqual(userConventionFiles, ['.claude/CLAUDE.md', '.codex/AGENTS.md']);
  });
});
