import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capitalized, codeSpan, counted, escapedText, findingAnchor, findingLink, inlineText, listed, localPathWords, paragraphText, quoted, sentenceText, tableCell } from '../../src/review/markdown.ts';

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

describe('counted', () => {
  it('takes the singular noun for one and the plural for every other count, zero included', () => {
    assert.equal(counted(1, 'fix goes', 'fixes go'), '1 fix goes');
    assert.equal(counted(0, 'fix goes', 'fixes go'), '0 fixes go');
    assert.equal(counted(2, 'fix goes', 'fixes go'), '2 fixes go');
    assert.equal(counted(1000, 'file', 'files'), '1000 files');
  });
});

describe('listed', () => {
  it('joins the last two words by and and any before them by commas, with nothing for no word', () => {
    assert.equal(listed([]), '');
    assert.equal(listed(['a']), 'a');
    assert.equal(listed(['a', 'b']), 'a and b');
    assert.equal(listed(['a', 'b', 'c']), 'a, b and c');
    assert.equal(listed(['a', 'b', 'c', 'd']), 'a, b, c and d');
  });
});

describe('capitalized', () => {
  it('puts the first character in upper case and leaves the rest, an empty text and a capital as they are', () => {
    assert.equal(capitalized('the fixer of c1-1'), 'The fixer of c1-1');
    assert.equal(capitalized('deep-review commit'), 'Deep-review commit');
    assert.equal(capitalized('Already'), 'Already');
    assert.equal(capitalized(''), '');
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

describe('findingAnchor and findingLink (R6 of the report for the person)', () => {
  it('anchors a finding by its number, and links to it with the number as the text', () => {
    assert.equal(findingAnchor(12), 'finding-12');
    assert.equal(findingLink(1), '[finding 1](#finding-1)');
  });
});

describe('escapedText (R11, TD6 of the report for the person)', () => {
  it('escapes a tag, a double underscore and an asterisk outside a code span, and nothing inside one', () => {
    assert.equal(escapedText('reads <stdin> first'), 'reads \\<stdin> first');
    assert.equal(escapedText('calls __init__ twice'), 'calls \\_\\_init\\_\\_ twice');
    assert.equal(escapedText('a * b and snake_case'), 'a \\* b and snake_case');
    assert.equal(escapedText('`<stdin>`, `__init__` and `a * b`'), '`<stdin>`, `__init__` and `a * b`');
    assert.equal(escapedText('``a ` <b>`` and <c>'), '``a ` <b>`` and \\<c>');
  });

  it('leaves a backtick with no closer as text, and a character already escaped as it is', () => {
    assert.equal(escapedText('a ` then <b>'), 'a ` then \\<b>');
    assert.equal(escapedText('already \\<b> and \\*'), 'already \\<b> and \\*');
  });
});

describe('quoted (R6, PD13, TD5 of the report for the person)', () => {
  const numbers = new Map([['RIPPLE-3', 1], ['SWEEP-2', 1], ['REMOVALS-6', 2]]);

  it('adds the number after an id of another finding, and not after the quote\'s own, an id the run does not hold or an id in a code span', () => {
    assert.equal(quoted('as REMOVALS-6 says, and SWEEP-2 too', { numbers, own: 1 }), 'as REMOVALS-6 (finding 2) says, and SWEEP-2 too');
    assert.equal(quoted('see RIPPLE-3 and MADEUP-9', { numbers }), 'see RIPPLE-3 (finding 1) and MADEUP-9');
    assert.equal(quoted('see `RIPPLE-3`', { numbers }), 'see `RIPPLE-3`');
    assert.equal(quoted('see RIPPLE-3 (finding 1)', { numbers }), 'see RIPPLE-3 (finding 1)', 'once');
  });

  it('adds the number after a batch index that stands alone, and not after a name with an index', () => {
    const batch = ['REMOVALS-6', 'RIPPLE-3'];
    assert.equal(quoted('fixed [0] and [1]; [2] is not in the batch', { numbers, batch }), 'fixed [0] (finding 2) and [1] (finding 1); [2] is not in the batch');
    assert.equal(quoted('reads argv[0] and list[1][0]', { numbers, batch }), 'reads argv[0] and list[1][0]');
    assert.equal(quoted('fixed [0]', { numbers }), 'fixed [0]', 'a text with no batch has no index');
  });

  it('escapes what a preview would hide, after the aliases', () => {
    assert.equal(quoted('<stdin> for [0]', { numbers, batch: ['RIPPLE-3'] }), '\\<stdin> for [0] (finding 1)');
  });
});

describe('localPathWords (R15 of the brief of a run)', () => {
  const posix = { worktree: '/work/repo', home: '/home/me' };
  const windows = { worktree: 'C:\\Work\\Repo', home: 'C:\\Users\\Me' };

  it('names a path inside the worktree relative to it, with forward slashes', () => {
    assert.equal(localPathWords('/work/repo/.git/deep-review.toml', posix), '.git/deep-review.toml');
    assert.equal(localPathWords('/work/repo', posix), '.');
    assert.equal(localPathWords('c:\\work\\repo\\.git\\deep-review.toml', windows), '.git/deep-review.toml', 'without case on a Windows path');
  });

  it('names a path inside the home directory under ~, and leaves any other path as it is', () => {
    assert.equal(localPathWords('/home/me/.codex/AGENTS.md', posix), '~/.codex/AGENTS.md');
    assert.equal(localPathWords('/home/me', posix), '~');
    assert.equal(localPathWords('C:\\Users\\Me\\.claude\\CLAUDE.md', windows), '~/.claude/CLAUDE.md');
    assert.equal(localPathWords('/home/meant/notes.md', posix), '/home/meant/notes.md', 'a sibling that shares a prefix is not inside');
    assert.equal(localPathWords('/etc/deep-review.toml', posix), '/etc/deep-review.toml');
    assert.equal(localPathWords('/home/Me/x', posix), '/home/Me/x', 'with case on a POSIX path');
  });

  it('prefers the worktree to the home directory that holds it', () => {
    assert.equal(localPathWords('/home/me/repo/src/a.ts', { worktree: '/home/me/repo', home: '/home/me' }), 'src/a.ts');
  });

  it('keeps every character of a Windows path whose root changes length in lower case', () => {
    // 'İ' (U+0130) is one code unit, and two in lower case.
    const places = { worktree: 'C:\\Users\\İlker\\proj', home: 'C:\\Users\\İlker' };
    assert.equal(localPathWords('C:\\Users\\İlker\\.codex\\AGENTS.md', places), '~/.codex/AGENTS.md');
    assert.equal(localPathWords('C:\\Users\\İlker\\proj\\src\\x.ts', places), 'src/x.ts');
    assert.equal(localPathWords('c:\\users\\İlker\\proj', places), '.');
    assert.equal(localPathWords('C:\\Users\\İlkers\\x.ts', places), 'C:\\Users\\İlkers\\x.ts', 'a sibling that shares a prefix is not inside');
  });

  it('names nothing relative to an empty root', () => {
    assert.equal(localPathWords('/x/y', { worktree: '', home: '' }), '/x/y');
  });
});

describe('sentenceText', () => {
  it('ends a text with one stop, keeps its own mark, and turns a trailing colon, comma or semicolon into the stop', () => {
    assert.equal(sentenceText('guard the null'), 'guard the null.');
    assert.equal(sentenceText('guard it?'), 'guard it?');
    assert.equal(sentenceText('see (it is gone.)'), 'see (it is gone.)');
    assert.equal(sentenceText('as follows:'), 'as follows.');
    assert.equal(sentenceText('one\n## two'), 'one ## two.');
  });
});
