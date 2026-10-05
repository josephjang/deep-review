# Technical Design: Codex sandbox setting on Windows

Product part: [2026-10-04-codex-sandbox.requirements.md](2026-10-04-codex-sandbox.requirements.md).

(Added 2026-10-05, after review.) This proposal was written on
2026-10-04 as one Unified file, `2026-10-04-codex-sandbox.md`, and split
into these two files after review, since the change adds a ledger event
version with a fold for older ones, changes the runtime interface and
the policy file, and respells the worker's search path, the cases
`AGENTS.md` gives the Split form for. The Context, which was the
Evidence section, and the Verification are the Unified file's own text,
except that the departures Verification listed, all of them technical,
are now Technical Decisions with their dates. The Summary, the Design,
the other Technical Decisions, the Test Strategy and the Risks &
Migration were written at the split from what the code did then.

## Summary

One setting, a Windows sandbox from the Codex adapter's
`windowsSandboxes` (`unelevated`, `elevated`, `none`), travels from the
command line or the policy file to the ledger, and from the ledger to
the command line of every Codex worker. `resolvePolicy` chooses it for a
Codex run on Windows; the controller records it on
`review.configured@4` and, on every invocation, hands it to every launch
as the run's pinned runtime options; the Codex adapter turns it into
`sandbox_mode`, `windows.sandbox` and the worker's environment. Every
other use reads the recorded value through one helper,
`pinnedWindowsSandbox`, which asks the platform as well: the warning,
the editors' task fragment, the surveyor's lookup and the resume's
check of the flag. The report names the value from the ledger.

## Context

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
  it stayed unreadable. (Amended 2026-10-05, after review.) The five
  folders named are not the whole grant: the last probe below found it
  on every folder directly under the profile except `.ssh` and
  `.config`, added when the elevated sandbox starts.
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
- (Probed 2026-10-05 after review, codex-cli 0.160.0.) Starting `codex
  sandbox -c 'sandbox_mode="read-only"' -c 'windows.sandbox="elevated"'`
  added `CodexSandboxUsers:(OI)(CI)(RX)` to `C:\Users\<user>\.cargo`, a
  folder made for the probe, and `Get-Command -CommandType Application`
  then found a tool in it as `CodexSandboxOffline`; another new folder
  under the profile behaved the same. After the probe every folder
  directly under the profile carried that grant except `.ssh` and
  `.config`, and the profile folder itself carried none. The grants
  outlast the sandbox; how many of them predate the probe is not known.

## Design

### Command line and policy file (R1, R9)

`deep-review review` takes `--codex-windows-sandbox`, whose usage line
lists `windowsSandboxes` from `src/runtime/codex.ts`.
`codexWindowsSandboxFlagProblem` in `src/review/policy.ts` refuses a
value outside them and the flag with any runtime but Codex. The command
line refuses either with the usage before it opens the checkpoint, and
`refuseInvocationFlags` refuses the same for a caller that does not come
through it, on a new run and on a resume. Every other command refuses
the flag as one it does not take. A given value reaches the controller
as `PolicyFlags.codexWindowsSandbox`.

A runtime entry of the policy file gains an optional `windowsSandbox`
over the same values. `policyFileSchema` requires it on the `codex`
entry and refuses it on any other (TD5). The file is validated whole
before an entry is chosen, so a policy file whose `codex` entry names
none is refused for a Claude Code run too (Risks & Migration).
`roles/policy.json` ships `"windowsSandbox": "none"` (D4).

`scripts/smoke-runtime.ts` takes the same three values for the Codex
adapter it builds, checked with `isWindowsSandbox`. The adapter's own
default stays `unelevated` (Non-Goals of the requirements).

### Resolving the value (R1, R3)

`resolvePolicy(policy, roles, adapter, flags, platform)` returns
`codex: { windowsSandbox }` only when the adapter is Codex's and the
platform is `win32`: the flag's value, else the policy entry's. A policy
built without `parsePolicy` that names neither is refused rather than
given a value. Any other runtime or platform gets `codex: null`, and a
new run off Windows that named the flag logs that the flag is ignored
there (`openRun` in `src/review/controller.ts`). Only a new run reads
the policy file; a configured run reads its configuration.

