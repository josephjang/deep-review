/**
 * Node's on-disk compile cache for every Node process a test run starts.
 * The suite starts thousands of them (the fake runtimes, the CLI, the
 * stand-in checks), and each compiles the same TypeScript modules from
 * scratch; with the cache, a process reuses the code an earlier one
 * compiled. test/setup.ts turns it on through enableCompileCache.
 */
import module from 'node:module';
import { isAbsolute, resolve } from 'node:path';

/** Where the suite keeps the cache unless the environment names another: under node_modules/, which git ignores and `npm ci` clears. */
export const defaultCompileCacheDirectory = resolve(import.meta.dirname, '../../node_modules/.cache/node-compile-cache');

/**
 * The directory the cache should use, or null when it should stay off.
 * NODE_DISABLE_COMPILE_CACHE turns it off whatever its value, as it does
 * for Node itself. A directory NODE_COMPILE_CACHE names is kept, made
 * absolute against `cwd`: Node reads a relative one against each process's
 * own working directory, and the processes a test starts run in sandboxes.
 */
export function compileCacheDirectory(environment: NodeJS.ProcessEnv, cwd: string): string | null {
  if (environment.NODE_DISABLE_COMPILE_CACHE !== undefined) return null;
  const named = environment.NODE_COMPILE_CACHE;
  if (named === undefined || named === '') return defaultCompileCacheDirectory;
  return isAbsolute(named) ? named : resolve(cwd, named);
}

/**
 * Turn the cache on for this process, and through NODE_COMPILE_CACHE for
 * every Node process it starts, which inherit the variable. Setting the
 * variable reaches only the children: this process reads it at its own
 * start, so it is enabled here directly.
 */
export function enableCompileCache(environment: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): void {
  const directory = compileCacheDirectory(environment, cwd);
  if (directory === null) return;
  environment.NODE_COMPILE_CACHE = directory;
  module.enableCompileCache(directory);
}
