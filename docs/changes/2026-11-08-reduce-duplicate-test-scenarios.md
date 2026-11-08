# Change Proposal: Reduce duplicate integration scenarios

## Summary

Some runtime and continuation integration cases repeat protocol or scope-rule variants that lower-level tests already exercise. Remove five repeated expensive scenarios, preserve the rules at their owning layer, and strengthen the integration cases that prove evidence recording and continuation routing. This changes test organization and execution counts, not engine behavior.

## Requirements

### R1: Preserve the boundary each retained layer owns

Adapter tests retain detailed malformed-output and session rules. Scope tests retain added-path, mode/base, changed-content and moved-HEAD comparisons. Runtime integration still proves that a failed adapter response closes the worker, records its reason and null answer, and freezes evidence. Continuation integration still proves that changed bytes are discovered through the controller's Git comparison, create another run, leave the finished run unchanged and explain the refusal.

### R2: Remove actual expensive executions

Remove the duplicate Claude wrong-session launcher row, the Codex non-JSON launcher row, and three full continuation scenarios for an added path, another scope mode and moved HEAD. Do not hide the same work in a loop. Keep the changed-bytes continuation case and merge the wrong-session assertions into the already existing session-recording case.

### R3: Keep unknown denial evidence explicit

Retain the Claude success-envelope-without-denials integration as a separate case and assert null denial evidence on both receipt and ledger. Its protocol rejection already has an adapter test, but the distinction between an empty denial list and unknown denial evidence is useful at the recording boundary. This sixth initial removal candidate is deliberately retained.

## Decisions

### D1: Keep variants in the layer that owns the rule

The four continuation mismatch variants use one controller call to scopeMismatch, with no reason-specific controller branches. Keep detailed reasons in test/scope/compare.test.ts and one changed-content controller case for the findDrift callback and refusal routing. This follows R2, PD3 and TD4 of [fix pass continuation](2026-10-10-fix-pass-continuation.requirements.md) and its [technical design](2026-10-10-fix-pass-continuation.design.md); it changes the allocation of verification rather than those product guarantees.

### D2: Retain representative protocol-to-record integration

Keep Claude malformed JSON, missing denial evidence, wrong-session recording and schema failures, and keep Codex malformed oversized output, mismatched final-message and other failed responses. The decoder units own malformed-line variants; the launcher owns mapping their failed result to a finished worker and frozen evidence. Runtime process, timeout, permission and continuation tests remain intact.

### D3: Probe regressions before accepting the reduction

In a disposable checkout, temporarily break the removed scope-rule branches, the controller's changed-byte callback, its rejection routing or refusal log, and failed-result recording. Run the relevant retained tests and record which assertions reject each mutation. Restore production files before final checks. These probes provide evidence for the retained boundaries; they are not a proof against every possible defect.

## Non-goals

### N1: Change production or the resumable contract

Do not edit engine, role or skill sources, generated distributions, ledger fixtures, real interruption cases or OS matrices. Do not change CI scheduling, cache policy, fixture sharing or fake-worker execution. No test is moved out of the ordinary suite.

## Metrics

### M1: Separate fewer cases from faster identical work

Measure the two affected integration files in three alternating before/after pairs, with committed source and role inputs identical apart from the intended test edits. Report case counts, all samples, medians and ranges. This is an evaluation of deliberately reduced work, not a same-workload compiler or engine speedup. A full-suite correctness run is not a before/after timing comparison, and no total CI improvement is inferred.

## Risks

### K1: Lower-level coverage can miss caller wiring

The changed-bytes continuation case must remain because unit tests inject their own changedSince callback and cannot prove the controller passes findDrift. Explicitly retain new-run identity, old ledger/report preservation and exact refusal logging. A passing lower-level comparison alone does not establish integration behavior.

### K2: Small timing changes can be noise

Timeout and other integration scenarios still dominate the measured files. Three samples establish only the observed local range and median. Record a weak or negative elapsed result honestly, alongside the five executions removed, without extrapolating to a CI-wide percentage.

## Test strategy

### T1: Check retained behavior and mutations

Run the affected integration files with their adapter and focused scope tests. The scope comparisons still use temporary Git/checkpoint fixtures; the layering assigns rule ownership rather than claiming every lower-level check is a dependency-free unit. Use targeted mutation probes for the rule and integration boundaries, restore all mutations, and compare the baseline and reduced files three times per condition. Record the exact scope and reduced counts.

### T2: Preserve repository validation

Run npm run check and npm run verify in an isolated checkout containing committed engine/role inputs and this test change. No engine stop, resume, launch or ledger behavior changes, so a local contract run is not required. The real review still gates release.

## Against the vision note

### V1: Keep evidence at the boundary

Principles 1 and 8 of the [2026-11-05 vision note](../2026-11-05-vision.md) require evidence and explicit coverage limits. Publish the retained-case mapping, mutation outcomes, execution counts and measurement scope instead of treating fewer tests as proof of equal coverage or a pipeline speedup.

### V2: Preserve the real-run gate

Principle 12 still requires a real review before release. Offline rule and integration evidence does not replace that review. This proposal does not change the product guarantees or depart from the vision note.

## Verification

Five actual integration scenarios were removed: two direct launcher executions and three whole read-only review/fix-command scenarios. The affected files run 118 cases before and 113 after, retaining one platform skip; launcher runs 97 to 95 and fix continuation 21 to 18. The missing-denial integration was retained and strengthened, rather than counting all six original candidates as removals. Adapter and focused scope cases remain unchanged.

The two affected files with adapter/scope verification passed 282 cases: 280 passed, two skipped and zero failed. Ten temporary mutations were each rejected by a retained semantic assertion, covering added paths, scope mode, HEAD, controller drift/routing/logging, Claude session identity, failed-result propagation, unknown denial evidence and Codex malformed output. Every production mutation was restored before measurements and final validation. Exact edits, commands, witnesses and input fingerprints are in the [measurement data](../reports/2026-11-08-test-time-measurements.json); the author keeps full logs outside the repository.

Three alternating comparison pairs all exited zero. Combined process elapsed was 24.504016, 24.961977 and 24.716485 s before, and 24.382816, 24.288090 and 24.401813 s after. The median fell from 24.716485 to 24.382816 s, an observed 0.333669 s or 1.35% reduction. The same concurrent invocations reported fix-continuation file medians of 17.518943 and 15.094780 s, 13.84% less; the launcher remained the longer file with retained real timeouts. Per-file durations overlap and cannot be added. Three samples establish no statistical significance, and the changed workload establishes no identical-work, whole-suite or CI-wide speedup.

The isolated npm run check passed lint, typecheck and 3,731 ordinary cases: 3,718 passed, 13 skipped, zero failed and zero canceled. The command took 582.022 s; the runner reported 557.515 s. npm run verify matched Claude's 43 files and Codex's 42 files. The validated test files match the submitted edits, and production/helper fingerprints match before and after. Validation excluded separately prepared bounded-path-scan and unrelated role changes. These single full-check timings are correctness evidence, not a new performance comparison.

No local contract run was required because no engine stop, resume, child launch or ledger behavior changed. No CI run or real review was triggered; the real review remains required before release under principle 12. No production behavior change is included.
