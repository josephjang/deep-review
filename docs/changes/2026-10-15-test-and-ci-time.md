# Change Proposal: Test and CI time

## Summary

The test suite takes 283 to 378 s on a 16-thread Windows machine and
893 to 969 s on the hosted Windows runner, which bounds every CI run at
about 16 minutes. The report of 2026-10-14
(`docs/reports/2026-10-14-test-and-ci-time.md`) measured where that
time goes and tried the levers. This proposal takes four of the five
levers the report recommends: split the largest test file by its
describes, start the engine's synchronous git calls without a console
host on Windows, run the suite below normal priority, and put the
Windows job's temporary directory on the runner's workspace disk. The
fifth, three shards for the Windows job, is deferred (Non-Goals).
Together the four take about a third off a local run and 13% to 36%
off the Windows job's tests, all measured. None changes what the
engine does for a
person who runs it; one (the git calls) changes how a short-lived child
process is created on Windows. The proposal also answers issue #49:
Defender's scans are not the main cost, and the scratch-root option the
issue asks for would move 3% of the scan wait, so it is not built.

## Problem

A review of a change runs the engine's test suite before it is pushed
and again on three hosted runners. The suite has 2,030 tests in 91
files, of which about a quarter are end-to-end: each starts a temporary
repository, the real engine and a fake model process per worker, and
one such test starts about 170 child processes. The report measured the
suite at `e0e401a`:

- Locally, one file, `test/review/fix-pass.test.ts`, holds 59 tests in
  two top-level describes that run one after the other at concurrency
  4. The file takes 300 to 366 s of a 283 to 378 s run, and for the last
  two thirds of a run it is the only file left: the machine idles at 23
  to 36% while it finishes.
- On Windows, every child the suite starts is two processes, because a
  console process gets a console host of its own even when its window
  is hidden. A run starts about 25,000 children and 50,980 processes in
  all; the tree's CPU is 1,455 s, more than half of it kernel time. The
  engine keeps its workers attached to the console on purpose, so that
  Ctrl-C reaches them (`src/runtime/process.ts`), but its synchronous
  git calls, which end within milliseconds, pay the same price for no
  reason.
- While the first third of a run saturates the machine, other programs
  slow down: a process start takes 3 times as long, up to 10 times at
  the 95th percentile, and a small write twice as long. The developer
  sees this as a sluggish desktop for about 100 s per run.
- In CI, the Windows job's tests take 893 to 969 s against 267 s on
  Ubuntu, and the ratio is the same for every size of suite. Defender
  is not the cause: the hosted image has real-time protection off. A
  benchmark on each runner found the OS temporary disk of the Windows
  runner 9 times slower at fsync and 13 times slower at a SQLite
  transaction than the workspace disk next to it, and the suite puts
  every sandbox, artifact and ledger write on that slow disk through
  `os.tmpdir()`. Git itself is also 11 to 20 times slower per operation
  there, which no setting reaches.
- Issue #49 asked whether Defender's scanning of the engine's working
  files makes a Windows run slow, and proposed a Dev Drive and a way to
  name the engine's scratch root. The report recorded the scans: they
  are all file writes, 58% of them the checkpoint artifacts the tests'
  reviews write, and 3% the workers' scratch files. A Dev Drive saves 7
  to 13% locally and nothing in CI.

## Goals

- A local run of the suite finishes in about 160 s on the measuring
  machine where it took 283 to 378 s, with every test unchanged.
- The Windows CI job's tests take 13% to 36% less, by the machine the
  pool hands out, at no cost in runner minutes.
- A developer's other programs stay responsive while the suite runs.
- The engine's observable behavior, its ledger and its prompts do not
  change: a person who runs a review sees nothing different.
- Issue #49 is closed with a measured answer, and the Dev Drive is
  documented as an option a developer may take, not a setup the
  repository needs.

## Non-Goals

- No change to Ctrl-C behavior. Workers and probes stay attached to the
  console on Windows; detaching them (lever F of the report, about 6%)
  would let an interrupted engine leave its workers running and needs
  its own proposal.
- No scratch-root option for the engine. The scans on the workers'
  scratch files are 3% of the scan wait, under 1% of a run; `TEMP`
  already places the scratch root, and the tests already put it under
  each sandbox.
- No Defender exclusion or Dev Drive in the repository. Both are
  per-machine steps; the report measures them and the README documents
  the Dev Drive as optional.
