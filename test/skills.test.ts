import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { engineBundleName, engineDirectoryName } from '../src/build/bundle.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/**
 * The skill texts are prompts and product bytes; this test pins only what
 * the engine's contract needs them to say (R11 of the read-only review):
 * the bundle's path, the runtime, every scope flag, the exit codes and
 * what to show for each, and that nothing else reviews the change.
 */
describe('the skill texts', () => {
  const skills: [name: string, path: string, runtime: string][] = [
    ['Claude Code', 'skill/claude/skills/deep-review/SKILL.md', 'claude'],
    ['Codex', 'skill/codex/SKILL.md', 'codex'],
  ];

  for (const [name, path, runtime] of skills) {
    it(`${name}: names the bundle, the runtime, the scope flags, the exit codes and the waiting rule`, () => {
      const text = read(path);
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}`), 'the bundle path');
      assert.ok(text.includes(`review --runtime ${runtime}`), 'the runtime flag');
      for (const flag of ['--worktree', '--last-commit', '--ref <ref>', '--from <rev> --to HEAD', '--merge-base', '--path <path>']) assert.ok(text.includes(flag), flag);
      assert.match(text, /Exit code 0: the last line of stdout is the report's path/);
      assert.match(text, /Exit code 2: the run is blocked or was refused/);
      assert.match(text, /Any other exit code: show stderr verbatim/);
      assert.match(text, /wait for it to exit/);
      assert.match(text, /Do not poll the\s+ledger/);
      assert.match(text, /run the same\s+command again/);
      assert.match(text, /Do not\s+summarize, quote or interpret the findings/);
      assert.match(text, /Never review, fix, revert or commit the change another way under this\s+skill's name, and never edit the code yourself: no `git commit`, no\s+amend, no push/);
      assert.match(text, /Node 26 or newer/);
      assert.doesNotMatch(text, /not shipped|skeleton|editing nothing/);
    });

    it(`${name}: passes --fix only when asked, warns that the workers edit the tree, and commits only through the engine (R14 of the fix pass)`, () => {
      const text = read(path);
      assert.match(text, /When the user asks for the findings to be\s+fixed or applied, add `--fix`/);
      assert.match(text, /`--check <kind>=<command>` for each\s+check command the user names/);
      assert.match(text, /tell the user that the engine's workers\s+will edit the working tree and that the run commits nothing/);
      assert.match(text, /Without\s+such a request, do not pass `--fix`/);
      assert.match(text, /the fixes are in the working tree, uncommitted, one\s+patch per finding/);
      assert.match(text, /offer\s+to commit them/);
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}" commit`), 'the commit subcommand of the same bundle');
      assert.match(text, /adding `--change-message <message>` when the scope was `--worktree`/);
      assert.match(text, /ask the user for\s+that commit's message before you run it/);
    });
  }

  it('keeps the Claude skill out of automatic invocation and the Codex skill out of implicit invocation', () => {
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), /^disable-model-invocation: true$/m);
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), /\$\{CLAUDE_PLUGIN_ROOT\}\/engine\/main\.mjs/);
    assert.match(read('skill/codex/agents/openai.yaml'), /allow_implicit_invocation: false/);
    assert.doesNotMatch(read('skill/codex/agents/openai.yaml'), /not shipped/);
  });

  it('tells the Codex skill that the run budget does not apply, and the Claude skill its default', () => {
    assert.match(read('skill/codex/SKILL.md'), /--budget-usd` does not apply to Codex/);
    // The default the skill names is the policy's, so a changed default cannot leave the skill behind.
    const { runBudgetUsd } = (JSON.parse(read('roles/policy.json')) as { runtimes: { claude: { runBudgetUsd: number } } }).runtimes.claude;
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), new RegExp(`--budget-usd <usd>\` only when the\\s+user names a run budget; the default is ${String(runBudgetUsd)} USD\\.`));
  });

  it('describes the plugin as carrying the engine, in the plugin and the marketplace alike, and no longer as editing nothing', () => {
    for (const path of ['skill/claude/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skill/claude/skills/deep-review/SKILL.md', 'skill/codex/SKILL.md', 'skill/codex/agents/openai.yaml']) {
      const text = read(path);
      if (!path.endsWith('.yaml')) assert.match(text, /a Node program installed with this (plugin|skill)/, path);
      assert.doesNotMatch(text, /skeleton|no engine|editing nothing/, path);
      assert.match(text, /fixes/, `${path} says the engine can apply the fixes`);
    }
  });
});
