# Change Proposal: Codex sandbox setting on Windows

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

Amended on 2026-10-05 after a reduced gate (Verification): the shipped
default is `none`, so a Codex fix run on Windows gives its editors no
sandbox unless the operator asks for one (D4). Of the three values only
`none` let the editors run the build and the tests with no hand on the
run; `elevated` blocked the survey and broke tools for the sandbox user,
and `unelevated` leaves a fixer to validate in one process.

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
refusal (see Evidence).

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
  `unelevated`.
- R4: Under `elevated` the Codex adapter sets
  `PSExecutionPolicyPreference=RemoteSigned` in the worker's environment
  unless the variable is already set. Under `unelevated` and for an
  unsandboxed editor the environment is as today. (Amended 2026-10-05.)
  That holds except for the search path, which R11 spells `PATH` under
  every value, so no value leaves a worker's environment exactly as it
  was; the execution policy is still set only under `elevated`, and
  there in one spelling (see the departures under Verification).
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

## Decisions

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

## Evidence

Probes of 2026-10-04 on Windows 11, codex-cli 0.160.0, Node 26.10.0. The
gate runs of 2026-10-03 used codex-cli 0.157.1; the symptom is the same.

| Probe | unelevated | elevated |
|---|---|---|
| `spawnSync(node, ['-v'])`, stdio `pipe` | `EPERM` | runs |
| the same, stdio `inherit`, `ignore` or a file | runs | runs |
| `cmd /c "git --version \| findstr git > file"` from node | runs | runs |
| listen on a named pipe | `EACCES` | `EACCES` |
| asynchronous `spawn`, stdio `pipe` | `EPERM` | runs |
| eslint, one mocha file in one process | passes | passes |
| eslint, `npm run lint` | fails in 3 s | passes in 40 s |
| write outside the workspace | refused | refused |
| read `~/.ssh` | allowed | refused |
| read `AppData\Local\pnpm`, `AppData\Local\uv` | allowed | allowed |

Through `codex exec` with the adapter's settings and `gpt-6.1-sol`, in the
eslint clone:

- `sandbox_mode="danger-full-access"`: accepted, `npm run lint` exits 0.
- `windows.sandbox="elevated"`: `npm run lint` is refused by PowerShell
  (`PSSecurityException`, `UnauthorizedAccess`).
- The same with `PSExecutionPolicyPreference=RemoteSigned` in the
  environment: `npm run lint` exits 0, and `whoami` answers
  `CodexSandboxOffline`.

Also seen under `elevated`: `codex sandbox` given a bare `node` fails with
`CreateProcessAsUserW failed: 2`, and needs the full path (a worker's shell
resolved `npm` and `node` by name, so this did not reach a worker);
`os.userInfo()` throws `ENOMEM`; `Get-ExecutionPolicy` cannot load its
module.

Not probed: pnpm with its store under `elevated` (the directory is
readable; an install and a build were not run), `dotnet build`, and what
`codex exec` does under `elevated` on a machine without the setup.

Probes of 2026-10-05 with `codex sandbox` under `elevated`, after the
gate, as `CodexSandboxOffline`:

- The sandbox user has no profile: no `ProfileList` entry for its SID
  and no `C:\Users\CodexSandboxOffline`; it inherits the operator's
  `USERPROFILE`. `os.userInfo()` throws `uv_os_get_passwd returned
  ENOMEM`, and `tsx` calls it on load, so `pnpm check:comments` fails;
  with a preload answering it from the environment, the same command
  passes.
- `C:\Users\josep` carries no entry for `CodexSandboxUsers`, which has
  read and execute on chosen folders under it (`projects`, `AppData`,
  `.claude`, `.agents`, `.codex`). The sandbox user cannot list the
  profile directory itself. `where.exe` fails for every file under it,
  `where /R` with "Access is denied", and succeeds under
  `C:\Program Files`, `C:\Windows\System32` and `C:\Users\Public`.
  Rebuilt under `C:\Users\Public`, a directory the user cannot list made
  `where.exe` and Node's `readdirSync` of it fail, and a grant of
  `(S,RD,X,RA)` on that directory alone made both work, while a file in
  it stayed unreadable.
- `Get-Command -CommandType Application <tool>` in Windows PowerShell
  finds `pnpm.cmd`, `node` and `git` with exit code 0 and a missing tool
  with 1, under `elevated` and `unelevated` alike.
- (Probed 2026-10-05 as the operator, in Windows PowerShell on Windows
  11.) With `zzprobe.bat` in the current directory and not on PATH,
  `Get-Command -CommandType Application zzprobe` exits 1, the same with
  `.\zzprobe` exits 0 naming `zzprobe.bat`, `where.exe zzprobe` finds it,
  and `cmd.exe /d /s /c zzprobe` runs it. With
  `NoDefaultCurrentDirectoryInExePath=1`, `where.exe` still finds it and
  `cmd.exe` does not.
