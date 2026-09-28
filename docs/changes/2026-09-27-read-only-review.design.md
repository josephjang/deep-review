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
  one it pinned. An executable a spawn without a shell cannot start is
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
  budget in force, the blocker and its action, and the report path if
  written. `--json` prints one object holding the same facts (run id,
  status, worktree, phase, worker counts, the statistics per phase and in
  total, blocker, report path) and the whole `RunState.review`, whose
  units and unverified groups are nested by phase.
- `abandon` appends `run.abandoned@1` under the checkpoint's start lock
  and the run lock (below), after folding the run again under them. A
  run that is complete or already abandoned is refused as a usage error:
  the ledger never closes a review run whose report is written, so the
  event would be accepted and would misstate the run's outcome for good.
  A running engine holds the run lock, so an abandon during a run is
  refused with "engine <pid> is running run <id>".

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
2. **Take the run lock.** `<checkpoint>/runs/<runId>.lock`, created with
   `wx`, holding this process id. A lock whose process is alive
   (`process.kill(pid, 0)` succeeds) refuses the command with the
   `lock-held` blocker; a lock whose process is gone is replaced, and so
   is one that holds no pid once its file is older than 10 s, a younger
   one being refused as another engine's lock in the instant between its
   create and its write. A found run's lock is taken before its
   preflight, so an engine running it refuses this one at once. The found
   run is folded again once its lock is held, since the engine that held
   the lock may have appended after the find; a run no longer resumable
   is released and a new run is created. The lock is released on every
   way out: the controller's own release, the process's exit, and a
   signal that would end the engine (`SIGINT`, `SIGTERM`, `SIGHUP`,
   `SIGQUIT` on POSIX; `SIGINT`, `SIGBREAK`, `SIGHUP` on Windows), whose
   listener releases the lock and exits with 128 and the signal's number,
   since Node runs no exit listener for a death by signal. Two engines on
   one run is the hazard: `StaleRevisionError` protects each append, but
   two controllers would both dispatch the same step.
3. **Record the limits and the lost workers, and re-enter the phase.**
   The concurrency and run budget this invocation puts in force are
   appended as `limits.changed@1` when they differ from the run's (Policy,
   below). Every worker in `running` state at resume died with the
   previous engine or was orphaned by a hard kill; the controller appends
   `worker.lost@1` for each, naming the phase and unit key its launch
   label names, and the fold marks the worker lost and counts it as a
   failed attempt of that unit (TD5). A phase left running or blocked is
   then re-entered with `phase.started@1` at the next attempt.
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
     phase included: run `compareWorktree`, append `worktree.checked@1`;
     a drift appends `phase.finished@1` with outcome `blocked` and code
     `drift` in the same append.
   - `plan-verification`: a verification phase appends its
     `verification.planned@1` once.
   - `write-report`, in the report phase: render, `evidence.put`, append
     `report.written@1` and the report phase's `phase.finished@1`
     together.
   - `degrade`: append `angle.failed@1` or `group.unverified@1` for each
     unit of a degrading role that has used its two attempts.
   - `finish-phase` blocked with code `worker-failed`, once the workers
     in flight have settled, when a unit of a blocking role has used its
     two attempts.
   - `launch`: the phase's units not yet answered, not degraded, with an
     attempt left and no worker in flight, up to `concurrency - running`
     of them. Before each launch the budget check runs (below).
   - `await`: wait for any running worker; record its contribution.
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
retry; a unit with two gets its degradation or blocks. Nothing is
recomputed from evidence; every fact the planner needs is an event.

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
| verifier | scope, the group's candidates numbered `[0]`.. with the angle each came from and the `unlocated` mark | one verdict per index with one evidence line, by the rubric of the candidate's angle |
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
and every index of the group has a verdict; merge-rank indexes exist and
every index of the working list is a primary or a member exactly once.

