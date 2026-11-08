# Report: Options for reducing test time

This report evaluates reducing the work of the tests, reducing duplicate cases, reusing preparation and compiler work, and running the resumable contract less often. It draws on the current code, the earlier reports of [2026-10-14](2026-10-14-test-and-ci-time.md) and [2026-10-22](2026-10-22-test-suite-after-resumable-runs.md), three successful CI runs and local experiments. Implementation progress records completed local work separately from the remaining recommendations. O7 cancels superseded PR runs, and O8 exempts narrowly defined documentation-only PRs from contract invocations while retaining main validation and adding scheduled/manual backstops. Their live CI effect has not yet been observed. The author keeps the raw experimental logs outside the repository; the measurements and reproducible methods used for the decisions are recorded here.

## Recommendation

First address the repeated scanning of long words in `src/review/finding-names.ts`. A completed comparison of the same 150 files and 3,713 ordinary cases, with three runs per implementation, reduced median process elapsed time from 554.140 to 63.257 s: 88.58% less time, or 8.76 times faster. The path expression was the only source change. This is a stronger immediate opportunity than changing test runners, adding CI shards, or weakening the process tests. The controlled comparison below separates this local result from CI and from the earlier interrupted experiments.

For CI, cancel obsolete PR runs and make contract execution conditional on the change, backed by scheduled and manual runs. For local iteration, enable incremental typechecking. Remove demonstrably duplicate integration cases, then replace length-limit sweeps with boundary cases. Remeasure both test tiers after the path fix before investing in process, Git, concurrency or shard changes. The current findings do not justify a percentage claim about the eventual CI improvement.

## Priorities

The order weighs measured effect, implementation cost and the possibility of missing a defect. A priority is a recommendation, not authorization to change the required checks. Suite elapsed time, the wait for the latest PR result, total runner time and local feedback time are separate outcomes.

| Order | Work | Primary outcome | Evidence and reason |
|---|---|---|---|
| 1 | Bound the path scan (O1) | Less work in every affected run | Prepared and locally validated; implementation is separate from this CI change. Three same-workload whole-suite pairs reduced median elapsed time by 88.58%, with the same passing case counts. |
| 2 | Cancel superseded PR workflows (O7) | Less obsolete work and queue contention | Implemented locally with unchanged job matrices; live cancellation and savings remain unobserved. Benefit depends on how often pushes overlap. |
| 3 | Run the contract conditionally (O8) | Less CI work on unrelated changes | Implemented for documentation-only PRs with full-run fallbacks, preserved status names and scheduled/manual backstops. Windows contract steps historically took 472 to 801 s; net live savings remain unmeasured. |
| 4 | Incremental typecheck (O9) | Faster local repetition | Measured at 8.646 s normally and 1.655 s on an unchanged warm run. Cold runs remain about as expensive as today. |
| 5 | Remove duplicate integration cases (O10) | Fewer expensive scenarios and less maintenance | Six initial removal candidates are identified below. Only one is a direct duplicate; the others need a coverage review. |
| 6 | Replace padding sweeps with boundaries (O2) | Fewer renders and bounded test construction | Keep the transitions and refusal cases. After O1 the two original files already take 2.182 s, so their remaining savings are limited. |
| 7 | Profile and reduce remaining waits, child starts and Git calls (O3, O11, O12, O14) | Less work in review and contract scenarios | Plausible next bottlenecks, but current counts and savings are unmeasured. Choose among them using a new profile of each tier. |
| 8 | Tune preparation, scheduling, caches and runner capacity (O4, O5, O13, O15, O16) | Faster preparation or a shorter execution tail | Their value depends on the profile after the earlier changes. More runners and cache transfers can increase total cost. |

Implement the first four as separate changes where possible, so their effects and policy decisions remain attributable. Do not add their measured or estimated savings: they affect different runs, overlap, and can move the bottleneck to another job. Conditional contract execution, for example, saves no work on a PR that still qualifies for the full contract.

## Evaluation record

