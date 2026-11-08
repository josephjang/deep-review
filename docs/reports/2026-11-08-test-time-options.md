# Report: Options for reducing test time

This report evaluates reducing the work of the tests, reducing duplicate cases, reusing preparation and compiler work, and running the resumable contract less often. It draws on the current code, the earlier reports of [2026-10-14](2026-10-14-test-and-ci-time.md) and [2026-10-22](2026-10-22-test-suite-after-resumable-runs.md), three successful CI runs and local experiments. Implementation progress records completed local work separately from the remaining recommendations; CI policy is unchanged. The author keeps the raw experimental logs outside the repository; the measurements and reproducible methods used for the decisions are recorded here.

## Recommendation

First address the repeated scanning of long words in `src/review/finding-names.ts`. An isolated change to the path recognition expression made all 71 tests in `pull-request-form.test.ts` and `pull-request-areas.test.ts` pass in 2.182 s. In the original full-suite run, those two files were still consuming a core each after 244 s and were deliberately stopped. This is a stronger immediate opportunity than changing test runners, adding CI shards, or weakening the process tests.

For CI, cancel obsolete PR runs and make contract execution conditional on the change, backed by scheduled and manual runs. For local iteration, enable incremental typechecking. Remove demonstrably duplicate integration cases, then replace length-limit sweeps with boundary cases. Remeasure both test tiers after the path fix before investing in process, Git, concurrency or shard changes. The current findings do not justify a percentage claim about the eventual CI improvement.

## Priorities

The order weighs measured effect, implementation cost and the possibility of missing a defect. A priority is a recommendation, not authorization to change the required checks. Suite elapsed time, the wait for the latest PR result, total runner time and local feedback time are separate outcomes.

| Order | Work | Primary outcome | Evidence and reason |
|---|---|---|---|
| 1 | Bound the path scan (O1) | Less work in every affected run | Prepared and locally validated; implementation is separate from this report-only change. See Implementation progress. The original form tests exceeded 244 s; the experiment passed them in 2.182 s and the ordinary suite in 64.945 s. It preserves the inputs. |
| 2 | Cancel superseded PR workflows (O7) | Less obsolete work and queue contention | A small workflow change with no loss of checks on the latest revision. Benefit depends on how often pushes overlap. |
| 3 | Run the contract conditionally (O8) | Less CI work on unrelated changes | Windows contract steps took 472 to 801 s in the sampled runs. It requires a policy proposal and reliable change classification, so it follows the two simpler changes. |
| 4 | Incremental typecheck (O9) | Faster local repetition | Measured at 8.646 s normally and 1.655 s on an unchanged warm run. Cold runs remain about as expensive as today. |
| 5 | Remove duplicate integration cases (O10) | Fewer expensive scenarios and less maintenance | Six initial removal candidates are identified below. Only one is a direct duplicate; the others need a coverage review. |
| 6 | Replace padding sweeps with boundaries (O2) | Fewer renders and bounded test construction | Keep the transitions and refusal cases. After O1 the two original files already take 2.182 s, so their remaining savings are limited. |
| 7 | Profile and reduce remaining waits, child starts and Git calls (O3, O11, O12, O14) | Less work in review and contract scenarios | Plausible next bottlenecks, but current counts and savings are unmeasured. Choose among them using a new profile of each tier. |
| 8 | Tune preparation, scheduling, caches and runner capacity (O4, O5, O13, O15, O16) | Faster preparation or a shorter execution tail | Their value depends on the profile after the earlier changes. More runners and cache transfers can increase total cost. |

Implement the first four as separate changes where possible, so their effects and policy decisions remain attributable. Do not add their measured or estimated savings: they affect different runs, overlap, and can move the bottleneck to another job. Conditional contract execution, for example, saves no work on a PR that still qualifies for the full contract.

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

