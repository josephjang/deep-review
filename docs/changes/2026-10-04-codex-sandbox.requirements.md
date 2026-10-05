# Product Requirements: Codex sandbox setting on Windows

Technical part: [2026-10-04-codex-sandbox.design.md](2026-10-04-codex-sandbox.design.md).

## Summary

Let a run choose how its Codex workers are confined on Windows, so that a
fixer and a repair worker can run the repository's build and tests. One
setting with three values, pinned on the run: `unelevated` and `elevated`
name the Windows sandbox every Codex worker uses, and `none` runs the
workers that edit with no sandbox while the workers that only read keep
one. Under the elevated sandbox the adapter also sets PowerShell's
execution policy for the worker's process, which is what kept `npm` and
`pnpm` from starting there. When the editors of a fix run are left in the
unelevated sandbox, the run says so at its start and their tasks say what
cannot run. The recorded cause of the failure, which was wrong, is
corrected wherever it is written.

Amended on 2026-10-05 after a reduced gate (Verification of the design):
the shipped default is `none`, so a Codex fix run on Windows gives its
editors no sandbox unless the operator asks for one (D4). Of the three
values only `none` let the editors run the build and the tests with no
hand on the run; `elevated` blocked the survey and broke tools for the
sandbox user, and `unelevated` leaves a fixer to validate in one process.

## Problem

On Codex for Windows no fixer or repair worker can run a repository's build
or tests (issue #10). On the fix pass gate of 2026-10-03 (zod #6530, run
`509e520e`) every fixer met `spawn EPERM`, 48 times over eight batches, and
the repair worker named a bundle-size regression, measured it, and answered
`deferred` because it could not run the build to validate a change. The
fixer's validation rules ask for a red run against the unfixed code or a
mutation; under this sandbox every fix falls back to `static` or `limited`.

The cause recorded then was that no process a worker's process starts may
start another. That is not what happens. A probe on 2026-10-04 with
`codex sandbox` (codex-cli 0.160.0, no model involved) showed:

- Under `unelevated`, a process cannot create a named pipe
  (`net.createServer().listen('\\\\.\\pipe\\...')` fails with `EACCES`).
  Node gives a child its piped stdio through named pipes, so
  `child_process.spawn` and `spawnSync` fail with `EPERM` whenever any of
  the child's stdio is `pipe`, which is the default.
- The same spawn succeeds with stdio `inherit`, `ignore` or a file handle,
  and a grandchild started through `cmd.exe` with its own pipes runs. So
  processes do start; it is the pipe that is refused.
- eslint's `npm run lint` (`node Makefile.js lint`, which starts processes
  through shelljs) fails in 3 s under `unelevated` and passes in 40 s under
  `elevated`, as it does with no sandbox.

The unelevated sandbox runs commands under a restricted token of the
operator's own account; the elevated one runs them as a separate local
user. Nothing the engine does can make a repository's Node tools stop using
pipes, so under `unelevated` a Node toolchain cannot run, whatever the
task says.

The adapter has supported `elevated` since the runtime adapter element, but
only the smoke script can choose it, and a first probe of it on 2026-10-03
stopped at PowerShell refusing the `pnpm.ps1` shim. The probe of 2026-10-04
found that one environment variable on the worker's process removes that
refusal (see Context in the design).

OpenAI's documentation names `elevated` the preferred Windows sandbox and
`unelevated` the fallback, so the engine's default is the vendor's fallback.
The elevated sandbox needs a setup step an administrator approves, and not
every machine has it.

## Goals

- On Windows, a Codex fixer and repair worker can run the repository's
  build and tests when the operator chooses a confinement that allows it.
- The choice is the operator's, made when the run starts, recorded on the
  ledger, and kept on every resume.
- A worker that only reads is confined under every value.
- A run whose editors cannot run the build knows it: the operator is told
  at the start, and the editors are told in their task, so no turn is
  spent finding out.
- What the documents and comments say about the cause is true.

## Non-Goals

- No change to the Codex adapter's own default. A caller that builds the
  adapter itself, such as the smoke script, still gets `unelevated` when
  it names nothing; only the policy's value, which `review` uses, is
  `none` (D4).
