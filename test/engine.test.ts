import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { engineVersion } from '../src/engine.ts';

describe('engineVersion', () => {
  it('is the version in package.json', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };
    assert.equal(engineVersion(), manifest.version);
    assert.match(engineVersion(), /^\d+\.\d+\.\d+$/);
  });
});
