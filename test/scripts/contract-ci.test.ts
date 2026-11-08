import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contractPlan, documentationOnly, parseChanges, planStatus } from '../../scripts/contract-ci.ts';
import { git } from '../helpers/git.ts';

const directories: string[] = [];
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'deep-review-contract-policy-'));
  directories.push(path);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function repository(): string {
  const root = scratch();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Contract policy test');
  git(root, 'config', 'user.email', 'contract@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.filemode', 'true');
  put(root, 'README.md');
  put(root, 'docs/note.md');
  put(root, 'src/engine.ts');
  commit(root);
  git(root, 'checkout', '-b', 'feature');
  return root;
}
function put(root: string, path: string, content = 'initial\n'): void {
  const destination = join(root, path);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, content);
}
function commit(root: string): void {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'Test change');
}
function merge(root: string) {
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'main');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'merge', '--no-ff', 'feature', '-m', 'Test merge');
  const tested = git(root, 'rev-parse', 'HEAD');
  return { event: { pull_request: { base: { sha: base }, head: { sha: head } } }, tested };
}
function plan(root: string) {
  const merged = merge(root);
  return contractPlan(root, 'pull_request', merged.event, merged.tested);
}
function raw(path: string, before = '100644', after = '100644', status = 'M'): Buffer {
  return Buffer.from(`:${before} ${after} ${'a'.repeat(40)} ${'b'.repeat(40)} ${status}\0${path}\0`);
}

describe('contract documentation policy', () => {
  it('exempts only exact root documentation and Markdown below docs', () => {
    for (const path of ['README.md', 'AGENTS.md', 'docs/note.md', 'docs/changes/nested.md', 'docs/한글.md']) {
      assert.equal(documentationOnly(parseChanges(raw(path))), true, path);
    }
    for (const path of ['readme.md', 'docs/run.ts', 'docs/policy.json', 'docs/image.svg', 'docs/note.MD', 'src/README.md', 'skill/codex/SKILL.md', 'roles/policy.json', '.github/workflows/check.yml', 'docs/../src/readme.md', '/docs/note.md', 'docs//note.md', 'docs/note\n.md', 'docs/\\note.md']) {
      assert.equal(documentationOnly(parseChanges(raw(path))), false, path);
    }
    assert.equal(documentationOnly([]), false);
  });

  it('allows regular-file additions and deletions, rejects executable, link and submodule modes', () => {
    for (const modes of [['000000', '100644'], ['100644', '000000'], ['100644', '100644']]) {
      const status = modes[0] === '000000' ? 'A' : modes[1] === '000000' ? 'D' : 'M';
      assert.equal(documentationOnly(parseChanges(raw('docs/note.md', modes[0], modes[1], status))), true);
    }
    for (const mode of ['100755', '120000', '160000', '040000']) {
      assert.equal(documentationOnly(parseChanges(raw('docs/note.md', '100644', mode))), false);
      assert.equal(documentationOnly(parseChanges(raw('docs/note.md', mode, '100644'))), false);
    }
    assert.throws(() => parseChanges(raw('docs/note.md', '000000', '000000')));
  });

  it('rejects truncated, renamed, invalid and non-UTF-8 raw inventories', () => {
    for (const bytes of [Buffer.from('broken'), raw('docs/note.md').subarray(0, -1), raw('docs/note.md', '100644', '100644', 'R100'), Buffer.concat([raw('docs/note.md'), Buffer.from([0xff])])]) {
      assert.throws(() => parseChanges(bytes));
    }
    for (const status of ['U', 'X', 'B', 'A', 'D']) assert.throws(() => parseChanges(raw('docs/note.md', '100644', '100644', status)));
    assert.throws(() => parseChanges(Buffer.from(raw('docs/note.md').toString().replace('a'.repeat(40), 'a'.repeat(41)))));
  });
});

