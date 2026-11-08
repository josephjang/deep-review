# Report: Options for reducing test time

This report evaluates reducing the work of the tests, reducing duplicate cases, reusing preparation and compiler work, and running the resumable contract less often. It draws on the current code, the earlier reports of [2026-10-14](2026-10-14-test-and-ci-time.md) and [2026-10-22](2026-10-22-test-suite-after-resumable-runs.md), three successful CI runs and local experiments. Implementation progress records completed local work separately from the remaining recommendations. O7 cancels superseded PR runs, and O8 exempts narrowly defined documentation-only PRs from contract invocations while retaining main validation and adding scheduled/manual backstops. Their live CI effect has not yet been observed. The author keeps the raw experimental logs outside the repository; the measurements and reproducible methods used for the decisions are recorded here.

## Recommendation

O1 now bounds the repeated scanning of long words in `src/review/finding-names.ts`, with its source, two regressions and generated engine bundles included together. A completed comparison of the same 150 files and 3,713 ordinary cases, with three runs per implementation, reduced median process elapsed time from 554.140 to 63.257 s: 88.58% less time, or 8.76 times faster. The path expression was the only source change. This is a stronger immediate opportunity than changing test runners, adding CI shards, or weakening the process tests. The controlled comparison below separates this local result from CI and from the earlier interrupted experiments.

For CI, cancel obsolete PR runs and make contract execution conditional on the change, backed by scheduled and manual runs. For local iteration, enable incremental typechecking. Remove demonstrably duplicate integration cases, then replace length-limit sweeps with boundary cases. The [remaining-bottleneck profile](2026-11-09-remaining-test-bottlenecks.md) now records three instrumented after-O1 observations per tier: ordinary median 66.425 s and contract 239.524 s. O1 is now integrated with the later test-tooling changes, but those instrumented profiles predate its two regressions and remain historical observations rather than literal current-head timings. For qualifying-CI latency, investigate contract fixture work and bounded scenario parallelism; for ordinary feedback, first target controlled business-timeout outcomes, then eligible in-process claim/snapshot commands. No improvement or hosted-CI percentage is established by this profile.

## Priorities

The order weighs measured effect, implementation cost and the possibility of missing a defect. A priority is a recommendation, not authorization to change the required checks. Suite elapsed time, the wait for the latest PR result, total runner time and local feedback time are separate outcomes.

| Order | Work | Primary outcome | Evidence and reason |
|---|---|---|---|
| 1 | Bound the path scan (O1) | Less work in every affected run | Source, two regressions and regenerated bundles integrated with the later test-tooling changes; validation is recorded below. Three same-workload whole-suite pairs reduced median elapsed time by 88.58%, with the same passing case counts. |
| 2 | Cancel superseded PR workflows (O7) | Less obsolete work and queue contention | Implemented locally with unchanged job matrices; live cancellation and savings remain unobserved. Benefit depends on how often pushes overlap. |
| 3 | Run the contract conditionally (O8) | Less CI work on unrelated changes | Implemented for documentation-only PRs with full-run fallbacks, preserved status names and scheduled/manual backstops. Windows contract steps historically took 472 to 801 s; net live savings remain unmeasured. |
| 4 | Incremental typecheck (O9) | Faster local repetition | Implemented with seven invalidation scenarios. Three paired npm-command samples reduced the unchanged warm median from 8.699 to 1.809 s, 79.20% less time; cold incremental median was 8.616 s. |
| 5 | Remove duplicate integration cases (O10) | Fewer expensive scenarios and less maintenance | Five scenarios removed after the coverage audit; the missing-denial case was retained and strengthened. Three affected-file pairs reduced the combined median by 1.35%; continuation's overlapping file median fell 13.84%. |
| 6 | Replace padding sweeps with boundaries (O2) | Fewer renders and bounded test construction | Implemented fixed cap-1/at/+1 cases. Changed-scenario form calls fell from 1,082 to 65; the three-pair marginal-O2 median fell 49.07% with the same isolated O1 expression on both sides. |
| 7 | Use the remaining profile to target contract and ordinary costs (O14/O4, O11/O12/O3) | Shorter qualifying-CI tail or local feedback, according to goal | Contract median 239.524 s versus ordinary 66.425 s under isolated O1. Contract fixture/parallelism design and ordinary business-timeout/150 eligible command calls are concrete next targets; no new optimization adopted. |
| 8 | Defer broader preparation, sharding, cache and capacity changes (O5/O13/O15/O16) | Lower preparation or runner cost only where measured | Ordinary role/template copies totaled about one cumulative second in the first profile; native SQLite I/O was not measured. No shard, capacity or persistent-cache benefit has been established. |

Implement the first four as separate changes where possible, so their effects and policy decisions remain attributable. Do not add their measured or estimated savings: they affect different runs, overlap, and can move the bottleneck to another job. Conditional contract execution, for example, saves no work on a PR that still qualifies for the full contract.

## Evaluation record

Each option gets a before-and-after evaluation when implemented. [The measurement data](2026-11-08-test-time-measurements.json) records the completed whole-suite comparison under `controlledOrdinarySuite`, the paired path-scan samples, the earlier cache experiments and the historical incomplete full-suite baseline. A blank improvement figure means not established, not zero improvement. Measurements of an experiment do not mean that its configuration has been adopted.

| Option | Current evaluation | Established improvement | Evidence still needed |
|---|---|---|---|
| O1: Bound the path scan | Source/regressions/bundles integrated; historical three whole-suite pairs and five public-API pairs per synthetic input retained | Same-workload whole-suite median: 554.140 to 63.257 s, 88.58% less process elapsed time. Synthetic 40,000-letter public-API case: 99.97% less time | CI and complete check-pipeline effects; no before/after contract comparison |
| O2: Boundary cases | Fixed boundaries implemented; 71 named cases retained and ten selected faults rejected | Changed-scenario form calls 1,082 to 65; affected-file median 1.946 to 0.991 s, 49.07% less under a common isolated O1 expression | Marginal O2 only, not shipped-source or cumulative timing; exact proposed-commit correctness and scope are recorded below |
| O3: Git calls | Three profiles per tier: 33,862 ordinary and 13,666 contract public Git invocations per run | No reduction implemented or speedup measured | Trace argument-level duplicate reads within a comparison, preserve HEAD/status boundaries and Git filters, then compare the change |
| O4: Concurrency and splitting | Contract is one file with four sequential scenario suites and up to four concurrent cases inside each | No configuration comparison or gain measured | Bounded scenario experiment on actual OS runner capacity, total work and timeout/resource safety |
| O5: Sharding | Not implemented | Not measured | Latest-revision latency, slowest shard and total runner time including setup and queues |
| O6: Focused edit-loop tests | Available practice; no comparative sample recorded | Not measured | Time to feedback for fixed representative edits; final full-check cost reported separately |
| O7: Cancel obsolete CI | Workflow grouping implemented; actionlint and six local identity cases pass | Not measured; scheduling does not speed up a single suite | Live overlapping PR cancellation, independent main runs, obsolete runner time avoided and latest-push-to-result latency over a recorded observation window |
| O8: Conditional contract | Narrow Markdown policy, complete Git inventory and per-OS gates implemented; local verification recorded below | Three contract invocations and npm installations omitted per eligible PR by design; elapsed and net runner savings not measured | Live exempted/relevant/error/manual/scheduled outcomes, eligible PR fraction, classification/setup overhead, added weekly work and coverage/detection delay |
| O9: Incremental checks | Typecheck adopted; three npm-command samples per condition and seven invalidation scenarios; typed lint remains uncached | Unchanged warm median: 8.699 to 1.809 s, 79.20% less time; cold incremental median: 8.616 s | Representative edit latency and CI cache persistence remain unmeasured. No whole-check gain inferred; lint's earlier warm reduction is not acceptable evidence for required typed linting |
| O10: Duplicate cases and layering | Five integration scenarios removed; one retained; ten temporary rule/wiring mutations rejected | Affected cases 118 to 113; combined median 24.716 to 24.383 s, 1.35% less time. Same-run continuation file median 17.519 to 15.095 s, 13.84% less | No whole-suite or CI-wide timing improvement established; further reductions need their own coverage review |
| O11: Deliberate waits | Ordinary profile identifies three 10 s check deadlines and two 4 s role deadlines; contract orphan polling consumed only 0.051 to 0.207 cumulative s | No waiting change or saving measured | Controlled readiness/timeout host outcomes for business rules, retaining real deadlines, process trees and orphan observation |
| O12: Remaining fake-worker children | 153 snapshot/43 claim dispatches observed; only 132/18 qualify as fake-runtime calls from in-process test-file parents | No process change or saving measured | Real command behavior in selected in-process hosts, representative CLI isolation, critical-file time and unchanged contract processes |
| O13: Preparation reuse | First profile: 336 sandbox constructors, cumulative 7.991 s; role copies 0.483 s and repository copies 0.580 s | No reuse change or gain measured | Native storage cost and critical-path effect; preserve isolated ledgers and writable files |
| O14: Smaller contract scenarios | Three profiles: contract median 239.524 s, dominated by fix and base scenarios; 100 stop cases and empty marks retained | No fixture change or gain measured | Preserve R2 retry/write cases, every point/way, all five comparisons and composite interactions before reducing scenario work |
| O15: CI compile cache and scheduling | Not implemented | Not measured | Cache transfer cost, cold/warm time and worker idle tail |
| O16: Stable inputs and capacity | One contaminated full-suite experiment discarded; no prevention change implemented | Not measured | Rerun rate over an observation window; runner price/time and memory/GC evidence for any capacity change |

