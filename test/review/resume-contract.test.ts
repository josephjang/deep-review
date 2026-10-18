// The contract of resumable runs (R1, R2 of resumable runs): a fix run on
// the fakes is stopped at each point of a fixed set, in each way that
// applies there, and the same command run again must keep the five parts
// of the contract against the same run with no stop, or fail the part a
// mark of a known failure names (test/helpers/resume-marks.ts). The fixed
// set holds the first and the last append of a phase, the launch and the
// end of a worker and of a check, a worker and a check while they run, the
// record of a revision, the step before the report is written, and
// `commit` before and after it moves the branch. `npm run resume-test`
// runs every point.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { brokenParts, pointOf, reference, stopAndResume, waysAt, type Reference } from '../helpers/resume-contract.ts';
import { marksOf, unexpected } from '../helpers/resume-marks.ts';
import { sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** The points the suite stops the engine at, by name (`pointOf`). */
const fixedPoints = [
  // The first append of the first phase, and the last of a phase of workers.
  'phase.started survey',
  'phase.finished finders',
  // A worker's launch and its end, before its answer is recorded (W5).
  'worker.launched triage triage:SCAN',
  'worker.finished triage triage:SCAN',
  // A worker while it runs at its last attempt, the first having failed (W1).
  'child finder-RIPPLE finders:RIPPLE#2',
  // The end of a check, and the last check before the fixes while it runs, the order of #25.
  'check.ran baseline-checks build',
  'child check test#1',
  // The check after the fixes that rewrites a file, while it runs after its write (W4).
  'child check lint#2',
  // A fixer while it runs, where a person then edits a file of the change (W8), and the record of its end with its answer and revision, one append since R6.
  'child fixer fixes:c1-1#1',
  'worker.finished fixer fixes:c1-1',
  // The last step before the report is written.
  'worktree.checked report start',
  // `commit` before and after it moves the branch (W6).
  'update-ref before',
  'update-ref after',
] as const;

describe('the contract of resumable runs', { timeout: 1_800_000, concurrency: sandboxConcurrency }, () => {
  let expected: Reference | null = null;
  before(async () => {
    expected = await reference();
  });

  it('stops only at points the run with no stop has', () => {
    const names = new Set([...expected!.appends, ...expected!.children, 'update-ref before', 'update-ref after']);
    for (const name of fixedPoints) assert.ok(names.has(name), `${name} is a point of the run with no stop`);
  });

  for (const name of fixedPoints) {
    const point = pointOf(name);
    for (const way of waysAt(point)) {
      const marked = marksOf(name, way, process.platform).map((mark) => `${mark.part}, until ${mark.closedBy}`);
      it(`keeps the contract after a stop at ${name} (${way})${marked.length === 0 ? '' : `, but for the known failure of ${marked.join('; ')}`}`, async () => {
        const stopped = await stopAndResume(point, way);
        assert.ok(stopped.reached, `the run reached ${name}`);
        assert.deepEqual(unexpected(name, way, process.platform, brokenParts(stopped, expected!)), []);
      });
    }
  }
});
