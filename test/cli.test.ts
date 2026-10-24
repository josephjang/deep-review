import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Checkpoint, isUnreadable } from '../src/checkpoint/checkpoint.ts';
import { locateCheckpoint } from '../src/checkpoint/locate.ts';
import { briefJsonV3 } from '../src/review/brief-json.ts';
import { acquireRunLock, acquireStartLock } from '../src/review/lock.ts';
import { shortRunId } from '../src/review/runs.ts';
import { maxConcurrency, policyFileName } from '../src/review/policy.ts';
import { caseInsensitiveFileSystem, claimsDirectoryFor, readClaims } from '../src/review/claims.ts';
import { withoutVariables } from '../src/runtime/environment.ts';
import { checkpointScratchKey } from '../src/runtime/scratch.ts';
import { checkKinds, finderAngles } from '../src/review/vocabulary.ts';
import { fixerAnswer } from './helpers/fake-runtime.ts';
import { baseEnvironment, fakeClaude, fakeCodex, type Finished, node, until } from './helpers/launcher.ts';
import { commitAll, git, write } from './helpers/repository.ts';
import { fakeCheckCommand, otherEngine, ReviewSandbox, sandboxConcurrency } from './helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../src/cli.ts');

describe('the deep-review command', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  // The operator's configuration directory is the sandbox's, so no file of the person running the suite reaches a command (R2 of the configuration).
  const environment = (box: ReviewSandbox): NodeJS.ProcessEnv => ({ ...withoutVariables(baseEnvironment, ['APPDATA', 'XDG_CONFIG_HOME'], process.platform), APPDATA: join(box.home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(box.home, '.config'), FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile, HOME: box.home, USERPROFILE: box.home });
  const run = (box: ReviewSandbox, ...args: string[]): Promise<Finished> => node([cli, ...args], { cwd: box.repo, env: environment(box) });
  const claudeFlags = (box: ReviewSandbox, ...more: string[]): string[] => ['review', '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', box.rolesRoot, ...more];

  it('prints the usage and exits 1 without a command, and 0 with --help', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const none = await run(box);
    assert.equal(none.status, 1);
    assert.match(none.stdout, /^usage:/);
    const help = await run(box, '--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /deep-review review {2}--runtime claude\|codex/);
    assert.ok(help.stdout.includes(`[--concurrency 1..${String(maxConcurrency)}]`), 'the usage names the bound the flag is checked against');
    assert.ok(help.stdout.includes('[--codex-windows-sandbox unelevated|elevated|none]'), 'the usage names the Codex Windows sandboxes');
    assert.ok(help.stdout.includes('[--fix [--fresh] [--check <kind>=<command>]... [--no-check <kind>]...]'), 'the usage names --fresh with --fix');
    assert.match(help.stdout, /deep-review claim   --path <path> --unit <key> --in <dir>/, 'the usage names the claim command a fixer runs');
    assert.match(help.stdout, /deep-review config  show --runtime claude|codex/, 'the usage names the config command (R14 of the configuration)');
    for (const subcommand of ['explain [<setting>]', 'validate [<file>]', 'init (--repository | --operator | --clone)']) assert.ok(help.stdout.includes(`deep-review config  ${subcommand}`), subcommand);
    assert.ok(help.stdout.includes('[--set <setting>=<value>]... [--config <file>] [--no-repository-config]'), 'the usage names the settings flags of review');
  });

  it('refuses an answer the flags do not spell with the usage and exit 1, before reading any run (R1 of answers)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const help = await run(box, '--help');
    assert.ok(help.stdout.includes('deep-review answer  --finding <id> (--option <n> | --accept | --reject) [--note <text>]'), 'the usage names the answer command');
    for (const [args, message] of [
      [['answer', '--option', '1'], /--finding takes a finding's id as the report prints it, such as RIPPLE-2, not ""/],
      [['answer', '--finding', 'ripple-2', '--option', '1'], /--finding takes a finding's id [^\n]*, not "ripple-2"/],
      [['answer', '--finding', 'RIPPLE-2'], /give exactly one of --option <n>, --accept and --reject/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--reject'], /give exactly one of --option <n>, --accept and --reject/],
      [['answer', '--finding', 'RIPPLE-2', '--option', '2', '--accept'], /give exactly one of/],
      [['answer', '--finding', 'RIPPLE-2', '--option', '0'], /--option takes an option's number as the report numbers it, from 1, not "0"/],
      [['answer', '--finding', 'RIPPLE-2', '--option', 'two'], /--option takes an option's number [^\n]*, not "two"/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--note', ' '], /--note needs text; leave it out for no note/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--note', 'x'.repeat(2001)], /--note holds at most 2000 UTF-16 code units [^\n]*, not 2001/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--note', '\u{1F600}'.repeat(1001)], /--note holds at most 2000 UTF-16 code units \(an emoji or other character outside the Basic Multilingual Plane counts as two\), not 2002/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--budget-usd', '0'], /--budget-usd must be a positive number, not 0/],
      [['answer', '--finding', 'RIPPLE-2', '--accept', '--fix'], /--fix does not apply to answer/],
      [['answer', '--finding', 'RIPPLE-2', '--accept'], /this repository has no checkpoint, so there is no run to answer/],
    ] as const) {
      const outcome = await run(box, ...args);
      assert.equal(outcome.status, 1, `${args.join(' ')}: ${outcome.stderr}`);
      assert.match(outcome.stderr, message);
      assert.match(outcome.stderr, /usage:/);
    }
  });

  it('refuses a command-line mistake with the usage and exit 1', async (t) => {

    const box = ReviewSandbox.forTest(t);
    for (const [args, message] of [
      [['bogus'], /unknown command "bogus"/],
      [['status', '--runtime', 'claude'], /--runtime does not apply to status/],
      [claudeFlags(box, '--last-commit', '--worktree'), /choose one scope/],
      [claudeFlags(box, '--from', 'HEAD~1'), /--from and --to go together/],
      [claudeFlags(box, '--last-commit', '--merge-base'), /--merge-base applies to --from and --to only/],
      [claudeFlags(box, '--last-commit', '--concurrency', '0'), new RegExp(`--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not 0`)],
      [claudeFlags(box, '--last-commit', '--concurrency', String(maxConcurrency + 1)), new RegExp(`--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not ${String(maxConcurrency + 1)}`)],
      [claudeFlags(box, '--last-commit', '--concurrency', '2.5'), /--concurrency must be a whole number from 1 to \d+, not 2\.5/],
      [claudeFlags(box, '--last-commit', '--budget-usd', 'lots'), /--budget-usd must be a number/],
      [claudeFlags(box, '--last-commit', '--budget-usd', '0'), /--budget-usd must be a positive number, not 0/],
      [claudeFlags(box, '--last-commit', '--budget-usd=-1'), /--budget-usd must be a positive number, not -1/],
      [['review', '--last-commit'], /--runtime claude\|codex is required/],
      [['review', '--runtime', 'gemini', '--last-commit'], /--runtime must be one of claude, codex/],
      [claudeFlags(box, '--worktree'), /--worktree reviews uncommitted changes, and this tree has none/],
      [['abandon'], /--reason <text> is required/],
      [claudeFlags(box, '--last-commit', '--check', 'lint=x'), /--check and --no-check apply only with --fix/],
      [claudeFlags(box, '--last-commit', '--no-check', 'lint'), /--check and --no-check apply only with --fix/],
      [claudeFlags(box, '--last-commit', '--fix', '--check', 'lint=x', '--check', 'lint=y'), /--check names the lint check, which another --check or --no-check already names/],
      [claudeFlags(box, '--last-commit', '--fix', '--check', 'lint=x', '--no-check', 'lint'), /--no-check names the lint check, which another/],
      [claudeFlags(box, '--last-commit', '--fix', '--check', 'format=x'), /--check names a check kind, one of build, typecheck, lint, test, not "format"/],
      [claudeFlags(box, '--last-commit', '--fix', '--check', 'lint'), /--check takes <kind>=<command>, not "lint"/],
      [claudeFlags(box, '--last-commit', '--fix', '--check', 'lint= '), /--check lint= needs a command/],
      [['status', '--fix'], /--fix does not apply to status/],
      // R10 of the questions in the chat: --all lists every run, for a person.
      [['status', '--all', '--run', '00000000'], /--all lists every run; leave out --run/],
      [['status', '--all', '--json'], /--all prints a list for a person and has no JSON form/],
      [['report', '--all'], /--all does not apply to report/],
      // R6 of the questions in the chat: report prints one form of its run.
      [['report', '--fixes', '--json'], /--json and --fixes do not go together; give one/],
      [['report', '--brief', '--json'], /--json and --brief do not go together; give one/],
      [['report', '--brief', '--fixes'], /--brief and --fixes do not go together; give one/],
      [['report', '--fixes', '--finding', 'SCAN-1'], /--fixes and --finding do not go together; give one/],
      [['status', '--fixes'], /--fixes does not apply to status/],
      // R2 of fix pass continuation: --fresh declines a continuation, which only --fix makes.
      [claudeFlags(box, '--last-commit', '--fresh'), /--fresh applies only with --fix/],
      [['status', '--fresh'], /--fresh does not apply to status/],
      [claudeFlags(box, '--last-commit', '--codex-windows-sandbox', 'elevated'), /--codex-windows-sandbox applies only to runtime codex, not claude/],
      [claudeFlags(box, '--last-commit', '--codex-windows-sandbox', 'full'), /--codex-windows-sandbox must be one of unelevated, elevated, none, not "full"/],
      [['review', '--runtime', 'codex', '--executable', process.execPath, '--executable-arg', fakeCodex, '--roles', box.rolesRoot, '--last-commit', '--codex-windows-sandbox', ''], /--codex-windows-sandbox must be one of unelevated, elevated, none, not ""/],
      [['status', '--codex-windows-sandbox', 'none'], /--codex-windows-sandbox does not apply to status/],
    ] as const) {
      const result = await run(box, ...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, message, args.join(' '));
      assert.match(result.stderr, /usage:/, `${args.join(' ')} prints the usage`);
    }
    // The scope flags and the settings flags (R8, R13 of the configuration).
    for (const [args, message] of [
      [claudeFlags(box, '--branch', '--worktree'), /choose one scope: --last-commit, --worktree, --branch/],
      [claudeFlags(box, '--last-commit', '--base', 'main'), /--base applies to --branch only/],
      [claudeFlags(box, '--last-commit', '--set', 'nope=1'), /--set names no setting "nope"/],
      [claudeFlags(box, '--last-commit', '--set', 'checks.test'), /--set takes <setting>=<value>/],
      [claudeFlags(box, '--last-commit', '--set', 'run.concurrency=0'), /--set run\.concurrency: /],
      [claudeFlags(box, '--last-commit', '--budget-usd', '5', '--set', 'budget.usd=6'), /--set budget\.usd and --budget-usd both set budget\.usd; give one/],
      [claudeFlags(box, '--last-commit', '--set', 'scope.exclude=["a"]', '--set', 'scope.exclude=["b"]'), /--set scope\.exclude and --set scope\.exclude both set scope\.exclude/],
      [['status', '--set', 'budget.usd=1'], /--set does not apply to status/],
      [claudeFlags(box, '--last-commit', '--set', 'checks.test=npm test'), /--set checks.test applies only with --fix, as --check does/],
      [claudeFlags(box, '--last-commit', '--set', 'runtimes.codex.windows_sandbox=none'), /--set runtimes\.codex\.windows_sandbox applies only to runtime codex, not claude/],
      [claudeFlags(box, '--last-commit', '--set', 'runtimes.codex.strong=x'), /--set runtimes\.codex\.strong applies only to runtime codex, not claude/],
    ] as const) {
      const result = await run(box, ...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, message, args.join(' '));
      assert.match(result.stderr, /usage:/, `${args.join(' ')} prints the usage`);
    }
    // A policy refusal is an engine error, exit 1 without the usage.
    const codexBudget = await run(box, 'review', '--runtime', 'codex', '--executable', process.execPath, '--executable-arg', fakeCodex, '--roles', box.rolesRoot, '--last-commit', '--budget-usd', '5');
    assert.equal(codexBudget.status, 1);
    assert.match(codexBudget.stderr, /^InvalidPolicyError: --budget-usd does not apply to runtime codex/);
  });

  it('refuses a .cmd shim and a missing executable as runtime-unqualified, with exit 2', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const shim = join(box.directory, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const refused = await run(box, ...claudeFlags(box, '--last-commit').map((arg) => (arg === process.execPath ? shim : arg)));
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /^blocked \(runtime-unqualified\): .*claude\.cmd is a \.cmd shim, which cannot be spawned without a shell; pass --executable/);
    const missing = await run(box, 'review', '--runtime', 'claude', '--executable', join(box.directory, 'absent'), '--last-commit');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /is not a file; pass --executable/);
    // The executable is resolved once the engine knows the run is new, which takes the checkpoint; the refusal comes before a run is created.
    assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    assert.equal((await run(box, 'status')).stdout, 'No active run.\n');
  });

  it('resumes a configured run with its pinned executable, never resolving or refusing the one the command names or finds on PATH', async (t) => {

    const box = ReviewSandbox.forTest(t);
    box.script({ triage: { exit: 2 } });
    assert.equal((await run(box, ...claudeFlags(box, '--last-commit'))).status, 2);
    const pinned = box.run().review!.configuration;
    // A shim the command refuses for a new run, first on PATH as an npm install on Windows puts claude.cmd there, and named by the flag.
    const shims = join(box.directory, 'shims');
    mkdirSync(shims);
    const shim = join(shims, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const env = { ...Object.fromEntries(Object.entries(environment(box)).filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: `${shims}${delimiter}${process.env.PATH ?? ''}` };
    const review = (...args: string[]): Promise<Finished> => node([cli, 'review', '--runtime', 'claude', '--roles', box.rolesRoot, ...args], { cwd: box.repo, env });
    // Named by the flag: the run resumes, and blocks again only because its triage fails again.
    const named = await review('--executable', shim);
    assert.equal(named.status, 2, named.stderr);
    assert.match(named.stderr, /^blocked in triage \(worker-failed\)/m);
    assert.doesNotMatch(named.stderr, /runtime-unqualified/);
    // Found on PATH, as the command resolves a runtime name with no --executable: the run resumes to its report.
    box.script({});
    const found = await review();
    assert.equal(found.status, 0, found.stderr);
    const state = box.run();
    assert.deepEqual(state.review!.configuration, pinned);
    assert.ok(Object.values(state.workers).every((worker) => worker.launch.executable === pinned.executable), 'every worker ran the pinned executable');
    // A new run still resolves the command's executable, and refuses the shim before it creates a run.
    const fresh = await review('--executable', shim, '--last-commit');
    assert.equal(fresh.status, 2, fresh.stderr);
    assert.match(fresh.stderr, /^blocked \(runtime-unqualified\): .*claude\.cmd is a \.cmd shim, which cannot be spawned without a shell/);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no new run was created');
  });

  it('says there is no run before any review, in text and JSON, and finds the repository through --repo given absolute or relative', async (t) => {

    const box = ReviewSandbox.forTest(t);
    assert.equal((await run(box, 'status')).stdout, 'No run: this repository has no checkpoint yet.\n');
    assert.equal((await run(box, 'status', '--json')).stdout, 'null\n');
    assert.equal((await run(box, 'status', '--all')).stdout, 'No run: this repository has no checkpoint yet.\n', 'status --all says what status says (R10 of the questions in the chat)');
    const elsewhere = await node([cli, 'status', '--repo', box.repo], { cwd: box.directory, env: environment(box) });
    assert.equal(elsewhere.stdout, 'No run: this repository has no checkpoint yet.\n', elsewhere.stderr);
    const relative = await node([cli, 'status', '--repo', 'repo'], { cwd: box.directory, env: environment(box) });
    assert.equal(relative.stdout, 'No run: this repository has no checkpoint yet.\n', relative.stderr);
    const outside = await node([cli, 'status', '--repo', box.home], { cwd: box.directory, env: environment(box) });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /NotInRepositoryError/);
    const abandon = await run(box, 'abandon', '--reason', 'nothing');
    assert.equal(abandon.status, 1);
    assert.match(abandon.stderr, /no checkpoint, so there is no run to abandon/);
    // A checkpoint that holds no run yet.
    Checkpoint.open(locateCheckpoint(box.repo).root, { engine: '0.0.0-test' }).close();
    const empty = await run(box, 'status', '--all');
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, 'No active run.\n');
    assert.equal((await run(box, 'report')).stderr, `refused: no run of worktree ${box.repo} has a report; deep-review status shows the run that is active\n`, 'a worktree with no run keeps the refusal it had');
    // A worktree whose runs have no report: the refusal gives the state of the newest and names status --all (R8 of the questions in the chat).
    const checkpoint = Checkpoint.open(locateCheckpoint(box.repo).root, { engine: '0.0.0-test' });
    try {
      const older = checkpoint.createRun({ worktree: box.repo });
      checkpoint.append(older.id, older.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'wrong scope' } }]);
      const newer = checkpoint.createRun({ worktree: box.repo });
      const none = await run(box, 'report');
      assert.equal(none.status, 2, none.stderr);
      assert.equal(none.stderr, `refused: no run of worktree ${box.repo} has a report; the newest, run ${newer.id}, never started its review; deep-review status --all lists the runs\n`);
    } finally {
      checkpoint.close();
    }
  });

  it('shows the brief of the run of the worktree with a report that ended last, or of the run --run names, as text and as JSON, and writes its copy (R16 of the brief of a run; R8, R9 of the questions in the chat)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({});
    const none = await run(box, 'report');
    assert.equal(none.status, 2, 'no checkpoint yet');
    assert.match(none.stderr, /refused: [^\n]*no run has a report; deep-review status/);
    const first = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(first.status, 0, first.stderr);
    const firstId = /run ([0-9a-f-]+): created/.exec(first.stderr)![1]!;
    write(box.repo, 'src/b.ts', 'export const b = 2;\n');
    const second = await run(box, ...claudeFlags(box, '--worktree'));
    assert.equal(second.status, 0, second.stderr);
    const secondId = /run ([0-9a-f-]+): created/.exec(second.stderr)![1]!;

    // The run that ended last, its short form and the path of its copy last.
    const newest = await run(box, 'report');
    assert.equal(newest.status, 0, newest.stderr);
    const lines = newest.stdout.trim().split('\n');
    assert.equal(lines.length, 8);
    assert.match(lines[0]!, new RegExp(`\\(run ${secondId.slice(0, 8)}\\)$`));
    assert.match(lines.at(-1)!, new RegExp(`[\\\\/]reports[\\\\/]\\d{4}-\\d{2}-\\d{2}-${secondId.slice(0, 8)}\\.md$`));
    assert.ok(existsSync(lines.at(-1)!));

    // status --all lists both runs, newest first, each with the path of its copy (R10 of the questions in the chat).
    const listed = await run(box, 'status', '--all');
    assert.equal(listed.status, 0, listed.stderr);
    const listLines = listed.stdout.trimEnd().split('\n');
    assert.equal(listLines.length, 2, listed.stdout);
    assert.ok(listLines[0]!.startsWith(`${shortRunId(secondId)} started `) && listLines[0]!.includes(': complete; worktree, ') && listLines[0]!.endsWith(`; report ${lines.at(-1)!}`), listLines[0]!);
    assert.ok(listLines[1]!.startsWith(`${shortRunId(firstId)} started `) && listLines[1]!.includes(': complete; last-commit, '), listLines[1]!);
    assert.match(listLines[1]!, new RegExp(`; report .*[\\\\/]reports[\\\\/]\\d{4}-\\d{2}-\\d{2}-${shortRunId(firstId)}\\.md$`));

    rmSync(lines.at(-1)!);
    await run(box, 'report');
    assert.ok(existsSync(lines.at(-1)!), 'report writes the copy again');

    // While another engine holds the run's lock, report writes no copy and names the record, since that engine writes the copy (R14, TD6 of the brief of a run).
    rmSync(lines.at(-1)!);
    const release = acquireRunLock(locateCheckpoint(box.repo).root, secondId);
    try {
      const held = await run(box, 'report');
      assert.equal(held.status, 0, held.stderr);
      assert.match(held.stdout.trim().split('\n').at(-1)!, /[\\/]artifacts[\\/][0-9a-f]{64}$/, 'the record\'s path');
      assert.match(held.stderr, new RegExp(`run ${secondId}: the copy of the report is not written again, since [^\\n]*is running run ${secondId}`));
      assert.equal(existsSync(lines.at(-1)!), false, 'no copy is written under another engine\'s lock');
    } finally {
      release();
    }

    // --run names an older run, by the first 8 characters of its id (R11 of the questions in the chat); --json gives version 3 of the JSON form, the one it writes since the questions in the chat, with the local facts.
    const named = await run(box, 'report', '--run', shortRunId(firstId), '--json');
    assert.equal(named.status, 0, named.stderr);
    const json = briefJsonV3.parse(JSON.parse(named.stdout));
    assert.equal(json.run, firstId);
    assert.equal(json.version, 3);
    assert.deepEqual(json.notShown, [], 'a run --run names passes no run over');

    // --brief prints the brief as a chat shows it, from its title, and then the path of the copy (R7 of the questions in the chat).
    const brief = await run(box, 'report', '--run', shortRunId(firstId), '--brief');
    assert.equal(brief.status, 0, brief.stderr);
    const briefLines = brief.stdout.trimEnd().split('\n');
    assert.match(briefLines[0]!, /^# /);
    assert.ok(briefLines.includes('## What the review did not cover'), brief.stdout);
    assert.match(briefLines.at(-1)!, new RegExp(`[\\\\/]reports[\\\\/]\\d{4}-\\d{2}-\\d{2}-${shortRunId(firstId)}\\.md$`));
    assert.doesNotMatch(brief.stdout, /<details>|\]\(#finding-|end of this report/);
    const newestBrief = await run(box, 'report', '--brief');
    assert.ok(newestBrief.stdout.trimEnd().split('\n').at(-1)!.includes(shortRunId(secondId)), 'the run report takes with no --run');

    // --fixes prints a line for each fix, here the sentence of a run that only reviewed, and then the path of the copy (R6 of the questions in the chat).
    const fixes = await run(box, 'report', '--run', firstId, '--fixes');
    assert.equal(fixes.status, 0, fixes.stderr);
    const fixesLines = fixes.stdout.trimEnd().split('\n');
    assert.equal(fixesLines.length, 2, fixes.stdout);
    assert.match(fixesLines[0]!, /^This run only reviewed: it changed nothing\./);
    assert.match(fixesLines[1]!, new RegExp(`[\\\\/]reports[\\\\/]\\d{4}-\\d{2}-\\d{2}-${shortRunId(firstId)}\\.md$`));
    assert.deepEqual([json.headline.documents, json.documents], [0, []], 'a run that only reviews leaves no document out of date');
    assert.match(json.local.copy!, new RegExp(`${firstId.slice(0, 8)}\\.md$`));
    assert.match(json.local.record, /[\\/]artifacts[\\/][0-9a-f]{64}$/);
    assert.equal(json.local.continueCommand, null);
    assert.equal(json.changeState, 'none', 'the fake triage gave no account');

    // A later run with no current report: report --run refuses it with its state, naming status --run (R9 of the questions in the chat); report shows the run before it, and names the later one first (R8).
    const checkpoint = Checkpoint.open(locateCheckpoint(box.repo).root, { engine: '0.0.0-test' });
    try {
      const active = checkpoint.createRun({ worktree: box.repo });
      const refused = await run(box, 'report', '--run', active.id);
      assert.equal(refused.status, 2);
      assert.equal(refused.stderr, `refused: run ${active.id} has no current report, since it never started its review; deep-review status --run ${active.id} shows where it is\n`);
      const past = await run(box, 'report');
      assert.equal(past.status, 0, past.stderr);
      const pastLines = past.stdout.trimEnd().split('\n');
      assert.equal(pastLines[0], `Not shown: run ${shortRunId(active.id)}, a later run, never started its review.`);
      assert.match(pastLines[1]!, new RegExp(`\\(run ${shortRunId(secondId)}\\)$`), 'the short form of the run before it follows');
      assert.equal(pastLines.length, 9);
      // With --json, stdout holds the JSON form alone, which names the later run in notShown.
      const pastJson = await run(box, 'report', '--json');
      assert.equal(pastJson.status, 0, pastJson.stderr);
      const parsed = briefJsonV3.parse(JSON.parse(pastJson.stdout));
      assert.equal(parsed.run, secondId);
      assert.deepEqual(parsed.notShown, [{ run: active.id, state: 'never started its review' }]);

      // Abandoned, the run gives the reason of its abandon, in the refusal and in the line.
      checkpoint.append(active.id, active.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'wrong scope' } }]);
      const abandoned = await run(box, 'report', '--run', shortRunId(active.id));
      assert.equal(abandoned.status, 2);
      assert.equal(abandoned.stderr, `refused: run ${active.id} has no current report, since it was abandoned: wrong scope; deep-review status --run ${active.id} shows where it is\n`);
      assert.equal((await run(box, 'report')).stdout.split('\n')[0], `Not shown: run ${shortRunId(active.id)}, a later run, was abandoned: wrong scope.`);

      // Three later runs, the latest one this engine cannot read: a line each, the latest first.
      const created = checkpoint.createRun({ worktree: box.repo });
      const unreadable = box.unreadableRun();
      const crowded = await run(box, 'report');
      assert.equal(crowded.status, 0, crowded.stderr);
      const crowdedLines = crowded.stdout.trimEnd().split('\n');
      assert.match(crowdedLines[0]!, new RegExp(`^Not shown: run ${shortRunId(unreadable)}, a later run, cannot be read by this engine \\([^)]+\\); an engine that declares its events can show it\\.$`));
      assert.equal(crowdedLines[1], `Not shown: run ${shortRunId(created.id)}, a later run, never started its review.`);
      assert.equal(crowdedLines[2], `Not shown: run ${shortRunId(active.id)}, a later run, was abandoned: wrong scope.`);
      assert.match(crowdedLines[3]!, new RegExp(`\\(run ${shortRunId(secondId)}\\)$`));
      // A fourth: three lines, then one that counts the fourth.
      const fourth = checkpoint.createRun({ worktree: box.repo });
      const counted = (await run(box, 'report')).stdout.trimEnd().split('\n');
      assert.equal(counted[0], `Not shown: run ${shortRunId(fourth.id)}, a later run, never started its review.`);
      assert.equal(counted[3], 'Not shown: 1 more later run; deep-review status --all lists them');
      assert.match(counted[4]!, new RegExp(`\\(run ${shortRunId(secondId)}\\)$`));
      // A run of another worktree is not this worktree's to name.
      checkpoint.createRun({ worktree: box.home });
      assert.deepEqual((await run(box, 'report')).stdout.trimEnd().split('\n').slice(0, 5), counted.slice(0, 5));
    } finally {
      checkpoint.close();
    }
    assert.match((await run(box, 'report', '--fix')).stderr, /--fix does not apply to report/);

    // A copy that cannot be written leaves the record's path last, and stderr says why (TD6 of the brief of a run).
    const reports = join(locateCheckpoint(box.repo).root, 'reports');
    rmSync(reports, { recursive: true, force: true });
    writeFileSync(reports, 'not a directory');
    const fallback = await run(box, 'report', '--run', firstId);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout.trim().split('\n').at(-1)!, /[\\/]artifacts[\\/][0-9a-f]{64}$/);
    assert.match(fallback.stderr, new RegExp(`run ${firstId}: could not write the copy of the report to `));
    const fallbackJson = briefJsonV3.parse(JSON.parse((await run(box, 'report', '--run', firstId, '--json')).stdout));
    assert.equal(fallbackJson.local.copy, null);
  });

  it('ends with the path of the record when the copy cannot be written, and says why on stderr (R13, TD6 of the brief of a run)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({});
    // A file where the directory of the copies would be.
    const root = locateCheckpoint(box.repo).root;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'reports'), 'not a directory');
    const result = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(result.status, 0, result.stderr);
    const last = result.stdout.trim().split('\n').at(-1)!;
    assert.match(last, /[\\/]artifacts[\\/][0-9a-f]{64}$/, 'the record\'s path');
    assert.match(result.stderr, /: could not write the copy of the report to .+[\\/]reports[\\/]\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md: /);
  });

  it('reviews the last commit to a report, prints its path last, and then reports the run through status', async (t) => {

    const box = ReviewSandbox.forTest(t);
    box.script({});
    const result = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    const reportPath = lines.at(-1)!;
    assert.ok(existsSync(reportPath), reportPath);
    // The short form of the brief comes first, seven lines for a run that only reviews, with no line of documents, and the last line is the path of the copy beside the ledger (R13, R14 of the brief of a run; R7 of the documentation step).
    assert.equal(lines.length, 8, result.stdout);
    assert.match(lines[0]!, /^The commit [0-9a-f]{8} \(run [0-9a-f]{8}\)$/);
    assert.deepEqual(lines.slice(1, 7).map((line) => line.split(':')[0]), ['The change', 'Questions', 'Against a written rule', 'Not covered', 'Look at', 'Changed']);
    assert.match(reportPath, /[\\/]deep-review-checkpoint[\\/]reports[\\/]\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/);
    // The report starts with the brief, titled from the scope when the triage gave no account, and ends with the facts of the run (R12 of the brief of a run).
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /^# The commit [0-9a-f]{8}\n/);
    assert.match(report, /\n## The run\n\nRepository: /);
    assert.match(result.stderr, /run [0-9a-f-]+: created\n/);
    assert.match(result.stderr, /phase triage: started \(attempt 1\)/);
    assert.match(result.stderr, /worker triage triage:SCAN: completed in [0-9.]+ s, 0\.00 USD/);
    assert.match(result.stderr, /report written to /);
    // Status: the run is complete, and JSON carries the review projection.
    const status = await run(box, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'No active run.\n', 'a complete run is not active');
    const runId = /run ([0-9a-f-]+): created/.exec(result.stderr)![1]!;
    const named = await run(box, 'status', '--run', runId);
    assert.match(named.stdout, new RegExp(`^Run ${runId}: complete\\n`));
    assert.match(named.stdout, /^Runtime: claude 2\.1\.283; models opus and sonnet$/m);
    assert.match(named.stdout, /^Phase: none running$/m);
    assert.match(named.stdout, /^Workers: 0 running, 12 finished, 0 lost$/m);
    assert.match(named.stdout, /^Spend: 0\.01 USD of 60\.00 USD; \d+ input, \d+ output tokens$/m);
    assert.match(named.stdout, /^Report: .+$/m);
    const json = JSON.parse((await run(box, 'status', '--run', runId, '--json')).stdout) as { runId: string; status: string; workers: { finished: number }; review: { report: unknown; blocker: null } };
    assert.equal(json.runId, runId);
    assert.equal(json.status, 'complete');
    assert.equal(json.workers.finished, 12);
    assert.ok(json.review.report !== null);
    assert.equal(json.review.blocker, null);
    // A complete run is not abandoned after the fact: its report stands, and so does its status.
    const late = await run(box, 'abandon', '--run', runId, '--reason', 'cleanup');
    assert.equal(late.status, 1, late.stderr);
    assert.match(late.stderr, new RegExp(`^run ${runId} is complete; only an active or blocked run can be abandoned\\n`));
    assert.match((await run(box, 'status', '--run', runId)).stdout, new RegExp(`^Run ${runId}: complete\\n`));
    // Reviewing again starts a new run, since a finished run is not reopened.
    const second = await run(box, ...claudeFlags(box, '--ref', 'HEAD~1', '--path', 'src'));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(box.checkpoint.foldRuns().length, 2);
    assert.deepEqual(box.checkpoint.foldRuns()[1]!.scope?.request, { ref: 'HEAD~1', paths: ['src'], exclude: [] });
    // An id the checkpoint does not hold is a command-line mistake, for status and abandon alike.
    for (const args of [['status', '--run', 'nope'], ['abandon', '--run', 'nope', '--reason', 'gone']]) {
      const unknown = await run(box, ...args);
      assert.equal(unknown.status, 1, args.join(' '));
      assert.match(unknown.stderr, /nope[\s\S]*\n\nusage:/, args.join(' '));
    }
  });

  it('exits 2 with the blocker when the run blocks, survives status --json, and continues on the next command', async (t) => {

    const box = ReviewSandbox.forTest(t);
    box.script({ triage: { exit: 2 } });
    const blocked = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /^blocked in triage \(worker-failed\): the triage worker for triage:SCAN failed twice: .*\naction: run the command again, which gives the failed worker two fresh attempts, or abandon the run\n$/m);
    const status = await run(box, 'status');
    assert.match(status.stdout, /^Run [0-9a-f-]+: blocked\n/);
    assert.match(status.stdout, /^Phase: triage \(attempt 1, blocked\)$/m);
    assert.match(status.stdout, /^Blocker: worker-failed: the triage worker/m);
    assert.match(status.stdout, /^Action: run the command again/m);
    const json = JSON.parse((await run(box, 'status', '--json')).stdout) as { status: string; blocker: { code: string; action: string } };
    assert.equal(json.status, 'blocked');
    assert.equal(json.blocker.code, 'worker-failed');
    assert.match(json.blocker.action, /run the command again/);
    box.script({});
    // The scope flags of a resumed run are ignored, with a note.
    const resumed = await run(box, ...claudeFlags(box, '--worktree'));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stderr, /is active; its scope flags are ignored and the run continues/);
    assert.match(resumed.stderr, /phase triage: re-entered \(attempt 2\), clearing the worker-failed blocker/);
    assert.equal(box.checkpoint.foldRuns().length, 1);
  });

  // R2, R8, R13 of the configuration: the files and flags of a review, read as the command reads them.
  it('reviews the branch from origin/HEAD with --branch, under the operator\'s, the clone\'s and the --config file and a --set, each recorded with its layer', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const start = git(box.repo, 'rev-parse', 'HEAD~1');
    git(box.repo, 'update-ref', 'refs/remotes/origin/main', start);
    git(box.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    write(box.repo, 'src/c.ts', 'export const c = 1;\n');
    commitAll(box.repo, 'a second commit on the branch');
    const operatorFile = process.platform === 'win32' ? join(box.home, 'AppData', 'Roaming', 'deep-review', 'config.toml') : join(box.home, '.config', 'deep-review', 'config.toml');
    write(operatorFile, '', 'schema = 1\nbudget.usd = 33\n');
    const commonDir = locateCheckpoint(box.repo).commonDir;
    writeFileSync(join(commonDir, 'deep-review.toml'), 'schema = 1\ntools.path = ["bin"]\n');
    const invocation = join(box.directory, 'run.toml');
    writeFileSync(invocation, 'schema = 1\nconventions.user_rules = "ignore"\n');
    const result = await run(box, ...claudeFlags(box, '--branch', '--config', invocation, '--set', 'run.concurrency=2'));
    assert.equal(result.status, 2, result.stderr);
    const state = box.run();
    assert.deepEqual(state.scope?.request, { range: { from: 'origin/main', to: 'HEAD', mergeBase: true }, paths: [], exclude: [] });
    assert.equal(state.scope?.base, start, 'the merge base of origin/main and HEAD');
    assert.deepEqual(state.scope?.files.map((file) => file.path).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/gone.ts'], 'both commits of the branch');
    const configuration = state.review!.configuration;
    assert.equal(configuration.runBudgetUsd, 33);
    assert.equal(configuration.concurrency, 2);
    assert.deepEqual(configuration.survey, { userRules: 'ignore' });
    const settings = configuration.settings!;
    assert.deepEqual([settings.layers['budget.usd'], settings.layers['run.concurrency'], settings.layers['conventions.user_rules'], settings.layers['tools.path'], settings.layers['review.base']], ['operator', 'flag', 'invocation', 'clone', 'default']);
    assert.equal(settings.values['review.base'], 'origin/main');
    assert.deepEqual(settings.values['tools.path'], [join(box.repo, 'bin')]);
    assert.deepEqual(settings.files.map((file) => [file.layer, file.path]), [['operator', operatorFile], ['clone', join(commonDir, 'deep-review.toml')], ['invocation', invocation]]);
    assert.match(result.stderr, /settings from the operator's file /);
    // status names the scope the run recorded as branch, counts its commits, and gives the paths it captured (R12 of the questions in the chat).
    const status = await run(box, 'status', '--run', state.id);
    assert.equal(status.status, 0, status.stderr);
    const branchCommits = Number(git(box.repo, 'rev-list', '--count', '--first-parent', `${start}..HEAD`));
    assert.ok(status.stdout.includes(`\nScope: branch, ${String(branchCommits)} commits and 4 files, from the merge base with origin/main (${start.slice(0, 8)}) to the working tree\n`), status.stdout);
    const json = JSON.parse((await run(box, 'status', '--run', state.id, '--json')).stdout) as { scope: { mode: string; commits: number; files: string[]; excluded: string[] } };
    assert.deepEqual([json.scope.mode, json.scope.commits, [...json.scope.files].sort(), json.scope.excluded], ['branch', branchCommits, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/gone.ts'], []]);
  });

  it('refuses --branch in a clone with no origin/HEAD, naming the setting and the flag, and takes --base over it', async (t) => {
    const box = ReviewSandbox.forTest(t, { triage: { exit: 2 } });
    const refused = await run(box, ...claudeFlags(box, '--branch'));
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /refused: --branch needs the branch the change starts from, and this clone has no origin\/HEAD; set review\.base [^\n]*, or give --base <rev>/);
    assert.deepEqual(box.checkpoint.foldRuns(), []);
    const based = await run(box, ...claudeFlags(box, '--branch', '--base', 'HEAD~1'));
    assert.equal(based.status, 2, based.stderr);
    assert.deepEqual(box.run().scope?.request.range, { from: 'HEAD~1', to: 'HEAD', mergeBase: true });
    assert.equal(box.run().review!.configuration.settings!.layers['review.base'], 'flag');
  });

  it('captures the scope the command names for an active run that has none yet, and refuses a mistaken scope before capturing anything', async (t) => {

    const box = ReviewSandbox.forTest(t);
    // A run left without a scope, as a capture that threw leaves it.
    const runId = box.checkpoint.createRun({ worktree: box.repo }).id;
    const mistaken = await run(box, ...claudeFlags(box, '--base', 'main'));
    assert.equal(mistaken.status, 1, mistaken.stderr);
    assert.match(mistaken.stderr, /--base applies to --branch only/);
    assert.equal(box.checkpoint.fold(runId).scope, null, 'nothing was captured');
    box.script({});
    const scoped = await run(box, ...claudeFlags(box, '--ref', 'HEAD~1', '--path', 'src'));
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.doesNotMatch(scoped.stderr, /scope flags are ignored/);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'the scopeless run continued');
    assert.deepEqual(box.checkpoint.fold(runId).scope?.request, { ref: 'HEAD~1', paths: ['src'], exclude: [] }, 'the scope asked for, not an automatic one');
  });

  it('refuses to abandon a run another engine holds, abandons it once released, then starts a new run, and with --fix --fresh one more beside the finished one', async (t) => {

    const box = ReviewSandbox.forTest(t);
    box.script({ triage: { exit: 2 } });
    assert.equal((await run(box, ...claudeFlags(box, '--last-commit'))).status, 2);
    const runId = box.run().id;
    // This test process holds the lock, as a running engine would; the command runs in a process of its own.
    const release = acquireRunLock(box.checkpoint.root, runId);
    try {
      const held = await run(box, 'abandon', '--reason', 'stuck');
      assert.equal(held.status, 2, held.stderr);
      assert.ok(held.stderr.startsWith(`blocked (lock-held): engine ${String(process.pid)} is running run ${runId} (lock `), held.stderr);
      assert.ok(held.stderr.endsWith('; wait for that engine to finish; the lock clears itself when its process ends\n'), held.stderr);
      const review = await run(box, ...claudeFlags(box));
      assert.equal(review.status, 2, review.stderr);
      assert.match(review.stderr, /blocked \(lock-held\)/);
    } finally {
      release();
    }
    // An engine between finding its run and locking it holds the start lock; abandon waits its turn too.
    const starting = acquireStartLock(box.checkpoint.root);
    try {
      const held = await run(box, 'abandon', '--reason', 'stuck');
      assert.equal(held.status, 2, held.stderr);
      assert.ok(held.stderr.startsWith(`blocked (lock-held): engine ${String(process.pid)} is starting or ending a run in this repository`), held.stderr);
    } finally {
      starting();
    }
    // --run takes the first 8 characters of the id (R11 of the questions in the chat).
    const abandoned = await run(box, 'abandon', '--reason', 'stuck', '--run', shortRunId(runId));
    assert.equal(abandoned.status, 0, abandoned.stderr);
    assert.equal(abandoned.stdout, `run ${runId} abandoned: stuck\n`);
    assert.equal(box.checkpoint.fold(runId).status, 'abandoned');
    assert.equal((await run(box, 'abandon', '--reason', 'again')).status, 1, 'no active run is left');
    box.script({});
    const fresh = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(box.checkpoint.foldRuns().length, 2);
    assert.match((await run(box, 'status', '--run', shortRunId(runId))).stdout, /: abandoned \(stuck\)\n/);
    // --fresh reaches the engine: the finished read-only run just written is not continued (R2 of fix pass continuation).
    box.script({ triage: { exit: 2 } });
    const declined = await run(box, ...claudeFlags(box, '--last-commit', '--fix', '--fresh'));
    assert.equal(declined.status, 2, declined.stderr);
    assert.match(declined.stderr, /^--fresh: no finished run is considered; a new run is created$/m);
    assert.equal(box.checkpoint.foldRuns().length, 3);
  });

  // Issue #37: a run another engine build wrote, holding an event this engine does not declare, stopped every command that picks a run.
  it('passes over a run this engine cannot read when a command looks for its run, and refuses it by name with exit 1', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const unreadable = box.unreadableRun();
    const reason = `it holds phase.finished@99 at sequence 2, written by engine ${otherEngine}, which this engine (`;
    const passedOver = `run ${unreadable}: passed over: ${reason}`;
    const status = await run(box, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'No active run.\n');
    assert.ok(status.stderr.startsWith(passedOver) && status.stderr.endsWith('such as the one that wrote it, can read the run\n'), status.stderr);
    assert.equal(status.stderr.split('\n').length, 2, 'one line');
    const json = await run(box, 'status', '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout), null, 'stdout stays JSON, the line goes to stderr');
    assert.ok(json.stderr.startsWith(passedOver), json.stderr);
    const abandon = await run(box, 'abandon', '--reason', 'which one');
    assert.equal(abandon.status, 1, abandon.stderr);
    assert.ok(abandon.stderr.startsWith(passedOver) && abandon.stderr.includes('\nno active run to abandon\n'), abandon.stderr);
    for (const args of [['status', '--run', unreadable], ['abandon', '--run', unreadable, '--reason', 'from the older engine'], ['commit', '--run', unreadable]]) {
      const named = await run(box, ...args);
      assert.equal(named.status, 1, `${args.join(' ')}: ${named.stderr}`);
      assert.ok(named.stderr.startsWith(`UnreadableRunError: run ${unreadable} cannot be read: ${reason}`), `${args.join(' ')}: ${named.stderr}`);
    }
    box.script({});
    const review = await run(box, ...claudeFlags(box, '--last-commit'));
    assert.equal(review.status, 0, review.stderr);
    assert.ok(review.stderr.startsWith(passedOver), review.stderr);
    assert.equal(box.checkpoint.ledger.lastSequence(unreadable), 2, 'nothing was appended to the run passed over');
    assert.deepEqual(box.checkpoint.listRuns().map((listed) => isUnreadable(listed)), [true, false], 'the review ran a run of its own');
  });

  it('exits 2 on a refusal that has no blocker code, as on one that has', async (t) => {

    const box = ReviewSandbox.forTest(t);
    box.script({ triage: { exit: 2 } });
    assert.equal((await run(box, ...claudeFlags(box, '--last-commit'))).status, 2);
    const first = box.run().id;
    const second = box.checkpoint.createRun({ worktree: box.repo }).id;
    for (const args of [claudeFlags(box), ['status'], ['abandon', '--reason', 'which one']]) {
      const refused = await run(box, ...args);
      assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
      assert.equal(refused.stderr, `refused: 2 runs are active (${first}, ${second}); abandon all but one with \`deep-review abandon --run <id> --reason <text>\`\n`, args.join(' '));
    }
  });

  it('refuses a start of a run id that two runs share with exit 2, naming both, in each command that takes --run (R11 of the questions in the chat)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const shared = ['1a2b3c4d-0000-4000-8000-000000000001', '1a2b3c4d-1111-4000-8000-000000000002'];
    const checkpoint = Checkpoint.open(locateCheckpoint(box.repo).root, { engine: '0.0.0-test', ids: () => shared[checkpoint.runIds().length]! });
    try {
      for (let index = 0; index < shared.length; index++) checkpoint.createRun({ worktree: box.repo });
    } finally {
      checkpoint.close();
    }
    for (const args of [['status', '--run', '1a2b3c4d'], ['report', '--run', '1a2b3c4d'], ['abandon', '--run', '1a2b3c4d', '--reason', 'which one'], ['commit', '--run', '1a2b3c4d'], ['answer', '--run', '1a2b3c4d', '--finding', 'SCAN-1', '--accept']]) {
      const refused = await run(box, ...args);
      assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
      assert.equal(refused.stderr, `refused: --run 1a2b3c4d names 2 runs (${shared.join(', ')}); give more of the id\n`, args.join(' '));
    }
    const longer = await run(box, 'status', '--run', '1a2b3c4d-1');
    assert.equal(longer.status, 0, longer.stderr);
    assert.ok(longer.stdout.startsWith(`Run ${shared[1]!}`), longer.stdout);
  });

  it('resumes after the engine is killed mid-phase: the running workers are lost, the answered units are not run again', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const marker = join(box.directory, 'design-may-answer');
    // DESIGN, the sixth finder, waits for the marker; with a concurrency of 2 at least three finders answer before it is reached.
    box.script({ 'finder-DESIGN': { waitFor: marker } });
    const child = spawn(process.execPath, [cli, ...claudeFlags(box, '--last-commit', '--concurrency', '2')], { cwd: box.repo, env: environment(box), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const root = locateCheckpoint(box.repo).root;
    await until(() => existsSync(join(root, 'ledger.sqlite')), 'the checkpoint', 60_000);
    const answered = (): string[] => {
      const checkpoint = Checkpoint.open(root, { engine: 'test-observer' });
      try {
        const run = checkpoint.foldRuns()[0];
        return run?.review === null || run?.review === undefined ? [] : Object.entries(run.review.units.finders).filter(([, unit]) => unit.answeredBy !== null).map(([angle]) => `finders:${angle}`);
      } finally {
        checkpoint.close();
      }
    };
    const runningOnLedger = (): number => {
      const checkpoint = Checkpoint.open(root, { engine: 'test-observer' });
      try {
        return Object.values(checkpoint.foldRuns()[0]?.workers ?? {}).filter((worker) => worker.status === 'running').length;
      } finally {
        checkpoint.close();
      }
    };
    await until(() => answered().length >= 3 && /worker finder-DESIGN finders:DESIGN: started/.test(stderr) && runningOnLedger() >= 1, 'three finders answered and a worker running on the ledger', 120_000);
    const before = answered();
    child.kill();
    await new Promise<void>((done) => child.once('close', () => done()));
    // The awaited close shows the killed engine exited; its pid is not probed, since Windows can give the number to another process while the resume runs.
    // The orphaned DESIGN worker, if any, waits for the marker; let it go so nothing outlives the test.
    writeFileSync(marker, '');
    const midway = box.run();
    const running = Object.values(midway.workers).filter((worker) => worker.status === 'running');
    assert.ok(running.length >= 1, 'a worker was running when the engine died');
    assert.equal(midway.review!.phases.finders.status, 'running');
    const resumed = await run(box, ...claudeFlags(box));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stderr, /: resuming\n/);
    assert.match(resumed.stderr, /lost with the previous engine/);
    assert.match(resumed.stderr, /phase finders: re-entered \(attempt 2\)/);
    const after = box.run();
    assert.ok(Object.values(after.workers).filter((worker) => worker.status === 'lost').length >= 1);
    // Every finder answered before the kill was launched exactly once in all; the lost ones twice.
    for (const angle of finderAngles) {
      const launches = Object.values(after.workers).filter((worker) => worker.launch.label === `finder-${angle} finders:${angle}`).length;
      if (before.includes(`finders:${angle}`)) assert.equal(launches, 1, `${angle} was answered before the kill and not run again`);
      else assert.ok(launches >= 1 && launches <= 2, `${angle}: ${String(launches)} launches`);
    }
    assert.equal(after.review!.report !== null, true);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'the same run continued');
  });

  it('resumes a fix run whose engine was killed while a fixer ran: the fixer\'s half-applied edit is no drift, and its replacement is told so', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const marker = join(box.directory, 'fixer-may-answer');
    const fixed = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
    box.script({
      triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'other() passes null' }], leads: finderAngles.map((angle) => ({ angle, lead: null })), change: null } },
      // The first fixer edits its file and then waits; it is killed with the engine. Its replacement answers.
      'fixer:fixes:c1-1': [{ edits: [{ writes: { 'src/a.ts': `${fixed}// half done\n` } }], waitFor: marker }, { edits: [{ writes: { 'src/a.ts': fixed } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) }],
    });
    const checks = checkKinds.flatMap((kind) => ['--check', `${kind}=${fakeCheckCommand(kind)}`]);
    const child = spawn(process.execPath, [cli, ...claudeFlags(box, '--last-commit', '--fix', ...checks)], { cwd: box.repo, env: environment(box), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    await until(() => /worker fixer fixes:c1-1: started/.test(stderr) && readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8').includes('half done'), 'the fixer\'s half-applied edit', 180_000);
    child.kill();
    await new Promise<void>((done) => child.once('close', () => done()));
    // The orphaned fixer, if any, waits for the marker; let it go so nothing outlives the test.
    writeFileSync(marker, '');
    const resumed = await run(box, ...claudeFlags(box, '--fix'));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stderr, /lost with the previous engine/);
    assert.match(resumed.stderr, /phase fixes: re-entered \(attempt 2\)/);
    const state = box.run();
    assert.ok(state.review!.checks.every((check) => !check.drifted), 'the lost fixer\'s owned file is left out of the start check');
    const prompts = Object.values(state.workers).filter((worker) => worker.launch.label === 'fixer fixes:c1-1');
    assert.equal(prompts.length, 2);
    assert.match(box.checkpoint.evidence.read(prompts[1]!.launch.prompt).toString('utf8'), /The tree may already hold part of this work/);
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), fixed);
    // The lost fixer's half-applied edit was recorded with its loss, as its own; the replacement's edit after it is the finding's (R20).
    assert.match(resumed.stderr, /worker fixer fixes:c1-1: its edits recorded in 1 revision/);
    assert.deepEqual(state.review!.fix!.revisions.map((revision) => [revision.source.kind === 'attempt' ? revision.source.workerId : revision.source.kind, revision.change.findings]), [[prompts[0]!.launch.workerId, []], ['fix', ['SCAN-1']]]);
    const events = box.events(state.id);
    const lostAt = events.findIndex(([kind]) => kind === 'worker.lost');
    assert.equal(events[lostAt + 1]?.[0], 'tree.revised', 'the revision follows the loss in its append');
  });

  it('resumes a fix run whose claims directory was removed with its engine, seeding it again from the ledger, so a retry\'s claim of its cluster\'s file is its own (R3 of commit series integrity)', async (t) => {
    const box = ReviewSandbox.forTest(t);
    const policyFile = join(box.rolesRoot, policyFileName);
    writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(readFileSync(policyFile, 'utf8')), fixes: { batchSize: 1 } }, null, 2));
    const marker = join(box.directory, 'fixer-may-answer');
    const shared = 'test/shared.test.ts';
    const found = (line: number, summary: string): Record<string, unknown> => ({ file: 'src/a.ts', line, summary, detail: `${summary}: d` });
    box.script({
      triage: { output: { candidates: [found(2, 'text is dereferenced when null'), found(6, 'other() passes null on')], leads: finderAngles.map((angle) => ({ angle, lead: null })), change: null } },
      // c1-1 claims the shared test and answers; c1-2 waits and is killed with the engine; its replacement claims the same file again.
      'fixer:fixes:c1-1': { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { [shared]: 'shared\n' } }], output: fixerAnswer([{ files: [shared] }]) },
      'fixer:fixes:c1-2': [{ waitFor: marker }, { edits: [{ claims: [shared], expectClaim: 'claimed', writes: { [shared]: 'shared\nmore\n' } }], output: fixerAnswer([{ files: [shared] }]) }],
    });
    const checks = checkKinds.flatMap((kind) => ['--check', `${kind}=${fakeCheckCommand(kind)}`]);
    const child = spawn(process.execPath, [cli, ...claudeFlags(box, '--last-commit', '--fix', ...checks)], { cwd: box.repo, env: environment(box), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const root = locateCheckpoint(box.repo).root;
    const secondRunning = (): boolean => {
      const checkpoint = Checkpoint.open(root, { engine: 'test-observer' });
      try {
        return Object.values(checkpoint.foldRuns()[0]?.workers ?? {}).some((worker) => worker.launch.label === 'fixer fixes:c1-2' && worker.status === 'running');
      } finally {
        checkpoint.close();
      }
    };
    await until(() => /worker fixer fixes:c1-2: started/.test(stderr) && secondRunning(), 'the second batch running on the ledger', 180_000);
    child.kill();
    await new Promise<void>((done) => child.once('close', () => done()));
    writeFileSync(marker, '');
    const midway = box.run();
    assert.deepEqual(midway.review!.fix!.claims.map((claim) => [claim.path, claim.key]), [[shared, 'c1-1']], 'the claim reached the ledger with c1-1\'s answer');
    // The engine's claims directory is under the system's temporary directory, as its scratch is; a cleaning removes it while no engine runs.
    const directory = claimsDirectoryFor(join(tmpdir(), 'deep-review-scratch', checkpointScratchKey(box.checkpoint)), midway.id, 1);
    assert.ok(existsSync(directory), directory);
    rmSync(directory, { recursive: true });
    try {
      const resumed = await run(box, ...claudeFlags(box, '--fix'));
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.match(resumed.stderr, /lost with the previous engine/);
      const state = box.run();
      // The retry's claim found the seeded marker of its cluster's claim and made none of its own.
      assert.deepEqual(readClaims(directory, caseInsensitiveFileSystem(box.repo)).map((claim) => (claim.whole ? [claim.generation, claim.cluster, claim.unit] : null)), [[1, 'c1', 'c1-1']]);
      assert.deepEqual(state.review!.fix!.claims.map((claim) => [claim.path, claim.key]), [[shared, 'c1-1']]);
      assert.deepEqual(state.review!.fix!.answers.fixes['c1-2']!.violations, []);
      assert.ok(state.review!.checks.every((check) => !check.drifted));
    } finally {
      rmSync(join(tmpdir(), 'deep-review-scratch', checkpointScratchKey(box.checkpoint)), { recursive: true, force: true });
    }
  });

  it('runs snapshot from a fixer\'s shell and refuses it outside a worktree', async (t) => {

    const box = ReviewSandbox.forTest(t);
    const into = join(box.directory, 'snapshots');
    write(box.repo, 'src/a.ts', 'changed\n');
    const taken = await run(box, 'snapshot', '--finding', '0', '--into', into);
    assert.equal(taken.status, 0, taken.stderr);
    assert.match(taken.stdout, /^snapshot 0: \d+ paths into /);
    const outside = await node([cli, 'snapshot', '--finding', '0', '--into', into], { cwd: box.directory, env: environment(box) });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /is not inside a git worktree/);
  });
});