### Ledger event and fold (R3)

`review.configured@4` (`src/checkpoint/events.ts`) is version 3's shape
and `codex: { windowsSandbox } | null`, the value an enum over
`codexWindowsSandboxesV4`, a frozen copy of the adapter's values that a
test holds equal to them (TD1). It restates version 3's refinements, as
every version in the file restates its own, and adds one: a run whose
`runtime` is not `codex` records `codex: null`. The controller appends
version 4 for every new run, and its configuration log line names the
value when there is one.

`src/checkpoint/review-fold.ts` folds version 4 as recorded. Versions 1
to 3 get their `codex` from `unpinnedCodex(runtime, worktree)`, given
the worktree `run.created` recorded: `{ windowsSandbox: 'unelevated' }`
for a Codex run whose worktree is not rooted at `/`, and `null` for any
other run (TD2). `ReviewConfiguration` is version 4's type, so every
reader sees one shape whichever version recorded it.

Fixture `schema-1-07` adds a seventh run, a Codex fix run configured at
version 4 from `C:\fixture\unsandboxed`, pinned to `none` and abandoned
as its survey starts. Its sixth run, a Codex run configured at version
3 from `/fixture/unsurveyed`, folds to `null`.

### The pin on every launch (R2)

`PinnedRuntimeOptions` (`src/runtime/runtimes.ts`) holds what a run
pinned, by runtime name: today `codex?: { windowsSandbox }`. On every
invocation `runReview` derives it from the folded configuration with
`pinnedRuntimeOptionsOf`, `{}` when `codex` is null, and passes it to
every `runWorker` as `pinned`, beside the run's `platform`. The launcher
puts the adapter's own entry, an own property of `pinned` under the
adapter's name or else `null` (`pinnedFor`), on the new
`LaunchPlan.runtimeOptions` (`src/runtime/adapter.ts`), typed `unknown`
because each runtime's shape is its own.

`createCodexAdapter` checks its `windowsSandbox` option at construction,
`unelevated` when none is given, and for each launch uses
`launchSandbox(plan.runtimeOptions)` when it names one and its own
otherwise. `launchSandbox` returns `null` for an absent entry or one
without `windowsSandbox`, and throws for an entry that is not an object,
holds another key or names a value Codex lacks. The command is built
before the launch is appended, so a refused entry launches and records
nothing. The Claude Code adapter ignores the field.
`ReviewOptions.runtimes` stays a `RuntimeRegistry`, as before this
change (TD3).

### The platform a run is built for (R1 to R3)

`ReviewOptions.platform`, this process's by default, decides whether a
new run pins a sandbox, answers every question `pinnedWindowsSandbox`
is asked, and, passed to `runWorker` as `platform`, becomes
`LaunchPlan.platform`, from which the adapter builds the worker's
command and environment and the launcher its `workerEnvironment`. The
spawn and the kill stay this process's (TD4).

### One reading of the pinned value (R3, R5, R6, R12)

`pinnedWindowsSandbox(configuration, platform)` in `policy.ts` is the
recorded value on `win32` and `null` elsewhere. Every question the
engine asks about how a run's workers are confined goes through it:
`editorsUnderUnelevatedSandbox`, a fix run whose value there is
`unelevated`; the surveyor's `elevatedSandbox` in `src/review/phases.ts`;
and the resume's check of the flag (TD6).

### Confinement and the command line (R2)

`confinementOf` in `src/runtime/codex.ts` is every value's meaning in
one place. From the worker's access, the plan's platform and scratch
directory and the sandbox, it gives what `codexCommand` writes as
`sandbox_mode`, `sandbox_workspace_write.writable_roots` and
`windows.sandbox`:

| Platform and value | Reader | Editor |
|---|---|---|
| not Windows, any value | `read-only`, no `windows.sandbox` | `workspace-write`, the scratch directory writable, no `windows.sandbox` |
| Windows, `unelevated` or `elevated` | `read-only`, `windows.sandbox` the value | `workspace-write`, the scratch directory writable, `windows.sandbox` the value |
| Windows, `none` | `read-only`, `windows.sandbox="unelevated"` | `danger-full-access`, no writable root, `windows.sandbox="unelevated"` (TD7) |