- No setting for macOS or Linux. Codex's sandboxes there let a worker run
  a build, so nothing has shown a need.
- No sandbox setting for Claude Code. Its workers are held by a tool
  allowlist and have no OS sandbox today; that is unchanged.
- No removal of the sandbox from readers (D2).
- No further repair rounds. Having the engine run the checks between
  rounds of one repair session would help a worker that cannot run them
  itself, but it reopens PD9 of the fix pass and is not needed if the
  editors can run the build. Revisit if the gate shows no value is usable.
- No return of the snapshot command to starting git. R23 of the fix pass
  stands: a manifest read with no process works under every sandbox.
- No setup of the machine. The elevated sandbox needs Codex's one-time
  setup and a package store the sandbox user can read; the README says so
  and the engine does neither.
- No container or WSL support of the engine's own. An operator may run the
  engine inside either; nothing here depends on it.

## Requirements

- R1: `review` accepts `--codex-windows-sandbox <unelevated|elevated|none>`.
  Without the flag the value is the policy's `runtimes.codex.windowsSandbox`,
  shipped as `none` (amended 2026-10-05; first shipped as `unelevated`).
  With `--runtime claude` the flag is refused. On
  another platform than Windows the flag is ignored with a warning and
  every worker runs as today.
- R2: Under `unelevated` and `elevated`, every Codex worker of the run uses
  that Windows sandbox, with `sandbox_mode` from its access as today.
  Under `none`, a worker whose access is `edit` runs with
  `sandbox_mode="danger-full-access"`, and every other worker runs
  read-only under the `unelevated` sandbox, which needs no setup. A run
  without `--fix` has no editor, so `none` changes nothing in it.
- R3: The value is recorded on `review.configured@4` as
  `codex: { windowsSandbox }`, `null` when the runtime is Claude Code or
  the platform is not Windows. A resume uses the recorded value; a resume
  that passes the flag with a different value is refused by name, as other
  pinned settings are. A run configured at version 3 or earlier folds to
  `unelevated`. (Amended 2026-10-05.) That holds for a Codex run on
  Windows only: the fold reads the platform from the worktree
  `run.created` recorded, resolved, so a Codex run whose worktree is
  rooted at `/` folds to `null`, as a version 4 run off Windows records,
  and any other worktree (a drive letter, a UNC share, or a relative
  path a library caller passed) folds to `unelevated`. A run of another
  runtime folds to `null` wherever it ran.
- R4: Under `elevated` the Codex adapter sets
  `PSExecutionPolicyPreference=RemoteSigned` in the worker's environment
  unless the variable is already set. Under `unelevated` and for an
  unsandboxed editor the environment is as today. (Amended 2026-10-05.)
  That holds except for the search path, which R11 spells `PATH` under
  every value, so no value leaves a worker's environment exactly as it
  was; the execution policy is still set only under `elevated`, and
  there in one spelling (see the departures under Verification in the
  design).
- R5: When a fix run's value is `unelevated`, `review` prints one warning
  before the first worker starts: editors cannot run tools that start
  processes through Node, which includes most build and test commands,
  and the two other values of the flag. The warning is printed again on
  each resume of such a run. (Amended 2026-10-05.) Since the value is
  pinned and a resume naming another is refused (R3), the warning says
  the run is abandoned before a new one is started with either value; it
  had said only that a run started with one could run them, which a
  resume following it was refused for.
- R6: In the same case the fixer's and the repair worker's task carries
  one fragment saying that a Node process here cannot start a child whose
  output it captures, so the build, the tests and package scripts fail
  with `EPERM`; that a fix is validated by what does run (a direct `node`
  probe, a test file run in one process) and recorded as `limited` with
  that reason otherwise; and that the engine runs the checks afterwards.
  In every other case the task does not carry it, and the prompts of
  those runs keep their hashes. (Amended 2026-10-05.) The fragment names
  how a test file stays in one process, with the test runner's option
  against a child per file and `node --test --test-isolation=none
  <file>` as the example: by default `node --test <file>` runs the file
  as a child through captured stdio (on Node 26.10 it sees
  `NODE_TEST_CONTEXT=child-v8`), the spawn that fails there.
