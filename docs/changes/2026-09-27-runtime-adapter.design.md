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
- Found during implementation: `codex exec resume` accepts neither
  `--sandbox` nor `--add-dir`; it takes `--config`, `--model`,
  `--json`, `--output-schema`, `--output-last-message`,
  `--ignore-user-config`, `--ignore-rules` and `--skip-git-repo-check`.
  The directory `codex` resolves into also holds `codex.exe`.
- Found after updating to `codex-cli` 0.157.1: `workspace-write` keeps
  `<worktree>/.git` read-only, and Codex refuses every command of a worker
  given a writable root beneath it ("cannot reopen writable descendants
  under read-only carveouts"), in the elevated and the unelevated Windows
  sandbox alike. Such a refusal leaves no item in the JSONL stream; it is
  logged to stderr as `ERROR codex_core::tools::router: error=exec_command
  failed`. The elevated Windows sandbox, which runs commands as a separate
  sandbox user, needs a one-time setup per machine.

## Design

### Invocation (R1, R2)

`src/runtime/contract.ts` holds the zod schema for an invocation: `runtime`
(a registered name), `executable` (absolute path), `executableArgs`
(literal arguments before the adapter's, empty by default, for a CLI that
runs behind an interpreter such as `node cli.js`), `model`, `effort` (one
of `low`, `medium`, `high`, `xhigh`, `max`), `access` (`read-only` or
`edit`), `shell` (boolean), `prompt`, `outputSchema` (a zod schema),
`timeoutMs` (one second to one hour), and optionally `budgetUsd` (positive,
at most 100), `scratch` (absolute path), `label` (free text for the
ledger) and `resume` (a session id; the prompt is then the follow-up
message). A NUL in any string is refused, and a model or session id that
starts with a dash, which a CLI would read as an option, is refused too.
The output schema must compile to draft-07 with an object at its root.

### Adapter and registry (R2, R4, R10)

`RuntimeAdapter` in `src/runtime/adapter.ts` is `name`, `capabilities`,
`qualification` (the version pattern and the help texts to read, each
with the flags it must mention), `command(invocation, plan)` and
`decode(invocation, plan, outputs)`; the plan is what the launcher
decided (session id, session resumed, scratch directory, compiled schema,
schema and final-message file paths, platform, inherited environment).
`src/runtime/registry.ts` maps a name to its adapter and throws on a
duplicate registration; `src/runtime/runtimes.ts` registers the two the
engine ships, `src/runtime/claude.ts` and `src/runtime/codex.ts`.
Nothing outside them branches on a runtime name.

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

`preflight` in `src/runtime/preflight.ts` runs the adapter's version
probe and every help probe (Claude: `--help`; Codex: `--help`,
`exec --help` and `exec resume --help`) with a ten second timeout and no
model call, matches the version output against the runtime's pattern,
requires every flag the adapter's command uses to appear as a whole flag
in the help text it belongs to, and returns the observed version. A test
holds each adapter's commands to the flags its qualification lists.

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

The command is `--ask-for-approval never exec --ignore-user-config
--ignore-rules --skip-git-repo-check`, `--config sandbox_mode=` with
`"read-only"` or `"workspace-write"` from `access`,
`--config sandbox_workspace_write.writable_roots=` with the scratch
directory only when `access` is `edit`, `windows.sandbox` on Windows (the
adapter's option: `unelevated` by default, which runs on any machine, or
`elevated` through `createCodexAdapter({ windowsSandbox: 'elevated' })`
on a machine with the elevated setup), the config overrides that disable
project docs, skill instructions, web search, apps, plugins, remote
plugins, skill search and skill dependency install, the model,
`model_reasoning_effort`, `--json`, `--output-schema` with the schema
file, `--output-last-message` with the result file, and `-` for stdin. A
continuation is `exec resume` with the same options, then the session and
`-`. The sandbox is a config override rather than `--sandbox` and
`--add-dir` because `exec resume` takes neither flag, and a continuation
has to run under the sandbox of the worker it continues. Every flag is
written in its long form so the preflight checks exactly what runs. `shell:
false`, `effort: max` and `budgetUsd` are refused through the capability
table. On Windows every spelling of `PATH` is merged and directories
containing `WindowsApps` are removed, because the restricted token cannot
launch the Store shell.

### Launcher (R1, R3, R6, R7, R8)

`runWorker(checkpoint, runId, invocation)` in `src/runtime/launcher.ts`
does, in order:

1. Fold the run; refuse an unknown or inactive run.
2. Check the invocation against the adapter's capabilities, and a
   continuation against the worker it continues.
3. Build the command, which may refuse the caller's environment, and
   preflight the executable.
4. Freeze the prompt, with its scratch note appended, and the compiled
   draft-07 schema as evidence.
5. Create the scratch directory: the continued worker's, the caller's, or
   `<os tmpdir>/deep-review-scratch/<checkpoint key>/<workerId>`, the key
   being a digest of the checkpoint root; none for a read-only worker
   whose runtime cannot allow writes to it. One inside the reviewed tree
   or the checkpoint is refused. Write the prompt and schema to
   `<checkpoint root>/io/<workerId>/`.
6. Append `worker.launched`.
7. Open the prompt file as stdin; spawn with `shell: false`, the run's
   worktree as `cwd`, stdout and stderr redirected to files, and the
   environment of the adapter with `TEMP`, `TMP` and `TMPDIR` (forward
   slashes, for Git Bash) pointing at the scratch directory and
   `MSBUILDDISABLENODEREUSE=1`,
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
11. Remove the process files, which are all evidence now, and return the
    receipt.

A failure at step 7 (the process never starts) still runs steps 9 to 11
with outcome `failed` and termination `not-started`, and so does a
failure of the launcher itself after step 6, so the ledger never holds a
launched worker without a finish from this launcher. The one exception is
a run abandoned while its worker ran: it accepts no finish, and
`runWorker` throws `RunClosedError` with the evidence already frozen. A
failure before step 6 appends nothing.

### Receipt and decoding (R5)

The receipt has `process` (exit code, signal, `termination` of `exited`,
`killed` or `not-started`, `startedAt`, `endedAt`), `runtime` (name,
observed version, session ids, usage as the runtime reported it),
`denials` (an array of tool and detail, or `null` when the runtime gives
no evidence either way), `output` (validated data or `null`), `outcome`
(`completed`, `budget`, `timeout` or `failed`), `error` (message or
`null`) and `evidence` (every reference the two events hold).

Claude decoding requires a `result` envelope with `subtype: success`,
`is_error: false`, a `structured_output` field and a `permission_denials`
array; the envelope's `session_id` must equal the pinned or resumed one;
`terminal_reason: budget_exhausted` or a `subtype` starting with
`error_max_budget` is outcome `budget`. Codex decoding parses every JSONL
line, requires no `exec_command failed` router error on stderr (a sandbox
that could not run commands at all, which the stream does not show),
exactly one `thread.started` (its id is the session, and on a
continuation the session continued), exactly one `turn.completed` as the
last event, no `error` or `turn.failed` event, no `mcp_tool_call` or
`web_search` item, no item left started without completing, no failed
item other than a command with a nonzero exit code, and a final message
file equal to the last `agent_message`; `denials` is `null`. stdout,
stderr and the final message are refused for decoding above 16 MiB and are
still frozen as evidence. A denial never changes the outcome; a budget
stop is not `failed`; a rejected schema, a nonzero exit without a budget
stop or a decode failure is `failed` with the reason. A session id the
ledger's session id pattern cannot hold is named in the error and left off
the record, so a finish can always be appended.

### Ledger events and fold (R3, R11)

`worker.launched@1` carries the worker id, label, runtime, executable,
observed version, model, effort, access, shell, session id or null, the
session resumed or null, scratch or null, budget or null, timeout, and the
prompt and schema as artifact references. `worker.finished@1` carries the
worker id, outcome, exit code, signal, termination, start and end, session
ids, usage as JSON text (so nothing a runtime prints can be mistaken for
an artifact reference), denials, error, stdout and stderr as references,
the runtime's final message file as a reference or null, and the
validated answer as JSON, a reference present exactly when the outcome is
`completed`. Both are declared in `src/checkpoint/events.ts`
and reduced in `src/checkpoint/fold.ts`. `RunState` gains `workers`, keyed
by id, each `running` (launch only) or `finished` (launch and receipt). A
finish without a launch, a second finish, or a second launch with the
same id, is invalid history. A run created before this element folds with an empty `workers`.
Golden fixture `schema-1-03` is added; `schema-1-01` and `schema-1-02`
stay.

### Smoke script (R12)

`scripts/smoke-runtime.ts`, run as `npm run smoke -- --claude <path>
--codex <path> --codex-model <model>`, opens a checkpoint in a temporary
repository, runs one prompt through each given CLI, continues each session
once, and prints every receipt's outcome, version, session ids, answer,
denials and usage. Both prompts ask the worker to create a file in the
repository with its shell, so the run also shows whose read-only mode
stops the write, fresh and continued. It is not part of `npm run check`.

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

- **TD7: The scratch directory is outside the reviewed tree and the git
  directory, named in the prompt, the shell's temporary directory, and
  passed to the runtime as writable.** (D9.) Each half alone failed a
  pilot: a scratch path the CLI would not allow writes to (D10) and a
  prompt with no scratch path (D3). Keyed by worker id rather than by a
  role or unit, because no such concept exists yet; the role element may
  choose to share one. Amended in implementation: the reviewed design put
  it under the checkpoint, which in a main worktree is inside `.git`, and
  Codex refuses every command of a worker whose writable root is there. It
  now defaults to the system's temporary directory for every runtime,
  under a key per checkpoint. What is given up is keeping a worker's
  leftovers beside its evidence; a scratch directory was never evidence,
  and the system may clean it.

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

- Settled: a resumed Claude session with `--json-schema` and a resumed
  Codex session with `--output-schema` both return structured output under
  the schema (Verification). PD1 stands.
- Settled: the caller pins `codex.exe`, the real executable beside the
  `codex` launcher, and a `shell: false` spawn starts it (Verification).
- Open: Claude Code reports a resumed session's `total_cost_usd` for the
  whole session, not the continuation alone (Verification). Whether
  `--max-budget-usd` on a continuation is also measured against the whole
  session is unverified; the role element, which sets continuation
  budgets, settles it before relying on one.
- Can a Codex read-only worker's refused write be recognised from its
  JSONL (a `command_execution` item with a permission error) well enough
  to fill `denials`? Deferred: the design leaves `denials: null` for Codex
  and the question is reopened when a real run needs the evidence.

## Test Strategy

Fakes: `test/helpers/fake-claude.ts` and `test/helpers/fake-codex.ts`,
run through `process.execPath` as the executable with the fake as its
argument and steered by `FAKE_*` variables in the environment, print the
envelope or JSONL they are given, wait for a marker, exit nonzero or
spawn a grandchild as instructed. Every case
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
  reads the ledger); a spawn failure (nonexistent executable, with the
  preflight replaced, since the real one refuses it first) leaves a
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
- R7: the scratch directory exists under the scratch root, the prompt
  names it, `TEMP`, `TMP` and `TMPDIR` in the fake's environment point at
  it, and a Codex read-only worker gets none; in a real main worktree the
  default is outside both the worktree and the git directory; one inside
  the tree or the checkpoint is refused.
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
  machine, including an editor per runtime that must write in the tree
  and in its scratch directory; `npm run check` and `npm run verify` green
  on the three CI runners.

