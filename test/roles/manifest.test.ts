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
  rejects('rejects a fragment name with a parent directory part', { schemaVersion: 1, roles: { r: ['../a.md'] } }, /fragment name/);
  rejects('rejects a fragment name with a slash', { schemaVersion: 1, roles: { r: ['sub/a.md'] } }, /fragment name/);
  rejects('rejects a fragment name in upper case', { schemaVersion: 1, roles: { r: ['Lead.md'] } }, /fragment name/);
  rejects('rejects a fragment name without the .md extension', { schemaVersion: 1, roles: { r: ['lead.txt'] } }, /fragment name/);
  rejects('rejects a fragment name with a double dash', { schemaVersion: 1, roles: { r: ['lead--brief.md'] } }, /fragment name/);
  rejects('rejects a value that is not an object', 'roles', /Invalid role manifest/);
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
