import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { baseEnvironment, baseLockReason, makeBaseTree, removeBaseTrees, type BaseTreeContext } from '../../../src/review/checks/base.ts';
import { baseSkipReasons } from '../../../src/review/vocabulary.ts';
import { commitAll, createRepository, git, repositoryWith, temporaryDirectory, write } from '../../helpers/repository.ts';

/** A repository whose base commit holds `base.txt` and whose head adds `head.txt`, with the scratch directory of a run beside it. */
function sandbox(t: TestContext): { readonly directory: string; readonly repo: string; readonly base: string; readonly head: string; readonly context: (change?: Partial<BaseTreeContext>) => BaseTreeContext; readonly logs: string[] } {
  const directory = temporaryDirectory(t, 'deep-review-base-');
  const repo = repositoryWith(join(directory, 'repo'), { 'base.txt': 'base\n' });
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'head.txt', 'head\n');
  const head = commitAll(repo, 'head');
  const logs: string[] = [];
  const context = (change: Partial<BaseTreeContext> = {}): BaseTreeContext => ({ runId: 'run-1', worktree: repo, scratch: join(directory, 'scratch'), checkpointRoot: join(repo, '.git', 'deep-review'), environment: process.env, log: (line) => logs.push(line), ...change });
  return { directory, repo, base, head, context, logs };
}

/** Each entry of `git worktree list --porcelain` as its lines, the main worktree's first. */
const entries = (repo: string): string[][] => git(repo, 'worktree', 'list', '--porcelain').split(/\n\n/).map((entry) => entry.split('\n').filter((line) => line.length > 0)).filter((entry) => entry.length > 0);

/** A post-checkout hook in the repository that records each run of it in `marker`. */
function hookInto(repo: string, marker: string): void {
  write(repo, '.git/hooks/post-checkout', `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`);
  chmodSync(join(repo, '.git', 'hooks', 'post-checkout'), 0o755);
}

describe('makeBaseTree', () => {
  it('checks the base out detached in a private directory under the scratch directory, locked with the reason that names the run, and runs no hook of the repository', (t) => {
    const { directory, repo, base, context } = sandbox(t);
    const marker = join(directory, 'hook-ran');
    hookInto(repo, marker);
    git(repo, 'worktree', 'add', '--detach', join(directory, 'by-hand'), base);
    assert.equal(existsSync(marker), true, 'the hook runs at a checkout git makes with the repository\'s hooks');
    rmSync(marker);
    const tree = makeBaseTree(context(), base);
    assert.equal(tree.kind, 'made');
    const path = tree.kind === 'made' ? tree.path : '';
    assert.equal(join(path, '..'), join(directory, 'scratch'));
    assert.match(readdirSync(join(directory, 'scratch')).join(','), /^run-1-base-/);
    assert.equal(git(path, 'rev-parse', 'HEAD'), base);
    assert.equal(existsSync(join(path, 'base.txt')), true);
    assert.equal(existsSync(join(path, 'head.txt')), false, 'the tree is the base, not the change');
    assert.deepEqual(entries(repo).find((entry) => entry[0] === `worktree ${path}`)?.slice(2), ['detached', `locked ${baseLockReason('run-1')}`]);
    assert.equal(existsSync(marker), false, 'no hook ran at the checkout of the base');
  });

  it('makes none for the empty tree, the base of a root commit, and runs no git', (t) => {
    const { directory, repo, context } = sandbox(t);
    assert.deepEqual(makeBaseTree(context(), '4b825dc642cb6eb9a060e54bf8d69288fbee4904'), { kind: 'none', skip: { reason: 'empty-tree', error: baseSkipReasons['empty-tree'] } });
    assert.equal(existsSync(join(directory, 'scratch')), false);
    assert.equal(entries(repo).length, 1);
  });

  it('makes none when git refuses, with the fixed words and the first line of git\'s error, and logs the whole error', (t) => {
    const { context, logs } = sandbox(t);
    const tree = makeBaseTree(context(), 'f'.repeat(40));
    assert.equal(tree.kind, 'none');
    assert.equal(tree.kind === 'none' ? tree.skip.reason : null, 'no-worktree');
    const error = tree.kind === 'none' ? tree.skip.error : '';
    assert.ok(error.startsWith(`${baseSkipReasons['no-worktree']}: `), error);
    assert.match(error, /invalid reference/);
    assert.doesNotMatch(error, /\n/);
    assert.ok(logs.some((line) => line.startsWith('no worktree of the base ffffffff could be made: ')), logs.join('\n'));
  });

  it('makes none, and nothing in the reviewed tree, when the scratch directory is inside it', (t) => {
    const { repo, base, context } = sandbox(t);
    const tree = makeBaseTree(context({ scratch: join(repo, 'scratch') }), base);
    assert.equal(tree.kind, 'none');
    assert.equal(tree.kind === 'none' ? tree.skip.reason : null, 'no-worktree');
    assert.match(tree.kind === 'none' ? tree.skip.error : '', /^no worktree of the base could be made: The worktree of the base .* is inside the reviewed tree/);
    assert.equal(existsSync(join(repo, 'scratch')), false);
  });

  it('makes the worktree in the reviewed repository when GIT_DIR names another one for the engine', (t) => {
    const { directory, repo, base, context } = sandbox(t);
    const victim = repositoryWith(join(directory, 'victim'), { 'victim.txt': 'victim\n' });
    const tree = makeBaseTree(context({ environment: { ...process.env, GIT_DIR: join(victim, '.git'), GIT_WORK_TREE: victim } }), base);
    assert.equal(tree.kind, 'made');
    assert.equal(entries(repo).length, 2);
    assert.equal(entries(victim).length, 1, 'the other repository has no worktree of the base');
  });
});

