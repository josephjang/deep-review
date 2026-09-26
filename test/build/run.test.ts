import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { artifactTargets, type ArtifactTarget } from '../../src/build/artifacts.ts';
import { formatOutcome, runBuild } from '../../src/build/run.ts';

const write = (root: string, path: string, content: string): void => {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
};

const targets: readonly ArtifactTarget[] = [
  { name: 'alpha', source: 'skill/alpha', destination: 'dist/alpha' },
  { name: 'beta', source: 'skill/beta', destination: 'dist/beta' },
];

/** A repository whose sources and dist/ agree, as after a committed build. */
const seedMatchingRepository = (repository: string): void => {
  write(repository, 'skill/alpha/SKILL.md', 'alpha\r\n');
  write(repository, 'skill/alpha/agents/openai.yaml', 'interface: {}\n');
  write(repository, 'skill/beta/SKILL.md', 'beta\n');
  write(repository, 'dist/alpha/SKILL.md', 'alpha\r\n');
  write(repository, 'dist/alpha/agents/openai.yaml', 'interface: {}\n');
  write(repository, 'dist/beta/SKILL.md', 'beta\n');
};

describe('runBuild', () => {
  let repository: string;
  let stagingParent: string;
  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), 'deep-review-run-'));
    stagingParent = join(repository, '.staging');
    mkdirSync(stagingParent);
  });
  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  it('verifies a matching dist/ without touching it', () => {
    seedMatchingRepository(repository);
    const outcome = runBuild({ repositoryRoot: repository, verify: true, targets, stagingParent });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.outcomes.map((o) => [o.target.name, o.files, o.differences, o.published]), [
      ['alpha', 2, [], false],
      ['beta', 1, [], false],
    ]);
  });

  it('reports every kind of difference per target and fails verification', () => {
    seedMatchingRepository(repository);
    write(repository, 'skill/alpha/SKILL.md', 'alpha changed\n');
    write(repository, 'skill/beta/new.md', 'new');
    write(repository, 'dist/beta/stale.md', 'stale');
    const outcome = runBuild({ repositoryRoot: repository, verify: true, targets, stagingParent });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.outcomes[0]?.differences, [{ path: 'SKILL.md', kind: 'changed' }]);
    assert.deepEqual(outcome.outcomes[1]?.differences, [
      { path: 'new.md', kind: 'missing' },
      { path: 'stale.md', kind: 'extra' },
    ]);
    assert.equal(readFileSync(join(repository, 'dist/alpha/SKILL.md'), 'utf8'), 'alpha\r\n', 'verify never writes');
    assert.equal(existsSync(join(repository, 'dist/beta/stale.md')), true, 'verify never deletes');
  });

  it('treats an absent dist/ as every file missing', () => {
    seedMatchingRepository(repository);
    rmSync(join(repository, 'dist'), { recursive: true });
    const outcome = runBuild({ repositoryRoot: repository, verify: true, targets, stagingParent });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.outcomes.map((o) => o.differences.map((d) => d.kind)), [['missing', 'missing'], ['missing']]);
  });

  it('build mode replaces dist/ so that a following verify passes', () => {
    seedMatchingRepository(repository);
    write(repository, 'skill/alpha/SKILL.md', 'alpha changed\n');
    write(repository, 'dist/beta/stale.md', 'stale');
    const built = runBuild({ repositoryRoot: repository, verify: false, targets, stagingParent });
    assert.equal(built.ok, true);
    assert.deepEqual(built.outcomes.map((o) => [o.published, o.differences.length]), [[true, 1], [true, 1]]);
    assert.equal(readFileSync(join(repository, 'dist/alpha/SKILL.md'), 'utf8'), 'alpha changed\n');
    assert.equal(existsSync(join(repository, 'dist/beta/stale.md')), false);
    assert.equal(runBuild({ repositoryRoot: repository, verify: true, targets, stagingParent }).ok, true);
  });

  it('build mode on an already current dist/ reports it unchanged', () => {
    seedMatchingRepository(repository);
    const built = runBuild({ repositoryRoot: repository, verify: false, targets, stagingParent });
    assert.equal(built.ok, true);
    assert.deepEqual(built.outcomes.map((o) => o.differences), [[], []]);
  });

  it('removes its staging directory even when a target cannot be assembled', () => {
    write(repository, 'skill/alpha/SKILL.md', 'alpha');
    assert.throws(() => runBuild({ repositoryRoot: repository, verify: true, targets, stagingParent }), /source does not exist/);
    assert.deepEqual(readdirSync(stagingParent), []);
  });

  it('publishes nothing when a later target cannot be assembled', () => {
    seedMatchingRepository(repository);
    write(repository, 'skill/alpha/SKILL.md', 'alpha changed\n');
    rmSync(join(repository, 'skill/beta'), { recursive: true });
    assert.throws(() => runBuild({ repositoryRoot: repository, verify: false, targets, stagingParent }), /source does not exist/);
    assert.equal(readFileSync(join(repository, 'dist/alpha/SKILL.md'), 'utf8'), 'alpha\r\n', 'alpha was assembled but must not be published');
    assert.deepEqual(readdirSync(stagingParent), []);
  });

  it('defaults to the repository targets', () => {
    for (const target of artifactTargets) write(repository, `${target.source}/SKILL.md`, target.name);
    const outcome = runBuild({ repositoryRoot: repository, verify: false, stagingParent });
    assert.deepEqual(outcome.outcomes.map((o) => o.target), artifactTargets);
    for (const target of artifactTargets) assert.equal(readFileSync(join(repository, target.destination, 'SKILL.md'), 'utf8'), target.name);
  });
});

