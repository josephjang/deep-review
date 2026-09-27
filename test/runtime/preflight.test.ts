import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { PreflightError } from '../../src/runtime/errors.ts';
import { mentionsFlag, preflight } from '../../src/runtime/preflight.ts';
import { baseEnvironment, fakeClaude, fakeCodex, isAlive, until } from '../helpers/launcher.ts';

const fakeHangingProbe = resolve(import.meta.dirname, '../helpers/fake-hanging-probe.ts');

/** Node running an inline script as the executable; `--` hands the probe's own arguments to the script. */
const inlineScript = (script: string): string[] => ['-e', script, '--'];

describe('mentionsFlag', () => {
  it('finds a flag as a whole word in the ways help texts write it', () => {
    for (const text of ['  --add-dir <dirs...>', '-e, --eval=script', '--json\n', 'Options: --json, --x', '[--json]']) {
      const flag = text.includes('--eval') ? '--eval' : text.includes('--add-dir') ? '--add-dir' : '--json';
      assert.equal(mentionsFlag(text, flag), true, text);
    }
  });

  it('does not find a flag inside a longer one', () => {
    assert.equal(mentionsFlag('--setting-sources <s>', '--settings'), false);
    assert.equal(mentionsFlag('--settings-file', '--settings'), false);
    assert.equal(mentionsFlag('--json-schema', '--json'), false);
    assert.equal(mentionsFlag('x--json', '--json'), false);
    assert.equal(mentionsFlag('', '--json'), false);
  });

  it('treats the flag as text, not a pattern', () => {
    assert.equal(mentionsFlag('--a.b', '--a.b'), true);
    assert.equal(mentionsFlag('--axb', '--a.b'), false);
  });
});

describe('preflight', () => {
  it('returns the version each fake reports and checks every help text', async () => {
    assert.equal(await preflight(claudeAdapter, process.execPath, [fakeClaude], baseEnvironment), '2.1.283');
    assert.equal(await preflight(codexAdapter, process.execPath, [fakeCodex], baseEnvironment), '0.147.0');
  });

  it('names every missing flag and where it was looked for', async () => {
    await assert.rejects(
      preflight(codexAdapter, process.execPath, [fakeCodex], { ...baseEnvironment, FAKE_HELP_OMIT: '--ask-for-approval' }),
      (error: unknown) => error instanceof PreflightError && /lacks flags the adapter uses: --ask-for-approval \(in --help\)$/.test(error.message),
    );
  });

  it('refuses version output that only resembles the runtime', async () => {
    for (const version of ['2.1.283', 'Claude Code 2.1.283', '2.1 (Claude Code)', '2.1.283 (Claude Code) beta']) {
      await assert.rejects(preflight(claudeAdapter, process.execPath, [fakeClaude], { ...baseEnvironment, FAKE_VERSION: version }), /does not identify itself as claude/, version);
    }
  });

  it('kills a probe that hangs with its whole process tree at the timeout, without waiting for its pipes', { timeout: 60_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'preflight-hang-'));
    const pidFile = join(directory, 'grandchild.pid');
    let grandchild: number | undefined;
    try {
      const startedAt = Date.now();
      await assert.rejects(
        preflight(claudeAdapter, process.execPath, [fakeHangingProbe], { ...baseEnvironment, FAKE_HANG: pidFile }, { timeoutMs: 2000 }),
        (error: unknown) => error instanceof PreflightError && /^The claude preflight could not run .*--version: it did not finish within 2000 ms$/.test(error.message),
      );
      // The grandchild holds the probe's stdout open and never exits, so a
      // preflight that waited for the pipes to close would never return.
      assert.ok(Date.now() - startedAt < 20_000, 'the preflight returned soon after its timeout');
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0, `the wrapper recorded a grandchild pid, not ${String(grandchild)}`);
      await until(() => !isAlive(grandchild!), `grandchild ${String(grandchild)} to die`, 10_000);
    } finally {
      if (grandchild !== undefined && isAlive(grandchild)) process.kill(grandchild, 'SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('kills a probe that prints more than the output limit', async () => {
    await assert.rejects(
      preflight(claudeAdapter, process.execPath, [fakeClaude], baseEnvironment, { maxOutputBytes: 8 }),
      (error: unknown) => error instanceof PreflightError && /--version: it printed more than 8 bytes$/.test(error.message),
    );
  });

  it('accepts output exactly at the output limit', async () => {
    const version = '2.1.283 (Claude Code)\n';
    await assert.rejects(
      preflight(claudeAdapter, process.execPath, [fakeClaude], baseEnvironment, { maxOutputBytes: Buffer.byteLength(version) }),
      // The version probe fits; the help text, which is longer, does not.
      (error: unknown) => error instanceof PreflightError && /--help: it printed more than 22 bytes$/.test(error.message),
    );
  });

  it('reports what a failing probe printed on stderr, or how it ended when it printed nothing', async () => {
    await assert.rejects(
      preflight(claudeAdapter, process.execPath, inlineScript("process.stderr.write('  no such option\\n'); process.exit(3);"), baseEnvironment),
      (error: unknown) => error instanceof PreflightError && /--version: no such option$/.test(error.message),
    );
    await assert.rejects(
      preflight(claudeAdapter, process.execPath, inlineScript('process.exit(3);'), baseEnvironment),
      (error: unknown) => error instanceof PreflightError && /--version: it exited with code 3$/.test(error.message),
    );
  });

  it('names an executable that does not exist', async () => {
    const missing = join(tmpdir(), 'preflight-no-such-executable');
    await assert.rejects(
      preflight(claudeAdapter, missing, [], baseEnvironment),
      (error: unknown) => error instanceof PreflightError && error.message.startsWith(`The claude preflight could not run ${missing} --version: `) && /ENOENT/.test(error.message),
    );
  });

  it('gives a probe an empty stdin, so one that reads its input does not hang', { timeout: 60_000 }, async () => {
    const script = "require('node:fs').readFileSync(0); console.log(process.argv[1] === '--version' ? '2.1.283 (Claude Code)' : '--nothing');";
    await assert.rejects(
      preflight(claudeAdapter, process.execPath, inlineScript(script), baseEnvironment, { timeoutMs: 20_000 }),
      // Past the version probe: the only failure left is the help text, not a timeout.
      (error: unknown) => error instanceof PreflightError && /^claude 2\.1\.283 at .* lacks flags the adapter uses: /.test(error.message),
    );
  });

  it('refuses a limit that is not a positive whole number', async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(preflight(claudeAdapter, process.execPath, [fakeClaude], baseEnvironment, { timeoutMs }), RangeError, String(timeoutMs));
    }
    await assert.rejects(preflight(claudeAdapter, process.execPath, [fakeClaude], baseEnvironment, { maxOutputBytes: 0 }), RangeError);
  });
});