## Verification

Run on the author's Windows 11 machine on 2026-09-27, Node 26.10.0,
against the commits of this element up to the smoke script.

- `npm run check`: lint, typecheck and every test pass, with 3 skipped
  (symlink cases that need a privilege this Windows account lacks,
  skipped before this element too). `npm run verify`: both artifacts
  match `dist/`.
- Continuous integration, pull request #1: run 36283803500 at `aa9497d`
  passed `npm run check` and `npm run verify` on ubuntu-latest,
  windows-latest and macos-latest, so the POSIX process-group kill, the
  grandchild tests and the four-launcher test pass on Linux and macOS
  too. The run before it, 36283092466, failed one assertion on macOS
  only: the test sandbox's temporary directory was under `/var`, a
  symlink to `/private/var`, and a worker's own cwd reports the resolved
  path. The sandbox now canonicalizes its directory, as `locateCheckpoint`
  does for a real worktree; the launcher did not change.
- Tests were checked to fail when the behavior they guard is removed:
  killing only the root at a timeout fails both grandchild tests (which
  is why the fake's grandchild is detached on Windows: libuv's job object
  otherwise kills it with its parent whatever the launcher does);
  pinning environment variables without removing other spellings fails
  the environment test; allowing one append attempt fails the
  four-launcher test every time; keeping the process files when the
  launch append is refused fails its test.
