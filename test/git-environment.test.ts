import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { deleteRepositoryVariables, git, isRepositoryVariable, repositoryVariables, withoutRepositoryVariables } from './helpers/git.ts';
import type { ProbeReport } from './helpers/inherited-git-probe.ts';
import { repositoryWith } from './helpers/repository.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probe = resolve(import.meta.dirname, 'helpers', 'inherited-git-probe.ts');

/** Every file under `directory`, by forward-slash path, with the SHA-256 of its bytes. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(directory, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return files;
}

/** The `--import` modules `npm test` preloads into every test process, read from package.json. */
function preloadsOfNpmTest(): string[] {
  const script = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.test;
  assert.ok(script !== undefined, 'package.json has a test script');
  return [...script.matchAll(/--import[= ](\S+)/g)].map((match) => match[1]!);
}

describe('a test run under git variables that name another repository', () => {
  let sandbox: string;
  /** The repository the variables name, standing in for the clone a rebase or a hook runs in. */
  let victim: string;
  let before: Record<string, string>;
  beforeEach(() => {
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-inherited-git-')));
    victim = repositoryWith(join(sandbox, 'victim'), { 'victim.txt': 'victim\n' });
    before = snapshot(victim);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /**
   * Run the probe with `variables` over this process's environment, check
   * that the repository they name is untouched, and return what the probe
   * reported. The repository is checked first: a probe whose git acted on it
   * can fail on what it found there, and the change is the finding.
   */
  const runProbe = (args: string[], variables: Record<string, string>): ProbeReport => {
    const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...variables } });
    assert.deepEqual(snapshot(victim), before, `the repository the variables name was changed; the probe said:\n${result.stderr}`);
    assert.equal(result.status, 0, `the probe failed:\n${result.stderr}`);
    return JSON.parse(result.stdout) as ProbeReport;
  };

  it('leaves the repository GIT_DIR names untouched when a test makes repositories through the helpers, even run directly with no preload', () => {
    const work = join(sandbox, 'work');
    const report = runProbe([probe, 'helpers', work], { GIT_DIR: join(victim, '.git') });

    assert.equal(report.commonDir, realpathSync.native(join(work, 'repo', '.git')), 'the engine located the test repository');
  });

  it('leaves the named repository untouched and its injected settings unread under every variable that names a repository or carries settings', () => {
    const work = join(sandbox, 'work');
    const gitDir = join(victim, '.git');
    const report = runProbe([probe, 'helpers', work], {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: victim,
      GIT_COMMON_DIR: gitDir,
      GIT_INDEX_FILE: join(gitDir, 'index'),
      GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
      GIT_CONFIG_PARAMETERS: "'user.name'='Injected'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.email',
      GIT_CONFIG_VALUE_0: 'injected@example.invalid',
      GIT_NAMESPACE: 'injected',
    });

    assert.equal(report.commonDir, realpathSync.native(join(work, 'repo', '.git')));
    assert.equal(report.author, 'Test <test@example.invalid>', 'the commit took the test identity, not the injected one');
    assert.deepEqual(report.refs, ['refs/heads/feature', 'refs/heads/main'], 'the refs are outside any namespace');
  });

  it('keeps the engine\'s own git calls off the repository GIT_DIR names in a process npm test starts, which imports no helper', () => {
    const preloads = preloadsOfNpmTest();
    assert.notDeepEqual(preloads, [], 'npm test preloads a module into every test process');
    const target = repositoryWith(join(sandbox, 'target'), { 'a.txt': 'a\n' });
    const report = runProbe([...preloads.flatMap((module) => ['--import', module]), probe, 'engine', target], { GIT_DIR: join(victim, '.git') });

    assert.equal(report.commonDir, realpathSync.native(join(target, '.git')), 'the engine located the test repository');
  });
});

describe('the repository variables', () => {
  it('hold every variable git itself clears when it moves to another repository', () => {
    const local = git(tmpdir(), 'rev-parse', '--local-env-vars').split(/\r?\n/).filter((line) => line.length > 0);
    assert.ok(local.includes('GIT_DIR'), 'git printed its list');
    assert.deepEqual(local.filter((name) => !repositoryVariables.includes(name)), []);
  });

  it('match every spelling Windows takes for a name, and only the exact name elsewhere', () => {
    assert.ok(isRepositoryVariable('git_dir', 'win32'));
    assert.ok(isRepositoryVariable('Git_Config_Key_3', 'win32'));
    assert.ok(!isRepositoryVariable('git_dir', 'linux'));
    assert.ok(isRepositoryVariable('GIT_DIR', 'linux'));
  });

  it('take the numbered settings by prefix and leave every other variable, git\'s own included', () => {
    for (const name of ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_12', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS']) assert.ok(isRepositoryVariable(name, 'linux'), name);
    for (const name of ['PATH', 'GIT_AUTHOR_NAME', 'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIRECTORY', 'MY_GIT_DIR']) assert.ok(!isRepositoryVariable(name, 'linux'), name);
  });

  it('come out of a copy, leaving the original as it was', () => {
    const environment = { PATH: '/bin', GIT_DIR: '/elsewhere/.git', git_work_tree: '/elsewhere', GIT_CONFIG_KEY_0: 'core.bare' };
    assert.deepEqual(withoutRepositoryVariables(environment, 'win32'), { PATH: '/bin' });
    assert.deepEqual(withoutRepositoryVariables(environment, 'linux'), { PATH: '/bin', git_work_tree: '/elsewhere' });
    assert.deepEqual(withoutRepositoryVariables({}, 'linux'), {});
    assert.equal(environment.GIT_DIR, '/elsewhere/.git');
  });

  it('are deleted in place', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '/bin', GIT_DIR: '/elsewhere/.git', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };
    deleteRepositoryVariables(environment, 'linux');
    assert.deepEqual(environment, { PATH: '/bin' });
    deleteRepositoryVariables(environment, 'linux');
    assert.deepEqual(environment, { PATH: '/bin' });
  });

  it('are absent from this test process', () => {
    assert.deepEqual(Object.keys(process.env).filter((name) => isRepositoryVariable(name)), []);
  });
});
