import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pinVariables, spellingsOf, withoutVariables } from '../../src/runtime/environment.ts';

describe('environment helpers', () => {
  it('finds every spelling of a name', () => {
    assert.deepEqual(spellingsOf({ Path: 'a', PATH: 'b', PATHEXT: 'c' }, 'path'), [['Path', 'a'], ['PATH', 'b']]);
    assert.deepEqual(spellingsOf({ HOME: 'h' }, 'path'), []);
  });

  it('removes every spelling and leaves other names alone', () => {
    assert.deepEqual(withoutVariables({ temp: '1', TEMP: '2', Tmp: '3', TEMPLATE: '4' }, ['TEMP', 'TMP']), { TEMPLATE: '4' });
    assert.deepEqual(withoutVariables({}, ['TEMP']), {});
  });

  it('pins one spelling over any inherited one', () => {
    const pinned = pinVariables({ tmpdir: '/old', TmpDir: '/older', HOME: '/h' }, { TMPDIR: '/new' });
    assert.deepEqual(pinned, { HOME: '/h', TMPDIR: '/new' });
  });

  it('does not change its input', () => {
    const inherited = { TEMP: '/old' };
    pinVariables(inherited, { TEMP: '/new' });
    assert.deepEqual(inherited, { TEMP: '/old' });
  });
});
