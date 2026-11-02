import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findingMarker, lastLineMarker, markerLine, publicationMarker } from '../../src/review/markers.ts';

describe('the markers of publish (TD5 of the review on the pull request)', () => {
  it('reads back from the last line the marker markerLine writes there', () => {
    for (const marker of [publicationMarker('run-1', 2), findingMarker('run-1', 'SCAN-1')]) {
      assert.equal(lastLineMarker(`The review.\n\n${markerLine(marker)}`), marker);
      assert.equal(lastLineMarker(`The review.\r\n${markerLine(marker)}\n  \n`), marker, 'trailing blank lines and CRLF are no last line');
    }
  });

  it('reads no marker that is not on the last line, and none from an empty text', () => {
    assert.equal(lastLineMarker(`${markerLine(publicationMarker('run-1', 1))}\nA worker's text after it.`), null);
    assert.equal(lastLineMarker(''), null);
  });

  it('names the run and the serial or the finding, as the ledger schema of a marker takes them', () => {
    assert.equal(publicationMarker('run-1', 3), 'deep-review publication run-1 3');
    assert.equal(findingMarker('run-1', 'SCAN-1'), 'deep-review finding run-1 SCAN-1');
  });
});