describe('removeBaseTrees', () => {
  it('removes each worktree of the run, wherever its scratch directory was and whether its directory is there, and every other entry stays as it was', (t) => {
    const { directory, repo, base, context, logs } = sandbox(t);
    const here = makeBaseTree(context(), base);
    // A command of the run under another TMPDIR made this one, and a crash left both.
    const elsewhere = makeBaseTree(context({ scratch: join(directory, 'other-tmp', 'scratch') }), base);
    const gone = makeBaseTree(context(), base);
    assert.ok(here.kind === 'made' && elsewhere.kind === 'made' && gone.kind === 'made');
    rmSync(gone.path, { recursive: true, force: true });
    // A stop between the private directory and git's entry leaves the directory alone.
    mkdirSync(join(directory, 'scratch', 'run-1-base-stopped'));
    // The run's own directory of the scratch, which holds its claims, and other worktrees of the person, one of them missing, one another run's.
    mkdirSync(join(directory, 'scratch', 'run-1', 'claims'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', join(directory, 'person'), base);
    git(repo, 'worktree', 'add', '--detach', join(directory, 'unmounted'), base);
    rmSync(join(directory, 'unmounted'), { recursive: true, force: true });
    const other = makeBaseTree(context({ runId: 'run-2' }), base);
    assert.equal(other.kind, 'made');
    const others = entries(repo).filter((entry) => ![here, elsewhere, gone].some((tree) => tree.kind === 'made' && entry[0] === `worktree ${tree.path}`));
    assert.equal(others.length, 4);

    removeBaseTrees(context());
    assert.deepEqual(entries(repo), others);
    assert.equal(existsSync(here.path), false);
    assert.equal(existsSync(elsewhere.path), false);
    assert.deepEqual(readdirSync(join(directory, 'scratch')).sort(), ['run-1', other.kind === 'made' ? other.path.split(/[\\/]/).at(-1)! : ''].sort());
    assert.ok(logs.filter((line) => line.startsWith('removed the worktree of the base at ')).length === 3, logs.join('\n'));

    removeBaseTrees(context());
    assert.deepEqual(entries(repo), others, 'a second removal changes nothing');
  });

  it('lists the worktrees by line, and removes the run\'s, on a git before 2.36 that refuses -z', { skip: process.platform === 'win32' && 'a POSIX shell script stands in for git' }, (t) => {
    const { directory, repo, base, context, logs } = sandbox(t);
    const here = makeBaseTree(context(), base);
    const gone = makeBaseTree(context(), base);
    assert.ok(here.kind === 'made' && gone.kind === 'made');
    rmSync(gone.path, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '--detach', join(directory, 'person'), base);
    const others = entries(repo).filter((entry) => entry[0] !== `worktree ${here.path}` && entry[0] !== `worktree ${gone.path}`);
    // git 2.32 to 2.35 has `worktree add --lock --reason` but no `worktree list -z`.
    const bin = join(directory, 'old-git');
    write(bin, 'git', `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then for a; do if [ "$a" = -z ]; then echo "error: unknown switch \\\`z'" >&2; exit 129; fi; done; fi\nexec "${join(git(repo, '--exec-path'), 'git')}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);

    removeBaseTrees(context({ environment: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) } }));
    assert.deepEqual(entries(repo), others);
    assert.equal(existsSync(here.path), false);
    assert.ok(logs.some((line) => line.startsWith('could not list the worktrees of the base with -z, listing them by line: ')), logs.join('\n'));
    assert.ok(logs.filter((line) => line.startsWith('removed the worktree of the base at ')).length === 2, logs.join('\n'));
  });

  it('logs what it cannot remove and does not throw', (t) => {
    const { directory, context, logs } = sandbox(t);
    assert.doesNotThrow(() => removeBaseTrees(context({ worktree: join(directory, 'no-repository') })));
    assert.ok(logs.some((line) => line.startsWith('could not list the worktrees of the base: ')), logs.join('\n'));
  });
});

describe('baseEnvironment', () => {
  it('leaves out the repository variables of git and each path into the reviewed worktree, keeps every other entry, and names each change', (t) => {
    const reviewed = createRepository(join(temporaryDirectory(t, 'deep-review-base-env-'), 'repo'));
    const inside = join(reviewed, 'node_modules', '.bin');
    const outside = join(reviewed, '..', 'tools');
    const { environment, changed } = baseEnvironment({
      PATH: [inside, outside, 'bin'].join(delimiter),
      PYTHONPATH: [join(reviewed, 'src'), outside].join(delimiter),
      NODE_PATH: outside,
      VIRTUAL_ENV: join(reviewed, '.venv'),
      GIT_DIR: join(reviewed, '.git'),
      GIT_CONFIG_COUNT: '1',
      HOME: reviewed,
      PWD: reviewed,
      CLAUDE_PROJECT_DIR: reviewed,
    }, reviewed, [join(reviewed, 'tools')]);
    assert.equal(environment.PATH, [outside, 'bin'].join(delimiter), 'a tools.path directory inside the reviewed worktree goes too, and a relative entry stays');
    assert.equal(environment.PYTHONPATH, outside);
    assert.equal(environment.NODE_PATH, outside);
    assert.equal(environment.VIRTUAL_ENV, undefined);
    assert.equal(environment.GIT_DIR, undefined);
    assert.equal(environment.GIT_CONFIG_COUNT, undefined);
    assert.equal(environment.HOME, reviewed, 'a variable that lists no directory a check loads from stays');
    assert.deepEqual([environment.PWD, environment.CLAUDE_PROJECT_DIR], [reviewed, reviewed], 'as the README and the module say, a path into the reviewed worktree outside the lists stays');
    assert.equal(environment.CI, 'true', 'the pins of every check hold');
    assert.deepEqual([...changed].sort(), [
      'GIT_CONFIG_COUNT',
      'GIT_DIR',
      `VIRTUAL_ENV, inside the reviewed worktree`,
      `the entries of PATH inside the reviewed worktree: ${join(reviewed, 'tools')}, ${inside}`,
      `the entries of PYTHONPATH inside the reviewed worktree: ${join(reviewed, 'src')}`,
    ].sort());
    const outsideOnly = baseEnvironment({ PATH: outside, VIRTUAL_ENV: join(outside, '.venv') }, reviewed, []);
    assert.deepEqual(outsideOnly.changed, []);
    assert.equal(outsideOnly.environment.VIRTUAL_ENV, join(outside, '.venv'));
  });

  for (const name of ['PERL5LIB', 'PERLLIB', 'RUBYLIB', 'GEM_PATH', 'CLASSPATH']) {
    it(`leaves out each entry of ${name} inside the reviewed worktree, as it does PATH's`, (t) => {
      const reviewed = createRepository(join(temporaryDirectory(t, 'deep-review-base-env-'), 'repo'));
      const inside = join(reviewed, 'lib');
      const outside = join(reviewed, '..', 'lib');
      const { environment, changed } = baseEnvironment({ [name]: [inside, outside].join(delimiter) }, reviewed, []);
      assert.equal(environment[name], outside);
      assert.deepEqual(changed, [`the entries of ${name} inside the reviewed worktree: ${inside}`]);
    });
  }

  it('leaves out a variable whose every entry is inside the reviewed worktree, rather than setting it empty', (t) => {
    const reviewed = createRepository(join(temporaryDirectory(t, 'deep-review-base-env-'), 'repo'));
    const bin = join(reviewed, 'node_modules', '.bin');
    const tools = join(reviewed, 'tools');
    const { environment, changed } = baseEnvironment({ PATH: bin, PYTHONPATH: [join(reviewed, 'src'), ''].join(delimiter) }, reviewed, [tools]);
    assert.equal(Object.hasOwn(environment, 'PATH'), false, 'an empty PATH would search the working directory alone');
    assert.equal(Object.hasOwn(environment, 'PYTHONPATH'), false, 'an empty entry left alone is no entry');
    assert.deepEqual([...changed].sort(), [
      `PATH, every entry inside the reviewed worktree: ${tools}, ${bin}`,
      `PYTHONPATH, every entry inside the reviewed worktree: ${join(reviewed, 'src')}`,
    ].sort());
  });

  it('judges an entry under a directory it cannot search as written, keeping it outside the reviewed worktree and leaving it out inside', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX file modes, which root ignores' }, (t) => {
    const directory = temporaryDirectory(t, 'deep-review-base-env-');
    const reviewed = createRepository(join(directory, 'repo'));
    const lockedOutside = join(directory, 'locked');
    const lockedInside = join(reviewed, 'locked');
    for (const locked of [lockedOutside, lockedInside]) {
      mkdirSync(join(locked, 'bin'), { recursive: true });
      chmodSync(locked, 0o000);
    }
    try {
      const { environment, changed } = baseEnvironment({ PATH: [join(lockedOutside, 'bin'), join(lockedInside, 'bin'), '/usr/bin'].join(delimiter) }, reviewed, []);
      assert.equal(environment.PATH, [join(lockedOutside, 'bin'), '/usr/bin'].join(delimiter));
      assert.deepEqual(changed, [`the entries of PATH inside the reviewed worktree: ${join(lockedInside, 'bin')}`]);
    } finally {
      // The temporary directory's removal needs to search each of them.
      for (const locked of [lockedOutside, lockedInside]) chmodSync(locked, 0o755);
    }
  });
});
