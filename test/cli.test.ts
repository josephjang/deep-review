import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint, isUnreadable } from '../src/checkpoint/checkpoint.ts';
import { locateCheckpoint } from '../src/checkpoint/locate.ts';
import { acquireRunLock, acquireStartLock } from '../src/review/lock.ts';
import { maxConcurrency } from '../src/review/policy.ts';
import { checkKinds, finderAngles } from '../src/review/vocabulary.ts';
import { fixerAnswer } from './helpers/fake-runtime.ts';
import { baseEnvironment, fakeClaude, fakeCodex, isAlive, until } from './helpers/launcher.ts';
import { write } from './helpers/repository.ts';
import { fakeCheckCommand, otherEngine, ReviewSandbox } from './helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../src/cli.ts');

describe('the deep-review command', { timeout: 900_000 }, () => {
  let box: ReviewSandbox;
  beforeEach(() => {
    box = new ReviewSandbox();
  });
  afterEach(() => {
    box.close();
  });

  const environment = (): NodeJS.ProcessEnv => ({ ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile, HOME: box.home, USERPROFILE: box.home });
  const run = (...args: string[]): SpawnSyncReturns<string> => spawnSync(process.execPath, [cli, ...args], { cwd: box.repo, env: environment(), encoding: 'utf8' });
  const claudeFlags = (...more: string[]): string[] => ['review', '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', box.rolesRoot, ...more];

  it('prints the usage and exits 1 without a command, and 0 with --help', () => {
    const none = run();
    assert.equal(none.status, 1);
    assert.match(none.stdout, /^usage:/);
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /deep-review review {2}--runtime claude\|codex/);
    assert.ok(help.stdout.includes(`[--concurrency 1..${String(maxConcurrency)}]`), 'the usage names the bound the flag is checked against');
    assert.ok(help.stdout.includes('[--codex-windows-sandbox unelevated|elevated|none]'), 'the usage names the Codex Windows sandboxes');
  });

  it('refuses a command-line mistake with the usage and exit 1', () => {
    for (const [args, message] of [
      [['bogus'], /unknown command "bogus"/],
      [['status', '--runtime', 'claude'], /--runtime does not apply to status/],
      [claudeFlags('--last-commit', '--worktree'), /choose one scope/],
      [claudeFlags('--from', 'HEAD~1'), /--from and --to go together/],
      [claudeFlags('--last-commit', '--merge-base'), /--merge-base applies to --from and --to only/],
      [claudeFlags('--last-commit', '--concurrency', '0'), new RegExp(`--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not 0`)],
      [claudeFlags('--last-commit', '--concurrency', String(maxConcurrency + 1)), new RegExp(`--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not ${String(maxConcurrency + 1)}`)],
      [claudeFlags('--last-commit', '--concurrency', '2.5'), /--concurrency must be a whole number from 1 to \d+, not 2\.5/],
      [claudeFlags('--last-commit', '--budget-usd', 'lots'), /--budget-usd must be a number/],
      [claudeFlags('--last-commit', '--budget-usd', '0'), /--budget-usd must be a positive number, not 0/],
      [claudeFlags('--last-commit', '--budget-usd=-1'), /--budget-usd must be a positive number, not -1/],
      [['review', '--last-commit'], /--runtime claude\|codex is required/],
      [['review', '--runtime', 'gemini', '--last-commit'], /--runtime must be one of claude, codex/],
      [claudeFlags('--worktree'), /--worktree reviews uncommitted changes, and this tree has none/],
      [['abandon'], /--reason <text> is required/],
      [claudeFlags('--last-commit', '--check', 'lint=x'), /--check and --no-check apply only with --fix/],
      [claudeFlags('--last-commit', '--no-check', 'lint'), /--check and --no-check apply only with --fix/],
      [claudeFlags('--last-commit', '--fix', '--check', 'lint=x', '--check', 'lint=y'), /--check names the lint check, which another --check or --no-check already names/],
      [claudeFlags('--last-commit', '--fix', '--check', 'lint=x', '--no-check', 'lint'), /--no-check names the lint check, which another/],
      [claudeFlags('--last-commit', '--fix', '--check', 'format=x'), /--check names a check kind, one of build, typecheck, lint, test, not "format"/],
      [claudeFlags('--last-commit', '--fix', '--check', 'lint'), /--check takes <kind>=<command>, not "lint"/],
      [claudeFlags('--last-commit', '--fix', '--check', 'lint= '), /--check lint= needs a command/],
      [['status', '--fix'], /--fix does not apply to status/],
      [claudeFlags('--last-commit', '--codex-windows-sandbox', 'elevated'), /--codex-windows-sandbox applies only to runtime codex, not claude/],
      [claudeFlags('--last-commit', '--codex-windows-sandbox', 'full'), /--codex-windows-sandbox must be one of unelevated, elevated, none, not "full"/],
      [['review', '--runtime', 'codex', '--executable', process.execPath, '--executable-arg', fakeCodex, '--roles', box.rolesRoot, '--last-commit', '--codex-windows-sandbox', ''], /--codex-windows-sandbox must be one of unelevated, elevated, none, not ""/],
      [['status', '--codex-windows-sandbox', 'none'], /--codex-windows-sandbox does not apply to status/],
    ] as const) {
      const result = run(...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, message, args.join(' '));
      assert.match(result.stderr, /usage:/, `${args.join(' ')} prints the usage`);
    }
    assert.match(run(...claudeFlags()).stderr, /a new run needs its scope/);
    // A policy refusal is an engine error, exit 1 without the usage.
    const codexBudget = run('review', '--runtime', 'codex', '--executable', process.execPath, '--executable-arg', fakeCodex, '--roles', box.rolesRoot, '--last-commit', '--budget-usd', '5');
    assert.equal(codexBudget.status, 1);
    assert.match(codexBudget.stderr, /^InvalidPolicyError: --budget-usd does not apply to runtime codex/);
  });

  it('refuses a .cmd shim and a missing executable as runtime-unqualified, with exit 2', () => {
    const shim = join(box.directory, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const refused = run(...claudeFlags('--last-commit').map((arg) => (arg === process.execPath ? shim : arg)));
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /^blocked \(runtime-unqualified\): .*claude\.cmd is a \.cmd shim, which cannot be spawned without a shell; pass --executable/);
    const missing = run('review', '--runtime', 'claude', '--executable', join(box.directory, 'absent'), '--last-commit');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /is not a file; pass --executable/);
    // The executable is resolved once the engine knows the run is new, which takes the checkpoint; the refusal comes before a run is created.
    assert.deepEqual(box.checkpoint.foldRuns(), [], 'no run was created');
    assert.equal(run('status').stdout, 'No active run.\n');
  });

  it('resumes a configured run with its pinned executable, never resolving or refusing the one the command names or finds on PATH', () => {
    box.script({ triage: { exit: 2 } });
    assert.equal(run(...claudeFlags('--last-commit')).status, 2);
    const pinned = box.run().review!.configuration;
    // A shim the command refuses for a new run, first on PATH as an npm install on Windows puts claude.cmd there, and named by the flag.
    const shims = join(box.directory, 'shims');
    mkdirSync(shims);
    const shim = join(shims, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const env = { ...Object.fromEntries(Object.entries(environment()).filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: `${shims}${delimiter}${process.env.PATH ?? ''}` };
    const review = (...args: string[]): SpawnSyncReturns<string> => spawnSync(process.execPath, [cli, 'review', '--runtime', 'claude', '--roles', box.rolesRoot, ...args], { cwd: box.repo, env, encoding: 'utf8' });
    // Named by the flag: the run resumes, and blocks again only because its triage fails again.
    const named = review('--executable', shim);
    assert.equal(named.status, 2, named.stderr);
    assert.match(named.stderr, /^blocked in triage \(worker-failed\)/m);
    assert.doesNotMatch(named.stderr, /runtime-unqualified/);
    // Found on PATH, as the command resolves a runtime name with no --executable: the run resumes to its report.
    box.script({});
    const found = review();
    assert.equal(found.status, 0, found.stderr);
    const state = box.run();
    assert.deepEqual(state.review!.configuration, pinned);
    assert.ok(Object.values(state.workers).every((worker) => worker.launch.executable === pinned.executable), 'every worker ran the pinned executable');
    // A new run still resolves the command's executable, and refuses the shim before it creates a run.
    const fresh = review('--executable', shim, '--last-commit');
    assert.equal(fresh.status, 2, fresh.stderr);
    assert.match(fresh.stderr, /^blocked \(runtime-unqualified\): .*claude\.cmd is a \.cmd shim, which cannot be spawned without a shell/);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'no new run was created');
  });

  it('says there is no run before any review, in text and JSON, and finds the repository through --repo given absolute or relative', () => {
    assert.equal(run('status').stdout, 'No run: this repository has no checkpoint yet.\n');
    assert.equal(run('status', '--json').stdout, 'null\n');
    const elsewhere = spawnSync(process.execPath, [cli, 'status', '--repo', box.repo], { cwd: box.directory, env: environment(), encoding: 'utf8' });
    assert.equal(elsewhere.stdout, 'No run: this repository has no checkpoint yet.\n', elsewhere.stderr);
    const relative = spawnSync(process.execPath, [cli, 'status', '--repo', 'repo'], { cwd: box.directory, env: environment(), encoding: 'utf8' });
    assert.equal(relative.stdout, 'No run: this repository has no checkpoint yet.\n', relative.stderr);
    const outside = spawnSync(process.execPath, [cli, 'status', '--repo', box.home], { cwd: box.directory, env: environment(), encoding: 'utf8' });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /NotInRepositoryError/);
    const abandon = run('abandon', '--reason', 'nothing');
    assert.equal(abandon.status, 1);
    assert.match(abandon.stderr, /no checkpoint, so there is no run to abandon/);
  });

  it('reviews the last commit to a report, prints its path last, and then reports the run through status', () => {
    box.script({});
    const result = run(...claudeFlags('--last-commit'));
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    const reportPath = lines.at(-1)!;
    assert.ok(existsSync(reportPath), reportPath);
    assert.match(readFileSync(reportPath, 'utf8'), /^# Deep review report\n/);
    assert.match(result.stderr, /run [0-9a-f-]+: created\n/);
    assert.match(result.stderr, /phase triage: started \(attempt 1\)/);
    assert.match(result.stderr, /worker triage triage:SCAN: completed in [0-9.]+ s, 0\.00 USD/);
    assert.match(result.stderr, /report written to /);
    // Status: the run is complete, and JSON carries the review projection.
    const status = run('status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'No active run.\n', 'a complete run is not active');
    const runId = /run ([0-9a-f-]+): created/.exec(result.stderr)![1]!;
    const named = run('status', '--run', runId);
    assert.match(named.stdout, new RegExp(`^Run ${runId}: complete\\n`));
    assert.match(named.stdout, /^Runtime: claude 2\.1\.283; models opus and sonnet$/m);
    assert.match(named.stdout, /^Phase: none running$/m);
    assert.match(named.stdout, /^Workers: 0 running, 12 finished, 0 lost$/m);
    assert.match(named.stdout, /^Spend: 0\.01 USD of 60\.00 USD; \d+ input, \d+ output tokens$/m);
    assert.match(named.stdout, /^Report: .+$/m);
    const json = JSON.parse(run('status', '--run', runId, '--json').stdout) as { runId: string; status: string; workers: { finished: number }; review: { report: unknown; blocker: null } };
    assert.equal(json.runId, runId);
    assert.equal(json.status, 'complete');
    assert.equal(json.workers.finished, 12);
    assert.ok(json.review.report !== null);
    assert.equal(json.review.blocker, null);
    // A complete run is not abandoned after the fact: its report stands, and so does its status.
    const late = run('abandon', '--run', runId, '--reason', 'cleanup');
    assert.equal(late.status, 1, late.stderr);
    assert.match(late.stderr, new RegExp(`^run ${runId} is complete; only an active or blocked run can be abandoned\\n`));
    assert.match(run('status', '--run', runId).stdout, new RegExp(`^Run ${runId}: complete\\n`));
    // Reviewing again starts a new run, since a finished run is not reopened; its scope flags are needed.
    const again = run(...claudeFlags());
    assert.equal(again.status, 1);
    assert.match(again.stderr, /a new run needs its scope/);
    const second = run(...claudeFlags('--ref', 'HEAD~1', '--path', 'src'));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(box.checkpoint.foldRuns().length, 2);
    assert.deepEqual(box.checkpoint.foldRuns()[1]!.scope?.request, { ref: 'HEAD~1', paths: ['src'] });
    // An id the checkpoint does not hold is a command-line mistake, for status and abandon alike.
    for (const args of [['status', '--run', 'nope'], ['abandon', '--run', 'nope', '--reason', 'gone']]) {
      const unknown = run(...args);
      assert.equal(unknown.status, 1, args.join(' '));
      assert.match(unknown.stderr, /nope[\s\S]*\n\nusage:/, args.join(' '));
    }
  });

  it('exits 2 with the blocker when the run blocks, survives status --json, and continues on the next command', () => {
    box.script({ triage: { exit: 2 } });
    const blocked = run(...claudeFlags('--last-commit'));
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /^blocked in triage \(worker-failed\): the triage worker for triage:SCAN failed twice: .*\naction: run the command again, which gives the failed worker two fresh attempts, or abandon the run\n$/m);
    const status = run('status');
    assert.match(status.stdout, /^Run [0-9a-f-]+: blocked\n/);
    assert.match(status.stdout, /^Phase: triage \(attempt 1, blocked\)$/m);
    assert.match(status.stdout, /^Blocker: worker-failed: the triage worker/m);
    assert.match(status.stdout, /^Action: run the command again/m);
    const json = JSON.parse(run('status', '--json').stdout) as { status: string; blocker: { code: string; action: string } };
    assert.equal(json.status, 'blocked');
    assert.equal(json.blocker.code, 'worker-failed');
    assert.match(json.blocker.action, /run the command again/);
    box.script({});
    // The scope flags of a resumed run are ignored, with a note.
    const resumed = run(...claudeFlags('--worktree'));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stderr, /is active; its scope flags are ignored and the run continues/);
    assert.match(resumed.stderr, /phase triage: re-entered \(attempt 2\), clearing the worker-failed blocker/);
    assert.equal(box.checkpoint.foldRuns().length, 1);
  });

  it('captures the scope the command names for an active run that has none yet, and refuses one without scope flags', () => {
    // A run left without a scope, as a capture that threw leaves it.
    const runId = box.checkpoint.createRun({ worktree: box.repo }).id;
    const bare = run(...claudeFlags());
    assert.equal(bare.status, 1, bare.stderr);
    assert.match(bare.stderr, /needs its scope: --last-commit, --worktree/);
    assert.equal(box.checkpoint.fold(runId).scope, null, 'nothing was captured');
    box.script({});
    const scoped = run(...claudeFlags('--ref', 'HEAD~1', '--path', 'src'));
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.doesNotMatch(scoped.stderr, /scope flags are ignored/);
    assert.equal(box.checkpoint.foldRuns().length, 1, 'the scopeless run continued');
    assert.deepEqual(box.checkpoint.fold(runId).scope?.request, { ref: 'HEAD~1', paths: ['src'] }, 'the scope asked for, not an automatic one');
  });

  it('refuses to abandon a run another engine holds, abandons it once released, and then starts a new run', () => {
    box.script({ triage: { exit: 2 } });
    assert.equal(run(...claudeFlags('--last-commit')).status, 2);
    const runId = box.run().id;
    // This test process holds the lock, as a running engine would; the command runs in a process of its own.
    const release = acquireRunLock(box.checkpoint.root, runId);
    try {
      const held = run('abandon', '--reason', 'stuck');
      assert.equal(held.status, 2, held.stderr);
      assert.ok(held.stderr.startsWith(`blocked (lock-held): engine ${String(process.pid)} is running run ${runId} (lock `), held.stderr);
      assert.ok(held.stderr.endsWith('; wait for that engine to finish; the lock clears itself when its process ends\n'), held.stderr);
      const review = run(...claudeFlags());
      assert.equal(review.status, 2, review.stderr);
      assert.match(review.stderr, /blocked \(lock-held\)/);
    } finally {
      release();
    }
    // An engine between finding its run and locking it holds the start lock; abandon waits its turn too.
    const starting = acquireStartLock(box.checkpoint.root);
    try {
      const held = run('abandon', '--reason', 'stuck');
      assert.equal(held.status, 2, held.stderr);
      assert.ok(held.stderr.startsWith(`blocked (lock-held): engine ${String(process.pid)} is starting or ending a run in this repository`), held.stderr);
    } finally {
      starting();
    }
    const abandoned = run('abandon', '--reason', 'stuck');
    assert.equal(abandoned.status, 0, abandoned.stderr);
    assert.equal(abandoned.stdout, `run ${runId} abandoned: stuck\n`);
    assert.equal(box.checkpoint.fold(runId).status, 'abandoned');
    assert.equal(run('abandon', '--reason', 'again').status, 1, 'no active run is left');
    box.script({});
    const fresh = run(...claudeFlags('--last-commit'));
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(box.checkpoint.foldRuns().length, 2);
    assert.match(run('status', '--run', runId).stdout, /: abandoned \(stuck\)\n/);
  });

  // Issue #37: a run another engine build wrote, holding an event this engine does not declare, stopped every command that picks a run.
  it('passes over a run this engine cannot read when a command looks for its run, and refuses it by name with exit 1', () => {
    const unreadable = box.unreadableRun();
    const reason = `it holds phase.finished@99 at sequence 2, written by engine ${otherEngine}, which this engine (`;
    const passedOver = `run ${unreadable}: passed over: ${reason}`;
    const status = run('status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'No active run.\n');
    assert.ok(status.stderr.startsWith(passedOver) && status.stderr.endsWith('such as the one that wrote it, can read the run\n'), status.stderr);
    assert.equal(status.stderr.split('\n').length, 2, 'one line');
    const json = run('status', '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout), null, 'stdout stays JSON, the line goes to stderr');
    assert.ok(json.stderr.startsWith(passedOver), json.stderr);
    const abandon = run('abandon', '--reason', 'which one');
    assert.equal(abandon.status, 1, abandon.stderr);
    assert.ok(abandon.stderr.startsWith(passedOver) && abandon.stderr.includes('\nno active run to abandon\n'), abandon.stderr);
    for (const args of [['status', '--run', unreadable], ['abandon', '--run', unreadable, '--reason', 'from the older engine'], ['commit', '--run', unreadable]]) {
      const named = run(...args);
      assert.equal(named.status, 1, `${args.join(' ')}: ${named.stderr}`);
      assert.ok(named.stderr.startsWith(`UnreadableRunError: run ${unreadable} cannot be read: ${reason}`), `${args.join(' ')}: ${named.stderr}`);
    }
    box.script({});
    const review = run(...claudeFlags('--last-commit'));
    assert.equal(review.status, 0, review.stderr);
    assert.ok(review.stderr.startsWith(passedOver), review.stderr);
    assert.equal(box.checkpoint.ledger.lastSequence(unreadable), 2, 'nothing was appended to the run passed over');
    assert.deepEqual(box.checkpoint.listRuns().map((listed) => isUnreadable(listed)), [true, false], 'the review ran a run of its own');
  });

  it('exits 2 on a refusal that has no blocker code, as on one that has', () => {
    box.script({ triage: { exit: 2 } });
    assert.equal(run(...claudeFlags('--last-commit')).status, 2);
    const first = box.run().id;
    const second = box.checkpoint.createRun({ worktree: box.repo }).id;
    for (const args of [claudeFlags(), ['status'], ['abandon', '--reason', 'which one']]) {
      const refused = run(...args);
      assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
      assert.equal(refused.stderr, `refused: 2 runs are active (${first}, ${second}); abandon all but one with \`deep-review abandon --run <id> --reason <text>\`\n`, args.join(' '));
    }
  });

  it('resumes after the engine is killed mid-phase: the running workers are lost, the answered units are not run again', async () => {
    const marker = join(box.directory, 'design-may-answer');
    // DESIGN, the sixth finder, waits for the marker; with a concurrency of 2 at least three finders answer before it is reached.
    box.script({ 'finder-DESIGN': { waitFor: marker } });
    const child = spawn(process.execPath, [cli, ...claudeFlags('--last-commit', '--concurrency', '2')], { cwd: box.repo, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
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
    // The orphaned DESIGN worker, if any, waits for the marker; let it go so nothing outlives the test.
    writeFileSync(marker, '');
    const midway = box.run();
    const running = Object.values(midway.workers).filter((worker) => worker.status === 'running');
    assert.ok(running.length >= 1, 'a worker was running when the engine died');
    assert.equal(midway.review!.phases.finders.status, 'running');
    const resumed = run(...claudeFlags());
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
    assert.ok(!isAlive(child.pid!));
  });

  it('resumes a fix run whose engine was killed while a fixer ran: the fixer\'s half-applied edit is no drift, and its replacement is told so', async () => {
    const marker = join(box.directory, 'fixer-may-answer');
    const fixed = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
    box.script({
      triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'other() passes null' }], leads: finderAngles.map((angle) => ({ angle, lead: null })) } },
      // The first fixer edits its file and then waits; it is killed with the engine. Its replacement answers.
      'fixer:fixes:c1-1': [{ edits: [{ writes: { 'src/a.ts': `${fixed}// half done\n` } }], waitFor: marker }, { edits: [{ writes: { 'src/a.ts': fixed } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) }],
    });
    const checks = checkKinds.flatMap((kind) => ['--check', `${kind}=${fakeCheckCommand(kind)}`]);
    const child = spawn(process.execPath, [cli, ...claudeFlags('--last-commit', '--fix', ...checks)], { cwd: box.repo, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    await until(() => /worker fixer fixes:c1-1: started/.test(stderr) && readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8').includes('half done'), 'the fixer\'s half-applied edit', 180_000);
    child.kill();
    await new Promise<void>((done) => child.once('close', () => done()));
    // The orphaned fixer, if any, waits for the marker; let it go so nothing outlives the test.
    writeFileSync(marker, '');
    const resumed = run(...claudeFlags('--fix'));
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

  it('runs snapshot from a fixer\'s shell and refuses it outside a worktree', () => {
    const into = join(box.directory, 'snapshots');
    write(box.repo, 'src/a.ts', 'changed\n');
    const taken = run('snapshot', '--finding', '0', '--into', into);
    assert.equal(taken.status, 0, taken.stderr);
    assert.match(taken.stdout, /^snapshot 0: \d+ paths into /);
    const outside = spawnSync(process.execPath, [cli, 'snapshot', '--finding', '0', '--into', into], { cwd: box.directory, env: environment(), encoding: 'utf8' });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /is not inside a git worktree/);
  });
});