Each option gets a before-and-after evaluation when implemented. [The measurement data](2026-11-08-test-time-measurements.json) records the completed whole-suite comparison under `controlledOrdinarySuite`, the paired path-scan samples, the earlier cache experiments and the historical incomplete full-suite baseline. A blank improvement figure means not established, not zero improvement. Measurements of an experiment do not mean that its configuration has been adopted.

| Option | Current evaluation | Established improvement | Evidence still needed |
|---|---|---|---|
| O1: Bound the path scan | Locally implemented; three alternating whole-suite pairs, plus five public-API pairs per synthetic input | Same-workload whole-suite median: 554.140 to 63.257 s, 88.58% less process elapsed time. Synthetic 40,000-letter public-API case: 99.97% less time | CI and complete check-pipeline results; contract tier not timed |
| O2: Boundary cases | A temporary threshold-jump variant passed 71 tests in 149.721 s using the original scan | No incremental improvement over the implemented O1 established | Run the same cut/refusal coverage before and after O2 with O1 present on both sides |
| O3: Git calls | Not implemented or newly profiled | Not measured | Call counts and cumulative time per subcommand, plus drift and filter compatibility |
| O4: Concurrency and splitting | Not implemented | Not measured | Alternating runs at each concurrency, longest-file tail, CPU, memory and failures on each OS |
| O5: Sharding | Not implemented | Not measured | Latest-revision latency, slowest shard and total runner time including setup and queues |
| O6: Focused edit-loop tests | Available practice; no comparative sample recorded | Not measured | Time to feedback for fixed representative edits; final full-check cost reported separately |
| O7: Cancel obsolete CI | Workflow grouping implemented; actionlint and six local identity cases pass | Not measured; scheduling does not speed up a single suite | Live overlapping PR cancellation, independent main runs, obsolete runner time avoided and latest-push-to-result latency over a recorded observation window |
| O8: Conditional contract | Narrow Markdown policy, complete Git inventory and per-OS gates implemented; local verification recorded below | Three contract invocations and npm installations omitted per eligible PR by design; elapsed and net runner savings not measured | Live exempted/relevant/error/manual/scheduled outcomes, eligible PR fraction, classification/setup overhead, added weekly work and coverage/detection delay |
| O9: Incremental checks | One unchanged-input run per condition; neither cache adopted | Typecheck warm run: 8.646 to 1.655 s, 80.9% less time; cold incremental run: 8.351 s | Repeated runs after edits and invalidation tests. Lint's 95.5% warm reduction is not acceptable evidence for required typed linting |
| O10: Duplicate cases and layering | Six candidate executions identified; none removed | Not measured | Before/after executed case counts by layer and preserved defect detection, then elapsed time |
| O11: Deliberate waits | Not implemented | Not measured | Time spent waiting, retained real-clock cases and timeout regressions |
| O12: Remaining fake-worker children | Not implemented | Not measured | Child-start counts and time, with representative CLI wiring checks preserved |
| O13: Preparation reuse | Not implemented | Not measured | Setup/copy/cleanup time and proof of independent writable state |
| O14: Smaller contract scenarios | Not implemented | Not measured | All required stop points/methods reached, five contract parts checked and scenario elapsed times |
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

This is the first candidate. It addresses a shared production function and preserves the test inputs. Its benefit extends to long worker prose, not only the suite. It needs its own behavior-change proposal, review against R3, focused regression coverage, the required build and checks, and the real-run gate of vision principle 12 before release. No implementation is included in this report.

An alternative is to avoid path-range scanning when no candidate id occurs, but that must also preserve the separate diagram identifier checks. Do not merge multiple speculative fast paths before measuring the simpler expression change.

### O2: Replace incremental padding sweeps with boundary cases

`pull-request-form.test.ts` renders from padding zero until refusal, 200 characters at a time, twice: with and without diagrams. `pull-request-areas.test.ts` renders both a plain and a secret-bearing answer at each step until the area diagrams are cut. With a 60,000-character limit these loops can make hundreds of expensive calls while testing only a handful of distinct cut states.

