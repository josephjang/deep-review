# Technical Design: Read-only review

Product part: [2026-09-27-read-only-review.requirements.md](2026-09-27-read-only-review.requirements.md).

## Summary

A command-line entry point, `deep-review`, opens the checkpoint of the
repository it is run in, creates or resumes a run, and drives a fixed
sequence of phases through one controller loop: fold the ledger, compute
the next step from the state alone, execute it (launch workers, record
their answers), append what happened, repeat until the report is written
or the run blocks. Every phase is a module with a pure planner over the
folded state and an executor that turns plans into `runWorker` calls; the
planner is what makes a resumed run continue exactly where the ledger
stops. Roles get their tasks as a prompt composed from the assembled role
prompt, a scope block and the phase's inputs, and their answers are
validated by a zod schema per role, with candidate ids assigned by the
engine. Fourteen new event kinds record the pinned policy, each phase's
progress, every worker's contribution and the report; the fold exposes them
as `RunState.review`. The build gains an esbuild step that bundles the
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
deep-review review  --runtime claude|codex [--executable <abs path>]
                    [--strong-model <m>] [--fast-model <m>]
                    [--last-commit | --worktree | --ref <ref> | --from <rev> --to <rev> [--merge-base]]
                    [--path <p>]... [--concurrency 1..16] [--budget-usd <n>]
                    [--repo <dir>]
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
- `--executable` is optional. When absent the command resolves the
  runtime's command name (`claude`, `codex`) on `PATH` once, at the
  command line, records the absolute path on the configuration event and
  never resolves again (TD10 of the runtime adapter is kept: the launch
  records what runs, the resolution happens once before it). A result
  that is a `.cmd` or `.bat` shim is refused with a message naming the
  flag, since such a shim cannot be spawned without a shell (runtime
  adapter, Verification).
- `review` prints progress to stderr, one line per phase start and end
  and per worker start and end (role, angle or group, outcome, seconds,
  cost when known), and on success prints the report's absolute path as
  the last line of stdout. Exit code 0 on a report, 2 on a blocked run
  (with the blocker and its action on stderr), 1 on any other error.
- `status` prints the fold of the active run or `--run`: phase and
  attempt, workers running and finished per phase, spend against the
  budget, the blocker and its action, and the report path if written;
  `--json` prints the `RunState.review` projection.
- `abandon` appends `run.abandoned@1` after taking the run lock (below).
  A running engine holds the lock, so an abandon during a run is refused
  with "engine <pid> is running this run".

The command that a skill runs is the bundle: `node <artifact>/engine/main.mjs review ...`.

### Run lifecycle and resumption (R1, R10)

`src/review/controller.ts` exports `runReview(context)` where the context
holds the checkpoint, the worktree, the runtime registry, the roles root,
the resolved policy and the flags.

1. **Find or create the run.** `checkpoint.listRuns()` filtered to
   `status === 'active'` and `review.report === null`. Zero: create a run,
   capture the scope, append `review.configured@1`. One: resume it,
   refusing when its pinned runtime differs from `--runtime` (the operator
   abandons or drops the flag). More than one: refuse, naming the ids;
   the operator abandons all but one. A blocked run is active and is
   resumed; its blocker is cleared by the next `phase.started`.
2. **Take the run lock.** `<checkpoint>/runs/<runId>.lock`, created with
   `wx`, holding this process id. A lock whose process is alive
   (`process.kill(pid, 0)` succeeds) refuses the command with the
   `lock-held` blocker; a lock whose process is gone is replaced. The
   lock is removed on every exit path the launcher already hooks (normal
   exit, `SIGINT`, `SIGTERM`, `SIGHUP` on POSIX). Two engines on one run
   is the hazard: `StaleRevisionError` protects each append, but two
   controllers would both dispatch the same step.
3. **Record lost workers.** Every worker in `running` state at resume
   died with the previous engine or was orphaned by a hard kill; the
   controller appends `worker.lost@1` for each, and the fold treats a
   lost worker as finished with outcome `failed` for the retry count
   (TD5).