- R7: The report's run section names the value for a Codex run on Windows.
- R8: The cause is corrected where it is written: the comment on
  `windowsSandbox` in `src/runtime/codex.ts`, the README's sentence in the
  fix pass section, a dated correction beside R23 and PD21 in the fix pass
  proposal (the record of what was believed stays; the note says what a
  later probe found), lever 2 of
  `docs/reports/2026-10-03-fixer-time-and-cost.md`, and issue #10.
- R9: The README says what each value needs and gives up: `elevated` needs
  Codex's elevated setup and readable package stores; `none` gives an
  editor an unconfined shell and the network, so it suits a change the
  operator trusts or a machine that is itself the boundary (a container,
  a virtual machine).
- R10: Acceptance is real runs on Windows, zod #6530 with `--fix` on Codex
  from fresh clones: one with `elevated`, one with `none`. Each passes
  when it reaches a report with no hand on the run, no fixer or repair
  result holds `spawn EPERM`, at least one finding's `validation` records
  an executed red and green run, and a check that regresses after the
  fixes is repaired or deferred for a reason other than being unable to
  run it. A run under `unelevated` is recorded for the warning and for
  the count of `EPERM` results against `509e520e`'s 48.
- R11: (Added 2026-10-05.) On Windows the Codex adapter hands a worker
  its search path as one variable spelled `PATH`, under every value. The
  elevated runner adds a `PATH` of its own, so the `Path` the adapter
  wrote until then reached the worker beside it; `pnpm exec` prepends
  `node_modules\.bin` to one of the two while the shell it starts reads
  the other, so no project binary resolved.
- R12: (Added 2026-10-05.) When a run's value is `elevated` on Windows,
  the surveyor's task names `Get-Command -CommandType Application <tool>`
  in Windows PowerShell as the way to look a tool up, in place of
  `where.exe`, which finds nothing as the sandbox user under a directory
  whose ancestors that user cannot list, such as anything in the
  operator's profile. Every other run's surveyor task is unchanged.
  (Amended 2026-10-05.) `Get-Command` does not search the current
  directory, which `cmd.exe` does before PATH, so when the lookup fails
  the task has the surveyor try `.\<tool>` too: a check that starts with
  a script in the repository root, such as `gradlew.bat`, `mvnw.cmd` or
  `build.cmd`, is then not reported missing and does not block the
  survey with `check-unavailable`. Like `where.exe`, the lookup does not
  heed `NoDefaultCurrentDirectoryInExePath`, which keeps `cmd.exe` out of
  the current directory when set; that gap is every value's, not
  `elevated`'s.

## Product Decisions

- **D1: One flag with three values.** The author chose one flag on
  2026-10-04 over the draft's two (a sandbox choice and a separate switch
  for unsandboxed editors). The operator answers one question, "how are
  Codex workers confined on this machine", and the three answers are the
  three things that exist: the sandbox that needs no setup, the one that
  needs it, and none for the workers that must run the build. The cost is
  that `none` does not mean the same thing for every role (D2), which R2
  states outright. The combination the two flags allowed and this does
  not, elevated readers with unsandboxed editors, has no use: a machine
  with the elevated setup uses `elevated` for both.

- **D2: Readers keep the sandbox under `none`.** Codex has no tool
  allowlist; its shell is its only tool, so `sandbox_mode="read-only"` is
  the only thing that keeps a finder or a verifier from writing. Claude
  Code's readers are held by their tool list instead. Removing the
  sandbox from every Codex role would therefore be looser than Claude
  Code, not equal to it, for the roles that make up most of a run. The
  readers of a `none` run use `unelevated` because `none` is the value
  for a machine without the elevated setup.

- **D3: An unsandboxed editor is acceptable in a fix run because the
  engine already runs the repository's code.** The author approved it as
  an opt-in on 2026-10-04. After the fixers, the engine runs the build
  and the tests with the operator's permissions and no sandbox, so
  anything a fixer wrote, or the change under review carried, runs then.
  What the sandbox adds on an editor is confinement during its session:
  no network and no write outside the worktree by the model's own
  commands. On 2026-10-05 the author made it the default (D4), so the
  same reasoning now stands for every Codex fix run on Windows that does
  not ask for a sandbox.