### E1: Compare one change at a time

Use the last validated configuration as the baseline for the next option, so its marginal contribution is visible. Also record cumulative time against a completed original baseline when one is available. Keep the test command, input revision, dependencies, OS, runtime version, runner capacity and cache state fixed except for the factor under test. Name changes by proposal, file or PR rather than branch commit hashes, and record the exact commands. Compilation-cache, result-cache and cold/warm conditions must be explicit.

Use at least five alternating before/after pairs for local elapsed-time comparisons where practical, or the smaller count the operator requests; state that limit and which runs were selected. Report the sample count, median and range, and retain failed runs rather than silently dropping them. Keep excluded runs traceable. Separate OS and runner classes in CI comparisons. Do not present a tail percentile from a handful of samples. A deliberately timed-out baseline is a regression reproduction, not a completed timing sample.

### E2: Record time, work and verification separately

Record ordinary-test and contract elapsed times separately, and distinguish the test stage from lint, typecheck, install, build/verify and complete CI latency. Include time from the latest push to the required result and total runner time when evaluating CI policy. For the proposed mechanism, add child starts, Git calls, deliberate waits, cache transfer bytes/time or setup/cleanup time as appropriate.

Record passed, failed, skipped and canceled cases, the selected files and scenarios, and their unit/integration/engine-E2E classification when established. Count required OS and stop-method executions too: moving work to a schedule changes when coverage exists even when the logical case list stays the same. A reduced case count is not itself a speedup, and a test exemption is not a passing test. Layer classification has not yet been completed for this suite.

### E3: State the result and its limits

For comparable completed runs, absolute saving is `before - after`; reduction is `(before - after) / before * 100`; speedup is `before / after`. Publish negative changes as regressions. For policy changes compare equivalent PR cohorts and account for added scheduled work, rather than treating every skipped job as pure net savings. Record the coverage consequence and decide whether to retain, revise or reject the change. Keep synthetic function, local suite and CI results separate, and do not sum improvements from different baselines.

## Paired evaluation of bounded path scanning

The follow-up benchmark calls the public `namedFindings` function on 10,000, 20,000 and 40,000 `q` characters followed by ` RIPPLE-2.`. Both implementations must return the same letters followed by ` finding 3.`. Only the path expression and its explanatory comment differ between the source copies. They share the Markdown dependency, the same one-entry names map and English naming rules. This measures the actual public transformation rather than the expression alone.

Node 26.12.1 on Linux x64 loaded both modules before timing and warmed each with two calls using 1,000 letters and the same id. Each input then ran in five pairs, alternating which implementation ran first. The timed region contains only the function call; startup, module compilation and the assertion of each output are excluded. The raw samples are in the measurement data. The author keeps the temporary benchmark driver outside the repository; the method and complete samples are recorded here so the comparison can be reproduced.

| Letters before the id | Before median (range), ms | After median (range), ms | Reduction in median |
|---|---:|---:|---:|
| 10,000 | 74.448 (74.042 to 74.814) | 0.135 (0.106 to 0.201) | 99.82% |
| 20,000 | 295.519 (295.439 to 296.055) | 0.211 (0.203 to 0.297) | 99.93% |
| 40,000 | 1,075.694 (1,075.199 to 1,095.001) | 0.369 (0.353 to 0.410) | 99.97% |

All 30 measured outputs matched their expected text. This supports retaining O1 for the observed long-word bottleneck. It is not a 99.97% suite or CI improvement: the workload is deliberately synthetic. The later same-workload suite comparison below establishes a separate local improvement of 88.58%. The earlier passing 66.122 s suite remains an absolute validation measurement with two added regression cases, not one of the paired timing samples.

## Controlled whole-suite evaluation

The comparison used two clean copies of the same committed input tree, with identical dependency installation from the lock file and fixed role files. All 150 original ordinary test files and their helpers stayed the same. Only `slashJoined` in `src/review/finding-names.ts` changed to the boundary-constrained expression. The two new compatibility/performance regression cases were excluded from both copies: the long-word case intentionally fails on the original expression. Thus this is a same-workload measurement of the complete existing ordinary suite, not a speedup obtained by deleting cases.

Both sides used Node 26.12.1 on Linux x64 with an AMD Ryzen 9 3900X and 24 available logical processors. The command was `node --import ./test/setup.ts --test --test-reporter=<same summary reporter> "test/**/*.test.ts"`, equivalent to the test selection and setup of `npm test`, with summary recording instead of its usual reporter. Each timed run received a fresh primary `NODE_COMPILE_CACHE` directory; tests that explicitly configure their own caches retained that behavior. Dependency installation, cloning, the npm wrapper, lint, typecheck, build/verify and the contract tier were outside the timed region. The OS page cache was not flushed.

The primary metric is process elapsed time from spawning the test runner to its close, including startup and reporting. The secondary runner-reported durations are retained in the data. Runs were serial, alternating order by pair: before/after, after/before, before/after. The user limited the final comparison to the first three pairs. A fourth pair had already completed when that request arrived and was excluded in full, and the following run was stopped. Those exclusions and the instrumentation pilot are recorded separately; they were not selected by their timings or outcomes.

| Pair | Execution order | Before, s | After, s | Time reduction |
|---|---|---:|---:|---:|
| 1 | Before, after | 552.982 | 63.513 | 88.51% |
| 2 | After, before | 554.487 | 63.257 | 88.59% |
| 3 | Before, after | 554.140 | 62.769 | 88.67% |
| Median by implementation | Three runs each | 554.140 | 63.257 | 88.58% |

