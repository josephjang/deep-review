import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeAdapter } from '../../src/runtime/adapter.ts';
import { UnknownRuntimeError } from '../../src/runtime/errors.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';

const adapter = (name: string, effortLevels: RuntimeAdapter['capabilities']['effortLevels'] = ['low']): RuntimeAdapter => ({
  name,
  capabilities: { assignsSessionId: false, budgetCap: false, denialEvidence: false, withholdShell: false, readOnlyScratch: false, effortLevels, resume: false },
  qualification: { version: { args: ['--version'], pattern: /^(\S+)$/ }, help: [] },
  command: () => ({ args: [], environment: {} }),
  decode: () => ({ sessionIds: [], usage: null, denials: null, result: { kind: 'failed', error: 'never run' } }),
});

describe('RuntimeRegistry', () => {
  it('looks adapters up by name and lists the names sorted', () => {
    const first = adapter('zeta');
    const second = adapter('alpha-two');
    const registry = new RuntimeRegistry([first, second]);
    assert.equal(registry.get('zeta'), first);
    assert.equal(registry.get('alpha-two'), second);
    assert.deepEqual(registry.names(), ['alpha-two', 'zeta']);
  });

  it('registers after construction and chains', () => {
    const registry = new RuntimeRegistry().register(adapter('one')).register(adapter('two'));
    assert.deepEqual(registry.names(), ['one', 'two']);
  });

  it('refuses a name registered twice', () => {
    const registry = new RuntimeRegistry([adapter('claude')]);
    assert.throws(() => registry.register(adapter('claude')), /already registered/);
    assert.throws(() => new RuntimeRegistry([adapter('codex'), adapter('codex')]), /already registered/);
  });

  it('refuses a malformed name and a runtime with no effort level', () => {
    for (const name of ['', 'Claude', 'two words', '-lead', 'trail-', 'a--b', 'a_b']) {
      assert.throws(() => new RuntimeRegistry([adapter(name)]), /lowercase words/, name);
    }
    assert.throws(() => new RuntimeRegistry([adapter('pi', [])]), /no effort level/);
  });

  it('names the unknown runtime and the registered ones', () => {
    const registry = new RuntimeRegistry([adapter('claude'), adapter('codex')]);
    assert.throws(
      () => registry.get('pi'),
      (error: unknown) => error instanceof UnknownRuntimeError && error.runtime === 'pi' && /registered: claude, codex/.test(error.message),
    );
    assert.throws(() => new RuntimeRegistry().get('pi'), /registered: none/);
  });
});
