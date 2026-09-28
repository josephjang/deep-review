# Technical Design: Read-only review

Product part: [2026-09-27-read-only-review.requirements.md](2026-09-27-read-only-review.requirements.md).

## Summary

A command-line entry point, `deep-review`, opens the checkpoint of the
repository it is run in, creates or resumes a run, and drives a fixed
sequence of phases through one controller loop: fold the ledger, compute
the next step from the state alone, execute it (launch workers, record
their answers), append what happened, repeat until the report is written
or the run blocks. One pure planner over the folded state gives the next
step of whichever phase is running, and one phases module turns a planned
unit into a `runWorker` invocation and its receipt into an event; the
planner is what makes a resumed run continue exactly where the ledger
stops. Roles get their tasks as a prompt composed from the assembled role
prompt, a scope block and the phase's inputs, and their answers are
validated by a zod schema per role, with candidate ids assigned by the
engine. Fifteen new event kinds record the pinned policy, the limits in
force, each phase's progress, every worker's contribution and the report;
the fold exposes them as `RunState.review`. The build gains an esbuild step that bundles the
command into each artifact beside a copy of `roles/`, and the engine's
identity becomes the bundle's hash.

## Non-Goals

- No streaming of worker output; progress is one line per phase and per
  worker on stderr.
- No editing of the reviewed tree by anything in this element, engine or
  worker; every invocation is `access: 'read-only'`.
- No continuation of any session; `resume` is never set on an invocation.
- No change to the runtime adapters' command lines or decoders, except
  one added method, `summarizeUsage`, and one capability flag it needs.
- No change to scope capture or to the evidence store's format; one
  accessor is added to the store so a prompt can name a blob's path.
- No plugin or skill mechanics beyond what the skeleton set up: the same
  marketplace, the same Codex directory copy, the same two skill files.

## Context

Verified at `33741db` of this repository.

- `Checkpoint` (`src/checkpoint/checkpoint.ts`) opens `ledger.sqlite` and
  the evidence store under `<git-common-dir>/deep-review-checkpoint/`,
  creates runs, folds one run or lists all, and appends events with an
  expected last sequence, throwing `StaleRevisionError` on a race. Events
  carry `kind`, `version`, `payload`, the engine string given at open, and
  a recorded time. `defineModel` refuses a registry and a reducer set that
  do not cover each other exactly, and the golden test fails when the DDL
  or the registry changes without a new fixture
  (`test/fixtures/checkpoints/schema-1-01` to `-03`).
- `RunState` (`src/checkpoint/fold.ts`) has `id`, `worktree`, `createdAt`,
  `engine`, `status: 'active' | 'abandoned'`, `abandonReason`, `scope`,
  `workers` by id (each `running` or `finished` with its launch and
  finish) and `lastSequence`.
- `captureScope(checkpoint, runId, request)` (`src/scope/capture.ts`)
  appends `scope.captured@1`: mode, request, base, head, up to 2000 files
  with frozen before and after states (blobs under 8 MiB, hash and size
  above) and the patch as a blob. `compareWorktree(scope, worktree)`
  (`src/scope/compare.ts`) answers per file `unchanged`, `modified`,
  `deleted` or `restored`.
- `runWorker(checkpoint, runId, invocation, options)`
  (`src/runtime/launcher.ts`) runs one worker to its end and returns a
  `WorkerReceipt`: outcome `completed | budget | timeout | failed`, error,
  process facts, runtime name and version, session ids, raw usage, denials
  and the validated `output`, with every byte as evidence. It appends
  `worker.launched@1` before the spawn and `worker.finished@1` after,
  whatever happened, and kills the worker's tree at the timeout and when
  the engine exits or is interrupted. An answer the output schema rejects
  is a `failed` outcome. The invocation names runtime, absolute
  executable, `executableArgs`, model, effort, access, shell, prompt,
  `outputSchema` (zod, compiled to closed draft-07), `timeoutMs` up to one
  hour, optional `budgetUsd` up to 100, optional `scratch`, `label` and
  `resume`.
- Capabilities (`src/runtime/claude.ts:373`, `src/runtime/codex.ts:451`):
  Claude Code assigns session ids, caps budget, gives denial evidence,
  can withhold the shell, allows a read-only scratch directory and takes
  efforts `low` to `max`; Codex does none of the first five and takes
  `low` to `xhigh`. The launcher refuses by name an invocation that asks
  for a capability the runtime lacks, so a `budgetUsd` on a Codex
  invocation is refused, not ignored.
- Usage is kept as the runtime reported it. Claude's decoder stores
  `{ usage, modelUsage, total_cost_usd }` from the envelope; Codex's stores
  the `usage` of the last `turn.completed`. The runtime adapter's Open
  Questions record why the two are unlike and name the target: a pure
  `summarizeUsage` per adapter over `JSON.parse(finish.usage)`.
- `assembleRoles(rolesRoot)` (`src/roles/assemble.ts`) returns every role's
  prompt text and SHA-256 from `roles/manifest.json` and
  `roles/fragments/`, refusing a malformed fragment by name;
  `repositoryRolesRoot()` resolves `roles/` relative to the source file.
  Twenty-one roles are declared; this element runs fourteen of them:
  `triage` (which is the `SCAN` worker, so `finder-SCAN` is not run on
  its own), the nine other `finder-*`, `deduplication`, `verifier`,
  `sweep` and `merge-rank`.
- The build (`src/build/artifacts.ts`, `scripts/build.ts`) copies
  `skill/claude` to `dist/claude` and `skill/codex` to `dist/codex` byte
  for byte through a staging directory, and `--verify` digests both trees
  and reports differences. The Claude artifact is a plugin with
  `.claude-plugin/plugin.json` and `skills/deep-review/SKILL.md`; the
  Codex artifact is `SKILL.md` and `agents/openai.yaml`.
- `engineVersion()` (`src/engine.ts`) reads `package.json` beside the
  sources and says the bundling element must supply the version another
  way. The version is `0.0.0`.
- The proof of concept's controller (`agent-skills`,
  `packages/deep-review-driver` 0.3.5): candidates carried `locations[]`
  with an `anchor` that had to be a substring of the line; the controller
  validated every location against the change and rejected bug candidates
  at test paths; verifier groups were one per file, chunked at 8; a
  verifier retried once, then its candidates became `PLAUSIBLE`
  `unverified`; merge-rank returned severity `critical | major | minor`;
  `concurrency` defaulted to 4 (1 to 16); every worker had 8 USD and 600 s.
  Its skill told the model to poll `full run --wait-ms 30000`.

## Design

### Command line (R1, R13)

`src/cli.ts` is the entry point of the bundle and of `npm run review`
during development. It uses `node:util`'s `parseArgs` with `strict: true`
and three subcommands.

```
deep-review review  --runtime claude|codex [--executable <path>] [--executable-arg <arg>]...
                    [--strong-model <m>] [--fast-model <m>]
                    [--last-commit | --worktree | --ref <ref> | --from <rev> --to <rev> [--merge-base]]
                    [--path <p>]... [--concurrency 1..16] [--budget-usd <n>]
                    [--repo <dir>] [--roles <dir>]
deep-review status  [--run <id>] [--json] [--repo <dir>]
deep-review abandon --reason <text> [--run <id>] [--repo <dir>]
```

- `--repo` defaults to the current directory; `locateCheckpoint` finds
  the worktree and the checkpoint from it.
- Exactly one scope mode. `--last-commit` is `{ ref: 'HEAD~1' }` on a
  clean tree as the scope element defines it; `--worktree` is
  `{ paths }`; `--ref` and `--from/--to` map to `ScopeRequest` directly.
  The scope element's own validation refuses the rest (a `to` that is
  not HEAD, an unmerged path).
- `--executable` is optional. The command's executable, the flag's path
  made absolute or, when the flag is absent, the runtime's command name
  (`claude`, `codex`) resolved on `PATH`, is resolved once, and only for
  a run not yet configured: its absolute path is recorded on the
  configuration event and never resolved again (TD10 of the runtime
  adapter is kept: the launch records what runs, the resolution happens
  once before it). A resumed configured run neither resolves nor refuses
  the command's executable, `--executable` included, and preflights the
  one it pinned; its refusal names the pinned path and the run, and says
  to make that path qualify again or abandon the run, never to pass
  `--executable`. An executable a spawn without a shell cannot start is
  refused with a message naming the flag: a `.cmd` or `.bat` shim on
  every platform, and on Windows anything but a `.exe` or `.com` (a
  `.ps1`, `.vbs` or `.js` file, or a file without an extension), which
  Node 26 refuses to spawn there (runtime adapter, Verification).
- `review` prints progress to stderr, one line per phase start and end
  and per worker start and end (role, angle or group, outcome, seconds,
  cost when known), and on success prints the report's absolute path as
  the last line of stdout. Exit code 0 on a report; 2 on a blocked run
  (with the blocker and its action on stderr) and on every refusal, with
  or without a blocker code (a held lock, an unqualified runtime, two
  active runs, a run pinned to another runtime or active in another
  worktree, roles that no longer digest as pinned); 1 on a usage error
  and on any other error.
- `status` prints the fold of the active run or `--run`: its status
  (with the reason of an abandoned run), worktree, runtime, version and
  models, the phase it is in with its attempt, how many workers are
  running, finished and lost, the spend and tokens against the run
  budget in force, what the budget check counts when that differs from
  the reported spend (Retries, budget and blockers), the blocker and its
  action, and the report path if written. `--json` prints one object
  holding the same facts (run id, status, worktree, phase, worker counts,
  the statistics per phase and in total, the budget check, blocker,
  report path) and the whole `RunState.review`, whose
  units and unverified groups are nested by phase.
- `abandon` appends `run.abandoned@1` under the checkpoint's start lock
  and the run lock (below), after folding the run again under them. A
  run that is complete or already abandoned is refused as a usage error:
  the ledger never closes a review run whose report is written, so the
  event would be accepted and would misstate the run's outcome for good.
  A running engine holds the run lock, so an abandon during a run is
  refused with "engine <pid> is running run <id>", or "another engine"
  when the lock's side file names no pid (step 2 of the lifecycle).

The command that a skill runs is the bundle: `node <artifact>/engine/main.mjs review ...`.

### Run lifecycle and resumption (R1, R10)

`src/review/controller.ts` exports `runReview(options)` where the options
hold the checkpoint, the worktree, the runtime registry and the runtime's
name, the executable (a path, or the function that resolves one), the
roles root, the flags and the scope source: whether the command named a
scope, and the request, resolved only when a capture happens.

