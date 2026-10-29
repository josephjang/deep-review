import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { engineBundleName, engineDirectoryName } from '../src/build/bundle.ts';
import { main } from '../src/command.ts';
import { settingNames } from '../src/config/settings.ts';
import { blockerActions, continuedCheckUnavailableAction } from '../src/review/vocabulary.ts';

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
      // The short form of the brief as printed, then the path (R13, R17 of the brief of a run).
      assert.match(text, /Exit code 0: stdout ends with the top of the run's brief: its title\s+and the line of the change, the status line, What needs you and\s+Before you merge as the report has them, and a line that names\s+`report --fixes`; its last line is the report's path\. Show the lines\s+before the path to the user in a code block, as printed, then show\s+the path and say the report is theirs to read: it starts with the\s+brief, and a block for each finding and the evidence follow\./);
      assert.match(text, /When the user asks what a finished run found, run the `main\.mjs` of\s+step 3 with only `report`, adding `--run <id>` when they name a run,\s+and show what it prints as step 4 says\./);
      assert.match(text, /Exit code 2: the run is blocked or was refused/);
      // The blocker as printed and nothing more: the interactive smoke showed a model that retold a budget block wrongly.
      assert.match(text, /Show both verbatim in a code\s+block and stop, with no account of your own of what the run did,\s+spent or left undone\./);
      assert.match(text, /Any other exit code: show stderr verbatim/);
      assert.match(text, /wait for it to exit/);
      assert.match(text, /Do not poll the\s+ledger/);
      assert.match(text, /run the same\s+command again/);
      assert.match(text, /Do\s+not summarize, quote or interpret the findings/);
      // The host answers in the person's language and quotes what the engine prints as it prints it (R12 of the report for the person).
      assert.match(text, /Answer the user in the language that the user writes, and quote ids,\s+paths and commands as printed\./);
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
      assert.match(text, /Without such a request, do not pass `--fix`/);
      // A finished read-only run of the unchanged change is continued, not reviewed again (R11 of fix pass continuation).
      assert.match(text, /When a read-only run of the same\s+change has finished and the change is unchanged since, the same\s+command with `--fix` continues that run and reviews nothing again,\s+so the fixes are of the findings the user read\./);
      const review = text.indexOf(`review --runtime ${runtime}`);
      if (runtime === 'codex') {
        // The Codex skill tells the user before the command, in step 2, since Codex shows a message the model writes before a command (R13 of the questions in the chat).
        assert.match(text, /tell the\s+user that the engine's workers will edit the working tree, that it\s+runs the check commands it chose from the repository, and that the\s+run commits nothing/);
        assert.ok(text.indexOf('continues that run') < text.indexOf('Before you run it, tell the') && text.indexOf('Before you run it, tell the') < review, 'the continuation, then the warning, then the command');
      } else {
        // The Claude Code skill says it in the message of step 3, after the review starts, where the model writes text (PD10 of the questions in the chat).
        const warning = text.search(/For\s+a fix run, also say that the engine's workers will edit the working\s+tree, that it runs the check commands it chose from the repository,\s+and that the run commits nothing\./);
        assert.ok(warning > review, 'the warning comes in the message after the review starts');
        assert.doesNotMatch(text, /Before you run it, tell the/);
        assert.match(text, /The message of step 3 tells the user what a fix run\s+does\./);
        // A run that --fix continues is warned of in the same message, after it starts (R13 of the questions in the chat), so no warning comes before the command.
        assert.doesNotMatch(text.slice(0, review), /tell the user before you\s+run the review|will edit the working\s+tree/, 'no warning before the command, also for a continued run');
        // A continued run is in its fixes phase from its start, so the skill does not say that every run has edited nothing until the message is read.
        assert.doesNotMatch(text, /until its fixes phase the run has edited nothing/);
        assert.match(text, /a run that reviews edits nothing until its fixes phase\./);
      }
      assert.match(text, /the fixes are in the working tree,\s+uncommitted, one\s+patch per\s+finding as the report's Patches lists them/);
      assert.match(text, /offer\s+to commit them/);
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}" commit`), 'the commit subcommand of the same bundle');
      assert.match(text, /adding `--change-message <message>` when the scope was `--worktree`/);
      assert.match(text, /ask the user for\s+that commit's message before you run it/);
    });

    it(`${name}: runs deep-review answer when the user answers a question or a departure, and says what each outcome means (R12 of answers)`, () => {
      const text = read(path);
      assert.match(text, /The brief at the top of the report lists, under What needs you, the\s+questions the run asked and the fixes that go against a written rule,\s+each with the `deep-review answer` command that answers it\./);
      // A number names a finding only within its run, so the template names the run as the brief's command does (R7 of the report for the person).
      assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}" answer --run <run> --finding <number> --option <n>`), 'the answer subcommand of the same bundle');
      assert.ok(read('src/review/needs.ts').includes('`deep-review answer --run ${shortRunId(run)} --finding ${String(finding)} ${choice}`'), 'the brief\'s command has the same shape');
      assert.match(text, /with the run, the finding's number and the option's number as that\s+item's `deep-review answer` command prints them, the run being the\s+eight characters of its id that the command names/);
      assert.match(text, /`--accept` or\s+`--reject` in place of `--option <n>` for a departure, and `--note <text>` with what the user said beyond the\s+choice/);
      assert.match(text, /as a background shell command with\s+the longest timeout you can/);
      assert.match(text, /stdout ends with the top of the brief\s+and the new report's path: show them as in step 4 and offer to commit\s+the new edits as in step 5/);
      assert.match(text, /it says that `review --fix`\s+applies the answer: offer to run step 3 again with `--fix`/);
      assert.match(text, /When it says the tree already holds the answer, tell the user nothing\s+was applied/);
      assert.match(text, /Exit code 2: show stderr verbatim and stop; when it says\s+the answer is recorded, the same command applies it once the cause\s+it names is gone/);
      assert.ok(text.indexOf(' commit\n') < text.indexOf(' answer --run') && text.indexOf(' answer --run') < text.indexOf('Exit code 2: the run is blocked'), 'after the commit step, before the blocked run');
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
      const usage = read('src/command.ts');
      for (const flag of step1.match(/--[a-z-]+/g) ?? []) assert.ok(usage.includes(`'${flag.slice(2)}'`) || usage.includes(` ${flag.slice(2)}: {`), `${flag} is a flag of review`);
    });

    it(`${name}: shows the configuration with config show when asked about it, and writes the repository's file only as an edit the user asks for`, () => {
      const text = read(path);
      assert.match(text, /When the user asks how deep-review is configured, or what a run would\s+take now, run the `config show` command of step 3 with the same scope\s+flags and no `--fix`, and show all that it prints\./);
      // A question about a run is answered from that run's record: config show reads today's files and flags, which may differ from those the run recorded or a resume ignored.
      assert.match(text, /When the user asks\s+why a run reviewed what it did, answer from that run's own record, not\s+from `config show`, which reads today's files and flags: for the active\s+run, run the `status` command of step 3 and show all that it prints;\s+for a finished run, show the `Settings:` line of the facts of the run,\s+the part `## About this run` at the end of its report, and the paragraph\s+under Before you merge in its brief that says what the run did not\s+examine, exactly as the report prints them\./);
      assert.doesNotMatch(text, /why a run reviewed\s+what it did, run the `config show`/);
      // The record the skill names holds the run's settings: status and the report give the same settings lines.
      assert.ok(read('src/review/status.ts').includes('settingsHeaderLine(') && read('src/review/status.ts').includes('settingsLimitations('), 'status prints the run\'s recorded settings');
      // The report gives the settings line in the facts of the run, the paths left out among the gaps of the brief, and the rest in the notes of the run (R10, R12 of the brief of a run).
      assert.ok(read('src/review/report.ts').includes('settingsHeaderLine(') && read('src/review/report.ts').includes('settingsNotes(') && read('src/review/brief.ts').includes('scope.excluded'), 'the report prints the run\'s recorded settings');
      assert.ok(read('src/review/report.ts').includes('\'## About this run\'') && read('src/review/report.ts').includes('\'## What the review covered\''), 'the report has the facts of the run and what the review covered (R8 of the report for the person)');
      assert.match(text, /When the user\s+asks to change a preference, name the file that\s+`config show` lists for it\./);
      // R3 of the skill surface corrections: a new file comes from config init, each setting commented at its default, not from TOML the model writes.
      assert.match(text, /When the user asks for a configuration file\s+that does not exist yet, run the `main\.mjs` of step 3 with only\s+`config init --repository`, `config init --operator` or\s+`config init --clone`, for the repository's file, the operator's or\s+this clone's\./);
      assert.match(text, /It writes a new file with each setting as a comment at\s+its default and a sentence that says what the setting does, prints the\s+file's path, and refuses to write over a file that exists; then edit\s+that file as the user asks\./);
      // config init takes none of the review's flags, so the skill gives it none, and it refuses a file that exists, as the skill says.
      const usage = read('src/command.ts');
      const init = /^\s*init: \[([^\]]*)\]/m.exec(usage);
      assert.ok(init !== null, 'config init has a flag list');
      for (const flag of ['repository', 'operator', 'clone']) assert.ok(init[1]!.includes(`'${flag}'`), `--${flag} is a flag of config init`);
      assert.ok(usage.includes('exists, and config init writes only a new file'), 'config init refuses to write over a file');
      assert.match(text, /Write the repository's\s+`\.deep-review\/config\.toml` only as a change the user asks for, as any\s+other edit, never as a step of a review\./);
    });

    // R10, R11, R14 of the questions in the chat: the engine prints what a person asks about a run, and the skill relays the result last.
    it(`${name}: names the commands that give one finding, the brief and the fixes, runs report after commit, and finds a run by its start or from the list`, () => {
      const text = read(path);
      const step4 = text.slice(text.indexOf('4. Exit code 0'), text.indexOf('5. '));
      assert.match(step4, /Put them\s+in the last message of the turn, after any other command you run\./);
      assert.match(step4, /When the user asks for more on one finding, run the `main\.mjs` of\s+step 3 with only `report --finding <number>`, with the number that\s+the brief shows\./);
      assert.match(step4, /When the user asks for the whole result, run it with\s+only `report --brief`; when the user asks what the run changed, with\s+only `report --fixes`; when the user asks for the statistics of the\s+run, with only `report --stats`\./);
      assert.match(step4, /Show the lines before the path as\s+printed, the Markdown of `--brief`, `--finding` and `--stats` as\s+Markdown, and then the path\./);
      const step5 = text.slice(text.indexOf('5. When the user accepts'), text.indexOf('6. '));
      assert.match(step5, /On exit code 2, show stderr\s+verbatim and stop\. On exit code 0, run the `main\.mjs` of step 3 with\s+only `report`, and in the last message of the turn show the lines that\s+`commit` printed, one per commit, and then what `report` printed, as\s+step 4 says: the brief that the review printed still says that the\s+fixes are not committed\./);
      assert.match(text, /`--run` takes the eight\s+characters of a run id that the brief shows\. When the user asks for a\s+run and does not know which, run it with only `status --all`, show what\s+it prints, and then run `report --run <id>` with the run the user\s+chooses\./);
      // The flags the skill names are flags of report and status, and the short form that report prints after a commit names the commits.
      const usage = read('src/command.ts');
      for (const flag of ['brief', 'fixes', 'finding', 'all']) assert.ok(usage.includes(`'${flag}'`), `--${flag} is a flag the engine takes`);
      assert.ok(usage.includes('[--json | --brief | --fixes | --stats | --finding <number>]') && usage.includes('deep-review status  --all'), 'the usage names them');
      assert.ok(read('src/review/runs.ts').includes('export const shortRunIdLength = 8;'), '--run takes the eight characters the brief shows');
      assert.ok(read('src/review/brief.ts').includes(', and the fixes are committed.'), 'the status line says once a run committed its fixes (R14 of the report for the person)');
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
      // The review resumes an active run with the scope it recorded, ignoring the scope flags, and config show never looks for one: status comes first, with the same engine.
      const status = step3.match(/^ {3}node "[^"\n]+" status$/m);
      assert.ok(status !== null && status.index! < show.index!, 'status runs before config show');
      assert.equal(status[0].replace(/ status$/, ' review '), review[0].slice(0, review[0].indexOf(' review ') + ' review '.length));
      assert.match(step3, /When it prints no line that starts with `Run `, no run is active\./);
      // A retelling stays right because the Scope: line names both ends of the change (R11, tested with config show), so the skill no longer explains them.
      assert.doesNotMatch(step3, /the commit after `from`/);
      assert.doesNotMatch(step3, /next step is a message|not a tool\s+call/);
      if (runtime === 'codex') {
        // Codex shows a message the model writes before a command, and its review runs in the foreground of the turn, so its order stays (R13 of the questions in the chat).
        assert.match(step3, /When `status` prints a `Run ` line instead, that run is active and the\s+review below resumes it: run no `config show`, and in that message\s+copy the `Run `, `Scope:` and `Settings:` lines of `status` into a\s+code block, character for character, and say that the review\s+continues that run with the scope and the settings it recorded and\s+ignores the scope flags\./);
        // In the reply, not only as the command's output: the smoke on Claude Code showed a model that ran config show and told the user nothing of it.
        assert.match(step3, /When it exits 0, write the user a message before your next tool call,\s+in this same reply: copy its `Scope:` line and the `budget\.usd` line\s+under its `Settings:` into a code block, character for character, and\s+below it say whether the run fixes\./);
        assert.match(step3, /The user does not see the command's output, so this message is where\s+they see the scope\./);
        // A reply with the message alone ends the turn: `codex exec` ends the session, so no review runs.
        assert.match(step3, /Then, in the same reply, start the review at once;\s+the message does not end your turn: do not ask the user to confirm,\s+and do not wait for an answer\./);
        assert.match(step3, /A user who sees a wrong scope stops the\s+review/);
        // A stopped run stays active, and the next review would resume it with the wrong scope.
        // Esc leaves the engine running, so this abandon can meet lock-held; the Codex skill does not say to end it first: https://github.com/josephjang/deep-review/issues/76
        assert.match(step3, /When the user stops it because its scope is wrong,\s+close it with `abandon --reason <text>` before you run the corrected\s+request, so that the next review starts a new run rather than resume\s+this one\./);
      } else {
        // The message comes after the review starts, as the last text of the turn, where the model writes text and not its thinking (R13, PD10 of the questions in the chat).
        assert.match(step3, /When it exits 0, keep its `Scope:` line\s+and the `budget\.usd` line under its `Settings:` for the message below\./);
        assert.match(step3, /When `status` prints a `Run ` line instead, that run is active and the\s+review below resumes it: run no `config show`, and keep the `Run `,\s+`Scope:` and `Settings:` lines of `status` for the message below\./);
        assert.match(step3, /Then start the review at once, from the repository, as a background\s+shell command with the longest timeout you can: do not ask the user\s+to confirm, and do not wait for an answer\./);
        const message = step3.search(/Once it runs, write the user a message as the last text of this turn\./);
        assert.ok(message > review.index!, 'the message comes after the review starts');
        assert.match(step3, /The user does not see the commands' output, so this message is where\s+they see the scope: copy the lines you kept into a code block,\s+character for character, and below it say whether the run fixes\./);
        assert.match(step3, /For an active run, say that the\s+review continues that run with the scope and the settings it recorded\s+and ignores the scope flags\. Then end the turn: the review goes on,\s+and when it exits you go on with step 4\./);
        assert.doesNotMatch(step3, /before your next tool call|in the same reply/);
        // abandon refuses a run whose engine holds its lock, so the background command stops first.
        assert.match(step3, /When\s+the user stops it because its scope is wrong, stop the background\s+command first, since `abandon` refuses a run whose engine still runs;\s+then close the run with `abandon --reason <text>` before you run the\s+corrected request, so that the next review starts a new run rather\s+than resume this one\./);
        assert.ok(read('src/review/lock.ts').includes('is running run'), 'abandon refuses a run another engine holds');
      }
      // The lines the skill names are lines status prints, and the resume is the one the engine logs.
      const command = read('src/command.ts');
      assert.ok(command.includes('\'No active run.\\n\'') && command.includes('\'No run: this repository has no checkpoint yet.\\n\''), 'status prints no Run line when no run is active');
      assert.ok(read('src/review/status.ts').includes('`Run ${state.id}: ${status}'), 'status opens with a Run line');
      assert.ok(read('src/review/status.ts').includes('settingsHeaderLine(review.configuration)'), 'status prints the Settings: line');
      assert.ok(read('src/review/status.ts').includes('scopeLine(shown)') && read('src/scope/scope-line.ts').includes('return scope.empty === null ? `Scope: '), 'status prints a Scope: line for an active run (R12 of the questions in the chat)');
      assert.ok(read('src/review/controller.ts').includes('is active; its scope flags are ignored and the run continues'), 'a review resumes an active run and ignores its scope flags');
      assert.match(step3, /When `config show` exits with code 2, show stderr verbatim\s+and\s+stop,\s+as step 7 says for a refusal\./);
      // A command with anything chained to it is not the command the Claude Code approval names (R4).
      assert.match(text, /Run each command below as it is written, alone, with nothing\s+chained before or after it\./);
      assert.doesNotMatch(step3, /wait for (the user|a yes|confirmation)|ask the user whether/);
      // The two lines the skill names are lines config show prints.
      // The words the skill names, not the code that fills them in.
      assert.ok(read('src/scope/scope-line.ts').includes('`Scope: ') && read('src/config/command.ts').includes('scopeLine(scope)'), 'config show prints a Scope: line');
      assert.ok(read('src/config/command.ts').includes('\'Settings:\''), 'config show prints a Settings: header');
      assert.ok((settingNames as readonly string[]).includes('budget.usd'), 'budget.usd is a setting config show lists');
    });

    it(`${name}: answers a check-unavailable blocker with the flag the user chooses, after showing it (R15 of the repository survey)`, () => {
      const text = read(path);
      assert.match(text, /A `check-unavailable` blocker names a check the project defines whose\s+tool this machine lacks/);
      assert.match(text, /run the same\s+command again, adding `--no-check <kind>` if they choose to go\s+without that check or `--check <kind>=<command>` if they name one\s+that runs, and nothing if they installed the tool/);
      // R8 and PD7 of the skill surface corrections: the clone's file settles the kind for a new run, so the skill closes the blocked one first.
      assert.match(text, /When the action\s+names the clone's file and they choose to settle it there instead,\s+write that file with `config init --clone` when it does not exist,\s+as the configuration paragraph below says, set its `checks\.<kind>`\s+line as they ask, then close the blocked run with\s+`abandon --reason <text>` and run the same command again, which\s+starts a new run: the blocked run keeps the settings it recorded\./);
      // A continued run's abandon would lose its read-only review, so its action leaves the clone's file out, and the skill offers it only when the action names it.
      assert.match(text, /The\s+action of a run that `--fix` continued from a read-only review does\s+not name that file, since an abandoned run cannot be continued and its\s+review would be lost; do not offer it then\./);
      // The way out the skill offers is one the engine's action names, and only the action of a run not continued names it.
      assert.ok(blockerActions['check-unavailable'].includes('checks.<kind> in the clone\'s file, which deep-review config init --clone writes, then abandon this run and start a new one'));
      assert.ok(!continuedCheckUnavailableAction.includes('clone\'s file'));
    });
  }

  // A new Claude Code session that asks for a result without naming the skill therefore searches for it first: https://github.com/josephjang/deep-review/issues/77
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
    // A YAML list, since each rule holds spaces and quotes: one rule for each shell tool Claude Code has, Bash and, primary on Windows, PowerShell, both naming the engine alone.
    const lines = frontMatter('skill/claude/skills/deep-review/SKILL.md');
    const start = lines.indexOf('allowed-tools:');
    assert.ok(start >= 0, 'an allowed-tools list');
    const rules: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('  - ')) break;
      rules.push(line.slice('  - '.length));
    }
    const engine = 'node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *';
    assert.deepEqual(rules, [`Bash(${engine})`, `PowerShell(${engine})`]);
    // A rule matches the command text as Claude writes it, quotes included, so every command of the skill starts with the rules' text before its `*`.
    const prefix = engine.slice(0, -1);
    const commands = text.split('\n').filter((line) => line.trimStart().startsWith('node '));
    assert.ok(commands.length >= 4, 'config show, review, commit and answer');
    for (const command of commands) assert.ok(command.trimStart().startsWith(prefix), `${command.trim()} is a command the rules approve`);
    assert.ok(text.includes(`${engineDirectoryName}/${engineBundleName}`));
    // The host picks the shell tool, and both are approved; the skill names one only for the fault of the Store PowerShell, where the PowerShell tool cannot check a command (R12).
    assert.deepEqual(text.split('\n').filter((line) => /Bash tool|PowerShell tool/.test(line)), ['If the PowerShell tool cannot check a command of this skill ("malformed', 'Bash tool from then on.']);
    assert.match(text, /If the PowerShell tool cannot check a command of this skill \("malformed\s+syntax that cannot be parsed"\), run the commands of this skill with the\s+Bash tool from then on\./);
    // Codex has no such setting, so its skill has no such line.
    assert.ok(!frontMatter('skill/codex/SKILL.md').some((line) => line.startsWith('allowed-tools:')));
  });

  // R5 of the skill surface corrections: the autocomplete of Claude Code shows what the user can type after the command.
  // R12 of the skill surface corrections: the plugin's hook warns a Windows user about the Store PowerShell when a new session starts.
  it('runs the engine\'s session-start hook from the Claude plugin when a new session starts, with no shell, and gives Codex no hook', async () => {
    const hooks = JSON.parse(read('skill/claude/hooks/hooks.json')) as { description: string; hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> };
    assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart'], 'no other event');
    const [group, ...more] = hooks.hooks.SessionStart!;
    assert.equal(more.length, 0);
    // Only a new session: resume, clear and compact would repeat the warning.
    assert.equal(group!.matcher, 'startup');
    // Exec form, so no shell runs it, whichever shell Windows would pick; the engine of the plugin itself.
    assert.deepEqual(group!.hooks, [{ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${engineDirectoryName}/${engineBundleName}`, 'hook', 'session-start'], timeout: 10 }]);
    assert.match(hooks.description, /issues\/102430/);
    // The arguments the hook passes are a command the engine takes, and it exits 0.
    const args = group!.hooks[0]!.args as string[];
    const err: string[] = [];
    assert.equal(await main(args.slice(1), { stdout: () => undefined, stderr: (text) => err.push(text), environment: {}, cwd: root }), 0, err.join(''));
    assert.equal(existsSync(resolve(root, 'skill/codex/hooks')), false);
  });

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

  // R17 of resumable runs: the Claude skill says how a run the budget stopped or a usage limit blocked goes on, and the Codex skill, which has neither, says nothing of it.
  it('tells the Claude skill that the same command continues a fix run the budget stopped and one a usage limit blocked, and to show and offer the engine\'s line', () => {
    const claude = read('skill/claude/skills/deep-review/SKILL.md');
    const step3 = claude.slice(claude.indexOf('3. '), claude.indexOf('4. Exit code 0'));
    const step4 = claude.slice(claude.indexOf('4. Exit code 0'), claude.indexOf('5. '));
    assert.match(step3, /A fix run that the run budget stopped continues the same way: run the\s+same command with `--budget-usd` above the spend that the engine names,\s+and it reviews nothing again\./);
    assert.match(step3, /A run that a usage limit blocked resumes\s+with the same command after the reset that its blocker names\./);
    assert.match(step4, /When stderr has a line that says the run budget stopped the fix pass,\s+show that line to the user as printed and offer to run the command it\s+names\./);
    assert.doesNotMatch(read('skill/codex/SKILL.md'), /run budget stopped|usage limit/);
    // The line the skill names is one the engine logs, and the limit's block names its reset.
    assert.ok(read('src/review/controller.ts').includes('the run budget stopped its fix pass; ${continuing} continues it'));
    assert.ok(read('src/review/steps.ts').includes('stopped at the provider\'s usage limit: '));
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
      'allowed-tools:\n  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)\n  - PowerShell(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)\n',
      // Codex has no PowerShell tool whose check can fail this way (R12).
      'If the PowerShell tool cannot check a command of this skill ("malformed\nsyntax that cannot be parsed"), run the commands of this skill with the\nBash tool from then on.\n',
      'argument-hint: "[worktree | last commit | branch | from <rev>] [fix] [path ...]"\n',
      '   user limited the review to. Pass `--budget-usd <usd>` only when the\n   user names a run budget; the default is 60 USD.\n',
      // The warning of a fix run goes into the message of step 3 (PD10 of the questions in the chat), also for a run that --fix continues (R13).
      '   the survey. The message of step 3 tells the user what a fix run\n   does. Without such a request, do not pass `--fix`: the review then\n   edits nothing and runs no check.\n',
      // Step 3's first sentence ends here with `exit:`; the Codex skill goes on, on that line, with where engine/main.mjs is, so the shared text wraps apart only here.
      '   repository and wait for it to exit:\n',
      // The review starts in the background first, and the message with the scope ends the turn (R13 of the questions in the chat).
      '   When `config show` exits with code 2, show stderr verbatim and stop,\n   as step 7 says for a refusal. When it exits 0, keep its `Scope:` line\n   and the `budget.usd` line under its `Settings:` for the message below.\n   When `status` prints a `Run ` line instead, that run is active and the\n   review below resumes it: run no `config show`, and keep the `Run `,\n   `Scope:` and `Settings:` lines of `status` for the message below.\n\n   Then start the review at once, from the repository, as a background\n   shell command with the longest timeout you can: do not ask the user\n   to confirm, and do not wait for an answer.\n\n   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" review --runtime claude <scope flags> [--fix]\n\n   Once it runs, write the user a message as the last text of this turn.\n   The user does not see the commands\' output, so this message is where\n   they see the scope: copy the lines you kept into a code block,\n   character for character, and below it say whether the run fixes. For\n   a fix run, also say that the engine\'s workers will edit the working\n   tree, that it runs the check commands it chose from the repository,\n   and that the run commits nothing. For an active run, say that the\n   review continues that run with the scope and the settings it recorded\n   and ignores the scope flags. Then end the turn: the review goes on,\n   and when it exits you go on with step 4.\n   A user who sees a wrong scope stops the review before it has spent\n   much; a run that reviews edits nothing until its fixes phase. When\n   the user stops it because its scope is wrong, stop the background\n   command first, since `abandon` refuses a run whose engine still runs;\n   then close the run with `abandon --reason <text>` before you run the\n   corrected request, so that the next review starts a new run rather\n   than resume this one.\n\n',
      // Codex reports no cost, so it has no run budget, and this engine knows no limit of Codex (R17 of resumable runs).
      '   A fix run that the run budget stopped continues the same way: run the\n   same command with `--budget-usd` above the spend that the engine names,\n   and it reviews nothing again. A run that a usage limit blocked resumes\n   with the same command after the reset that its blocker names.\n',
      '   When stderr has a line that says the run budget stopped the fix pass,\n   show that line to the user as printed and offer to run the command it\n   names.\n',
    ],
    'skill/codex/SKILL.md': [
      'description: Deep review of one change by the deep-review engine, a Node program installed with this skill. It writes a Markdown report with the evidence for each finding and the engine\'s own decision on it, asks only the questions a person must answer, names the fixes that depart from a rule, and says what the run did not examine; when the user asks, its own workers also apply the fixes and it runs the project\'s checks, committing nothing. Use only when the user asks for $deep-review by name.\n',
      '   user limited the review to. `--budget-usd` does not apply to Codex,\n   which reports no cost; do not pass it.\n',
      // Codex shows a message the model writes before a command, so it tells the user before the review starts (R13 of the questions in the chat).
      '   the survey. Before you run it, tell the\n   user that the engine\'s workers will edit the working tree, that it\n   runs the check commands it chose from the repository, and that the\n   run commits nothing. Without such a request, do not pass `--fix`: the\n   review then edits nothing and runs no check. With `--fix` on Windows,\n   also tell the user that the workers that edit run with no sandbox and\n   with network access unless the user names\n   `--codex-windows-sandbox unelevated`, under which they cannot run most\n   build and test commands, or `--codex-windows-sandbox elevated`, which\n   needs Codex\'s elevated setup; pass that flag only when the user names\n   it.\n',
      '   repository and wait for it to exit. `engine/main.mjs` is in this\n   skill\'s directory, the one that holds this SKILL.md:\n',
      '   When it exits 0, write the user a message before your next tool call,\n   in this same reply: copy its `Scope:` line and the `budget.usd` line\n   under its `Settings:` into a code block, character for character, and\n   below it say whether the run fixes.\n   When `status` prints a `Run ` line instead, that run is active and the\n   review below resumes it: run no `config show`, and in that message\n   copy the `Run `, `Scope:` and `Settings:` lines of `status` into a\n   code block, character for character, and say that the review\n   continues that run with the scope and the settings it recorded and\n   ignores the scope flags.\n   The user does not see the command\'s output, so this message is where\n   they see the scope. Then, in the same reply, start the review at once;\n   the message does not end your turn: do not ask the user to confirm,\n   and do not wait for an answer. A user who sees a wrong scope stops the\n   review before it has spent much; until its fixes phase the run has\n   edited nothing. When the user stops it because its scope is wrong,\n   close it with `abandon --reason <text>` before you run the corrected\n   request, so that the next review starts a new run rather than resume\n   this one. When `config show` exits with code 2, show stderr verbatim\n   and stop, as step 7 says for a refusal.\n\n   Run the review from the repository, with the longest timeout you can,\n   and wait for it to exit:\n\n   node "<this skill\'s directory>/engine/main.mjs" review --runtime codex <scope flags> [--fix]\n\n   When the command returns to you before it exits, poll it until it\n   exits, and do not end your turn while it runs: `codex exec` stops a\n   command that still runs when the turn ends.\n\n',
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
