import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { refuseShim, resolveExecutable } from '../../src/review/executable.ts';

describe('resolveExecutable', () => {
  let sandbox: string;
  let first: string;
  let second: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-executable-'));
    first = join(sandbox, 'first');
    second = join(sandbox, 'second');
    mkdirSync(first);
    mkdirSync(second);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const refused = (fn: () => unknown, message: RegExp): void => {
    assert.throws(fn, (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && message.test(error.message));
  };

  it('finds the first match in PATH order on POSIX, without trying extensions', () => {
    writeFileSync(join(second, 'claude'), '');
    writeFileSync(join(first, 'claude.exe'), '');
    const path = [first, second].join(delimiter);
    assert.equal(resolveExecutable('claude', { PATH: path }, 'linux'), join(second, 'claude'));
    refused(() => resolveExecutable('codex', { PATH: path }, 'linux'), /no codex was found on PATH/);
  });

  it('tries PATHEXT in order on Windows for a bare name, and refuses a .cmd or .bat shim by name', () => {
    writeFileSync(join(first, 'claude.CMD'), '');
    writeFileSync(join(second, 'claude.exe'), '');
    const environment = { Path: [first, second].join(delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    // PATH order comes first: the shim in `first` is found before the executable in `second`, and refused.
    refused(() => resolveExecutable('claude', environment, 'win32'), /claude\.CMD is a \.CMD shim, which cannot be spawned without a shell; pass --executable/);
    assert.equal(resolveExecutable('claude', { Path: [second, first].join(delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'), join(second, 'claude.exe'));
    assert.equal(resolveExecutable('claude', { PATH: second }, 'win32'), join(second, 'claude.exe'), 'the default PATHEXT includes .EXE');
    writeFileSync(join(second, 'codex.bat'), '');
    refused(() => resolveExecutable('codex', { PATH: second }, 'win32'), /codex\.bat is a \.bat shim/);
  });

  it('takes a path as given, made absolute, and refuses one that is not a file', () => {
    writeFileSync(join(first, 'claude'), '');
    assert.equal(resolveExecutable(join(first, 'claude'), {}, 'linux'), join(first, 'claude'));
    assert.equal(resolveExecutable('./first/claude', {}, 'linux', sandbox), join(first, 'claude'));
    refused(() => resolveExecutable(join(first, 'absent'), {}, 'linux'), /is not a file; pass --executable/);
    refused(() => resolveExecutable(first, {}, 'linux'), /is not a file/);
  });

  it('refuses a shim whatever its case, and passes anything else', () => {
    refused(() => refuseShim('C:\\tools\\claude.Cmd'), /shim/);
    assert.equal(refuseShim('/usr/bin/claude'), '/usr/bin/claude');
    assert.equal(refuseShim('C:\\tools\\codex.exe'), 'C:\\tools\\codex.exe');
  });
});