1. **Find or create the run, under the start lock.**
   `<checkpoint>/start.lock`, taken like a run lock (step 2), covers
   finding the run, creating one and taking its run lock, so two engines
   started together cannot both find no run and create one each;
   `abandon` takes it too. `checkpoint.listRuns()` filtered to
   `status === 'active'` and no report. More than one: refuse, naming the
   ids; the operator abandons all but one. One created in another
   worktree of the repository (paths compared resolved, and without case
   on Windows): refuse, naming its worktree; the operator runs the
   command there or abandons the run. One: take its run lock (step 2) and
   resume it, refusing when its pinned runtime differs from `--runtime`
   (the operator abandons or drops the flag); a configured run is held
   to what it pinned (Policy, below). Zero: resolve the policy
   and the command's executable and preflight it, then create a run and
   take its lock, so a refusal creates nothing. A run with no scope yet,
   new or left by a capture that failed, captures the scope the command
   names, resolved before a new run is created so a refused request
   creates nothing; a run that has one ignores the command's scope flags,
   and the log says so. A run not yet configured then appends
   `review.configured@1`. A blocked run is active and is resumed; its
   blocker is cleared by the next `phase.started`.
2. **Take the run lock.** `<checkpoint>/runs/<runId>.lock` is an empty
   SQLite database that the engine opens and holds inside
   `BEGIN EXCLUSIVE` for as long as it runs the run, taken without
   waiting (TD6). A lock another connection holds, in another process or
   in this one, refuses the command at once with the `lock-held` blocker,
   naming the holder's pid from the side file `<lock>.pid`, or "another
   engine" when that file is missing or names no pid. The side file is
   written after the take and removed before the release, so it is best
   effort: absent for an instant after a take, and stale after a hard
   kill until the next holder writes its own. The lock file itself is
   never deleted, since a holder's lock lives on the file it opened, and
   a file there that is no SQLite database, such as the pid file an
   older engine left, is refused with its path and no blocker code. A
   found run's lock is taken before its preflight, so an engine running
   it refuses this one at once. The found run is folded again once its
   lock is held, since the engine that held the lock may have appended
   after the find; a run no longer resumable is released and a new run
   is created. The operating system drops the lock when the holding
   process ends, however it ends; the engine also releases it, removing
   the side file, rolling back and closing, at most once, on every way
   out: the controller's own release, the process's exit, and a signal
   that would end the engine (`SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT` on
   POSIX; `SIGINT`, `SIGBREAK`, `SIGHUP` on Windows), whose listener
   releases the lock and exits with 128 and the signal's number, since
   Node runs no exit listener for a death by signal. Two engines on one
   run is the hazard: `StaleRevisionError` protects each append, but two
   controllers would both dispatch the same step.
3. **Record the limits and the lost workers, and re-enter the phase.**
   The concurrency and run budget this invocation puts in force are
   appended as `limits.changed@1` when they differ from the run's (Policy,
   below). Every worker in `running` state at resume died with the
   previous engine or was orphaned by a hard kill; the controller appends
   `worker.lost@1` for each, naming the phase and unit key its launch
   label names, and the fold marks the worker lost and counts it as a
   failed attempt of that unit, a failure marked `lost` (TD5). A phase
   left running or blocked is then re-entered with `phase.started@1` at
   the next attempt.
4. **Loop.** `step = nextStep(review, live)` (pure, `src/review/steps.ts`,
   over the latest fold, `live` being the units in flight and the spend
   so far); execute the step; append its events with `state.lastSequence`
   as the expected sequence, once, the append returning the state folded
   anew; repeat. The
   append is never retried: while it holds the run lock the controller
   is the run's one writer (another engine and `abandon` take the lock
   first, and the launchers of the workers in flight append only while
   the controller awaits them, after which it folds afresh), so a
   `StaleRevisionError` means another writer broke in, and it is thrown.
   The steps are, in order of precedence:
   - `blocked`: return with the blocker.
   - `complete`: the report is written; return its path.
   - `start-phase`: when no phase is running, append `phase.started@1`
     for the next pending phase with attempt = previous attempt + 1.
   - `check-worktree`, once per attempt of the running phase, the report
     phase included: compare the scope files with their frozen after
     states (`compareScopeFiles`) and append `worktree.checked@1`, drifted
     or not, alone.
   - `finish-phase` blocked with code `drift`, when the attempt has a
     drifted check, found at its start or before an answer was recorded
     (below): once no worker is in flight, else `await`. Nothing more is
     launched in a drifted attempt.
   - `plan-verification`: a verification phase appends its
     `verification.planned@1` once.
   - `write-report`, in the report phase: render, `evidence.put`, append
     `report.written@1` and the report phase's `phase.finished@1`
     together.
   - `degrade`: append `angle.failed@1` or `group.unverified@1` for each
     unit of a degrading role that has used its two attempts, none of
     them a lost worker.
   - `finish-phase` blocked with code `worker-failed`, once the workers
     in flight have settled, when a unit of a blocking role has used its
     two attempts, or a unit of any role has used them with a lost worker
     among its failures.
   - `launch`: the phase's units not yet answered, not degraded, with an
     attempt left and no worker in flight, up to `concurrency - running`
     of them. Before each launch the budget check runs (below).
   - `await`: wait for any running worker and record what it gave. A
     completed answer is first held to the tree: the controller compares
     the scope files with their frozen after states again, and on a
     difference appends one drifted `worktree.checked@1` for the attempt,
     unless the attempt already has one, and sets the answer aside,
     neither recorded nor counted as a failure; every later answer of the
     attempt is set aside the same way. A completed answer on an
     undrifted tree is recorded as the unit's contribution, or as a
     failed attempt when a structural check refuses it; any other
     receipt is recorded as a failed attempt (Recording a contribution).
   - `finish-phase`: when every unit is answered or degraded, append
     `phase.finished@1` with outcome `completed`, or `degraded` when
     some unit degraded.

   The controller keeps the workers in flight in a map and awaits the
   first to settle, one at a time, so each receipt is recorded before the
   next launch decision, which keeps the budget check exact to the
   receipts seen; a worker's promise never rejects, so a launcher error
   surfaces when it is awaited, never as an unhandled rejection. Every
   way out of the loop, a launcher error or a failed append included,
   first waits for the workers still in flight and records their answers,
   and only then releases the lock. A runtime that stops qualifying
   mid-run, found by a worker's own preflight, is refused as
   `runtime-unqualified`, as it is at startup.

Resumption is the loop itself: the planner sees the answered units on the
state and plans only the rest. A unit with one failed attempt gets its
retry; a unit with two gets its degradation or blocks, and blocks when a
lost worker is among the two. A unit whose answer was set aside after a
drift has neither an answer nor a failure for it, so the re-entered phase
launches it again without using an attempt. Nothing is recomputed from
evidence; every fact the planner needs is an event.

### Policy (R3)

`roles/policy.json`, validated by `src/review/policy.ts`:

```json
{
  "schemaVersion": 1,
  "roles": {
    "triage":              { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-REMOVALS":     { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-DESIGN":       { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-ALTITUDE":     { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-RIPPLE":       { "tier": "fast",   "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-FOOTGUNS":     { "tier": "fast",   "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-WRAPPERS":     { "tier": "fast",   "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-EFFICIENCY":   { "tier": "fast",   "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-DUPLICATION":  { "tier": "fast",   "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "finder-CONVENTIONS":  { "tier": "fast",   "effort": "medium", "budgetUsd": 8, "timeoutMs": 600000 },
    "deduplication":       { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "verifier":            { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "sweep":               { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 },
    "merge-rank":          { "tier": "strong", "effort": "high",   "budgetUsd": 8, "timeoutMs": 600000 }
  },
  "runtimes": {
    "claude": { "strong": "opus",        "fast": "sonnet",        "runBudgetUsd": 30 },
    "codex":  { "strong": "gpt-6-astra", "fast": "gpt-5.6-terra", "runBudgetUsd": null }
  },
  "concurrency": 4
}
```

- The file must name exactly the roles this element runs, no more and no
  fewer; a role in the manifest that the policy does not name is not run
  by this element, and a policy role the manifest lacks is refused. The
  values are the proof of concept's (role prompts, D6). Efforts are
  checked against the runtime's `effortLevels` at resolution, so a policy
  value a runtime lacks is refused before any run exists.
- Resolution: `resolvePolicy(policy, roles, adapter, flags)` gives the
  policy part of the pinned configuration: runtime, models
  `{ strong, fast }` from flags else the runtime's defaults, per-role
  `{ model, effort, budgetUsd, timeoutMs }` with `budgetUsd` set to null
  when the runtime lacks `budgetCap` (the launcher would refuse it), the
  concurrency and the run budget (flag, else the runtime's default, else
  null), and the roles digest: SHA-256 over the sorted `roleKey:sha256`
  lines of `assembleRoles`, so a run says which prompts it ran. The
  controller adds the executable, the `executableArgs` given by
  `--executable-arg` (empty by default) and the version the preflight
  observed.
- `review.configured@1` holds the resolved configuration verbatim. A
  resumed configured run reads it from the fold and never reads the
  policy file. It is refused, naming both digests, when its roles no
  longer digest as pinned (the operator runs it with `--roles` naming the
  roles it started with, or abandons it); it preflights its pinned
  executable, not the command's; and the model flags, which do not apply
  to it, are logged as ignored. `--concurrency` and `--budget-usd` are
  per invocation, checked on every invocation by the one rule the
  command line and the policy use (`invocationFlagProblem`): raising the
  budget is how a `budget` blocker is cleared and lowering the
  concurrency is how a machine is spared, so each flag when given, else
  the pinned value, is in force for the invocation. When the limits in
  force differ from the run's, they are appended as
  `limits.changed@1 { concurrency, runBudgetUsd }`, and the planner,
  `status` and the report read the limits in force from the fold, so the
  report records the value in force at the end.

### Prompts (R7)

`src/review/prompts.ts` composes each worker's prompt as the assembled role
prompt, one blank line, then a `## Task` section, so the role text the
prompts element verified is unchanged and the task follows it. The launcher
appends its scratch note after.

The **scope block** is the same in every prompt of a run:

- `Repository: <worktree>`, `Base: <commit>`, `Head: <commit>`,
  `Mode: <mode>`.
- A table of changed files: path, status (`added`, `modified`,
  `deleted`), and for each the frozen before state as `before: <path of
  blob>` (or `none`, or `oversized <sha256> <size>`) and `after: read the
  file in the worktree` (or `deleted`).
- The patch, inline in a fenced block when its blob is at most 256 KiB
  (TD3), else `Patch: <path of blob>`.
- The convention files that govern the change (R12): the engine lists
  the paths that exist among `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  and `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at the repository root
  and in each ancestor directory of a changed file. The `CONVENTIONS`
  fragment already says the worker verifies the list itself.

Blob paths come from a new `EvidenceStore.pathOf(reference)` (absolute
path of the blob). Read-only workers can read the checkpoint; the runtime
adapter's read-only mode restricts writing, not reading.

The **task text per role** (`src/review/tasks.ts`), each ending with the
sentence "Return only the JSON your schema describes", so the prompt's
prose and the schema agree (R4):

