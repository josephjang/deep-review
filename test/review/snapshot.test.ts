import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { sha256Hex } from '../../src/evidence/store.ts';
import { prepareSnapshots, readSnapshot, snapshotListingSchema, takeSnapshot } from '../../src/review/snapshot.ts';
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

  it('copies a modified, a created and a deleted path, lists the deleted one absent, and leaves out an ignored file', () => {
    write(repo, 'src/a.ts', 'fixed\n');
    write(repo, 'test/a.test.ts', 'test\n');
    remove(repo, 'src/b.ts');
    write(repo, 'debug.log', 'noise');
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

  it('copies what git sees changed, not every file a line-ending rewrite touched under core.autocrlf (R22)', () => {
    // A clone with core.autocrlf checks out CRLF, as on the first gate run's Windows machine.
    const origin = repositoryWith(join(directory, 'origin'), { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    const crlfRepo = join(directory, 'crlf');
    git(directory, '-c', 'core.autocrlf=true', 'clone', '-q', origin, crlfRepo);
    git(crlfRepo, 'config', 'core.autocrlf', 'true');
    assert.equal(readFileSync(join(crlfRepo, 'src', 'a.ts'), 'utf8'), 'a\r\n');
    // A formatter rewrites the checkout to LF: git status lists the file, git diff does not.
    write(crlfRepo, 'src/a.ts', 'a\n');
    write(crlfRepo, 'src/b.ts', 'b changed\n');
    assert.match(git(crlfRepo, 'status', '--porcelain'), /^ ?M src\/a\.ts$/m, 'the case git status gets wrong');
    takeSnapshot({ worktree: crlfRepo, finding: 0, into });
    assert.deepEqual(Object.keys(listingOf(0).paths), ['src/b.ts'], 'only the file whose content changed');
  });

  it('copies every path the engine listed, so a path changed and changed back is still compared', () => {
    prepareSnapshots(into, ['src/back.ts', 'src/never.ts']);
    takeSnapshot({ worktree: repo, finding: 1, into });
    const listing = listingOf(1);
    assert.deepEqual(listing.paths['src/back.ts'], { sha256: sha256Hex(Buffer.from('back\n')), size: 5, symlink: false });
    assert.equal(listing.paths['src/never.ts'], 'absent');
    assert.deepEqual(JSON.parse(readFileSync(join(into, 'paths.json'), 'utf8')), ['src/back.ts', 'src/never.ts']);
  });

  it('copies a symlink as its target text', (context) => {
    if (!link(repo, 'pointer', 'src/a.ts')) {
      context.skip('this platform does not let the test create a symlink');
      return;
    }
    takeSnapshot({ worktree: repo, finding: 0, into });
    assert.deepEqual(readSnapshot(into, 0)!('pointer'), { bytes: Buffer.from('src/a.ts'), symlink: true });
  });

  it('replaces an earlier snapshot of the same index whole', () => {
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

  describe('deep-review snapshot', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'snapshot', ...args], { cwd: join(repo, 'src'), env: baseEnvironment, encoding: 'utf8' });

    it('takes the snapshot of the worktree it runs in, from a subdirectory too, and says what it copied', () => {
      write(repo, 'src/a.ts', 'fixed\n');
      const result = run('--finding', '0', '--into', into);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `snapshot 0: 1 paths into ${into}\n`);
      assert.deepEqual(readSnapshot(into, 0)!('src/a.ts'), { bytes: Buffer.from('fixed\n'), symlink: false });
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
