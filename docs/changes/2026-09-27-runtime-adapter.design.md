# Technical Design: Runtime adapter

Product part: [2026-09-27-runtime-adapter.requirements.md](2026-09-27-runtime-adapter.requirements.md).

## Summary

A runtime-neutral invocation goes in; one adapter per runtime turns it into
a command line and reads the runtime's answer back; one launcher, shared by
every runtime, spawns the process, writes the worker to the ledger before
and after, and freezes every byte of the exchange into the evidence store.
Adapters are pure (command builder and decoder), live in a registry, and
declare a capability table the launcher checks before running. Two ledger
events, `worker.launched` and `worker.finished`, are the whole record of a
worker; a continuation is a new worker that names the session it resumes.

## Non-Goals

- No bundling of the engine for distribution. The launcher spawns the
  runtime CLI, not the engine; how the engine itself is shipped inside the
  plugin is the first end-to-end element's question.
- No transcript reading. Claude Code and Codex write their own session
  files; the engine records the id and never parses them.
- No streaming of worker output while it runs. stdout and stderr go to
  files and are read when the process ends.
- No retry inside the launcher. A launch is one process; a controller that
  wants another one runs another worker.

## Context

Verified at `20cbb39` of this repository and `822986e` of `agent-skills`,
with `claude` 2.1.283 and `codex-cli` 0.147.0 installed on the author's
Windows machine on 2026-09-27. Nothing uncommitted was used.

- The proof of concept's runtime boundary is
  `agent-skills/packages/deep-review-driver/src/runtime/` (`contracts.ts`,
  `claude.ts`, `codex.ts`, `preflight.ts`, `containment.ts`) with the
  process handling in `worker.ts` and `scratch.ts`. Its command builders
  and decoders are sound and most of their rules are kept; its contract
  carries Claude tool names, its worker branches on the runtime name, and
  its containment is Windows-only PowerShell. The denial handling in
  `full-review/denied-tools.ts` and `result-correction.ts` rejects a
  result on any denial and re-runs a read-only role once from scratch.
- This repository has the ledger (`src/checkpoint/`), the evidence store
  (`src/evidence/`) and scope capture (`src/scope/`). `Checkpoint.append`
  validates payloads against the registry in `src/checkpoint/events.ts`,
  verifies every artifact reference and checks the folded sequence, so a
  new event kind gets all three for free. `RunState` in
  `src/checkpoint/fold.ts` has `scope` and no notion of a worker.
- Both installed CLIs accept every flag the adapters use. Claude:
  `--print`, `--output-format`, `--json-schema`, `--effort`,
  `--max-budget-usd`, `--tools`, `--allowedTools`, `--permission-mode`,
  `--strict-mcp-config`, `--setting-sources`, `--settings`, `--session-id`,
  `--resume`, `--add-dir`, `--disable-slash-commands`. Codex `exec`:
  `--json`, `--output-schema`, `--output-last-message`, `--sandbox`,
  `--ignore-user-config`, `--ignore-rules`, `--add-dir`,
  `--skip-git-repo-check`, and the `resume` subcommand. Claude's `--effort`
  accepts `low`, `medium`, `high`, `xhigh` and `max`; Codex has no `max`.
- On this machine `codex` on `PATH` resolves to a launcher under
  `AppData/Local/Programs/OpenAI/Codex/bin/codex` rather than an `.exe`;
  whether a `shell: false` spawn starts it is not yet known.

## Design

### Invocation (R1, R2)

`src/runtime/contract.ts` holds the zod schema for an invocation: `runtime`
(a registered name), `executable` (absolute path), `model`, `effort` (one
of `low`, `medium`, `high`, `xhigh`, `max`), `access` (`read-only` or
`edit`), `shell` (boolean), `prompt`, `outputSchema` (a zod schema),
`timeoutMs` (one second to one hour), and optionally `budgetUsd` (positive,
at most 100), `scratch` (absolute path), `label` (free text for the
ledger) and `resume` (a session id; the prompt is then the follow-up
message). A NUL in any string is refused.