4. **Loop.** `state = checkpoint.fold(runId)`; `step = nextStep(state)`
   (pure, `src/review/steps.ts`); execute the step; append its events with
   `state.lastSequence` as the expected sequence, retrying the fold and
   the append once on `StaleRevisionError` (only `abandon` can race a
   locked run); repeat. The steps are, in order of precedence:
   - `blocked`: return with the blocker.
   - `check-worktree` before a phase that has not started, and before the
     report: run `compareWorktree`, append `worktree.checked@1`; a drift
     appends `phase.finished@1` with outcome `blocked` and code `drift`
     for the phase about to start.
   - `start-phase`: append `phase.started@1` with attempt = previous
     attempt + 1.
   - `launch`: the phase planner's list of units not yet answered, whose
     attempt count is below 2, minus the units whose worker is running;
     up to `concurrency - running` of them. Before each launch the budget
     check runs (below).
   - `await`: wait for any running worker; record its contribution.
   - `finish-phase`: when every unit is answered or exhausted, append
     `phase.finished@1` with outcome `completed`, `degraded` (some unit
     exhausted and the role degrades) or `blocked` (a unit exhausted and
     the role blocks, code `worker-failed`).
   - `write-report`: render, `evidence.put`, append `report.written@1`.

   Workers run concurrently through a small pool (`src/review/pool.ts`)
   that resolves one at a time so each receipt is recorded before the
   next launch decision, which keeps the budget check exact to the
   receipts seen.

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
- Resolution: `resolvePolicy(file, runtime, flags)` gives the pinned
  configuration: runtime, executable, `executableArgs` (empty), models
  `{ strong, fast }` from flags else the runtime's defaults, per-role
  `{ model, effort, budgetUsd, timeoutMs }` with `budgetUsd` set to null
  when the runtime lacks `budgetCap` (the launcher would refuse it), the
  concurrency and the run budget (flag, else the runtime's default, else
  null), and the roles digest: SHA-256 over the sorted `roleKey:sha256`
  lines of `assembleRoles`, so a run says which prompts it ran.
- `review.configured@1` holds the resolved configuration verbatim. A
  resumed run reads it from the fold and ignores the file and the flags,
  except `--concurrency` and `--budget-usd`, which are per invocation:
  raising the budget is how a `budget` blocker is cleared, so the check
  uses the flag when given and the pinned value otherwise, and the report
  records the value in force at the end.

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
| merge-rank | scope, the working list with verdicts | fold same-root-cause findings across locations, rank most severe first with a severity per finding |

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

**Locations** (`src/review/locations.ts`): `normalizeLocation(scope,
candidate)` returns `{ file: <scope path>, line, located: true }` when
the candidate's `file`, with backslashes turned to slashes and any prefix
that is not part of a scope path removed, is a suffix match of exactly one
scope path (longest match wins), and `line` is at most the line count of
that file's after state, counted in the worktree, which the drift check
has just confirmed equals the frozen after state (an oversized file is
frozen as hash and size only, so the worktree is the one place its lines
can be counted). Otherwise the candidate keeps its
raw `file` and `line` with `located: false`. A deleted file has no after
state; a candidate on it is unlocated too, and the report says why.

### Phases (R2, R5)

Each phase module in `src/review/phases/` exports `plan(state): Unit[]`,
`invocation(unit, state, context): InvocationInput` and
`record(unit, receipt, state): NewEvent[]`. A unit is `{ phase, key }`
where the key is the angle, the group id or the phase name for a phase
with one worker; the attempt count of a unit is the number of workers
whose launch `label` is the role and whose recorded contribution (or
failure) names the key. To make that count readable from the fold, each
contribution event and each failure event names its `workerId`, and the
planner counts them; the launch label carries the role key (D10 of the
role prompts) and the engine appends `:<key>` for a finder or verifier
(`finder-RIPPLE`, `verifier:g3`), which is free text on the ledger.

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

A phase with no unit (an empty sweep, an empty working list) is started
and finished with outcome `completed` in one append, so the ledger shows it
ran. When merge-rank has nothing to rank, the report's Findings section
says no finding survived verification and lists the refuted ones.