**Ids** are assigned by the engine: `SCAN-<n>`, `<ANGLE>-<n>`, `SWEEP-<n>`
in the worker's discovery order, numbered from 1 per angle. A retried
finder numbers from 1 again; only the answer that is recorded has ids.

**Locations** (`src/review/locations.ts`): `normalizeLocations(scope,
worktree, candidates)` gives a candidate `{ file: <scope path>, line,
located: true }` when `matchScopePath` finds one scope path for its
`file`, and `line` is at most the line count of that file's after state.
The file is normalized as a scope path is spelled (backslashes turned to
slashes, runs of slashes and a leading `./` removed), and its
repository-relative tails, after any root or drive and after the last
`.` or `..` segment, are tried longest first: a tail that is a scope path
matches it, so an absolute or otherwise prefixed spelling of a changed
file is found; a tail that is not a scope path but names an entry the
worktree holds, compared without case, is a different, unchanged file,
and the candidate matches nothing, so `src/index.ts` is never pinned to a
changed root `index.ts`. Failing both, a file that is itself the bare
tail of exactly one scope path (`a.ts` for `src/a.ts`) matches it. Each
comparison with a scope path is exact first, then without case, and a
name that matches two scope paths without case matches neither. Lines
are counted in the worktree, which the drift check at the start of the
phase's attempt found equal to the frozen after state (an oversized file
is frozen as hash and size only, so the worktree is the one place its
lines can be counted; an edit made while the phase's workers run is not
seen until the next check). Otherwise the candidate keeps its raw `file`
and `line` as `rawFile` and `rawLine`, with `located: false`. A deleted
file has no after state; a candidate on it is unlocated too, and the
report says why.

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
located candidates by scope path and unlocated ones by their `file`
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
a lost worker, is what the fold counts against the unit.

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
  contribution, no recorded degradation and fewer than 2 `attempt.failed`
  events (a lost worker counts as one). The retry is a fresh invocation
  with the same task. A blocked phase re-entered gives its units fresh
  attempts, but an angle recorded as not run or a group marked unverified
  stays settled and is never launched again.
- **Budget check.** Before each launch: `spend = Σ summarizeUsage(finish)
  .costUsd` over the run's finished workers with a non-null cost. A
  worker whose cost went unreported (timed out, failed after its process
  started but before the runtime printed its usage, or lost with its
  engine) adds nothing to it; the report counts such workers. If the
  runtime's `costInUsd` capability is false the check is skipped and the
  report says the run budget did not apply. If a run budget is in force
  (`review.limits`) and `spend >= budget`, the phase finishes `blocked`
  with code `budget`, detail "spent 31.20 USD of the 30.00 USD run
  budget" and the action "run the command again with --budget-usd above
  31.20, or abandon the run". Workers already running finish and are
  recorded.
- **Blockers** are `{ code, detail, action }` on `phase.finished@1`, the
  codes being an enum the report and `status` print with their actions:

  | Code | Raised when | Operator action |
  |---|---|---|
  | `worker-failed` | a blocking role's unit failed twice | run again (two fresh attempts), or abandon |
  | `budget` | spend reached the run budget | run again with a higher `--budget-usd`, or abandon |
  | `drift` | the worktree differs from the scope | restore the named files and run again, or abandon and start a new run |
  | `lock-held` | another engine holds the run lock or the start lock | wait for it, or if its process is gone the lock clears itself |
  | `runtime-unqualified` | the preflight refused the executable | fix the installation or pass `--executable`, then run again |

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
| `candidates.recorded` | phase (`triage`, `finders`, `sweep`), key (`SCAN`, the angle, `sweep`), workerId, candidates `[{ id, angle, file, line, located, rawFile, rawLine, summary, detail }]`, leads `[{ angle, lead }]` or null (triage only) | candidates by id; leads; marks the unit answered |
| `attempt.failed` | phase, key, workerId, reason | one more failure of the unit |
| `angle.failed` | angle, reason | angle marked not run |
| `deduplication.recorded` | phase, workerId, groups `[{ members: ids, keep: id, reason }]` | duplicates leave the working list |
| `verification.planned` | phase, groups `[{ id, candidateIds }]` | the plan the units come from |
| `verdicts.recorded` | phase, groupId, workerId, verdicts `[{ id, verdict, evidence }]` | verdicts by candidate id |
| `group.unverified` | phase, groupId, reason | its candidates `PLAUSIBLE` + `unverified` |
| `ranking.recorded` | workerId, findings `[{ id (primary), members, severity, summary, reason }]` | the ranked list |
| `report.written` | report (artifact reference), statistics (per phase and in total: workers, wall seconds, costUsd or null, costUnreported or null, input, cached input and output tokens or null; budgetApplied) | `report`; the run is complete |
| `worker.lost` | workerId, phase and key (both, from the launch label, or neither), reason | the worker's state becomes `lost`; a unit it names counts one more failure |