- **D4: The shipped default is `none`.** The author decided on
  2026-10-05, after the reduced gate. Until then the default stayed
  `unelevated`, with the author's position of 2026-10-04 that it should
  become `elevated` or `none`: a default under which the build cannot
  run serves no fix run, and the elevated setup is not on every machine.
  The gate settled the choice. `none` was the one value whose run reached
  a report with no hand on it while its editors ran the build and the
  tests. `elevated` let them run, but as the sandbox user `where.exe`,
  `os.userInfo()`, reads above the workspace and biome from a pnpm script
  all failed, the survey blocked on a tool that was installed, and the
  repair worker could not run the tests; and it needs a setup an
  administrator approves. `unelevated` held to its warning and fragment,
  but its fixers could not see a lint error the build then caught. This
  makes an unsandboxed editor the shipped behavior, which the author
  accepted on D3's grounds; an operator who wants an editor confined
  passes `--codex-windows-sandbox unelevated` or `elevated`, or changes
  the policy. What `codex exec` does under `elevated` on a machine
  without the setup was not probed and no longer bears on the default.

- **D5: A flag with a policy default, not policy alone.** `fixes.batchSize`
  and `survey.userRules` are policy because they describe how a review is
  done. Which sandbox works depends on the machine, so the operator
  chooses it per invocation; the policy holds the value used when nothing
  is said.

- **D6: The execution policy is set through the environment, under
  `elevated` only.** As the sandbox user, Windows PowerShell refuses every
  `.ps1` shim (`npm`, `pnpm`, `npx`); the likely reason is that a user
  with no policy of its own gets the Windows default, `Restricted`, which
  the probe could not read back. `PSExecutionPolicyPreference` sets the
  policy for one process tree and changes nothing on the machine; a
  machine or group policy still overrides it. Telling workers to call the
  `.cmd` shims was rejected: it is one more thing to remember in every
  command. Under `unelevated` and `none` the worker is the operator's own
  account and its policy is already the operator's.

- **D7: The task fragment is conditional on the run's own setting.** The
  condition (Codex, Windows, `unelevated`, an editor) is a fact about the
  engine's launch, not a rule about the repository, so it is decided by
  the engine. The fragment is added to the task, not to the role prompt,
  so no role's prompt or hash changes for any other run.

- **D8: The earlier record is corrected by a dated note, not rewritten.**
  The fix pass proposal says what was believed on 2026-10-03 and R23 was
  decided on it. The decision still stands on the corrected cause
  (`spawnSync git` does fail), so the note says what the cause is and
  that the decision is unchanged.

- **D9: Under `elevated` the engine fixes what is its own and leaves the
  sandbox as Codex draws it.** (Added 2026-10-05.) The author's position:
  a run that trusts the change uses `none`, so `elevated` is for a change
  that is not trusted, and its confinement is the point. Two causes of
  the gate's failures are the engine's own and are fixed: the duplicate
  search path (R11) and the lookup command the surveyor is told to use
  (R12). Two are left: `os.userInfo()` throws because the sandbox user has
  no profile, which stops `tsx`, and the sandbox user cannot list the
  operator's profile directory, which stops a tool that walks up through
  it, such as vitest's default config loader. A preload in
  `NODE_OPTIONS` that answers `os.userInfo()` from the environment was
  probed and works, and a list-only grant on the profile directory was
  probed and works; both were rejected, the first for reaching into every
  Node process the repository runs, the second for widening what the
  sandbox user may see. A search of Codex's issues and source found no
  supported fix for either. Codex's elevated runner passes
  `LOGON_WITH_PROFILE` only in its registered-Core mode
  (`CODEX_WINDOWS_REGISTERED_CORE=1`, `runner_client.rs`), so the CLI's
  sandbox user has no profile; openai/codex#42753 reports the same
  `ENOMEM` and is open with no reply. Codex stopped granting the profile
  root on purpose (openai/codex#18443, to keep `.ssh` and the like
  intact), and openai/codex#41237 reports esbuild failing on it, open
  with no reply; its one way to add a readable directory,
  `/sandbox-add-read-dir`, lasts a session of the interactive client and
  is not open to `codex exec`. Placing the repository outside the profile
  was rejected as a fix: it asks every operator to change where they
  work, and any tool that walks up through the profile, now or later,
  breaks again. So both limits stay until Codex changes, and under
  `elevated` an editor may not run the build or the tests, depending on
  the repository's tools; the README says so. Revisit when #42753 is
  fixed or Codex grants the profile root again.