### Adapter and registry (R2, R4, R10)

`RuntimeAdapter` in `src/runtime/adapter.ts` is `name`, `capabilities`,
`preflight(executable)`, `command(invocation, paths)` and
`decode(invocation, outputs)`. `src/runtime/registry.ts` maps a name to its
adapter and throws on a duplicate registration. The two adapters are
`src/runtime/claude.ts` and `src/runtime/codex.ts`; nothing outside them
branches on a runtime name.

`capabilities` declares: session id assignable before launch; budget cap
enforceable; denial evidence available; shell can be withheld; a read-only
worker can write to its scratch directory; the effort levels that exist;
sessions can be resumed. For the two runtimes:

| Capability | Claude Code | Codex |
|---|---|---|
| Session id assigned before launch | yes (`--session-id`) | no, observed from `thread.started` |
| Budget cap | yes (`--max-budget-usd`) | no |
| Denial evidence | yes (`permission_denials`) | no |
| Shell can be withheld | yes | no |
| Read-only worker writes to scratch | yes (`--add-dir`) | no |
| Effort levels | low to max | low to xhigh |
| Resume | `--resume <id>` | `exec resume <id>` |

`preflight` runs `--version` and `--help` (Codex: `exec --help`) with a
ten second timeout and no model call, matches the version output against
the runtime's pattern, requires every flag the adapter's command uses to
appear in the help text, and returns the observed version.

### Translation, Claude Code (R7, R8, R9)

`access` and `shell` become `--tools` and `--allowedTools`: `Read`, `Glob`,
`Grep`; plus `Bash` when `shell`; plus `Edit` and `Write` when `access` is
`edit`. The command is `--print --output-format json`, the model, the
effort, `--session-id` with the pinned id (or `--resume` with the session
being continued), `--add-dir` with the scratch directory,
`--max-budget-usd` when a budget is given, `--permission-mode dontAsk`,
`--disable-slash-commands`, `--strict-mcp-config`, `--setting-sources ''`,
a `--settings` object that disables auto memory and excludes every
CLAUDE.md, and `--json-schema` with the compiled schema. The environment
is the caller's with `CLAUDE_CODE_EFFORT_LEVEL` and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY` set (the variable outranks the flag, so
both are pinned); an inherited `MAX_THINKING_TOKENS`,
`CLAUDE_CODE_DISABLE_THINKING` or `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`
is refused by name, comparing names case-insensitively so Windows cannot
hide one under another spelling.

### Translation, Codex (R7, R8, R9)

The command is `-a never exec --ignore-user-config --ignore-rules
--skip-git-repo-check`, `--sandbox read-only` or `workspace-write` from
`access`, `--add-dir` with the scratch directory only when `access` is
`edit`, `windows.sandbox="unelevated"` on Windows, the config overrides
that disable project docs, skill instructions, web search, apps, plugins,
remote plugins, skill search and skill dependency install, the model,
`model_reasoning_effort`, `--json`, `--output-schema` with the schema
file, `--output-last-message` with the result file, and `-` for stdin. A
continuation is `exec resume <session>` with the same flags. `shell:
false`, `effort: max` and `budgetUsd` are refused through the capability
table. On Windows every spelling of `PATH` is merged and directories
containing `WindowsApps` are removed, because the restricted token cannot
launch the Store shell.

### Launcher (R1, R3, R6, R7, R8)

`runWorker(checkpoint, runId, invocation)` in `src/runtime/launcher.ts`
does, in order:

1. Fold the run; refuse an unknown or inactive run.
2. Check the invocation against the adapter's capabilities.
3. Preflight the executable.
4. Freeze the prompt and the compiled draft-07 schema as evidence.
5. Create `<checkpoint root>/scratch/<workerId>` (skipped for a Codex
   read-only worker).
