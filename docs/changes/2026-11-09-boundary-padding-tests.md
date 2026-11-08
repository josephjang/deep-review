# Change Proposal: Test review limits at their boundaries

## Summary

The pull request form tests grow a finding's explanation in 200-character steps until the review is refused or its area diagrams are cut. Hundreds of renders rediscover a few length transitions. Replace those sweeps with a fixed number of calls at the documented 60,000-character limit, retaining the cut order, refusal detail, visible content and secret counts.

## Requirements

### R1: Keep an independent limit and cut oracle

Assert the public 60,000-character cap and the literal cut sequence: refuted candidates, findings left as is, the minor table, then area diagrams. For every applicable cut state, test the last body below the cap, the body exactly at the cap and the next input character. The latter must select the next cut or refuse after all applicable cuts. With no diagram, never make a diagram cut.

### R2: Preserve posted content and refusal evidence

Keep the cut notices, the questions, the area descriptions, full findings and the final publication marker. Check a line comment below, at and above the same cap, and retain the refusal's finding, location, size and part accounting. No production behavior or publication policy changes.

### R3: Count secrets in each explicit state

For plain and secret-bearing area titles, calibrate padding independently because redaction changes text length. Both variants must reach every literal cut state at its boundary. Check that no token is posted and that the secret-bearing variant reports exactly one additional secret before and after the diagrams are removed.

## Decisions

### D1: Calibrate input size without discovering expected behavior

Start with one character of padding, so trimming an empty explanation suffix does not change the relation between padding and posted length. A successful body gives the remaining input length to the fixed public cap. Render the three neighboring inputs, then use the above-boundary form as the next seed. The expected states are declared independently of production bodyCuts and returned cuts. The loop has a literal finite state count and asserts positive progress; it cannot search indefinitely when a renderer changes.

### D2: Compare test construction after the shared scan fix

Use the same isolated bounded-path-scan expression on both sides of the three-pair comparison, solely to measure the incremental effect of fewer renders after O1. The original sweeps otherwise spend minutes in the known quadratic recognizer and O1 already has its own controlled three-pair evaluation. Do not include any O1 gain in O2's result. Separately run the complete repository check and verify against committed production sources plus only the proposed test edits, excluding the independently prepared O1 implementation and unrelated role work.

### D3: Count renderer work and probe the boundary checks

Collect production form/body/comment renderer call counts in a disposable instrumented checkout, outside timed samples. Temporarily mutate the cap, the strict fit comparison, cut ordering or applicability, refusal and secret accounting, and confirm retained assertions reject those selected faults. Restore all instrumentation and mutations before final validation.

## Non-goals

### N1: Change engine complexity or test tiers

Do not edit production sources, roles, skill prompts, distributions, contract frequency, golden fixtures or process tests. This work removes construction renders rather than claiming fewer named cases. The bounded-path-scan change remains separate; these length checks do not substitute for its long-word regression.

## Metrics

### M1: Separate reduced work from a compiler or engine speedup

Record actual renderer calls, named cases and three alternating before/after samples for the two affected files. Report startup-inclusive medians and ranges under the common experimental scan expression. A single exact-commit full check establishes correctness, not a before/after suite or CI speedup.

## Risks

### K1: Calibration could follow a broken implementation

Only the input length is calibrated. Expected sizes, cuts, retained content, marker and refusal accounting are asserted independently. Mutations of the cap and off-by-one comparison must fail these assertions even when padding follows the observed body length.

### K2: A test-only benchmark can be misread as shipped performance

State prominently that both timed variants share the isolated O1 expression. Do not mix those timings with the earlier original-scan baseline or extrapolate a whole-suite gain. Exact proposed-commit validation uses the original production source.

## Test strategy

### T1: Check boundaries and selected regressions

Run both affected files and the temporary mutation probes. Record exact source edits, failing retained assertions and renderer counts in the public measurement data; the author keeps full logs outside the repository. The mutation set is targeted evidence rather than exhaustive proof.

### T2: Preserve repository validation

Run npm run check and npm run verify once after the test inputs are frozen, with committed production and role inputs. No engine stop, resume, child launch or ledger behavior changes, so a local contract run is not required. No real review or CI result is implied by local validation.

## Against the vision note

### V1: Preserve evidence and name the measurement boundary

Principles 1 and 8 of the [2026-11-05 vision note](../2026-11-05-vision.md) require evidence and explicit coverage limits. Publish the retained transitions, selected mutation results, call counts and exact experimental scan setup instead of treating fewer renders as proof of a pipeline speedup.

### V2: Keep the real-run gate

Principle 12 still requires a real review before release. Boundary cases and local repository checks do not replace that review. No departure from the note is proposed.

## Verification

The two affected files retained all 71 named cases and passed with zero failures or skips. Ten temporary source mutations were rejected by retained semantic assertions: the public cap, body/comment exact-fit comparisons, cut order, area-diagram selection, body/comment refusal, secret accounting after diagram cuts, protected area intro and publication marker. All instrumentation and mutations were restored before timing and final validation.

Untimed counters measured changed-scenario form calls falling from 1,082 to 65, internal body renders from 1,209 to 187 and comment renders from 1,082 to 68. Across both entire files, including unchanged setup and tests, form calls fell from 1,165 to 148. These are renderer entry counts, not fewer named cases or independent additive quantities.

All three alternating comparison pairs passed 71 cases on both sides. Both variants used the same isolated O1 expression solely to measure marginal O2: before times were 1.946110, 1.923483 and 2.013650 s; after times were 0.957781, 0.991210 and 1.031323 s. Process spawn-to-close medians were 1.946110 and 0.991210 s, an observed 0.954900 s or 49.07% reduction. These timings are not the exact committed production source, an identical-work optimization, or a cumulative O1 plus O2 result. Three local Linux samples establish no statistical confidence or whole-suite/CI improvement.

The exact proposed-commit npm run check passed lint, typecheck and 3,731 ordinary cases: 3,718 passed, 13 skipped, zero failed and zero canceled. The command took 240.215 s and the ordinary runner reported 215.957 s. npm run verify matched Claude's 43 files and Codex's 42 files. This validation used committed production and role inputs plus the frozen test edits, excluding the experimental O1 expression and unrelated role changes. The single full-check timing is correctness evidence rather than a before/after performance comparison.

The [measurement data](../reports/2026-11-08-test-time-measurements.json) records all samples, renderer scopes, exact temporary edits and semantic witnesses, controlled scan expressions and input fingerprints. The author keeps full logs outside the repository. No local contract run was required because engine stop, resume, child launch and ledger behavior did not change. No CI run or real review was triggered; principle 12 still requires the real review before release.
