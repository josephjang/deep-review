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
process is created on Windows, and which git binary it is (D6). The proposal also answers issue #49:
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
  reason. Where `git` on PATH is Git for Windows' launcher, as it is
  from PowerShell, from cmd and on the CI runner, each git call is a
  third process: the launcher starts the real binary and waits for it.
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
  and bodies. What the three files share, `reviewScript`, the `found`
  and `noLeads` it is built from, and the `fixedA` and `fixedB` its
  fixers write, lives once in `test/helpers/fix-pass-fixture.ts`; a
  helper only one file uses stays in that file (`testA` and
  `setPolicyBatchSize` in the fix pass, `labelsOf`, `addedLabels` and
  `literal` in the continuation). Each file imports only what it uses,
  so that `npm run lint` passes.
- **R2: the engine's synchronous git calls start without a console host
  on Windows.** The five call sites, `src/scope/git.ts`,
  `src/review/commit.ts` (two), `src/checkpoint/locate.ts` and
  `test/helpers/git.ts`, start git through one function,
  `runGitSync` in `src/runtime/git-sync.ts`, together with the
  options each site passes today. On `win32` the function starts the
  real git binary, `git.exe` in the directory `git --exec-path`
  prints, resolved once per process, and passes `detached: true`; a
  git it cannot resolve is started from PATH with `detached: false`,
  as today, and elsewhere git is started from PATH with
  `detached: false` (D6). The function's doc comment says why git is
  detached where workers are not, and that `detached` reaches libuv
  through `execFileSync` although Node documents it for `spawn` only.
  The function also passes a `timeout`, 60 s unless a site gives its
  own, because a detached child is in a process group that Ctrl-C does
  not reach: a git that waits on a lock or a slow remote must not
  outlive an engine the user interrupted, and the timeout ends the
  child with `TerminateProcess`, console or not. A call that times out
  fails through the same path as a non-zero exit, with the stderr git
  wrote so far. A unit test gives the function a fake runner in place
  of `execFileSync` and asserts the options it receives on each
  platform, the timeout among them; the runner is `execFileSync`, not
  `spawnSync`, because the five sites rely on the error it throws
  (`status`, `stdout`, `stderr`), which a wrapper around `spawnSync`
  would rebuild. On Windows, tests also check that a child started
  this way has no console host of its own, and that the real binary
  gives the programs it runs the environment, and reads the
  configuration, that the git on PATH does. Workers and probes
  (`src/runtime/process.ts`, `src/runtime/preflight.ts`) keep
  `detached: process.platform !== 'win32'`.
- **R3: the suite runs below normal priority.** `test/setup.ts`, which
  every test process imports, lowers the priority class of its own
  process to `os.constants.priority.PRIORITY_BELOW_NORMAL`, so that
  every process the test runner and the tests start inherits it. A
  process already at that priority or lower keeps its own: a run
  started under `nice -n 19` is not raised, which an unprivileged user
  could not do anyway. A system that refuses the change (EPERM or
  EACCES) leaves the priority as it is; Node reports the refusal as
  `ERR_SYSTEM_ERROR` with the errno name in `info.code`, not in `code`.
  A test asserts that `os.getPriority()` in a test process is that
  value or lower, and that a child it starts has the same.
- **R4: the Windows job's temporary directory is on the workspace
  disk.** The step of `check.yml` that runs the tests sets `TEMP` and
  `TMP` to `runner.temp` on every runner. Node's `os.tmpdir()` reads
  them on Windows only and `TMPDIR` elsewhere, so the Ubuntu and macOS
  jobs keep their temporary directory. The setting is on the step, not
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
  -16% on top of A (from Git Bash; D6 has the figures from PowerShell),
  H at +1 to 3% of wall time with the desktop back to idle latencies,
  and I at -13% to -36% of the Windows tests by machine.
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
  Windows.** A conditional per OS is more workflow for no effect: Node
  reads `TEMP` and `TMP` for `os.tmpdir()` on Windows only, so on
  Ubuntu and macOS the two variables change nothing the suite uses, and
  the step's comment says so. (As first written, this decision rested
  on `runner.temp` sharing a file system with the OS temporary
  directory there; that holds, but the variables never reach it.)
  Rejected: a Windows-only `if`, which repeats in the workflow what
  Node already does.
