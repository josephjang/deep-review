import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeSpan, inlineText, paragraphText, tableCell } from '../../src/review/markdown.ts';

describe('codeSpan', () => {
  it('quotes plain text in single backticks', () => {
    assert.equal(codeSpan('npm run lint'), '`npm run lint`');
    assert.equal(codeSpan('node "/a/main.mjs" answer'), '`node "/a/main.mjs" answer`');
  });

  it('uses a delimiter one backtick longer than the longest run inside, so the text cannot close the span', () => {
    assert.equal(codeSpan('echo `date` now'), '``echo `date` now``');
    assert.equal(codeSpan('a ``b`` c'), '```a ``b`` c```');
    assert.equal(codeSpan('a``b`c'), '```a``b`c```', 'the longest run, wherever it is');
  });

  it('pads with a space a text that starts or ends with a backtick, which would otherwise join the delimiter', () => {
    assert.equal(codeSpan('`x'), '`` `x ``');
    assert.equal(codeSpan('echo `date`'), '`` echo `date` ``');
  });

  it('pads a text that both starts and ends with a space, which a renderer would otherwise strip', () => {
    assert.equal(codeSpan(' x '), '`  x  `');
    assert.equal(codeSpan(' x'), '` x`', 'a space at one end only is kept as it is');
    assert.equal(codeSpan('   '), '`   `', 'a blank text is not padded');
  });
});

describe('inlineText', () => {
  it('joins every line with one space, whatever the line ending and the blanks around it', () => {
    assert.equal(inlineText('one\ntwo\r\nthree\rfour'), 'one two three four');
    assert.equal(inlineText('a  \n\n  ## b'), 'a ## b');
    assert.equal(inlineText('no break'), 'no break');
    assert.equal(inlineText(''), '');
  });
});

describe('paragraphText', () => {
  it('escapes a leading character that would open a block', () => {
    for (const opener of ['#', '>', '-', '+', '*', '=', '|', '`', '~']) assert.equal(paragraphText(`${opener} text`), `\\${opener} text`, opener);
    assert.equal(paragraphText('## heading'), '\\## heading');
    assert.equal(paragraphText('```js'), '\\```js');
  });

  it('escapes the punctuation of an ordered list marker', () => {
    assert.equal(paragraphText('1. first'), '1\\. first');
    assert.equal(paragraphText('12) twelfth'), '12\\) twelfth');
    assert.equal(paragraphText('2026 was a year'), '2026 was a year', 'a number without list punctuation is text');
  });

  it('drops leading blanks, which could open a code block, and joins lines', () => {
    assert.equal(paragraphText('    indented'), 'indented');
    assert.equal(paragraphText('fine\n## not a heading'), 'fine ## not a heading');
    assert.equal(paragraphText('\n# after a break'), '\\# after a break');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(paragraphText('null dereference at line 4'), 'null dereference at line 4');
    assert.equal(paragraphText(''), '');
  });
});

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
