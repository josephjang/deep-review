import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tableCell } from '../../src/review/markdown.ts';

describe('tableCell', () => {
  it('leaves plain text alone', () => {
    assert.equal(tableCell('src/a.ts'), 'src/a.ts');
    assert.equal(tableCell(''), '');
  });

  it('escapes every pipe, so the text stays one cell', () => {
    assert.equal(tableCell('a | b|c'), 'a \\| b\\|c');
  });

  it('turns every line break into a space, so the text stays one row', () => {
    assert.equal(tableCell('one\ntwo\r\nthree'), 'one two three');
    assert.equal(tableCell('a\n| b'), 'a \\| b');
  });
});