- First smoke, with `codex-cli` 0.147.0 and read-only workers only:
  `npm run smoke -- --claude C:\Users\josep\.local\bin\claude.exe
  --codex C:\Users\josep\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe
  --codex-model gpt-5.5`, effort `low`, repository kept at
  `%TEMP%\deep-review-smoke-ewBRl6`.

  | Runtime | Step | Outcome | Session | Seconds | Shell write | Cost |
  |---|---|---|---|---|---|---|
  | claude 2.1.283, haiku | first | completed | 32827e5b-c047-40dd-b02c-d1b7d166a96e | 7.4 | succeeded | 0.0079 USD |
  | claude 2.1.283, haiku | continuation | completed | the same, resumed | 5.7 | succeeded | 0.0127 USD, whole session |
  | codex-cli 0.147.0, gpt-5.5 | first | completed | 01a0e026-f88b-7cf0-bb1d-e58c1a60be63 | 10.7 | denied | 22238 input tokens |
  | codex-cli 0.147.0, gpt-5.5 | continuation | completed | the same, resumed | 6.9 | denied | 45580 input tokens |

  Both Claude receipts had an empty denial list; both Codex receipts had
  `denials: null`. Each continuation returned an answer under the schema,
  and `thread.started` on `exec resume` carried the resumed id. The
  frozen Codex streams show the write command exiting 1 with
  `UnauthorizedAccessException`, fresh and continued, so the
  `--config sandbox_mode="read-only"` override holds under both. The
  Claude write succeeding is PD3 as accepted: Claude Code has no
  read-only sandbox for the shell.
