// The contract of resumable runs (R1, R2 of resumable runs): a fix run on
// the fakes is stopped at each point of a fixed set, in each way that
// applies there, and the same command run again must keep the five parts
// of the contract against the same run with no stop, or fail the part a
// mark of a known failure names (test/helpers/resume-marks.ts). The fixed
// set of the fix pass holds the first and the last append of a phase, the
// launch and the end of a worker and of a check, a worker and a check
// while they run, the end of a verifier whose answer cites a run with a
// probe, the record of a revision, the documentation step while
// its worker runs and at its end, the step before the report is written,
// and `commit` before and after it moves the branch. The fixed set of the
// base holds the checks on the base of the change: the worktree of the
// base before and after git makes it and removes it, a check there at its
// end and while it runs, the step before the phase ends, and the repair
// that compares the failures while it runs and at its end (R11 of the
// facts before a merge). `npm run resume-test` runs every point of both.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { baseScenario, brokenParts, fixScenario, hasPoint, pointOf, reference, stopAndResume, waysAt, type Reference, type Scenario } from '../helpers/resume-contract.ts';
import { marksOf, unexpected } from '../helpers/resume-marks.ts';
import { sandboxConcurrency } from '../helpers/review-sandbox.ts';

/** The points the suite stops the engine at in the fix pass, by name (`pointOf`). */
const fixPoints = [
  // The first append of the first phase, and the last of a phase of workers.
  'phase.started survey',
  'phase.finished finders',
  // A worker's launch and its end, before its answer is recorded (W5).
  'worker.launched triage triage:SCAN',
  'worker.finished triage triage:SCAN',
  // A worker while it runs at its last attempt, the first having failed (W1).
  'child finder-RIPPLE finders:RIPPLE#2',
  // A verifier's end, after its cited probe is frozen and before its answer is recorded with it (R11 of runs on the record).
  'worker.finished verifier verification:g1',
  // The end of a check, and the last check before the fixes while it runs, the order of #25.
  'check.ran baseline-checks build',
  'child check test#1',
  // The check after the fixes that rewrites a file, while it runs after its write (W4).
  'child check lint#2',
  // A fixer while it runs, where a person then edits a file of the change (W8), and the record of its end with its answer and revision, one append since R6.
  'child fixer fixes:c1-1#1',
  'worker.finished fixer fixes:c1-1',
  // The documentation step while its worker runs, and the record of its end with its answer and revision (R12 of the documentation step).
  'child documentation documentation:documentation#1',
  'worker.finished documentation documentation:documentation',
  // The last step before the report is written.
  'worktree.checked report start',
  // `commit` before and after it moves the branch (W6).
  'update-ref before',
  'update-ref after',
] as const;

/** The points the suite stops the engine at in the checks on the base, by name (R11 of the facts before a merge). */
const basePoints = [
  // git makes the worktree of the base: a directory with no entry before it, a locked entry after it.
  'worktree add before',
  'worktree add after',
  // build passed on the base, before typecheck ran there, which the next attempt runs again in a new worktree (TD16).
  'check.ran base-checks build',
  // typecheck while it runs on the base, its third start, and at its end there.
  'child check typecheck#3',
  'check.ran base-checks typecheck',
  // git removes the worktree of the base before the phase ends, and the step just before its end.
  'worktree remove before',
  'worktree remove after',
  'before phase.finished base-checks',
  // The repair while it compares the failures with the base, and the record of its answer with the comparison.
  'child fixer repair:repair#1',
  'worker.finished fixer repair:repair',
] as const;

/** Stop the run of `scenario` at each of `points` in each way that applies there, against its run with no stop, which it gives. */
function contractOf(scenario: Scenario, points: readonly string[]): () => Reference {
  let expected: Reference | null = null;
  before(async () => {
    expected = await reference(scenario);
  });

  it('stops only at points the run with no stop has', () => {
    for (const name of points) assert.ok(hasPoint(expected!, name), `${name} is a point of the run with no stop`);
  });

  for (const name of points) {
    const point = pointOf(name);
    for (const way of waysAt(point)) {
      const marked = marksOf(name, way, process.platform).map((mark) => `${mark.part}, until ${mark.closedBy}`);
      it(`keeps the contract after a stop at ${name} (${way})${marked.length === 0 ? '' : `, but for the known failure of ${marked.join('; ')}`}`, async () => {
        const stopped = await stopAndResume(point, way, scenario);
        assert.ok(stopped.reached, `the run reached ${name}`);
        assert.deepEqual(unexpected(name, way, process.platform, brokenParts(stopped, expected!)), []);
      });
    }
  }
  return () => expected!;
}

describe('the contract of resumable runs', { timeout: 1_800_000, concurrency: sandboxConcurrency }, () => {
  const expected = contractOf(fixScenario, fixPoints);

  it('records each verdict of the run with no stop with the run it rests on and its probe frozen, so every stop is crossed by a run that cites runs (R11 of runs on the record)', () => {
    const { outcome } = expected();
    const verdicts = Object.values(outcome.state.review!.candidates).flatMap((candidate) => (candidate.verdict === null ? [] : [candidate.verdict]));
    assert.ok(verdicts.length > 0, 'the run has verdicts');
    assert.ok(verdicts.every((verdict) => verdict.basis === 'ran' && verdict.runs.length === 1 && verdict.runs[0]!.probe !== null), JSON.stringify(verdicts));
    assert.equal(outcome.cited.length, verdicts.length);
  });
});

describe('the contract of resumable runs, with the checks on the base', { timeout: 1_800_000, concurrency: sandboxConcurrency }, () => {
  const expected = contractOf(baseScenario, basePoints);

  it('runs build and typecheck on the base and the repair\'s comparison in the run with no stop, and leaves no worktree of the base', () => {
    const { outcome } = expected();
    assert.deepEqual(outcome.checks.filter((check) => check.startsWith('base-checks ')), ['base-checks build passed', 'base-checks typecheck failed']);
    assert.deepEqual(outcome.comparisons, ['typecheck same']);
    assert.deepEqual(outcome.baseTrees, []);
  });
});