- No Defender step in CI. The hosted Windows image already has
  real-time protection off and excludes `C:\` and `D:\` (the image's
  own build script, cited in the report).
- No fewer workers per review in the tests, no shared preflight, and no
  change to the compile cache: the report found none of these a lever
  worth its cost.
- No change to `npm run check`, `npm test` or the test runner's
  options.
- No shards for the Windows job. The report estimates three shards at
  about 5 to 6 minutes of tests where the job takes 15 today, but each
  shard is a runner, so the change triples the runner minutes of the
  Windows job. The author deferred it on 2026-10-15 for that cost. The
  report's lever B holds the estimate and the measurement plan; it can
  follow as a workflow-only change in its own pull request, once the
  four levers here have shown what the Windows job costs without it.
  Ubuntu and macOS are not sharded for the same reason.

## Requirements

- **R1: fix-pass is three files, the tests unchanged.**
  `test/review/fix-pass.test.ts` keeps the describe "the fix pass"
  without its nested "claims (commit series integrity)" describe, which
  moves to `test/review/fix-pass-claims.test.ts`; "the continuation of
  a finished read-only run" moves to
  `test/review/fix-continuation.test.ts`. The 59 tests keep their names
  and bodies. The script, constants and small helpers the three files
  share (`reviewScript`, `fixedA`, `fixedB`, `found`, `noLeads`,
  `labelsOf`, `addedLabels`, `literal`, `setPolicyBatchSize`) live once,
  in a helper under `test/helpers/`, and each file imports only what it
  uses, so that `npm run lint` passes.
- **R2: the engine's synchronous git calls start without a console host
  on Windows.** The five call sites, `src/scope/git.ts`,
  `src/review/commit.ts` (two), `src/checkpoint/locate.ts` and
  `test/helpers/git.ts`, start git through one function that passes
  `detached: true` on `win32` and `false` elsewhere, together with the
  options each site passes today. The function's doc comment says why
  git is detached where workers are not, and that `detached` reaches
  libuv through `spawnSync` although Node documents it for `spawn`
  only. The function also passes a `timeout`, 60 s unless a site
  gives its own, because a detached child is in a process group that
  Ctrl-C does not reach: a git that waits on a lock or a slow remote
  must not outlive an engine the user interrupted, and `spawnSync`'s
  timeout ends the child with `TerminateProcess`, console or not. A
  call that times out fails through the same path as a non-zero exit,
  with the stderr git wrote so far. A unit test gives the function a
  fake `spawnSync` and asserts the options it receives on each
  platform, the timeout among them. Workers and probes
  (`src/runtime/process.ts`, `src/runtime/preflight.ts`) keep
  `detached: process.platform !== 'win32'`.
- **R3: the suite runs below normal priority.** `test/setup.ts`, which
  every test process imports, lowers the priority class of its own
  process to `os.constants.priority.PRIORITY_BELOW_NORMAL`, so that
  every process the test runner and the tests start inherits it. A test
  asserts that `os.getPriority()` in a test process is that value.
- **R4: the Windows job's temporary directory is on the workspace
  disk.** The step of `check.yml` that runs the tests sets `TEMP` and
  `TMP` to `runner.temp` on every runner; on Ubuntu and macOS the value
  is on the same file system as before. The setting is on the step, not
  the job, because the `runner` context is not available to a job's
  `env`.
- **R5: the Dev Drive and the exclusion are documented as optional.**
  The Developing section of `README.md` gains a short note for Windows
  developers: a Dev Drive holding the checkout and `TEMP` saves 7 to
  13% of a local run, a Defender exclusion of the sandboxes' temporary
  directory saves at most the same, both are optional, and neither is
  needed by the repository.
- **R6: issue #49 is closed by this change** with a comment that
  points at the report's lever D and this proposal.

## Decisions

- **D1: Take A, E, H and I; defer B; document D; drop C and F; build
  no scratch-root option.** The report measured A at -20% locally, E at
  -16% on top of A, H at +1 to 3% of wall time with the desktop back to
  idle latencies, and I at -13% to -36% of the Windows tests by machine.
  B is an estimate, and it triples the Windows job's runner minutes;
  the author deferred it for that cost until the four measured levers
  have landed (Non-Goals). C had nothing to turn off. F changes the engine's
  Ctrl-C behavior for about 6% and is left to its own proposal. The Dev
  Drive is worth half of A or E and is a setup each developer makes
  once, so it is documented, not required. The scratch-root option
  moves 3% of the scan wait, which does not justify an engine option.
  Rejected: taking only the CI levers (I, B), which would leave the
  developer's local loop at 283 to 378 s; and taking the Dev Drive as
  the answer to #49, which the measurement does not support.
- **D2: The git calls stay synchronous and rely on Node's option
  pass-through, guarded by one function and a test.** Node documents
  `detached` for `spawn` only, but `spawn`, `spawnSync` and
  `execFileSync` share one option normalizer that reads it and hands it
  to libuv, which maps it to `DETACHED_PROCESS` on Windows. The
  measurement works because of that, and has across Node versions.
  Making the git calls asynchronous would stay within the documented
  API but turns the synchronous code paths of scope, commit and
  checkpoint location into asynchronous ones, a larger change for the
  same effect. Rejected: leaving the calls as they are (16% of a local
  run); and the asynchronous rewrite (cost without a gain the
  synchronous form lacks). One function for all five sites means the
  pass-through has one place to break and one test to catch it. The
  one thing a detached child loses is Ctrl-C: today a git that hangs
  dies with the engine the user interrupts, and detached it would run
  on until it finished. The function's timeout stands in for Ctrl-C.
  Rejected: relying on git's own short run time without a timeout,
  which holds for the common case and not for a lock wait or a remote
  call; and keeping the calls attached, which is the 16%.
- **D3: The priority is lowered unconditionally in `test/setup.ts`, not
  behind a flag or a CI check.** On a CI runner the job is alone, so
  the class makes no difference there; locally it costs a developer who
  waits on the suite with nothing else running 1 to 3%. An environment
  variable to opt out was rejected: it is a knob with one user and no
  measured need, and the cost it would save is within a run's own
  spread. Rejected too: setting the class in the `npm test` script
  through a wrapper, which would not reach a developer who runs
  `node --test` directly.
- **D4: `TEMP` is set on the check step for every runner, not only
  Windows.** A conditional per OS is more workflow for no effect: on
  Ubuntu and macOS `runner.temp` and the OS temporary directory are on
  the same file system, and the benchmark shows no difference between
  them there. Rejected: a Windows-only `if`, which hides the
  assumption that the other runners are unaffected instead of letting
  the runs show it.
- **D5: The engine's artifact writes are not changed.** The scan
  recording shows each checkpoint artifact scanned twice, once as its
  `.pending` file and once under its hash name, and the evidence store
  fsyncs each. A write under the final name without the rename would
  save a scan but lose the atomic replace that the store exists to
  give, and on the slow CI disk the cost is the fsync, which lever I
  removes by moving the disk. Rejected for this change; a later
  proposal may revisit the store's durability on a measured need.

## Risks

- Risk: a future Node release stops forwarding `detached` through
  `spawnSync`, and git calls silently get a console host again. Accepted
  with a guard: the unit test of R2 asserts the options the single
  function passes, and the report's measurement is repeatable from its
  appendix.
- Risk: a detached git does not receive the Ctrl-C that ends the
  engine, so a git that hangs on a lock or a remote outlives an
  interrupted engine for up to the timeout of R2, and holds its lock
  that long. Accepted: 60 s is the bound where today there is none,
  the engine's own git calls are local plumbing that ends in
  milliseconds, and the lock it could hold is one git itself releases
  when it exits.
- Risk: lever I's gain depends on the machine the hosted pool hands out
  (-13% on one CPU generation, -36% on another), and a third kind may
  give another figure. Accepted: the direction held in every pair, the
  change is four lines, and the pull request's runs record the machine.
- Risk: without the shards, the Windows job still bounds a CI run at
  about 10 to 13 minutes after lever I. Accepted by the author: the
  shards cost three runners per run, and the decision waits until the
  measured levers show the job's time without them.
- Risk: a developer who runs the suite with nothing else open pays 1 to
  3% for the lower priority class. Accepted: within the spread of a run
  and in exchange for a usable desktop during every other run.
- Risk: `test/setup.ts` lowering its priority also lowers the priority
  of a developer's own child processes started from a test, which is
  intended, and of any debugger attached to the test process, which is
  not. Accepted: a debugger session is short and the class is
  BelowNormal, not Idle.