describe('complete Git inventory', () => {
  it('exempts a multi-commit documentation PR even when the target branch advances', () => {
    const root = repository();
    put(root, 'docs/note.md', 'first change\n'); commit(root);
    put(root, 'README.md', 'second change\n'); commit(root);
    git(root, 'checkout', 'main');
    put(root, 'src/base-only.ts'); commit(root);
    git(root, 'checkout', 'feature');
    const result = plan(root);
    assert.equal(result.required, false);
    assert.equal(result.reason, 'docs-only');
    assert.equal(result.files, 2);
    assert.notEqual(result.base, result.mergeBase);
  });

  it('retains an earlier source change when the last push only changes docs', () => {
    const root = repository();
    put(root, 'src/engine.ts', 'source change\n'); commit(root);
    put(root, 'docs/note.md', 'later docs\n'); commit(root);
    assert.equal(plan(root).required, true);
  });

  it('requires the contract for a source mutation present only in the tested merge', () => {
    const root = repository();
    put(root, 'docs/note.md', 'documentation branch\n'); commit(root);
    const merged = merge(root);
    put(root, 'src/engine.ts', 'merge-only source change\n');
    git(root, 'add', '--all');
    git(root, 'commit', '--amend', '--no-edit');
    const tested = git(root, 'rev-parse', 'HEAD');
    assert.equal(git(root, 'diff', '--name-only', `${merged.event.pull_request.base.sha}...${merged.event.pull_request.head.sha}`), 'docs/note.md');
    const result = contractPlan(root, 'pull_request', merged.event, tested);
    assert.equal(result.required, true);
    assert.equal(result.reason, 'relevant-change');
    assert.equal(result.files, 2);
  });

  for (const [from, to, required] of [
    ['src/engine.ts', 'docs/moved.md', true],
    ['docs/note.md', 'src/moved.ts', true],
    ['docs/note.md', 'docs/renamed.md', false],
  ] as const) {
    it(`counts both endpoints when ${from} moves to ${to}`, () => {
      const root = repository();
      git(root, 'mv', from, to); commit(root);
      const result = plan(root);
      assert.equal(result.required, required);
      assert.equal(result.files, 2);
    });
  }

  it('counts deleted Markdown as documentation', () => {
    const root = repository();
    git(root, 'rm', 'docs/note.md'); commit(root);
    assert.equal(plan(root).required, false);
  });

  it('requires the contract for an executable Markdown file', () => {
    const root = repository();
    put(root, 'docs/program.md', 'executable\n');
    // The index mode is portable even on filesystems without executable bits.
    git(root, 'add', 'docs/program.md');
    git(root, 'update-index', '--chmod=+x', 'docs/program.md');
    if (process.platform !== 'win32') chmodSync(join(root, 'docs/program.md'), 0o755);
    git(root, 'commit', '-m', 'Executable Markdown');
    assert.equal(plan(root).required, true);
  });

  it('falls back on empty differences, shallow history and an unexpected tested merge', () => {
    const root = repository();
    put(root, 'docs/note.md', 'change\n'); commit(root);
    const merged = merge(root);
    const base = merged.event.pull_request.base.sha;
    assert.equal(contractPlan(root, 'pull_request', merged.event, base).reason, 'inventory-unavailable');
    const noChange = { pull_request: { base: { sha: base }, head: { sha: base } } };
    assert.equal(contractPlan(root, 'pull_request', noChange, merged.tested).required, true);
    writeFileSync(join(root, '.git/shallow'), `${base}\n`);
    assert.equal(contractPlan(root, 'pull_request', merged.event, merged.tested).reason, 'inventory-unavailable');
  });

  it('requires the contract for an empty PR tree difference', () => {
    const root = repository();
    git(root, 'commit', '--allow-empty', '-m', 'Empty change');
    const result = plan(root);
    assert.equal(result.required, true);
    assert.equal(result.files, 0);
  });

  it('falls back when crisscross ancestry has multiple merge bases', () => {
    const root = repository();
    const initial = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const left = git(root, 'commit-tree', tree, '-p', initial, '-m', 'Left');
    const right = git(root, 'commit-tree', tree, '-p', initial, '-m', 'Right');
    const base = git(root, 'commit-tree', tree, '-p', left, '-p', right, '-m', 'Left merge');
    const head = git(root, 'commit-tree', tree, '-p', right, '-p', left, '-m', 'Right merge');
    const tested = git(root, 'commit-tree', tree, '-p', base, '-p', head, '-m', 'Tested merge');
    git(root, 'reset', '--hard', tested);
    const result = contractPlan(root, 'pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, tested);
    assert.equal(result.reason, 'inventory-unavailable');
  });

  it('fails closed for malformed events and unavailable revisions', () => {
    const root = repository();
    put(root, 'docs/note.md', 'change\n'); commit(root);
    const merged = merge(root);
    for (const event of [null, {}, { pull_request: [] }, { pull_request: { base: { sha: '--help' }, head: { sha: 'a'.repeat(40) } } }, { pull_request: { base: { sha: 'f'.repeat(40) }, head: { sha: 'e'.repeat(40) } } }]) {
      assert.equal(contractPlan(root, 'pull_request', event, merged.tested).reason, 'inventory-unavailable');
    }
    assert.equal(contractPlan(scratch(), 'pull_request', merged.event, merged.tested).reason, 'inventory-unavailable');
  });

  it('requires all non-PR events without depending on a Git inventory', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'unknown']) {
      assert.deepEqual(contractPlan('missing-checkout', event, {}, ''), { required: true, reason: 'non-pr', files: 0 });
    }
  });
});

