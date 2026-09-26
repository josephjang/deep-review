import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { PreflightError } from '../../src/runtime/errors.ts';
import { mentionsFlag, preflight } from '../../src/runtime/preflight.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from '../helpers/launcher.ts';

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
});
