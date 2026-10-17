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
      for (const flag of ['--worktree', '--last-commit', '--branch', '--base <rev>', '--ref <ref>', '--from <rev> --to HEAD', '--merge-base', '--path <path>']) assert.ok(text.includes(flag), flag);
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
      // The survey chooses the checks; a flag settles only a kind the user names (R5 of the repository survey). The words matter, not where the text wraps.
      assert.match(text, /The engine surveys\s+the\s+repository\s+for\s+its\s+checks\s+itself/);
      assert.match(text, /add\s+`--check <kind>=<command>`\s+only\s+for\s+a\s+check\s+command\s+the\s+user\s+names,\s+and\s+`--no-check <kind>`\s+only\s+for\s+a\s+check\s+the\s+user\s+says\s+to\s+skip/);
      assert.match(text, /each\s+settles\s+its\s+kind\s+over\s+the\s+survey/);
      assert.match(text, /tell the\s+user that the engine's workers will edit the working tree, that it\s+runs the check commands it chose from the repository, and that the\s+run commits nothing/);
      assert.match(text, /Without such a request, do not pass `--fix`/);
      // A finished read-only run of the unchanged change is continued, not reviewed again (R11 of fix pass continuation); the warning still comes before the command.
      assert.match(text, /When a read-only run of the same\s+change has finished and the change is unchanged since, the same\s+command with `--fix` continues that run and reviews nothing again,\s+so the fixes are of the findings the user read\./);
      assert.ok(text.indexOf('continues that run') < text.indexOf('Before you run it, tell the'), 'the continuation is said before the warning, which still precedes the command');
      assert.match(text, /the fixes are in the working tree, uncommitted, one\s+patch per finding/);
      assert.match(text, /offer\s+to commit them/);
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}" commit`), 'the commit subcommand of the same bundle');
      assert.match(text, /adding `--change-message <message>` when the scope was `--worktree`/);
      assert.match(text, /ask the user for\s+that commit's message before you run it/);
    });

    it(`${name}: runs deep-review answer when the user answers a question or a departure, and says what each outcome means (R12 of answers)`, () => {
      const text = read(path);
      assert.match(text, /The report's Decisions section lists the questions the run asked and\s+the fixes that depart from a rule, each ending with the\s+`deep-review answer` command that answers it\./);
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}" answer --finding <id> --option <n>`), 'the answer subcommand of the same bundle');
      assert.match(text, /`--accept` or `--reject` in place of `--option <n>` for a\s+departure, and `--note <text>` with what the user said beyond the\s+choice/);
      assert.match(text, /as a background shell command with\s+the longest timeout you can/);
      assert.match(text, /the last line of stdout is the new report's\s+path: show it as in step 4 and offer to commit the new edits as in\s+step 5/);
      assert.match(text, /it says that `review --fix`\s+applies the answer: offer to run the step 3 command with `--fix`/);
      assert.match(text, /When it says the tree already holds the answer, tell the user nothing\s+was applied/);
      assert.match(text, /Exit code 2: show stderr verbatim and stop; when it says\s+the answer is recorded, the same command applies it once the cause\s+it names is gone/);
      assert.ok(text.indexOf(' commit\n') < text.indexOf(' answer --finding') && text.indexOf(' answer --finding') < text.indexOf('Exit code 2: the run is blocked'), 'after the commit step, before the blocked run');
      assert.doesNotMatch(text, /write the rule|record the rule/, 'nothing about writing a rule (PD3 of answers)');
    });

    // R9, R15 of the configuration: the engine applies the default scope, and the skill names a scope only when the user does.
    it(`${name}: gives a scope flag only for a scope the user names, and leaves the rest to the engine's configuration`, () => {
      const text = read(path);
      const step1 = text.slice(text.indexOf('1. Decide the scope'), text.indexOf('2. Decide whether to fix'));
      assert.match(step1, /- the user's branch: `--branch`, adding `--base <rev>` when the user\s+names what the branch starts from/);
      assert.match(step1, /With no instruction, pass no scope flag: the engine chooses the scope\s+its configuration names\./);
      assert.doesNotMatch(text, /git status/, 'the engine applies the rule the skill held in prose');
      // Every scope flag step 1 names is one the engine takes.
      const usage = read('src/cli.ts');
      for (const flag of step1.match(/--[a-z-]+/g) ?? []) assert.ok(usage.includes(`'${flag.slice(2)}'`) || usage.includes(` ${flag.slice(2)}: {`), `${flag} is a flag of review`);
    });

    it(`${name}: shows the configuration with config show when asked about it, and writes the repository's file only as an edit the user asks for`, () => {
      const text = read(path);
      assert.match(text, /When the user asks how deep-review is configured, or why a run reviewed\s+what it did, run the step 3 command with `config show` in place of\s+`review`, with the same scope flags and no `--fix`, and show what it\s+prints\./);
      assert.match(text, /When the user asks to change a preference, name the file that\s+`config show` lists for it\./);
      assert.match(text, /Write the repository's\s+`\.deep-review\/config\.toml` only as a change the user asks for, as any\s+other edit, never as a step of a review\./);
    });

    it(`${name}: answers a check-unavailable blocker with the flag the user chooses, after showing it (R15 of the repository survey)`, () => {
      const text = read(path);
      assert.match(text, /A `check-unavailable` blocker names a check the project defines whose\s+tool this machine lacks/);
      assert.match(text, /run the same\s+command again, adding `--no-check <kind>` if they choose to go\s+without that check or `--check <kind>=<command>` if they name one\s+that runs, and nothing if they installed the tool/);
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

  it('tells a Codex fix run on Windows that its editors are unsandboxed, and offers the sandbox only when the user names it', () => {
    const codex = read('skill/codex/SKILL.md');
    // The shipped windowsSandbox is none: the editing workers run with no sandbox and network access.
    assert.match(codex, /With `--fix` on Windows,\s+also tell the user that the workers that edit run with no sandbox and\s+with network access/);
    // Each offered value carries its cost, so the user chooses knowing it.
    assert.match(codex, /`--codex-windows-sandbox unelevated`, under which they cannot run most\s+build and test commands/);
    assert.match(codex, /`--codex-windows-sandbox elevated`, which\s+needs Codex's elevated setup/);
    assert.match(codex, /pass that flag only when the user names\s+it/);
    // The engine refuses --codex-windows-sandbox with --runtime claude, so the Claude skill must never offer it.
    assert.doesNotMatch(read('skill/claude/skills/deep-review/SKILL.md'), /codex-windows-sandbox|windowsSandbox/);
  });

  it('tells the Codex skill to poll the command until it exits and not to end the turn, since codex exec stops it (R15 of the configuration)', () => {
    assert.match(read('skill/codex/SKILL.md'), /When the command returns to you before it exits, poll it until it\s+exits, and do not end your turn while it runs: `codex exec` stops a\s+command that still runs when the turn ends\./);
  });

  /**
   * The lines each runtime words its own way (TD11 of the configuration):
   * the description and the invocation setting of the front matter, the
   * run budget, the Codex Windows sandbox, how to run the command and
   * wait for it, and the path of the engine. Every other line is the same
   * in both skills, so a change to one that forgets the other fails here.
   */
  const ownWords: Readonly<Record<string, readonly string[]>> = {
    'skill/claude/skills/deep-review/SKILL.md': [
      'description: Deep review of a change by the deep-review engine, a Node program installed with this plugin. It runs the SCAN triage, nine more finder angles, deduplication, verification, a gap sweep, a merge-and-rank pass and a decision pass, and writes a Markdown report; when the user asks, its own workers also apply the fixes and it runs the project\'s checks, committing nothing. Use only when the user asks for deep-review by name.\n',
      'disable-model-invocation: true\n',
      '   user limited the review to. Pass `--budget-usd <usd>` only when the\n   user names a run budget; the default is 60 USD.\n',
      '   review then edits nothing and runs no check.\n',
      '3. Run this from the repository as a background shell command with the\n   longest timeout you can, and wait for it to exit:\n',
    ],
    'skill/codex/SKILL.md': [
      'description: Deep review of a change by the deep-review engine, a Node program installed with this skill. It runs the SCAN triage, nine more finder angles, deduplication, verification, a gap sweep, a merge-and-rank pass and a decision pass, and writes a Markdown report; when the user asks, its own workers also apply the fixes and it runs the project\'s checks, committing nothing. Use only when the user asks for $deep-review by name.\n',
      '   user limited the review to. `--budget-usd` does not apply to Codex,\n   which reports no cost; do not pass it.\n',
      '   review then edits nothing and runs no check. With `--fix` on Windows,\n   also tell the user that the workers that edit run with no sandbox and\n   with network access unless the user names\n   `--codex-windows-sandbox unelevated`, under which they cannot run most\n   build and test commands, or `--codex-windows-sandbox elevated`, which\n   needs Codex\'s elevated setup; pass that flag only when the user names\n   it.\n',
      '3. Run this from the repository, with the longest timeout you can, and\n   wait for it to exit. `engine/main.mjs` is in this skill\'s directory,\n   the one that holds this SKILL.md:\n',
      '   When the command returns to you before it exits, poll it until it\n   exits, and do not end your turn while it runs: `codex exec` stops a\n   command that still runs when the turn ends.\n\n',
    ],
  };

  /** A skill's text less the lines its runtime words its own way, each of which must be there, with the engine's path and runtime named alike. */
  const sharedText = (path: string): string => {
    let text = read(path).replaceAll('\r\n', '\n');
    for (const own of ownWords[path]!) {
      assert.ok(text.includes(own), `${path} still words this its own way: ${JSON.stringify(own.slice(0, 60))}`);
      text = text.replace(own, '');
    }
    return text.replaceAll('${CLAUDE_PLUGIN_ROOT}', '<root>').replaceAll('<this skill\'s directory>', '<root>').replaceAll('--runtime claude', '--runtime <runtime>').replaceAll('--runtime codex', '--runtime <runtime>');
  };

  it('keeps the two skills one text, except for the lines each runtime words its own way (TD11 of the configuration)', () => {
    const claude = sharedText('skill/claude/skills/deep-review/SKILL.md').split('\n');
    const codex = sharedText('skill/codex/SKILL.md').split('\n');
    assert.deepEqual(codex, claude);
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
