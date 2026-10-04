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

- No change of default in this change. The default is decided after the
  gate (D4).
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
  shipped as `unelevated`. With `--runtime claude` the flag is refused. On
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
  unsandboxed editor the environment is as today.
- R5: When a fix run's value is `unelevated`, `review` prints one warning
  before the first worker starts: editors cannot run tools that start
  processes through Node, which includes most build and test commands,
  and the two other values of the flag. The warning is printed again on
  each resume of such a run.
- R6: In the same case the fixer's and the repair worker's task carries
  one fragment saying that a Node process here cannot start a child whose
  output it captures, so the build, the tests and package scripts fail
  with `EPERM`; that a fix is validated by what does run (a direct `node`
  probe, a test file run in one process) and recorded as `limited` with
  that reason otherwise; and that the engine runs the checks afterwards.
  In every other case the task does not carry it, and the prompts of
  those runs keep their hashes.
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
  commands.

- **D4: The shipped default stays `unelevated` in this change and is
  decided after the gate.** The author's position on 2026-10-04: the
  default should become `elevated` or `none`, since a default under which
  the build cannot run serves no fix run, and the elevated setup is not
  on every machine, so `elevated` alone cannot be assumed. What the gate
  must show before the choice: whether zod's toolchain runs under
  `elevated` (R10), and what `codex exec` does under `elevated` on a
  machine without the setup (fail, or fall back to `unelevated` as the
  documentation says the interactive client does). A default of `none`
  would make an unsandboxed editor the shipped behavior, which reverses
  the opt-in of D3 and needs its own decision then.

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

## Risks

- Risk: an unsandboxed editor that reads hostile text in the change under
  review has a shell and the network. Accepted for a run that asks for
  `none`; this is the exposure a Claude Code editor already has, the
  README names it, and the drift check sees writes to the worktree only.
  Not yet accepted as a default (D4).
- Risk: a tool that asks who the user is fails under `elevated`
  (`os.userInfo()` throws). Not accepted blindly: R10's run on zod shows
  whether pnpm, vitest or esbuild do; a failure there is recorded and
  weighs on D4.
- Risk: the sandbox user cannot read a package store or a tool installed
  under the operator's profile on some machine. Accepted; the README says
  what must be readable, and the failure names the path.
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

No checks have run yet.