describe('contract status gates', () => {
  const documentation = { GITHUB_EVENT_NAME: 'pull_request', CONTRACT_PLAN_RESULT: 'success', CONTRACT_REQUIRED: 'false', CONTRACT_REASON: 'docs-only', CONTRACT_FILES: '3' };
  it('distinguishes exemptions, full runs and explicit inventory fallbacks', () => {
    assert.equal(planStatus(documentation, 'success').exempt, true);
    for (const reason of ['relevant-change', 'non-pr', 'inventory-unavailable']) {
      const status = planStatus({ ...documentation, CONTRACT_REQUIRED: 'true', CONTRACT_REASON: reason, CONTRACT_FILES: '0' }, 'success');
      assert.equal(status.valid, true);
      assert.equal(status.exempt, false);
    }
  });

  it('rejects failed, skipped and canceled classification even with passing matrix results', () => {
    for (const result of ['failure', 'skipped', 'cancelled', '']) {
      assert.deepEqual(planStatus({ ...documentation, CONTRACT_PLAN_RESULT: result }, 'success').valid, false);
      assert.equal(planStatus({ ...documentation, CONTRACT_PLAN_RESULT: result }).exempt, false);
    }
  });

  it('rejects malformed or contradictory outputs instead of granting an exemption', () => {
    for (const patch of [{ CONTRACT_REQUIRED: '' }, { CONTRACT_REQUIRED: 'false\nrequired=true' }, { CONTRACT_REASON: 'unknown' }, { CONTRACT_REASON: 'relevant-change' }, { CONTRACT_FILES: '0' }, { CONTRACT_FILES: '-1' }, { CONTRACT_FILES: 'NaN' }, { CONTRACT_FILES: '01' }, { CONTRACT_FILES: '9007199254740992' }]) {
      const status = planStatus({ ...documentation, ...patch });
      assert.equal(status.valid, false);
      assert.equal(status.exempt, false);
    }
  });

  it('rejects documentation exemptions on main, scheduled, manual and unknown events', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'unknown', '']) {
      const status = planStatus({ ...documentation, GITHUB_EVENT_NAME: event }, 'success');
      assert.equal(status.valid, false);
      assert.equal(status.exempt, false);
    }
  });

  it('rejects failed, skipped, canceled and missing matrix results', () => {
    for (const result of ['failure', 'skipped', 'cancelled', 'missing', '']) {
      assert.equal(planStatus(documentation, result).valid, false);
    }
  });

  it('writes a full-run fallback through the CLI when event input cannot be read', () => {
    const root = scratch();
    const output = join(root, 'output');
    const result = spawnSync(process.execPath, [resolve('scripts/contract-ci.ts'), 'plan'], { cwd: root, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(root, 'missing'), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /^required=true\nreason=inventory-unavailable\nfiles=0\n$/);
  });

  it('fails the CLI gate while explicitly preventing exemption for a failed classifier', () => {
    const root = scratch();
    const output = join(root, 'output');
    const result = spawnSync(process.execPath, [resolve('scripts/contract-ci.ts'), 'gate'], { env: { ...process.env, ...documentation, CONTRACT_PLAN_RESULT: 'failure', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'exempt=false\n');
  });
});
