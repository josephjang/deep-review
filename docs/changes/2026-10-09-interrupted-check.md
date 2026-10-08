# Change Proposal: Interrupted check

## Summary

A check whose process is killed while the engine is being stopped is
recorded as `failed`, since `checkOutcomeOf` gives any exit other than 0
that outcome, and a resumed checks phase runs only the kinds it has no
record of, so the check never runs again and the report says it failed.
After the change a re-entered checks phase runs again every kind whose
last run in that phase did not pass, the later run being the one the
report, the fixers' tasks and the repair read, and the report says the
kind ran twice. No event changes shape and no outcome value is added:
the rerun's own `check.ran@1` is the later event that corrects the
earlier one, which is the ledger's rule for a wrong record. A check that
passed before the engine was stopped is not run again.

This proposal comes from the same runs as
`2026-10-09-commit-series-integrity.requirements.md` and travels in the
same pull request; it changes the checks phases' planner and reducer
and nothing a fixer, a revision or a claim touches, so it stands alone.

## Problem

On 2026-10-08 the engine's second review of its own decision step, run
`8dbe23ad`, was stopped right after its decision phase completed, to be
resumed with `--concurrency 1`. The ledger records what happened to the
baseline checks, read from this repository's checkpoint:

| Attempt | Kind | Outcome | Exit | Started | Ended |
|---|---|---|---|---|---|
| 1 | typecheck | failed | 143 | 11:06:32.766 | 11:06:37.203 |
| 2 | lint | passed | 0 | 11:06:37.627 | 11:06:52.677 |
| 2 | test | passed | 0 | 11:06:52.698 | 11:12:03.223 |

The stop killed the baseline typecheck's process tree before it reached
the engine: `npm run typecheck` exited 143, the code npm gives when its child
ends by SIGTERM, with 47 bytes of stdout, and the engine, still alive
for a moment, recorded it `failed` and started lint. Lint died with the
engine and left no record. The resume re-entered the phase at attempt 2
and ran lint and test, since `dueCheck` passes over a kind with a run in
the phase, whatever its outcome, and the reducer refuses a second run of
a kind in one phase. So the run's report says typecheck failed before
the fixes; every fixer's task said so, with that output's path, as the
failure it was not to blame itself for (R24 of the fix pass); and the
typecheck ran only after the fixes, where it passed in 3.1 s. The same
tree's typecheck passed at the first run's baseline and in every
per-commit check.

Nothing was lost on that run: `repairTargets` takes a kind that failed
at baseline and fails after the fixes, so a regression would still have
reached the repair worker. What was lost is the truth of the record and
the fixers' baseline, and on a run whose stop lands during the test
suite, five minutes here, the resumed run would tell every fixer the
suite failed before any edit.