- The worker's process sees both `PATH` and `Path`. `pnpm exec biome
  --version` and `pnpm exec vitest --version` fail with "not recognized"
  while `pnpm format:check`, a script, passes; launched with the parent's
  search path spelled `PATH` alone, the child sees one variable and
  `pnpm exec biome --version` prints its version.

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
  installed.
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

## Verification

Implemented on 2026-10-04 on branch `plan-next-steps-review` in six
commits after the proposal: `94b82ca` corrects the recorded cause (R8),
`e0f900c` gives the Codex adapter `none` and the execution policy (R2,
R4), `7d35d8f` pins the value on the run (R1, R3), `5682bf8` adds the
warning and the task fragment (R5, R6), `5802cdd` the report's line (R7)
and `6717a67` the README (R9). Issue #10's body had already been
corrected on GitHub with the probed cause before the work began.

Run on the author's Windows 11 machine, Node 26.10.0:

- `npm run check` passes at `6717a67`: lint, typecheck and 1438 tests,
  1419 passing and 19 skipped, the same platform cases that skipped
  before this change. `npm run verify` matches both artifacts at every
  commit that changed the engine; each of those commits carries its
  rebuilt `dist/`.
- No fragment under `roles/` and no file under `skill/` changed, so the
  roles digest and every role's hash are what they were (D7). The
  fixer's and the repair worker's tasks are byte for byte as before
  unless the run's editors are under `unelevated`, which a test holds by
  removing the fragment from such a task and comparing it with the
  other.
- Ledger: `review.configured@4` and fixture `schema-1-07`, whose
  seventh run is a Codex fix run pinned to `none`. The sixth run of
  `schema-1-06`, a Codex run configured at version 3, folds to
  `unelevated` under the new engine, and the golden test now asserts
  that of every older fixture's Codex run, and `null` of every other.
- What the suite proves of each requirement: the adapter's command
  lines and environment for every value, fresh and continued, on Windows
  and elsewhere (R2, R4); the policy file's refusals and `resolvePolicy`
  for every runtime, value and platform, and the command line's refusals
  (R1); through the controller with the fake Codex, the value pinned
  from the flag and from the policy, `null` off Windows and on Claude
  Code, a resume with another value refused by name and with the same
  or none accepted, a version 3 run resumed under `unelevated`, and the
  workers launched on runtimes built with the pinned value (R1 to R3);
  in a whole fix run, the warning before the first worker and again on
  a resume, the fragment in the fixer's and the repair worker's prompts
  and in no reader's, and neither under `elevated`, `none`, another
  platform or Claude Code (R5, R6); the report's line for each value and
  its absence (R7).

Departures and choices the proposal did not state:

- The controller takes a function that builds the runtimes rather than
  a registry: it builds one with no option for the adapter that
  resolves the policy, preflights the executable and reads usage, none
  of which the sandbox changes, and one with the run's pinned value for
  the workers, so a resume launches on what the run pinned however the
  command was invoked.
- Under `none` an editor gets no `sandbox_workspace_write.writable_roots`,
  which has no meaning outside `workspace-write`, and the command keeps
  `windows.sandbox="unelevated"`, as the probe that ran
  `danger-full-access` had it.
- An empty `PSExecutionPolicyPreference` is taken as unset and replaced,
  since an empty value sets no policy. (Amended 2026-10-05.) The worker
  gets the variable in one spelling only: when the caller's environment
  holds several, the first by code unit that has a value is kept and
  the others removed. Node hands a Windows child only the spelling that
  sorts first, so an empty `PSExecutionPolicyPreference` beside a
  `psexecutionpolicypreference=AllSigned` had reached the worker as the
  empty one, with no policy pinned.
- A resume that passes the flag to a run that pinned none, because it was
  configured off Windows, says the flag is ignored rather than refusing
  it, as a new run off Windows does. (Amended 2026-10-05.) So does a
  resume off Windows of any run, whatever it pinned: no sandbox applies
  there, so a flag naming another value than the pinned one is named as
  ignored, not refused, as R1 has it for a new run.
- The fold cannot tell the platform a run was on, so a Codex run
  configured at version 3 or earlier reads as `unelevated` on any
  platform, as R3 says. The warning, the fragment and, since the
  amendment above, the resume's check of the flag ask the platform too,
  so such a run resumed on macOS or Linux gets neither warning nor
  fragment, and its resume takes any value of the flag with the note
  that it is ignored; its report would still name `unelevated` in its
  header, which is accepted as a case of runs already in flight when the
  engine is updated. (Amended 2026-10-05.) `unelevated` is what
  `deep-review review` ran such a run under, but not necessarily what a
  library caller did: the adapter could be built with `elevated` before
  this change, and the ledger did not record it. Such a run, resumed
  after the update, relaunches its workers under `unelevated`, and on
  Windows refuses `--codex-windows-sandbox elevated` as another value
  than the pinned one; abandoning it and starting again is the way to
  keep `elevated`.
- `review` takes a `platform` option, the process's by default, so the
  suite exercises the Windows cases on every runner of CI.

### Gate, reduced (2026-10-04 to 10-05)

R10's runs, cut down for cost at the author's request, so they are
evidence for D4 rather than R10's acceptance as written. The engine was
`1f640ce` built with one uncommitted change, never committed: only the
five best-ranked fixer-routed findings went to fixers, the rest held.
The models were `--strong-model gpt-6.1-sol --fast-model gpt-6-luna`,
one step below the policy's. zod #6530 from fresh `core.autocrlf=true`
clones at `e48a0055`, `--from eca96871 --to HEAD --fix`, codex-cli
0.160.0, pnpm 10.12.1 on PATH from its own prefix.

| | `none` | `elevated` | `unelevated` |
|---|---|---|---|
| Run | `67dda382` | `0bda0a7c` | `8376b749` |
| Reader timeout | 600 s | 1200 s | 1200 s |
| Hand on the run | none | survey blocked, checks given by flag; restarted | none |
| Findings | 20 (19 CONFIRMED) | 26 (23 CONFIRMED) | 35 (35 CONFIRMED) |
| Fixes | 1 applied, 4 already applied | 5 applied | 2 applied, 2 already applied, 1 deferred |
| `spawn EPERM` in fixer and repair results | 0 | 0 | 0 |
| Executed red and green validation | 3 findings | 5 findings | 4 findings, run in one process |
| Checks after the fixes | build passes; test 6 failures to 2 | all as baseline | build regressed, repaired |
| Workers, wall time | 30, 6703 s | 28, 4538 s | 30, 5458 s |
| Input (cached), output tokens | 13.4M (11.8M), 123k | 21.5M (19.6M), 188k | 18.0M (16.0M), 174k |

What the runs showed:

- **`none` meets R10's four criteria.** Its editors ran `pnpm build`,
  `pnpm test`, vitest, biome and the integration typecheck with no
  refusal; one found the cause of zod's `attw` failure
  (`FORCE_HYPERLINK`) and one fixed zod's Windows path bug in
  `treeshake.test.ts` to get its validation running, a one-line edit
  outside its findings that rode in a finding's patch.
- **`elevated` runs the build and the tests, with friction for every
  worker.** As the sandbox user, `where.exe` finds nothing, so the
  surveyor reported pnpm missing and the survey blocked with
  `check-unavailable` (R15); `os.userInfo()` throws (`uv_os_get_passwd`
  `ENOMEM`), so `tsx` fails and with it `pnpm build`'s postbuild and the
  comment check; vitest's default config loader cannot read the
  directories above the workspace and needs `--configLoader runner`; and
  `biome` does not resolve from a pnpm script though `biome.exe` and the
  shim run directly. The fixers worked around each and still produced
  executed validation for all five findings; the repair worker could not
  run `pnpm test` at all. `PSExecutionPolicyPreference` removed the shim
  refusal: no fixer met `PSSecurityException`.
- **`unelevated` does what R5 and R6 intend.** The warning printed once,
  before the first worker. No fixer called pnpm or vitest: each wrote a
  single-process runner in its scratch directory and ran it with `node`,
  for red and green and mutation runs. A fixer's edit then broke the
  build, a biome `noAssignInExpressions` error in `postbuild`, which no
  fixer could have run; the repair worker, given the output, fixed the
  line, checked it with `biome.exe` directly, and every check passed
  after it except test's six baseline failures. R10's `EPERM` count
  against `509e520e`'s 48 is 0, though over five findings in three
  batches, not 26 in seven.
- **The survey's commands depend on the shell.** zod's `test:source` and
  `check:circular` scripts need a POSIX shell; under `cmd.exe` the
  `none` run's typecheck and lint failed before and after every fix, so
  only build and test could see a regression there. The first
  `elevated` surveyor chose `pnpm --config.shell-emulator=true`, the
  others did not; the later runs set `npm_config_shell_emulator=true`.
- **600 s is short for `gpt-6.1-sol` on zod.** On the `none` run the
  triage and the sweep each needed their retry and REMOVALS did not run;
  the first `elevated` run's sweep timed out four times and the run was
  abandoned. With 1200 s nothing timed out but one fixer at 1800 s,
  whose snapshots kept its work (R20).

Not settled: R10 as written, with the policy's models and every finding.
D4 was decided on this evidence on 2026-10-05: the default is `none`.

### R11 and R12 (2026-10-05)

`b0cb767` spells the search path `PATH` (R11), with a test that every
spelling a caller holds becomes one `PATH` under every value, which
failed before the change; `ecc01bc` gives the elevated surveyor the
`Get-Command` lookup (R12), with a test that it is the one difference
from every other surveyor task and run-level tests that an elevated
run's surveyor gets it and a `none` or `unelevated` one keeps
`where.exe`. `npm run check` passes at `ecc01bc`: 1445 tests, 1426
passing and 19 skipped; `npm run verify` matches. Both rest on the
`codex sandbox` probes in Evidence; no `codex exec` run has used them
yet.
