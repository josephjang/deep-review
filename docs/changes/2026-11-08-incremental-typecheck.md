# Change Proposal: Reuse TypeScript checking state

## Summary

Repeated local typechecks currently rebuild the TypeScript project graph. Enable TypeScript's incremental mode for the existing no-output check and keep its disposable state in an ignored cache directory. Preserve the same compiler, project inputs and diagnostics, and keep authoritative typed linting uncached.

## Requirements

### R1: Preserve the typecheck gate

The typecheck command must continue to report invalid TypeScript and return a failing exit code. Reusing state must detect imported-type changes, compiler-option changes, dependency declaration updates and deleted inputs. Restoring valid inputs must recover without manually deleting the cache.

### R2: Keep state disposable and local

Write state to `.cache/typecheck.tsbuildinfo`, ignored by Git. A missing or unusable cache must not exempt checking. The cache is compiler metadata, never runtime output or a committed artifact. No CI cache upload, restore or persistence is introduced.

## Decisions

### D1: Use the compiler's existing incremental mode

Change the npm typecheck command to `tsc --noEmit --incremental --tsBuildInfoFile .cache/typecheck.tsbuildinfo`. Keep tsconfig unchanged so the command's optimization does not add cache-writing configuration to editor or lint consumers. TypeScript owns graph invalidation and cache compatibility; no custom cache key, timestamp wrapper or compiler runner is needed. [The incremental option](https://www.typescriptlang.org/tsconfig/incremental.html) and [build information path](https://www.typescriptlang.org/tsconfig/tsBuildInfoFile.html) document this state and its location.

### D2: Keep typed lint authoritative

Do not enable ESLint's result cache. The type-aware lint rules depend on imported information, and its file cache does not establish cross-file invalidation. This change reuses only the TypeScript compiler's checking state.

### D3: Evaluate warm and cold work separately

Measure three uncached, three cold-incremental and three unchanged warm-incremental invocations on the same frozen project, using the operator's requested sample count. Alternate the uncached/warm order and record a fresh incremental cache for each pair. Report startup-inclusive command elapsed time, exit codes, medians and ranges. Cold means absent TypeScript state, not a flushed operating-system page cache. Do not extend these figures to ordinary tests, contract tests or total CI latency.

## Non-goals

### N1: Change tests, CI scheduling or emitted artifacts

No tests are removed, no contract policy changes, and no engine, role or skill source is edited. Fresh CI runners still pay a cold typecheck. CI cache persistence and a whole-check performance comparison are separate work.

## Risks

### K1: Cached checks could conceal changed inputs

Probe invalidation with a real compiler using a small project and a dependency declaration, and compare each failing case with an uncached check. Include changed input contents with preserved timestamps, restored valid inputs, a deleted imported file, and malformed or version-mismatched metadata. These probes verify the pinned compiler's behavior rather than mirroring its implementation in permanent repository tests.

### K2: State can be deleted or shared by overlapping checks

The cache is optional and worktree-local. Deleting `.cache/typecheck.tsbuildinfo` forces a cold check. Do not share one cache file between different worktrees or concurrent compiler invocations. TypeScript's state format is compiler-owned, so upgrades may rebuild it. No runtime depends on the file.

## Test strategy

### T1: Exercise changed inputs and failures

Use executable invalidation probes with frozen fixtures and recorded compiler diagnostics/exit codes, then restore or discard the isolated fixtures. Missing, malformed and stale cache cases must still check source, and invalid inputs must fail on repeated warm checks as well as cold checks. Record enough fixture contents and commands in the evaluation data to reproduce the decisions; the author keeps full logs outside the repository.

### T2: Preserve repository checks

Run npm run check and npm run verify once in an isolated checkout containing committed source/role inputs and this change. No engine stop, resume, launch or ledger behavior changes, so a local contract run is not required. No implementation-mirroring permanent test is needed for adding compiler flags.

## Against the vision note

### V1: Preserve evidence while reducing repeated work

Principles 1 and 8 of the [2026-11-05 vision note](../2026-11-05-vision.md) require evidence and explicit coverage limits. Publish samples and invalidation outcomes without treating cached success as an exemption or claiming a whole-pipeline speedup from a compiler-only sample.

### V2: Retain the real-run gate

Principle 12 still requires the real review before release. Compiler probes and repository checks establish the tooling change locally; they do not replace that review. No departure from the note is proposed.

## Verification

Three actual npm-command samples per condition all exited zero. The uncached median was 8.698805 s, cold incremental 8.616380 s and unchanged warm incremental 1.808939 s. Warm reuse saved 6.889865 s, a 79.20% reduction and 4.81 times speedup for typechecking alone. The sample count is the operator's requested three, with no exclusions or repetitions. The [measurement data](../reports/2026-11-08-test-time-measurements.json) records all nine samples, commands, ranges, environment, input fingerprint and reproducible invalidation fixtures.

Seven invalidation scenarios passed. Imported-type and dependency declaration changes with original modification times restored, a compiler-option change and an imported-file deletion each failed on the first incremental check, a repeated incremental check and an uncached check, with identical cached/uncached diagnostics. Restoring valid files recovered without deleting the cache. Missing, malformed and stale-version metadata still rejected invalid code and recovered with current-version state after restoration. The compiler created the initially absent cache directory and file, and Git ignored the result.

`npm run check` passed lint, typecheck and 3,736 ordinary cases: 3,723 passed, 13 skipped, zero failed and zero canceled. The command took 599.742 s and the ordinary runner reported 575.755 s. `npm run verify` matched both artifacts: Claude 43 files and Codex 42 files. Validation used an isolated checkout with committed source/role inputs and this tooling change, excluding the separately prepared bounded-path-scan implementation and unrelated role work. The author keeps full logs outside the repository.

Node bytecode caching was explicitly disabled for all performance samples, probes and full verification, independently of TypeScript's incremental state. The OS page cache was not flushed. The full-check timing is a single correctness run, not a before-and-after comparison or a new comparison with earlier ordinary-suite measurements. Fresh CI runners still start cold, and representative edit latency has not been measured. No local contract run was required because no engine stop, resume, launch or ledger behavior changed. No real review or CI run was triggered; principle 12 still requires the real review before release.
