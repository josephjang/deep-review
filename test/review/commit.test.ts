import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import { UnreadableRunError } from '../../src/checkpoint/errors.ts';
import { commitRun } from '../../src/review/commit.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { freezeLimitBytes } from '../../src/scope/capture.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, type Finished, node } from '../helpers/launcher.ts';
import { git, write } from '../helpers/repository.ts';
import { afterFind, otherEngine, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure` });
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
const fixedB = 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n';

/** Two findings, one in src/a.ts and one in src/b.ts, each fixed by its cluster's fixer, which also adds a test to the first. */
const twoFixes: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads } },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'test/a.test.ts': 'test a\n' } }], output: fixerAnswer([{ files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
};

describe('deep-review commit', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  /** A fix run of `twoFixes` to its report, concurrency 1 so c1's revision is recorded first. */
  const fixRun = async (box: ReviewSandbox, script: Script = twoFixes): Promise<string> => {
    box.script(script);
    const outcome = await box.fix('claude', { flags: { concurrency: 1 } });
    assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
    return box.run().id;
  };
  /** A sandbox for the test `t` alone, holding a fix run of `script` to its report. */
  const fixedBox = async (t: TestContext, script?: Script): Promise<ReviewSandbox> => {
    const box = ReviewSandbox.forTest(t);
    await fixRun(box, script);
    return box;
  };
  const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && pattern.test(error.message);

  it('commits an unfinished attempt\'s edits with the message the retry gave on verifying them, its trailer saying so, and its leftovers under the engine\'s', async (t) => {
    const box = await fixedBox(t, {
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null')], leads: noLeads } },
      'fixer:fixes:c1-1': [
        // The first attempt snapshots its finding, writes a test after the snapshot, and dies.
        { edits: [{ writes: { 'src/a.ts': fixedA }, snapshot: 0 }, { writes: { 'test/a.test.ts': 'test a\n' } }], exit: 3 },
        { output: fixerAnswer([{ status: 'already-applied', files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
      ],
    });
    const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.deepEqual(outcome.commits.map((commit) => commit.subject), ['fix(a): Return 0 for a null text', 'chore: keep the partial edits of batch c1-1']);
    assert.match(git(box.repo, 'log', '-1', '--format=%B', outcome.commits[0]!.sha), /^fix\(a\): Return 0 for a null text\n\nWhy finding 0 changed\.\n\nDeep-review: run [0-9a-f-]+, SCAN-1 \(SCAN, PLAUSIBLE\), from an unfinished attempt of batch c1-1$/);
    assert.match(git(box.repo, 'log', '-1', '--format=%B', outcome.commits[1]!.sha), /\n\nDeep-review: run [0-9a-f-]+, partial edits of an unfinished attempt of batch c1-1$/);
    assert.deepEqual(git(box.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', outcome.commits[1]!.sha).split('\n'), ['test/a.test.ts']);
    assert.equal(git(box.repo, 'status', '--porcelain'), '');
  });

  it('commits the captured change first in worktree mode, from its frozen bytes, with the message given, and refuses without one', async (t) => {
    const box = ReviewSandbox.forTest(t);
    // An uncommitted change makes the review's scope the worktree.
    write(box.repo, 'src/c.ts', 'export const c = 1;\n');
    write(box.repo, 'src/a.ts', 'export function parse(text: string | null) {\n  return text!.length;\n}\n');
    await fixRun(box, {
      triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null')], leads: noLeads } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
    });
    assert.equal(box.run().scope!.mode, 'worktree');
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo }), refused(/give that commit's message with --change-message/));
    const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo, changeMessage: 'feat: Add c and accept a null text\n\nThe change under review.' });
    assert.deepEqual(outcome.commits.map((commit) => commit.subject), ['feat: Add c and accept a null text', 'fix(a): Return 0 for a null text']);
    // The change's commit holds the change as reviewed, and the fix's commit only the fix.
    assert.equal(git(box.repo, 'show', `${outcome.commits[0]!.sha}:src/a.ts`), 'export function parse(text: string | null) {\n  return text!.length;\n}');
    assert.equal(git(box.repo, 'show', `${outcome.commits[0]!.sha}:src/c.ts`), 'export const c = 1;');
    assert.deepEqual(git(box.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', outcome.commits[1]!.sha).split('\n'), ['src/a.ts']);
    assert.equal(git(box.repo, 'status', '--porcelain'), '');
    assert.equal(box.run().review!.fix!.commits!.commits[0]!.revision, 'change');
  });

  it('refuses a run without a report, one without the fix pass, and one that changed no file', async (t) => {
    const box = ReviewSandbox.forTest(t);
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('claude')).kind, 'blocked');
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId: box.run().id }), refused(/has no report yet/));
    box.checkpoint.append(box.run().id, box.run().lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'next case' } }]);
    box.script({});
    assert.equal((await box.review('claude')).kind, 'report');
    const readOnly = box.checkpoint.foldRuns().at(-1)!.id;
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId: readOnly }), refused(/ran without --fix/));
    // A fix run whose fixer found its finding already applied, and changed nothing.
    box.script({ ...twoFixes, 'fixer:fixes:c1-1': { output: fixerAnswer([{ status: 'already-applied', files: [] }]) }, 'fixer:fixes:c2-1': { output: fixerAnswer([{ status: 'already-applied', files: [] }]) } });
    assert.equal((await box.fix('claude')).kind, 'report');
    const unchanged = box.checkpoint.foldRuns().at(-1)!.id;
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId: unchanged }), refused(/changed no file, so there is nothing to commit/));
  });

  it('refuses a revised file too large to have been frozen, before any object is written', async (t) => {
    const big = 'x'.repeat(freezeLimitBytes + 1);
    const box = await fixedBox(t, {
      triage: { output: { candidates: [found('src/a.ts', 2, 'needs a big table')], leads: noLeads } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'src/table.txt': big } }], output: fixerAnswer([{ files: ['src/a.ts', 'src/table.txt'] }]) },
    });
    const objects = git(box.repo, 'count-objects');
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo }), refused(/src\/table\.txt is larger than the run freezes/));
    assert.equal(git(box.repo, 'count-objects'), objects, 'no object was written');
  });

  it('commits on a detached HEAD, moving HEAD itself', async (t) => {
    const box = ReviewSandbox.forTest(t);
    git(box.repo, 'checkout', '-q', '--detach');
    await fixRun(box);
    const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
    assert.equal(git(box.repo, 'rev-parse', 'HEAD'), outcome.commits.at(-1)!.sha);
    assert.equal(git(box.repo, 'rev-parse', 'main'), box.run().scope!.head, 'the branch HEAD left stays where it was');
  });


  // These start from the same run, which the engine refuses to commit from
  // any path but its own: they take turns in one sandbox, restored before each.
  describe('from one fix run of twoFixes', { concurrency: 1 }, () => {
    let box: ReviewSandbox;
    let runId: string;
    before(async () => {
      box = new ReviewSandbox();
      runId = await fixRun(box);
      box.keep();
    });
    beforeEach(() => {
      box.restore();
    });
    after(() => {
      box.close();
    });

    it('builds one commit per revision from the frozen bytes, moves the branch once, and leaves the tree clean, with no hook run', () => {
      const head = git(box.repo, 'rev-parse', 'HEAD');
      // A pre-commit hook that leaves a marker: a commit built with plumbing never runs it.
      const marker = join(box.directory, 'hook-ran');
      const hook = join(box.repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\n`);
      chmodSync(hook, 0o755);
      const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
      assert.equal(outcome.runId, runId);
      assert.deepEqual(outcome.commits.map((commit) => commit.subject), ['fix(a): Return 0 for a null text', 'fix(b): Import parse']);
      assert.equal(existsSync(marker), false, 'no hook ran');
      // The branch moved to the last commit, each commit touching exactly its revision's paths.
      assert.equal(git(box.repo, 'rev-parse', 'HEAD'), outcome.commits[1]!.sha);
      assert.equal(git(box.repo, 'rev-parse', 'HEAD~2'), head);
      assert.deepEqual(git(box.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', outcome.commits[0]!.sha).split('\n'), ['src/a.ts', 'test/a.test.ts']);
      assert.deepEqual(git(box.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', outcome.commits[1]!.sha).split('\n'), ['src/b.ts']);
      assert.equal(git(box.repo, 'status', '--porcelain'), '', 'the worktree and the index equal the last commit');
      assert.equal(git(box.repo, 'show', 'HEAD:src/b.ts'), fixedB.trimEnd());
      // Author and committer come from the user's configuration; the message carries the trailer.
      assert.equal(git(box.repo, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Test <test@example.invalid> / Test <test@example.invalid>');
      assert.match(git(box.repo, 'log', '-1', '--format=%B', outcome.commits[0]!.sha), /^fix\(a\): Return 0 for a null text\n\nWhy finding 0 changed\.\n\nDeep-review: run [0-9a-f-]+, SCAN-1 \(SCAN, PLAUSIBLE\)$/);
      const commits = box.run().review!.fix!.commits!;
      assert.deepEqual(commits.commits.map((commit) => [commit.sha, commit.revision]), [[outcome.commits[0]!.sha, 0], [outcome.commits[1]!.sha, 1]]);
      assert.equal(commits.from, head);
      assert.equal(commits.to, outcome.commits[1]!.sha);
      // A second invocation is refused by the ledger's record, naming the commits.
      assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId }), refused(/commits were already created/));
      assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo }), refused(/no completed fix run has changes left to commit/));
    });

    it('refuses --change-message for a run that reviewed a committed change', () => {
      assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, changeMessage: 'x' }), refused(/leave out --change-message/));
    });

    it('refuses when HEAD is not the head the run reviewed, and when a revised file changed after the run', () => {
      write(box.repo, 'src/b.ts', 'edited after the run\n');
      assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo }), refused(/no longer holds what run .* recorded at src\/b\.ts \(modified\)/));
      write(box.repo, 'src/b.ts', fixedB);
      git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'a commit after the run');
      assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo }), refused(/HEAD is [0-9a-f]+, not [0-9a-f]+, the head run .* reviewed/));
      assert.equal(box.run().review!.fix!.commits, null, 'nothing was recorded');
    });

    it('leaves the ref where it is when a commit lands while the commits are built, and the built commits unreferenced', () => {
      let landed = '';
      assert.throws(() => commitRun({
        checkpoint: box.checkpoint,
        worktree: box.repo,
        beforeMove: () => {
          git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'landed meanwhile');
          landed = git(box.repo, 'rev-parse', 'HEAD');
        },
      }), refused(/refs\/heads\/main moved while the commits were built, so it was left where it is/));
      assert.equal(git(box.repo, 'rev-parse', 'HEAD'), landed);
      assert.equal(box.run().review!.fix!.commits, null);
    });

    it('unstages a staged path no commit holds, naming it, and leaves its bytes in the tree', () => {
      write(box.repo, 'notes.txt', 'mine\n');
      git(box.repo, 'add', 'notes.txt');
      const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo });
      assert.deepEqual(outcome.unstaged, ['notes.txt']);
      assert.equal(git(box.repo, 'status', '--porcelain'), '?? notes.txt');
      assert.equal(readFileSync(join(box.repo, 'notes.txt'), 'utf8'), 'mine\n');
    });

    it('prints each commit and says no hook ran, exits 2 on a refusal, and 1 on a usage mistake', async () => {
      const environment = { ...baseEnvironment, HOME: box.home, USERPROFILE: box.home };
      const run = (...args: string[]): Promise<Finished> => node([cli, 'commit', ...args], { cwd: box.repo, env: environment });
      assert.equal((await run('--change-message', 'x')).status, 2);
      assert.match((await run('--json')).stderr, /--json does not apply to commit/);
      assert.equal((await run('--run', 'no-such-run')).status, 1);
      const made = await run();
      assert.equal(made.status, 0, made.stderr);
      assert.match(made.stdout, /^[0-9a-f]{12} fix\(a\): Return 0 for a null text\n[0-9a-f]{12} fix\(b\): Import parse\n$/);
      assert.match(made.stderr, /2 commits created; no commit hook ran/);
      assert.equal((await run()).status, 2, 'a second invocation is refused');
    });

    it('passes over a run this engine cannot read when it picks the run, commits the newest one it can, and refuses the unreadable run by name', () => {
      // Newer in the ledger than the fix run, so a choice of the newest run that ignored readability would take it.
      const unreadable = box.unreadableRun();
      const sequence = box.checkpoint.ledger.lastSequence(unreadable);
      const logs: string[] = [];
      const log = (line: string): void => {
        logs.push(line);
      };
      assert.throws(
        () => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId: unreadable, log }),
        (error: unknown) => error instanceof UnreadableRunError && error.runId === unreadable && error.unknown.engine === otherEngine && error.unknown.sequence === sequence,
      );
      assert.deepEqual(logs, [], 'a named run is refused, not passed over');
      const outcome = commitRun({ checkpoint: box.checkpoint, worktree: box.repo, log });
      assert.equal(outcome.runId, runId);
      assert.deepEqual(outcome.commits.map((commit) => commit.subject), ['fix(a): Return 0 for a null text', 'fix(b): Import parse']);
      assert.deepEqual(logs, [`run ${unreadable}: passed over: it holds phase.finished@99 at sequence ${String(sequence)}, written by engine ${otherEngine}, which this engine (0.0.0-test) does not declare; an engine that declares it, such as the one that wrote it, can read the run`]);
      assert.equal(box.checkpoint.ledger.lastSequence(unreadable), sequence, 'nothing was appended to the run passed over');
    });

    it('refuses the chosen run by name when another engine makes it unreadable before its lock is taken, and commits nothing', () => {
      const head = git(box.repo, 'rev-parse', 'HEAD');
      // The engine that wrote the run appends an event this one does not declare right after the choice, before the run lock.
      const late = afterFind(box.checkpoint, () => {
        box.addUnknownEvent(runId);
      });
      assert.throws(() => commitRun({ checkpoint: late.checkpoint, worktree: box.repo }), (error: unknown) => error instanceof UnreadableRunError && error.runId === runId && error.unknown.engine === otherEngine);
      assert.equal(late.acted(), true);
      assert.equal(git(box.repo, 'rev-parse', 'HEAD'), head, 'no commit was made');
    });
  });
});
