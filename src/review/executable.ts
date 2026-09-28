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

/** The refusal of an executable the launcher could not spawn, saying why and naming the flag that takes another. */
const unspawnable = (why: string): ReviewRefusedError =>
  new ReviewRefusedError(
    `${why}; pass --executable with the runtime's real executable (for an npm install, the node binary with --executable-arg naming the CLI's entry script)`,
    'runtime-unqualified',
  );

/**
 * Refuse an executable that a spawn without a shell cannot start: a `.cmd`
 * or `.bat` shim on any platform, and on Windows anything but a `.exe` or
 * `.com`. The extension is read the way `platform` spells paths, so a dot
 * in a Windows directory name is not taken for one.
 */
export function refuseShim(executable: string, platform: NodeJS.Platform = process.platform): string {
  const extension = (platform === 'win32' ? win32 : posix).extname(executable);
  if (shellShims.has(extension.toLowerCase())) {
    throw unspawnable(`${executable} is a ${extension} shim, which cannot be spawned without a shell`);
  }
  if (platform === 'win32' && !windowsSpawnable.has(extension.toLowerCase())) {
    throw unspawnable(`${executable} is ${extension === '' ? 'a file without an extension' : `a ${extension} file`}, and Windows starts only a .exe or .com without a shell`);
  }
  return executable;
}

/**
 * The absolute path of `name` on PATH, the first match in PATH order and,
 * on Windows, in PATHEXT order for a name without an extension. A result a
 * spawn without a shell cannot start is refused by name (`refuseShim`): a
 * `.cmd` or `.bat` shim anywhere, and on Windows anything but a `.exe` or
 * `.com`. A name given as a path is made absolute and must exist.
 */
export function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): string {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const absolute = resolve(cwd, name);
    if (!isFile(absolute)) throw new ReviewRefusedError(`${absolute} is not a file; pass --executable with the runtime's executable`, 'runtime-unqualified');
    return refuseShim(realpathSync.native(absolute), platform);
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
      if (isFile(candidate)) return refuseShim(realpathSync.native(candidate), platform);
    }
  }
  throw new ReviewRefusedError(`no ${name} was found on PATH; install the runtime or pass --executable with its path`, 'runtime-unqualified');
}