Use explicit or boundedly discovered inputs immediately below and above each relevant threshold. Keep every cut transition, the order of cuts, refusal after all cuts, the final marker, the retained questions and full findings, and the secret count in every cut state. Add an explicit upper bound to any search so an unexpected renderer change produces an explanatory failure instead of an unbounded loop. Do not derive the expected cut order from the implementation.

A separate temporary experiment jumped to the next length threshold while retaining the 200-character grid and the existing assertions. It retained the original expensive expression and passed the same 71 tests in 149.721 s, substantially slower than O1. This supports fixing the shared scan first. Fewer renders can follow as a test-maintenance change, without taking away boundary coverage.

### O3: Reduce measured Git calls, preserving freshness

The October report measured 22,582 Git starts after the in-process fake migration, but that is historical evidence, not a current count. The current engine still reads `HEAD` during drift checks, reads status for strays, and uses separate diff and untracked-file commands in `changedAgainstHead`. The tests exercise those paths repeatedly.

After O1, profile call counts and cumulative time by subcommand on representative review, fix and contract scenarios on each OS. Investigate combining reads within one comparison, batching object queries, and avoiding duplicate immutable metadata reads. Do not cache worktree status or `HEAD` across worker/check boundaries: external edits and interrupted writes are exactly what those checks must detect. Preserve Git's line-ending and filter semantics instead of replacing Git with a partial imitation. This option is a larger engine change and requires the resumable contract tests.

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

The current typecheck command is `tsc --noEmit`; tsconfig has no incremental setting. The current lint command is `eslint .`. Follow-up measurements ran each tool directly through Node, with temporary cache files outside the repository, on the same Linux environment as the earlier experiments. Each command exited zero. These are single runs with unchanged inputs, not measurements after a source edit or on CI.

| Tool | Normal | First cached run | Unchanged warm run |
|---|---:|---:|---:|
| TypeScript | 8.646 s | 8.351 s | 1.655 s |
| ESLint | 14.963 s | 15.299 s | 0.666 s |