The same holds for a fresh worker and a continued one.

### The worker's environment (R4, R11)

`codexEnvironment(environment, platform, windowsSandbox)` copies the
caller's environment unchanged off Windows. On Windows it gathers every
spelling of `PATH`, splits each on `;`, drops empty entries and every
directory under `WindowsApps`, and writes the rest as one variable
spelled `PATH`, every other spelling removed, under every value (TD8).
Under `elevated` only, it then pins `PSExecutionPolicyPreference`: the
caller's own value when a spelling holds a non-empty one, the first such
spelling by code unit, else `RemoteSigned`, written in that one spelling
with every other removed (TD9). The helpers that find and remove
spellings are those of `src/runtime/environment.ts`.

### Warning and the editors' fragment (R5, R6)

After configuration, on the first invocation and on every resume,
`runReview` computes `editorsUnderUnelevatedSandbox` once and, when it
holds, logs `unelevatedEditorsWarning(runId)` before any worker starts:
what the editors cannot run, that the sandbox is pinned, the `deep-review
abandon` command, and the two other values. The same value reaches
`PhaseContext.unelevatedEditors`, from which `src/review/phases.ts` gives
each editing unit `unelevatedSandbox`; `fixerTask` and `repairTask` in
`src/review/tasks.ts` add `unelevatedSandboxRule` when it holds, and no
other task carries it. The rule is task text, not a role fragment, so no
file under `roles/` and no role's hash changes (D7).

### The surveyor's lookup (R12)

`shellOf(platform, elevatedSandbox)` in `src/review/tasks.ts` names the
lookup the surveyor's task gives: `command -v` off Windows, `where.exe`
on Windows, and under `elevated` `elevatedLookup`, `Get-Command
-CommandType Application <tool>` through `powershell.exe -NoProfile`,
then the same with `.\<tool>` when that fails. Nothing else in the task
changes, so every other run's surveyor task is as before.

### Report (R7)

`renderReport` in `src/review/report.ts` adds `Codex Windows sandbox:`
after the runtime line when the configuration's `codex` is not null. Its
words are keyed by the ledger's type, not the adapter's vocabulary
(TD11), and `none` says what it means for each kind of worker.

### Comments, README and skill (R8, R9)

The comments on `windowsSandbox` in `src/runtime/codex.ts`, on the
snapshot command in `src/review/snapshot.ts` and `src/cli.ts`, and the
README's fix pass section state the corrected cause. The README
documents the flag, the policy key and its shipped value, and what each
value needs and gives up. The Codex skill (`skill/codex/SKILL.md`) tells
the user before a fix run on Windows that the editing workers run with
no sandbox and the network unless the user names another value, and
passes the flag only when the user names one.

## Technical Decisions

- **TD1: The value is a new version of `review.configured`, over a
  frozen copy of the values.** A field added to version 3 would edit a
  recorded event's schema, which the ledger rule in `AGENTS.md` forbids.
  The values are copied into the event's schema rather than imported
  from the adapter, as the review vocabulary is, so a later change to
  the adapter's values is a new version of the event; the test that
  holds the copy equal to the adapter's values fails first.
- **TD2: A Codex run configured before version 4 folds by its recorded
  worktree.** (Recorded 2026-10-04 under Verification.)
  The fold cannot tell the platform a run was on, so a Codex run
  configured at version 3 or earlier reads as `unelevated` on any
  platform, as R3 says. The warning, the fragment and, since TD10's
  amendment, the resume's check of the flag ask the platform too,
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
  keep `elevated`. (Amended 2026-10-05, after review.) The first
  sentence of this item was wrong: `run.created` records the worktree
  resolved, rooted at `/` on macOS and Linux and at a drive letter or a
  UNC share on Windows, so the fold does read the platform from it (R3).
  A Codex run configured at version 3 or earlier off Windows folds to
  `null`, and its report names no Windows sandbox in its header; the
  accepted case of a report naming `unelevated` for a run made on macOS
  or Linux no longer arises. A relative worktree, which only a library
  caller could record, is read as Windows, the platform where a wrong
  `null` would drop a sandbox the run had.
