import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import type { Checkpoint, NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { main } from '../../src/command.ts';
import { baseLockReason, makeBaseTree } from '../../src/review/checks/base.ts';
import { baseSkipReasons } from '../../src/review/vocabulary.ts';
import { checkpointScratchKey } from '../../src/runtime/scratch.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { fixedA, found, noLeads, reviewScript } from '../helpers/fix-pass-fixture.ts';
import { commitAll, git, repositoryWith, write } from '../helpers/repository.ts';
import { appending, reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** The fixer of c1-1 fixes src/a.ts, and the repair finds every failure there before the fixes. */
const script: Script = {
  ...reviewScript,
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
  'fixer:repair:repair': { output: fixerAnswer([{ status: 'deferred', files: [], note: 'every failure was there before the fixes' }]) },
};

/**
 * Two findings in src/a.ts, one batch each at a batch size of 1, whose first
 * fixer spends past a run budget of 1 USD, so the second batch is left for a
 * reopened fix pass.
 */
const budgetScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/a.ts', 6, 'other() passes null on')], leads: noLeads, change: null } },
  'fixer:fixes:c1-1': { costUsd: 5, edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
  'fixer:fixes:c1-2': { edits: [{ writes: { 'src/a.ts': fixedA.replace('return parse(null);', 'return parse(\'\');') }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
};

/** The worktrees of the repository as `git worktree list --porcelain` gives them, each as its lines. */
const worktrees = (repo: string): string[][] => git(repo, 'worktree', 'list', '--porcelain').split(/\n\n/).map((entry) => entry.split('\n').filter((line) => line.length > 0)).filter((entry) => entry.length > 0);

/** The worktrees of the base the run `runId` holds in git, by their lock reason. */
const baseTreesOf = (repo: string, runId: string): string[][] => worktrees(repo).filter((entry) => entry.includes(`locked ${baseLockReason(runId)}`));

/** The checkpoint of `box`, whose append of the run of lint on the base throws as a crash of the engine would, after build passed there and lint ran, before lint's record. */
const crashingOnBase = (box: ReviewSandbox): Checkpoint => appending(box.checkpoint, (events: readonly NewEvent[]) => {
  if (events.some((event) => event.kind === 'check.ran' && (event.payload as { phase: string; kind: string }).phase === 'base-checks' && (event.payload as { kind: string }).kind === 'lint')) throw new Error('the engine stopped');
});

/** Leave a worktree of the base of the run `runId` where the phase makes it, as an engine a kill stopped during the phase leaves it, since a throw removes its own; its entry in `git worktree list`. */
const leftByKill = (box: ReviewSandbox, runId: string): string[] => {
  const tree = makeBaseTree({ runId, worktree: box.repo, scratch: join(box.scratchRoot, checkpointScratchKey(box.checkpoint)), checkpointRoot: box.checkpoint.root, environment: process.env, log: () => {} }, box.run().scope!.base);
  assert.equal(tree.kind, 'made');
  const [left] = baseTreesOf(box.repo, runId);
  assert.ok(left !== undefined, 'the kill left the worktree of the base');
  return left;
};

describe('the checks on the base (R1, R11 of the facts before a merge)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('runs build and each kind that failed before the fixes and after them once in a worktree of the base, with no hook of the repository, and removes it', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    const marker = join(box.directory, 'hook-ran');
    write(box.repo, '.git/hooks/post-checkout', `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`);
    chmodSync(join(box.repo, '.git', 'hooks', 'post-checkout'), 0o755);
    reportText(await box.fix('claude'));
    const state = box.run();
    const fix = state.review!.fix!;
    assert.equal(state.review!.phases['base-checks'].status, 'completed');
    assert.deepEqual(fix.checks.runs['base-checks'].map((run) => [run.kind, run.outcome, run.replaces]), [['build', 'passed', null], ['lint', 'failed', null]], 'typecheck and test passed before the fixes, so only lint needs the base, after its build');
    const onBase = box.checkPlaces().filter((place) => !place.cwd.startsWith(box.repo));
    assert.deepEqual(onBase.map((place) => place.kind), ['build', 'lint']);
    assert.ok(onBase.every((place) => place.head === state.scope!.base && place.cwd.startsWith(join(box.scratchRoot, checkpointScratchKey(box.checkpoint), `${state.id}-base-`))), JSON.stringify(onBase));
    assert.equal(new Set(onBase.map((place) => place.cwd)).size, 1, 'the attempt made one worktree for both');
    const versions = box.checkpoint.ledger.events(state.id).filter((event) => event.payload.includes('"base-checks"')).map((event) => `${event.kind}@${String(event.version)}`);
    assert.deepEqual(versions, ['phase.started@7', 'worktree.checked@8', 'check.started@2', 'check.ran@4', 'check.started@2', 'check.ran@4', 'phase.finished@8', 'report.written@7'], 'the report\'s statistics hold the row of the phase');
    assert.equal(worktrees(box.repo).length, 1, 'the worktree of the base is gone after the phase');
    assert.deepEqual(readdirSync(join(box.scratchRoot, checkpointScratchKey(box.checkpoint))).filter((name) => name.startsWith(`${state.id}-base-`)), []);
    assert.equal(existsSync(marker), false, 'the post-checkout hook of the repository did not run');
    assert.equal(git(box.repo, 'log', '--format=%s', '-1'), 'the change under review');
  });

  it('runs no check on the base and makes no worktree when no kind failed before the fixes and after them', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: ['fail', 'pass'] });
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.equal(state.review!.phases['base-checks'].status, 'completed');
    assert.deepEqual(state.review!.fix!.checks.runs['base-checks'], []);
    assert.ok(!box.logs.some((line) => line.includes('worktree of the base')), box.logs.join('\n'));
  });

  it('records each due kind skipped, with the reason, when the base is the empty tree', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    // The change under review is a root commit, whose base is the empty tree.
    git(box.repo, 'checkout', '-q', '--orphan', 'root');
    commitAll(box.repo, 'the change under review');
    box.checks({ lint: 'fail' });
    reportText(await box.fix('claude'));
    const state = box.run();
    assert.deepEqual(state.review!.fix!.checks.runs['base-checks'].map((run) => [run.kind, run.outcome, run.error]), [['build', 'skipped', baseSkipReasons.emptyTree], ['lint', 'skipped', baseSkipReasons.emptyTree]]);
    assert.equal(box.checkPlaces().filter((place) => !place.cwd.startsWith(box.repo)).length, 0);
    assert.equal(worktrees(box.repo).length, 1);
  });

  it('records each due kind skipped, with the first line of git\'s error, when git cannot make the worktree, and goes on', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    // A file where git keeps the records of linked worktrees, so it can record none.
    writeFileSync(join(box.repo, '.git', 'worktrees'), '');
    box.checks({ lint: 'fail' });
    reportText(await box.fix('claude'));
    const runs = box.run().review!.fix!.checks.runs['base-checks'];
    assert.deepEqual(runs.map((run) => [run.kind, run.outcome]), [['build', 'skipped'], ['lint', 'skipped']]);
    for (const run of runs) assert.match(run.error ?? '', new RegExp(`^${baseSkipReasons.noWorktree}: \\S[^\\n]*$`));
    assert.equal(box.checkPlaces().filter((place) => !place.cwd.startsWith(box.repo)).length, 0);
  });

  it('keeps the repository variables of git and the paths into the reviewed worktree out of a check on the base, and every other entry in', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    const victim = repositoryWith(join(box.directory, 'victim'), { 'victim.txt': 'victim\n' });
    const inside = join(box.repo, 'node_modules', '.bin');
    const outside = join(box.directory, 'tools');
    const path = [inside, outside, process.env.PATH ?? ''].join(delimiter);
    reportText(await box.fix('claude', {}, { GIT_DIR: join(victim, '.git'), PATH: path, PYTHONPATH: [join(box.repo, 'src'), outside].join(delimiter) }));
    const places = box.checkPlaces();
    const onBase = places.filter((place) => !place.cwd.startsWith(box.repo));
    assert.equal(onBase.length, 2);
    for (const place of onBase) {
      assert.equal(place.environment.GIT_DIR, null);
      assert.equal(place.environment.PATH, [outside, process.env.PATH ?? ''].join(delimiter));
      assert.equal(place.environment.PYTHONPATH, outside);
    }
    assert.ok(places.filter((place) => place.cwd.startsWith(box.repo)).every((place) => place.environment.GIT_DIR === join(victim, '.git') && place.environment.PATH === path), 'the checks in the reviewed worktree keep the environment of the engine (#27)');
    const changed = box.logs.find((line) => line.startsWith('phase base-checks: its checks run without '))?.slice('phase base-checks: its checks run without '.length).split('; ');
    assert.deepEqual(changed?.sort(), ['GIT_DIR', `the entries of PATH inside the reviewed worktree: ${inside}`, `the entries of PYTHONPATH inside the reviewed worktree: ${join(box.repo, 'src')}`], 'the log names each variable the phase changed');
    assert.equal(worktrees(victim).length, 1, 'git made the worktree of the base in the reviewed repository');
  });

  it('removes the worktree it made when the command ends with a throw in the phase', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    await assert.rejects(box.fix('claude', { checkpoint: crashingOnBase(box) }), /the engine stopped/);
    const runId = box.run().id;
    assert.equal(box.checkPlaces().filter((place) => !place.cwd.startsWith(box.repo)).length, 2, 'build and lint ran in a worktree of the base before the throw');
    assert.deepEqual(baseTreesOf(box.repo, runId), []);
    assert.equal(worktrees(box.repo).length, 1);
    assert.deepEqual(readdirSync(join(box.scratchRoot, checkpointScratchKey(box.checkpoint))).filter((name) => name.startsWith(`${runId}-base-`)), []);
    assert.ok(box.logs.some((line) => line.startsWith('phase base-checks: removed the worktree of the base at ')), box.logs.join('\n'));
  });

  it('removes the worktree a crash left at the next command of the run, under another scratch directory, and touches no other worktree', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    await assert.rejects(box.fix('claude', { checkpoint: crashingOnBase(box) }), /the engine stopped/);
    const runId = box.run().id;
    const left = leftByKill(box, runId);
    // Worktrees of the person: one in place, and one on a disk that is not mounted.
    git(box.repo, 'worktree', 'add', '-q', '--detach', join(box.directory, 'person'), 'HEAD');
    git(box.repo, 'worktree', 'add', '-q', '--detach', join(box.directory, 'unmounted'), 'HEAD');
    rmSync(join(box.directory, 'unmounted'), { recursive: true, force: true });
    const others = worktrees(box.repo).filter((entry) => entry !== left && !entry.includes(`locked ${baseLockReason(runId)}`));
    reportText(await box.fix('claude', { scratchRoot: join(box.directory, 'another-scratch') }));
    assert.ok(box.logs.includes(`phase base-checks: removed the worktree of the base at ${left[0]!.slice('worktree '.length)}`), box.logs.join('\n'));
    assert.deepEqual(baseTreesOf(box.repo, runId), []);
    assert.deepEqual(worktrees(box.repo), others);
    const fix = box.run().review!.fix!;
    assert.deepEqual(fix.checks.runs['base-checks'].map((run) => [run.kind, run.attempt, run.outcome]), [['build', 1, 'passed'], ['build', 2, 'passed'], ['lint', 2, 'failed']], 'the new attempt builds its own worktree before lint');
  });

  it('removes the worktree a crash left when the run is abandoned', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    await assert.rejects(box.fix('claude', { checkpoint: crashingOnBase(box) }), /the engine stopped/);
    const runId = box.run().id;
    leftByKill(box, runId);
    assert.equal(baseTreesOf(box.repo, runId).length, 1);
    // Another run's worktree of the base, which the abandon of this run leaves.
    const other = makeBaseTree({ runId: 'another-run', worktree: box.repo, scratch: join(box.directory, 'other'), checkpointRoot: box.checkpoint.root, environment: process.env, log: () => {} }, box.run().scope!.base);
    assert.equal(other.kind, 'made');
    const errors: string[] = [];
    const status = await main(['abandon', '--reason', 'done with it', '--repo', box.repo], { stdout: () => {}, stderr: (text) => errors.push(text), environment: process.env, cwd: box.repo });
    assert.equal(status, 0, errors.join(''));
    assert.deepEqual(baseTreesOf(box.repo, runId), []);
    assert.equal(baseTreesOf(box.repo, 'another-run').length, 1);
    assert.match(errors.join(''), new RegExp(`^run ${runId}: removed the worktree of the base at `, 'm'));
  });

  it('blocks on an edit of the reviewed worktree after a stop during a run on the base, and writes nothing back', async (t) => {
    const box = ReviewSandbox.forTest(t, script);
    box.checks({ lint: 'fail' });
    await assert.rejects(box.fix('claude', { checkpoint: crashingOnBase(box) }), /the engine stopped/);
    const runId = box.run().id;
    leftByKill(box, runId);
    const edited = `${readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8')}// a person's edit\n`;
    writeFileSync(join(box.repo, 'src', 'a.ts'), edited);
    const outcome = await box.fix('claude');
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    assert.deepEqual(outcome.kind === 'blocked' ? [outcome.blocker.phase, outcome.blocker.code] : null, ['base-checks', 'drift']);
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), edited, 'the edit stays');
    assert.ok(!box.events(runId).some(([kind]) => kind === 'tree.restored'));
    assert.deepEqual(baseTreesOf(box.repo, runId), [], 'the attempt removed the worktree the stop left before it checked the tree');
  });

  it('makes no worktree of the base for a kind a reopened fix pass only records skipped after a build that failed there, and gives it that reason', async (t) => {
    const box = ReviewSandbox.forTest(t, budgetScript);
    box.editPolicy((policy) => ({ ...policy, fixes: { batchSize: 1 } }));
    // build fails on the base alone, its third run; typecheck fails before the fixes and again after the reopened batch, so the reopen adds it to the kinds the base takes.
    box.checks({ lint: 'fail', build: ['pass', 'pass', 'fail', 'pass'], typecheck: ['fail', 'pass', 'fail'] });
    reportText(await box.fix('claude', { flags: { budgetUsd: 1 } }));
    const stopped = box.run().review!.fix!.checks.runs['base-checks'];
    assert.deepEqual(stopped.map((run) => [run.kind, run.outcome, run.error]), [['build', 'failed', null], ['lint', 'skipped', baseSkipReasons.buildFailed]]);
    const placesBefore = box.checkPlaces().length;
    // Git can make no worktree from here on, so a checkout the reopened phase tried would give its reason in place of the build's.
    writeFileSync(join(box.repo, '.git', 'worktrees'), '');
    reportText(await box.fix('claude', { flags: { budgetUsd: 100 } }));
    const state = box.run();
    assert.equal(state.review!.fix!.reopenings.length, 1);
    const reopened = state.review!.fix!.checks.runs['base-checks'].filter((run) => run.attempt === state.review!.phases['base-checks'].attempt && run.attempt > 1);
    assert.deepEqual(reopened.map((run) => [run.kind, run.outcome, run.error]), [['typecheck', 'skipped', baseSkipReasons.buildFailed]], 'the build that failed on the base stays its result');
    assert.ok(box.checkPlaces().slice(placesBefore).every((place) => place.cwd.startsWith(box.repo)), 'no check ran on the base after the reopen');
    assert.ok(!box.logs.some((line) => line.includes('no worktree of the base could be made')), box.logs.join('\n'));
  });
});
