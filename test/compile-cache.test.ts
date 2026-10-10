import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, type TestContext } from 'node:test';
import { compileCacheDirectory, defaultCompileCacheDirectory } from './helpers/compile-cache.ts';

const setup = pathToFileURL(resolve(import.meta.dirname, 'setup.ts')).href;

/**
 * A new temporary directory by its real path, removed when the test `t`
 * ends. A process started in it reports its working directory with every
 * link resolved (on macOS the temporary directory sits under /var, a link
 * to /private/var), so a path the test expects is built from the same form.
 */
function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'compile-cache-')));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** This process's environment without either compile cache variable, so a child starts as a developer's shell would. */
function plainEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_COMPILE_CACHE;
  delete environment.NODE_DISABLE_COMPILE_CACHE;
  return environment;
}

/**
 * What a process that preloads test/setup.ts sees, run in `cwd`: its own
 * cache directory, the NODE_COMPILE_CACHE it leaves its children, and the
 * cache directory of a child it starts in another working directory.
 */
function preloaded(cwd: string, environment: NodeJS.ProcessEnv, elsewhere: string): { readonly own: string | null; readonly variable: string | null; readonly child: string | null } {
  const script = [
    "const { spawnSync } = require('node:child_process');",
    "const own = require('node:module').getCompileCacheDir() ?? null;",
    "const child = spawnSync(process.execPath, ['-e', \"process.stdout.write(String(require('node:module').getCompileCacheDir() ?? ''))\"], { cwd: process.argv[1], encoding: 'utf8' }).stdout || null;",
    'process.stdout.write(JSON.stringify({ own, variable: process.env.NODE_COMPILE_CACHE ?? null, child }));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['--import', setup, '-e', script, elsewhere], { cwd, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { own: string | null; variable: string | null; child: string | null };
}

describe('compileCacheDirectory', () => {
  const cwd = resolve(tmpdir(), 'somewhere');

  it('uses the suite\'s directory under node_modules when the environment names none', () => {
    assert.equal(compileCacheDirectory({}, cwd), defaultCompileCacheDirectory);
    assert.equal(compileCacheDirectory({ NODE_COMPILE_CACHE: '' }, cwd), defaultCompileCacheDirectory);
    assert.ok(defaultCompileCacheDirectory.endsWith(join('node_modules', '.cache', 'node-compile-cache')), defaultCompileCacheDirectory);
  });

  it('keeps the directory NODE_COMPILE_CACHE names, made absolute against the working directory', () => {
    const absolute = resolve(tmpdir(), 'cache');
    assert.equal(compileCacheDirectory({ NODE_COMPILE_CACHE: absolute }, cwd), absolute);
    assert.equal(compileCacheDirectory({ NODE_COMPILE_CACHE: 'cache' }, cwd), resolve(cwd, 'cache'));
  });

  it('stays off whenever NODE_DISABLE_COMPILE_CACHE is set, whatever its value, as for Node itself', () => {
    for (const value of ['1', '0', 'false', '']) {
      assert.equal(compileCacheDirectory({ NODE_DISABLE_COMPILE_CACHE: value, NODE_COMPILE_CACHE: 'cache' }, cwd), null, JSON.stringify(value));
    }
  });
});

describe('the compile cache test/setup.ts turns on', () => {
  it('serves the test process and every Node process it starts, in whatever directory that one runs', (t) => {
    const seen = preloaded(resolve(import.meta.dirname, '..'), plainEnvironment(), temporaryDirectory(t));
    assert.equal(seen.variable, defaultCompileCacheDirectory);
    assert.ok(seen.own?.startsWith(defaultCompileCacheDirectory + sep), String(seen.own));
    assert.ok(seen.child?.startsWith(defaultCompileCacheDirectory + sep), String(seen.child));
  });

  it('hands its children a relative NODE_COMPILE_CACHE resolved against its own working directory', (t) => {
    const cwd = temporaryDirectory(t);
    const seen = preloaded(cwd, { ...plainEnvironment(), NODE_COMPILE_CACHE: 'cache' }, temporaryDirectory(t));
    const expected = resolve(cwd, 'cache');
    assert.equal(seen.variable, expected);
    assert.ok(seen.own?.startsWith(expected + sep), String(seen.own));
    assert.ok(seen.child?.startsWith(expected + sep), String(seen.child));
  });

  it('turns nothing on when NODE_DISABLE_COMPILE_CACHE is set', (t) => {
    const seen = preloaded(resolve(import.meta.dirname, '..'), { ...plainEnvironment(), NODE_DISABLE_COMPILE_CACHE: '1' }, temporaryDirectory(t));
    assert.deepEqual(seen, { own: null, variable: null, child: null });
  });
});