- **TD3: The run's pin travels with every launch, and the runtimes stay
  a registry.** (Recorded 2026-10-04 under Verification.)
  The controller takes a function that builds the runtimes rather than
  a registry: it builds one with no option for the adapter that
  resolves the policy, preflights the executable and reads usage, none
  of which the sandbox changes, and one with the run's pinned value for
  the workers, so a resume launches on what the run pinned however the
  command was invoked. (Amended 2026-10-05, after review.) That choice
  is reversed. A function that took no argument still type-checked, and
  its Codex workers ran under the adapter's default `unelevated` while
  the ledger, the report and the warning named the pinned value; nothing
  in the engine could tell. `ReviewOptions.runtimes` is a
  `RuntimeRegistry` again, as before this change, and the controller
  passes what the run pinned to every launch instead: `runWorker` takes
  a `pinned` option, a `PinnedRuntimeOptions` keyed by runtime name, and
  hands each adapter its own entry as `LaunchPlan.runtimeOptions`. The
  Codex adapter applies a pinned `windowsSandbox` over the one it was
  built with and refuses an entry it does not understand before the
  worker runs, so the sandbox the ledger names is the one every worker
  runs under whatever registry the caller passes. The accepted cost: the
  sandbox now has two binding times, the adapter's construction default
  for a caller that launches workers itself and the run's pin for a
  review, and the plan carries a value only its own adapter reads. The
  provider and the Claude Code settings stay construction options, since
  the ledger records neither.
- **TD4: The run's platform builds every worker; the host spawns it.**
  (Recorded 2026-10-04 under Verification.)
  `review` takes a `platform` option, the process's by default, so the
  suite exercises the Windows cases on every runner of CI. (Amended
  2026-10-05.) The launcher builds each worker's command and environment
  for that platform too, through a `platform` option of `runWorker`, so
  the sandbox a run pins and the one its workers are confined by are
  decided by one value; before, a run configured for Linux on a Windows
  host pinned no sandbox but launched its Codex workers under
  `windows.sandbox="unelevated"`. The spawn and the kill stay the host's.
- **TD5: A review's Codex-only settings are keyed by the Codex
  runtime's name.**
  (Added 2026-10-05, after review.) TD2 of the runtime adapter design
  (R10 of its requirements) says nothing outside an adapter's module
  branches on a runtime's name. This change makes one exception: a
  review's Codex-only settings are keyed by the Codex runtime's name,
  `codexRuntimeName`. The policy file requires a `windowsSandbox` on the
  `codex` entry and refuses one on any other, `--codex-windows-sandbox`
  is refused with any other runtime, `resolvePolicy` pins a sandbox only
  for Codex, the controller passes the pin under the `codex` key, and
  `review.configured@4` accepts a `codex` field other than `null` only
  from a Codex run, while the fold tells a Codex run configured before
  version 4 by the same name. The reasons: R1 and R3 name Codex in each
  of those places, and the frozen ledger schema and its fold cannot
  consult an adapter, since a newer engine must read an old ledger
  whatever adapters it registers, so they spell `'codex'` as a literal.
  Giving adapters a Windows sandbox capability for the policy and the
  flag to ask was rejected: it adds a library-facing surface for a
  setting one adapter has, under names that are Codex's anyway, and the
  ledger's literal would stay. A third runtime is still one module and
  one registration, and touches none of these. `src/runtime/registry.ts`
  states the exception.
- **TD6: One helper reads the pinned value, with the platform.** A run
  configured on Windows may be resumed elsewhere, where no Windows
  sandbox applies, so every question about confinement asks
  `pinnedWindowsSandbox` and none reads `configuration.codex` alone.
  The warning and the fragment share one value computed once per
  invocation, so the two cannot disagree. Handing the tasks the raw
  value was rejected: it would put `confinementOf`'s mapping in a third
  place, and the surveyor, a reader, would be told `none` while it runs
  sandboxed.
