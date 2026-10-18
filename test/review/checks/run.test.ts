import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EvidenceStore } from '../../../src/evidence/store.ts';
import { spawnSync } from 'node:child_process';
import { checkEnvironment, checkOutcomeOf, checkPins, runCheck, shellInvocation, type CheckRequest } from '../../../src/review/checks/run.ts';
import { killMarkCodes } from '../../../src/runtime/process.ts';
import { killWithMark } from '../../helpers/resume-contract.ts';
import { buildServerPins } from '../../../src/runtime/environment.ts';
import { baseEnvironment, isAlive, until, waitForPid } from '../../helpers/launcher.ts';

/** A command line running `script` with this Node, quoted for either platform shell. */
const node = (script: string, ...args: string[]): string => [process.execPath, script, ...args].map((part) => `"${part}"`).join(' ');

describe('shellInvocation', () => {
  it('hands the command to cmd.exe as one verbatim argument on Windows, with no AutoRun and the outer quotes stripped', () => {
    const shell = shellInvocation('pnpm run -r --filter zod build', 'win32');
    assert.match(shell.executable, /[\\/]System32[\\/]cmd\.exe$/i);
    assert.deepEqual(shell.args, ['/d', '/s', '/c', '"pnpm run -r --filter zod build"']);
    assert.equal(shell.verbatimArguments, true);
  });

  it('hands the command to /bin/sh -c elsewhere, quoting nothing', () => {
    assert.deepEqual(shellInvocation('make test && echo "done"', 'linux'), { executable: '/bin/sh', args: ['-c', 'make test && echo "done"'], verbatimArguments: false });
    assert.equal(shellInvocation('x', 'darwin', '/opt/sh').executable, '/opt/sh');
  });
});

describe('checkEnvironment', () => {
  it('adds the build-server pins and the non-interactive pins over every spelling the platform reads as theirs', () => {
    const environment = checkEnvironment({ PATH: '/bin', ci: 'false', Term: 'xterm', MSBUILDDISABLENODEREUSE: '0' }, 'win32');
    for (const [name, value] of Object.entries({ ...buildServerPins, ...checkPins })) assert.equal(environment[name], value, name);
    assert.equal(environment.ci, undefined, 'a Windows spelling of CI is replaced');
    assert.equal(environment.Term, undefined);
    assert.equal(environment.PATH, '/bin');
    assert.equal(checkEnvironment({ ci: 'false' }, 'linux').ci, 'false', 'on POSIX ci and CI are two variables');
    assert.equal(checkEnvironment({}, 'linux').TMPDIR, undefined, 'a check gets no scratch directory of its own');
  });

  // R11, TD10 of the configuration: a check finds the tools a worker finds.
  it('puts the tools.path directories first on PATH, as a worker has them', () => {
    assert.equal(checkEnvironment({ PATH: '/bin' }, 'linux', ['/opt/node/bin']).PATH, '/opt/node/bin:/bin');
    assert.equal(checkEnvironment({ Path: 'C:\\Windows' }, 'win32', ['C:\\tools']).Path, 'C:\\tools;C:\\Windows');
  });

  it('runs a check with the tools.path directories first on its PATH', async () => {
    const tools = mkdtempSync(join(tmpdir(), 'dr-tools-'));
    try {
      const store = new EvidenceStore(join(tools, 'evidence'));
      const script = join(tools, 'print-path.mjs');
      writeFileSync(script, 'process.stdout.write(process.env.PATH ?? process.env.Path ?? "");\n');
      const result = await runCheck(store, { command: node(script), worktree: tools, environment: baseEnvironment, toolsPath: [join(tools, 'bin')], timeoutMs: 60_000, ioDirectory: join(tools, 'io') });
      assert.equal(result.outcome, 'passed', result.error ?? '');
      assert.ok(store.read(result.stdout!).toString('utf8').startsWith(`${join(tools, 'bin')}${process.platform === 'win32' ? ';' : ':'}`));
    } finally {
      rmSync(tools, { recursive: true, force: true });
    }
  });
});

