import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { refuseShim, resolveExecutable } from '../../src/review/executable.ts';

const refused = (fn: () => unknown, message: RegExp): void => {
  assert.throws(fn, (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && message.test(error.message));
};

/** What every refusal of an unspawnable executable ends with. */
const suffix = "; pass --executable with the runtime's real executable (for an npm install, the node binary with --executable-arg naming the CLI's entry script)";

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

  it('refuses on Windows a file PATHEXT finds that Windows cannot start without a shell', () => {
    writeFileSync(join(first, 'claude.JS'), '');
    writeFileSync(join(second, 'claude.exe'), '');
    // PATHEXT lists .JS first, so the script in `first` is found before the executable in `second`, and refused.
    const environment = { PATH: [first, second].join(delimiter), PATHEXT: '.JS;.EXE' };
    refused(() => resolveExecutable('claude', environment, 'win32'), /claude\.JS is a \.JS file, and Windows starts only a \.exe or \.com without a shell; pass --executable with the runtime's real executable/);
    assert.equal(resolveExecutable('claude', { PATH: second, PATHEXT: '.JS;.EXE' }, 'win32'), join(second, 'claude.exe'), 'the executable is taken where no script comes first');
  });

  it('refuses an extensionless executable on Windows and takes it on POSIX', () => {
    writeFileSync(join(first, 'codex'), '');
    refused(() => resolveExecutable(join(first, 'codex'), {}, 'win32'), /codex is a file without an extension, and Windows starts only a \.exe or \.com without a shell/);
    assert.equal(resolveExecutable(join(first, 'codex'), {}, 'linux'), join(first, 'codex'));
    assert.equal(resolveExecutable('codex', { PATH: first }, 'linux'), join(first, 'codex'));
  });

  it('takes a path as given, made absolute, and refuses one that is not a file', () => {
    writeFileSync(join(first, 'claude'), '');
    assert.equal(resolveExecutable(join(first, 'claude'), {}, 'linux'), join(first, 'claude'));
    assert.equal(resolveExecutable('./first/claude', {}, 'linux', sandbox), join(first, 'claude'));
    refused(() => resolveExecutable(join(first, 'absent'), {}, 'linux'), /is not a file; pass --executable/);
    refused(() => resolveExecutable(first, {}, 'linux'), /is not a file/);
  });
});

describe('refuseShim', () => {
  const refusedWith = (executable: string, platform: NodeJS.Platform, message: string): void => {
    assert.throws(() => refuseShim(executable, platform), (error: unknown) => error instanceof ReviewRefusedError && error.code === 'runtime-unqualified' && error.message === message, `${executable} on ${platform}`);
  };

  it('refuses a .cmd or .bat shim on every platform whatever its case, with the shim message', () => {
    refusedWith('C:\\tools\\claude.Cmd', 'win32', `C:\\tools\\claude.Cmd is a .Cmd shim, which cannot be spawned without a shell${suffix}`);
    refusedWith('/opt/tools/claude.cmd', 'linux', `/opt/tools/claude.cmd is a .cmd shim, which cannot be spawned without a shell${suffix}`);
    refusedWith('/opt/tools/claude.BAT', 'darwin', `/opt/tools/claude.BAT is a .BAT shim, which cannot be spawned without a shell${suffix}`);
  });

  it('passes anything else on POSIX, where the file itself says how it runs', () => {
    assert.equal(refuseShim('/usr/bin/claude', 'linux'), '/usr/bin/claude');
    assert.equal(refuseShim('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'darwin'), '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  });

  it('passes on Windows a .exe or .com whatever its case', () => {
    assert.equal(refuseShim('C:\\tools\\codex.exe', 'win32'), 'C:\\tools\\codex.exe');
    assert.equal(refuseShim('C:\\tools\\claude.EXE', 'win32'), 'C:\\tools\\claude.EXE');
    assert.equal(refuseShim('C:\\tools\\claude.com', 'win32'), 'C:\\tools\\claude.com');
  });

  it('refuses on Windows any other extension, or none, naming what it found', () => {
    const windowsRefusal = (executable: string, what: string): string => `${executable} is ${what}, and Windows starts only a .exe or .com without a shell${suffix}`;
    refusedWith('C:\\npm\\claude.ps1', 'win32', windowsRefusal('C:\\npm\\claude.ps1', 'a .ps1 file'));
    refusedWith('C:\\npm\\claude.JS', 'win32', windowsRefusal('C:\\npm\\claude.JS', 'a .JS file'));
    refusedWith('C:\\npm\\claude.vbs', 'win32', windowsRefusal('C:\\npm\\claude.vbs', 'a .vbs file'));
    refusedWith('C:\\npm\\claude', 'win32', windowsRefusal('C:\\npm\\claude', 'a file without an extension'));
    // A dot in a directory name is no extension of the file, whichever platform runs the test.
    refusedWith('C:\\my.tools\\claude', 'win32', windowsRefusal('C:\\my.tools\\claude', 'a file without an extension'));
  });

  it('judges the process platform when none is named', () => {
    const script = process.platform === 'win32' ? 'C:\\npm\\claude.js' : '/usr/bin/claude.js';
    if (process.platform === 'win32') refused(() => refuseShim(script), /is a \.js file, and Windows starts only/);
    else assert.equal(refuseShim(script), script);
  });
});