The current `check.yml` has no workflow concurrency group. A newer push to a PR can leave the previous revision running its three check jobs and three contract jobs. Group runs by workflow and PR, and use conditional `cancel-in-progress` to cancel an obsolete revision. Keep main-branch validation separate so unrelated work cannot cancel it. [GitHub documents this mechanism](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

This does not make a single test faster. It reduces work whose result the author no longer needs and can release runner capacity for the latest revision. Measure canceled runner minutes and time from the latest push to its result; the sampled CI data does not establish their current magnitude.

### O8: Run the contract less often

The contract deliberately stops a real engine, resumes it, compares the result with an uninterrupted run and checks for orphan processes. [R1 and R2 of resumable runs](../changes/2026-10-18-resumable-runs.requirements.md#r1-resumable-means-five-things) state why ordinary unit tests cannot replace it. Its execution frequency is a separate policy choice from keeping those guarantees and cases.

| Policy | Work saved | Consequence |
|---|---|---|
| Relevant changes only | The full contract matrix on changes classified as unrelated | A classifier omission can let a relevant change merge without the contract. |
| Once before merge | Repeated contract runs during PR editing | Every later change invalidates that result; final validation needs an automatic, revision-specific trigger. |
| Scheduled and manual runs only | Contract work leaves the normal PR path | Recovery defects can merge and become installable before detection. |

Recommend relevant-change execution first. Start with a narrow exemption for changes only to documentation under `docs/` or documentation-only edits to README and AGENTS; do not exempt an entire prompt, skill or generated-output directory without examining its executable files and policy effects. Treat engine sources, dependency and toolchain changes, role policy, the contract and its helpers, and CI/build configuration as relevant. Report rendering and schemas matter too: the contract compares reports and frozen records, not just process termination. Unknown changes, incomplete diffs and classification errors run the full matrix.

For PRs, compare the complete change with its target base, not just the last push. Renames and deletions must count. Any manual exemption tied to a label or an earlier result must be invalidated when the PR changes. Keep an explicit manual force-run option. A Node classification script fits this repository's cross-platform toolchain rule.

Keep all three OS jobs when a change qualifies, since process termination, file handling and known-failure marks differ by OS. Add a scheduled full matrix on main as a backstop and record the revision it checked. Initially keep main-push validation as it is; removing that repeated validation is a separate decision about whether PR validation represents the resulting main revision. A schedule is not proof that every intermediate main revision passed. Because installations come from main, scheduled-only validation has a direct distribution risk.

Run a lightweight classification/status job for every PR and require an aggregate result that distinguishes a justified exemption from a failed or canceled contract. Do not hide a required workflow behind `paths-ignore`: [GitHub says filtered-out workflows can leave required checks Pending](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpull_requestpull_request_targetpaths). Confirm the repository's actual required-check configuration before changing job names or requirements; that configuration was not inspected here.

This changes the policy stated in AGENTS.md, which currently requires the contract on every PR, and the CI practice recorded by the resumable-runs proposal. Adoption needs its own change proposal and coordinated edits to AGENTS, README and workflow documentation. Record the accepted detection delay, exemption rules, fallback behavior and response to a scheduled failure. Neither the current workflow nor the current rule is changed by this report.

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

The follow-up baseline, cold-cache and warm-cache typecheck and lint commands all exited zero; their timings and unchanged-input limitation are recorded under O9. They ran against the workspace and do not establish that the temporary path-expression implementation passed lint or typecheck. No duplicate case was removed, no conditional-execution classifier was tested, and no scheduled CI run was added.

O1 is prepared and locally validated as recorded below; its implementation is a separate change. Next perform O7 as an independent CI change, then prepare the policy proposal for O8 and validate O9's incremental invalidation. Review the six O10 removal candidates before deleting any, and treat O2 as a small follow-up. For each change, record ordinary-suite and contract elapsed time separately, latest-push-to-result time, total runner minutes, failures and reruns, and any newly exempted revisions. Remeasure before selecting the remaining options; none of the unmeasured ones has a promised speedup.

## Implementation progress

### O1: Bounded path scanning prepared

A follow-up implementation preserves the path and finding-name requirements of O1 and adds two regression cases. The long-word child-process regression failed against the original code at its 30 s timeout. With the bounded expression, all 120 tests in the finding-name, finding-name case, PR form and PR area files passed in 1.913 s. `npm run check` passed lint, typecheck and 3,715 tests: 3,702 passed, 13 skipped and zero failed; the test stage took 66.122 s. Build and verify matched both distribution artifacts. No existing test was removed. The implementation, its proposal and its generated bundles are not part of this report-only change; the author keeps the validation logs outside the repository.

These checks ran in an isolated checkout with the committed role inputs so unrelated role edits could not contaminate the result. This is local validation of the follow-up implementation, not a completed real-model or CI gate or a new check of this report-only change. The contract tier was not rerun because the change affects none of the stop, resume, launch or append paths that require it. No other priority has been implemented yet.
