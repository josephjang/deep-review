import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { shellInvocation } from '../src/review/checks/run.ts';
import { runProbe, type ProbeRequest } from '../src/runtime/preflight.ts';
import { runProcess, type ProcessRequest, type ProcessResult } from '../src/runtime/process.ts';
import { paddedVersionBytes } from './helpers/fake-probe.ts';
import { inProcessRunProbe, inProcessRunProcess, processFakeOf, runtimeFakeOf } from './helpers/in-process-runner.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from './helpers/launcher.ts';
import { fakeCheck, fakeCheckCommand } from './helpers/review-sandbox.ts';

/** A new temporary directory by its real path, removed when the test `t` ends. */
function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'in-process-runner-')));
  t.after(() => {
    // A process the real runner killed may hold a file a moment after it is gone, which Windows refuses to remove until it lets go.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

/** A request in `directory` for `executable` and `args`, with the prompt on stdin and the fakes' base environment. */
function requestIn(directory: string, executable: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stdin'), 'the prompt');
  return {
    executable,
    args,
    cwd: directory,
    environment: { ...baseEnvironment, ...environment },
    stdinFile: join(directory, 'stdin'),
    stdoutFile: join(directory, 'stdout'),
    stderrFile: join(directory, 'stderr'),
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** A check's request, as runCheck makes it: the platform shell running `command`. */
function checkRequestIn(directory: string, command: string, environment: NodeJS.ProcessEnv = {}): ProcessRequest {
  const shell = shellInvocation(command);
  return requestIn(directory, shell.executable, shell.args, environment, { verbatimArguments: shell.verbatimArguments });
}

/** What one runner gave: the end of the process, and its two streams as text. */
interface Ran {
  readonly termination: ProcessResult['termination'];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the request `build` makes in a directory of its own once through the
 * real runner and once through the in-process runner, and give both, with
 * the directory each ran in.
 */
async function bothRunners(t: TestContext, build: (directory: string) => ProcessRequest): Promise<{ readonly real: Ran; readonly inProcess: Ran; readonly directories: { readonly real: string; readonly inProcess: string } }> {
  const root = temporaryDirectory(t);
  const run = async (name: string, runner: (request: ProcessRequest) => Promise<ProcessResult>): Promise<[Ran, string]> => {
    const directory = join(root, name);
    const result = await runner(build(directory));
    const text = (file: string): string => (existsSync(join(directory, file)) ? readFileSync(join(directory, file), 'utf8') : '');
    return [{ termination: result.termination, exitCode: result.exitCode, signal: result.signal, stdout: text('stdout'), stderr: text('stderr') }, directory];
  };
  const [real, realDirectory] = await run('real', runProcess);
  const [inProcess, inProcessDirectory] = await run('in-process', inProcessRunProcess);
  return { real, inProcess, directories: { real: realDirectory, inProcess: inProcessDirectory } };
}

/** A probe of `script` with `args`, under the fakes' base environment and `environment`. */
const probe = (script: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}, maxOutputBytes = 4 * 1024 * 1024): ProbeRequest => ({
  executable: process.execPath,
  args: [script, ...args],
  environment: { ...baseEnvironment, ...environment },
  timeoutMs: 60_000,
  maxOutputBytes,
});

/** What a probe gave: its stdout, or the message it was refused with. */
const settle = (pending: Promise<string>): Promise<{ readonly stdout?: string; readonly refused?: string }> => pending.then((stdout) => ({ stdout }), (error: unknown) => ({ refused: (error as Error).message }));

describe('the in-process runner', () => {
  describe('which requests it runs in this process', () => {
    it('runs the fake runtimes and the stand-in check here, with the arguments after the script', (t) => {
      const directory = temporaryDirectory(t);
      assert.deepEqual(processFakeOf(requestIn(directory, process.execPath, [fakeClaude, '-p', '--json']))?.args, ['-p', '--json']);
      assert.equal(processFakeOf(requestIn(directory, process.execPath, [fakeClaude]))?.name, 'claude');
      assert.equal(processFakeOf(requestIn(directory, process.execPath, [fakeCodex, 'exec']))?.name, 'codex');
      assert.equal(processFakeOf(checkRequestIn(directory, fakeCheckCommand('build')))?.name, 'check build');
    });

    it('leaves a fake that may start a grandchild to the real runner: one told to hang with one, one that may hold, and a check with a hang rule', (t) => {
      const directory = temporaryDirectory(t);
      assert.equal(processFakeOf(requestIn(directory, process.execPath, [fakeClaude], { FAKE_HANG: join(directory, 'pid') })), null);
      assert.equal(processFakeOf(requestIn(directory, process.execPath, [fakeCodex], { FAKE_START_DIR: directory })), null);
      const checks = join(directory, 'checks.json');
      writeFileSync(checks, JSON.stringify({ test: ['pass', 'hang'], lint: { write: { 'a.txt': 'a' }, hang: true } }));
      assert.equal(processFakeOf(checkRequestIn(directory, fakeCheckCommand('test'), { FAKE_CHECKS: checks })), null);
      assert.equal(processFakeOf(checkRequestIn(directory, fakeCheckCommand('build'), { FAKE_START_DIR: directory })), null);
      // A check that hangs with no grandchild needs no tree, so it runs here.
      assert.equal(processFakeOf(checkRequestIn(directory, fakeCheckCommand('lint'), { FAKE_CHECKS: checks }))?.name, 'check lint');
    });

    it('leaves every other request to the real runner: another script or executable, a command around the check, another shell, and a working directory that is not there', (t) => {
      const directory = temporaryDirectory(t);
      assert.equal(processFakeOf(requestIn(directory, process.execPath, ['-e', ''])), null);
      assert.equal(processFakeOf(requestIn(directory, join(directory, 'claude'), [fakeClaude])), null);
      assert.equal(processFakeOf(checkRequestIn(directory, `${fakeCheckCommand('build')} && echo more`)), null);
      assert.equal(processFakeOf(checkRequestIn(directory, `node "${fakeCheck}" build`)), null);
      const shell = shellInvocation(fakeCheckCommand('build'), process.platform, join(directory, 'another-shell'));
      assert.equal(processFakeOf(requestIn(directory, shell.executable, shell.args)), null);
      assert.equal(processFakeOf(requestIn(directory, process.execPath, [fakeClaude], {}, { cwd: join(directory, 'missing') })), null);
    });

    it('runs a probe of a fake runtime here, and leaves any other probe to runProbe', () => {
      assert.equal(runtimeFakeOf(process.execPath, [fakeClaude, '--version'])?.name, 'claude');
      assert.equal(runtimeFakeOf(process.execPath, [fakeCodex, 'exec', '--help'])?.name, 'codex');
      assert.equal(runtimeFakeOf(process.execPath, ['-e', 'console.log(1)']), null);
    });
  });

  describe('what a fake gives, against the real runner', () => {
    it('gives a worker\'s answer, its stderr and its exit code as the real runner does', async (t) => {
      const { real, inProcess } = await bothRunners(t, (directory) => requestIn(directory, process.execPath, [fakeClaude, '-p', '--session-id', 's-1'], { FAKE_OUTPUT: '{"answer":"yes"}', FAKE_STDERR: 'a warning\n', FAKE_EXIT: '3' }));
      assert.equal(real.exitCode, 3);
      assert.match(real.stdout, /"session_id":"s-1".*"structured_output":\{"answer":"yes"\}/);
      assert.deepEqual(inProcess, real);
    });

    it('writes Codex\'s final message to the file its flag names, as the real runner\'s fake does', async (t) => {
      const { real, inProcess, directories } = await bothRunners(t, (directory) => requestIn(directory, process.execPath, [fakeCodex, 'exec', '--output-last-message', join(directory, 'final')], { FAKE_OUTPUT: '{"answer":"no"}' }));
      assert.deepEqual(inProcess, real);
      assert.equal(readFileSync(join(directories.inProcess, 'final'), 'utf8'), readFileSync(join(directories.real, 'final'), 'utf8'));
    });

    it('writes a huge stream whole', async (t) => {
      const { real, inProcess } = await bothRunners(t, (directory) => requestIn(directory, process.execPath, [fakeClaude, '-p'], { FAKE_HUGE: String(3 * 1024 * 1024 + 5), FAKE_HUGE_STREAM: 'stderr' }));
      assert.equal(real.stderr.length, 3 * 1024 * 1024 + 5);
      assert.deepEqual(inProcess, real);
    });

    it('exits 1 with the error on stderr when the fake throws, as Node ends a script', async (t) => {
      const { real, inProcess } = await bothRunners(t, (directory) => requestIn(directory, process.execPath, [fakeClaude, '-p'], { FAKE_DENIALS: 'not json' }));
      assert.equal(real.exitCode, 1);
      assert.equal(inProcess.exitCode, 1);
      for (const ran of [real, inProcess]) assert.match(ran.stderr, /SyntaxError: Unexpected token/);
    });

    it('ends a fake that outlives its timeout as killed, with the exit code or signal a tree kill leaves', async (t) => {
      const { real, inProcess } = await bothRunners(t, (directory) => requestIn(directory, process.execPath, [fakeClaude, '-p'], { FAKE_WAIT_FOR: join(directory, 'never') }, { timeoutMs: 1500 }));
      assert.equal(real.termination, 'killed');
      assert.deepEqual(inProcess, real);
    });

    for (const [rule, expected] of [
      ['pass', { exitCode: 0 }],
      ['fail', { exitCode: 1 }],
      [{ exit: 137 }, { exitCode: 137 }],
      [{ failIfContains: { 'a.txt': 'broken' } }, { exitCode: 1 }],
      ['nonsense', { exitCode: 2 }],
    ] as const) {
      it(`runs the stand-in check under the rule ${JSON.stringify(rule)} as the real runner does`, async (t) => {
        const { real, inProcess } = await bothRunners(t, (directory) => {
          const checks = join(directory, 'checks.json');
          mkdirSync(directory, { recursive: true });
          writeFileSync(checks, JSON.stringify({ build: rule }));
          writeFileSync(join(directory, 'a.txt'), 'broken');
          return checkRequestIn(directory, fakeCheckCommand('build'), { FAKE_CHECKS: checks });
        });
        assert.equal(real.exitCode, expected.exitCode);
        assert.deepEqual(inProcess, real);
      });
    }

    it('writes the files a check\'s rule names in its working directory, and counts its runs beside the rules', async (t) => {
      const { real, inProcess, directories } = await bothRunners(t, (directory) => {
        const checks = join(directory, 'checks.json');
        mkdirSync(directory, { recursive: true });
        writeFileSync(checks, JSON.stringify({ lint: [{ write: { 'out/made.txt': 'made' } }, 'fail'] }));
        return checkRequestIn(directory, fakeCheckCommand('lint'), { FAKE_CHECKS: checks });
      });
      assert.deepEqual(inProcess, real);
      for (const directory of [directories.real, directories.inProcess]) {
        assert.equal(readFileSync(join(directory, 'out', 'made.txt'), 'utf8'), 'made');
        assert.equal(readFileSync(join(directory, 'checks.json.runs'), 'utf8'), 'lint\n');
        assert.equal(readFileSync(join(directory, 'checks.json.lint.count'), 'utf8'), '1');
      }
    });

    it('fails as the real runner does when the input is missing, before any output file exists', async (t) => {
      const directory = temporaryDirectory(t);
      const request = { ...requestIn(directory, process.execPath, [fakeClaude, '-p']), stdinFile: join(directory, 'missing') };
      await assert.rejects(runProcess(request), { code: 'ENOENT' });
      await assert.rejects(inProcessRunProcess(request), { code: 'ENOENT' });
      assert.equal(existsSync(join(directory, 'stdout')), false);
    });
  });

  describe('probes, against runProbe', () => {
    for (const [name, request] of [
      ['Claude\'s version', probe(fakeClaude, ['--version'])],
      ['Claude\'s help', probe(fakeClaude, ['--help'])],
      ['Codex\'s version', probe(fakeCodex, ['--version'])],
      ['Codex exec\'s help', probe(fakeCodex, ['exec', '--help'], { FAKE_HELP_OMIT: '--json' })],
    ] as const) {
      it(`answers the probe of ${name} as runProbe does`, async () => {
        const real = await settle(runProbe(request));
        assert.ok(real.stdout !== undefined && real.stdout.length > 0);
        assert.deepEqual(await settle(inProcessRunProbe(request)), real);
      });
    }

    it('refuses a probe past its output limit with the words runProbe uses', async (t) => {
      const padded = join(temporaryDirectory(t), 'padded');
      writeFileSync(padded, '');
      const request = probe(fakeClaude, ['--version'], { FAKE_PADDED_WHEN: padded }, paddedVersionBytes / 2);
      const real = await settle(runProbe(request));
      assert.equal(real.refused, `it printed more than ${String(paddedVersionBytes / 2)} bytes`);
      assert.deepEqual(await settle(inProcessRunProbe(request)), real);
    });

    it('reads a variable by any spelling the platform reads it by, as a child does', async () => {
      // PATH spelled otherwise: Windows finds it without case, and POSIX does not find it at all.
      const environment = Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => name.toUpperCase() !== 'PATH'));
      const request = { ...probe(fakeClaude, ['--version']), environment: { ...environment, Path: ['first', 'second'].join(delimiter), FAKE_QUALIFIED_FIRST_ON_PATH: 'first' } };
      const real = await settle(runProbe(request));
      assert.equal(real.stdout?.includes('unrelated'), process.platform !== 'win32');
      assert.deepEqual(await settle(inProcessRunProbe(request)), real);
    });
  });
});
