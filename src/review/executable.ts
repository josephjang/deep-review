/**
 * Which binary a runtime name stands for (TD10 of the runtime adapter, kept
 * by the read-only review): resolved on PATH once, at the command line,
 * recorded on the configuration event and never resolved again.
 */
import { realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { spellingsOf } from '../runtime/environment.ts';
import { ReviewRefusedError } from './errors.ts';

/** The extensions a Windows shell tries for a bare command name, in its order, when PATHEXT says nothing. */
const defaultPathExt = ['.COM', '.EXE', '.BAT', '.CMD'];

/** Extensions of the shims a spawn without a shell cannot start. */
const shellShims = new Set(['.cmd', '.bat']);

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Refuse an executable that is a shell shim, naming the flag that takes another. */
export function refuseShim(executable: string, flag = '--executable'): string {
  if (shellShims.has(extname(executable).toLowerCase())) {
    throw new ReviewRefusedError(
      `${executable} is a ${extname(executable)} shim, which cannot be spawned without a shell; pass ${flag} with the runtime's real executable (for an npm install, the node binary with --executable-arg naming the CLI's entry script)`,
      'runtime-unqualified',
    );
  }
  return executable;
}

/**
 * The absolute path of `name` on PATH, the first match in PATH order and,
 * on Windows, in PATHEXT order for a name without an extension. A `.cmd`
 * or `.bat` result is refused by name. A name given as a path is made
 * absolute and must exist.
 */
export function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): string {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const absolute = resolve(cwd, name);
    if (!isFile(absolute)) throw new ReviewRefusedError(`${absolute} is not a file; pass --executable with the runtime's executable`, 'runtime-unqualified');
    return refuseShim(realpathSync.native(absolute));
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
      if (isFile(candidate)) return refuseShim(realpathSync.native(candidate));
    }
  }
  throw new ReviewRefusedError(`no ${name} was found on PATH; install the runtime or pass --executable with its path`, 'runtime-unqualified');
}