describe('checkOutcomeOf', () => {
  const at = { startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:01.000Z' };
  it('passes an exit code of 0 alone', () => {
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: 0, signal: null, ...at }), 'passed');
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: 1, signal: null, ...at }), 'failed');
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: 134, signal: null, ...at }), 'failed', 'a test runner that aborts gives 134, a real failure');
    assert.equal(checkOutcomeOf({ termination: 'killed', exitCode: null, signal: 'SIGKILL', treeKillError: null, ...at }), 'timeout');
    assert.equal(checkOutcomeOf({ termination: 'not-started', exitCode: null, signal: null, error: 'ENOENT', ...at }), 'not-started');
  });

  it('cuts a check that ended with a kill mark, a signal or a code a shell or Windows gives a killed process, and fails one with exit code 1 (R4 of resumable runs)', () => {
    for (const exitCode of killMarkCodes) assert.equal(checkOutcomeOf({ termination: 'exited', exitCode, signal: null, ...at }), 'cut', String(exitCode));
    assert.deepEqual(killMarkCodes, [129, 130, 131, 137, 143, 3221225786]);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL']) assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: null, signal, ...at }), 'cut', signal);
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: null, signal: null, ...at }), 'cut', 'a guard with no result is a mark too (R8)');
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: 1, signal: null, ...at }), 'failed', 'taskkill leaves exit code 1, the accepted risk of PD5');
    assert.equal(checkOutcomeOf({ termination: 'exited', exitCode: 128, signal: null, ...at }), 'failed');
  });
});