`RunState` gains `review: ReviewState | null` with: `configuration`,
`limits` (the concurrency and run budget in force), `phases` (per phase:
status `pending | running | completed | degraded | blocked`, attempt),
`blocker` (with its phase), `checks`, `leads`, `candidates` (by id, with
angle, phase, worker, location, and its resolution: `duplicateOf`,
`verdict`, `unverified`), `units` (by phase, then by unit key: the worker
that answered, and the failures), `anglesNotRun`, `deduplications` (per
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

with `(unlocated: <raw file>:<raw line>)` and `(unverified)` where they
apply. Statistics is one table with a row per phase and a total, each
cost cell naming how many workers' cost went unreported. Limitations
lists the angles not run and the unverified groups (in plan order),
every drift check's outcome, the run budget in force at the end or why
none applied, how many workers reported no cost (so the run cost more
than the totals show), the oversized files no worker could be given
frozen, and the unlocated candidates by why they are unlocated: on a
file outside the change, on a file the change deletes, on a line past
the end of a changed file, or on a path that only ends with a changed
path, which the ledger alone cannot tell an unchanged file from. Text a
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
  is one more `attempt.failed`-equivalent.
- **TD3: The patch is inline under 256 KiB and by path above.** The cap
  keeps a small change's prompt self-contained (the common case: a pull
  request of a few hundred lines is well under it) and a large one from
  filling every worker's context; the runtime adapter freezes the prompt
  whatever its size, so evidence is unaffected. The frozen before states
  are always by path, since a worker reads them only when the diff does
  not show enough.
- **TD4: Indexes in, ids out.** Workers refer to candidates by the index
  the engine numbered them with in the prompt, and the engine assigns and
  keeps ids. A worker that returned ids could return one that does not
  exist or belongs to another group; an index is checked structurally.
- **TD5: A lost worker is recorded, not repaired.** The resuming engine
  cannot know whether an orphaned process still runs; it records the
  worker lost with the reason "the engine exited while the worker ran"
  and counts it as a failed attempt. Appending a `worker.finished` for it
  was rejected: that event says what a process did, and nothing observed
  it. For the same reason the launcher refuses to continue a session
  that holds a lost worker, since an orphan may still write to it.
- **TD6: One run lock file per run, by process id.** SQLite serializes
  appends and `StaleRevisionError` catches a race, but two controllers
  would still both plan the same step and launch it twice before either
  append fails. A lock by process id is checkable on every platform
  (`process.kill(pid, 0)`), needs no daemon, and clears itself when its
  process is gone. The start lock is the same kind of file at the
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

- Open: the change the gate reviews (R14, PD15). Criteria: a merged pull
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
  say so.
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
  worktree, in any case, never pinned to a changed path it ends with; the
  bare-tail rule; ambiguity without case matching neither; a line past
  the end; a deleted file; an oversized file measured from the worktree;
  every failure yields `located: false` and keeps the candidate.