describe('formatOutcome', () => {
  const alpha = targets[0]!;

  it('prints a match line per target in verify mode', () => {
    const text = formatOutcome({ ok: true, outcomes: [{ target: alpha, files: 1, differences: [], published: false }] });
    assert.equal(text, 'alpha: 1 file, matches dist/alpha');
  });

  it('prints each difference under its target and a closing instruction', () => {
    const text = formatOutcome({
      ok: false,
      outcomes: [{ target: alpha, files: 2, differences: [{ path: 'a.md', kind: 'changed' }, { path: 'b/c.md', kind: 'missing' }], published: false }],
    });
    assert.equal(text, [
      'alpha: 2 files, differs from dist/alpha',
      '  changed a.md',
      '  missing b/c.md',
      'dist/ is out of date: run `npm run build` and commit the result',
    ].join('\n'));
  });

  it('says what build mode wrote, and when nothing changed', () => {
    assert.equal(formatOutcome({ ok: true, outcomes: [{ target: alpha, files: 0, differences: [], published: true }] }), 'alpha: 0 files, dist/alpha unchanged');
    assert.equal(
      formatOutcome({ ok: true, outcomes: [{ target: alpha, files: 3, differences: [{ path: 'x', kind: 'extra' }], published: true }] }),
      'alpha: 3 files, wrote dist/alpha (1 changed)\n  extra   x',
    );
  });
});

describe('scripts/build.ts', () => {
  const script = resolve(import.meta.dirname, '../../scripts/build.ts');
  let repository: string;
  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), 'deep-review-cli-'));
    for (const target of artifactTargets) write(repository, `${target.source}/SKILL.md`, target.name);
  });
  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  const run = (...args: string[]) => spawnSync(process.execPath, [script, '--root', repository, ...args], { encoding: 'utf8' });

  it('exits 1 from --verify when dist/ is missing and 0 once it is built', () => {
    const failed = run('--verify');
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /claude: 1 file, differs from dist\/claude/);
    assert.match(failed.stdout, /missing SKILL\.md/);
    const built = run();
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /wrote dist\/claude/);
    const verified = run('--verify');
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /codex: 1 file, matches dist\/codex/);
  });

  it('rejects an unknown flag', () => {
    const result = run('--bogus');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bogus/);
  });
});