The TypeScript experiment added `--incremental --tsBuildInfoFile <cache-file>` to `--noEmit`. [TypeScript's incremental cache](https://www.typescriptlang.org/tsconfig/incremental.html) stores compilation graph information. Put it in an ignored cache directory and verify invalidation with an imported-type change, compiler-option change, dependency update and file deletion. Its strongest evidence here is for repeated local checks; a new CI runner needs a restored cache to benefit.

The ESLint experiment added `--cache --cache-strategy content --cache-location <cache-file>`. The 0.666 s result is not a safe basis for enabling it in the required check: this repository uses type-aware rules, while [ESLint does not invalidate a cached file when another file it depends on changes](https://eslint.org/docs/latest/use/command-line-interface#--cache). Keep authoritative typed linting uncached unless dependency-aware invalidation is established. Content-based file keys alone do not solve that problem. An optional local cached lint command must be clearly distinguished from the full check.

### O10: Remove duplicate cases by assigning verification to one layer

The target is fewer executions of the same scenario, not fewer `it` declarations with the same work hidden inside loops. Keep detailed input variants at the lowest layer that owns the rule, and integration cases for extracting the right inputs, recording results and connecting components. A shared expectation derived from the production implementation is not an independent test oracle.

| Candidate | Existing verification to retain | Initial reduction candidate |
|---|---|---:|
| The Claude different-session row in `runtime/launcher.test.ts` and the following session-recording test execute the same response | Merge the failure, null-output and evidence assertions into the session-recording case | 1 execution |
| Launcher rows for a Claude envelope without denials and a Codex non-JSON stream | Detailed rejection cases in `runtime/claude.test.ts` and `runtime/codex.test.ts`, plus a representative failed-response recording case per adapter in the launcher | 2 executions, conditional on that coverage review |
| Four continuation mismatch cases: changed bytes, added path, changed scope mode and moved HEAD | The reason-specific `scopeMismatch` cases in `scope/compare.test.ts`, plus representative integration coverage for creating a new run, preserving the old run and logging the refusal | Up to 3 executions, conditional on the caller retaining all relevant wiring checks |

Six executions are a review target, not six proven-safe deletions or a percentage reduction of the suite. The first pair is a direct duplicate; the other five trade repeated end-to-end verification for coverage that already exists in another layer. Before deleting them, identify a defect each test catches and show where it is still caught. A small mutation of the relevant guard or routing code can test that judgment more usefully than a passing suite alone.

Apply the same review to `tasks.test.ts` and `phases.test.ts`: the task builders own detailed wording, while phase tests own extracting data from recorded state and selecting the task. In `controller.test.ts`, retain a complete review and representative failure, degradation, budget and drift paths; do not repeat every lower-level wording or parsing variant through a whole review. Moving a case to a new unit test can lower time without reducing the total case count, and should be reported that way.

Keep old checkpoint fixtures and per-version schema checks: forward compatibility is an explicit repository contract, and a newer fixture does not replace proof that an older one opens. Prompt bytes are also product behavior here, so role and skill tests cannot be dismissed merely because they assert text. Preserve permission boundaries, schema/prompt vocabulary consistency, record-before-edit rules and real interruption tests.

### O11: Remove deliberate waiting from business-logic tests

The sandbox uses a four-second timeout for roles scripted to hang. For a test whose subject is what happens after a timeout, return a controlled timeout result or use an injected clock instead of waiting for wall time. Retain real deadlines and process trees where the subject is startup timing, guard behavior, termination or orphan cleanup. Do not globally shorten timeouts: a slow runner can then turn a valid worker into a spurious failure.

The contract already polls readiness markers rather than sleeping blindly between phases. Its orphan grace period is an observation window, not automatically wasted time. Profile deliberate waits separately from process startup before replacing them, and retain at least the real-process boundary cases each business-logic substitute depends on.

### O12: Reduce the remaining child starts inside fake workers

The in-process fake worker still runs its claim and snapshot commands through child Node processes in `test/helpers/fake-runtime.ts`. For tests of ownership, revision attribution or retry decisions, a test host could call the command implementation directly. Keep representative command-line cases that prove argument parsing, quoting, process boundaries and the recorded result. Keep the real children throughout the resumable contract.

This extends the existing fake-host design rather than removing the guard from production. It changes the verification boundary and needs a coverage comparison before adoption. Count claim and snapshot child starts and their cumulative time first; the October process counts do not establish the current opportunity.

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

O1 is prepared and locally validated as recorded below; its implementation is a separate change. The later controlled comparison establishes its ordinary-suite improvement at 88.58% on the measured environment. O7 and O8 are implemented as independent workflow changes, with their CI benefits still unmeasured. Next validate O9's incremental invalidation. Review the six O10 removal candidates before deleting any, and treat O2 as a small follow-up. For each change, record ordinary-suite and contract elapsed time separately, latest-push-to-result time, total runner minutes, failures and reruns, and any newly exempted revisions. Remeasure before selecting the remaining options; none of the unmeasured ones has a promised speedup.

## Implementation progress

### O1: Bounded path scanning prepared

A follow-up implementation preserves the path and finding-name requirements of O1 and adds two regression cases. The long-word child-process regression failed against the original code at its 30 s timeout. With the bounded expression, all 120 tests in the finding-name, finding-name case, PR form and PR area files passed in 1.913 s. `npm run check` passed lint, typecheck and 3,715 tests: 3,702 passed, 13 skipped and zero failed; the test stage took 66.122 s. Build and verify matched both distribution artifacts. No existing test was removed. The implementation, its proposal and its generated bundles are not part of this CI change; the author keeps the validation logs outside the repository.

These checks ran in an isolated checkout with the committed role inputs so unrelated role edits could not contaminate the result. This is local validation of the follow-up implementation, not a completed real-model or CI gate or a new check of this CI change. The contract tier was not rerun because the change affects none of the stop, resume, launch or append paths that require it.

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