**Grouping for verification** (`src/review/grouping.ts`, pure): take the
working list (every candidate not dropped as a dedup duplicate), group by
normalized file, unlocated candidates by their raw `file` string; sort each
group by line; split a group of more than 8 into consecutive chunks of at
most 8, the last chunk absorbing a remainder of 1 into its predecessor so
no chunk holds a single candidate when the group had more. Group ids are
`g<n>` in file order. The plan is recorded once per verification phase as
`verification.planned@1`, so a later engine with a different grouping rule
still resumes the plan this run made.

**Recording a contribution.** For a `completed` receipt whose structural
checks pass: finders and the triage append `candidates.recorded@1` (and
the triage its `leads`); dedup appends `deduplication.recorded@1`; a
verifier appends `verdicts.recorded@1`; merge-rank appends
`ranking.recorded@1`. For any other receipt the phase appends
`attempt.failed@1` naming the unit, the worker and the reason (outcome and
error, or the structural check that failed). That event is what the
planner counts.

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
`PLAUSIBLE`), then the correctness angles before the design angles (the
rubric's cross-class tiebreak), then by primary id. The worker's order is
advisory; the recorded order is the engine's, so two engines render the
same report from the same ledger.

### Retries, budget and blockers (R5, R6)

- **Retry rule.** A unit is launched while it has no recorded
  contribution and fewer than 2 `attempt.failed` events (a lost worker
  counts as one). The retry is a fresh invocation with the same task.
- **Budget check.** Before each launch: `spend = Σ summarizeUsage(finish)
  .costUsd` over the run's finished workers with a non-null cost. If the
  runtime's `costInUsd` capability is false the check is skipped and the
  report's Statistics says the run budget did not apply. If the run has a
  budget and `spend >= budget`, the phase finishes `blocked` with code
  `budget`, detail "spent 31.20 USD of 30.00 USD" and the action "run
  again with --budget-usd above 31.20, or abandon". Workers already
  running finish and are recorded.
- **Blockers** are `{ code, detail, action }` on `phase.finished@1`, the
  codes being an enum the report and `status` print with their actions:

  | Code | Raised when | Operator action |
  |---|---|---|
  | `worker-failed` | a blocking role's unit failed twice | run again (two fresh attempts), or abandon |
  | `budget` | spend reached the run budget | run again with a higher `--budget-usd`, or abandon |
  | `drift` | the worktree differs from the scope | restore the named files and run again, or abandon and start a new run |
  | `lock-held` | another engine holds the run lock | wait for it, or if its process is gone the lock clears itself |
  | `runtime-unqualified` | the preflight refused the executable | fix the installation or pass `--executable`, then run again |

  `lock-held` and `runtime-unqualified` are refusals before any event and
  are printed, not recorded; the other three are on the ledger. A test
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
phase for the report, with the phase of a worker read from the
contribution or failure event that names it.

### Ledger events and fold (R10)

New kinds, all version 1, in `src/checkpoint/events.ts`, each with a
reducer in `src/checkpoint/fold.ts`; the fixture `schema-1-04` is
committed with them. Payloads are strict; free text fields are bounded.

| Kind | Payload | Reducer effect on `state.review` |
|---|---|---|
| `review.configured` | runtime, executable, executableArgs, version (preflight), models, roles (per role: model, effort, budgetUsd, timeoutMs), rolesDigest, concurrency, runBudgetUsd | creates `review` with the policy; twice is invalid history |
| `phase.started` | phase (enum), attempt | phase status `running`; clears `blocker`; attempt must be previous + 1 |
| `phase.finished` | phase, attempt, outcome (`completed`, `degraded`, `blocked`), blocker `{ code, detail, action }` or null | phase status; sets `blocker` when blocked; invalid without a matching start |
| `worktree.checked` | before (phase or `report`), drifted, files `[{ path, outcome }]` (only the not-unchanged ones) | appended to `checks` |
| `candidates.recorded` | phase (`triage`, `finders`, `sweep`), angle, workerId, candidates `[{ id, file, line, located, rawFile, rawLine, summary, detail }]`, leads `[{ angle, lead }]` or null (triage only) | candidates by id; leads; marks the unit answered |
| `attempt.failed` | phase, key, workerId, reason | counted per unit |
| `angle.failed` | phase, angle, reason | angle marked not run |
| `deduplication.recorded` | phase, workerId, groups `[{ members: ids, keep: id, reason }]` | duplicates leave the working list |
| `verification.planned` | phase, groups `[{ id, candidateIds }]` | the plan the units come from |
| `verdicts.recorded` | phase, groupId, workerId, verdicts `[{ id, verdict, evidence }]` | verdicts by candidate id |
| `group.unverified` | phase, groupId, reason | its candidates `PLAUSIBLE` + `unverified` |
| `ranking.recorded` | workerId, findings `[{ id (primary), members, severity, summary, reason }]` | the ranked list |
| `report.written` | report (artifact reference), statistics (per phase workers, seconds, costUsd or null, tokens) | `report`; the run is complete |
| `worker.lost` | workerId, reason | the worker's state becomes `lost` |

`RunState` gains `review: ReviewState | null` with: `policy`, `phases`
(per phase: status `pending | running | completed | degraded | blocked`,
attempt), `blocker`, `checks`, `leads`, `candidates` (by id, with angle,
phase, location, and its resolution: `duplicateOf`, `verdict`,
`unverified`), `plans` (per verification phase), `failures` (per unit),
`anglesNotRun`, `ranking`, `report`. `WorkerState` gains the variant
`{ status: 'lost'; launch; launchedAt; reason }`. The status line becomes
`active | blocked | complete | abandoned`, derived: `blocked` when
`blocker !== null`, `complete` when `report !== null`.

The four existing fixtures must fold with `review: null` and `workers`
untouched, which is the forward-compatibility proof the AGENTS.md rule
asks for; the new fixture holds one run through every kind, including a
blocked phase, a lost worker and a degraded angle.

### Report (R9)

`src/review/report.ts` exports `renderReport(state): string`, pure over
the fold, and the controller stores it with `evidence.put` and appends
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
apply. Statistics is one table per phase and a total; Limitations lists
the degraded units, every drift check's outcome, the budget's
applicability and the oversized files no worker could be given frozen.
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
  worker lost with the reason "engine exited while the worker ran" and
  counts it as a failed attempt. Appending a `worker.finished` for it was
  rejected: that event says what a process did, and nothing observed it.
- **TD6: One run lock file per run, by process id.** SQLite serializes
  appends and `StaleRevisionError` catches a race, but two controllers
  would still both plan the same step and launch it twice before either
  append fails. A lock by process id is checkable on every platform
  (`process.kill(pid, 0)`), needs no daemon, and clears itself when its
  process is gone.
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
  on Windows. The command refuses the shim and names `--executable`; the
  runtime adapter's `executableArgs` exists for a caller that wants to
  spawn the shim's target through `node`, and the skill text can say how
  once a user hits it.

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
- Locations (R8): suffix match with forward and backward slashes and an
  absolute prefix; ambiguity (two scope paths with the same suffix, only
  the longer matches); a line past the end; a deleted file; an oversized
  file measured from the worktree; every failure yields `located: false`
  and keeps the candidate.
- Grouping: by file, sorted by line, chunks of 8, remainder of 1
  absorbed, unlocated by raw file; ids stable.
- Planner (R1, R2, R5): synthetic folds for every step in the precedence
  order, including: nothing done; a phase running with two units answered
  of nine; a unit with one failure (retry planned); a unit with two
  failures on a degrading role (degradation event planned) and on a
  blocking role (block planned); a blocked run (returns the blocker); a
  lost worker counted; every phase with no unit (started and finished in
  one append).
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
  a unit twice, a verdict for an unknown candidate); the four old
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

No checks have run yet. This section is filled by the commits that
complete the element: `npm run check` and `npm run verify` on the author's
machine and on the three CI runners, the roles' hashes after each text
commit, and the two gate runs.

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
- Migration: none for existing checkpoints. The four fixtures fold with
  `review: null`; a run recorded before this element has no review and
  `status` says so. No event changes shape; every new kind is version 1.
- Migration for installs: the placeholder skill is replaced at the next
  `plugin marketplace update` or directory copy; a user who runs the new
  skill without Node 26 gets Node's own error, and the skill text names
  the requirement.
