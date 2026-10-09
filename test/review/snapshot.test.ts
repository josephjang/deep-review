import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { sha256Hex } from '../../src/evidence/store.ts';
import { changedListed, prepareCheckManifest, prepareSnapshots, readManifest, readSnapshot, snapshotListingSchema, takeSnapshot } from '../../src/review/snapshot.ts';
import { trackedFiles } from '../../src/scope/git.ts';
import { InvalidScopeRequestError } from '../../src/scope/errors.ts';
import { baseEnvironment } from '../helpers/launcher.ts';
import { git, link, remove, repositoryWith, write } from '../helpers/repository.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');

describe('snapshots', () => {
  let directory: string;
  let repo: string;
  let into: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-snapshot-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/back.ts': 'back\n', '.gitignore': '*.log\n' });
    into = join(directory, 'scratch', 'snapshots');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const listingOf = (finding: number): ReturnType<typeof snapshotListingSchema.parse> => snapshotListingSchema.parse(JSON.parse(readFileSync(join(into, `${String(finding)}.json`), 'utf8')));

  /** Launch a worker: the engine's manifest of the tree as it is now, with the paths the run expects. */
  const launch = (expected: string[] = []): void => prepareSnapshots(into, repo, expected);

  it('copies a modified, a created and a deleted path since the launch, and lists the deleted one absent', () => {
    launch();
    write(repo, 'src/a.ts', 'fixed\n');
    write(repo, 'test/a.test.ts', 'test\n');
    remove(repo, 'src/b.ts');
    takeSnapshot({ worktree: repo, finding: 0, into });
    const listing = listingOf(0);
    assert.deepEqual(Object.keys(listing.paths).sort(), ['src/a.ts', 'src/b.ts', 'test/a.test.ts']);
    assert.deepEqual(listing.paths['src/a.ts'], { sha256: sha256Hex(Buffer.from('fixed\n')), size: 6, symlink: false });
    assert.equal(listing.paths['src/b.ts'], 'absent');
    assert.equal(readFileSync(join(into, '0', 'test', 'a.test.ts'), 'utf8'), 'test\n');
    const read = readSnapshot(into, 0)!;
    assert.deepEqual(read('src/a.ts'), { bytes: Buffer.from('fixed\n'), symlink: false });
    assert.equal(read('src/b.ts'), null, 'listed absent');
    assert.equal(read('src/back.ts'), undefined, 'not listed, so unknown');
  });

  it('walks past .git and what git ignored at launch, and lists a new file git would ignore for the engine to drop', () => {
    write(repo, '.gitignore', '*.log\nbuild/\n');
    write(repo, 'build/out.js', 'built\n');
    write(repo, 'old.log', 'old\n');
    launch();
    write(repo, 'build/out.js', 'rebuilt\n');
    write(repo, 'build/more.js', 'more\n');
    write(repo, 'old.log', 'old, longer\n');
    write(repo, 'new.log', 'new\n');
    takeSnapshot({ worktree: repo, finding: 0, into });
    assert.deepEqual(Object.keys(listingOf(0).paths), ['new.log'], 'nothing under build/ or in .git, nor the log ignored at launch');
  });

  it('lists what changed on disk since the launch, a line-ending rewrite under core.autocrlf included, which the engine compares as git would (R22, R23)', () => {
    // A clone with core.autocrlf checks out CRLF, as on the gate's Windows machine.
    const origin = repositoryWith(join(directory, 'origin'), { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n' });
    const crlfRepo = join(directory, 'crlf');
    git(directory, '-c', 'core.autocrlf=true', 'clone', '-q', origin, crlfRepo);
    git(crlfRepo, 'config', 'core.autocrlf', 'true');
    assert.equal(readFileSync(join(crlfRepo, 'src', 'a.ts'), 'utf8'), 'a\r\n');
    prepareSnapshots(into, crlfRepo, []);
    write(crlfRepo, 'src/a.ts', 'a\n');
    write(crlfRepo, 'src/b.ts', 'b changed\n');
    takeSnapshot({ worktree: crlfRepo, finding: 0, into });
    assert.deepEqual(Object.keys(listingOf(0).paths), ['src/a.ts', 'src/b.ts'], 'src/c.ts, untouched, is not listed');
  });

  it('copies every path the engine expects, so a path changed and changed back is still compared, and records the tree at launch', () => {
    launch(['src/back.ts', 'src/never.ts']);
    takeSnapshot({ worktree: repo, finding: 1, into });
    const listing = listingOf(1);
    assert.deepEqual(Object.keys(listing.paths), ['src/back.ts', 'src/never.ts']);
    assert.deepEqual(listing.paths['src/back.ts'], { sha256: sha256Hex(Buffer.from('back\n')), size: 5, symlink: false });
    assert.equal(listing.paths['src/never.ts'], 'absent');
    const manifest = readManifest(into)!;
    assert.equal(manifest.worktree, repo);
    assert.deepEqual(manifest.expected, ['src/back.ts', 'src/never.ts']);
    assert.deepEqual(Object.keys(manifest.files), ['.gitignore', 'src/a.ts', 'src/b.ts', 'src/back.ts']);
    assert.equal(manifest.files['src/a.ts']![0], 2);
  });

  it('lists nothing but the expected paths without a manifest, and refuses one that is not a manifest', () => {
    write(repo, 'src/a.ts', 'fixed\n');
    takeSnapshot({ worktree: repo, finding: 0, into });
    assert.deepEqual(listingOf(0).paths, {});
    writeFileSync(join(into, 'manifest.json'), '{"expected":[]}');
    assert.throws(() => takeSnapshot({ worktree: repo, finding: 0, into }), /is not a snapshot manifest/);
  });

  it('copies a symlink as its target text', (context) => {
    launch();
    if (!link(repo, 'pointer', 'src/a.ts')) {
      context.skip('this platform does not let the test create a symlink');
      return;
    }
    takeSnapshot({ worktree: repo, finding: 0, into });
    assert.deepEqual(readSnapshot(into, 0)!('pointer'), { bytes: Buffer.from('src/a.ts'), symlink: true });
  });

  it('replaces an earlier snapshot of the same index whole', () => {
    launch();
    write(repo, 'src/a.ts', 'first\n');
    write(repo, 'src/temp.ts', 'temp\n');
    takeSnapshot({ worktree: repo, finding: 2, into });
    write(repo, 'src/a.ts', 'second\n');
    remove(repo, 'src/temp.ts');
    takeSnapshot({ worktree: repo, finding: 2, into });
    assert.deepEqual(readSnapshot(into, 2)!('src/a.ts'), { bytes: Buffer.from('second\n'), symlink: false });
    assert.equal(readSnapshot(into, 2)!('src/temp.ts'), undefined, 'the first snapshot\'s listing is gone');
    assert.equal(existsSync(join(into, '2', 'src', 'temp.ts')), false, 'and so is its copy');
  });

  it('refuses a directory inside the worktree, so a snapshot can never be a stray', () => {
    assert.throws(() => takeSnapshot({ worktree: repo, finding: 0, into: join(repo, '.snapshots') }), InvalidScopeRequestError);
    assert.equal(existsSync(join(repo, '.snapshots')), false);
  });

  it('reads no snapshot for a finding with none, a listing that is not one, or a copy changed since', () => {
    assert.equal(readSnapshot(into, 0), null);
    launch();
    write(repo, 'src/a.ts', 'fixed\n');
    takeSnapshot({ worktree: repo, finding: 0, into });
    writeFileSync(join(into, '0', 'src', 'a.ts'), 'tampered\n');
    assert.equal(readSnapshot(into, 0)!('src/a.ts'), undefined, 'a copy that no longer has its listed hash is unknown');
    writeFileSync(join(into, '3.json'), '{"finding":4,"paths":{}}');
    assert.equal(readSnapshot(into, 3), null, 'a listing for another index');
    writeFileSync(join(into, '5.json'), 'not json');
    assert.equal(readSnapshot(into, 5), null);
  });

  it('never reads a listed path that would leave the snapshot directory', () => {
    takeSnapshot({ worktree: repo, finding: 0, into });
    writeFileSync(join(directory, 'scratch', 'outside.txt'), 'x');
    writeFileSync(join(into, '0.json'), JSON.stringify({ finding: 0, paths: { '../../outside.txt': { sha256: sha256Hex(Buffer.from('x')), size: 1, symlink: false } } }));
    assert.equal(readSnapshot(into, 0)!('../../outside.txt'), undefined);
  });

  describe('the manifest of a check that may write the tree (PD9 of commit series integrity)', () => {
    it('lists every tracked file and nothing git does not track, and writes itself outside the worktree', () => {
      write(repo, 'untracked.ts', 'u\n');
      write(repo, 'ignored.log', 'i\n');
      const checks = join(directory, 'scratch', 'run', 'checks', 'checks-build');
      const manifest = prepareCheckManifest(checks, repo);
      assert.deepEqual(Object.keys(manifest.files), ['.gitignore', 'src/a.ts', 'src/b.ts', 'src/back.ts']);
      assert.deepEqual(readManifest(checks), manifest);
      assert.deepEqual(trackedFiles(repo), ['.gitignore', 'src/a.ts', 'src/b.ts', 'src/back.ts']);
    });

    it('names a tracked file changed or deleted since, and neither a file new since nor one left alone', () => {
      write(repo, 'src/back.ts', 'changed before the check\n');
      const manifest = prepareCheckManifest(join(directory, 'scratch', 'check'), repo);
      write(repo, 'src/a.ts', 'rewritten by the check, longer\n');
      remove(repo, 'src/b.ts');
      write(repo, 'dist/new.js', 'new\n');
      assert.deepEqual(changedListed(manifest), ['src/a.ts', 'src/b.ts']);
    });
  });

  describe('deep-review snapshot', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'snapshot', ...args], { cwd: join(repo, 'src'), env: baseEnvironment, encoding: 'utf8' });

    it('takes the snapshot of the worktree the manifest names, wherever it runs, and says what it copied', () => {
      launch();
      write(repo, 'src/a.ts', 'fixed\n');
      const result = spawnSync(process.execPath, [cli, 'snapshot', '--finding', '0', '--into', into], { cwd: directory, env: baseEnvironment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `snapshot 0: 1 paths into ${into}\n`);
      assert.deepEqual(readSnapshot(into, 0)!('src/a.ts'), { bytes: Buffer.from('fixed\n'), symlink: false });
    });

    it('starts no process with a manifest, as in a sandbox that lets a worker\'s process start none (R23)', () => {
      launch();
      write(repo, 'src/a.ts', 'fixed\n');
      // Every way of starting a process throws, as Codex's Windows sandbox refuses them.
      const forbid = join(directory, 'forbid.mjs');
      writeFileSync(forbid, "import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nfor (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); };\nsyncBuiltinESMExports();\n");
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(forbid).href, cli, 'snapshot', '--finding', '0', '--into', into], { cwd: join(repo, 'src'), env: baseEnvironment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readSnapshot(into, 0)!('src/a.ts'), { bytes: Buffer.from('fixed\n'), symlink: false });
      // Without a manifest it asks git where the worktree is, which the same sandbox refuses.
      const bare = join(directory, 'bare-scratch');
      const refused = spawnSync(process.execPath, ['--import', pathToFileURL(forbid).href, cli, 'snapshot', '--finding', '0', '--into', bare], { cwd: join(repo, 'src'), env: baseEnvironment, encoding: 'utf8' });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /EPERM/);
    });

    it('asks git where the worktree is when there is no manifest, from a subdirectory too', () => {
      const result = run('--finding', '0', '--into', into);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `snapshot 0: 0 paths into ${into}\n`);
    });

    it('refuses a missing or malformed index, a missing directory and an unknown flag, with the usage', () => {
      for (const [args, message] of [
        [['--into', into], /--finding must be a finding's index/],
        [['--finding', '-1', '--into', into], /--finding must be a finding's index|argument missing|Option/],
        [['--finding', '1.5', '--into', into], /--finding must be a finding's index/],
        [['--finding', '01', '--into', into], /--finding must be a finding's index/],
        [['--finding', '0'], /--into <dir> is required/],
        [['--finding', '0', '--into', into, '--json'], /--json does not apply to snapshot/],
      ] as const) {
        const result = run(...args);
        assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
        assert.match(result.stderr, message, args.join(' '));
      }
    });

    it('refuses a directory inside the worktree', () => {
      const result = run('--finding', '0', '--into', join(repo, 'snap'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^InvalidScopeRequestError: The snapshot directory .* is inside the worktree/);
    });
  });
});
