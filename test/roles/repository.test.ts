import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assembleRoles, fragmentsDirectoryName, manifestFileName, repositoryRolesRoot } from '../../src/roles/assemble.ts';

/** Every role the engine knows, in manifest order: the ten finder angles and the phase roles around them. */
const expectedRoles = [
  'triage', 'angle-decision',
  'finder-SCAN', 'finder-REMOVALS', 'finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY',
  'finder-DESIGN', 'finder-DUPLICATION', 'finder-ALTITUDE', 'finder-CONVENTIONS',
  'deduplication', 'verifier', 'sweep', 'merge-rank',
  'fixer', 'documentation', 'test-assessment', 'auditor', 'answer',
];

/** The roles whose prompt opens with the lead reviewer's brief. */
const leadRoles = ['triage', 'angle-decision', 'finder-SCAN', 'deduplication', 'verifier', 'sweep', 'merge-rank', 'test-assessment'];

describe('the repository\'s roles/', () => {
  const roles = assembleRoles(repositoryRolesRoot());

  it('assembles exactly the expected roles, in order', () => {
    assert.deepEqual(roles.map((role) => role.key), expectedRoles);
  });

  it('gives every role a prompt that starts with text and ends with one newline', () => {
    for (const role of roles) {
      assert.ok(role.prompt.length > 0, role.key);
      assert.ok(role.prompt.endsWith('\n') && !role.prompt.endsWith('\n\n'), role.key);
      assert.ok(!role.prompt.startsWith('\n'), role.key);
    }
  });

  it('opens the lead roles with the lead brief and gives every finder the output contract', () => {
    for (const role of roles) {
      const names = role.fragments.map((fragment) => fragment.name);
      if (leadRoles.includes(role.key)) assert.equal(names[0], 'lead-brief.md', role.key);
      if (role.key.startsWith('finder-')) assert.ok(names.includes('finder-output.md'), role.key);
    }
  });

  /**
   * Wording that names one runtime's mechanism, which no worker on another
   * runtime has (R6 of the role prompts proposal): Claude Code's subagents
   * and the `Agent` tool that spawns them, its `AskUserQuestion` tool, its
   * `Grep` tool, the "single message block" that runs tool calls in
   * parallel, and the names of the prompt-only skill's subagents.
   */
  const runtimeWording: readonly [RegExp, string][] = [
    [/\bsubagents?\b/i, 'subagent'],
    [/`Agent`/, 'the Agent tool'],
    [/subagent_type/, 'subagent_type'],
    [/AskUserQuestion/, 'AskUserQuestion'],
    [/orchestrator/i, 'the orchestrator'],
    [/\bagents?\b/i, 'agent, meaning a worker'],
    [/\bGrep\b/, 'the Grep tool'],
    [/tier table/, 'the tier table'],
    [/message block/, 'a message block'],
    [/deep-review-(lead|fixer|auditor|analyst|scout|conventions|driver)\b/, 'a subagent name'],
    [/deep-review skill/, 'the deep-review skill as the worker\'s employer'],
  ];

  it('names no mechanism of one runtime in any prompt', () => {
    const offences: string[] = [];
    for (const role of roles) {
      role.prompt.split('\n').forEach((line, index) => {
        for (const [pattern, what] of runtimeWording) if (pattern.test(line)) offences.push(`${role.key} line ${String(index + 1)} names ${what}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offences, []);
  });
});

describe('scripts/roles.ts', () => {
  const script = resolve(import.meta.dirname, '../../scripts/roles.ts');
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-roles-script-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('prints one line per role and writes each assembled prompt under --output', () => {
    const output = join(sandbox, 'out');
    const result = spawnSync(process.execPath, [script, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, -1).map((line) => line.split('\t')[0]), expectedRoles);
    assert.match(lines.at(-1)!, /^Wrote 21 prompts to /);
    assert.deepEqual(readdirSync(output).sort(), expectedRoles.map((key) => `${key}.md`).sort());
    for (const role of assembleRoles(repositoryRolesRoot())) {
      assert.equal(readFileSync(join(output, `${role.key}.md`), 'utf8'), role.prompt, role.key);
    }
  });

  it('refuses an --output directory that already exists', () => {
    const result = spawnSync(process.execPath, [script, '--output', sandbox], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
    assert.deepEqual(readdirSync(sandbox), []);
  });

  /** A one-role roles directory under the sandbox, for the cases that must not touch the repository's roles/. */
  function writeSmallRoles(): string {
    const other = join(sandbox, 'roles');
    mkdirSync(join(other, fragmentsDirectoryName), { recursive: true });
    writeFileSync(join(other, manifestFileName), JSON.stringify({ schemaVersion: 1, roles: { only: ['a.md'] } }));
    writeFileSync(join(other, fragmentsDirectoryName, 'a.md'), 'alpha\n');
    return other;
  }

  it('assembles another roles directory with --root', () => {
    const other = writeSmallRoles();
    const result = spawnSync(process.execPath, [script, '--root', other], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^only\t1 fragments\t6 bytes\t[a-f0-9]{64}\n$/);
  });

  it('refuses an --output inside the roles directory and leaves that directory as it was', () => {
    const other = writeSmallRoles();
    const inside = [
      join(other, 'assembled'),
      join(other, fragmentsDirectoryName, 'prompts'),
      // Missing parents inside the roles directory must not be created either.
      join(other, fragmentsDirectoryName, 'nested', 'prompts'),
    ];
    // Windows paths compare without regard to case, so a differently cased spelling is the same directory.
    if (process.platform === 'win32') inside.push(join(other.toUpperCase(), 'assembled'));
    for (const output of inside) {
      const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, output);
      assert.match(result.stderr, /must not be inside the roles directory/, output);
      assert.deepEqual(readdirSync(other).sort(), [fragmentsDirectoryName, manifestFileName].sort(), output);
      assert.deepEqual(readdirSync(join(other, fragmentsDirectoryName)), ['a.md'], output);
    }
    assert.deepEqual(assembleRoles(other).map((role) => role.key), ['only']);
  });

  it('accepts an --output beside the roles directory whose name merely starts like it', () => {
    const other = writeSmallRoles();
    const output = `${other}-assembled`;
    const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, 'only.md'), 'utf8'), 'alpha\n');
  });
});