The median saving is 490.883 s, about 8 minutes 11 seconds per ordinary-suite run, and the speedup is 8.76 times. The before range is 552.982 to 554.487 s; the after range is 62.769 to 63.513 s. Every selected run exited zero with 3,713 cases: 3,700 passed, 13 skipped, zero failed and zero canceled. The recorded test-file fingerprint and lock-file hash allow the input set to be checked. No tail percentile or statistical confidence interval is inferred from three pairs.

This establishes a local same-workload ordinary-suite improvement for O1. It does not establish an 88.58% improvement for CI, `npm run check`, the contract tier, the two newly added cases or a real model review. The earlier interrupted baseline remains historical evidence only and is not used in this percentage.

## What is already implemented

The review sandbox already runs ordinary fake workers, preflight probes and stand-in checks in the test process (`test/helpers/in-process-runner.ts`). Fakes that need a real process tree, runtime tests, command-line tests and the resumable contract retain real processes. Recommending this migration again would repeat the 2026-10-22 work.

Sandbox repositories already come from a per-process template. Node's compile cache is enabled and inherited by children through `test/setup.ts` and `test/helpers/compile-cache.ts`. Tests run below normal priority to keep other programs responsive. Windows CI already places temporary files on the runner's workspace disk. The contract tier already runs separately, on all three operating systems, beside the check job.

## Current CI evidence

The table gives step durations, not complete workflow or queue time. `check` includes lint, typecheck and ordinary tests. Contract is the `npm run test:contract` step. These are different revisions and potentially different runner hardware, not controlled before-and-after comparisons.