- An earlier smoke run with `--codex-model gpt-6-astra`, the model in the
  author's Codex config, failed both Codex workers with the runtime's
  error on the receipt ("requires a newer version of Codex"), the thread
  id kept, and the continuation run against that thread: the failure
  path working on a real runtime.
- After updating Codex to 0.157.1 and setting up its elevated Windows
  sandbox, a probe with an editor found that no Codex editor could run a
  command (Context), while its receipt said `completed`: the smoke had
  never started an editor. Two fixes followed, each with a test that
  failed before it: the default scratch directory moved out of the git
  directory (TD7), and a stderr router refusal now fails the worker. The
  smoke gained an editor step that must write `edit.txt` in the tree and
  `scratch.txt` in its scratch directory, and a
  `--codex-windows-sandbox` flag.
- Second smoke, `codex-cli` 0.157.1 with `gpt-6-astra`: `npm run smoke --
  --claude <as above> --codex <as above> --codex-model gpt-6-astra
  --codex-windows-sandbox elevated` (repository
  `%TEMP%\deep-review-smoke-NllRoT`), then Codex alone with the default
  unelevated sandbox (`%TEMP%\deep-review-smoke-RiGuzJ`). Every worker
  completed and every editor wrote both files.

  | Runtime | Sandbox | Step | Session | Seconds | Shell write | Cost |
  |---|---|---|---|---|---|---|
  | claude 2.1.283, haiku | none | first | 253cbf17-1923-4b30-b0d6-755862f58569 | 8.0 | succeeded | 0.0074 USD |
  | claude 2.1.283, haiku | none | continuation | the same, resumed | 5.6 | succeeded | 0.0120 USD, whole session |
  | claude 2.1.283, haiku | none | editor | c0288e3f-625b-4976-b3aa-a606cc27747e | 16.0 | both files | 0.0348 USD |
  | codex-cli 0.157.1, gpt-6-astra | elevated | first | 01a0e03b-d602-7c61-a831-12da49a23c62 | 8.3 | denied | 28355 input tokens |
  | codex-cli 0.157.1, gpt-6-astra | elevated | continuation | the same, resumed | 10.1 | denied | 57466 input tokens |
  | codex-cli 0.157.1, gpt-6-astra | elevated | editor | 01a0e03c-1f96-7ee2-ab5b-89b13f456b1e | 12.7 | both files | 29646 input tokens |
  | codex-cli 0.157.1, gpt-6-astra | unelevated | first | 01a0e03c-6dc4-73b1-99d0-dba63b4fb595 | 12.9 | denied | 28661 input tokens |
  | codex-cli 0.157.1, gpt-6-astra | unelevated | continuation | the same, resumed | 9.4 | denied | 58678 input tokens |
  | codex-cli 0.157.1, gpt-6-astra | unelevated | editor | 01a0e03c-c5c9-72f2-91bb-90a359ccf897 | 11.9 | both files | 29748 input tokens |

  The frozen Codex streams show each read-only write command exiting 1
  with a permission error, fresh and continued, and both editor commands
  exiting 0, under both sandboxes. Claude Code writes a `claude`
  directory of its own into the scratch directory, since `TEMP` names it.