describe('runCheck', { timeout: 120_000 }, () => {
  let directory: string;
  let evidence: EvidenceStore;
  let worktree: string;
  let serial = 0;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-check-')));
    evidence = new EvidenceStore(join(directory, 'evidence'));
    worktree = join(directory, 'tree');
    mkdirSync(worktree);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /** A script in the sandbox, so a command line holds no characters either shell would interpret. */
  const script = (name: string, body: string): string => {
    const path = join(directory, name);
    writeFileSync(path, body);
    return path;
  };
  const request = (command: string, change: Partial<CheckRequest> = {}): CheckRequest => ({
    command,
    worktree,
    environment: baseEnvironment,
    timeoutMs: 30_000,
    ioDirectory: join(directory, 'io', `check-${String((serial += 1))}`),
    ...change,
  });

  it('passes a command that exits 0, in the worktree, with its output frozen and its process files removed', async () => {
    const path = script('pass.mjs', "process.stdout.write(process.cwd()); process.stderr.write('warn'); process.exit(0);\n");
    const checked = request(node(path));
    const result = await runCheck(evidence, checked);
    assert.equal(result.outcome, 'passed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.termination, 'exited');
    assert.equal(result.error, null);
    assert.equal(evidence.read(result.stdout).toString('utf8'), worktree);
    assert.equal(evidence.read(result.stderr).toString('utf8'), 'warn');
    assert.ok(result.startedAt <= result.endedAt);
    assert.equal(existsSync(checked.ioDirectory), false);
  });

  it('fails a command that exits otherwise, and one the shell cannot find', async () => {
    const failing = await runCheck(evidence, request(node(script('fail.mjs', "console.error('2 tests failed'); process.exit(3);\n"))));
    assert.equal(failing.outcome, 'failed');
    assert.equal(failing.exitCode, 3);
    assert.match(evidence.read(failing.stderr).toString('utf8'), /2 tests failed/);
    const missing = await runCheck(evidence, request('deep-review-no-such-command-anywhere'));
    assert.equal(missing.outcome, 'failed', 'the shell started and said the command does not exist');
    assert.notEqual(missing.exitCode, 0);
  });

  it('runs a shell command line whole: an argument with spaces and a chain of two commands', async () => {
    const path = script('args.mjs', "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    const result = await runCheck(evidence, request(`${node(path, 'one arg', 'two')} && ${node(path, 'again')}`));
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(evidence.read(result.stdout).toString('utf8').trim().split(/\r?\n/), ['["one arg","two"]', '["again"]']);
  });

  it('gives the command the pins and an empty stdin, so a prompt reads end of input', async () => {
    const path = script('env.mjs', "const fs = await import('node:fs'); const input = fs.readFileSync(0, 'utf8'); process.stdout.write(JSON.stringify({ input, CI: process.env.CI, NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT, MSBUILDDISABLENODEREUSE: process.env.MSBUILDDISABLENODEREUSE }));\n");
    const result = await runCheck(evidence, request(node(path), { environment: { ...baseEnvironment, CI: 'false', TERM: 'xterm-256color' } }));
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(JSON.parse(evidence.read(result.stdout).toString('utf8')), { input: '', CI: 'true', NO_COLOR: '1', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', MSBUILDDISABLENODEREUSE: '1' });
  });

  it('kills a check at its timeout with its whole tree, through the shell, and records a timeout', async () => {
    // The grandchild is detached on Windows, so only a kill that walks the tree from the shell ends it (see hangWithGrandchild).
    const pidFile = join(directory, 'grandchild.pid');
    const path = script('hang.mjs', `const { spawn } = await import('node:child_process'); const { writeFileSync } = await import('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
    const pending = runCheck(evidence, request(node(path), { timeoutMs: 3000 }));
    const grandchild = await waitForPid(pidFile);
    try {
      const result = await pending;
      assert.equal(result.outcome, 'timeout');
      assert.equal(result.termination, 'killed');
      assert.equal(result.error, null, 'the whole tree was reached');
      await until(() => !isAlive(grandchild), `grandchild ${String(grandchild)} to die`, 10_000);
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  /** Run a check that writes its pid and waits, end it with `kill` once the pid is there, and return what the check came to. */
  const killedBy = async (kill: (pid: number) => void): Promise<string> => {
    const pidFile = join(directory, `waiting-${String((serial += 1))}.pid`);
    const path = script(`wait-${String(serial)}.mjs`, `(await import('node:fs')).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);
`);
    const pending = runCheck(evidence, request(node(path)));
    kill(await waitForPid(pidFile));
    return (await pending).outcome;
  };

  it('cuts a real check that SIGTERM or SIGINT ends on POSIX (R4 of resumable runs)', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
    assert.equal(await killedBy((pid) => process.kill(pid, 'SIGTERM')), 'cut');
    assert.equal(await killedBy((pid) => process.kill(pid, 'SIGINT')), 'cut');
  });

  it('cuts a real check the kill of Git for Windows ends, and fails one taskkill ends, the accepted risk (R4, PD5 of resumable runs)', { skip: process.platform === 'win32' ? false : 'Windows tools' }, async () => {
    assert.equal(await killedBy(killWithMark), 'cut');
    assert.equal(await killedBy((pid) => spawnSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })), 'failed');
  });

  it('records a shell that cannot start as not started, with the reason', async () => {
    const result = await runCheck(evidence, request('make test', { shell: join(directory, 'no-such-shell') }));
    assert.equal(result.outcome, 'not-started');
    assert.equal(result.termination, 'not-started');
    assert.match(result.error ?? '', /ENOENT/);
    assert.equal(evidence.read(result.stdout).length, 0);
  });

  it('refuses an io directory that already exists, running nothing', async () => {
    const checked = request(node(script('touch.mjs', "(await import('node:fs')).writeFileSync('ran', '');\n")));
    mkdirSync(checked.ioDirectory, { recursive: true });
    await assert.rejects(runCheck(evidence, checked), /EEXIST/);
    assert.equal(existsSync(join(worktree, 'ran')), false);
    assert.equal(existsSync(checked.ioDirectory), true, 'another check\'s directory is left alone');
  });

  it('keeps the process files when the output cannot be frozen, and says where', async () => {
    const checked = request(node(script('out.mjs', "process.stdout.write('kept');\n")));
    const broken = { put: (): never => { throw new Error('disk full'); } };
    await assert.rejects(runCheck(broken, checked), (error: Error) => error.message.includes(checked.ioDirectory) && /disk full/.test(error.message));
    assert.equal(readFileSync(join(checked.ioDirectory, 'stdout'), 'utf8'), 'kept');
  });
});