- **TD7: An unsandboxed editor has no writable root and keeps
  `windows.sandbox="unelevated"`.** (Recorded 2026-10-04 under
  Verification.)
  Under `none` an editor gets no `sandbox_workspace_write.writable_roots`,
  which has no meaning outside `workspace-write`, and the command keeps
  `windows.sandbox="unelevated"`, as the probe that ran
  `danger-full-access` had it.
- **TD8: The search path is spelled `PATH` and loses `WindowsApps`
  under every value.** Codex's elevated runner adds a `PATH` of its
  own, so any other spelling gave the worker two (R11);
  Windows reads the name in any case, so the one spelling changes
  nothing where no runner adds one. The `WindowsApps` directories are
  dropped for an editor that `none` runs in no sandbox too, though it
  could launch what they hold, so that every worker of a run has one
  search path and one shell; the requirements' Risks record what that
  costs.
- **TD9: The execution policy reaches the worker in one spelling, and
  an empty value counts as unset.** (Recorded 2026-10-04 under
  Verification.)
  An empty `PSExecutionPolicyPreference` is taken as unset and replaced,
  since an empty value sets no policy. (Amended 2026-10-05.) The worker
  gets the variable in one spelling only: when the caller's environment
  holds several, the first by code unit that has a value is kept and
  the others removed. Node hands a Windows child only the spelling that
  sorts first, so an empty `PSExecutionPolicyPreference` beside a
  `psexecutionpolicypreference=AllSigned` had reached the worker as the
  empty one, with no policy pinned.
- **TD10: A resume where the run pins no sandbox names the flag as
  ignored.** (Recorded 2026-10-04 under Verification.)
  A resume that passes the flag to a run that pinned none, because it was
  configured off Windows, says the flag is ignored rather than refusing
  it, as a new run off Windows does. (Amended 2026-10-05.) So does a
  resume off Windows of any run, whatever it pinned: no sandbox applies
  there, so a flag naming another value than the pinned one is named as
  ignored, not refused, as R1 has it for a new run.
- **TD11: The report renders from the ledger's type.** The header's
  words are keyed by the values `review.configured@4` records, not by
  the adapter's `windowsSandboxes`, so a report of a recorded run says
  what the ledger holds whatever the adapter later accepts.

## Test Strategy

Unit and integration tests under `node:test`, with the fake Codex the
suite already scripts workers with, then the gate by hand.

- R1: the command line's usage names the flag, and it refuses the flag
  with Claude Code, a value Codex lacks, an empty value and the flag on
  `status` (`test/cli.test.ts`); the policy file is refused when its
  `codex` entry names no value, another entry names one, or a value is
  unknown, and the committed policy ships `none` on the `codex` entry
  alone; `resolvePolicy` gives the policy's value on Windows, the
  flag's over it, and none for another platform or runtime
  (`test/review/policy.test.ts`).
- R2: the adapter's command line and environment for every value,
  access and platform, fresh and continued, scratch directory given or
  not; a pinned value wins over the adapter's own, the adapter's own
  stands when the plan pins none, and an entry it does not understand
  is refused (`test/runtime/codex.test.ts`); the launcher hands each
  adapter its own entry by name and nothing an object inherits, launches
  a Codex worker under the pin over the adapter's own, launches nothing
  when the adapter refuses its entry, and builds the command and
  environment for the platform it is given
  (`test/runtime/launcher.test.ts`).
- R1 to R3 through the controller with the fake Codex
  (`test/review/codex-sandbox.test.ts`): the value pinned from the flag
  and from the policy and every worker launched with it, also over
  runtimes the caller built with another; `null` off Windows and on
  Claude Code; a resume naming another value refused by name, the same
  or none accepted; the flag named as ignored on a resume off Windows
  and of a run that pinned none; a version 3 Codex run from a Windows
  worktree resumed under `unelevated`, which runs on Windows only; the
  worker's command built for the run's platform whatever the host.
- R3 in the ledger: the event takes one of the three values for a Codex
  run and refuses one on another runtime, and its values equal the adapter's
  (`test/review/policy.test.ts`); the fold reads version 4 as recorded
  and an earlier Codex run as `unelevated` when its worktree has a drive
  letter or is a UNC share, and as `null` when rooted at `/` or on Claude
  Code (`test/checkpoint/review-fold.test.ts`); the golden test opens
  every fixture to `schema-1-07` and holds each older fixture's run to
  that rule (`test/checkpoint/golden.test.ts`).
