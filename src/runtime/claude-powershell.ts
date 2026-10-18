/**
 * The warning the Claude Code plugin shows when a session starts on a
 * machine whose PowerShell 7 is the Microsoft Store build (R12 of the
 * skill surface corrections). With that build, Claude Code cannot check
 * any command of its PowerShell tool, so each command asks for approval,
 * the skill's too: https://github.com/anthropics/claude-code/issues/102430.
 * The plugin cannot change the session's environment, so it says how; when
 * Claude Code fixes the fault, this module and its hook come out.
 */
import { lstatSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { spellingsOf } from './environment.ts';

/** Whether a file is present at a path. The Store's `pwsh.exe` is an app execution alias, which `lstat` sees and `stat`, `realpath` and `existsSync` do not. */
export type PresentAt = (path: string) => boolean;

const lstatPresent: PresentAt = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** The first `pwsh.exe` on `PATH` on Windows, as Claude Code finds PowerShell 7 for its tool, or null when there is none. */
export function firstPwshOnPath(environment: NodeJS.ProcessEnv, present: PresentAt = lstatPresent): string | null {
  const path = spellingsOf(environment, 'PATH', 'win32').map(([, value]) => value ?? '').find((value) => value.length > 0) ?? '';
  for (const directory of path.split(win32.delimiter)) {
    const trimmed = directory.replaceAll('"', '').trim();
    if (trimmed.length === 0) continue;
    const candidate = win32.join(trimmed, 'pwsh.exe');
    if (present(candidate)) return candidate;
  }
  return null;
}

/** Whether a path is in the folder of the Microsoft Store's app execution aliases. */
const isStoreAlias = (path: string): boolean => posix.normalize(path.replaceAll('\\', '/')).toLowerCase().includes('/microsoft/windowsapps/');

/**
 * The warning for this session, or null: only on Windows, only while the
 * PowerShell tool is on (Claude Code turns it off when
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL` is `0`, which a session's settings
 * `env` passes to its hooks), and only when the first `pwsh.exe` on `PATH`
 * is the Store's alias. With no `pwsh.exe`, Claude Code uses Windows
 * PowerShell 5.1, whose commands it can check.
 */
export function storePowerShellWarning(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, present: PresentAt = lstatPresent): string | null {
  if (platform !== 'win32') return null;
  if (spellingsOf(environment, 'CLAUDE_CODE_USE_POWERSHELL_TOOL', platform).some(([, value]) => value === '0')) return null;
  const pwsh = firstPwshOnPath(environment, present);
  if (pwsh === null || !isStoreAlias(pwsh)) return null;
  return [
    `deep-review: PowerShell 7 on this machine is the Microsoft Store build (${pwsh}).`,
    'With it, Claude Code cannot check the commands of its PowerShell tool, so each one asks for approval, deep-review\'s too (https://github.com/anthropics/claude-code/issues/102430).',
    'To fix it, add "env": { "CLAUDE_CODE_USE_POWERSHELL_TOOL": "0" } to ~/.claude/settings.json, so that Claude Code uses Git Bash, which needs Git for Windows.',
    'To keep PowerShell instead, install PowerShell 7 from the MSI or the zip and put its folder before %LOCALAPPDATA%\\Microsoft\\WindowsApps on PATH.',
  ].join(' ');
}

/** What the plugin's SessionStart hook prints: the warning as the `systemMessage` that Claude Code shows the user, or nothing, since plain output would go to the model instead. */
export function sessionStartOutput(warning: string | null): string {
  return warning === null ? '' : `${JSON.stringify({ systemMessage: warning })}\n`;
}
