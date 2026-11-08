# Report: Remaining test bottlenecks

This historical profile measured the ordinary and resumable-contract tiers after the test-tooling changes and the then-separately prepared O1 path-scan expression. The [bounded scan source, regressions and regenerated bundles](../changes/2026-11-08-bounded-path-scan.md) are now integrated together. The profile predates those two regression cases and includes disposable hooks, so its observations remain an instrumented baseline rather than literal current-head performance. The profiling itself implements no optimization.

The [options report](2026-11-08-test-time-options.md) holds the previous decisions. The [measurement data](2026-11-08-test-time-measurements.json) adds `remainingBottleneckProfile` with all six samples, per-file/case counters, instrumentation source, fingerprints and limits. The author keeps full raw logs outside the repository.

## Three observations per tier

Exactly three instrumented runs of each tier ran serially: ordinary first, then contract. Each invocation started with a fresh primary Node compile cache and unchanged committed roles, helpers and dependencies. Only the isolated scan expression and disposable profiling hooks differed from committed sources. The OS page cache was not flushed. The primary interval is Node runner spawn to close, including instrumentation and startup but excluding npm, install, lint, typecheck and verify.

| Sample | Ordinary, s | Contract, s |
|---|---:|---:|
| 1 | 66.424767 | 239.524026 |
| 2 | 64.641199 | 239.699126 |
| 3 | 67.237299 | 239.324625 |
| Median | 66.424767 | 239.524026 |

Every ordinary run had 3,731 cases: 3,718 passed, 13 skipped, zero failed or canceled. Every contract run passed all 109 assertions, covering 100 stop cases, four reference runs and the additional reference assertions. The current marks table is empty: no known broken contract part is accepted by a mark. These local Linux observations establish no hosted-CI, cross-platform or uninstrumented baseline speedup. No percentage is computed against earlier correctness runs.

## The elapsed-time tail

The ordinary tier's longest file is the fix pass, rather than the PR padding files. File elapsed intervals include their concurrent cases and cannot be added to runner elapsed time.

| Ordinary file | Three-run median, s |
|---|---:|
| `test/review/fix-pass.test.ts` | 61.049 |
| `test/review/publish.test.ts` | 48.033 |
| `test/review/fix-reopen.test.ts` | 47.787 |
| `test/review/controller.test.ts` | 40.109 |
| `test/cli.test.ts` | 38.890 |
| `test/review/commit.test.ts` | 35.576 |
| `test/review/fix-continuation.test.ts` | 34.559 |
| `test/review/pull-request-scope.test.ts` | 34.000 |

The contract's four top-level scenario suites run sequentially in its single file, with up to four stop cases inside a scenario and one model worker per engine. Their measured medians show where a qualifying contract job spends its time. Each scenario starts its own uninterrupted reference.

| Contract scenario suite | Three-run median, s |
|---|---:|
| Fix pass | 121.221 |
| Checks on the base | 76.307 |
| Read-only pull request | 24.875 |
| Pull request review followed by its fix pass | 16.570 |

