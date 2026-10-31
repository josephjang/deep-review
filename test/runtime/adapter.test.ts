import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maxDecodeBytes, maxLineBytes, outputLines, readEvents } from '../../src/runtime/adapter.ts';

const lines = (text: string | Buffer, maxBytes?: number): (string | null)[] => [...outputLines(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), maxBytes)];

describe('outputLines', () => {
  it('yields nothing for an empty stream', () => {
    assert.deepEqual(lines(''), []);
  });

  it('splits at line feeds, with the bytes after the last one as one more line', () => {
    assert.deepEqual(lines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(lines('a\nb'), ['a', 'b']);
    assert.deepEqual(lines('\n\na'), ['', '', 'a']);
    assert.deepEqual(lines('\n'), ['']);
  });

  it('drops the carriage return that ends a CRLF line, and keeps one inside a line', () => {
    assert.deepEqual(lines('{"a":1}\r\n\r\n{"b":2}\r\n'), ['{"a":1}', '', '{"b":2}']);
    assert.deepEqual(lines('a\rb\r\nc\r'), ['a\rb', 'c']);
    assert.deepEqual(lines('\r\r\n'), ['\r']);
  });

  it('decodes each line as UTF-8, a character outside the BMP whole and an invalid byte as U+FFFD', () => {
    assert.deepEqual(lines('café\n\u{1F600}\n'), ['café', '\u{1F600}']);
    assert.deepEqual(lines(Buffer.from([0x61, 0xff, 0x0a, 0x62])), ['a�', 'b']);
  });

  it('yields null for a line over the limit in bytes, not characters, and goes on with the next', () => {
    assert.deepEqual(lines('abc\nabcd\r\nab', 3), ['abc', null, 'ab']);
    // Two characters, four bytes.
    assert.deepEqual(lines('éé\né', 3), [null, 'é']);
    // The dropped carriage return does not count toward the limit.
    assert.deepEqual(lines('abc\r\n', 3), ['abc']);
    assert.deepEqual(lines('abcd', 3), [null]);
  });

  it('is re-iterable, and decodes a line only when the iteration reaches it', () => {
    const bytes = Buffer.from('one\ntwo\n');
    const iterable = outputLines(bytes);
    assert.deepEqual([...iterable], ['one', 'two']);
    assert.deepEqual([...iterable], ['one', 'two']);
    const iterator = iterable[Symbol.iterator]();
    assert.deepEqual(iterator.next(), { value: 'one', done: false });
    bytes.write('TWO', 4);
    assert.deepEqual(iterator.next(), { value: 'TWO', done: false });
    assert.equal(iterator.next().done, true);
  });

  it('allows a line longer than the cap on a whole output, since one event can carry all a command printed', () => {
    assert.ok(maxLineBytes > maxDecodeBytes);
  });
});

describe('readEvents', () => {
  const read = (lines: (string | null)[]): { malformed: string | null; events: unknown[] } => {
    const events: unknown[] = [];
    const malformed = readEvents(lines, 'Runtime', (event) => events.push(event));
    return { malformed, events };
  };

  it('passes each event object to the observer in order and returns null for a stream with none malformed', () => {
    assert.deepEqual(read([]), { malformed: null, events: [] });
    assert.deepEqual(read(['{"a":1}', '', '  ', '{"b":2}']), { malformed: null, events: [{ a: 1 }, { b: 2 }] });
  });

  it('names the runtime and the line, blank lines counted, of a line too long, not JSON or not an object', () => {
    assert.equal(read(['', null]).malformed, `Runtime printed line 2 that is longer than the ${String(maxLineBytes)} bytes the launcher decodes as one line`);
    assert.match(read(['{}', '', '{"a":']).malformed ?? '', /^Runtime printed line 3 that is not JSON: /);
    for (const bad of ['[1]', 'null', '"text"', '7']) assert.equal(read([bad]).malformed, 'Runtime printed line 1 that is not an event object');
  });

  it('keeps the first malformed line and still observes every event after it', () => {
    assert.deepEqual(read(['{"a":1}', '[1]', '{"b":2}', 'x', null, '{"c":3}']), {
      malformed: 'Runtime printed line 2 that is not an event object',
      events: [{ a: 1 }, { b: 2 }, { c: 3 }],
    });
  });
});