The issue (#25) proposes recording no `check.ran` for a check that has
not finished when the engine is stopping. Read against the code, the
engine already does that in the one case it can see: when a signal
reaches the engine first, `LiveProcesses` in `src/runtime/process.ts`
kills every live child and raises the signal again, the process ends,
and `runDueCheck` in `src/review/controller.ts` never appends. Lint on
this run is that case. The recorded failure is the other order: the
check died before the engine knew anything, the shell reported an exit
code, and the engine was alive to append it. On Windows, where this run
was, the engine installs no signal listener at all and a stop from
outside is a termination it cannot observe, so a flag that says "the
engine is stopping" cannot be set in time. The fix has to be on the
resume's side, where the engine knows one thing for certain: the phase
was cut short, because it is re-entering it.

## Goals

- A check killed by stopping the engine runs again when the run
  resumes, whatever order the kill reached the processes in and on
  every platform.
- A check that passed before the stop is not run again.
- The record says what happened: the killed run stays on the ledger and
  the rerun is the later event that supersedes it.

## Non-Goals

- **Telling a killed check from a failed one at the moment it ends.**
  An exit code of 128 plus a signal number is a shell convention, not a
  fact the engine can rely on: a native test runner that aborts exits
  134 on its own and is a real failure. The engine parses no output and
  reads no code beyond zero (PD8 of the fix pass).
- **A signal listener on Windows.** The listener's absence there is
  deliberate (the comment in `process.ts`): Ctrl-C reaches every process
  on the console and the job object ends the children with the engine.
  A stop from outside the console has no signal to listen for.
- **A new check outcome.** Weighed and rejected (D2).
- **Rerunning every kind on re-entry.** Weighed and rejected (D1).
- **A check killed by something else while the engine goes on.** A
  process killed by hand during a run that is not stopped is recorded
  as it ended, and the phase completes; only a re-entered phase reruns.

## Requirements

- **R1: A re-entered checks phase runs again every kind whose last run
  in that phase did not pass.** When `baseline-checks`, `checks` or
  `repair-checks` starts a second or later attempt, `dueCheck` names,
  after the kinds with no run in the phase, each kind whose last run in
  the phase has an outcome other than `passed` (`failed`, `timeout`,
  `not-started` or `skipped`), in the pinned order, `build` first; the
  skip rule for the three later kinds reads the build's last run as it
  does now. A kind whose last run passed is not run again. The checks
  the phase runs in its first attempt are unchanged.
- **R2: A kind runs at most once per attempt, and the last run is the
  one read.** The reducer refuses a second `check.ran@1` of one kind in
  one attempt of a phase, and accepts one in a later attempt; `lastRun`
  keeps giving the last run of the kind in the phase, so the report's
  Checks table, `failedAtBaseline`, `repairTargets`, the fixers' baseline
  block and `status` all read the rerun.
- **R3: The report and the log say a kind ran again.** Limitations
  gains, for each kind with more than one run in a phase, a line naming
  the phase, each attempt's outcome and seconds, and that the earlier
  attempt was cut short by the engine's stop; the controller logs
  `check typecheck (baseline-checks): running again, attempt 1 failed
  before the engine stopped`. The Checks table shows the last run, as
  now.
- **R4: No event changes.** `check.ran@1` keeps its shape and its
  outcomes; `reviewVocabularyV4` is unchanged; no golden fixture is
  needed, since the registry does not change. A ledger with one run per
  kind per phase folds as before.

## Decisions

- **D1: Rerun what did not pass, not everything and not only the last.**
  Rerunning every kind of a re-entered phase was rejected: a passed
  suite cannot have been made to pass by a kill, and on this repository
  the suite is five minutes a resume would pay for nothing. Rerunning
  only the last recorded run of the earlier attempt, the one that may
  have been in flight when the stop came, was considered: it reruns
  less on a phase stopped late, but it reads the order of records as a
  fact about the stop, which it is not when the engine was killed
  between two checks, and it is a rule with a condition where "did not
  pass" needs none. A failed check rerun once per interruption of its
  phase is the price; a stop is rare and a failing check is the cheaper
  kind to rerun.
- **D2: No `interrupted` outcome.** A new outcome value, recorded in
  place of `failed` when the engine knows it is stopping, would need
  the engine to know, which it does not in the case that happened
  (Problem), and it would widen `check.ran@1`'s outcome enum, which the
  2026-10-08 decision allows in place with the fixture regenerated, for
  a value the engine could write only on POSIX and only when the signal
  reached it first, where it writes nothing today. The rerun under R1
  covers both orders and both platforms with no new value; the record
  of the killed run stays as the shell reported it, exit 143, and the
  Limitations line says why it ran again.
- **D3: The rerun is the correction.** AGENTS.md's rule for the ledger
  is that a wrong event is corrected by a later event that says so. The
  rerun's `check.ran@1` at the later attempt is that event, and
  `lastRun` already reads the last; nothing marks the earlier run void,
  and `status --json` carries both.
- **D4: Not folded into the commit series design.** The two share a
  pull request and two runs, not a code path: this change is `dueCheck`
  in `src/review/steps.ts`, `checkRan` in `src/checkpoint/fix-fold.ts`,
  one Limitations line and one log line, and its tests are the checks
  phases' own.

## Design

- `dueCheck` (`src/review/steps.ts`) takes the phase's attempt from the
  fold and, when it is above 1, treats a kind whose `lastRun` in the
  phase did not pass as due after the kinds with none; the skip rule is
  unchanged. `lastRun` is unchanged. A `DueCheck` gains `again: CheckRan
  | null`, the earlier run, for the log.
- `checkRan` (`src/checkpoint/fix-fold.ts`) refuses a second run of a
  kind in the same attempt, "runs the typecheck check twice in attempt 1
  of baseline-checks", and accepts one in a later attempt; the test that
  pinned "twice in baseline-checks" moves to the attempt.
- `runDueCheck` (`src/review/controller.ts`) logs the rerun with the
  earlier attempt's outcome before it runs.
- `fixLimitations` (`src/review/fix-report.ts`) adds the line of R3 for
  each kind and phase with more than one run.

## Test Strategy

- `test/review/fix-steps.test.ts`: a re-entered checks phase runs again
  the kind whose earlier run failed, timed out, did not start or was
  skipped, after the kinds with no run, and not the kind that passed; a
  first attempt runs each kind once as before; the skip rule reads a
  rerun build's outcome.
- `test/checkpoint/fix-fold.test.ts`: a second run of a kind in one
  attempt is refused naming the attempt; one in a later attempt folds,
  `lastRun` gives it, and `repairTargets` and `failedAtBaseline` read
  it; the existing histories fold unchanged.
- `test/review/fix-pass.test.ts`, a whole run on the fakes: the fake
  typecheck is scripted to exit 143 at the baseline, the engine is
  stopped after it is recorded and before the next check (the existing
  killed-engine harness), the run resumes, the typecheck runs again and
  passes, every fixer's task names no baseline failure, the report's
  Checks table shows it passed before the fixes, and Limitations says it
  ran again; a second case where the earlier run passed sees no rerun.
- `test/review/fix-report.test.ts` and `test/review/report.test.ts`: the
  Limitations line.
- `npm run check` and `npm run verify` before the commit; no golden
  fixture, since the registry is unchanged, which the golden test's
  identity check shows.

## Verification

No checks have run yet. Filled by the commit that implements this
proposal: the test counts, and, from the gate of the commit series
proposal, whether any check was interrupted and rerun.

## Risks

- A check that fails on its own and is interrupted after it is recorded
  runs again on the resume, once per interruption of the phase. Accepted
  (D1); the cost is the check's own time.
- A check killed by hand during a run that is not stopped stays
  recorded as it ended, and the phase completes without a rerun.
  Accepted (Non-Goals); the record shows the exit, and the operator can
  abandon or run the command again only before the phase completes.
- A kind whose rerun also does not pass has two failing runs on the
  ledger; the report reads the last and the line in Limitations names
  both. Accepted.
- A rerun's output supersedes the earlier run's in the fixers' tasks
  and the repair's; the earlier output stays frozen and is reachable
  through `status --json`. Accepted.