| Role | Task inputs | Task text says |
|---|---|---|
| triage | scope | run `SCAN` over every hunk and its enclosing function; return candidates, and for each of the nine other angles one lead (a file, symbol or mechanism to inspect) or `null`, never a skip |
| finder-`<ANGLE>` | scope, the angle, `lead` and its source (`SCAN` or `none`) | run the angle; check the lead first; return candidates |
| deduplication | scope, candidates numbered `[0]`.. with id, file, line, summary and detail | group candidates that describe the same defect at the same location for the same reason; name the member to keep per group; a candidate in no group stands alone |
| verifier | scope, the group's candidates numbered `[0]`.. with the angle each came from and the `outside the change` or `unlocated` mark | one verdict per index with one evidence line, by the rubric of the candidate's angle; an answer that misses an index is discarded whole and the group is run again |
| sweep | scope, the verified list (id, location, summary, verdict), the refuted list (id, location, summary, evidence) | find gaps only; return candidates each with the angle whose territory it sits in |
| merge-rank | scope, the working list with verdicts | fold same-root-cause findings across locations; give each finding a severity, a `CONVENTIONS` violation taking the severity of the rule it breaks; the engine orders them (TD9), and the order returned is not kept |

Candidates are numbered by the engine in the input and referred to by
index in the answer (dedup members, verdicts), so no worker copies ids
back and a wrong id cannot be returned.

### Output schemas and validation (R4, R8)

`src/review/schemas.ts`, zod, every object strict and every field
required (`.nullable()` where a value may be absent), as
`compileOutputSchema` demands:

- `candidateSchema`: `{ file, line (int ≥ 1), summary (1..400 chars),
  detail (1..2000 chars) }`. `detail` is the fourth field of the finder
  output contract (`failure_scenario` or `value_statement`); one name in
  the schema because the angle decides which it is, and the prompt says
  so. The `sweep` candidate adds `angle` (enum of the ten).
- `triageOutput`: `{ candidates: candidateSchema[] (≤ 12), leads: [{ angle
  (enum of the nine), lead: string | null }] (exactly 9, one per angle) }`.
- `finderOutput`: `{ candidates: candidateSchema[] (≤ 12) }`;
  `sweepOutput` the same with `angle` per candidate.
- `deduplicationOutput`: `{ groups: [{ members: int[] (≥ 2), keep: int,
  reason }] }`.
- `verifierOutput`: `{ verdicts: [{ index: int, verdict: 'CONFIRMED' |
  'PLAUSIBLE' | 'REFUTED', evidence (1..1000 chars) }] }`.
- `mergeRankOutput`: `{ findings: [{ primary: int, members: int[],
  severity: 'critical' | 'major' | 'minor', summary, reason }] }`.

