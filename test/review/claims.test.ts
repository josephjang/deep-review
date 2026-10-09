import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { caseInsensitiveFileSystem, claimFile, ClaimRequestError, claimsDirectoryFor, ClaimsDirectoryLostError, heldFileName, markerHash, markerName, normalizeClaimPath, prepareClaims, readClaims, readHeld, type Held } from '../../src/review/claims.ts';
import { InvalidScopeRequestError } from '../../src/scope/errors.ts';
import { baseEnvironment } from '../helpers/launcher.ts';
import { repositoryWith } from '../helpers/repository.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');

describe('claims', () => {
  let directory: string;
  let repo: string;
  let dir: string;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-claims-')));
    repo = repositoryWith(join(directory, 'repo'), { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'test/shared.test.ts': 'shared\n' });
    dir = claimsDirectoryFor(join(directory, 'scratch'), 'run-1', 1);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  /** The round of two clusters, c1 owning src/a.ts and c2 src/b.ts, with one batch each and a second batch of c1. */
  const round = (overrides: Partial<Held> = {}): Held => ({
    worktree: repo,
    clusters: { c1: ['src/a.ts'], c2: ['src/b.ts'] },
    units: { 'c1-1': 'c1', 'c1-2': 'c1', 'c2-1': 'c2', 'c3-1': 'c3' },
    settled: [],
    caseInsensitive: false,
    ...overrides,
  });
  const prepare = (overrides: Partial<Held> = {}, recorded: Parameters<typeof prepareClaims>[2] = []): void => prepareClaims(dir, round(overrides), recorded, false);
  const markerFiles = (): string[] => readdirSync(dir).filter((name) => name !== heldFileName).sort();
  const at = (iso: string) => (): Date => new Date(iso);

  it('names the directory per checkpoint scratch, run and round', () => {
    assert.equal(claimsDirectoryFor('/s/key', 'run-1', 1), join('/s/key', 'claims', 'run-1', 'round-1'));
    assert.equal(claimsDirectoryFor('/s/key', 'run-1', 2), join('/s/key', 'claims', 'run-1', 'round-2'));
    assert.notEqual(claimsDirectoryFor('/s/key', 'run-2', 1), claimsDirectoryFor('/s/key', 'run-1', 1));
  });

  describe('prepareClaims', () => {
    it('writes held.json afresh at every launch, so the command learns which holders have settled', () => {
      prepare();
      assert.deepEqual(readHeld(dir), round());
      prepare({ settled: ['c2'] });
      assert.deepEqual(readHeld(dir).settled, ['c2']);
      assert.deepEqual(markerFiles(), [], 'no claim, no marker');
    });

    it('seeds each recorded claim once, in ledger order, and removes no marker', () => {
      const recorded = [
        { path: 'docs/a.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:00.000Z' },
        { path: 'docs/a.md', cluster: 'c2', unit: 'c2-1', claimedAt: '2026-10-09T02:00:00.000Z' },
        { path: 'docs/late.md', cluster: 'c1', unit: 'c1-1', claimedAt: null },
      ];
      prepare({}, recorded);
      writeFileSync(join(dir, `${'f'.repeat(64)}.1.json`), '{"path":"x","cluster":"c9","unit":"c9-1","claimedAt":null}\n');
      const first = readClaims(dir);
      prepare({}, recorded);
      assert.deepEqual(readClaims(dir), first, 'a second launch seeds nothing more and keeps every marker');
      const docs = first.filter((claim) => claim.hash === markerHash('docs/a.md', false));
      assert.deepEqual(docs.map((claim) => (claim.whole ? [claim.generation, claim.cluster] : null)), [[1, 'c1'], [2, 'c2']], 'the latest recorded claim is the holder');
      const late = first.find((claim) => claim.hash === markerHash('docs/late.md', false))!;
      assert.equal(late.whole && late.claimedAt, null, 'a late claim is seeded with no time');
      assert.ok(existsSync(join(dir, `${'f'.repeat(64)}.1.json`)));
    });

    it('seeds a recorded claim above a marker that records another claim of the path', () => {
      prepare();
      assert.equal(claimFile(dir, 'docs/a.md', 'c1-1', at('2026-10-09T01:00:00.000Z')).kind, 'claimed');
      prepare({ settled: ['c1'] }, [{ path: 'docs/a.md', cluster: 'c2', unit: 'c2-1', claimedAt: null }]);
      const claims = readClaims(dir);
      assert.deepEqual(claims.map((claim) => claim.generation), [1, 2]);
      const seeded = claims[1]!;
      assert.equal(seeded.whole && seeded.cluster, 'c2');
    });

    it('refuses a directory it prepared before and that is gone, creating nothing (R12)', () => {
      prepare();
      rmSync(dir, { recursive: true });
      assert.throws(() => prepareClaims(dir, round(), [], true), (error: unknown) => error instanceof ClaimsDirectoryLostError && error.directory === dir && /is gone: stop editing and answer/.test(error.message));
      assert.equal(existsSync(dir), false);
      prepareClaims(dir, round(), [], false);
      assert.ok(existsSync(join(dir, heldFileName)), 'a first launch, or a resumed engine, creates it');
    });
  });

  describe('claimFile', () => {
    beforeEach(() => prepare());

    it('answers owned for a file of the unit\'s own cluster and refuses one another cluster owns, naming it (R2, F14)', () => {
      assert.deepEqual(claimFile(dir, 'src/a.ts', 'c1-2'), { kind: 'owned', path: 'src/a.ts', cluster: 'c1' });
      assert.deepEqual(claimFile(dir, 'src/b.ts', 'c1-1'), { kind: 'refused', path: 'src/b.ts', holder: 'c2', by: 'plan' });
      assert.deepEqual(markerFiles(), [], 'neither makes a marker');
    });

    it('creates a marker once, answers claimed to the same cluster\'s later batch, and refuses another cluster naming the holder', () => {
      assert.deepEqual(claimFile(dir, 'test/shared.test.ts', 'c1-1', at('2026-10-09T01:00:00.000Z')), { kind: 'claimed', path: 'test/shared.test.ts', cluster: 'c1', generation: 1, created: true });
      assert.deepEqual(markerFiles(), [markerName('test/shared.test.ts', 1, false)]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, markerName('test/shared.test.ts', 1, false)), 'utf8')), { path: 'test/shared.test.ts', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:00.000Z' });
      assert.deepEqual(claimFile(dir, 'test/shared.test.ts', 'c1-2'), { kind: 'claimed', path: 'test/shared.test.ts', cluster: 'c1', generation: 1, created: false });
      assert.deepEqual(claimFile(dir, 'test/shared.test.ts', 'c2-1'), { kind: 'refused', path: 'test/shared.test.ts', holder: 'c1', by: 'claim' });
      assert.deepEqual(claimFile(dir, 'test/new.test.ts', 'c3-1').kind, 'claimed', 'a new file, with a cluster that owns nothing');
      assert.equal(markerFiles().length, 2);
    });

    it('lets the next cluster claim a file whose holder has settled, as the next generation (PD3)', () => {
      claimFile(dir, 'test/shared.test.ts', 'c1-1');
      prepare({ settled: ['c1'] });
      assert.deepEqual(claimFile(dir, 'test/shared.test.ts', 'c2-1', at('2026-10-09T02:00:00.000Z')), { kind: 'claimed', path: 'test/shared.test.ts', cluster: 'c2', generation: 2, created: true });
      assert.deepEqual(claimFile(dir, 'test/shared.test.ts', 'c3-1'), { kind: 'refused', path: 'test/shared.test.ts', holder: 'c2', by: 'claim' }, 'the new holder has not settled');
      assert.deepEqual(readClaims(dir).map((claim) => claim.generation), [1, 2], 'the settled holder\'s marker stays');
    });

    it('normalizes slashes and dot segments, so a Windows spelling makes the plan\'s marker (TD4)', () => {
      assert.equal(claimFile(dir, 'src\\a.ts', 'c1-1').kind, 'owned');
      assert.equal(claimFile(dir, '.\\test\\shared.test.ts', 'c1-1').kind, 'claimed');
      assert.deepEqual(claimFile(dir, 'test/./shared.test.ts', 'c2-1'), { kind: 'refused', path: 'test/shared.test.ts', holder: 'c1', by: 'claim' });
      assert.equal(markerFiles().length, 1);
    });

    it('meets one marker for two spellings that differ in case when the file system folds case, and two when it does not (TD4)', () => {
      assert.equal(claimFile(dir, 'Docs/Notes.md', 'c1-1').kind, 'claimed');
      assert.equal(claimFile(dir, 'docs/notes.md', 'c2-1').kind, 'claimed', 'a case-sensitive file system holds two files');
      assert.equal(claimFile(dir, 'SRC/A.ts', 'c2-1').kind, 'claimed', 'and SRC/A.ts is not src/a.ts');
      rmSync(dir, { recursive: true });
      prepare({ caseInsensitive: true });
      assert.equal(claimFile(dir, 'Docs/Notes.md', 'c1-1').kind, 'claimed');
      assert.deepEqual(claimFile(dir, 'docs/notes.md', 'c2-1'), { kind: 'refused', path: 'docs/notes.md', holder: 'c1', by: 'claim' });
      assert.deepEqual(claimFile(dir, 'SRC/A.ts', 'c2-1'), { kind: 'refused', path: 'SRC/A.ts', holder: 'c1', by: 'plan' });
      assert.deepEqual(markerFiles(), [markerName('docs/notes.md', 1, true)]);
      assert.equal(markerName('Docs/Notes.md', 1, true), markerName('docs/notes.md', 1, true));
    });

    it('refuses a path outside the repository, under .git, absolute or empty, with the reason', () => {
      for (const path of ['../outside.ts', 'src/../../x', '.git/config', 'src/.GIT/x', '/etc/passwd', 'C:/x.ts', 'c:\\x.ts', '', '.', 'src//a.ts', 'src/']) {
        assert.throws(() => claimFile(dir, path, 'c1-1'), InvalidScopeRequestError, JSON.stringify(path));
      }
      assert.deepEqual(markerFiles(), []);
      assert.equal(normalizeClaimPath('./src/./a.ts'), 'src/a.ts');
    });

    it('refuses a unit the round lacks, one whose cluster has settled, and a directory inside the worktree', () => {
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c9-1'), (error: unknown) => error instanceof ClaimRequestError && /unit c9-1 is no batch of this round/.test(error.message));
      prepare({ settled: ['c1'] });
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c1-2'), (error: unknown) => error instanceof ClaimRequestError && /cluster c1 has settled, so it claims nothing more/.test(error.message));
      assert.deepEqual(markerFiles(), []);
      const inside = join(repo, '.claims');
      prepareClaims(inside, round(), [], false);
      assert.throws(() => claimFile(inside, 'docs/a.md', 'c1-1'), InvalidScopeRequestError);
    });

    it('refuses a path whose latest marker is not whole yet as held by a worker not yet known, and reads that marker as not whole (F13)', () => {
      writeFileSync(join(dir, markerName('docs/empty.md', 1, false)), '');
      writeFileSync(join(dir, markerName('docs/half.md', 1, false)), '{"path":"docs/half.md","clus');
      assert.deepEqual(claimFile(dir, 'docs/empty.md', 'c1-1'), { kind: 'held-by-unknown', path: 'docs/empty.md' });
      assert.deepEqual(claimFile(dir, 'docs/half.md', 'c1-1'), { kind: 'held-by-unknown', path: 'docs/half.md' });
      prepare({ settled: ['c1', 'c2'] });
      assert.equal(claimFile(dir, 'docs/half.md', 'c3-1').kind, 'held-by-unknown', 'whoever writes it has not settled as far as anyone knows');
      assert.deepEqual(readClaims(dir).map((claim) => [claim.whole, claim.generation]), [[false, 1], [false, 1]]);
    });

    it('throws ClaimsDirectoryLostError for a directory or held.json that is gone, and so does readClaims (R12)', () => {
      rmSync(join(dir, heldFileName));
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c1-1'), ClaimsDirectoryLostError);
      rmSync(dir, { recursive: true });
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c1-1'), ClaimsDirectoryLostError);
      assert.throws(() => readClaims(dir), ClaimsDirectoryLostError);
      assert.equal(existsSync(dir), false, 'nothing recreates it');
    });

    it('refuses a held.json that is not the round\'s description', () => {
      writeFileSync(join(dir, heldFileName), '{"worktree":1}');
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c1-1'), ClaimRequestError);
      writeFileSync(join(dir, heldFileName), 'not json');
      assert.throws(() => claimFile(dir, 'docs/a.md', 'c1-1'), ClaimRequestError);
    });
  });

  it('reads every marker by hash and generation, leaving out files that are not markers', () => {
    prepare();
    claimFile(dir, 'docs/a.md', 'c1-1', at('2026-10-09T01:00:00.000Z'));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, `${'a'.repeat(64)}.0.json`), 'x');
    assert.deepEqual(readClaims(dir), [{ whole: true, hash: markerHash('docs/a.md', false), generation: 1, path: 'docs/a.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:00.000Z' }]);
  });

  it('tells whether the worktree\'s file system folds case, as the file system itself answers', () => {
    writeFileSync(join(directory, 'Probe.txt'), 'x');
    assert.equal(caseInsensitiveFileSystem(repo), existsSync(join(directory, 'pROBE.TXT')));
    const uncased = join(directory, '1234');
    mkdirSync(join(uncased, 'Sub'), { recursive: true });
    assert.equal(caseInsensitiveFileSystem(uncased), existsSync(join(directory, 'pROBE.TXT')), 'a root with no cased letter is probed through an entry under it');
  });

  describe('deep-review claim', () => {
    const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'claim', ...args], { cwd, env: baseEnvironment, encoding: 'utf8' });
    const claimArgs = (path: string, unit: string): string[] => ['--path', path, '--unit', unit, '--in', dir];
    beforeEach(() => prepare());

    it('exits 0 for an owned or claimed file and 2 naming the holder for a refusal', () => {
      const owned = run(repo, ...claimArgs('src/a.ts', 'c1-1'));
      assert.equal(owned.status, 0, owned.stderr);
      assert.equal(owned.stdout, 'claim src/a.ts: owned by your cluster c1\n');
      const claimed = run(repo, ...claimArgs('test/shared.test.ts', 'c1-1'));
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.equal(claimed.stdout, 'claim test/shared.test.ts: claimed for your cluster c1\n');
      assert.equal(run(repo, ...claimArgs('test/shared.test.ts', 'c1-2')).stdout, 'claim test/shared.test.ts: already held by your cluster c1\n');
      const refused = run(repo, ...claimArgs('test/shared.test.ts', 'c2-1'));
      assert.equal(refused.status, 2);
      assert.equal(refused.stderr, 'claim refused: test/shared.test.ts is held by cluster c1\n');
      const owner = run(repo, ...claimArgs('src/b.ts', 'c1-1'));
      assert.equal(owner.status, 2);
      assert.equal(owner.stderr, 'claim refused: src/b.ts is owned by cluster c2\n');
      writeFileSync(join(dir, markerName('docs/half.md', 1, false)), '');
      const unknown = run(repo, ...claimArgs('docs/half.md', 'c1-1'));
      assert.equal(unknown.status, 2);
      assert.equal(unknown.stderr, 'claim refused: docs/half.md is being claimed by another worker\n');
    });

    it('gives one marker and one refusal to two processes claiming one path at once, before and after its holder settles', async () => {
      const race = async (units: readonly string[]): Promise<number[]> => {
        const exits = units.map((unit) => new Promise<number>((settle, reject) => {
          const child = spawn(process.execPath, [cli, 'claim', ...claimArgs('docs/race.md', unit)], { cwd: repo, env: baseEnvironment, stdio: 'ignore' });
          child.on('error', reject);
          child.on('exit', (code) => settle(code ?? -1));
        }));
        return (await Promise.all(exits)).sort();
      };
      assert.deepEqual(await race(['c1-1', 'c2-1']), [0, 2]);
      assert.deepEqual(readClaims(dir).map((claim) => claim.generation), [1]);
      const holder = readClaims(dir)[0]!;
      assert.ok(holder.whole);
      prepare({ settled: [holder.cluster] });
      // The holder settled, so the cluster it refused and c3 both aim at generation 2.
      assert.deepEqual(await race([holder.cluster === 'c1' ? 'c2-1' : 'c1-1', 'c3-1']), [0, 2]);
      assert.deepEqual(readClaims(dir).map((claim) => claim.generation), [1, 2]);
    });

    it('exits 1 with the words to stop editing when the directory is gone (R12)', () => {
      rmSync(dir, { recursive: true });
      const result = run(repo, ...claimArgs('docs/a.md', 'c1-1'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^ClaimsDirectoryLostError: the claims directory .* is gone: stop editing and answer\n$/);
    });

    it('exits 1 for a path outside the repository, a unit the round lacks and a run from a subdirectory of the worktree', () => {
      const outside = run(repo, ...claimArgs('../x.ts', 'c1-1'));
      assert.equal(outside.status, 1);
      assert.match(outside.stderr, /^InvalidScopeRequestError: .*must not leave the repository/);
      const unknown = run(repo, ...claimArgs('docs/a.md', 'c9-1'));
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /^ClaimRequestError: unit c9-1 is no batch of this round/);
      const nested = run(join(repo, 'src'), ...claimArgs('a.ts', 'c1-1'));
      assert.equal(nested.status, 1);
      assert.match(nested.stderr, /run the claim command from the repository root/);
      assert.deepEqual(markerFiles(), []);
      assert.equal(run(directory, ...claimArgs('docs/a.md', 'c1-1')).status, 0, 'outside the worktree the path is still the repository\'s');
    });

    it('refuses missing, repeated and foreign flags with the usage', () => {
      for (const [args, message] of [
        [['--unit', 'c1-1', '--in', dir], /--path <path> is required, once/],
        [['--path', 'a', '--path', 'b', '--unit', 'c1-1', '--in', dir], /--path <path> is required, once/],
        [['--path', 'a', '--in', dir], /--unit <key> is required/],
        [['--path', 'a', '--unit', 'c1-1'], /--in <dir> is required/],
        [[...claimArgs('a', 'c1-1'), '--repo', repo], /--repo does not apply to claim/],
        [[...claimArgs('a', 'c1-1'), '--into', dir], /--into does not apply to claim/],
      ] as const) {
        const result = run(repo, ...args);
        assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
        assert.match(result.stderr, message, args.join(' '));
        assert.match(result.stderr, /usage:/);
      }
    });

    it('starts no process, as in a sandbox that lets a worker\'s process start none (R2)', () => {
      const forbid = join(directory, 'forbid.mjs');
      writeFileSync(forbid, "import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nfor (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); };\nsyncBuiltinESMExports();\n");
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(forbid).href, cli, 'claim', ...claimArgs('docs/a.md', 'c1-1')], { cwd: repo, env: baseEnvironment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readClaims(dir).length, 1);
    });
  });
});
