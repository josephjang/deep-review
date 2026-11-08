# Change Proposal: Bound path scanning in finding names

## Summary

The review on a pull request replaces finding ids with the numbers its reader sees, while leaving ids inside paths unchanged. Its path recognizer repeatedly backtracks over a long word with no separator. Constraining matches to the start of a run of path characters preserves the path rule and avoids restarting that failed search at every character.

## Requirements

### R1: Preserve path and finding names

Keep R3 of [finding names in the review](2026-11-08-finding-names-in-the-review.md#r3-only-the-runs-ids-and-code-stays-code): an id inside a path or URL stays unchanged, while slash-joined ids alone are named. Preserve both path separators, adjacent paths, punctuation, Unicode surroundings, and the same rule in diagram labels and identifiers.

### R2: Do not rescan the suffixes of a word

A word containing only path characters and no slash or backslash must not cause a fresh path search at every position inside the word. The original expression took 22.37, 91.81, 355.52 and 1,417.38 ms on 5,000, 10,000, 20,000 and 40,000 repeated letters in one Linux measurement. Those timings are observations, not portable thresholds. The author keeps the raw measurement logs outside the repository.

## Decisions

### D1: Match only at the start of a path-character run

Add `(?<![\w.~-])` before the existing path expression. The existing greedy expression consumes the entire maximal path-character run whenever it finds a separator. Restarting inside a run cannot discover a different maximal path; when the run has no separator, the boundary prevents the repeated failed attempts. The characters accepted as paths and the handling of slash-joined ids stay the same.

### D2: Keep the public behavior as the regression boundary

Exercise finding-name replacement on paths, slash-joined ids, Unicode surroundings and a long non-matching word. Run the long-word case in a child with a generous process timeout, so a synchronous regular-expression regression cannot block the test runner indefinitely. Check the output as well as completion; a fast implementation that removes the input does not pass.

### D3: Keep this change independent of test reduction

This source change removes no test case and rewrites no padding sweep. The historical controlled comparison used the original test inputs, measuring the scan without reducing coverage. Later independent test-tooling changes replaced the sweeps and removed audited duplicates; integration with those changes is checked below. Role prompts, runtime policy, the ledger and CI frequency are outside this change.

## Non-goals

### N1: A new path grammar or parser

Do not broaden path recognition, add path normalization, or replace the naming pipeline. A parser rewrite would need a separate compatibility review.

### N2: A complete complexity claim for arbitrary input

This change bounds restarting the path expression inside a word. It does not claim linear complexity for every recognizer or every combination of URLs, code spans, paths and ids in the naming pipeline.

## Risks

### K1: A boundary could change which ids remain inside a path

Retain the existing path and diagram cases and add public-API cases for adjacent paths, both separators and Unicode surroundings. Compare replacement output, not just regular-expression matches.

### K2: A timing check could fail on a busy runner

Use a long enough input to separate the original repeated search from the bounded scan by orders of magnitude, and a generous child timeout instead of a tight millisecond assertion. The timeout is a regression guard, not a benchmark of CI hardware.

## Against the vision note

### V1: Preserve evidence and the reader's names

Principles 1 and 6 of the [2026-11-05 vision note](../2026-11-05-vision.md) require keeping evidence and making the review understandable with little context. The optimization preserves the names and paths the reader receives and changes no recorded decision or evidence.

### V2: Keep the real-run gate

Principle 12 still applies. Offline checks establish the bounded scan and compatibility cases; they do not replace the real review of the pull request before release.

## Verification

### Initial isolated evidence

The long-word regression failed against the original implementation at the child's 30 s process timeout. With the bounded scan, the finding-name, finding-name case, PR form and PR area files passed all 120 tests in 1.913 s. `npm run check` passed lint, typecheck and the ordinary suite: 3,715 tests, 3,702 passed, 13 skipped, zero failed; the test stage took 66.122 s on the measured Linux environment. These are single-run timings, not a cross-platform benchmark.

`npm run build` regenerated the two engine bundles and their hash sidecars; `npm run verify` matched both artifacts. The validation used an isolated checkout with the committed role prompts and policy, excluding unrelated work in progress. The contract tier was not run because no stop, resume, launch or ledger behavior changed. The real review of the pull request remains required before release under principle 12; no real model review, push or publication was performed here.

### Integration after the test-tooling changes

The same source change and two regressions are now integrated with the conditional-contract, incremental-typecheck, duplicate-scenario and boundary-padding changes. An isolated checkout uses committed role inputs and excludes unrelated role work. Rebuilding changes exactly the two engine bundles and their two hash sidecars; all four rebuilt outputs match the already prepared outputs. The four focused files passed all 120 cases, with no failures or skips. The latest `npm run check` passed lint, typecheck and 3,733 ordinary cases: 3,720 passed, 13 skipped, zero failed and zero canceled. The command took 87.839 s and the runner reported 63.571 s. `npm run verify` matched Claude's 43 files and Codex's 42 files. These are single integration-check timings, not a new before/after benchmark or a comparison with the earlier instrumented profile. No historical performance comparison was repeated or extended. The author keeps full logs outside the repository, and the [measurement data](../reports/2026-11-08-test-time-measurements.json) records the commands, counts, input fingerprint and generated-output hashes. No local contract run is required because no stop, resume, child launch or ledger behavior changes. The real review remains required before release; no hosted CI run or real-model review is claimed.
