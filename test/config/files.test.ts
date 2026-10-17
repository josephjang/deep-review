import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cloneConfigPath, maxConfigBytes, operatorConfigPath, parseConfig, readConfigFile, readRepositoryConfig, refuseProblems, repositoryConfigPath, type FileRead } from '../../src/config/files.ts';
import type { FileLayer } from '../../src/config/settings.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { emptyTree } from '../../src/scope/git.ts';
import { commitAll, git, remove, repositoryWith, write } from '../helpers/repository.ts';

const parsed = (text: string, layer: FileLayer = 'repository'): FileRead => parseConfig(layer, 'config.toml', Buffer.from(text), null);
const problemsOf = (read: FileRead): string => read.problems.join('\n');

describe('where the configuration files are', () => {
  it('finds the operator\'s file under APPDATA on Windows, however the variable is spelled, and none without it', () => {
    assert.equal(operatorConfigPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({ AppData: 'D:\\roaming' }, 'win32', 'C:\\Users\\a'), join('D:\\roaming', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({ XDG_CONFIG_HOME: '/x' }, 'win32', 'C:\\Users\\a'), null, 'XDG_CONFIG_HOME is not read on Windows');
  });

  it('finds the operator\'s file under an absolute XDG_CONFIG_HOME, else under ~/.config, ignoring a relative one', () => {
    assert.equal(operatorConfigPath({ XDG_CONFIG_HOME: '/srv/config' }, 'linux', '/home/a'), join('/srv/config', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({ XDG_CONFIG_HOME: 'relative/config' }, 'linux', '/home/a'), join('/home/a', '.config', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({ XDG_CONFIG_HOME: '' }, 'darwin', '/Users/a'), join('/Users/a', '.config', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({}, 'darwin', '/Users/a'), join('/Users/a', '.config', 'deep-review', 'config.toml'));
    assert.equal(operatorConfigPath({ xdg_config_home: '/srv/config' }, 'linux', '/home/a'), join('/home/a', '.config', 'deep-review', 'config.toml'), 'POSIX names are exact');
  });
});

describe('the files on disk and in the repository', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dr-config-files-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('puts the clone\'s file in the git common directory, which two worktrees of one clone share', () => {
    const repo = repositoryWith(join(root, 'repo'), { 'a.txt': 'a\n' });
    git(repo, 'worktree', 'add', '-q', join(root, 'second'), '-b', 'second');
    const first = cloneConfigPath(locateCheckpoint(repo).commonDir);
    const second = cloneConfigPath(locateCheckpoint(join(root, 'second')).commonDir);
    assert.equal(first, second);
    assert.equal(first, join(locateCheckpoint(repo).commonDir, 'deep-review.toml'));
  });

  it('reads the repository\'s file as a commit holds it, not as HEAD or the working tree does, and finds none at the empty tree', () => {
    const repo = repositoryWith(join(root, 'repo'), { [repositoryConfigPath]: 'schema = 1\nscope.exclude = ["dist/**"]\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    write(repo, repositoryConfigPath, 'schema = 1\nscope.exclude = ["other/**"]\n');
    const head = commitAll(repo, 'change the policy');
    write(repo, repositoryConfigPath, 'schema = 1\nscope.exclude = ["worktree/**"]\n');
    const atBase = readRepositoryConfig(repo, base);
    assert.deepEqual(atBase.problems, []);
    assert.deepEqual(atBase.file?.values.get('scope.exclude'), ['dist/**']);
    assert.equal(atBase.file?.commit, base);
    assert.equal(atBase.file?.path, repositoryConfigPath);
    assert.match(atBase.file!.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(readRepositoryConfig(repo, head).file?.values.get('scope.exclude'), ['other/**']);
    assert.deepEqual(readRepositoryConfig(repo, emptyTree(repo)), { file: null, problems: [] });
  });

  it('finds no repository file at a commit without one, and refuses a directory at its path', () => {
    const repo = repositoryWith(join(root, 'repo'), { 'a.txt': 'a\n' });
    assert.deepEqual(readRepositoryConfig(repo, git(repo, 'rev-parse', 'HEAD')), { file: null, problems: [] });
    write(repo, `${repositoryConfigPath}/inner.toml`, 'schema = 1\n');
    const commit = commitAll(repo, 'a directory where the file goes');
    assert.match(problemsOf(readRepositoryConfig(repo, commit)), /is a directory, not a regular file/);
  });

  it('refuses a repository file larger than 64 KiB before it parses it', () => {
    const repo = repositoryWith(join(root, 'repo'), { [repositoryConfigPath]: `schema = 1\n${'#'.repeat(maxConfigBytes)}\n` });
    assert.match(problemsOf(readRepositoryConfig(repo, git(repo, 'rev-parse', 'HEAD'))), /more than the 65536 the engine reads/);
  });

  it('finds no operator\'s or clone\'s file where none is, but refuses a --config file that is not there', () => {
    assert.deepEqual(readConfigFile('operator', join(root, 'none.toml')), { file: null, problems: [] });
    assert.deepEqual(readConfigFile('clone', join(root, 'none.toml')), { file: null, problems: [] });
    assert.match(problemsOf(readConfigFile('invocation', join(root, 'none.toml'))), /no such file; give --config/);
  });

  it('reads a file on disk with its hash and no commit, and refuses one that is too large or a directory', () => {
    const path = join(root, 'operator.toml');
    writeFileSync(path, 'schema = 1\n[runtimes.claude]\nstrong = "opus-next"\n');
    const read = readConfigFile('operator', path);
    assert.deepEqual(read.problems, []);
    assert.equal(read.file?.commit, null);
    assert.equal(read.file?.values.get('runtimes.claude.strong'), 'opus-next');
    writeFileSync(path, Buffer.alloc(maxConfigBytes + 1, 0x23));
    assert.match(problemsOf(readConfigFile('operator', path)), /more than the 65536/);
    mkdirSync(join(root, 'directory.toml'));
    assert.match(problemsOf(readConfigFile('clone', join(root, 'directory.toml'))), /not a regular file/);
  });

  it('reads the repository\'s file again after a file at the path was removed', () => {
    const repo = repositoryWith(join(root, 'repo'), { [repositoryConfigPath]: 'schema = 1\n' });
    remove(repo, repositoryConfigPath);
    const commit = commitAll(repo, 'drop the policy');
    assert.deepEqual(readRepositoryConfig(repo, commit), { file: null, problems: [] });
  });
});

describe('the checks of a file', () => {
  it('flattens tables and dotted keys to the registry\'s names', () => {
    const read = parsed('schema = 1\nchecks.test = "npm test"\n[runtimes.claude]\nstrong = "opus"\n[budget]\nusd = 120\n', 'operator');
    assert.deepEqual(read.problems, []);
    assert.deepEqual([...read.file!.values.entries()], [['checks.test', 'npm test'], ['runtimes.claude.strong', 'opus'], ['budget.usd', 120]]);
  });

  it('reads a quoted key that holds a dot as one unknown name, not as the setting its dots spell', () => {
    const read = parsed('schema = 1\n"checks.test" = "a"\n[checks]\ntest = "b"\n');
    assert.match(problemsOf(read), /checks\.test: no such setting/, 'the quoted key is unknown');
    const operator = parsed('schema = 1\n"checks.test" = "a"\n[checks]\ntest = "b"\n', 'operator');
    assert.equal(operator.file?.values.get('checks.test'), 'b', 'only the key TOML reads as a table entry is the setting');
    assert.deepEqual(operator.file?.ignored, ['checks.test']);
  });

  it('refuses a file that is not UTF-8, or not TOML', () => {
    assert.match(problemsOf(parseConfig('repository', 'config.toml', Buffer.from([0x73, 0xff, 0xfe]), null)), /not UTF-8/);
    assert.match(problemsOf(parsed('schema = 1\nchecks.test = \n')), /not valid TOML/);
  });

  it('refuses a file with no schema, another schema, or a newer one with the action to update the engine', () => {
    assert.match(problemsOf(parsed('scope.exclude = []\n')), /schema: the repository's file must say schema = 1$/);
    assert.match(problemsOf(parsed('schema = "1"\n')), /must say schema = 1, not "1"/);
    assert.match(problemsOf(parsed('schema = 0\n')), /must say schema = 1, not 0/);
    const newer = parsed('schema = 2\n[limits]\nbudget = 5\n');
    assert.equal(newer.problems.length, 1, 'a newer file is not checked for the names of its schema');
    assert.match(problemsOf(newer), /schema = 2, which a newer engine reads; update deep-review/);
  });

  it('refuses a value of the wrong kind, naming the setting', () => {
    assert.match(problemsOf(parsed('schema = 1\nchecks.timeout_minutes = "20"\n')), /checks\.timeout_minutes: .*not "20"/);
    assert.match(problemsOf(parsed('schema = 1\nscope.exclude = "dist/**"\n')), /scope\.exclude: /);
    assert.match(problemsOf(parsed('schema = 1\nchecks.test = true\n')), /checks\.test: /);
  });

  it('quotes a refused inf or nan as the file spells it, not as null', () => {
    assert.match(problemsOf(parsed('schema = 1\n[budget]\nusd = inf\n')), /budget\.usd: .*not inf$/);
    assert.match(problemsOf(parsed('schema = 1\n[run]\nconcurrency = nan\n', 'operator')), /run\.concurrency: .*not nan$/);
    assert.match(problemsOf(parsed('schema = 1\nscope.exclude = ["dist/**", -inf]\n')), /scope\.exclude: .*not \["dist\/\*\*",-inf\]$/);
  });

  it('refuses an unknown name in the repository\'s and the invocation file, and ignores it in the operator\'s and the clone\'s', () => {
    const text = 'schema = 1\nscope.include = ["src"]\n[runtimes.gemini]\nstrong = "x"\n';
    for (const layer of ['repository', 'invocation'] as const) {
      const read = parsed(text, layer);
      assert.equal(read.file, null, layer);
      assert.match(problemsOf(read), /scope\.include: no such setting/, layer);
      assert.match(problemsOf(read), /runtimes\.gemini\.strong: no such setting/, layer);
    }
    for (const layer of ['operator', 'clone'] as const) {
      const read = parsed(text, layer);
      assert.deepEqual(read.problems, [], layer);
      assert.deepEqual(read.file?.ignored, ['scope.include', 'runtimes.gemini.strong'], layer);
      assert.equal(read.file?.values.size, 0, layer);
    }
  });

  it('refuses an operator-only setting in the repository\'s file, and takes it in every other file', () => {
    const text = 'schema = 1\ntools.path = ["bin"]\nrun.concurrency = 2\n';
    assert.match(problemsOf(parsed(text, 'repository')), /tools\.path: the repository's file cannot set it, since it is operator-only/);
    assert.match(problemsOf(parsed(text, 'repository')), /run\.concurrency: /);
    for (const layer of ['operator', 'clone', 'invocation'] as const) assert.deepEqual(parsed(text, layer).file?.values.get('tools.path'), ['bin'], layer);
  });

  it('names every problem of a file in one read, and every file\'s in one refusal', () => {
    const read = parsed('schema = 1\nchecks.test = 3\nrun.concurrency = 2\nnope = 1\n');
    assert.equal(read.problems.length, 3);
    const other = parsed('checks.test = "x"\n', 'invocation');
    assert.throws(() => refuseProblems([...read.problems, ...other.problems]), (error: unknown) => {
      assert.ok(error instanceof ReviewRefusedError);
      for (const name of ['checks.test', 'run.concurrency', 'nope', 'schema']) assert.match(error.message, new RegExp(name.replace('.', '\\.')));
      return true;
    });
    refuseProblems([]);
  });

  it('names the escape when the repository\'s file at the base cannot be read', () => {
    const read = parseConfig('repository', repositoryConfigPath, Buffer.from('nope'), 'a'.repeat(40));
    assert.throws(() => refuseProblems(read.problems), /run with --no-repository-config/);
    assert.throws(() => refuseProblems(parsed('nope', 'operator').problems), (error: unknown) => error instanceof ReviewRefusedError && !error.message.includes('--no-repository-config'));
  });
});
