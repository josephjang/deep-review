/**
 * Which binary a runtime name stands for (TD10 of the runtime adapter, kept
 * by the read-only review): resolved on PATH once, at the command line,
 * recorded on the configuration event and never resolved again.
 */
import { realpathSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { isFile } from '../paths.ts';
import { spellingsOf } from '../runtime/environment.ts';
import { ReviewRefusedError } from './errors.ts';

/** The extensions a Windows shell tries for a bare command name, in its order, when PATHEXT says nothing. */
const defaultPathExt = ['.COM', '.EXE', '.BAT', '.CMD'];

/** Extensions of the shims a spawn without a shell cannot start, refused on every platform. */
const shellShims = new Set(['.cmd', '.bat']);

/**
 * The only extensions Windows starts without a shell. Probed on Node 26: a
 * `.cmd` fails the spawn with EINVAL; a `.ps1`, `.vbs` or `.js` with EFTYPE;
 * a file without an extension with ENOENT. Refusing them here names the
 * cause at the command line instead of a misleading error at preflight.
 */
const windowsSpawnable = new Set(['.exe', '.com']);

/**
 * What a refusal of an executable names as its action, and its blocker
 * code: for one that is not on PATH or not a file, and for one a spawn
 * without a shell cannot start.
 */
export interface ExecutableAdvice {
  readonly missing: string;
  readonly notFile: string;
  readonly unspawnable: string;
  readonly code: string | null;
}

/** The advice for a runtime's executable, which `--executable` names. */
export const runtimeExecutableAdvice: ExecutableAdvice = {
  missing: 'install the runtime or pass --executable with its path',
  notFile: "pass --executable with the runtime's executable",
  unspawnable: "pass --executable with the runtime's real executable (for an npm install, the node binary with --executable-arg naming the CLI's entry script)",
  code: 'runtime-unqualified',
};

/** The advice for the executable of `gh`, which `github.executable` names (R15 of the review on the pull request). */
export const githubExecutableAdvice: ExecutableAdvice = {
  missing: 'install the GitHub CLI, gh, or set github.executable to its path',
  notFile: "set github.executable to the path of gh's executable",
  unspawnable: "set github.executable to gh's own executable, with github.args for any argument it needs",
  code: null,
};

/** The refusal of an executable the launcher could not spawn, saying why and naming the action of `advice`. */
const unspawnable = (why: string, advice: ExecutableAdvice): ReviewRefusedError => new ReviewRefusedError(`${why}; ${advice.unspawnable}`, advice.code);

/**
 * Refuse an executable that a spawn without a shell cannot start: a `.cmd`
 * or `.bat` shim on any platform, and on Windows anything but a `.exe` or
 * `.com`. The extension is read the way `platform` spells paths, so a dot
 * in a Windows directory name is not taken for one.
 */
export function refuseShim(executable: string, platform: NodeJS.Platform = process.platform, advice: ExecutableAdvice = runtimeExecutableAdvice): string {
  const extension = (platform === 'win32' ? win32 : posix).extname(executable);
  if (shellShims.has(extension.toLowerCase())) {
    throw unspawnable(`${executable} is a ${extension} shim, which cannot be spawned without a shell`, advice);
  }
  if (platform === 'win32' && !windowsSpawnable.has(extension.toLowerCase())) {
    throw unspawnable(`${executable} is ${extension === '' ? 'a file without an extension' : `a ${extension} file`}, and Windows starts only a .exe or .com without a shell`, advice);
  }
  return executable;
}

/**
 * The absolute path of `name` on PATH, the first match in PATH order and,
 * on Windows, in PATHEXT order for a name without an extension. A result a
 * spawn without a shell cannot start is refused by name (`refuseShim`): a
 * `.cmd` or `.bat` shim anywhere, and on Windows anything but a `.exe` or
 * `.com`. A name given as a path is made absolute and must exist. Each
 * refusal names the action of `advice`: a runtime's by default.
 */
export function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd(), advice: ExecutableAdvice = runtimeExecutableAdvice): string {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const absolute = resolve(cwd, name);
    if (!isFile(absolute)) throw new ReviewRefusedError(`${absolute} is not a file; ${advice.notFile}`, advice.code);
    return refuseShim(realpathSync.native(absolute), platform, advice);
  }
  const path = spellingsOf(environment, 'PATH', platform).map(([, value]) => value ?? '').find((value) => value.length > 0) ?? '';
  const directories = path.split(delimiter).filter((directory) => directory.length > 0);
  const extensions = platform === 'win32'
    ? (extname(name) === '' ? (spellingsOf(environment, 'PATHEXT', platform)[0]?.[1]?.split(';').filter((extension) => extension.length > 0) ?? defaultPathExt) : [''])
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory.replaceAll('"', ''), `${name}${extension}`);
      // The path as the file system spells it, so a PATHEXT of `.EXE` records the file's own `claude.exe`.
      if (isFile(candidate)) return refuseShim(realpathSync.native(candidate), platform, advice);
    }
  }
  throw new ReviewRefusedError(`no ${name} was found on PATH; ${advice.missing}`, advice.code);
}
