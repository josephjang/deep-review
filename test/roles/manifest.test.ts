import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidRoleManifestError } from '../../src/roles/errors.ts';
import { fragmentNameSchema, parseRoleManifest, roleKeySchema } from '../../src/roles/manifest.ts';

const valid = { schemaVersion: 1, roles: { 'finder-SCAN': ['lead-brief.md', 'angles-scan.md'], verifier: ['lead-brief.md'] } };

describe('parseRoleManifest', () => {
  it('accepts a manifest and keeps the roles in their written order', () => {
    const manifest = parseRoleManifest(valid);
    assert.deepEqual(Object.keys(manifest.roles), ['finder-SCAN', 'verifier']);
    assert.deepEqual(manifest.roles['finder-SCAN'], ['lead-brief.md', 'angles-scan.md']);
  });

  const rejects = (name: string, value: unknown, pattern: RegExp): void => {
    it(name, () => {
      assert.throws(() => parseRoleManifest(value), (error: unknown) => error instanceof InvalidRoleManifestError && pattern.test(error.message));
    });
  };
  rejects('rejects a schema version it does not know', { ...valid, schemaVersion: 2 }, /schemaVersion/);
  rejects('rejects a top-level key it does not know', { ...valid, extra: true }, /extra/);
  rejects('rejects a manifest with no roles', { schemaVersion: 1, roles: {} }, /at least one role/);
  rejects('rejects a role with no fragments', { schemaVersion: 1, roles: { empty: [] } }, /empty/);
  rejects('rejects a role that names one fragment twice', { schemaVersion: 1, roles: { twice: ['a.md', 'b.md', 'a.md'] } }, /names a\.md twice[\s\S]*twice/);
  rejects('rejects a role key that starts with a digit', { schemaVersion: 1, roles: { '1st': ['a.md'] } }, /role key/);
  rejects('rejects a role key with a space', { schemaVersion: 1, roles: { 'has space': ['a.md'] } }, /role key/);
  rejects(
    'rejects role keys that differ only by case, naming both',
    { schemaVersion: 1, roles: { 'finder-SCAN': ['a.md'], verifier: ['b.md'], 'finder-scan': ['c.md'] } },
    /role keys finder-SCAN and finder-scan differ only by case[^\n]*\n[^\n]*roles\["finder-scan"\]/,
  );
  rejects(
    'rejects every key that collides by case with an earlier one',
    { schemaVersion: 1, roles: { a: ['a.md'], A: ['b.md'], B: ['c.md'], b: ['d.md'] } },
    /role keys a and A differ only by case[\s\S]*role keys B and b differ only by case/,
  );
  it('accepts role keys that share a spelling but differ by more than case', () => {
    const manifest = parseRoleManifest({ schemaVersion: 1, roles: { 'finder-SCAN': ['a.md'], 'finder-SCAN2': ['b.md'], finderSCAN: ['c.md'] } });
    assert.deepEqual(Object.keys(manifest.roles), ['finder-SCAN', 'finder-SCAN2', 'finderSCAN']);
  });
  rejects('rejects a fragment name with a parent directory part', { schemaVersion: 1, roles: { r: ['../a.md'] } }, /fragment name/);
  rejects('rejects a fragment name with a slash', { schemaVersion: 1, roles: { r: ['sub/a.md'] } }, /fragment name/);
  rejects('rejects a fragment name in upper case', { schemaVersion: 1, roles: { r: ['Lead.md'] } }, /fragment name/);
  rejects('rejects a fragment name without the .md extension', { schemaVersion: 1, roles: { r: ['lead.txt'] } }, /fragment name/);
  rejects('rejects a fragment name with a double dash', { schemaVersion: 1, roles: { r: ['lead--brief.md'] } }, /fragment name/);
  rejects('rejects a value that is not an object', 'roles', /Invalid role manifest/);

  // Only JSON.parse makes an own `__proto__` key; an object literal would set the prototype instead.
  describe('a role key __proto__ from JSON', () => {
    const roleKeyAtProto = /a role key is letters[^\n]*\n[^\n]*roles\.__proto__/;
    it('is refused beside a valid role rather than dropped', () => {
      const value: unknown = JSON.parse('{"schemaVersion":1,"roles":{"__proto__":["a.md"],"r":["b.md"]}}');
      assert.throws(() => parseRoleManifest(value), (error: unknown) => error instanceof InvalidRoleManifestError && roleKeyAtProto.test(error.message));
    });
    it('is refused by the role key rule when it is the only role', () => {
      const value: unknown = JSON.parse('{"schemaVersion":1,"roles":{"__proto__":["a.md"]}}');
      assert.throws(() => parseRoleManifest(value), (error: unknown) => error instanceof InvalidRoleManifestError && roleKeyAtProto.test(error.message) && !/at least one role/.test(error.message));
    });
    it('is refused even when its value is not a fragment list', () => {
      const value: unknown = JSON.parse('{"schemaVersion":1,"roles":{"__proto__":{"polluted":true},"r":["b.md"]}}');
      assert.throws(() => parseRoleManifest(value), (error: unknown) => error instanceof InvalidRoleManifestError && roleKeyAtProto.test(error.message));
      assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    });
  });
});

describe('roleKeySchema and fragmentNameSchema', () => {
  it('accept the shapes the repository uses', () => {
    for (const key of ['triage', 'finder-SCAN', 'merge-rank', 'a1']) assert.ok(roleKeySchema.safeParse(key).success, key);
    for (const name of ['lead-brief.md', 'angles-scan.md', 'step3-actions.md', 'a.md']) assert.ok(fragmentNameSchema.safeParse(name).success, name);
  });
  it('refuse a trailing dash, a dot in the stem and an empty stem', () => {
    assert.ok(!roleKeySchema.safeParse('trailing-').success);
    assert.ok(!fragmentNameSchema.safeParse('a.b.md').success);
    assert.ok(!fragmentNameSchema.safeParse('.md').success);
  });
});
