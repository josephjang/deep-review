import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
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
   * Every place a fragment says that other fragments' text comes below it:
   * the fragment, the words that say so, and the fragments meant, in the
   * order the words give them. Whether "below" is true depends on the
   * manifest's order, so each role that names the fragment is held to it.
   */
  const textBelow: readonly [fragment: string, words: RegExp, below: readonly string[]][] = [
    ['lead-brief.md', /the output contract below/, ['finder-output.md']],
    ['lead-verify.md', /the rubrics below/, ['rubrics.md']],
    ['analyst-brief.md', /angles are defined below[\s\S]*output contract below\s+the angle definitions/, ['angles-analyst.md', 'finder-output.md']],
    ['scout-brief.md', /angles are defined below[\s\S]*output contract below\s+the angle definitions/, ['angles-scout.md', 'finder-output.md']],
    ['conventions-brief.md', /angle is defined below[\s\S]*output contract below\s+the angle definition/, ['angles-conventions.md', 'finder-output.md']],
    ['auditor-brief.md', /three verdict definitions below/, ['step3-verdicts.md']],
    ['phase1-finders.md', /finder angles are defined below/, ['angles-scan.md', 'angles-analyst.md', 'angles-scout.md', 'angles-conventions.md']],
  ];

  it('places the text a fragment says is below it after that fragment, in every role', () => {
    for (const [fragment, words, below] of textBelow) {
      assert.match(readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, fragment), 'utf8'), words, fragment);
      const naming = roles.filter((role) => role.fragments.some((named) => named.name === fragment));
      assert.ok(naming.length > 0, `no role names ${fragment}`);
      for (const role of naming) {
        const names = role.fragments.map((named) => named.name);
        const positions = [fragment, ...below].map((name) => names.indexOf(name));
        assert.ok(positions.every((position, index) => position > (index === 0 ? -1 : positions[index - 1]!)), `${role.key}: ${[fragment, ...below].join(' then ')}, got ${names.join(', ')}`);
      }
    }
  });

  it('names no mechanism of one runtime in any prompt', () => {
    const offences = roles.flatMap((role) => runtimeWordingIn(role.prompt).map((offence) => `${role.key} ${offence}`));
    assert.deepEqual(offences, []);
  });
});

/**
 * Wording that names one runtime's mechanism, which no worker on another
 * runtime has (R6 of the role prompts proposal): Claude Code's subagents
 * and the `Agent` tool that spawns them, its `AskUserQuestion` tool, its
 * `Grep` tool, the "single message block" that runs tool calls in
 * parallel (and "the same block" that pointed back at it), and the names
 * of the prompt-only skill's subagents. "scope block" is not one.
 *
 * Each pattern is matched against a whole prompt, and a space inside a
 * phrase is `\s+`, so a phrase that a line wrap splits in two is still
 * found; a subagent name may break after its dash. Every pattern ignores
 * case except the Grep tool's, because a lowercase `grep` is the shell
 * command every runtime's shell has. `AGENTS.md`, an instruction file, is
 * not an agent.
 */
const runtimeWording: readonly [RegExp, string][] = [
  [/\bsubagents?\b/gi, 'subagent'],
  [/`Agent`/gi, 'the Agent tool'],
  [/subagent_type/gi, 'subagent_type'],
  [/AskUserQuestion/gi, 'AskUserQuestion'],
  [/orchestrator/gi, 'the orchestrator'],
  [/\bagents?\b(?!\.md\b)/gi, 'agent, meaning a worker'],
  [/\bGrep\b/g, 'the Grep tool'],
  [/\btier\s+table\b/gi, 'the tier table'],
  [/\b(message|same)\s+block\b/gi, 'a message block'],
  [/\bdeep-review-\s*(lead|fixer|auditor|analyst|scout|conventions|driver)\b/gi, 'a subagent name'],
  [/\bdeep-review\s+skill\b/gi, 'the deep-review skill as the worker\'s employer'],
];

/** Each runtime-specific phrase in `text`, as "line N names WHAT: LINE", N being the line the phrase starts on. */
function runtimeWordingIn(text: string): string[] {
  const lines = text.split('\n');
  const offences: string[] = [];
  for (const [pattern, what] of runtimeWording) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      offences.push(`line ${String(line)} names ${what}: ${lines[line - 1]!.trim()}`);
    }
  }
  return offences;
}

describe('the runtime-wording guard', () => {
  /** The WHAT of each offence the guard reports in `text`. */
  const named = (text: string): string[] => runtimeWordingIn(text).map((offence) => offence.replace(/^line \d+ names (.*?): .*$/s, '$1'));

  it('finds a phrase that a line wrap splits in two', () => {
    assert.deepEqual(named('run it from the tier\ntable above'), ['the tier table']);
    assert.deepEqual(named('all in a single message\n  block'), ['a message block']);
    assert.deepEqual(named('write it in the same\nblock as the dispatch'), ['a message block']);
    assert.deepEqual(named('a subagent of the deep-review\nskill'), ['subagent', 'the deep-review skill as the worker\'s employer']);
    assert.deepEqual(named('`subagent_type: "deep-review-\nlead"`'), ['subagent_type', 'a subagent name']);
  });

  it('finds a phrase whatever its case', () => {
    assert.deepEqual(named('Tier table first.'), ['the tier table']);
    assert.deepEqual(named('Message Block rules.'), ['a message block']);
    assert.deepEqual(named('The Deep-Review Skill says so.'), ['the deep-review skill as the worker\'s employer']);
    assert.deepEqual(named('Spawn a DEEP-REVIEW-FIXER.'), ['a subagent name']);
    assert.deepEqual(named('Two Agents edit it.'), ['agent, meaning a worker']);
  });

  it('passes the instruction file AGENTS.md, a scope block and the grep command', () => {
    assert.deepEqual(named('Read AGENTS.md and agents.md first.'), []);
    assert.deepEqual(named('The scope block is shared.'), []);
    assert.deepEqual(named('Run grep -n on the file.'), []);
    assert.deepEqual(named('Grep for the symbol.'), ['the Grep tool']);
  });

  it('reports the line a phrase starts on, and that line\'s text', () => {
    assert.deepEqual(runtimeWordingIn('first\nsecond\n  the orchestrator reads it\n'), ['line 3 names the orchestrator: the orchestrator reads it']);
    assert.deepEqual(runtimeWordingIn('first\nthe tier\ntable'), ['line 2 names the tier table: the tier']);
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

  it('refuses an --output that already exists as a file, leaving the file as it was', () => {
    const output = join(sandbox, 'out');
    writeFileSync(output, 'kept\n');
    const result = spawnSync(process.execPath, [script, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
    assert.equal(readFileSync(output, 'utf8'), 'kept\n');
  });

  it('refuses a file system root as --output', () => {
    const result = spawnSync(process.execPath, [script, '--output', parse(sandbox).root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
  });

  it('creates the missing parents of --output', () => {
    const other = writeSmallRoles();
    const output = join(sandbox, 'a', 'b', 'out');
    const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(output), ['only.md']);
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