| Successful run | Ubuntu check / contract | macOS check / contract | Windows check / contract |
|---|---:|---:|---:|
| [2026-11-08, 04:53 UTC](https://github.com/josephjang/deep-review/actions/runs/42448592010) | 285 / 320 s | 725 / 484 s | 483 / 472 s |
| [2026-11-08, 06:50 UTC](https://github.com/josephjang/deep-review/actions/runs/42456381588) | 254 / 403 s | 567 / 482 s | 572 / 801 s |
| [2026-11-08, 10:20 UTC](https://github.com/josephjang/deep-review/actions/runs/42471025134) | 1,025 / 292 s | 666 / 502 s | 1,482 / 776 s |

GitHub returned the job and step timestamps through `gh run view --json jobs`, but denied detailed log downloads with HTTP 403. Consequently this investigation cannot attribute the CI increase to a particular test or separate lint and typecheck from test time there. The latest run's unusually high Ubuntu and Windows check times warrant investigation, but their cause is not established by the timestamps alone.

Both tiers matter: in the middle run, the Windows contract step takes 801 s while check takes 572 s. Reducing ordinary tests alone would leave the contract job as the gate's longest test step.

## Local measurement and the immediate bottleneck

The measurement used Node 26.12.1 on Linux with `os.availableParallelism()` reporting 24. There are 150 ordinary test files. The normal test command was used with a custom reporter that recorded `test:pass`, `test:fail` and `test:summary` events. No coverage collection or model calls were added. All figures are single-run observations; other programs and some overlapping experiments were present, so they are not controlled benchmark medians.

The original run was deliberately stopped at its two long-running PR form test processes. Its runner ended after 252.542 s, reporting 3,629 passed, 13 skipped and two file failures caused by those explicit stops. This is an incomplete baseline, not a passing test run and not evidence that either test would fail on its own.

Other completed files in that run included `fix-pass.test.ts` at 58.595 s, `publish.test.ts` at 47.217 s, `fix-reopen.test.ts` at 46.686 s, `cli.test.ts` at 38.456 s and `controller.test.ts` at 38.450 s. File durations include contention and overlap; adding them does not give the suite's elapsed time.

### The intended path rule

[R3 of finding names in the review](../changes/2026-11-08-finding-names-in-the-review.md#r3-only-the-runs-ids-and-code-stays-code) requires keeping an id inside a file path unchanged while naming ids joined only to other ids. `namedFindings` calls `slotsOf`, which calls `outsideKept`. That function finds URL and path ranges before selecting ids. `outsideKept` scans for paths even when the text contains no id and no path separator.

The path expression is:

```js
const slashJoined = /[\w.~-]*(?:[/\\][\w.~-]*)+/g;
```

For a long word with no slash or backslash, its initial repetition consumes the word and backtracks while looking for the required separator. The unanchored search repeats at each subsequent position. This explains the measured near-quadratic cost on the repeated `q` padding used by the length tests. The concern is the scanning cost, not the intended rule that paths remain unchanged.

| Input, no separator | Original expression | Boundary-constrained experiment |
|---|---:|---:|
| 5,000 `q` characters | 22.37 ms | 0.041 ms |
| 10,000 | 91.81 ms | 0.067 ms |
| 20,000 | 355.52 ms | 0.134 ms |
| 40,000 | 1,417.38 ms | 0.252 ms |
| 60,000 | not measured | 0.606 ms |

The isolated experiment prevents a new attempt inside a run of path characters:

```js
const slashJoined = /(?<![\w.~-])[\w.~-]*(?:[/\\][\w.~-]*)+/g;
```

The two expressions returned the same matched text and start indexes for all 335,923 strings of length zero through seven over the alphabet `q`, `.`, `/`, `\`, space and `-`. This finite comparison supports the experiment; it is not a proof of equivalence for every input. Before adoption, require the existing naming and diagram cases, both path separators, adjacent paths, URLs, Unicode surroundings and long non-matching words to retain their behavior.

The microbenchmark is reproducible with Node alone:

```js
const before = /[\w.~-]*(?:[/\\][\w.~-]*)+/g;
const after = /(?<![\w.~-])[\w.~-]*(?:[/\\][\w.~-]*)+/g;
for (const length of [5000, 10000, 20000, 40000]) {
  const text = 'q'.repeat(length);
  for (const [name, pattern] of [['before', before], ['after', after]]) {
    const started = performance.now();
    const matches = [...text.matchAll(pattern)];
    console.log({ length, name, ms: performance.now() - started, matches: matches.length });
  }
}
```

## Options and tradeoffs

### O1: Bound the path scan before changing test coverage

The [bounded-path-scan proposal](../changes/2026-11-08-bounded-path-scan.md) records the source change now included with two regression cases and four generated engine bundle/hash files. It addresses a shared production function and preserves the path and finding-name behavior of R3. Its benefit extends to long worker prose, not only the suite. The historical controlled comparison preserved the original test inputs; the latest integration checks cover the subsequently changed suite. The real-run gate of vision principle 12 remains required before release.

An alternative is to avoid path-range scanning when no candidate id occurs, but that must also preserve the separate diagram identifier checks. Do not merge multiple speculative fast paths before measuring the simpler expression change.

### O2: Replace incremental padding sweeps with boundary cases

The original `pull-request-form.test.ts` rendered from padding zero until refusal, 200 characters at a time, twice: with and without diagrams. `pull-request-areas.test.ts` rendered both a plain and a secret-bearing answer at each step until the area diagrams were cut. The [boundary-padding proposal](../changes/2026-11-09-boundary-padding-tests.md) replaces those searches with a fixed five body cut states, four without a diagram, and three input neighbors at each state's public 60,000-character boundary.

A successful one-character seed calibrates only input length. The tests assert the independent cap, literal expected cut order, exact lengths of 59,999 and 60,000, and the next cut or a 60,001-character refusal. No cut oracle is read from the implementation or discovered from returned cuts. Progress and maximum padding are bounded. The comment path also tests below, at and above its cap. Cut notices, questions, area heading/title/intro, full findings, publication markers and refusal details remain checked. Secret and plain area titles are calibrated independently and retain the one-secret difference at each matching literal state.

An earlier temporary threshold-jump experiment retained the 200-character grid and original expensive expression, passing 71 tests in 149.721 s. That historical experiment is separate from the adopted fixed-boundary construction and the marginal-O2 comparison below. The new timed comparison uses the same isolated O1 expression on both sides, as recommended here, rather than charging the original quadratic scan to O2 or spending another three baseline runs in that known cost. Exact proposed-commit validation uses the original committed production source.

### O3: Reduce measured Git calls, preserving freshness

The October report measured 22,582 Git starts after the in-process fake migration, but that is historical evidence, not a current count. The current engine still reads `HEAD` during drift checks, reads status for strays, and uses separate diff and untracked-file commands in `changedAgainstHead`. The tests exercise those paths repeatedly.

The three local after-O1 profiles observed 33,862 ordinary and 13,666 contract Git invocations per run; the [focused profile](2026-11-09-remaining-test-bottlenecks.md) separates elapsed child waits from CPU and wall time. Argument-level metadata variants and other OS runners remain unprofiled. Investigate combining reads within one comparison, batching object queries, and avoiding duplicate immutable metadata reads. Do not cache worktree status or `HEAD` across worker/check boundaries: external edits and interrupted writes are exactly what those checks must detect. Preserve Git's line-ending and filter semantics instead of replacing Git with a partial imitation. This option is a larger engine change and requires the resumable contract tests.

### O4: Tune both levels of concurrency, and split measured long files

The outer runner executes files concurrently; sandbox suites also run up to four tests per file. [Node documents](https://nodejs.org/api/cli.html#--test-concurrency) the default file concurrency as available parallelism minus one. Increasing one level can multiply the load of the other and slow process starts or introduce timeout failures.

After O1, compare explicit file concurrency values on the actual runners, alternating configurations and recording elapsed time, CPU, peak memory and failures. Split a file only when its serial top-level suites leave a significant tail. The contract file currently has four scenario suites with separate reference runs and a shared helper, making scenario-based separation a plausible experiment. Its real-process stops, orphan checks and OS-specific marks must remain intact. A split can reduce elapsed time on spare cores but does not remove the work or guarantee a gain on small runners.

### O5: Shard CI only if latency still justifies the extra runners

[Node's `--test-shard`](https://nodejs.org/api/cli.html#--test-shard) partitions by file. It cannot divide the current single contract file; that tier needs a split or an explicit case partition first. Measure the slowest shard, include installation and queue time, and verify that every required test appears in exactly one shard.

The author deferred shards in [the October proposal](../changes/2026-10-15-test-and-ci-time.md) because of runner cost. Revisit that tradeoff with new measurements, rather than treating the earlier estimated five-to-six-minute Windows result as a current prediction. Wall time and total runner minutes are different metrics; added setup overhead and reduced contention determine the latter, so a shard count alone does not establish the cost multiplier.

### O6: Shorten the edit loop without weakening the gate

During local iteration, run the relevant test files directly, keeping `--import ./test/setup.ts` for Git-environment protection and cache setup. Finish with `npm run check` at the required commit and series boundaries, plus `test:contract` when the repository's rules require it. Focused tests improve feedback time but do not establish that unrelated tests pass.

Selection must include dependencies read dynamically, such as role fragments, fixtures and commands launched in children, not just TypeScript imports. A file-selection failure must fall back to the full suite. This is an edit-loop optimization under the current rules, not a replacement for the full required checks.

### O7: Cancel obsolete PR runs

The original `check.yml` had no workflow concurrency group, so another push to a PR could leave the previous revision running its three check jobs and three contract jobs. The [O7 proposal](../changes/2026-11-08-cancel-obsolete-pr-ci.md) now groups the entire workflow by workflow name, event name and PR number, with a unique run-id fallback for non-PR events. Cancellation is enabled only for pull requests. Separate main run ids prevent both running cancellation and pending-run replacement. [GitHub documents workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

This does not make a single test faster. It reduces work whose result the author no longer needs and can release runner capacity for the latest revision. Measure canceled runner minutes and time from the latest push to its result; the sampled CI data does not establish their current magnitude.

### O8: Run the contract less often

The contract deliberately stops a real engine, resumes it, compares the result with an uninterrupted run and checks for orphan processes. [R1 and R2 of resumable runs](../changes/2026-10-18-resumable-runs.requirements.md#r1-resumable-means-five-things) state why ordinary unit tests cannot replace it. Its execution frequency is a separate policy choice from keeping those guarantees and cases.

| Policy | Work saved | Consequence |
|---|---|---|
| Relevant changes only | Contract invocations on changes classified as unrelated | A classifier omission can let a relevant change merge without the contract. |
| Once before merge | Repeated contract runs during PR editing | Every later change invalidates that result; final validation needs an automatic, revision-specific trigger. |
| Scheduled and manual runs only | Contract work leaves the normal PR path | Recovery defects can merge and become installable before detection. |

The [O8 proposal](../changes/2026-11-08-conditional-contract-ci.md) implements relevant-change execution with an exemption only for regular, non-executable `.md` files below `docs/` and the exact root `README.md` and `AGENTS.md` paths. Other documentation extensions, prompts, skills, generated output, engine sources, dependencies, toolchain, role policy, tests/helpers and CI/build configuration remain relevant. Report rendering and schemas matter too: the contract compares reports and frozen records, not just process termination. Unknown changes and incomplete inventories produce a valid decision to run the full matrix. A failed or malformed classifier also runs the full tier and then fails each existing contract status.

For PRs, the Node classifier checks the entire branch from its unique merge base and the actual tested merge against its target base. It validates event SHAs and merge parents, requires full history, and reads NUL-delimited raw Git diffs with rename detection disabled so both endpoints and file modes count. It has no paginated API dependency. Every revision gets a new decision, and only a pull_request event can receive an exemption; workflow_dispatch forces full validation on its selected revision.

Every qualifying change still runs all three OS contracts because process termination, file handling and known-failure marks differ by OS. All main pushes remain fully checked. The Monday 03:23 UTC schedule and manual dispatch run the complete workflow, including three ordinary check/verify jobs as well as the three contract jobs. They add work, rather than making every PR cheaper. Schedules run on the default branch and may be delayed or dropped, so they establish no fixed detection interval and prove nothing about intermediate main revisions. A scheduled failure must be investigated and rerun on its named revision/OS before that revision is considered validated.

The classification and always-run aggregate jobs distinguish explicit exemptions from failed, canceled or skipped prerequisites. Each existing contract matrix job still allocates a runner, checks out, sets up Node and validates the plan; an eligible PR omits only npm ci and the contract command. Retaining these names avoids depending on a branch-protection migration. The read-only protection query returned HTTP 401, so the actual required checks remain unconfirmed and repository settings were left unchanged; the new aggregate does not automatically become required. No `paths-ignore` filter is used: [GitHub says filtered-out workflows can leave required checks Pending](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpull_requestpull_request_targetpaths).

The proposal, AGENTS, README and workflow now state the same exemption and fallback policy, superseding the earlier every-PR CI practice. A mistaken exemption can defer a relevant defect until main-push validation, exposing an installable revision in the meantime; that risk is accepted with the narrow policy and preserved main checks. No engine behavior or contract scenario is changed. Local verification does not establish live workflow adoption or a completed real-review gate.

The decision to skip the contract is not a claim that it passed. It reduces average work across eligible PRs, and shortens a PR's wait only if the skipped contract would otherwise outlast its check jobs. Measure the fraction of PRs exempted and the new longest required job before claiming a CI-wide gain.

### O9: Reuse typechecking work and distinguish lint caching

The initial typecheck command was `tsc --noEmit`; tsconfig had no incremental setting. The lint command remains `eslint .`. The earlier experiments below ran each tool directly through Node, with temporary cache files outside the repository, on the same Linux environment as the initial experiments. Each command exited zero. These are historical single runs with unchanged inputs, not measurements after a source edit or on CI; they are retained separately from the subsequent three-sample npm-command evaluation.

| Tool | Normal | First cached run | Unchanged warm run |
|---|---:|---:|---:|
| TypeScript | 8.646 s | 8.351 s | 1.655 s |
| ESLint | 14.963 s | 15.299 s | 0.666 s |

The [incremental-typecheck proposal](../changes/2026-11-08-incremental-typecheck.md) adopts `tsc --noEmit --incremental --tsBuildInfoFile .cache/typecheck.tsbuildinfo` as the npm typecheck command. [TypeScript's incremental cache](https://www.typescriptlang.org/tsconfig/incremental.html) stores compilation graph information; the ignored cache is disposable, and deleting it forces a fresh check. tsconfig's semantic options and the editor/lint configuration are unchanged. No cache is uploaded or restored in CI, so fresh runners still start cold.

The controlled follow-up uses three samples per condition, as requested, and includes the actual `npm run typecheck` process from spawn to close. A single isolated checkout keeps TypeScript source, configuration and dependencies fixed; only the npm typecheck script and TypeScript state differ. Pair 1 runs uncached, cold incremental, warm incremental; pair 2 runs cold incremental, warm incremental, uncached; pair 3 repeats pair 1. Each cold sample deletes the TypeScript state and primes the following unchanged warm sample. Script changes and state deletion are outside the timer. All nine samples exited zero. The author keeps the raw logs outside the repository; the [measurement data](2026-11-08-test-time-measurements.json) records every sample, commands, environment, input fingerprint and reproducible invalidation fixture.

| Pair | Uncached npm command (s) | Cold incremental (s) | Unchanged warm incremental (s) |
|---|---:|---:|---:|
| 1 | 8.695560 | 8.616380 | 1.778297 |
| 2 | 8.698805 | 8.531785 | 1.814709 |
| 3 | 8.832461 | 8.750036 | 1.808939 |
| Median | 8.698805 | 8.616380 | 1.808939 |

The unchanged warm median saves 6.889865 s, a 79.20% reduction and 4.81 times speedup relative to the uncached median. The uncached range is 8.695560 to 8.832461 s, cold incremental 8.531785 to 8.750036 s, and warm incremental 1.778297 to 1.814709 s. Cold incremental remains close to the original cost; these three samples establish no cold-run improvement, tail percentile or confidence interval. Node v26.12.1 and TypeScript 6.0.3 ran on Linux x64. `NODE_DISABLE_COMPILE_CACHE=1` disables Node's bytecode cache for all these samples, independently of TypeScript's incremental state. The OS page cache was not flushed, so cold refers only to absent TypeScript state. The earlier direct-compiler timings are not combined with this npm-command sample.

Seven correctness scenarios checked imported-type changes and dependency declaration updates with original modification times restored, a compiler-option change, an imported-file deletion, and missing, malformed and stale-version state. All four ordinary input mutations failed on the first incremental check, a repeated incremental check and an uncached check, with identical cached/uncached diagnostics. Restoring valid inputs succeeded without deleting the cache. All three absent/unusable-state scenarios still rejected invalid input and recovered with current-version state after restoration. These probes establish invalidation correctness for the pinned compiler and fixture, not representative edit latency or a compiler-wide proof. No permanent tests that mirror compiler flags were added.

The ESLint experiment added `--cache --cache-strategy content --cache-location <cache-file>`. The 0.666 s result is not a safe basis for enabling it in the required check: this repository uses type-aware rules, while [ESLint does not invalidate a cached file when another file it depends on changes](https://eslint.org/docs/latest/use/command-line-interface#--cache). Keep authoritative typed linting uncached unless dependency-aware invalidation is established. Content-based file keys alone do not solve that problem. An optional local cached lint command must be clearly distinguished from the full check.

### O10: Remove duplicate cases by assigning verification to one layer

The target is fewer executions of the same scenario, not fewer `it` declarations with the same work hidden inside loops. Keep detailed input variants at the lowest layer that owns the rule, and integration cases for extracting the right inputs, recording results and connecting components. A shared expectation derived from the production implementation is not an independent test oracle.

| Audited candidate | Verification retained | Decision |
|---|---|---:|
| Claude different-session launcher row duplicates the following session-recording case | The surviving launcher case now also asserts the exact failure, null answer/output evidence and verified frozen evidence; adapter session cases remain | Remove 1 execution |
| Claude envelope without a denial list | Keep a dedicated launcher case and strengthen receipt/ledger null-denial evidence, alongside the adapter rejection unit | Retain 1 candidate |
| Codex plain non-JSON launcher row | Decoder malformed-line units and retained launcher oversized malformed-stream cases, including frozen evidence | Remove 1 execution |
| Continuation mismatch variants for added path, another scope mode and moved HEAD | Keep the focused scope comparisons and changed-bytes caller case, strengthened to prove distinct new-run identity, unchanged old events/fold/report and exact refusal logging | Remove 3 executions |

The [duplicate-scenario proposal](../changes/2026-11-08-reduce-duplicate-test-scenarios.md) records the six-candidate audit: five integration scenarios were removed and the missing-denial case was deliberately retained as an evidence-recording boundary. The removed work comprises two direct launcher calls and three full read-only reviews followed by three fix commands that create blocked new runs; it is not hidden in loops. Detailed rejection and scope reasons remain at their owning layer. Ten temporary mutations rejected by the retained tests cover the selected rules, the controller's changed-byte callback and routing/logging, failed-result propagation and denial recording. This is targeted evidence, not a proof that every possible regression is covered.

The lower-level scope comparison cases still use temporary Git repositories and captured checkpoints. Here the layering separates rule ownership and smaller test boundaries; it does not claim these comparisons are dependency-free unit tests or complete the suite-wide layer classification.

Apply the same review to `tasks.test.ts` and `phases.test.ts`: the task builders own detailed wording, while phase tests own extracting data from recorded state and selecting the task. In `controller.test.ts`, retain a complete review and representative failure, degradation, budget and drift paths; do not repeat every lower-level wording or parsing variant through a whole review. Moving a case to a new unit test can lower time without reducing the total case count, and should be reported that way.

Keep old checkpoint fixtures and per-version schema checks: forward compatibility is an explicit repository contract, and a newer fixture does not replace proof that an older one opens. Prompt bytes are also product behavior here, so role and skill tests cannot be dismissed merely because they assert text. Preserve permission boundaries, schema/prompt vocabulary consistency, record-before-edit rules and real interruption tests.

### O11: Remove deliberate waiting from business-logic tests

The current profile identifies two four-second role timeouts in controller tests and three ten-second check timeouts in fix-pass tests. For a test whose subject is what happens after a timeout, return a controlled timeout result or use an injected clock instead of waiting for wall time. Retain real deadlines and process trees where the subject is startup timing, guard behavior, termination or orphan cleanup. Do not globally shorten timeouts: a slow runner can then turn a valid worker into a spurious failure.

The contract already polls readiness markers rather than sleeping blindly between phases. Its orphan grace period is an observation window, not automatically wasted time. Profile deliberate waits separately from process startup before replacing them, and retain at least the real-process boundary cases each business-logic substitute depends on.

### O12: Reduce the remaining child starts inside fake workers

The in-process fake worker still runs its claim and snapshot commands through child Node processes in `test/helpers/fake-runtime.ts`. For tests of ownership, revision attribution or retry decisions, a test host could call the command implementation directly. Keep representative command-line cases that prove argument parsing, quoting, process boundaries and the recorded result. Keep the real children throughout the resumable contract.

This extends the existing fake-host design rather than removing the guard from production. It changes the verification boundary and needs a coverage comparison before adoption. The current profile observes 132 snapshot and 18 claim calls made by fake-runtime inside test-file processes, separately from real fake-CLI and explicit command cases. Its parent completion intervals, normal-exit CPU and matching limits are recorded separately; cumulative asynchronous intervals are not removable suite time.

### O13: Reuse immutable preparation while isolating writes

Every `ReviewSandbox` copies the roles directory and rewrites its policy, despite repository creation already using a template. A frozen per-run template can avoid repeated discovery, parsing or policy preparation. Keep each test's writable repository, policy, counters and checkpoint private. Do not share SQLite connections, mutable ledgers or hard-linked files that a test can edit.

Copy-on-write file copies may help large fixtures where the filesystem supports them, with a normal-copy fallback. They still pay directory and metadata costs and may do little for the small role fragments. Measure constructor, copy, index-refresh and cleanup time separately before adding an overlay or more fixture machinery.

### O14: Make contract scenarios smaller without removing the contract

The common fix scenario includes a finder failing once, two fixer clusters, a lint rewrite and documentation reconciliation. Each stop case starts a fresh scenario, so those behaviors are repeatedly paid for even at stops whose immediate subject is narrower. Consider a smaller scenario for generic phase boundaries and specialized scenarios for retry exhaustion, edited-file restoration, documentation and base checks, while retaining a composite run that crosses their interactions.

The current scenario deliberately supplies the behaviors each stop needs, as R2 of resumable runs requires. A reduction must still reach every designated point, execute each applicable stop method, compare the five contract parts against the reference for that scenario, preserve OS-specific marks and test cross-phase interactions. Do not reuse a live checkpoint by editing its recorded paths or deleting events. Reusing a stopped prefix is a larger compatibility and isolation problem than reusing an immutable repository template.

### O15: Preserve compile caches between CI runs and shorten execution tails

The existing Node compile cache lives under `node_modules` and `npm ci` clears it. Restoring a dedicated cache after installation could preserve compilation work between jobs or runs. Separate it by OS, architecture and Node version, use the runtime's content validation and measure restore/save time and bytes. [Node's cache documentation](https://nodejs.org/api/module.html#module-compile-cache) also describes portability constraints. This cache does not eliminate process startup and is not a cache of passing test results; the workflow's npm cache serves a different purpose.

Historical file durations can also guide starting long files first or balancing shards. This shortens the tail only when some workers would otherwise be idle; it does not reduce the tests' work. Confirm that the chosen runner entry point honors the intended order and update timings as the suite changes. Keep the implementation in Node.

### O16: Avoid repeated work caused by unstable inputs and capacity choices

Local tests should run against a fixed source and role snapshot or an isolated checkout when another task edits the workspace. The discarded full-suite experiment in this report demonstrates the cost of mixing role versions during a run. Use that as a reason to prevent avoidable reruns, not as evidence for changing production role handling. CI normally starts from a fixed checkout already.

Compare larger or faster runners, storage placement and heap settings only after the algorithmic and process costs are measured. A larger runner can lower elapsed time while raising the bill; a heap increase helps only if garbage collection or memory pressure is material. Similarly, placing a quick validation job before the contract can save work on failures but delays successful contract runs by that job's duration. Select these policies using both successful-result latency and total runner time.

## Options not recommended now

Changing from `node:test` to Jest or Vitest does not remove the observed path scan or Git/process work, and adds a transformation/runtime difference from the engine's direct Node execution. Disabling process isolation makes file execution serial under [Node's documented execution model](https://nodejs.org/api/cli.html#--test-isolationmode) and introduces shared module and environment state. Neither is supported as an immediate optimization by this evidence.

Do not replace the contract's real processes with the in-process fake runner: that would remove its evidence of actual interruption and orphan behavior. Prefer reducing execution frequency under O8 to silently removing an OS or a stop method from the contract. Scheduled-only testing or moving some OS checks out of PR validation is a separate acceptance of later defect detection, not equivalent coverage before merge. Do not disable evidence durability, omit drift checks, or accept the offline suite as the release gate. Vision principles 1, 2 and 12 require preserving evidence, records and a real run while reducing cost.

## Verification and next decision

The isolated path-expression experiment passed the two original PR form files, 71 tests, in 2.182 s. The finite matcher comparison passed 335,923 inputs. A first full-suite experiment was discarded: the temporary copy still linked the workspace's roles, which another task changed during the run, causing policy parsing and role-digest failures. The follow-up froze those files from the committed tree and completed the 150-file ordinary suite in 64.945 s: 3,700 passed, 13 skipped, zero failed. That is an experimental suite result, not a passing `npm run check`: lint, typecheck, the contract tier, build verification and a real model review were not run for the temporary implementation. The original full-suite run was deliberately interrupted and must not be reported as passing. No CI experiment was run, and no engine, test, role prompt or generated artifact was changed by this investigation.

The follow-up baseline, cold-cache and warm-cache typecheck and lint commands all exited zero; their timings and unchanged-input limitation are recorded under O9. They ran against the workspace and do not establish that the temporary path-expression implementation passed lint or typecheck. That initial investigation removed no duplicate case, tested no conditional-execution classifier and added no scheduled CI run. Later implementation progress is recorded below.

O1 source, regression tests and generated bundles are now integrated and locally validated as recorded below. The later controlled comparison establishes its ordinary-suite improvement at 88.58% on the measured environment. O7 and O8 are implemented as independent workflow changes, with their CI benefits still unmeasured. O9 now reuses TypeScript state after successful invalidation probes and a three-pair unchanged-input evaluation; its compiler-only figure is not added to O1's suite reduction. O10 removed five audited integration scenarios, with modest combined affected-file savings because retained timeout work dominates; its maintenance and coverage allocation result is separate from a pipeline speedup. O2 now uses fixed boundary construction, with its marginal result measured under a common isolated O1 expression; it is not added to O1's reduction. The remaining ordinary and contract profile is now complete; its goal-specific next decisions are in the focused report. For each change, record ordinary-suite and contract elapsed time separately, latest-push-to-result time, total runner minutes, failures and reruns, and any newly exempted revisions. Remeasure before selecting the remaining options; none of the unmeasured ones has a promised speedup.

## Implementation progress

### O1: Bounded path scanning integrated

The source implementation preserves the path and finding-name requirements of O1 and adds two regression cases. The initial isolated evidence is retained here separately from the later integration check. The long-word child-process regression failed against the original code at its 30 s timeout. With the bounded expression, all 120 tests in the finding-name, finding-name case, PR form and PR area files passed in 1.913 s. `npm run check` passed lint, typecheck and 3,715 tests: 3,702 passed, 13 skipped and zero failed; the test stage took 66.122 s. Build and verify matched both distribution artifacts. No existing test was removed. Those initial measurements preceded the later test-tooling changes. The source, proposal, two regressions and four generated engine bundle/hash files are now included together; the author keeps the validation logs outside the repository.

Those initial checks ran in an isolated checkout with the committed role inputs so unrelated role edits could not contaminate the result. They are historical local validation, not a completed real-model or CI gate or the latest integration check. The contract tier was not rerun because the change affects none of the stop, resume, launch or append paths that require it.

The latest integration checkout contains the current committed source/roles plus O1 and its two regressions, excluding unrelated role work. The four focused files passed 120 cases with no skips or failures, and the build regenerated exactly four engine bundle/hash files. The latest `npm run check` passed lint, typecheck and 3,733 ordinary cases: 3,720 passed, 13 skipped, zero failed and zero canceled. Its 87.839 s command time and 63.571 s runner time are a single integration check, not a new same-workload benchmark or a literal comparison with the earlier instrumented profile. `npm run verify` matched Claude's 43 files and Codex's 42 files. The rebuilt outputs match the submitted bundles; the unrelated role edits were preserved and excluded. No performance sample was added to the existing three-pair comparison, and the real review remains required before release.

### O7: Cancel obsolete PR workflows

The workflow-level concurrency block covers both three-OS matrices, with the same triggers, job names, steps and commands as before. actionlint v1.7.12 passes without diagnostics using `actionlint -shellcheck='' -pyflakes='' .github/workflows/check.yml`. A local calculation of the group and cancellation expressions checked six identities, shown below; it checks the grouping intent rather than executing GitHub's scheduler. Comparing the workflow after removing the new concurrency block with the committed original confirmed that no existing job or trigger changed.

| Identity | Group | Cancel in progress |
|---|---|---|
| PR 42, first update, run 1001 | `check-pull_request-42` | true |
| PR 42, second update, run 1002 | `check-pull_request-42` | true |
| PR 43, run 1003 | `check-pull_request-43` | true |
| Different workflow, PR 42, run 1004 | `release-pull_request-42` | true |
| Main, first push, run 42 | `check-push-42` | false |
| Main, second push, run 43 | `check-push-43` | false |

The event namespace prevents a PR number from colliding with an equal main run id. GitHub does not guarantee dispatch order, and manually rerunning an old PR revision can cancel a current run in the same group; require a successful run of the current revision before merging. Cancellation of an earlier revision is not evidence that it passed.

`npm run check` passed lint, typecheck and 3,713 ordinary tests: 3,700 passed, 13 skipped, zero failed and zero canceled. The command took 578.582 s, with 554.188 s reported by the test runner; these are single verification timings, not a measurement of O7's scheduling effect. `npm run verify` matched both distribution artifacts. The isolated checkout used the committed inputs plus this workflow/proposal change, excluding unrelated role edits and the separately prepared O1 implementation. The author keeps the full logs outside the repository; the measurement data records the results and counts.

The contract tier was not run locally because this change affects no engine stop, resume, launch or ledger behavior. No CI run has been triggered for this change, so avoided runner time and latest-push latency remain unmeasured. No existing test case or required OS is removed, and no contract exemption is introduced. The real review remains required before release.

### O8: Conditional contract execution

The implementation exempts only a complete documentation-only PR and preserves all existing matrix status names. Its local test cases cover actual Git histories with multiple PR commits, target advancement, rename endpoints, deletion, executable Markdown, crisscross ancestry, missing/shallow history and merge-only source edits. Gate tests reject malformed outputs, unsafe file counts, non-PR exemptions and failed/canceled/skipped prerequisites. actionlint v1.7.12 passed with no diagnostics. The final isolated ordinary-suite run passed all 23 policy tests as part of 3,736 total cases: 3,723 passed, 13 skipped, zero failed and zero canceled. npm run check passed lint, typecheck and tests in 578.707 s, with 554.699 s reported by the runner. npm run verify matched both distribution artifacts. The checkout used committed source and role inputs plus this change, excluding the prepared O1 implementation and unrelated role edits. These are single verification timings, not an O8 performance comparison; the author keeps the full logs outside the repository.

The contract job uses `!cancelled()` to run fallback work after classification failure while preserving O7 cancellation of obsolete workflows. The aggregate alone uses `always()` and has a five-minute timeout. [GitHub documents that always() jobs may continue after cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation); the expensive matrix is therefore kept cancelable. Ordinary check/verify jobs remain unconditional, and the workflow grants only contents:read with no elevated PR trigger.

| Run class | Contract work | Remaining or added work |
|---|---|---|
| Eligible documentation-only PR | Three contract invocations and three npm installations omitted | Three OS runners still allocated for checkout/setup/gates, plus plan and aggregate jobs; ordinary checks unchanged |
| Relevant PR or valid uncertain-inventory fallback | All three contracts run | Plan and aggregate overhead added |
| Failed/malformed classifier | All three contracts attempted, then existing statuses fail | Aggregate also rejects the invalid plan; workflow cancellation remains canceled rather than exempted |
| Main push | All three contracts retained | Plan and aggregate overhead added |
| Weekly/manual workflow | Three contracts and three ordinary check/verify jobs run | Full additional workflow cost, including plan and aggregate jobs |

The Windows contract steps historically took 472 to 801 seconds, but that range is not a measured O8 saving. No live exempted/relevant PR, fallback, manual dispatch or scheduled run was triggered in this session. Eligible PR fraction, classification checkout cost, net runner savings and latest-push latency remain unmeasured, so neither a per-PR elapsed reduction nor a CI-wide percentage is claimed. A failed protection query (HTTP 401) prevented confirming required-check settings; no settings were changed, and the original matrix gates remain in place. The real review remains required before release.

### O9: Incremental typechecking

The npm command now uses TypeScript incremental no-output checking with state at the ignored `.cache/typecheck.tsbuildinfo` path. The same compiler and project inputs remain authoritative, and typed ESLint remains uncached. Three actual npm-command samples per condition show a 79.20% unchanged warm reduction, from a median 8.698805 to 1.808939 s; cold incremental median is 8.616380 s. Seven invalidation scenarios passed as described under O9. These results apply to repeated typechecking, not tests, contract execution or complete CI latency.

The isolated `npm run check` passed lint, typecheck and 3,736 ordinary cases: 3,723 passed, 13 skipped, zero failed and zero canceled. The full command took 599.742 s and the ordinary runner reported 575.755 s; `npm run verify` matched both artifacts. This single verification disables Node bytecode caching as the measurements do, which is separate from TypeScript incremental state. Its timings are not compared with earlier ordinary-suite experiments, and it excludes the separately prepared O1 implementation and unrelated role work. No test case or OS is removed, and no contract run or real review was triggered. The real review remains required before release.

### O10: Duplicate integration scenarios

Five scenarios were removed from the two affected files, reducing their cases from 118 to 113: launcher 97 to 95 and fix continuation 21 to 18. One platform-specific skip remains unchanged. No adapter or focused scope comparison case was removed. The surviving changed-bytes integration proves the controller passes its Git comparison into the scope rule and preserves the old review while creating a new run. The surviving wrong-session launcher case absorbs the duplicate failure/evidence assertions. The missing-denial case is retained with explicit null-denial receipt and ledger assertions.

The affected integration files plus adapter and focused scope tests passed 282 cases: 280 passed, two skipped, zero failed; the runner reported 24.379 s. Ten disposable source mutations were each rejected by a semantic assertion in a retained test. They disabled added-path, mode and HEAD checks; omitted the controller's drift callback; ignored its mismatch or removed its refusal reason; disabled Claude's session guard; converted failed verdicts to completion; converted unknown denial evidence to an empty list; and disabled Codex's malformed-stream guard. Every mutation was restored before measurement and final validation. The [measurement data](2026-11-08-test-time-measurements.json) records exact edits, commands, failing test names and diagnostic excerpts; the author keeps full logs outside the repository.

Three alternating pairs ran the two affected files together with identical committed engine, role, helper and dependency inputs, apart from the intended test edits. A fresh primary Node compile-cache directory was used for each invocation; existing helper cache behavior remained unchanged, and the OS page cache was not flushed. The primary metric is process spawn to close. Each run passed, with 117 passed/one skipped before and 112 passed/one skipped after. All six planned invocations are included without exclusions or repetitions.

| Pair | Before process elapsed (s) | After process elapsed (s) |
|---|---:|---:|
| 1 | 24.504016 | 24.382816 |
| 2, after first | 24.961977 | 24.288090 |
| 3 | 24.716485 | 24.401813 |
| Median | 24.716485 | 24.382816 |

The combined observed median saving is 0.333669 s, or 1.35%, calculated as `(median before - median after) / median before * 100`. The before range is 24.504016 to 24.961977 s and the after range is 24.288090 to 24.401813 s. These three samples establish no confidence interval or statistical significance. This is a deliberately reduced-work comparison, not an identical-work optimization, and no whole-suite or CI-wide percentage is inferred.

| File, from the same concurrent invocations | Before runner median (s) | After runner median (s) | Observed reduction |
|---|---:|---:|---:|
| Runtime launcher | 24.415166 | 24.073364 | 1.40% |
| Fix continuation | 17.518943 | 15.094780 | 13.84% |

These per-file durations overlap and are not independent isolated-file measurements or additive savings. The continuation file saves an observed median 2.424164 s, but retained real timeout cases leave the launcher as the longer file, limiting the combined gain. Remaining timeout, process, permission, resumable-contract, golden-fixture and OS coverage was not reduced.

The isolated `npm run check` passed lint, typecheck and 3,731 ordinary cases: 3,718 passed, 13 skipped, zero failed and zero canceled. Its 582.022 s command time and 557.515 s runner time are a single correctness check, not a whole-suite performance comparison. `npm run verify` matched both artifacts, Claude 43 files and Codex 42 files. The frozen checkout used committed production/role/helper inputs plus these test edits, excluding the separately prepared O1 implementation and unrelated role changes. No production source, role, skill or generated artifact changes are part of this work. No local contract run was required because engine stop, resume, launch and ledger behavior are unchanged. No CI run or real review was triggered, and the real review remains required before release.

### O2: Fixed boundary construction

The two affected files retain all 71 named cases. Five explicit body cut states, four no-diagram states and independently calibrated plain/secret variants replace unbounded 200-character sweeps. The tests now check exact below/at/above transitions, including comment limits, protected area prose and final markers. Ten temporary mutations were rejected by retained semantic assertions: changed cap, body/comment off-by-one comparisons, cut order, missing area-diagram selection, disabled body/comment refusals, lost secret counting after diagram cuts, omitted area intro and missing publication marker. All mutations were restored before measurements and final validation.

Disposable entry counters measured actual work outside the timed samples. Changed-scenario attribution uses a stack frame inside the form's fit tests or the area-title secret test; the all-file total also includes unchanged tests and module setup. No instrumentation is part of the proposed change. The author keeps the full counter, mutation and validation logs outside the repository; the [measurement data](2026-11-08-test-time-measurements.json) records exact edits, witnesses, counts and controlled inputs.

| Renderer work | Before | After |
|---|---:|---:|
| Named cases in both files | 71 | 71 |
| Form calls in changed scenarios | 1,082 | 65 |
| Internal body renders in changed scenarios | 1,209 | 187 |
| Internal comment renders in changed scenarios | 1,082 | 68 |
| Form calls across both complete files | 1,165 | 148 |

The changed-scenario form-call reduction is 93.99%; internal renders are separate counts and must not be added to it as though they were independent top-level calls. Both timed variants use the same isolated bounded-path-scan expression from O1, with all other production, role, helper and dependency inputs identical. Thus the comparison measures marginal O2 after O1, not the exact committed production source or O1 plus O2. The original q-padding input is retained. The exact-source full check uses no experimental O1 change.

| Pair | Before, common O1 scan (s) | After, common O1 scan (s) |
|---|---:|---:|
| 1 | 1.946110 | 0.957781 |
| 2, after first | 1.923483 | 0.991210 |
| 3 | 2.013650 | 1.031323 |
| Median | 1.946110 | 0.991210 |

All six planned runs passed all 71 cases, with no skips, failures, cancellations, exclusions or repetitions. Process spawn-to-close median time fell by 0.954900 s, an observed marginal-O2 reduction of 49.07%, calculated as `(median before - median after) / median before * 100`. The before range was 1.923483 to 2.013650 s and the after range 0.957781 to 1.031323 s. Each invocation used a fresh primary Node compile cache while retaining the helpers' existing cache behavior; the OS page cache was not flushed. Three local Linux samples establish no confidence interval, cross-platform result, whole-suite or CI-wide improvement.

The exact proposed-commit `npm run check` passed lint, typecheck and 3,731 ordinary cases: 3,718 passed, 13 skipped, zero failed and zero canceled. Its 240.215 s command time and 215.957 s runner time are a single correctness run on the original committed scan, not a controlled before/after suite comparison. `npm run verify` matched both artifacts, Claude 43 files and Codex 42 files. The frozen test files match the submitted edits; the exact-source checkout excluded the experimental O1 scan and unrelated role work. Production sources, roles, skills, distributed artifacts, contract coverage and OS jobs are unchanged by this work. No contract run, CI run or real review was triggered; the real review remains required before release.

## Remaining bottlenecks after the adopted test changes

The [focused profile](2026-11-09-remaining-test-bottlenecks.md) records exactly three instrumented runs per tier, with the same isolated O1 expression and no unrelated role changes. Ordinary process elapsed was 66.425, 64.641 and 67.237 s; contract was 239.524, 239.699 and 239.325 s. All ordinary runs passed 3,718 cases with 13 skips, and all contract runs passed 109 assertions with no current known-failure marks. These historical after-O1 instrumented observations predate the two newly integrated regressions and are not literal current-head or cumulative speedup figures.

The profile makes the next decision specific. O1 source/regression/bundles are now integrated as recorded above. For the qualifying-CI critical path, investigate the contract's fix/base scenario work and bounded scenario parallelism without removing R2's required retry/write behavior or any stop/OS coverage. For ordinary feedback, evaluate controlled business-timeout outcomes, then only the 150 qualified in-process snapshot/claim dispatches. Git-read batching needs a boundary/filter audit; fixture-copy and broad runner changes remain lower priority. No code, test, scheduling or cache optimization is adopted by this report.

The public data distinguishes dispatch counts from preload participation, normal exit rows from killed-process censoring, and overlapping parent completion/Git/timer intervals from wall time. In particular, a child's exit row is not OS exit, and overlapping per-child intersections do not establish causal or removable time. The exact committed-source correctness run passed `npm run check` (241.618 s, ordinary runner 217.175 s, 3,718 passed and 13 skipped) and `npm run verify` for both artifacts, without O1 or profiling hooks. The author keeps raw logs outside the repository.