6. Append `worker.launched`.
7. Write the prompt to a file and open it as stdin; spawn with `shell:
   false`, the run's worktree as `cwd`, stdout and stderr redirected to
   files, and the environment of the adapter with `TEMP`, `TMP` and
   `TMPDIR` (forward slashes, for Git Bash) pointing at the scratch
   directory and `MSBUILDDISABLENODEREUSE=1`,
   `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `UseSharedCompilation=false` and
   `UseRazorBuildServer=false` set, replacing any inherited spelling of
   those names.
8. Wait for exit or timeout. On timeout, kill the tree: `taskkill /PID
   <pid> /T /F` on Windows; on POSIX the child was spawned as its own
   process group and the group receives `SIGKILL`.
9. Decode through the adapter; freeze stdout, stderr and the final output
   as evidence.
10. Append `worker.finished`, retrying on `StaleRevisionError` by
    re-folding (several launchers may finish on one run at once).
11. Return the receipt.

A failure at step 7 (the process never starts) still runs steps 9 to 11
with outcome `failed`, so the ledger never holds a launched worker without
a finish from this launcher. A failure before step 6 writes nothing.

### Receipt and decoding (R5)

The receipt has `process` (exit code, signal, `termination` of `exited` or
`killed`, `startedAt`, `endedAt`), `runtime` (name, observed version,
session ids, usage as the runtime reported it), `denials` (an array of
tool and detail, or `null` when the runtime gives no evidence either way),
`output` (validated data or `null`), `outcome` (`completed`, `budget`,
`timeout` or `failed`) and `error` (message or `null`).

Claude decoding requires a `result` envelope with `subtype: success`,
`is_error: false`, a `structured_output` field and a `permission_denials`
array; the envelope's `session_id` must equal the pinned or resumed one;
`terminal_reason: budget_exhausted` or `subtype: error_max_budget` is
outcome `budget`. Codex decoding parses every JSONL line, requires exactly
one `thread.started` (its id is the session), exactly one `turn.completed`
as the last event, no `error` or `turn.failed` event, no `mcp_tool_call` or
`web_search` item, no item left started without completing, no failed
item other than a command with a nonzero exit code, and a final message
file equal to the last `agent_message`; `denials` is `null`. stdout,
stderr and the final message are refused for decoding above 16 MiB and are
still frozen as evidence. A denial never changes the outcome; a budget
stop is not `failed`; a rejected schema, a nonzero exit without a budget
stop or a decode failure is `failed` with the reason.

### Ledger events and fold (R3, R11)

`worker.launched@1` carries the worker id, label, runtime, executable,
observed version, model, effort, access, shell, session id or null, the
session resumed or null, scratch or null, budget or null, timeout, and the
prompt and schema as artifact references. `worker.finished@1` carries the
worker id, outcome, exit code, signal, termination, start and end, session
ids, usage, denials, error, stdout and stderr as references and the output
as a reference or null. Both are declared in `src/checkpoint/events.ts`
and reduced in `src/checkpoint/fold.ts`. `RunState` gains `workers`, keyed
by id, each `running` (launch only) or `finished` (launch and receipt). A
finish without a launch, or a second launch with the same id, is invalid
history. A run created before this element folds with an empty `workers`.
Golden fixture `schema-1-03` is added; `schema-1-01` and `schema-1-02`
stay.

### Smoke script (R12)

`scripts/smoke-runtime.ts`, run as `npm run smoke -- --claude <path>
--codex <path>`, opens a checkpoint in a temporary repository, runs one
trivial prompt with a one-field schema through each given CLI, continues
each session once, and prints every receipt's outcome, version, session
ids and usage. It is not part of `npm run check`.

## Technical Decisions

- **TD1: An adapter is a command builder and a decoder; one launcher owns
  the process.** (D1 of the reviewed draft.) Letting each adapter spawn
  was rejected: spawning, timeouts, evidence capture and ledger writes are
  the same for every runtime and would be copied per adapter, and a builder
  and decoder that never touch a process are testable with fakes on every
  platform.

- **TD2: A third runtime is one file and one registration.** (D2.) The
  proof of concept branched on the runtime name in the worker, the
  preflight and the result handling, so adding a runtime meant editing the
  engine. With an adapter interface and a registry, the engine calls the
  interface and the only place that knows a runtime's name is its module.

- **TD3: Permissions are `access` and `shell`, not tool names.** (D3.)
  Carrying Claude's tool names in the contract was rejected because a
  second runtime translates them anyway and a third may have nothing that
  corresponds. Two axes cover every role the proof of concept had: a
  finder reads and runs a shell, an editor also writes. Revisit if a role
  needs a permission neither axis expresses, such as network access.

- **TD4: Each adapter declares what it cannot do, and the launcher refuses
  before running rather than approximating.** (D4.) Hiding runtime
  differences behind a common contract was rejected: the proof of
  concept's Codex path silently had no budget cap and no denial evidence.
  A capability table makes "unknown" a stated value (`denials: null`) and
  a missing capability a refusal that names it.

- **TD5: The receipt separates process, runtime envelope, denials and
  validated output, and the outcome is an enum.** (D6.) One error string,
  as the proof of concept had, put a budget stop, a timeout and a malformed
  result in the same bucket, which is how a budget problem was diagnosed as
  a timeout problem in the pilot.

- **TD6: Prompt, schema, stdout, stderr and output are evidence, not log
  files.** (D7.) A `logs/` directory beside the checkpoint was rejected:
  the evidence store verifies every read and the ledger verifies every
  reference at append, and a log file has neither. The cost is a second
  copy of a large stdout; accepted, and the 16 MiB decode cap bounds what
  is worth reading.

- **TD7: The scratch directory is under the checkpoint, named in the
  prompt, the shell's temporary directory, and passed to the runtime as
  writable.** (D9.) Each half alone failed a pilot: a scratch path the CLI
  would not allow writes to (D10) and a prompt with no scratch path (D3).
  Keyed by worker id rather than by a role or unit, because no such
  concept exists yet; the role element may choose to share one.

- **TD8: The caller's environment is inherited minus what overrides role
  policy, and the runtime's configuration sources are switched off by
  flag.** (D10.) A clean environment was rejected: authentication and the
  tool path live in the inherited one. Session persistence stays on so a
  transcript exists to read after a timeout.

- **TD9: The version gate is the presence of required flags; the observed
  version is evidence.** (D12.) An exact-version allowlist stopped every
  new user (pilot D2) because the runtimes update faster than any list.

- **TD10: The executable is an absolute path supplied by the caller.**
  (D13.) Resolving `claude` or `codex` through `PATH` inside the adapter
  was rejected: which binary runs is a decision the run should record, not
  one the environment makes at each launch.

- **TD11: The prompt goes through a file on stdin; the schema is compiled
  to draft-07 and checked for portability.** (D14.) Proof-of-concept rules
  that held: a file avoids a pipe race on a process that may not read
  stdin, Claude rejects the 2020-12 schema URI, and a lookaround or
  backreference in a pattern is accepted by one runtime's validator and
  not the other's.

- **TD12: Two events, launched before spawn and finished after, with the
  session id on the first.** (D15.) Recording only a receipt was rejected
  because a worker that never answers would be invisible (pilot D5). The
  launch event carries a free-text label and no role schema, so the role
  element can attach meaning without a new event version.

- **TD13: Timeout kills the process tree with the platform's own tool;
  no third-party process library.** `taskkill /T` and a POSIX process
  group are what the platforms provide, and neither needs a dependency.
  A tree walk through `wmic` or `ps` was rejected as slower and no more
  complete.

## Open Questions

- Does a resumed Claude session with `--json-schema`, and a resumed Codex
  session with `--output-schema`, return structured output under the
  schema? Settled by the smoke run's continuation step. If not, PD1 falls
  back to a fresh worker carrying the earlier response.
- Does a `shell: false` spawn start the Codex launcher on Windows? Settled
  by the smoke run. If not, the caller pins the real executable and the
  design records the path shape that works.
- Can a Codex read-only worker's refused write be recognised from its
  JSONL (a `command_execution` item with a permission error) well enough
  to fill `denials`? Deferred: the design leaves `denials: null` for Codex
  and the question is reopened when a real run needs the evidence.

## Test Strategy

Fakes: `test/helpers/fake-claude.ts` and `test/helpers/fake-codex.ts`,
run through `process.execPath` as the executable and driven by a scenario
name in the environment, print the envelope or JSONL the scenario asks
for, sleep, exit nonzero or spawn a grandchild as instructed. Every case
below runs on all three CI runners.

- R1, R5: one scenario per outcome for each runtime (completed, budget,
  timeout, failed by nonzero exit, failed by malformed JSON, failed by
  schema rejection); the receipt's outcome, termination, session ids and
  error are asserted, and for the timeout case the fake's grandchild is
  proven dead afterwards.
- R2: one test per capability per runtime that lacks it, asserting the
  typed error names the capability and the ledger and scratch directory
  are untouched.
- R3: `worker.launched` exists with the session id before the fake starts
  (the fake blocks until a marker file is written by the test after it
  reads the ledger); a spawn failure (nonexistent executable) leaves a
  launched and a finished event with outcome `failed`.
- R4: preflight fails on a fake whose help lacks one flag and on a version
  output that does not match; the observed version is on the launch event.
- R5 (denials): Claude scenarios with a denial list, with an empty list
  and with the array missing (failed, reason named); a session id other
  than the pinned one (failed); Codex receipts carry `denials: null`.
- R5 (Codex stream): two `thread.started`, an incomplete turn, a
  mismatched final message, a failed item, a nonzero command that is not a
  failure, an MCP item, and a stream above 16 MiB.
- R6: every reference on both events verifies against the evidence store,
  and the bytes equal what the fake printed.
- R7: the scratch directory exists under the checkpoint, the prompt names
  it, `TEMP`, `TMP` and `TMPDIR` in the fake's environment point at it,
  and a Codex read-only worker gets none.
- R8: pins are applied over mixed-case inherited names; an inherited
  thinking override is refused; `WindowsApps` is removed from every
  `PATH` spelling on Windows; the Claude `--settings` object and
  `--setting-sources ''` are in the snapshot.
- R9: a continuation of each runtime produces `--resume` or `exec resume`
  with the same permission and schema flags, and a launch event whose
  `resumes` names the session.
- R10: registering a name twice throws; a test adapter registered under a
  new name runs through the launcher unchanged.
- R11: the fold of `schema-1-01` and `schema-1-02` has empty `workers`;
  `schema-1-03` folds two workers, one finished and one still running; a
  finish without a launch and a duplicate launch are invalid history.
- Command-line snapshots for both adapters, read-only and edit, with and
  without shell, budget and scratch.
- Concurrency: four launchers finishing on one run at once all land
  (`StaleRevisionError` retried).
- R12: `npm run smoke` against the installed CLIs, by hand, on this
  machine; `npm run check` and `npm run verify` green on the three CI
  runners.

## Verification

No checks have run yet. This section is filled by the commit that
completes the element, with the smoke run's observed versions, outcomes,
session ids and cost for each runtime and each continuation, and the CI
run that went green.

## Risks & Migration

- The Claude result envelope and the Codex JSONL stream are not documented
  contracts, and a CLI update can rename a field. Accepted; a decode
  failure is `outcome: failed` with the reason, the bytes are frozen, and
  a fixed engine can re-read them.
- `taskkill /T` can miss a process that has re-parented, and a POSIX group
  kill misses a process that called `setsid`. Accepted; neither was seen in
  any pilot, and the build-server pins remove the known case.
- Claude Code's `--effort` is outranked by its environment variable, so
  both are set; a future CLI may change the precedence. Accepted; the
  preflight records the version and the fake tests pin the argument list.
- Migration: the registry gains two kinds and the golden fixture serial
  advances to `03`. No ledger schema change, no migration step; an older
  ledger folds with empty `workers` (R11). A newer ledger under an older
  engine is refused by the unknown kind, as the checkpoint proposal's D4
  already promises.