- R4, R11: under `elevated` the execution policy is `RemoteSigned` for
  readers and editors, a caller's own value is kept in any spelling, an
  empty one is replaced, one spelling survives whichever sorts first,
  and nothing is set under the other values or off Windows; every
  spelling of `PATH` the caller holds becomes one `PATH`, and
  `WindowsApps` is dropped under `none` too
  (`test/runtime/codex.test.ts`).
- R5, R6: in a whole fix run under `unelevated`, the warning before the
  first worker and again on each resume, the fragment in the fixer's and
  the repair worker's prompts and in no reader's, and the warning's
  advice followable: the flag alone is refused and an abandoned run's
  successor runs the build; neither warning nor fragment under
  `elevated`, under `none` named or by default, for Codex on another
  platform, for Claude Code, or in a read-only run under `unelevated`
  (`test/review/codex-sandbox.test.ts`); a fixer's and a repair
  worker's task with the fragment differs from one without it by that
  paragraph alone (`test/review/tasks.test.ts`).
- R7: the report's line for each value, its absence for a run that pins
  none, and for a version 3 Codex run only when its worktree is on
  Windows (`test/review/report.test.ts`).
- R12: the elevated surveyor's task differs from every other only in
  the lookup, which names `.\<tool>` too (`test/review/tasks.test.ts`);
  through a run, an elevated surveyor gets `Get-Command` and a `none` or
  `unelevated` one `where.exe` (`test/review/codex-sandbox.test.ts`).
- The Codex skill's disclosure is pinned by `test/skills.test.ts`.
- R10: the gate by hand, recorded under Verification.
- `npm run check` and `npm run verify`.

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
  (Amended 2026-10-05.) Since the fold reads the platform from the
  worktree (R3), that sixth run, recorded at `/fixture/unsurveyed`,
  folds to `null`, and so does the same run in `schema-1-07`, which was
  regenerated with nothing else changed; the golden test asserts
  `unelevated` of an older fixture's Codex run only when its worktree is
  not rooted at `/`, and the fold's own tests hold the Windows shapes.
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
  its absence (R7). (Amended 2026-10-05, after review.) Since the
  runtimes are a registry again (see TD3), the suite proves instead that every worker is launched with the pinned
  value, including over runtimes the caller built with another, and
  that the Codex adapter refuses a pinned value it does not understand.

The departures and choices the proposal did not state, listed here
until the split on 2026-10-05, are now Technical Decisions TD2 to TD5,
TD7, TD9 and TD10, each with its dates.

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
`codex sandbox` probes in Context; no `codex exec` run has used them
yet.

## Risks & Migration

- Migration: a policy file under another `--roles` directory whose
  `codex` entry names no `windowsSandbox` is refused until the key is
  added, for a Claude Code run too, since the file is validated whole.
  `roles/policy.json` carries it. Accepted: the package is private and
  at version 0.0.0, only a new run reads the policy file, and a default
  for a missing key would be a second default beside the adapter's own.
- Migration: none for existing checkpoints. Versions 1 to 3 of
  `review.configured` stay registered and fold as TD2 says, and the
  fixtures `schema-1-01` to `schema-1-06` open and fold under the new
  engine. The one run that resumes otherwise than it ran is a Codex run
  on Windows that a library caller started on an adapter built with
  `elevated`: it resumes under `unelevated`, and is abandoned and
  started again to keep `elevated` (TD2).
- Migration: a library caller passes `runReview` the same
  `RuntimeRegistry` it passed before this change (TD3), and a caller of
  `runWorker` that pins nothing launches as before. An adapter of its
  own receives `LaunchPlan.runtimeOptions` and may ignore it, as Claude
  Code's does.
- Risk: a caller that launches Codex workers itself, with no run's pin,
  gets the adapter's default `unelevated`, not the policy's `none`.
  Accepted as the requirements' Non-Goals state it; the two binding
  times are TD3's accepted cost.