The launcher validates the answer against the schema; the engine then
applies **structural checks** the schema cannot express, and a failure is
treated exactly like a schema rejection (the attempt is `failed` for the
retry rule, with the reason on the ledger in the phase's record): triage
leads cover the nine angles once each; dedup indexes exist, no index is in
two groups, `keep` is a member; each verifier index appears exactly once
and every index of the group has a verdict, so an answer that misses one
is refused whole and none of its verdicts is recorded, as the verifier's
prompt (`phase2-verify.md`) and task say; merge-rank indexes exist and
every index of the working list is a primary or a member exactly once.

**Ids** are assigned by the engine: `SCAN-<n>`, `<ANGLE>-<n>`, `SWEEP-<n>`
in the worker's discovery order, numbered from 1 per angle. A retried
finder numbers from 1 again; only the answer that is recorded has ids.

**Locations** (`src/review/locations.ts`): `normalizeLocations(scope,
worktree, candidates)` gives a candidate `{ file, line, located: true,
inScope }` when `matchRepositoryPath` finds one canonical path of the
repository for its `file` and `line` is at most that file's line count.
The canonical path is a changed path of the scope (`inScope: true`) or
an unchanged file of the worktree in the worktree's own spelling
(`inScope: false`, "outside the change"). The file is normalized as a
scope path is spelled (backslashes turned to slashes, runs of slashes
and a leading `./` removed), and its repository-relative tails, after
any root or drive and after the last `.` or `..` segment, are tried
longest first: a tail that is a scope path matches it, so an absolute or
otherwise prefixed spelling of a changed file is found; a tail that is
not a scope path but names an entry the worktree holds, compared without
case, matches that unchanged entry, and no shorter tail is tried, so
`src/index.ts` is never pinned to a changed root `index.ts`. Failing
both, a file that is itself the bare tail of exactly one scope path
(`a.ts` for `src/a.ts`) matches it. Each comparison is exact first,
then without case, and a name that matches two paths without case, and
neither exactly, matches nothing: two scope paths, or two entries of a
case-sensitive worktree that differ only in case. Lines are counted in
the worktree. For a changed file the controller's drift check, run just
before it records the answer, found the worktree equal to the frozen
after state (an oversized file is frozen as hash and size only, so the
worktree is the one place its lines can be counted); an unchanged file,
which the scope froze nothing of and no drift check covers, is read as
the worktree holds it, in chunks, and a link is counted by its target
text, as the scope freezes a link. A candidate that matches nothing, or
matches a directory, a file the change deletes (which has no after
state) or a file with fewer lines, keeps its raw `file` and `line` as
`rawFile` and `rawLine`, with `located: false` and `inScope: false`,
and the report says why.

### Phases (R2, R5)

The planner, `src/review/steps.ts`, and one module for every phase's
work, `src/review/phases.ts`, carry the phases. `unitsOf(review, phase)`
lists a phase's units in the order they launch; `invocationFor(unit,
context)` builds a unit's invocation from its role's pinned policy and
prompt, its task and the scope block; and `contributionOf(unit, receipt,
state, worktree)` turns its receipt into the one event the ledger
records, a contribution or a failed attempt, each contribution's kind
and payload built together as a typed pair so the two cannot disagree. A
unit is `{ phase, key, role }`, where the key is the angle for a finder,
the group id for a verifier, `SCAN` for the triage and the phase's own
name for the other phases with one worker. A unit's attempts are counted
from the fold, which keeps every unit by phase and then by key with the
worker whose contribution is recorded and the failures before it: each
`attempt.failed` names the unit's phase and key, and so does each
`worker.lost` whose launch label names a unit. The launch label is the
role key (D10 of the role prompts), a space and the unit:
`<role> <phase>:<key>`, such as `finder-RIPPLE finders:RIPPLE` or
`verifier verification:g3`, which is free text on the ledger. The
controller parses it to name a lost worker's unit, and `spend.ts` to
count a worker toward its phase.

| Phase | Units | Role | Degradation after two failures |
|---|---|---|---|
| triage | one | `triage` | blocks (`worker-failed`) |
| finders | nine, one per angle | `finder-<ANGLE>` | `angle.failed@1`; the angle is "not run" in the report; the sweep is told |
| deduplication | one, only when ≥ 2 candidates | `deduplication` | blocks |
| verification | one per group | `verifier` | `group.unverified@1`; its candidates carry `PLAUSIBLE` with `unverified` |
| sweep | one | `sweep` | blocks |
| sweep-deduplication | one, only when the sweep returned ≥ 2 candidates | `deduplication` | blocks |
| sweep-verification | one per group, only when the sweep returned ≥ 1 | `verifier` | as verification |
| merge-rank | one, only when the working list is non-empty | `merge-rank` | blocks |
| report | none (engine) | | |

A phase with no unit (an empty sweep, an empty working list) is started,
checked against the worktree and finished with outcome `completed`, three
appends and no worker (a verification phase with no group also records
its empty plan), so the ledger shows it ran. When merge-rank has nothing
to rank, the report's Findings section says no finding survived
verification and lists the refuted ones.

**Grouping for verification** (`src/review/grouping.ts`, pure): take the
working list (every candidate not dropped as a dedup duplicate) and group
located candidates by their canonical repository path, in the change
or outside it, and unlocated ones by their `file`
normalized as a scope path is spelled and folded to lower case, an
absolute spelling joining the longest relative spelling given for it
that it ends with (so `C:\repo\src\a.ts` and `src/a.ts` share a
verifier, while two absolute spellings of one file that no relative one
names stay two groups); sort each group by line, then by id; split a
group of more than 8 into as few consecutive chunks as the cap of 8
allows, balanced so their lengths differ by at most one (9 gives 5 and 4,
17 gives 6, 6 and 5), so no chunk holds more than 8, nor a single
candidate when its group had more. Group ids are `g<n>` in file order,
located files first. The plan is recorded once per verification phase as
`verification.planned@1`, so a later engine with a different grouping rule
still resumes the plan this run made.

**Recording a contribution.** For a `completed` receipt whose structural
checks pass: the triage, the finders and the sweep append
`candidates.recorded@1` (and the triage its `leads`); dedup appends
`deduplication.recorded@1`; a verifier appends `verdicts.recorded@1`;
merge-rank appends `ranking.recorded@1`. For any other receipt the phase
appends `attempt.failed@1` naming the unit, the worker and the reason
(outcome and error, or the structural check that failed). That event, and
a lost worker, is what the fold counts against the unit, each failure
marked whether it was a lost worker. A completed answer that settles
after the worktree drifted is set aside before any of this (Run
lifecycle, `await`), and appends nothing for its unit.

**Verdict resolution.** After the verification phases, each candidate of
the working list has one verdict: the recorded one, or `PLAUSIBLE` marked
`unverified` when its group is unverified. `REFUTED` candidates leave the
working list and enter the refuted list with their evidence. The sweep's
candidates join the working list after their own verification, and the
merge-rank input is the union. A merged finding's verdict is `CONFIRMED`
when any member is, else `PLAUSIBLE`; its `unverified` mark is set when
every member is unverified.

**Ranking.** The engine orders the recorded findings by severity
(`critical`, `major`, `minor`), then verdict (`CONFIRMED` before
`PLAUSIBLE`), then the correctness angles, `CONVENTIONS` included, before
the design angles (the rubric's cross-class tiebreak), then by primary id. The worker's order is
advisory; the recorded order is the engine's, so two engines render the
same report from the same ledger.

### Retries, budget and blockers (R5, R6)

- **Retry rule.** A unit is launched while it has no recorded
  contribution, no recorded degradation and fewer than 2 failures, each
  an `attempt.failed` event or a lost worker. The retry is a fresh
  invocation with the same task. A unit out of attempts degrades by its
  role only when none of its failures is a lost worker; with a loss among
  them it blocks the phase with `worker-failed` whatever its role, since
  nothing observed it failing. A blocked phase re-entered gives its units
  fresh attempts, but an angle recorded as not run or a group marked
  unverified stays settled and is never launched again. An answer set
  aside after a drift is no failure, so its unit's next launch uses no
  attempt.
- **Budget check.** Before each launch, `budgetSpendOf`
  (`src/review/spend.ts`) counts the run's spend: every cost a finished
  worker reported (`summarizeUsage(finish).costUsd`), and for a finished
  worker whose process started but that reported no cost (a timeout, a
  failure before the runtime printed its usage) the `budgetUsd` its
  `worker.launched` recorded, the most the runtime let it spend. A worker
  lost with its engine is counted apart and not charged, since nothing
  observed what it spent and charging it would block the resume after
  every Ctrl-C; a worker whose process never started spent nothing. If
  the runtime's `costInUsd` capability is false the check is skipped and
  the report says the run budget did not apply. If a run budget is in
  force (`review.limits`) and the counted spend has reached it, the
  phase finishes `blocked` with code `budget`, detail "spent 31.20 USD of
  the 30.00 USD run budget", followed, when the check counted more than
  the reported costs, by the workers it charged at their caps and the
  lost ones it left out ("counting 2 workers that reported no cost at
  their per-worker caps; 1 worker lost with an earlier engine is not
  counted"), and the action "run the command again with --budget-usd
  above 31.20, or abandon the run". The report's totals still sum
  reported costs alone, so `status` prints a `Budget check:` line
  beside the spend when the two differ, and its JSON carries the check as
  `budgetCheck`. Workers already running finish and are recorded.
- **Blockers** are `{ code, detail, action }` on `phase.finished@1`, the
  codes being an enum the report and `status` print with their actions:

  | Code | Raised when | Operator action |
  |---|---|---|
  | `worker-failed` | a blocking role's unit failed twice, or any unit's two failures include a lost worker | run again (two fresh attempts), or abandon |
  | `budget` | spend reached the run budget | run again with a higher `--budget-usd`, or abandon |
  | `drift` | the worktree differs from the scope | restore the named files and run again, or abandon and start a new run |
  | `lock-held` | another engine holds the run lock or the start lock | wait for that engine to finish; the lock clears itself when its process ends |
  | `runtime-unqualified` | the preflight refused the executable | for a new run, fix the installation or pass `--executable`, then run again; for a configured run, which ignores `--executable`, make the pinned executable qualify again and run again, or abandon and start a new run |

  `lock-held` and `runtime-unqualified` are refusals, printed and never
  recorded: before any event, or, for a runtime that stops qualifying
  mid-run, once the workers in flight are recorded. The other three are
  on the ledger. A test
  enumerates the codes and asserts each has an action string and each
  survives `status --json` (plan principle 1).

### Usage summary (R6)

`RuntimeAdapter` gains `summarizeUsage(usage: unknown): UsageSummary`
and the capability `costInUsd: boolean`:

```ts
interface UsageSummary {
  readonly costUsd: number | null;
  readonly inputTokens: number | null;     // including cached
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
}
```

- Claude: `costUsd = total_cost_usd`; `inputTokens = usage.input_tokens +
  usage.cache_read_input_tokens + usage.cache_creation_input_tokens`;
  `cachedInputTokens = usage.cache_read_input_tokens`; `outputTokens =
  usage.output_tokens`. Since no session is continued here,
  `total_cost_usd` is this worker's (the whole-session question of the
  Open Questions is not reached). `costInUsd: true`.
- Codex: `costUsd = null`; `inputTokens = input_tokens` (which includes
  cached), `cachedInputTokens = cached_input_tokens`, `outputTokens =
  output_tokens`. `costInUsd: false`.
- Any missing or non-numeric field gives `null` for that number, never a
  throw; the decoders already keep the raw text on the finish, so a
  summary can be recomputed by a later engine.

`src/review/spend.ts` sums summaries over `RunState.workers` and per
phase for the report, with the phase of a worker read from its launch
label. A phase's seconds, and the run's, are wall time: the length of
the union of its workers' process intervals, so workers that ran at once
count once. `costUnreported` counts the workers whose cost the sums
leave out: finished without a reported cost after their process started
(a timeout, a failure before the runtime printed its usage), or lost
with their engine. A worker whose process never started spent nothing
and is not counted; on a runtime without `costInUsd` the count is null.
The budget check reads the same workers through `budgetSpendOf`, which
charges each finished one of them at its launch's per-worker budget and
counts the lost ones apart (Retries, budget and blockers).

### Ledger events and fold (R10)

New kinds, all version 1, in `src/checkpoint/events.ts`, each with a
reducer in `src/checkpoint/review-fold.ts`, which `src/checkpoint/fold.ts`
registers beside the run's own (`worker.lost`'s reducer is in `fold.ts`
itself, since it changes a worker); the fixture `schema-1-04` is
committed with them. Payloads are strict; free text fields are bounded,
a failed attempt's reason, an angle's or a group's reason and a
blocker's detail at 4000 characters, one frozen cap the engine cuts the
text it composes to. The v1 schemas write out the review vocabulary they
record (the angles, phases, outcomes, blocker codes, verdicts and
severities, the spellings of candidate ids, group ids and unit keys, and
the count of leads) instead of importing it from
`src/review/vocabulary.ts`, so a later change there cannot change what a
v1 event means; a test holds the two equal, so such a change fails until
the events that carry the changed words get a new version.

| Kind | Payload | Reducer effect on `state.review` |
|---|---|---|
| `review.configured` | runtime, executable, executableArgs, version (preflight), models, roles (per role: model, effort, budgetUsd, timeoutMs), rolesDigest, concurrency, runBudgetUsd | creates `review` with the configuration, whose concurrency and run budget are the first limits in force; twice, or before the scope, is invalid history |
| `limits.changed` | concurrency, runBudgetUsd | replaces the limits in force; invalid after the report |
| `phase.started` | phase (enum), attempt | phase status `running`; clears `blocker`; attempt must be previous + 1; invalid after the phase completed or degraded, or while an earlier phase has not; a blocked phase re-entered forgets its units' failures |
| `phase.finished` | phase, attempt, outcome (`completed`, `degraded`, `blocked`), blocker `{ code, detail, action }` or null | phase status; sets `blocker` when blocked; invalid without a matching start |
| `worktree.checked` | phase, attempt, drifted, files `[{ path, outcome }]` (only the not-unchanged ones) | appended to `checks`; the phase must be running at that attempt |
| `candidates.recorded` | phase (`triage`, `finders`, `sweep`), key (`SCAN`, the angle, `sweep`), workerId, candidates `[{ id, angle, file, line, located, inScope, rawFile, rawLine, summary, detail }]` (the schema refuses `inScope` on an unlocated candidate), leads `[{ angle, lead }]` or null (triage only) | candidates by id; leads; marks the unit answered; invalid when a located candidate's `inScope` disagrees with whether the scope holds its `file` |
| `attempt.failed` | phase, key, workerId, reason | one more failure of the unit, not lost |
| `angle.failed` | angle, reason | angle marked not run |
| `deduplication.recorded` | phase, workerId, groups `[{ members: ids, keep: id, reason }]` | duplicates leave the working list |
| `verification.planned` | phase, groups `[{ id, candidateIds }]` | the plan the units come from |
| `verdicts.recorded` | phase, groupId, workerId, verdicts `[{ id, verdict, evidence }]` | verdicts by candidate id |
| `group.unverified` | phase, groupId, reason | its candidates `PLAUSIBLE` + `unverified` |
| `ranking.recorded` | workerId, findings `[{ id (primary), members, severity, summary, reason }]` | the ranked list |
| `report.written` | report (artifact reference), statistics (per phase and in total: workers, wall seconds, costUsd or null, costUnreported or null, input, cached input and output tokens or null; budgetApplied) | `report`; the run is complete |
| `worker.lost` | workerId, phase and key (both, from the launch label, or neither), reason | the worker's state becomes `lost`; a unit it names counts one more failure, marked lost, so the unit blocks rather than degrades when its attempts run out |

`RunState` gains `review: ReviewState | null` with: `configuration`,
`limits` (the concurrency and run budget in force), `phases` (per phase:
status `pending | running | completed | degraded | blocked`, attempt),
`blocker` (with its phase), `checks`, `leads`, `candidates` (by id, with
angle, phase, worker, location, and its resolution: `duplicateOf`,
`verdict`, `unverified`), `units` (by phase, then by unit key: the worker
that answered, and the failures, each with its worker, its reason and
whether the worker was lost), `anglesNotRun`, `deduplications` (per
deduplication phase), `plans` (per verification phase),
`unverifiedGroups` (by verification phase, then by group id, with the
reason), `ranking`, `report`. `WorkerState` gains the variant
`{ status: 'lost'; launch; launchedAt; reason }`. The status line
`active | blocked | complete | abandoned` is derived: `blocked` when
`blocker !== null`, `complete` when `report !== null` (`reviewStatus`;
`RunState.status` itself stays two-valued, see Verification).

The three existing fixtures must fold with `review: null` and `workers`
untouched, which is the forward-compatibility proof the AGENTS.md rule
asks for; the new fixture holds one run through every kind, including a
blocked phase, a lost worker and a degraded angle.

### Report (R9)

`src/review/report.ts` exports `renderReport(state, { engine, statistics
}): string`, pure over the fold and the statistics `spend.ts` gives,
and the controller stores it with `evidence.put` and appends
`report.written@1`. Sections as R9 lists them; the header names the
engine identity, the runtime and version, the models, the policy digest
and the run id; the Angles section prints the ten angles in the fixed
order with `run` or `not run (<reason>)` and the lead `SCAN` gave; each
finding prints as

```
### 1. [critical] CONFIRMED  RIPPLE-2 (also FOOTGUNS-1)  src/a.ts:120
<summary>
Evidence: <verifier's line>
```

with `(outside the change)` or `(unlocated: <raw file>:<raw line>)`, and
`(unverified)`, where they apply. Statistics is one table with a row per phase and a total, each
cost cell naming how many workers' cost went unreported. Limitations
lists the angles not run and the unverified groups (in plan order),
every drift check's outcome, the run budget in force at the end or why
none applied, how many workers reported no cost (so the run cost more
than the totals show), the oversized files no worker could be given
frozen, the candidates on files outside the change (which no worktree
check covers), and the unlocated candidates by why they are unlocated:
on a path the repository does not hold or a line past the end of an
unchanged file, on a file the change deletes, on a line past the end of
a changed file, or on a path that ends with a changed path and could
name either that changed file or an unchanged path, neither with such a
line, which the ledger alone cannot tell apart. Text a
worker or a finder wrote goes through `inlineText` or `paragraphText`
(`src/review/markdown.ts`), so no summary, reason, evidence or file name
can change the report's structure.
The renderer is tested against a snapshot of a synthetic state, and the
snapshot is read by a person once, in review.

### Build, bundle and skills (R11)

- `esbuild` becomes a development dependency, pinned. `src/build/bundle.ts`
  calls its API: entry `src/cli.ts`, `bundle: true`, `platform: 'node'`,
  `format: 'esm'`, `target: 'node26'`, builtins external, `zod` bundled,
  `minify: false`, `sourcemap: false`, `legalComments: 'none'`, to
  `<staging>/<name>/engine/main.mjs`. Then `engine/engine.json` is
  written: `{ "version": <package.json version>, "sha256": <hash of
  main.mjs> }`, and `roles/` is copied to `engine/roles/` through the
  same tree copy the artifacts use (which refuses a symlink).
- `artifactTargets` keep their source copy; `assembleArtifact` gains the
  bundle step, so `dist/claude/engine/` and `dist/codex/engine/` exist
  and `--verify` compares them byte for byte with the rest. Determinism
  rests on esbuild being deterministic for one version and one input
  tree; the lock file pins the version and CI on three platforms proves
  the bytes agree (TD8).
- `src/engine.ts`: `engineIdentity()` returns `<version>+<sha256 first 12>`
  when an `engine.json` sits beside the running module (the bundle), and
  `<version>+dev` when running from the sources. Every event's `engine`
  string is this identity, which is what the skeleton's D5 promised.
- `rolesRoot` for the command is `engine/roles` beside the bundle, or the
  repository's `roles/` in development; `assembleRoles` already takes the
  root. The controller refuses to start when `assembleRoles` throws,
  before any run exists.
- `skill/claude/skills/deep-review/SKILL.md` keeps
  `disable-model-invocation: true` and says: decide the scope from what
  the user asked (default `--worktree` when the tree is dirty, else
  `--last-commit`); run `node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs"
  review --runtime claude <scope flags>` as a background shell command
  and wait for it to exit, without polling the ledger or reading the
  checkpoint; on exit 0 show the user the report path from the last stdout
  line and nothing else about the findings; on exit 2 show the blocker
  and its action verbatim; on any other exit show stderr. Never review
  the change another way under this skill's name.
- `skill/codex/SKILL.md` says the same with the path relative to the
  skill directory (`engine/main.mjs` beside `SKILL.md`), `--runtime
  codex`, and the note that `--budget-usd` does not apply to Codex.
  `agents/openai.yaml` keeps `allow_implicit_invocation: false` and its
  description drops "engine not shipped yet". `plugin.json`'s description
  drops the skeleton sentence. README's Installing and Developing
  sections gain the `review` command and the `npm run review` script.

### Prompt fragments (PD14, R12)

Two text commits, separate from the code:

1. **Narration rewrite.** `phase1-finders.md`, `phase2-verify.md`,
   `phase3-sweep.md` and `phase4-list.md` are cut to what a worker of this
   pipeline needs: the phases in order, what each returns, what the finder
   output contract is and that the engine assigns ids, the verifier
   grouping and the unverified rule, the sweep's purpose, the merge and
   rank rule. Gone: `angle-decision`, run/skip, `triage.md`,
   `candidates.md`, `verdicts.md`, `sweep.md`, `ranked.md`, "Step 1",
   "Step 3", the dispatch instructions, the `Driver lead` label. The
   `angle-decision` role leaves the manifest; the roles this element does
   not run (`fixer`, `documentation`, `test-assessment`, `auditor`,
   `answer`) keep their fragments unchanged, and `postreview-fix-test.md`,
   which `merge-rank` names, is dropped from `merge-rank` only, since it
   describes the fix pass. The tests that pin manifest order and the
   narration list (`test/roles/repository.test.ts`) move with the text.
2. **`CONVENTIONS` wording.** `angles-conventions.md`, `rubrics.md`
   (the `CONVENTIONS` rubric) and `phase3-sweep.md` name `CLAUDE.md`,
   `CLAUDE.local.md` and `AGENTS.md`, at `~/.claude/CLAUDE.md` and
   `~/.codex/AGENTS.md`, the repository root and ancestor directories.
   The example in `angles-conventions.md` stays.

Each commit records the roles' new hashes in this document's
Verification.

## Technical Decisions

- **TD1: The planner is pure over the fold and the controller is a loop
  of fold, plan, execute, append.** Alternatives: a state machine with
  its own persisted cursor (a second source of truth beside the ledger,
  which is what the proof of concept's obligations table was), or a
  controller that keeps in-memory progress and writes events as a log
  (a resumed run could not trust the log to be complete). With the planner
  reading only state, a resumed run and a running run take the same code
  path, and every resume test is a fold test.
- **TD2: Units and attempts are counted from events, not stored as
  counters.** A counter event (`attempt 2 of 2`) would have to be kept
  consistent with the worker events; counting `attempt.failed` and
  contribution events per unit needs no such invariant, and a lost worker
  is one more `attempt.failed`-equivalent, marked lost.
- **TD3: The patch is inline under 256 KiB and by path above.** The cap
  keeps a small change's prompt self-contained (the common case: a pull
  request of a few hundred lines is well under it) and a large one from
  filling every worker's context. The runtime adapter freezes each
  worker's prompt whole, whatever its size, and every prompt differs in
  its task, so a run stores the inline patch once per worker: about 8 to
  11 MB of evidence per run at the 256 KiB cap with 30 to 40 workers,
  and 1 to 2 MB for a typical change. Nothing prunes the evidence store
  yet (see Risks). Lowering the cap was rejected as unmeasured, freezing
  the scope block once and naming its path as a worse common case (every
  worker would have to read a file), and deduplicating the stored
  prompts because it would change the evidence store's format, which
  this element leaves alone. The frozen before states are always by
  path, since a worker reads them only when the diff does not show
  enough.
- **TD4: Indexes in, ids out.** Workers refer to candidates by the index
  the engine numbered them with in the prompt, and the engine assigns and
  keeps ids. A worker that returned ids could return one that does not
  exist or belongs to another group; an index is checked structurally.
- **TD5: A lost worker is recorded, not repaired.** The resuming engine
  cannot know whether an orphaned process still runs; it records the
  worker lost with the reason "the engine exited while the worker ran"
  and counts it as a failed attempt, marked lost, so retries stay
  bounded. Because nothing observed the worker failing, a unit whose
  attempts run out with a lost worker among them blocks its phase with
  `worker-failed` instead of degrading, whatever its role, and the rerun
  gives it fresh attempts: an interruption costs time, never an angle or
  a group. Appending a `worker.finished` for it was rejected: that event
  says what a process did, and nothing observed it. For the same reason
  the launcher refuses to continue a session that holds a lost worker,
  since an orphan may still write to it.
- **TD6: One run lock per run, held as an exclusive SQLite
  transaction.** SQLite serializes appends and `StaleRevisionError`
  catches a race, but two controllers would still both plan the same
  step and launch it twice before either append fails. Each lock is an
  empty SQLite file (`src/review/lock.ts`) that its holder keeps open
  inside `BEGIN EXCLUSIVE` for its lifetime. SQLite takes the operating
  system's file locks for that, so a second holder is refused whether it
  is another process or another connection in the same one, and the
  lock frees itself when the holder ends, even by a hard kill; this was
  probed on Windows before it was built (a second connection and a
  second process get `SQLITE_BUSY`, and a killed holder frees the lock).
  The ledger already depends on the same locking. A file holding a pid,
  checked with `process.kill(pid, 0)` and taken over when the pid looked
  dead, was the first design and was rejected after review: the
  takeover (read, remove, create) was not atomic, so two engines could
  both take a stale lock; a release removed whatever file was there,
  even another engine's; a reused pid looked alive; and a file holding
  no pid needed a grace period to tell a crash from a write in progress.
  Taking over by renaming to a unique name was rejected as complex and
  still racy among three engines. The price: the pid in a refusal is best
  effort, read from a side file, and one empty lock file stays per run
  and per checkpoint (the start lock), which nothing may delete while an
  engine could run. The start lock is the same kind of file at the
  checkpoint root, held while a run is found or created, because two
  engines that both find no run would otherwise create one each.
- **TD7: The verification plan is an event.** Grouping could be recomputed
  from the candidates at every fold, but a later engine with a different
  chunking rule would then plan different groups for a run in progress
  and re-verify answered candidates or orphan recorded verdicts.
- **TD8: One bundle per artifact, unminified, with a sidecar identity.**
  Injecting the bundle's own hash into itself is circular; the sidecar
  holds it and the runtime reads the sidecar beside the module. Unminified
  so that a stack trace from a user's machine reads against the sources
  and the diff of a rebuilt bundle is reviewable. One bundle copied twice
  rather than shared, because the two artifacts are installed by different
  mechanisms to different places.
- **TD9: The engine assigns severity order and the worker proposes
  severity.** The rubric's tiebreak (correctness before design at equal
  confidence) is a rule, and rules the engine can apply deterministically
  are applied by the engine; the model contributes what needs judgment,
  the severity and the merge.
- **TD10: `costInUsd` is a capability, not an inference from a null
  cost.** A Claude worker that failed before printing an envelope also
  has a null cost, and the check must not read that as "this runtime
  reports no cost". The capability says what the runtime can report; a
  null on one worker is a worker fact.
- **TD11: Convention files are listed by the engine and verified by the
  worker.** The engine knows the changed paths and the home directory,
  and listing the files that exist saves each `CONVENTIONS` worker a
  search; the fragment already tells the worker to verify the list, so a
  file the engine missed is still found.

## Open Questions

- Resolved 2026-09-29: the change the gate reviews (R14, PD15) is
  colinhacks/zod #6530; the criteria, the candidates and the reasons are
  in Verification. Criteria: a merged pull
  request of 200 to 800 changed lines in a widely used repository that
  Node and git can clone without credentials, touching more than one
  file, with at least one deletion or replacement (so `REMOVALS` has
  material) and a rules file (`CLAUDE.md` or `AGENTS.md`) at its root.
  Candidates are listed for the author before the run and the chosen one
  is recorded in Verification with the reasons.
- Open: the default run budget for Claude (30 USD in the policy) and the
  per-role timeouts (600 s, the proof of concept's, which its pilot D5
  first set too low at 180 s). The gate's two runs are the first
  measurement; the policy file is changed by a later commit when they
  say so. Measured 2026-09-29 (Verification): the Claude gate run spent
  13.27 USD and its longest worker ran 328 s, the Codex run's 310 s, so
  neither limit was approached and the policy is unchanged.
- Open, carried: whether `--max-budget-usd` on a Claude continuation
  counts the whole session (runtime adapter). Nothing here continues a
  session, so the question stays with the element that first does.
- Open: a token price for Codex, so that a Codex run can have a budget.
  Until one exists the report shows tokens and says the budget did not
  apply.
- Deferred: whether angle skipping returns as a cost measure, decided on
  the gate's cost per angle.
- Deferred: the `.cmd` shim case for a Claude Code installed through npm
  on Windows. For a new run the command refuses the shim, and on Windows
  anything but a `.exe` or `.com`, and names `--executable` with
  `--executable-arg`, which gives the runtime adapter's `executableArgs`
  for a caller that spawns the shim's target through `node`; a resumed
  run keeps the executable it pinned. The skill text can say how once a
  user hits it.

## Test Strategy

Fakes: `test/helpers/fake-claude.ts` and `test/helpers/fake-codex.ts` as
they are, plus a scripted mode in which the fake reads the role key from
the prompt's first line (every role prompt opens with a sentence that
names its role; the fake matches on the label the engine also puts on the
launch) and answers from a per-role script the test writes to a file named
by `FAKE_SCRIPT`, with per-unit outcomes (answer, malformed answer, exit
nonzero, hang past the timeout, exit after N ms). Every case runs on the
three CI runners.

- Policy (R3): the committed file resolves for both runtimes; a role the
  manifest lacks, a manifest role the policy lacks, an effort a runtime
  lacks and a malformed file are refused by name; `budgetUsd` is null for
  a runtime without `budgetCap`; flags override models and the run
  budget; the digest changes when a fragment changes.
- Schemas (R4): each compiles through `compileOutputSchema`; each
  structural check refuses its violation (a missing lead angle, a dedup
  index in two groups, a verdict index twice or missing, a merge that
  drops an index) and the refusal is recorded as `attempt.failed` with the
  reason.
- Locations (R8): tails tried longest first, with forward and backward
  slashes and an absolute prefix; a path naming an unchanged file of the
  worktree, in any case or an absolute spelling, located on that file in
  the worktree's spelling, outside the change, with its line checked,
  and never pinned to a changed path it ends with; the bare-tail rule;
  ambiguity without case matching neither, among scope paths or among
  entries of a case-sensitive worktree; a line past the end; a deleted
  file; a directory and a missing path; an oversized file measured from
  the worktree and a file counted across read chunks; every failure
  yields `located: false` and keeps the candidate.
- Grouping: by canonical repository path, sorted by line, the absolute,
  relative and other-case spellings of one unchanged file together; balanced chunks of at most 8
  for every length from 0 to 100, 9 giving 5 and 4; an invalid chunk size
  refused; the spellings of one unlocated file, in slashes, `./`, case or
  an absolute path, grouped together; ids stable.
- Planner (R1, R2, R5): synthetic folds for every step in the precedence
  order, including: nothing done; a phase running with two units answered
  of nine; a unit with one failure (retry planned); a unit with two
  failures on a degrading role (degradation event planned) and on a
  blocking role (block planned); a blocked run (returns the blocker); a
  lost worker counted, and a unit of a degrading role blocking instead
  when a lost worker is among its two failures, awaiting the workers in
  flight first; a drifted check awaiting the workers in flight, then
  blocking; the budget blocker naming the workers charged at their caps
  and the lost ones left out; every phase with no unit (started, checked
  and finished with no worker).
- Controller through the fakes (R1, R2, R5, R6, R7): a full review on
  each fake runtime reaches a report with the expected worker count and
  phase order; killing the engine after the third finder answers and
  running again launches exactly the six remaining finders and no
  earlier role; a finder that fails twice produces `angle.failed` and a
  report naming it, and the sweep prompt names the angle; a verifier
  group that fails twice produces `group.unverified` and `PLAUSIBLE`
  `unverified` findings; the triage failing twice blocks with
  `worker-failed`, and running again retries it and completes; a Claude
  fake reporting `total_cost_usd` that crosses the run budget blocks with
  `budget`, and running again with a higher `--budget-usd` completes;
  a timeout that reported no cost is charged at its 8 USD cap and blocks
  an 8 USD budget; a Codex fake reaches a report with the budget marked
  inapplicable; a file edited between phases blocks with `drift` naming
  the file, and restoring it and running again completes; a file edited
  while a phase's workers run records one drifted check for the attempt,
  sets aside the answers that settle after it, blocks once the workers
  in flight settle, and once the file is restored relaunches the
  set-aside units without using an attempt; the run lock refuses a second
  holder, in the same process or in another, and frees when a holder
  process is killed outright, and a lock file that is no SQLite database
  is refused and left alone; `abandon` during a run is refused.
- Events and fold (R10): every reducer's invalid histories (configured
  twice, finished without start, attempt out of order, a contribution for
  a unit twice, a verdict for an unknown candidate); the three old
  fixtures fold with `review: null`; `schema-1-04` folds to its recorded
  state; the golden test refuses the registry change without it.
- Usage (R6): `summarizeUsage` on the recorded usage of the runtime
  adapter's smoke receipts (checked in as fixtures from the Verification
  tables' runs), on a missing field and on non-JSON; the per-phase and
  total spend of a synthetic fold.
- Report (R9): a snapshot of a synthetic state exercising every section
  and mark; the rendered order follows the ranking rule; an empty
  findings list renders the refuted appendix.
- Blockers: the enumeration test of codes, actions and their survival
  through `status --json`.
- Command line: each scope flag maps to the scope element's request; two
  scope modes are refused; `--executable` a shim is refused;
  `--concurrency 0` and `17` are refused; exit codes 0, 1 and 2.
- Build (R11): `npm run build` in a temporary copy produces
  `engine/main.mjs`, `engine/engine.json` with the file's hash and
  `engine/roles/`; building twice gives identical bytes; the built
  `main.mjs` runs `status` in a temporary repository and reports no run;
  `engineIdentity()` reads the sidecar; `npm run verify` reports a
  changed bundle.
- Prompt fragments (PD14, R12): the wording guard and the narration pins
  updated to the rewritten text; a test that no prompt of a role this
  element runs names `angle-decision`, a checkpoint file or a step of the
  fix pass; a test that the `CONVENTIONS` fragment and rubric name the
  three files.
- Skills: the two skill texts name the bundle path and the exit codes,
  checked by a test that reads them (they are product bytes; the test
  pins what the engine's contract needs them to say).
- R14: the gate, by hand, on both runtimes, recorded in Verification with
  the repository, the change, worker counts, seconds, cost and tokens per
  phase, finding counts per verdict, and the author's reading of the two
  reports.

## Verification

Run on the author's Windows 11 machine on 2026-09-28, Node 26.10.0, over
the eleven commits that build the element after the proposal (`25ff51d`),
from `d0642fd` to `dadc928`, and the fix commit `0973112` after the
first documentation commit. `npm run check` and
`npm run verify` passed before each commit, `npm run check` ending at 811
tests, 799 passing and 12 skipped: the six POSIX signal cases, the four
symlink cases and the two assembler cases bound to a platform, as the
role prompts element recorded them, and no new skip. Continuous
integration on the three platforms has not run yet for these commits; it
runs when the pull request opens, and its result is recorded here then.

The commits, in order, and what each carries:

- `d0642fd` usage summary: `summarizeUsage` and `costInUsd` per adapter.
- `6b83b79` the fourteen event kinds, the reducers, `worker.lost`, and
  the golden fixture `schema-1-04`, whose third run goes through every
  kind; the three older fixtures fold with `review: null`.
- `534324a` the narration rewrite (text commit 1 of PD14).
- `b5f0e52` the `CONVENTIONS` wording (text commit 2, R12).
- `d7af182` `roles/policy.json` and its resolution.
- `6f7395a` output schemas, structural checks, locations, grouping.
- `56141a5` the scope block, the rules files, the task texts, `pathOf`.
- `5c37fc6` the state selectors, the planner, labels, spend, the report.
- `f4cd465` the controller, the lock, the executable resolution, the
  command, the scripted fakes and the whole-review tests.
- `9e2a151` the esbuild bundle in both artifacts.
- `dadc928` the skill texts, rebuilt into `dist/`.
- `0973112` three defects a review of the controller found before any
  real run: a launched worker's error could surface as an unhandled
  rejection while another worker was awaited, the controller's append
  retried once against the finishes the launchers append themselves, and
  `--repo` mangled an absolute path; `dist/` rebuilt with them.

The roles' hashes after each text commit. At `534324a` (narration):

| Role | Fragments | Bytes | SHA-256 |
|---|---|---|---|
| triage | 10 | 23997 | `e489f3271f87a1ebf17517fd1ee32d8ad30a12926d0b9e94ad01bdb4baf20cc3` |
| finder-SCAN | 6 | 12457 | `3a9dfee1144ce913cc780ee5da3293d1bffd5fe2a231a040115507335b916838` |
| finder-REMOVALS, DESIGN, ALTITUDE | 4 | 5175 | `2bf05b2b036f21fd0871773d4c17be7206b3b0591c5f951898f8011b2caa3377` |
| finder-RIPPLE, FOOTGUNS, WRAPPERS, EFFICIENCY, DUPLICATION | 4 | 7073 | `797f115385b0a4c36dda880edcbe0a101f282d3c5c8c1c3e2e1b61ebca6a0ace` |
| finder-CONVENTIONS | 4 | 3429 | `f59c5376c99af70457256af6c221319314cf99da53c68eaa61d026e178224d0d` |
| deduplication, verifier | 6 | 15096 | `5c3eeef70efda83ea3fc7da4961dbec660b33eef3813a8077a58ce94b0205129` |
| sweep | 10 | 22458 | `9ec198673392a6f74d423e9117b9806a2ad4fc56f4c324048cd9342a6b043469` |
| merge-rank | 6 | 13156 | `4975e4c2b458ae19836f5559e5491070d4bf5a7ff2a45f0d0d2f889174dedd72` |
| test-assessment | 6 | 28705 | `e63e40d70ff705c6db786c6e4876cf451348ecbd80bba45678273806d1786082` |

`fixer`, `documentation`, `auditor` and `answer` kept their hashes from
`115cca6`. The finders changed only through `finder-lead.md`
(`Driver lead` gone); the lead roles through the four phase fragments,
`lead-brief.md` and `rubrics.md`; `test-assessment` through `rubrics.md`.

At `b5f0e52` (`CONVENTIONS` wording), which changed `angles-conventions.md`,
the `CONVENTIONS` rubric in `rubrics.md` and one bullet of
`phase3-sweep.md`:

| Role | Fragments | Bytes | SHA-256 |
|---|---|---|---|
| triage | 10 | 24202 | `704cb575c920c7ec2b63beda108c3b2b25a0e5d8e9163e4fa06d2195cfc3e44f` |
| finder-SCAN | 6 | 12512 | `b76d436076eef7f7eaf1a73883de94fa3d598246d1217cba21e474fa1825f14f` |
| finder-CONVENTIONS | 4 | 3579 | `25eebcce7c5ef0cfa706d478024fa2fc90253bd65ec45b2fc1b17b2db8537f84` |
| deduplication, verifier | 6 | 15151 | `1f70c646e2c8d07e833a0c4de0a24ff53bbd1d49ade56f1c646df58cb4752a17` |
| sweep | 10 | 22711 | `7292146ec20360f7dd22fa2ae69169ada0686d7a913e9082423680160f6aae4a` |
| merge-rank | 6 | 13211 | `91ca712d7f35fdd683fbcd1fc9fa91e1b3a4faf2ccfde336db5aeb7a51d1b060` |
| test-assessment | 6 | 28760 | `a57fc5ca3d6f7387a34964f735f8a9ee5192281c0e75d44bb6052d9ce154102f` |

The eight other finders and the four fix-pass roles are unchanged from
the table above. Twenty roles make the manifest since `angle-decision`
left it. The `rolesDigest` a run pins is SHA-256 over every role's
`key:sha256` line, so it changes with any of these.

What the implementation decided where the design left room, or departed
from its text, each recorded here rather than silently:

- **The run's `status` stays `active | abandoned` on the fold.** The
  design said the status line becomes `active | blocked | complete |
  abandoned`, derived. The ledger's `status` is what `append` and the
  fold use to refuse events after a run closes, and a blocked run must
  accept the events that resume it, so the four-way status is a derived
  view, `reviewStatus(state)` in `src/review/state.ts`, which `status`
  prints; `RunState.status` is unchanged and the older fixtures fold as
  before.
- **`report` is a phase.** The design started and finished eight phases
  and checked the worktree "before the report" with a drift blocking
  "the phase about to start", which has no `phase.started`. The report
  is the ninth phase: started, checked, then `report.written` and
  `phase.finished` in one append. A drift before it blocks the report
  phase like any other.
- **The check comes after the start.** For every phase the order is
  `phase.started`, then `worktree.checked` for that attempt, then the
  work; a drift appends `phase.finished` blocked with code `drift` in the
  same append as the check. A resumed engine re-enters a running or
  blocked phase with `phase.started` at the next attempt, which is what
  makes it check the tree again and clears a blocker; the attempt counts
  entries into the phase, not worker attempts. Since `b090a2d` the
  check is appended alone and the planner finishes the phase blocked
  once no worker is in flight, as it does for a drift found before an
  answer is recorded.
- **Unit attempts are counted per unit, and reset by a block.** Failures
  are `attempt.failed` events and lost workers, counted per unit across
  the phase's attempts, so an interruption does not give a unit fresh
  attempts. A `phase.started` on a blocked phase forgets its units'
  failures, which is what "run again (two fresh attempts)" promises the
  operator after `worker-failed`; an interruption resumes with the count
  intact. Since `2c19267` a unit that runs out with a lost worker among
  its failures blocks with `worker-failed` instead of degrading.
- **A lost worker carries its unit.** `worker.lost@1` names the phase and
  unit key parsed from the launch label, `<role> <phase>:<key>`, and the
  fold counts it as a failed attempt of that unit; a label the parser
  does not recognise (the smoke's, say) loses the worker without a unit.
  No `attempt.failed` is appended for it.
- **`rubrics.md` changed wording too.** The narration rewrite was meant
  to touch four fragments; the test that no review role's prompt names a
  step of the fix pass found `Step 1` and `Step 3` in `rubrics.md` (and
  `run/skip` in `lead-brief.md`). Both were reworded to say the same
  routing without the step names ("a fix pass", "a later pass", "a
  steering question"); no rubric rule changed. The fix-loop element may
  restore the names when it defines the steps.
- **Two more flags.** `--executable-arg <arg>`, repeatable, gives the
  literal arguments the runtime contract's `executableArgs` takes, which
  is how the tests run the fake CLIs through Node and how a `.cmd` shim's
  target can be run through `node`; `--roles <dir>` names the roles
  directory, which the tests point at a copy whose policy has short
  timeouts. The default roles root is `engine/roles` beside the bundle,
  or the repository's `roles/` from the sources.
- **The budget is checked per launch step, not per worker.** A launch
  step fills the free concurrency at once, so the overshoot the
  requirements accept is up to `concurrency` workers' caps: with a 20 USD
  budget and 12 USD workers the test observes 60 USD spent (the triage,
  then four finders) before the block.
- **`--budget-usd` on Codex is refused, not ignored**, since the check it
  sets could never run; the Codex skill text says not to pass it.
- **Deduplication runs only when its pool holds two candidates**, and
  merge-rank only when a candidate survived; otherwise the phase starts,
  is checked and finishes completed with no worker, and the report says
  no finding survived.
- **Locations fall back to a case-insensitive match** after the exact
  one fails, since a finder may spell a path as its file system shows it.
- **The scripted fakes** answer by `<role>:<phase>:<unit>`, `<role>:<unit>`,
  `<role>` or `*` from a JSON file named by `FAKE_SCRIPT`, one step per
  attempt of a unit, each able to answer, answer malformed, exit nonzero,
  hang, wait for a file or report a cost; the header lines `Role:`,
  `Unit:` and `Phase:` in the Task section are what they match.

Tests checked to fail before their code, or with the behavior they guard
removed: every reducer's invalid history; every planner step on a
synthetic fold, including the fresh attempts after a block and the
retained count after an interruption; every structural check; the
suffix, tail and case rules of location matching; the chunking remainder;
the report snapshot, which fails on any change to the renderer; the
command's exit codes; and, through the fakes, a finder failing twice, a
verifier failing twice, the triage failing twice and the next command
continuing, the budget block and its continuation with a higher budget,
the drift block and its continuation once the file is restored, the lock
held and stale, and the engine killed after three finders answered,
whose next invocation records the lost workers and launches exactly the
units without an answer.

A deep review of the pull request at `a7542c7`, on 2026-09-28, found
defects the suite had not, and the 54 commits after it, from `35a6051`
to `1dde67c`, fix them, one defect or one refactor to a commit, each
with `dist/` rebuilt in the same commit. The design above is corrected
to the code they leave. `npm run check` and `npm run verify` passed
after each group of fixes was integrated; the three commits from
`f760f32` to `b3bcf13` do not typecheck on their own, since the report
there called the location matcher with the signature `353b939` had
replaced, until `7265592`. The commits, in order:

- `35a6051` a unit whose degradation was recorded was launched again
  after a blocked phase's re-entry, and the fold's refusal crashed every
  resume.
- `b14be80` a degradation's reason or a blocker's detail could exceed
  the ledger's 4000-character cap and crash the append; each is cut to
  fit, still quoting every failure.
- `ae2b376` refactor: one missing-index check for verdicts and ranking.
- `31964af` refactor: the angle list derived once, each angle's class
  declared once.
- `9e9115b` refactor: a recorded ranking is ordered through the report's
  `rankedFindings`.
- `c060262` refactor: the candidate id prefix and the single unit key
  named once.
- `6c98af7` the merge-rank task asked for an order the engine discards;
  it now states the engine's order.
- `16387b1` text: `phase4-list.md` said the report keeps the worker's
  order and left `CONVENTIONS` out of the correctness class.
- `353b939` a candidate in an unchanged file was located on a changed
  path its own path merely ends with.
- `013bbea` spellings of one unlocated file went to separate verifiers.
- `e7938a4` a group of 8n+1 candidates gave one verifier nine; chunks
  are balanced within eight, and a chunk size of 0 no longer loops.
- `0e7473f` text: `phase2-verify.md` says how the engine locates and
  groups unlocated paths.
- `fae7df2` a finish after a loss was refused as a second finish.
- `10a58e4` the launcher continued a session holding a lost worker.
- `0b2e327` the statistics' seconds summed worker time, not wall time.
- `78b4c92` a cost's half cent was lost to floating-point
  representation.
- `512eae0` workers whose cost went unreported vanished from the
  totals; `costUnreported` counts them.
- `3f61acd` refactor: one Markdown table-cell escaper.
- `0000f59` worker text could change the report's structure.
- `f760f32` Limitations gave every unlocated candidate one reason; each
  class now says why it is unlocated.
- `8a5684f` refactor: the report asks the fold whether a unit answered
  or went unverified.
- `b3bcf13` the v1 review events took their enums from the live
  vocabulary; they are frozen.
- `7265592` the report classified unlocated candidates with the old
  matcher's signature and rule.
- `7b52975` test: the lock test moved to its own file under a name its
  body supports.
- `2e04945` a lock file holding no pid refused every command for good.
- `aaafd1d` a signal that ended the engine left its run lock behind.
- `a7d0a4a` a throw in the loop left the workers in flight unrecorded
  and paid for again.
- `d12216d` a runtime that stopped qualifying mid-run exited 1 instead
  of being refused.
- `0a871f3` a refusal without a blocker code exited 1.
- `2af6717` two engines started together could each create a run.
- `3ef4879` the command and the controller each found the active run,
  so a paid review could run on a scope nobody asked for.
- `6d8dac1` a run was resumed from another worktree, mixing two trees.
- `96d450e` a resumed run re-read the policy file, never checked its
  roles digest and preflighted the command's executable.
- `c25a9ce` refactor: `--run` resolved in one place.
- `2ff6f9b` abandoning a complete run misstated its outcome for good.
- `e3b6bbf` refactor: `currentPhase` names the phase for the controller
  and `status`.
- `eb9b610` the limits an invocation put in force were not recorded, so
  the report, `status` and `budgetApplied` read the pinned ones; adds
  `limits.changed@1`.
- `a74a874` refactor: unused exports dropped, finder roles named once.
- `a44d9eb` refactor: the fold checks candidate ids through
  `candidateIdPrefix`.
- `006033b` refactor: the planner asks the fold whether a unit answered
  or went unverified.
- `6755022` refactor: units and unverified groups kept by phase, then by
  key.
- `d4fce3a` refactor: one rule reads a candidate's location.
- `222cc9f` refactor: the frozen 4000-character cap named once.
- `38ba617` refactor: the review's roles typed, not plain strings.
- `898fc41` refactor: whether a unit degrades derived from its phase
  alone.
- `29606a7` refactor: each contribution's kind and payload built
  together.
- `04329be` a worker whose process never started was counted as
  unreported cost.
- `70d6f06` refactor: one `isFile` in `src/paths.ts`.
- `477edcc` on Windows an executable no spawn without a shell can start
  passed the command line and failed later at preflight.
- `021a0c2` a found run was planned from a read older than its lock,
  and a stale append was retried over another writer's events.
- `ba1e248` refactor: `describeRun` moved to `src/review/status.ts`.
- `65ac5a6` the per-invocation flag checks lived in three copies that
  had drifted.
- `32f6b4d` a resumed configured run resolved, and could refuse, the
  command's executable.
- `1dde67c` test: the drift test slept a fixed 500 ms and could edit the
  tree before the scope was captured.

The two text commits changed the prompts of the roles that include
their fragments. After `0e7473f` (`phase2-verify.md`) and `16387b1`
(`phase4-list.md`), from `npm run roles`:

| Role | Fragments | Bytes | SHA-256 |
|---|---|---|---|
| deduplication, verifier | 6 | 15369 | `03e7cfcaf94f21b296398e238752a797e31bd5f7658a9e93a71847f4af861c78` |
| merge-rank | 6 | 13322 | `8504ff3d42b09c40914b084f61fe74f0a4dcc4f4cfeef0aa24b5ba4d4fadedba` |

Every other role keeps its hash from the tables above, and the
`rolesDigest` a run pins changes with these.

The fixture `schema-1-04` is this element's own and unreleased, so it
was regenerated in place rather than given a new serial: `512eae0` added
`costUnreported` to the statistics of `report.written@1`; `eb9b610`
added `limits.changed@1` to the registry, so the identity names it and
its registry digest is now
`a18fa259c6002c48e4b4143d71e68927dd3af7198943418c7a6e277fd43f9843`, and
the golden run raises its budget before the sweep's re-entry; `6755022`
changed only its `expected.json`, whose units and unverified groups are
nested by phase. The three older fixtures still fold with
`review: null`.

After the last of them, on the same machine and Node, `npm run check`
ends at 928 tests, 914 passing and 14 skipped: the six POSIX signal
cases, five symlink cases (the four above and `isFile`'s), the two
assembler cases bound to a platform, and the run lock's real-`SIGTERM`
case, which Windows cannot deliver; `npm run verify` matches.
Continuous integration has not run for these commits either.

The review's audit left eight questions only the author could decide,
and the author answered each on 2026-09-28. Six took code, in eight
commits after `346e4dd`, each with `dist/` rebuilt in the same commit;
`68bfac4` was written on its own branch from `346e4dd` and integrated
after `b090a2d`. The design above is corrected to the
code they leave. The commits, in order, with the decision each
implements:

- `2c19267` (interruption and coverage) a lost worker still uses an
  attempt, but a unit that runs out with a loss among its failures
  blocks with `worker-failed` instead of degrading; failures in the
  fold carry `lost`.
- `2bc60a4` (budget and unreported cost) the budget check charges a
  finished worker that ran but reported no cost at its per-worker cap,
  and names the lost ones without charging them; `status` gains the
  `Budget check:` line.
- `b090a2d` (drift while workers run) the scope files are compared
  again before each answer is recorded; an answer after a drift is set
  aside, the attempt blocks once the workers in flight settle, and the
  unit reruns without using an attempt.
- `68bfac4` (locks) each lock is an empty SQLite file held inside
  `BEGIN EXCLUSIVE`; the pid check, the takeover and the grace period
  are gone, and the test of a stale lock with them.
- `106d646` text (verifier answers are all or nothing):
  `phase2-verify.md` says an answer that misses a candidate is
  discarded whole and the whole group then goes unverified.
- `64006e3` (the same decision) the verifier task says an answer that
  misses an index is discarded whole and the group is run again.
- `399c0e9` (locations outside the change) a candidate on an unchanged
  file is located on its canonical path with a checked line and
  `inScope: false` on `candidates.recorded@1`; unlocated means only no
  such file and line.
- `42a951b` text (the same decision) `phase2-verify.md` says such a
  candidate is marked outside the change.

Of the other two, the accepted overshoot of the run budget by up to
`concurrency` workers' caps was kept as the requirements' Risks and the
decision above record it, with no change, and the storage the frozen
prompts cost was recorded in TD3 and the Risks, with no code change.
The documentation commits that follow the eight bring this proposal
and the README in line with them.

The two text commits changed the prompts of the roles that include
`phase2-verify.md`. After `106d646` the deduplication and verifier
prompt was 15480 bytes; after `42a951b`, from `npm run roles`:

| Role | Fragments | Bytes | SHA-256 |
|---|---|---|---|
| deduplication, verifier | 6 | 15658 | `0891f73b3af710f5ccfd850e76ae204543b75f40d47917b73a74e4147511a974` |

Every other role keeps its hash from the tables above, merge-rank the
one `16387b1` gave it, and the `rolesDigest` a run pins changes with
this one.

The fixture `schema-1-04` was regenerated in place again, since it is
still this element's own and unreleased: `2c19267` gave each unit
failure in its `expected.json` a `lost` flag, and its golden run now
degrades `FOOTGUNS` on two real failures and loses the first
`WRAPPERS` worker, whose second answers, as this engine records them;
`399c0e9` gave every recorded candidate `inScope` and added `RIPPLE-3`
on the unchanged `src/caller.ts`, spelled absolute by its finder and
verified in a group of its own. No event kind was added, so its
identity and registry digest are unchanged, and the three older
fixtures still fold with `review: null`.

After the last of them, on the same machine and Node, `npm run check`
ends at 957 tests, 941 passing and 16 skipped: the six POSIX signal
cases, the five symlink cases, the two assembler cases bound to a
platform and the run lock's real-`SIGTERM` case, as before, and two
new location cases that need a file system telling names apart by case
alone, which this one does not; `npm run verify` matches. Continuous
integration has not run for these commits either.

On 2026-09-29, recording the accepted symlink pin (Risks & Migration)
showed that a configured run refused as `runtime-unqualified`, on resume
or mid-run, was told to pass `--executable`, which it ignores. `b7d9f65`
gives that refusal its own action: make the pinned path qualify again, or
abandon the run and start a new one; a new run keeps the table's action.
Two controller tests were tightened and one added. On the same machine,
Node 26.10.0, `npm run check` ends at 960 tests, 944 passing and 16
skipped as before, and `npm run verify` matches the rebuilt bundle.

**R14 passed on 2026-09-29: the gate change reached a report on each
runtime with no hand on either run.**

The change is colinhacks/zod #6530, "fix(v4): parse recursive schemas
built by a factory", reviewed as the range from its merge base
`eca96871` to its head `e48a0055`: 7 files, +511/-172, TypeScript. It
was chosen from five candidates the author was shown (zod #6530 and
#6587, astral-sh/uv #22042, eslint/eslint #21247, vitest-dev/vitest
#11218), each a merged fix of 4 to 15 files changing source and tests
together, in a repository with a root rules file and no submodules.
zod #6530 stands for the common case of a real fix that carries a
refactor with it: a core walk, a memoizer and seven object builders
changed, 300 lines of tests added, a 22 KB `AGENTS.md` for
`CONVENTIONS`, deletions for `REMOVALS`, and 21 commits and 25 review
rounds on the pull request as a human baseline. Its description states
the invariants it relies on, which gives the verifiers claims to test.

Both runs used the shipped bundle, `node dist/<runtime>/engine/main.mjs`
at engine `0.0.0+eba735c9e667`, on the author's Windows 11 machine with
Node 26.10.0, one after the other, from a clone checked out at the head.
Neither retried, degraded or blocked a unit, and each run's nine
worktree checks found no drift.

| | Claude Code | Codex |
|---|---|---|
| Run | `7daab352` | `488b2ac1` |
| Runtime | claude 2.1.284 | codex-cli 0.157.1 |
| Models | opus, sonnet | gpt-6-astra, gpt-5.6-terra |
| Workers | 26 | 27 |
| Wall seconds | 1274 | 1553 |
| Longest worker | triage, 328 s | triage, 310 s |
| Cost | 13.27 USD of 30 | not reported; the budget did not apply |
| Input tokens (cached) | 7532101 (6435902) | 9254652 (7637504) |
| Output tokens | 243196 | 99728 |
| Findings | 28: 17 CONFIRMED, 11 PLAUSIBLE | 35: 33 CONFIRMED, 2 PLAUSIBLE |
| Refuted at verification | 9 | 2 |
| Verification groups (sweep) | 9 (3) | 9 (4) |

The two reports agree on the substance. Both confirm that the memoizer
latches a schema whose walk only assumed a cycle (`memoizer.ts` 256 and
264), that a lazy is followed one hop and a getter never, so strict
`z.compile` rejects acyclic schemas (`memoizer.ts` 72 and 140), that
mini's `.check()` still spreads a def and runs a recursive getter
early (`mini/schemas.ts:78`), and that each cloned def resolves the
source's raw shape again (`schemas.ts:2093`). Each also found what
the other did not: Claude that outputs of a shared input alias once
the memoizer latches, Codex that eagerly mirrored derived shapes
snapshot a source that is later changed, and that a child parser that
throws leaves its entry on the memoizer's global stack. Most findings
came with a probe the verifier ran against the clone.

Two differences are the runtimes', not the engine's, and are recorded
for the policy rather than changed here: Codex's verifiers confirmed 33
of 35 where Claude's confirmed 17 of 28, and Codex's merge-rank kept
twelve `CONVENTIONS` sites under zod's two comment rules (comment form
and JSDoc length) as twelve findings, where Claude's folded thirteen
sites of the same two rules into two.

A shakedown before the gate, on zod #6587 (5 files, +110/-16,
`--last-commit`) with Claude and the engine run from source, reached a
report in 737 s for 7.46 USD with 13 findings, 5 of them confirmed by
probes. Its `CONVENTIONS` finder cited the reviewer's own
`~/.codex/AGENTS.md` against zod's code, which TD11 allows by listing
the home directory's rules files; whether a review of another party's
repository should apply them is left to a later element.

The commit hashes this Verification cites are those on main. The rebase
merges of PR #5 and PR #7 rewrote 80 of them; each was replaced by the
commit on main with the same subject and the same patch id.

## Risks & Migration

- Risk: esbuild output differs across platforms or versions, and
  `npm run verify` fails on one CI runner while the others pass.
  Mitigation: the version is locked, minification is off, and CI on three
  runners is the check; if it happens, the build records the runner that
  produced the committed bytes and verify compares only where it matches,
  which is a later change with its own proposal.
- Risk: the bundle brings a multi-megabyte file into every commit that
  changes the engine. Accepted in the skeleton (D4); the bundle here is
  the command and zod, under one megabyte unminified.
- Risk: a prompt with an inline patch near 256 KiB plus a large role
  prompt approaches a runtime's context, and a finder fails on size
  rather than on the review. Mitigation: the cap is one constant, the
  failure is a `failed` outcome with the runtime's message on the ledger,
  and the gate's runs show whether the cap is right.
- Risk: each worker's frozen prompt holds the inline patch (TD3), so a
  run at the 256 KiB cap adds about 8 to 11 MB to the evidence store, a
  typical change 1 to 2 MB, and nothing prunes the store, so it grows
  with every run until a retention rule exists. Accepted, with no code
  change: each alternative TD3 names is unmeasured or worse, and the
  gate's runs (R14) decide the cap, which then decides this cost.
- Risk: `resolveExecutable` records the real path of the executable it
  finds, not the symlink it found, so a run is pinned to the file a
  symlink named when the run was configured. Claude Code's native
  installer links `claude` to a versioned file, and an automatic update
  may remove that file before a resume; the resumed run's preflight then
  refuses it as `runtime-unqualified`. Accepted by the author on
  2026-09-29: the pin is what makes a resumed run launch the binary it
  started with, which is the point of pinning (runtime adapter, TD10), and
  following the symlink instead would let an update change the runtime's
  version in the middle of a run. The cost is that such a run can only
  resume once that version is installed again at the same path, or be
  abandoned and started anew; a resumed run ignores `--executable`, so
  that flag is no way out, and the refusal of a configured run says so
  instead of the new run's action.
- Risk: the `SCAN` worker, asked for a lead per angle and its own
  review, gives weak leads when the diff supports none. Mitigation: the
  task says `null` is the right answer when no lead is apparent, and a
  finder runs the full angle whatever the lead.
- Risk: the fixed grouping by file puts unrelated candidates before one
  verifier, and one misjudgment spreads. Accepted: the rubric says each
  candidate is judged on its own claim, and the proof of concept ran the
  same grouping.
- Migration: none for existing checkpoints. The three older fixtures
  fold with `review: null`; a run recorded before this element has no
  review and `status` says so. No event changes shape; every new kind is version 1.
- Migration for installs: the placeholder skill is replaced at the next
  `plugin marketplace update` or directory copy; a user who runs the new
  skill without Node 26 gets Node's own error, and the skill text names
  the requirement.
