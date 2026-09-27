import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pinVariables, spellingsOf, withoutVariables, workerEnvironment } from '../../src/runtime/environment.ts';

describe('environment helpers on Windows, where names are case-insensitive', () => {
  it('finds every spelling of a name', () => {
    assert.deepEqual(spellingsOf({ Path: 'a', PATH: 'b', PATHEXT: 'c' }, 'path', 'win32'), [['Path', 'a'], ['PATH', 'b']]);
    assert.deepEqual(spellingsOf({ HOME: 'h' }, 'path', 'win32'), []);
  });

  it('removes every spelling and leaves other names alone', () => {
    assert.deepEqual(withoutVariables({ temp: '1', TEMP: '2', Tmp: '3', TEMPLATE: '4' }, ['TEMP', 'TMP'], 'win32'), { TEMPLATE: '4' });
    assert.deepEqual(withoutVariables({}, ['TEMP'], 'win32'), {});
  });

  it('pins one spelling over any inherited one', () => {
    const pinned = pinVariables({ tmpdir: '/old', TmpDir: '/older', HOME: '/h' }, { TMPDIR: '/new' }, 'win32');
    assert.deepEqual(pinned, { HOME: '/h', TMPDIR: '/new' });
  });
});

describe('environment helpers on POSIX, where names are exact', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`finds only the exact name on ${platform}`, () => {
      assert.deepEqual(spellingsOf({ Path: 'a', PATH: 'b', path: 'c' }, 'PATH', platform), [['PATH', 'b']]);
      assert.deepEqual(spellingsOf({ Path: 'a' }, 'PATH', platform), []);
    });

    it(`removes only the exact name on ${platform}, keeping a variable that differs in case`, () => {
      assert.deepEqual(withoutVariables({ temp: '1', TEMP: '2', Tmp: '3', TMP: '4' }, ['TEMP', 'TMP'], platform), { temp: '1', Tmp: '3' });
    });

    it(`pins the exact name on ${platform} and leaves its case variants as they were`, () => {
      const pinned = pinVariables({ tmpdir: '/old', TmpDir: '/older', TMPDIR: '/oldest', HOME: '/h' }, { TMPDIR: '/new' }, platform);
      assert.deepEqual(pinned, { tmpdir: '/old', TmpDir: '/older', HOME: '/h', TMPDIR: '/new' });
    });
  }
});

describe('environment helpers on any platform', () => {
  it('do not change their input', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const inherited = { TEMP: '/old', temp: '/lower' };
      pinVariables(inherited, { TEMP: '/new' }, platform);
      withoutVariables(inherited, ['TEMP'], platform);
      assert.deepEqual(inherited, { TEMP: '/old', temp: '/lower' });
    }
  });
});

describe('the worker environment the launcher pins (R7, R8)', () => {
  it('pins over case variants on Windows only, whatever platform the engine runs on', () => {
    const inherited = { tmp: '/inherited', MSBuildDisableNodeReuse: '0' };
    const windows = workerEnvironment(inherited, 'C:\\scratch', 'win32');
    assert.equal(windows.tmp, undefined);
    assert.equal(windows.MSBuildDisableNodeReuse, undefined);
    assert.equal(windows.TMP, 'C:\\scratch');
    for (const platform of ['linux', 'darwin'] as const) {
      const posix = workerEnvironment(inherited, '/scratch', platform);
      assert.equal(posix.tmp, '/inherited');
      assert.equal(posix.MSBuildDisableNodeReuse, '0');
      assert.equal(posix.TMP, '/scratch');
      assert.equal(posix.MSBUILDDISABLENODEREUSE, '1');
    }
  });

  it('writes TMPDIR with forward slashes on Windows only, where Git Bash reads it', () => {
    assert.equal(workerEnvironment({}, 'C:\\scratch\\worker', 'win32').TMPDIR, 'C:/scratch/worker');
    assert.equal(workerEnvironment({}, 'C:\\scratch\\worker', 'win32').TEMP, 'C:\\scratch\\worker');
    // A backslash is an ordinary filename character on POSIX.
    assert.equal(workerEnvironment({}, '/data/a\\b', 'linux').TMPDIR, '/data/a\\b');
    assert.equal(workerEnvironment({}, '/data/a\\b', 'darwin').TMP, '/data/a\\b');
    assert.equal(workerEnvironment({ TMPDIR: '/inherited' }, null, 'linux').TMPDIR, '/inherited');
  });
});
