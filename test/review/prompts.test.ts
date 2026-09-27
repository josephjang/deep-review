import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { EvidenceStore } from '../../src/evidence/store.ts';
import { closingSentence, composeWorkerPrompt, describeFrozen, describePatch, fenceFor, inlinePatchLimitBytes, readTaskHeader, scopeBlock } from '../../src/review/prompts.ts';

describe('fenceFor', () => {
  it('is three backticks unless the text holds a run that long, then one more than the longest run', () => {
    assert.equal(fenceFor('plain'), '```');
    assert.equal(fenceFor('has `code`'), '```');
    assert.equal(fenceFor('closes ``` a fence'), '````');
    assert.equal(fenceFor('``````'), '```````');
  });
});

describe('the scope block', () => {
  let sandbox: string;
  let evidence: EvidenceStore;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-prompts-'));
    evidence = new EvidenceStore(join(sandbox, 'artifacts'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const scopeWith = (patch: string | Buffer): ScopeState => ({
    mode: 'range',
    request: { range: { from: 'main', to: 'HEAD', mergeBase: true }, paths: [] },
    base: '1'.repeat(40),
    head: '2'.repeat(40),
    files: [
      { path: 'src/a.ts', status: 'modified', symlink: false, before: { blob: evidence.put('old a\n') }, after: { blob: evidence.put('new a\n') } },
      { path: 'src/new|pipe.ts', status: 'added', symlink: false, before: null, after: { blob: evidence.put('n\n') } },
      { path: 'src/gone.ts', status: 'deleted', symlink: false, before: { blob: evidence.put('g\n') }, after: null },
      { path: 'big.bin', status: 'modified', symlink: false, before: { oversized: { sha256: 'c'.repeat(64), size: 9_000_000 } }, after: { oversized: { sha256: 'd'.repeat(64), size: 9_000_001 } } },
      { path: 'link', status: 'added', symlink: true, before: null, after: { blob: evidence.put('target') } },
    ],
    patch: evidence.put(patch),
  });

  it('names the repository, base, head and mode, and tabulates every file with its frozen before state by path', () => {
    const scope = scopeWith('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old a\n+new a\n');
    const block = scopeBlock({ worktree: '/repo', scope, evidence, conventions: [] });
    assert.match(block, /^## Scope\n\nRepository: \/repo\nBase: 1{40}\nHead: 2{40}\nMode: range\n/);
    const frozen = scope.files[0]!.before!;
    assert.ok('blob' in frozen);
    const before = evidence.pathOf(frozen.blob);
    assert.ok(block.includes(`| src/a.ts | modified | ${before} | read the file in the worktree |`), block);
    assert.ok(block.includes('| src/new\\|pipe.ts | added | none | read the file in the worktree |'), 'a pipe in a path is escaped');
    assert.ok(block.includes('| src/gone.ts | deleted | ') && block.includes(' | deleted |'));
    assert.ok(block.includes(`| big.bin | modified | oversized ${'c'.repeat(64)} 9000000 bytes | read the file in the worktree |`));
    assert.ok(block.includes('| link | added (symlink) | none | read the file in the worktree |'));
    assert.ok(block.includes('None of CLAUDE.md, CLAUDE.local.md or AGENTS.md was found'));
    assert.ok(block.includes('### Patch\n\n```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old a\n+new a\n```'), block);
  });

  it('lists the rules files with their level', () => {
    const block = scopeBlock({ worktree: '/repo', scope: scopeWith('x\n'), evidence, conventions: [{ level: 'user', path: '/home/me/.claude/CLAUDE.md' }, { level: 'repository', path: 'AGENTS.md' }, { level: 'repository', path: 'src/CLAUDE.md' }] });
    assert.ok(block.includes('- /home/me/.claude/CLAUDE.md (user level)\n- AGENTS.md (repository)\n- src/CLAUDE.md (repository)'), block);
  });

  it('carries the patch inline up to the limit and names its path above it', () => {
    const small = Buffer.alloc(inlinePatchLimitBytes, 0x2b);
    assert.ok(describePatch(scopeWith(small), evidence).startsWith('```diff\n'));
    const large = Buffer.alloc(inlinePatchLimitBytes + 1, 0x2b);
    const scope = scopeWith(large);
    assert.equal(describePatch(scope, evidence), `The patch is ${String(inlinePatchLimitBytes + 1)} bytes, too large to carry here. Read it at: ${evidence.pathOf(scope.patch)}`);
  });

  it('fences a patch that holds a fence, and says when the patch is empty', () => {
    assert.match(describePatch(scopeWith('+```js\n+code\n+```\n'), evidence), /^````diff\n[\s\S]*\n````$/);
    assert.equal(describePatch(scopeWith(''), evidence), 'The patch is empty.');
    assert.equal(describePatch(scopeWith('no newline'), evidence), '```diff\nno newline\n```');
  });

  it('describes a frozen state as a path, none or oversized', () => {
    const reference = evidence.put('bytes');
    assert.equal(describeFrozen({ blob: reference }, evidence), evidence.pathOf(reference));
    assert.equal(describeFrozen(null, evidence), 'none');
    assert.equal(describeFrozen({ oversized: { sha256: 'e'.repeat(64), size: 5 } }, evidence), `oversized ${'e'.repeat(64)} 5 bytes`);
  });
});

describe('composeWorkerPrompt', () => {
  it('keeps the role prompt as it is, then the task section naming the role and unit, the task, the scope and the closing sentence', () => {
    const prompt = composeWorkerPrompt('You are a worker.\n', { role: 'finder-RIPPLE', phase: 'finders', unitKey: 'RIPPLE', task: 'Angle: RIPPLE\nLead: none' }, '## Scope\n\nRepository: /r');
    assert.equal(prompt, ['You are a worker.', '', '## Task', '', 'Role: finder-RIPPLE', 'Unit: RIPPLE', 'Phase: finders', '', 'Angle: RIPPLE', 'Lead: none', '', '## Scope', '', 'Repository: /r', '', closingSentence, ''].join('\n'));
    assert.ok(prompt.startsWith('You are a worker.\n\n## Task'));
    assert.ok(prompt.endsWith(`${closingSentence}\n`));
  });

  it('adds the newline a role prompt lacks rather than joining it to the task', () => {
    assert.ok(composeWorkerPrompt('role text', { role: 'triage', phase: 'triage', unitKey: 'SCAN', task: 't' }, 's').startsWith('role text\n\n## Task'));
  });

  it('is read back by readTaskHeader, which gives null for a prompt without the header', () => {
    const prompt = composeWorkerPrompt('r\n', { role: 'verifier', phase: 'verification', unitKey: 'g3', task: 'Role: not this one' }, 's');
    assert.deepEqual(readTaskHeader(prompt), { role: 'verifier', unitKey: 'g3', phase: 'verification' });
    assert.equal(readTaskHeader('no header here'), null);
    assert.equal(readTaskHeader('Role: x\nUnit: y\n'), null);
  });
});