## Risks

- Risk: an unsandboxed editor that reads hostile text in the change under
  review has a shell and the network. Accepted, as the default since
  2026-10-05 (D4): this is the exposure a Claude Code editor already has,
  the engine runs the repository's checks unsandboxed anyway, the README
  names it beside its advice for an untrusted repository, and the drift
  check sees writes to the worktree only. Writes outside the worktree and
  network use by an editor are not detected.
- Risk: a tool that asks who the user is fails under `elevated`
  (`os.userInfo()` throws). Not accepted blindly: R10's run on zod shows
  whether pnpm, vitest or esbuild do; a failure there is recorded and
  weighs on D4.
- Risk: the sandbox user cannot read a package store or a tool installed
  under the operator's profile on some machine. Accepted; the README says
  what must be readable, and the failure names the path. (Amended
  2026-10-05.) The surveyor looks tools up as that user while the engine
  runs the checks as the operator, so a check whose tool only the
  operator can read, such as one under `~\.cargo\bin`, blocks the survey
  with `check-unavailable` naming the tool, not a path, though the check
  would have run. The block's own action is the way past it: `--check
  <kind>=<command>` settles the kind, and the engine runs it as the
  operator. Having the engine look a missing tool up again as the
  operator before it blocks was left out: it would overrule the
  surveyor's recorded word (R15 of the repository survey) with a lookup
  that judges a name by a file on PATH, which the operator's PATH can
  satisfy with a WindowsApps alias the worker's drops, such as the
  `python` stub that only points at the Store when no Python is
  installed. (Amended 2026-10-05, after review.) `~\.cargo\bin` was a
  wrong example. On codex-cli 0.160.0, starting the elevated sandbox
  grants `CodexSandboxUsers` read and execute on every folder directly
  under the operator's profile except `.ssh` and `.config`, `.cargo`
  and a newly made folder among them (see Context in the design), so
  the surveyor finds a tool there. What still blocks the survey with
  `check-unavailable` though the engine could run the check is, under
  `elevated`, a tool under one of those protected folders or in the
  profile folder itself, and under every value, a tool reachable only
  through a WindowsApps alias, which every worker's search path drops
  (see the next risk). The workers cannot run those tools either. The
  surveyor's answer stands, and `--check` remains the way past it.
- Risk: (Added 2026-10-05, after review.) An editor that `none` runs in
  no sandbox loses the WindowsApps directories from its search path too,
  though it could launch what they hold, because R4 keeps its
  environment as it was. So a tool reachable only through a Store
  app-execution alias, such as Python installed from the Store or
  winget, runs for the engine's checks, which run as the operator, but
  not for the fixer, which records its validation as `limited`.
  Accepted, so that every worker gets one search path and one shell:
  Windows PowerShell 5.1 where PowerShell 7 came from the Store
  (`docs/reports/2026-10-03-fixer-time-and-cost.md` notes the adapter
  dropping WindowsApps there), the shell every run of R10's and D4's
  gate used, and the Store's `python` stub stays out of every worker's
  reach. Keeping WindowsApps for unsandboxed editors alone was left out:
  it would give one run's workers two shells, the surveyor, a reader,
  would still lose the alias and block the survey, and no real run has
  tried it.
- Risk: `PSExecutionPolicyPreference` is overridden by a group policy, so
  the shims stay refused on a managed machine. Accepted; the worker's
  output shows the refusal and `none` remains.
- Risk: Codex changes what its sandboxes allow between versions, as it may
  already have between 0.157.1 and 0.160.0. Accepted; the fragment of R6
  describes one sandbox and is removed when a gate shows it no longer
  true.
- Risk: the Codex verifiers' leniency on the earlier gates (33 of 35
  confirmed against Claude's 17 of 28) may have the same cause, a verifier
  unable to run a test that would refute a candidate. Not addressed here;
  R10's elevated run, where readers can run tests too, is the first
  evidence either way. Under `none` the readers stay under `unelevated`
  and would keep that limit.
