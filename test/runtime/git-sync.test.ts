import assert from 'node:assert/strict';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { gitTimeoutMs, installedGit, realGit, runGitSync, type GitSyncRunner, type GitSyncSpawnOptions } from '../../src/runtime/git-sync.ts';
import { withoutVariables } from '../../src/runtime/environment.ts';
import { git, withoutRepositoryVariables } from '../helpers/git.ts';

const windows = process.platform === 'win32';

/** One call a recorder's runner was given. */
interface RecordedCall {
  file: string;
  args: readonly string[];
  options: GitSyncSpawnOptions;
}

/** A runner that records each call and returns `output`, or throws `output` when it is an error. */
function recorder(output: string | Buffer | Error = 'out'): { run: GitSyncRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push({ file, args, options });
      if (output instanceof Error) throw output;
      return output;
    },
  };
}

/** The error a synchronous call threw, which the test requires it to throw. */
function thrown(call: () => unknown): NodeJS.ErrnoException & { status: number | null; signal: string | null; stdout: string; stderr: string } {
  try {
    call();
  } catch (error) {
    return error as ReturnType<typeof thrown>;
  }
  assert.fail('the call returned');
}

/** A new temporary directory, removed when the test `t` ends. */
function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'deep-review-git-sync-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * A Node script that prints how many console hosts (`conhost.exe`) are
 * children of its own process: one when it was given a console, none when
 * it was started without one. Windows only.
 */
const countOwnConsoleHosts = [
  "const { execFileSync } = require('node:child_process');",
  "const query = `(Get-CimInstance Win32_Process -Filter \"ParentProcessId=${process.pid} AND Name='conhost.exe'\" | Measure-Object).Count`;",
  "process.stdout.write(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).trim());",
].join('\n');

/** Where Git for Windows keeps the copy of git in its exec path, as `git --exec-path` prints it. */
const execPath = 'C:/Program Files/Git/mingw64/libexec/git-core';

describe('runGitSync', () => {
  it('starts a git named by its path detached on Windows, with a hidden window and the default timeout, passing the caller\'s options and arguments as given', () => {
    const { run, calls } = recorder();
    const environment = { PATH: 'x' };
    const input = Buffer.from('stdin bytes');
    const output = runGitSync(['--no-optional-locks', 'status'], { cwd: 'C:\\repo', env: environment, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 123 }, { run, platform: 'win32', file: 'C:\\Git\\git.exe' });
    assert.equal(output, 'out');
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call!.file, 'C:\\Git\\git.exe');
    assert.deepEqual(call!.args, ['--no-optional-locks', 'status']);
    assert.deepEqual(call!.options, { cwd: 'C:\\repo', env: environment, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 123, windowsHide: true, detached: true, timeout: gitTimeoutMs });
    assert.equal(gitTimeoutMs, 60_000);
  });

  it('starts a git looked up on PATH attached on Windows, where it may be a launcher that is slower detached', () => {
    const { run, calls } = recorder();
    runGitSync(['status'], { encoding: 'utf8' }, { run, platform: 'win32', file: 'git' });
    assert.equal(calls[0]!.file, 'git');
    assert.deepEqual(calls[0]!.options, { encoding: 'utf8', windowsHide: true, detached: false, timeout: gitTimeoutMs });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`starts git from PATH in the engine's process group on ${platform}`, () => {
      const { run, calls } = recorder(Buffer.from('bytes'));
      const output = runGitSync(['rev-parse', 'HEAD'], { cwd: '/repo' }, { run, platform });
      assert.deepEqual(output, Buffer.from('bytes'));
      assert.equal(calls[0]!.file, 'git');
      assert.deepEqual(calls[0]!.options, { cwd: '/repo', windowsHide: true, detached: false, timeout: gitTimeoutMs });
    });
  }

  it('keeps a timeout the caller gives, and sets its own console settings over the caller\'s', () => {
    const { run, calls } = recorder();
    runGitSync([], { encoding: 'utf8', timeout: 5, windowsHide: false }, { run, platform: 'win32', file: 'C:\\Git\\git.exe' });
    assert.equal(calls[0]!.options.timeout, 5);
    assert.equal(calls[0]!.options.windowsHide, true);
    assert.equal(calls[0]!.options.detached, true);
  });

  it('adds its settings when the caller gives no options', () => {
    const { run, calls } = recorder();
    runGitSync(['--version'], undefined, { run, platform: 'win32', file: 'C:\\Git\\git.exe' });
    assert.deepEqual(calls[0]!.options, { windowsHide: true, detached: true, timeout: gitTimeoutMs });
  });

  it('starts the git installedGit names when no file is given', () => {
    const { run, calls } = recorder();
    runGitSync(['--version'], undefined, { run });
    assert.equal(calls[0]!.file, installedGit());
    assert.equal(calls[0]!.options.detached, windows && win32.isAbsolute(installedGit()));
  });

  it('returns what the real git prints, and throws execFileSync\'s error on a non-zero exit, with its status and stderr', (t) => {
    const environment = withoutRepositoryVariables(process.env);
    // eslint-disable-next-line no-restricted-syntax -- the runner under test; the environment leaves out the repository variables as git() does.
    assert.match(runGitSync(['--version'], { encoding: 'utf8', env: environment }), /^git version /);
    const repo = temporaryDirectory(t);
    git(repo, 'init', '-q');
    // eslint-disable-next-line no-restricted-syntax -- the runner under test; the environment leaves out the repository variables as git() does.
    const failure = thrown(() => runGitSync(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment }));
    assert.equal(failure.status, 128);
    assert.equal(failure.signal, null);
    assert.match(failure.stderr, /^fatal: /m);
  });

  it('ends a detached child at the timeout and throws with what it printed so far', () => {
    // The platform is given as win32 everywhere, so the child is detached on every runner of the suite.
    // 2 s leaves the child several times its slowest process start under the suite's load (report 2026-10-14, section 6) to print 'started'.
    const started = Date.now();
    const failure = thrown(() => runGitSync(['-e', "process.stdout.write('started'); setTimeout(() => {}, 120_000);"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000 }, { file: process.execPath, platform: 'win32' }));
    assert.equal(failure.code, 'ETIMEDOUT');
    assert.equal(failure.status, null);
    assert.equal(failure.signal, 'SIGTERM');
    assert.equal(failure.stdout, 'started', 'the child ran before the timeout ended it');
    assert.ok(Date.now() - started < 60_000, `ended at the timeout, not when the child finished: ${Date.now() - started} ms`);
  });

  it('starts the child without a console host of its own on Windows, which only Node passing detached through execFileSync gives', { skip: !windows && 'console hosts are a Windows process' }, () => {
    const options: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    assert.equal(runGitSync(['-e', countOwnConsoleHosts], options, { file: process.execPath }), '0');
    // The same start with detached left out gets one, so the count above is the effect of detached and not of the probe.
    const attached: GitSyncRunner = (file, args, spawnOptions) => {
      const withoutDetached: GitSyncSpawnOptions = { ...spawnOptions, detached: false };
      return execFileSync(file, args, withoutDetached);
    };
    assert.equal(runGitSync(['-e', countOwnConsoleHosts], options, { file: process.execPath, run: attached }), '1');
  });
});

