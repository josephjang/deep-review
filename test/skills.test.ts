import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { engineBundleName, engineDirectoryName } from '../src/build/bundle.ts';
import { settingNames } from '../src/config/settings.ts';
import { blockerActions } from '../src/review/vocabulary.ts';

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
      assert.match(text, /it says that `review --fix`\s+applies the answer: offer to run step 3 again with `--fix`/);
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
      assert.match(text, /When the user asks how deep-review is configured, or why a run reviewed\s+what it did, run the `config show` command of step 3 with the same\s+scope flags and no `--fix`, and show all that it prints\./);
      assert.match(text, /When the user\s+asks to change a preference, name the file that\s+`config show` lists for it\./);
      // R3 of the skill surface corrections: a new file comes from config init, each setting commented at its default, not from TOML the model writes.
      assert.match(text, /When the user asks for a configuration file\s+that does not exist yet, run the `main\.mjs` of step 3 with only\s+`config init --repository`, `config init --operator` or\s+`config init --clone`, for the repository's file, the operator's or\s+this clone's\./);
      assert.match(text, /It writes a new file with each setting as a comment at\s+its default and a sentence that says what the setting does, prints the\s+file's path, and refuses to write over a file that exists; then edit\s+that file as the user asks\./);
      // config init takes none of the review's flags, so the skill gives it none, and it refuses a file that exists, as the skill says.
      const usage = read('src/cli.ts');
      const init = /^\s*init: \[([^\]]*)\]/m.exec(usage);
      assert.ok(init !== null, 'config init has a flag list');
      for (const flag of ['repository', 'operator', 'clone']) assert.ok(init[1]!.includes(`'${flag}'`), `--${flag} is a flag of config init`);
      assert.ok(usage.includes('exists, and config init writes only a new file'), 'config init refuses to write over a file');
      assert.match(text, /Write the repository's\s+`\.deep-review\/config\.toml` only as a change the user asks for, as any\s+other edit, never as a step of a review\./);
    });

    // R2 and PD1 of the skill surface corrections: the user sees the scope, the budget and the fix choice before the run, and nothing waits for the user.
    it(`${name}: shows the scope, the budget and the fix choice with config show before the review, and does not wait`, () => {
      const text = read(path);
      const step3 = text.slice(text.indexOf('3. '), text.indexOf('4. Exit code 0'));
      const show = step3.match(/^ {3}node "[^"\n]+" config show (.*)$/m);
      const review = step3.match(/^ {3}node "[^"\n]+" review (.*)$/m);
      assert.ok(show !== null && review !== null, 'step 3 holds both commands');
      // The same engine, runtime and flags, so the scope shown is the scope reviewed.
      assert.equal(show[0].replace(' config show ', ' review '), review[0]);
      assert.equal(show[1], `--runtime ${runtime} <scope flags> [--fix]`);
      assert.ok(show.index! < review.index!, 'config show runs before the review');
      // In the reply, not only as the command's output: the smoke on Claude Code showed a model that ran config show and told the user nothing of it.
      assert.match(step3, /When it exits 0, your next step is a message to the user, not a tool\s+call: quote its `Scope:` line and the `budget\.usd` line under its\s+`Settings:` exactly as it prints them, and say whether the run fixes\.\s+The user does not see the command's output, so this message is where\s+they see the scope\./);
      assert.match(step3, /start the review at once: do not ask the user\s+to confirm, and do not wait for an answer\./);
      assert.match(step3, /A user who sees a wrong\s+scope stops the review/);
      assert.match(step3, /When `config show`\s+exits with code 2, show stderr verbatim and stop, as step 7 says for a\s+refusal\./);
      // A command with anything chained to it is not the command the Claude Code approval names (R4).
      assert.match(text, /Run each command below as it is written, alone, with nothing\s+chained before or after it\./);
      assert.doesNotMatch(step3, /wait for (the user|a yes|confirmation)|ask the user whether/);
      // The two lines the skill names are lines config show prints.
      // The words the skill names, not the code that fills them in.
      assert.ok(read('src/config/command.ts').includes('`Scope: '), 'config show prints a Scope: line');
      assert.ok(read('src/config/command.ts').includes('\'Settings:\''), 'config show prints a Settings: header');
      assert.ok((settingNames as readonly string[]).includes('budget.usd'), 'budget.usd is a setting config show lists');
    });

    it(`${name}: answers a check-unavailable blocker with the flag the user chooses, after showing it (R15 of the repository survey)`, () => {
      const text = read(path);
      assert.match(text, /A `check-unavailable` blocker names a check the project defines whose\s+tool this machine lacks/);
      assert.match(text, /run the same\s+command again, adding `--no-check <kind>` if they choose to go\s+without that check or `--check <kind>=<command>` if they name one\s+that runs, and nothing if they installed the tool/);
      // R8 and PD7 of the skill surface corrections: the clone's file settles the kind for a new run, so the skill closes the blocked one first.
      assert.match(text, /When they choose to\s+settle it in the clone's file instead, write that file with\s+`config init --clone` when it does not exist, as the configuration\s+paragraph below says, set its `checks\.<kind>` line as they ask, then\s+close the blocked run with `abandon --reason <text>` and run the same\s+command again, which starts a new run: the blocked run keeps the\s+settings it recorded\./);
      // The way out the skill offers is one the engine's action names.
      assert.ok(blockerActions['check-unavailable'].includes('checks.<kind> in the clone\'s file, which deep-review config init --clone writes, then abandon this run and start a new one'));
    });
  }

  it('keeps the Claude skill out of automatic invocation and the Codex skill out of implicit invocation', () => {
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), /^disable-model-invocation: true$/m);
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), /\$\{CLAUDE_PLUGIN_ROOT\}\/engine\/main\.mjs/);
    assert.match(read('skill/codex/agents/openai.yaml'), /allow_implicit_invocation: false/);
    assert.doesNotMatch(read('skill/codex/agents/openai.yaml'), /not shipped/);
  });

  /** The front matter of a skill: the lines between its two `---` lines. */
  const frontMatter = (path: string): string[] => {
    const lines = read(path).replaceAll('\r\n', '\n').split('\n');
    assert.equal(lines[0], '---', `${path} opens with its front matter`);
    const end = lines.indexOf('---', 1);
    assert.ok(end > 0, `${path} closes its front matter`);
    return lines.slice(1, end);
  };

  // R4 and PD3 of the skill surface corrections: the Claude Code skill approves the engine's command, and nothing else, for the turn the user invokes it.
  it('approves only the engine\'s own command in the Claude skill, in the form every command of the skill takes', () => {
    const text = read('skill/claude/skills/deep-review/SKILL.md');
    const lines = frontMatter('skill/claude/skills/deep-review/SKILL.md').filter((line) => line.startsWith('allowed-tools:'));
    assert.deepEqual(lines, ['allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)'], 'one line with one rule');
    // A Bash rule matches the command text as Claude writes it, quotes included, so every command of the skill starts with the rule's text before its `*`.
    const prefix = 'node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" ';
    const commands = text.split('\n').filter((line) => line.trimStart().startsWith('node '));
    assert.ok(commands.length >= 4, 'config show, review, commit and answer');
    for (const command of commands) assert.ok(command.trimStart().startsWith(prefix), `${command.trim()} is a command the rule approves`);
    assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}`));
    // Codex has no such setting, so its skill has no such line.
    assert.ok(!frontMatter('skill/codex/SKILL.md').some((line) => line.startsWith('allowed-tools:')));
  });

  // R5 of the skill surface corrections: the autocomplete of Claude Code shows what the user can type after the command.
  it('hints the arguments of the Claude skill, quoted so YAML reads one string, and gives the Codex skill no hint', () => {
    const lines = frontMatter('skill/claude/skills/deep-review/SKILL.md').filter((line) => line.startsWith('argument-hint:'));
    // Unquoted, a value that starts with `[` is a YAML flow sequence, and the text after its `]` makes the front matter invalid.
    assert.deepEqual(lines, ['argument-hint: "[worktree | last commit | branch | from <rev>] [fix] [path ...]"']);
    assert.ok(!frontMatter('skill/codex/SKILL.md').some((line) => line.startsWith('argument-hint:')));
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
   * the description and the invocation setting of the front matter, and
   * the approval of the engine's command and the argument hint that only
   * Claude Code has (R6 of the skill surface corrections), the run budget,
   * the Codex Windows sandbox, how to run the commands of step 3 and wait
   * for them, and the path of the engine. Every other line is the same
   * in both skills, so a change to one that forgets the other fails here.
   */
  const ownWords: Readonly<Record<string, readonly string[]>> = {
    'skill/claude/skills/deep-review/SKILL.md': [
      'description: Deep review of one change by the deep-review engine, a Node program installed with this plugin. It writes a Markdown report with the evidence for each finding and the engine\'s own decision on it, asks only the questions a person must answer, names the fixes that depart from a rule, and says what the run did not examine; when the user asks, its own workers also apply the fixes and it runs the project\'s checks, committing nothing. Use only when the user asks for deep-review by name.\n',
      'disable-model-invocation: true\n',
      'allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)\n',
      'argument-hint: "[worktree | last commit | branch | from <rev>] [fix] [path ...]"\n',
      '   user limited the review to. Pass `--budget-usd <usd>` only when the\n   user names a run budget; the default is 60 USD.\n',
      '   review then edits nothing and runs no check.\n',
      '   exit:\n',
      '   Run the review from the repository as a background shell command with\n   the longest timeout you can, and wait for it to exit:\n',
    ],
    'skill/codex/SKILL.md': [
      'description: Deep review of one change by the deep-review engine, a Node program installed with this skill. It writes a Markdown report with the evidence for each finding and the engine\'s own decision on it, asks only the questions a person must answer, names the fixes that depart from a rule, and says what the run did not examine; when the user asks, its own workers also apply the fixes and it runs the project\'s checks, committing nothing. Use only when the user asks for $deep-review by name.\n',
      '   user limited the review to. `--budget-usd` does not apply to Codex,\n   which reports no cost; do not pass it.\n',
      '   review then edits nothing and runs no check. With `--fix` on Windows,\n   also tell the user that the workers that edit run with no sandbox and\n   with network access unless the user names\n   `--codex-windows-sandbox unelevated`, under which they cannot run most\n   build and test commands, or `--codex-windows-sandbox elevated`, which\n   needs Codex\'s elevated setup; pass that flag only when the user names\n   it.\n',
      '   exit. `engine/main.mjs` is in this skill\'s directory, the one that\n   holds this SKILL.md:\n',
      '   Run the review from the repository, with the longest timeout you can,\n   and wait for it to exit:\n',
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

  // R1 of the skill surface corrections: a user who reads the description in a plugin or skill list learns what a run gives, not how the engine is built.
  it('describes the plugin as carrying the engine and by what a run gives, in the plugin and the marketplace alike, and no longer as editing nothing', () => {
    for (const path of ['skill/claude/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skill/claude/skills/deep-review/SKILL.md', 'skill/codex/SKILL.md', 'skill/codex/agents/openai.yaml']) {
      const text = read(path);
      if (!path.endsWith('.yaml')) assert.match(text, /a Node program installed with this (plugin|skill)/, path);
      assert.doesNotMatch(text, /skeleton|no engine|editing nothing/, path);
      assert.match(text, /fixes/, `${path} says the engine can apply the fixes`);
      assert.match(text, /the questions a person must answer/, `${path} names the questions`);
      assert.match(text, /the fixes that depart from a rule/, `${path} names the departures`);
      assert.match(text, /what the run did not examine/, `${path} names what the run did not examine`);
      assert.match(text, /committing nothing/, `${path} says the run commits nothing`);
      assert.doesNotMatch(text, /SCAN|triage|finder angles|deduplication|sweep|merge-and-rank|decision pass/, `${path} lists no phase of the engine`);
    }
    // The installed plugin and its entry in the plugin list are one text.
    const plugin = (JSON.parse(read('skill/claude/.claude-plugin/plugin.json')) as { description: string }).description;
    const listed = (JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins: { name: string; description: string }[] }).plugins.find((entry) => entry.name === 'deep-review');
    assert.equal(listed?.description, plugin);
    // The trigger sentence stays, so neither host starts the skill but on the user's word.
    assert.match(read('skill/claude/skills/deep-review/SKILL.md'), /^description: .* Use only when the user asks for deep-review by name\.$/m);
    assert.match(read('skill/codex/SKILL.md'), /^description: .* Use only when the user asks for \$deep-review by name\.$/m);
  });
});