Changes from the reviewed design, each also made in the section it
changes:

- The Codex sandbox and writable roots are `--config` overrides, not
  `--sandbox` and `--add-dir`, and the preflight reads `exec resume
  --help` too, because `exec resume` takes neither flag.
- The invocation gained `executableArgs` for a CLI behind an
  interpreter. The fakes run that way, and so does an npm-installed
  Claude Code on Windows, whose `claude.cmd` cannot be spawned without a
  shell.
- An adapter declares a `qualification` recipe instead of a
  `preflight(executable)` method, so the adapter stays free of processes
  (TD1) and one preflight serves every runtime.
- `termination` gained `not-started` for a spawn that failed; recording
  a process that never existed as `exited` would be false.
- The finish holds the runtime's final message file and the validated
  answer as two references: the first is what a later engine re-decodes,
  the second what a later phase reads. Usage is JSON text.
- A continuation must keep its runtime, model, effort, access, shell,
  schema and scratch directory, and may not start while another worker
  runs in the session. Its budget and timeout are its own, since it is a
  new process with its own spend.
- An explicit scratch directory for a read-only worker on a runtime that
  cannot allow it is refused through the capability table
  (`readOnlyScratch`); without one the worker gets none (R7). No
  invocation asks for a session id to be assigned before launch, so that
  capability decides whether the launcher pins one and is never refused.
- The default scratch directory is under the system's temporary directory,
  not the checkpoint (TD7), and a scratch directory inside the checkpoint
  is refused.
- The Codex Windows sandbox is an adapter option, `unelevated` by
  default, instead of a pin: the adapter ignores the user's Codex config,
  and which sandbox a machine can run is a property of the machine.
- A Codex worker whose sandbox could not run a command, seen only on
  stderr, is `failed`: it never had the shell its answer assumes.

## Risks & Migration

- The Codex router refusal is recognised by one stderr log line, which is
  not a documented contract; a changed log format would let such a worker
  pass as `completed` again. Accepted; the smoke's editor step, which
  fails when an editor cannot write, is the check that catches it.
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