describe('realGit', () => {
  it('names git.exe in the directory git --exec-path prints, asking the git on PATH, attached and with the timeout', () => {
    const { run, calls } = recorder(`${execPath}\n`);
    const checked: string[] = [];
    const binary = realGit(run, (path) => (checked.push(path), true));
    assert.equal(binary, 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git.exe');
    assert.deepEqual(checked, [binary]);
    assert.deepEqual(calls, [{ file: 'git', args: ['--exec-path'], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: false, timeout: gitTimeoutMs } }]);
  });

  it('falls back to git from PATH when the exec path holds no git.exe', () => {
    assert.equal(realGit(recorder(execPath).run, () => false), 'git');
  });

  it('falls back to git from PATH when git cannot be run, or prints no absolute directory', () => {
    const missing = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    assert.equal(realGit(recorder(missing).run, () => true), 'git');
    for (const printed of ['', '\n', 'libexec/git-core']) assert.equal(realGit(recorder(printed).run, () => true), 'git', JSON.stringify(printed));
  });

  it('starts git from PATH outside Windows, resolving nothing', () => {
    assert.equal(installedGit('linux'), 'git');
    assert.equal(installedGit('darwin'), 'git');
  });

  it('resolves the real binary of the installed git on Windows, once', { skip: !windows && 'the git on PATH is a launcher on Windows only' }, () => {
    const binary = installedGit('win32');
    assert.ok(win32.isAbsolute(binary) && binary.toLowerCase().endsWith('\\git.exe') && existsSync(binary), binary);
    assert.equal(installedGit('win32'), binary);
  });

  it('gives git started by its real binary the environment the git on PATH gives the programs it runs', { skip: !windows && 'the git on PATH is a launcher on Windows only' }, (t) => {
    // git runs an alias that starts with ! through sh, so the dump also shows that the binary started directly finds sh.
    const dump = join(temporaryDirectory(t), 'dump.cjs');
    writeFileSync(dump, 'process.stdout.write(JSON.stringify(process.env));');
    const alias = `alias.dumpenv=!"${process.execPath.replaceAll('\\', '/')}" "${dump.replaceAll('\\', '/')}"`;
    // Without MSYSTEM, which Git Bash would pass on, so whatever MSYSTEM the dump shows is one git set itself.
    const environment = withoutVariables(withoutRepositoryVariables(process.env), ['MSYSTEM'], 'win32');
    const seen = (file: string): Record<string, string> => JSON.parse(execFileSync(file, ['-c', alias, 'dumpenv'], { env: environment, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, string>;
    // 'git' is looked up on PATH as the engine did before: Git for Windows' launcher on a default install and on the CI runner.
    const throughPath = seen('git');
    const direct = seen(installedGit('win32'));
    const pathKey = (variables: Record<string, string>): string => Object.keys(variables).find((key) => key.toUpperCase() === 'PATH')!;
    const entries = (variables: Record<string, string>): string[] => variables[pathKey(variables)]!.split(';').filter((entry) => entry !== '').sort();
    assert.deepEqual(entries(direct), entries(throughPath), 'the same PATH entries, in whatever order');
    const rest = (variables: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(variables).filter(([key]) => key !== pathKey(variables)));
    assert.deepEqual(rest(direct), rest(throughPath));
    // The real binary sets up its environment itself. Its MSYSTEM depends on the release: MINGW64 up to Git for Windows 2.55, UCRT64 from 2.56.
    assert.match(direct.MSYSTEM ?? '', /^[A-Z0-9]+$/, 'an MSYSTEM the real binary set itself');
  });

  it('reads the configuration through its real binary that the git on PATH reads, the system file among it', { skip: !windows && 'the git on PATH is a launcher on Windows only' }, (t) => {
    const outside = temporaryDirectory(t);
    const environment = withoutRepositoryVariables(process.env);
    const configuration = (file: string): string => execFileSync(file, ['config', '--list', '--show-origin', '--show-scope'], { cwd: outside, env: environment, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const direct = configuration(installedGit('win32'));
    assert.equal(direct, configuration('git'));
    assert.match(direct, /^system\t/m, 'the system configuration of the installation');
  });
});