The fix and base suites dominate the contract tail. A smaller fixture must still meet [R2 of resumable runs](../changes/2026-10-18-resumable-runs.requirements.md#r2-a-test-checks-the-contract-at-each-point), including the retry and rewriting-check cases each way needs, all designated points and stop methods, all five contract parts and representative cross-phase interactions. Splitting scenario suites could expose more concurrency on this 24-thread host, but would multiply inner concurrency and may give no gain on smaller CI runners. Neither change has been measured here.

## Git and command work

Every ordinary profile observed 33,862 public Git invocations, and every contract profile 13,666. First-sample elapsed child waits below are cumulative across participating Node parents, including scheduler contention; they are not Git CPU, independent latency components or removable suite time. Argument-level rev-parse variants were not logged, so its count must not be described as HEAD reads alone.

| Git command | Ordinary invocations | Ordinary cumulative s | Contract invocations | Contract cumulative s |
|---|---:|---:|---:|---:|
| rev-parse | 13806 | 135.912 | 5476 | 20.852 |
| status | 5964 | 62.669 | 2494 | 9.391 |
| ls-files | 5437 | 52.703 | 2238 | 8.018 |
| diff | 1511 | 17.763 | 370 | 1.260 |
| hash-object | 1038 | 9.945 | 943 | 3.333 |

[findDrift](../../src/review/drift.ts) compares expected paths and HEAD, and [worktreeChecked](../../src/review/drift.ts) records strays. [changedAgainstHead](../../src/scope/git.ts) separately asks diff and ls-files for tracked and untracked paths. [gitContent](../../src/review/content.ts) already skips Git when raw bytes match and caches clean-conversion IDs by path and content hash; it preserves [R22 of the fix pass](../changes/2026-10-01-fix-pass.requirements.md). A useful next Git audit would trace duplicate reads within one comparison boundary, with finer command arguments. Caching HEAD/status across worker/check boundaries or imitating filters would remove the evidence these checks provide.

The ordinary profile observed 153 snapshot and 43 claim dispatches in total. Qualifying an O12 test-host change requires both a fake-runtime caller frame and a test-file parent, not merely a test filename. That narrows the candidate to 132 snapshot and 18 claim calls, stable in all three runs. Real fake-CLI parents, explicit command tests and every real contract process remain outside this candidate.

| In-process fake-runtime caller file | Command | Invocations per run |
|---|---|---:|
| `test/review/fix-continuation.test.ts` | snapshot | 17 |
| `test/review/fix-pass.test.ts` | snapshot | 30 |
| `test/review/fix-reopen.test.ts` | snapshot | 44 |
| `test/review/commit.test.ts` | snapshot | 5 |
| `test/review/fix-pass-claims.test.ts` | claim | 17 |
| `test/review/fix-pass-claims.test.ts` | snapshot | 15 |
| `test/review/answer.test.ts` | snapshot | 2 |
| `test/review/publish.test.ts` | snapshot | 4 |
| `test/review/fix-pass.test.ts` | claim | 1 |
| `test/review/runs-on-the-record.test.ts` | snapshot | 4 |
| `test/review/continuation.test.ts` | snapshot | 1 |
| `test/review/pull-request-scope.test.ts` | snapshot | 6 |
| `test/review/base-checks.test.ts` | snapshot | 2 |
| `test/review/review-of-a-fix-run.test.ts` | snapshot | 2 |

The source path is [fake-runtime.runNode](../../test/helpers/fake-runtime.ts), then [src/cli.ts](../../src/cli.ts), the command-module imports and [snapshot/claim dispatch](../../src/command.ts). With a manifest, snapshot reads no ledger and starts no Git; claim also reads only the prepared directory, using exclusive markers for ownership. These are deliberate [R23 of the fix pass](../changes/2026-10-01-fix-pass.requirements.md) and [commit-series integrity](../changes/2026-10-09-commit-series-integrity.requirements.md) boundaries. A future in-process hook must call the real command behavior with the correct cwd/environment and preserve errors, snapshot bytes, claim ownership and isolation; retain command-line and cross-process representatives.

For the first run's 142 async snapshot dispatches with directly matched normal-exit rows, spawn to the child's exit row summed 46.703 s, while exit row to parent close summed 440.810 s. The latter includes other exit handlers, native teardown/cache flush, OS exit, pipe closure and parent scheduling/event-loop delivery. It intersects 274.133 s of completed synchronous Git intervals in the same parents. These per-child intersections can count one parent's Git interval several times; they support a contention hypothesis but neither identify its complete cause nor promise 440 seconds of savings. The 153-start headline also includes sync calls without a recorded child PID. Source imports and command work have not been separately CPU-profiled.

The first contract run observed 2,309 guarded fake-Claude worker launches plus 2,520 help probes and 2,520 version probes. The broader fake-Claude category combines workers with help probes and must not be treated as all worker launches. The fake CLI already lazy-loads its probe and worker paths, so that separation is not a new opportunity. Reducing fixture work can reduce both workers and their qualification probes; changing the production requalification rule is a separate behavior change.

## Waits and preparation

The ordinary first sample completed three 10,000 ms check deadlines in [fix-pass.test.ts](../../test/review/fix-pass.test.ts) and two 4,000 ms role deadlines in [controller.test.ts](../../test/review/controller.test.ts). Their cumulative callback intervals were 36.236 s and 32.677 s, respectively. These values overlap other work and include event-loop lag. They identify focused business-timeout tests, not an amount of wall time that can simply be subtracted. A future controlled host result should fire only after the scripted write/readiness event and exercise the same timeout/restoration routing. Keep the real startup, deadline, tree-kill and orphan tests; do not globally shorten timeouts.

The contract's 10 ms readiness polls wait for real engine work, rather than an unnecessary fixed sleep. Its intentional 2,000 ms orphan observation window used only 0.051, 0.101 and 0.207 s of completed 50 ms polls across the three runs. Shrinking that window is not supported by the measured cost. Guard watchdog polling similarly watches actual child completion and does not impose its whole timer duration as latency.

The first ordinary run constructed 336 ReviewSandbox instances in a cumulative 7.991 s. The role copies consumed 0.483 s and repository-template copies 0.580 s in the JavaScript hooks. These sums overlap other files and do not explain the 61-second critical file. Native SQLite I/O/fsync and unhooked filesystem operations were not measured, so low copy time does not show that ledger/storage is cheap. Immutable preparation reuse remains lower priority than the measured command and timeout targets.

## Next changes by goal

### P0: Scan fix integrated

The source, two regressions and four generated engine bundle/hash files are now integrated together, using the expression recorded in the public data. Latest validation is recorded in the [options report](2026-11-08-test-time-options.md#o1-bounded-path-scanning-integrated). The profile predates the two regressions and includes instrumentation; do not present 66.425 s as literal current-head ordinary performance or combine it with historical speedup percentages.

### P1: Address the qualifying contract job

For successful qualifying-CI latency, the four-minute contract tier is the larger observed tail. First design the smallest fixtures that preserve each stop's required behavior and a composite interaction run, then compare bounded scenario parallelism on the actual required runner capacity. Keep every OS, stop method, point and five-part comparison. No fixture reduction or concurrency configuration is selected or proven faster by this report.

### P2: Remove business-timeout waiting in the ordinary tier

Start with the two fix-pass cases sharing the three 10-second check timeouts, then the two four-second controller role cases. Use explicit readiness and controlled timeout results at the test-host layer, retaining the real lower-level timing and process tests. This is a concrete focused candidate with no production scheduling change, but still needs mutation evidence and a three-pair comparison.

### P3: Avoid selected ordinary claim and snapshot children

Evaluate an in-process command hook only for the 150 qualified fake-runtime dispatches. The measured CPU/process opportunity and affected files make it more specific than replacing all child processes. Preserve real CLI and contract boundaries, and measure file critical-path elapsed time rather than summed asynchronous completion intervals.

### P4: Audit Git reads and defer broad infrastructure changes

Trace same-boundary metadata duplication before changing engine reads. Preserve clean/filter semantics, drift boundaries, append-only evidence and the resumable contract. Preparation reuse, sharding, larger runners and persistent caches remain experiments without a measured benefit. A concurrency experiment must report both job elapsed time and total runner work, not only this host's spare cores.

## Instrumentation and verification limits

The disposable preload hooks public child_process, global completed timers and selected filesystem calls. It writes external JSONL only and adds no signal handler, stop change, timeout or grace-policy change. Two source hooks tag contract spans and completed sandbox construction. Preload propagation follows existing environments; explicit NODE_OPTIONS replacement and early process failure can omit child-internal data. Normal-exit CPU rows are lower bounds because killed engines and POSIX guards can leave no exit record.

The first ordinary run observed 2,851 parent Node dispatches, 2,387 with child PIDs; 2,354 of those had participating preload rows and 33 did not. Another 464 sync/error dispatches had no reported child PID, so they are unjoinable rather than proven uninstrumented. Across all participants there were 3,016 Node process-start rows and 2,488 normal exit rows. The first contract run observed 11,133 parent Node dispatches, 11,028 with child PIDs; 10,996 had participating preload rows, 32 did not, and 105 had no reported child PID. Its 11,939 participating starts and 8,689 exit rows do not form a complete OS process census. Raw rows and summaries retain these coverage distinctions.

An untimed runtime/process smoke check passed 32 cases with one skip before sampling. The profiling logs contained no failure, exclusion or rerun. The separate exact-source `npm run check` passed lint, typecheck and 3,731 ordinary cases: 3,718 passed, 13 skipped, zero failed or canceled. The command took 241.618 s and the runner 217.175 s; these are single correctness-run timings, not a new comparison. `npm run verify` matched Claude's 43 and Codex's 42 files. That original profiling-report validation used committed source and roles without O1 or profiling hooks; its timings remain historical correctness evidence. The subsequent bounded-scan integration has its own validation record in the linked options report. This profiling work changed no permanent code, tests, CI or cache policy, and the real review remains required before release.