- Grouping: by scope path, sorted by line; balanced chunks of at most 8
  for every length from 0 to 100, 9 giving 5 and 4; an invalid chunk size
  refused; the spellings of one unlocated file, in slashes, `./`, case or
  an absolute path, grouped together; ids stable.
- Planner (R1, R2, R5): synthetic folds for every step in the precedence
  order, including: nothing done; a phase running with two units answered
  of nine; a unit with one failure (retry planned); a unit with two
  failures on a degrading role (degradation event planned) and on a
  blocking role (block planned); a blocked run (returns the blocker); a
  lost worker counted; every phase with no unit (started, checked and
  finished with no worker).
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
  a Codex fake reaches a report with the budget marked inapplicable;
  a file edited between phases blocks with `drift` naming the file, and
  restoring it and running again completes; the run lock refuses a second
  engine while the first holds it and clears when the holder is gone;
  `abandon` during a run is refused.
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
the eleven commits that build the element after the proposal (`71b693f`),
from `76f1ba9` to `4cc1a80`, and the fix commit `9085ae6` after the
first documentation commit. `npm run check` and
`npm run verify` passed before each commit, `npm run check` ending at 811
tests, 799 passing and 12 skipped: the six POSIX signal cases, the four
symlink cases and the two assembler cases bound to a platform, as the
role prompts element recorded them, and no new skip. Continuous
integration on the three platforms has not run yet for these commits; it
runs when the pull request opens, and its result is recorded here then.

The commits, in order, and what each carries:

- `76f1ba9` usage summary: `summarizeUsage` and `costInUsd` per adapter.
- `c9516c1` the fourteen event kinds, the reducers, `worker.lost`, and
  the golden fixture `schema-1-04`, whose third run goes through every
  kind; the three older fixtures fold with `review: null`.
- `2c159d7` the narration rewrite (text commit 1 of PD14).
- `89e231a` the `CONVENTIONS` wording (text commit 2, R12).
- `21375c5` `roles/policy.json` and its resolution.
- `6c10afa` output schemas, structural checks, locations, grouping.
- `c98728a` the scope block, the rules files, the task texts, `pathOf`.
- `1664edc` the state selectors, the planner, labels, spend, the report.
- `105cbd4` the controller, the lock, the executable resolution, the
  command, the scripted fakes and the whole-review tests.
- `7c1fcd6` the esbuild bundle in both artifacts.
- `4cc1a80` the skill texts, rebuilt into `dist/`.
- `9085ae6` three defects a review of the controller found before any
  real run: a launched worker's error could surface as an unhandled
  rejection while another worker was awaited, the controller's append
  retried once against the finishes the launchers append themselves, and
  `--repo` mangled an absolute path; `dist/` rebuilt with them.

The roles' hashes after each text commit. At `2c159d7` (narration):

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
`a77e6ec`. The finders changed only through `finder-lead.md`
(`Driver lead` gone); the lead roles through the four phase fragments,
`lead-brief.md` and `rubrics.md`; `test-assessment` through `rubrics.md`.

At `89e231a` (`CONVENTIONS` wording), which changed `angles-conventions.md`,
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
  entries into the phase, not worker attempts.
- **Unit attempts are counted per unit, and reset by a block.** Failures
  are `attempt.failed` events and lost workers, counted per unit across
  the phase's attempts, so an interruption does not give a unit fresh
  attempts. A `phase.started` on a blocked phase forgets its units'
  failures, which is what "run again (two fresh attempts)" promises the
  operator after `worker-failed`; an interruption resumes with the count
  intact.
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

**R14, the gate on a real change from a well-known open-source
repository on both runtimes, has not run.** It needs the real Claude Code
and Codex CLIs signed in, costs real money, and its subject, the pull
request the Open Questions describe, is the author's to choose. Until it
runs, the element is complete in its code and its suite but not
accepted; the two reports' statistics, the repository, the change and
why they were chosen are recorded here when it does.

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
