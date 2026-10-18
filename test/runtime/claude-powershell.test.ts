import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { main, type CommandIo } from '../../src/command.ts';
import { firstPwshOnPath, sessionStartOutput, storePowerShellWarning, type PresentAt } from '../../src/runtime/claude-powershell.ts';

const store = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps';
const msi = 'C:\\Program Files\\PowerShell\\7';
const git = 'C:\\Program Files\\Git\\cmd';

/** A file system holding exactly these paths. */
const holding = (...paths: string[]): PresentAt => {
  const present = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => present.has(path.toLowerCase());
};

// R12 of the skill surface corrections: the plugin warns a Windows user whose PowerShell 7 is the Microsoft Store build.
describe('the Store PowerShell warning', () => {
  it('finds the first pwsh.exe in PATH order, as Claude Code does, ignoring empty and quoted entries', () => {
    const files = holding(`${store}\\pwsh.exe`, `${msi}\\pwsh.exe`);
    assert.equal(firstPwshOnPath({ PATH: `${git};;"${msi}";${store}` }, files), `${msi}\\pwsh.exe`);
    assert.equal(firstPwshOnPath({ PATH: `${store};${msi}` }, files), `${store}\\pwsh.exe`);
    assert.equal(firstPwshOnPath({ PATH: git }, files), null);
    assert.equal(firstPwshOnPath({}, files), null, 'no PATH at all');
    // Windows spells the variable Path as often as PATH.
    assert.equal(firstPwshOnPath({ Path: store }, files), `${store}\\pwsh.exe`);
  });

  it('warns on Windows when the first pwsh.exe is the Store alias and the PowerShell tool is on, naming both workarounds, the recommended one first', () => {
    const warning = storePowerShellWarning('win32', { Path: `${git};${store};${msi}` }, holding(`${store}\\pwsh.exe`, `${msi}\\pwsh.exe`));
    assert.ok(warning !== null);
    assert.ok(warning.startsWith(`deep-review: PowerShell 7 on this machine is the Microsoft Store build (${store}\\pwsh.exe).`), warning);
    assert.ok(warning.includes('https://github.com/anthropics/claude-code/issues/102430'));
    const off = warning.indexOf('"env": { "CLAUDE_CODE_USE_POWERSHELL_TOOL": "0" }');
    const keep = warning.indexOf('install PowerShell 7 from the MSI or the zip');
    assert.ok(off > 0 && keep > off, 'turning the tool off comes first, keeping PowerShell second');
    assert.match(warning, /which needs Git for Windows/);
    // The Store's own folder, under the package name, is the alias too.
    assert.notEqual(storePowerShellWarning('win32', { PATH: `${store}\\Microsoft.PowerShell_8wekyb3d8bbwe` }, holding(`${store}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`)), null);
  });

  it('says nothing off Windows, with the PowerShell tool off, with a PowerShell 7 that is not the Store build first, or with none', () => {
    const files = holding(`${store}\\pwsh.exe`, `${msi}\\pwsh.exe`);
    assert.equal(storePowerShellWarning('linux', { PATH: store }, files), null);
    assert.equal(storePowerShellWarning('darwin', { PATH: store }, files), null);
    assert.equal(storePowerShellWarning('win32', { PATH: store, CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' }, files), null, 'the recommended workaround applied');
    assert.equal(storePowerShellWarning('win32', { PATH: store, claude_code_use_powershell_tool: '0' }, files), null, 'Windows reads the name in any case');
    assert.notEqual(storePowerShellWarning('win32', { PATH: store, CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }, files), null, 'the tool turned on');
    assert.equal(storePowerShellWarning('win32', { PATH: `${msi};${store}` }, files), null, 'the other workaround applied');
    assert.equal(storePowerShellWarning('win32', { PATH: git }, files), null, 'no PowerShell 7, so Windows PowerShell 5.1');
  });

  it('prints the warning as a systemMessage, which Claude Code shows the user, and nothing at all otherwise', () => {
    assert.equal(sessionStartOutput(null), '');
    const printed = sessionStartOutput('a "quoted" warning');
    assert.ok(printed.endsWith('\n'));
    assert.deepEqual(JSON.parse(printed), { systemMessage: 'a "quoted" warning' });
  });
});

describe('deep-review hook session-start', () => {
  let root: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deep-review-hook-'));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const io = (environment: NodeJS.ProcessEnv): CommandIo => ({ stdout: (text) => out.push(text), stderr: (text) => err.push(text), environment, cwd: root });

  it('prints the warning on Windows with the Store alias first on PATH, nothing elsewhere, and exits 0 outside any repository', async () => {
    const alias = join(root, 'Microsoft', 'WindowsApps');
    mkdirSync(alias, { recursive: true });
    writeFileSync(join(alias, 'pwsh.exe'), '');
    assert.equal(await main(['hook', 'session-start'], io({ PATH: alias })), 0, err.join(''));
    if (process.platform === 'win32') {
      assert.match((JSON.parse(out.join('')) as { systemMessage: string }).systemMessage, /^deep-review: PowerShell 7 on this machine is the Microsoft Store build/);
    } else {
      assert.equal(out.join(''), '', 'no warning off Windows');
    }
    out.length = 0;
    assert.equal(await main(['hook', 'session-start'], io({ PATH: alias, CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' })), 0);
    assert.equal(out.join(''), '');
    assert.equal(err.join(''), '');
  });

  it('refuses a hook it does not have and a flag, with the usage', async () => {
    for (const args of [['hook'], ['hook', 'session-end'], ['hook', 'session-start', 'extra'], ['hook', 'session-start', '--json']]) {
      err.length = 0;
      assert.equal(await main(args, io({})), 1, args.join(' '));
      assert.match(err.join(''), /usage:/, args.join(' '));
    }
  });
});