- **D5: The engine's artifact writes are not changed.** The scan
  recording shows each checkpoint artifact scanned twice, once as its
  `.pending` file and once under its hash name, and the evidence store
  fsyncs each. A write under the final name without the rename would
  save a scan but lose the atomic replace that the store exists to
  give, and on the slow CI disk the cost is the fsync, which lever I
  removes by moving the disk. Rejected for this change; a later
  proposal may revisit the store's durability on a measured need.
- **D6 (2026-10-15, during the implementation): Start the real git
  binary on Windows, not the git on PATH.** The report measured lever
  E from Git Bash, where `git` on PATH is the real binary
  (`mingw64\bin\git.exe`). From PowerShell or cmd, and on the hosted
  runner (`C:\Program Files\Git\bin\git.exe` in the checkout log), it
  is Git for Windows' launcher, a 47 KB program that starts the real
  binary and waits for it. Detaching the launcher saves nothing: ten
  `git --version` were 33 processes either way, against 23 and 13 for
  the real binary, and one fix-pass test stayed at 425 processes. It
  costs time: 39 to 40 ms a call attached against 45 to 53 ms
  detached, because the launcher, left without a console, starts git
  in a console of its own. The author chose to resolve the real
  binary: `git --exec-path` names the directory that holds a copy of
  it, through any launcher or shim, and the binary sets up the
  environment the launcher would (MSYSTEM, HOME, PLINK_PROTOCOL and its
  own `mingw64\bin` and `usr\bin` on PATH; only the order of the PATH
  entries differs) and reads the same configuration, the system file
  among it. Started detached, it is one process at 16 ms a call where
  the launcher was three at 40 ms. Measured on one fix-pass test,
  before and after in alternation: 425 to 230 processes from
  PowerShell and 326 to 229 from Git Bash. A git the function cannot
  resolve is started from PATH attached, as before, since detaching a
  launcher makes it slower. Rejected: keeping R2 as first written,
  which slows every git call where PATH holds the launcher, CI among
  them; dropping lever E from this change; and running the Windows
  check step under Git Bash so CI finds the real binary, which leaves
  a developer in PowerShell with the slower calls. Carried out in
  `src/runtime/git-sync.ts` (`realGit`, `installedGit`, `runGitSync`).

## Risks

- Risk: a future Node release stops forwarding `detached` through
  `execFileSync`, and git calls silently get a console host again.
  Accepted with a guard: a test of R2 counts the console hosts of a
  child the function starts on Windows, against a control started
  without `detached`, and the report's measurement is repeatable from
  its appendix.
- Risk: a future Git for Windows stops setting up the environment in
  the real binary, or moves it out of the exec path, and the git the
  engine starts directly behaves otherwise than through the launcher.
  Accepted with a guard: on the Windows runner, the tests of R2 compare
  the environment and the configuration the resolved binary sees with
  what the git on PATH sees, and a binary the exec path does not hold
  falls back to the git on PATH.
- Risk: a `git.exe` on PATH that is not a plain launcher, one that
  changes what git does, is bypassed after its `--exec-path` answer.
  Accepted: Node starts only an `.exe` from PATH, and the ones a
  Windows git install puts there (Git for Windows' launchers, the
  shims of Scoop, Chocolatey and version managers) only start the real
  binary.
- Risk: a detached git does not receive the Ctrl-C that ends the
  engine, so a git that hangs on a lock or a remote outlives an
  interrupted engine for up to the timeout of R2, and holds its lock
  that long. Accepted: 60 s is the bound where today there is none,
  and the engine's own git calls are local plumbing that ends in
  milliseconds.
- Risk: a git ended at the timeout of R2 on Windows is killed with
  `TerminateProcess`, which runs none of git's cleanup, so a call that
  writes can leave its lock file behind, and every later git that
  needs the lock fails with "File exists" until the user removes it by
  hand. A probe showed it: a timed-out `git commit` left
  `.git/index.lock` in place. The engine's one writing call left on
  the timeout is the `update-ref` of `deep-review commit`, which can
  leave `<ref>.lock`, and its failure message names that lock and says
  the ref may or may not have moved. `reset -q` after it runs with no
  timeout, since it waits on neither a lock nor a remote. Accepted:
  the engine cannot tell a lock its killed git left from one another
  git holds in the same repository, so it does not remove the lock
  itself, and an `update-ref` runs past 60 s only behind a hook or a
  disk that hangs.
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
