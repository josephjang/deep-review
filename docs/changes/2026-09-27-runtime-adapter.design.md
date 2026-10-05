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
- Found in review, with `codex-cli` 0.157.1: a `--config` key Codex does
  not know is ignored without a word, so a key renamed by an update would
  silently stop switching its source off. Under `--strict-config` the
  same key makes `exec` and `exec resume` alike exit 1 before reading
  stdin, starting no thread, with ``Error loading config.toml: unknown
  configuration field `<key>` in -c/--config override`` on stderr, and an
  unknown feature name under `features` is refused the same way. Every
  key the adapter passes is accepted under it, and a project
  `.codex/config.toml` with unknown fields did not trip it. A known key
  with an unknown value, such as `web_search="nope"`, is refused with or
  without it, as Claude Code refuses an unknown `--permission-mode`.
  Whether 0.147.0 had the flag was not checked; a Codex without it is
  refused by the preflight, naming the flag.

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
The output schema must compile to draft-07 with an object at its root,
and every object in it must be closed and list each of its properties as
required, which Codex's strict structured output demands: a field that may
be absent is written `.nullable()`, and an optional field, a record or a
loose object is refused before anything runs, naming the object by its
JSON Pointer.

### Adapter and registry (R2, R4, R10)

`RuntimeAdapter` in `src/runtime/adapter.ts` is `name`, `capabilities`,
`qualification` (the version pattern and the help texts to read, each
with the flags it must mention), `command(invocation, plan)` and
`decode(invocation, plan, outputs)`; the plan is what the launcher
decided (session id, session resumed, scratch directory, compiled schema,
schema and final-message file paths, platform, inherited environment),
and the outputs are stderr, the final message, and stdout both whole (or
`null` above the decode cap) and as lines decoded one at a time, so an
adapter that reads a stream by line never needs it as one text.
`decode` returns the session ids the outputs named, usage, denials, and
exactly one result: an answer, a budget stop with its reason, or a
failure with its reason, so no adapter can report an answer and an error
at once.
(Amended 2026-10-05, by the Codex sandbox change,
`2026-10-04-codex-sandbox.design.md`.) The plan also carries `runtimeOptions`,
what a run pinned for the worker's runtime, which the launcher takes
from its `pinned` option by the adapter's name and the adapter applies
over the options it was built with: today the Codex Windows sandbox,
which the Codex adapter validates and Claude Code's ignores.
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
`exec --help` and `exec resume --help`) with no model call and empty
stdin, killing a probe with its process tree, as a worker is killed,
once it runs past ten seconds or prints more than 4 MiB, or when the
engine exits or, on POSIX, is interrupted while the probe runs; it
matches the version output against the runtime's pattern, requires
every flag the adapter's command uses to appear as a whole flag in the
help text it belongs to, and returns the observed version. A test
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
is refused by name. On Windows, where the CLI reads every spelling of a
name as one variable, names compare case-insensitively, so no spelling can
hide an override; elsewhere a name differing in case is another variable
the CLI never reads, and it is left alone. The variables a running Claude
Code session sets for the processes it starts (`CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and the rest of
`claudeSessionMarkers`) are dropped rather than refused: they describe
the enclosing session, not the worker, and refusing them would stop every
worker of an engine started inside Claude Code. Authentication and
provider variables stay.

`--setting-sources ''` also switches off what only the user's settings
hold: a credential helper (`apiKeyHelper`, `awsAuthRefresh`,
`awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper`) and the
settings `env` block, where a Bedrock, Vertex or gateway setup often
keeps its provider variables. The preflight needs no credential, so such
a machine would qualify and then fail every worker at authentication.
`createClaudeAdapter({ settings })` takes those keys and `env`, and
nothing else: an unknown key, `otelHeadersHelper` (telemetry, not a
credential) and a key the isolation sets are refused by name when the
adapter is built, and every value must be a string. They are merged into
the `--settings` object for a fresh worker and a continuation alike,
with `autoMemoryEnabled` and `claudeMdExcludes` written last so they
always win; with no settings the object is the one above, byte for byte.
Claude Code sets the `env` block in its own environment, over the one
the launcher gave it, so a name there that is a thinking override,
`CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, a session
marker or one of the launcher's pins (`TEMP`, `TMP`, `TMPDIR` and the
build-server pins) is refused before anything is recorded, spelled as
the platform reads it: any spelling on Windows, the exact name
elsewhere. `defaultRuntimes({ claude: { settings } })` passes them
through.

A command line the platform would not start is refused before anything
is recorded or run: on Windows the whole line, quoted as libuv quotes it,
may be at most 32766 characters, and on POSIX each argument at most
131071 bytes. The compiled schema travels as one argument, so a large
output schema is what reaches the limit, and the refusal says so; the
adapter's settings travel as another and are counted too, and a
`--settings` value too large names the settings as the remedy.

### Translation, Codex (R7, R8, R9)

The command is `--ask-for-approval never exec --ignore-user-config
--strict-config --ignore-rules --skip-git-repo-check`,
`--config sandbox_mode=` with `"read-only"` or `"workspace-write"` from
`access`, `--config sandbox_workspace_write.writable_roots=` with the
scratch directory only when `access` is `edit`, `windows.sandbox` on Windows (the
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
written in its long form so the preflight checks exactly what runs.
`--strict-config` makes Codex refuse a `--config` key it does not know,
which it otherwise ignores: a key an update renamed would silently stop
switching its source off, and the worker would run with that source on.
Under it such a key fails the worker before the model is called. `shell:
false`, `effort: max` and `budgetUsd` are refused through the capability
table. On Windows every spelling of `PATH` is merged and every directory
that is or lies under a `WindowsApps` directory is removed, judged by
whole path segments so that `D:\tools\mywindowsapps` stays, because the
restricted token cannot launch the Store shell.

`--ignore-user-config` also drops the user's `model_provider` and
`[model_providers.*]`, while the credentials under `CODEX_HOME` still
load: a machine set up for Azure or a gateway would fail every worker,
or, where those credentials also work for OpenAI, send the reviewed code
to OpenAI instead. `createCodexAdapter({ provider })` takes a provider
as `{ id, baseUrl, envKey?, queryParams? }`, checked when the adapter is
built: `id` is lowercase letters, digits, `_` and `-`, so it is a bare
TOML key; `baseUrl` parses as an http or https URL without a user name
or password, since a command line is visible to every process;
`envKey` is an environment variable name, the variable Codex reads the
API key from, so the key itself never reaches the command line;
`queryParams` is an object of strings, such as Azure's `api-version`;
and an unknown key is refused by name, as an unknown option is. After
the isolation overrides come `--config model_provider=`,
`model_providers.<id>.name`, `.base_url`, `.env_key` when given and
`.query_params` as an inline table when given, for a fresh worker and a
continuation alike. Every value is a TOML basic string: JSON's escapes,
plus DEL, which JSON leaves bare and TOML does not; a lone surrogate,
which no TOML string can hold, is refused. `--strict-config` accepts
each of these keys on 0.157.1, and a custom provider there sent its
requests to the given URL; an unset `envKey` variable fails the turn by
name, and a built-in id such as `openai` is refused by Codex itself
before any thread starts.
`defaultRuntimes({ codex: { provider } })` passes it through.

### Launcher (R1, R3, R6, R7, R8)

`runWorker(checkpoint, runId, invocation)` in `src/runtime/launcher.ts`
does, in order:

1. Fold the run; refuse an unknown or inactive run.
2. Check the invocation against the adapter's capabilities, and a
   continuation against the worker it continues: the session must be one
   a worker of the run ran under, no worker may still be running in it,
   some worker of it must have started (a pinned id is on the ledger
   before the process exists, so a session whose every worker failed to
   start has no conversation to resume), and the runtime, model, effort,
   access, shell, schema and scratch directory must be kept, the scratch
   directory compared as resolved. `continuationFields` classifies every
   field of `worker.launched` as kept or the continuation's own, so a
   field added to the launch does not compile until it is classified.
3. Build the command, which may refuse the caller's environment, a
   variable the adapter's settings would set over a pin, or a command
   line too long for the platform, and preflight the executable.
4. Freeze as evidence the prompt, with its scratch note appended, the
   compiled draft-07 schema, and the empty blob a finish records for an
   output the launcher could not freeze, so recording a finish never has
   to write to the evidence store.
5. Create the scratch directory, chosen in `src/runtime/scratch.ts`: the
   continued worker's, the caller's, or
   `<os tmpdir>/deep-review-scratch/<checkpoint key>/<workerId>`, the key
   being a digest of the checkpoint root; none for a read-only worker
   whose runtime cannot allow writes to it. One inside the reviewed tree
   or the checkpoint is refused. Containment is judged by whole path
   segments, so a sibling named `..tmp` is outside and a child named
   `..tmp` inside, after every link, junction and short name of the
   longest existing ancestor of both paths is resolved, so an alias
   cannot lead into either. Write the prompt and schema to
   `<checkpoint root>/io/<workerId>/`, a directory that must not exist
   yet: one that does is another worker's, and the launch is refused.
6. Append `worker.launched`.
7. Open the prompt file as stdin; spawn with `shell: false`, the run's
   worktree as `cwd`, stdout and stderr redirected to files, and the
   environment of the adapter with `TEMP`, `TMP` and `TMPDIR` pointing at
   the scratch directory (`TMPDIR` with forward slashes on Windows, for
   Git Bash, and as it is elsewhere, where a backslash is an ordinary
   filename character) and `MSBUILDDISABLENODEREUSE=1`,
   `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `UseSharedCompilation=false` and
   `UseRazorBuildServer=false` set. On Windows each replaces every
   inherited spelling of its name, since a Windows environment has one
   variable per name whatever its case and Node passes a child only one
   spelling of it; elsewhere each replaces its exact name, and a variable
   differing only in case is another variable, left alone.
8. Wait for exit or timeout. On timeout, kill the tree: `taskkill /PID
   <pid> /T /F` on Windows; on POSIX the child was spawned as its own
   process group and the group receives `SIGKILL`. When the tree cannot
   be reached (`taskkill` fails, or the group cannot be signalled) the
   root alone is killed and the timeout error says so, with why, since
   descendants may still run. A process that exited on its own as the
   timer fired is recorded as exited, and a pid Node has seen exit is
   never signalled, since it may name another process by then. While a
   worker runs, the engine's own exit also kills its tree, and on POSIX
   so do `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGQUIT`, which a worker in
   its own process group never receives from the terminal; the signal
   then ends the engine as it would have, unless the engine handles that
   signal itself. An engine killed outright runs no listener.
9. Freeze stdout, stderr and the final message as evidence, then decode
   them through the adapter. The pinned or continued session id is
   recorded on every finish: the launcher adds it to the ids the adapter
   read from the outputs, which are all an adapter reports.
10. Append `worker.finished`, retrying on `StaleRevisionError` by
    re-folding (several launchers may finish on one run at once).
11. Remove the process files, which are all evidence now, and return the
    receipt.

A failure at step 7 (the process never starts) still runs steps 9 to 11
with outcome `failed` and termination `not-started`, and so does a
failure of the launcher itself after step 6, so the ledger never holds a
launched worker without a finish from this launcher. Such a finish keeps
everything settled before the failure: the outputs already frozen, and
every session id already decoded. An output the launcher could not freeze
is recorded as the empty blob of step 4, its process file is the only
copy, and the process files stay, named in the error. The one exception
is a run abandoned while its worker ran: it accepts no finish, and
`runWorker` throws `RunClosedError` with the evidence already frozen and
the process files removed. A failure before step 6 appends nothing,
removes the process files, and removes the scratch directory the call
created for the worker; a caller's or a continued worker's scratch
directory, and the roots above one, stay.

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
`error_max_budget` is outcome `budget`; the envelope is read whole, so a
stdout above the decode cap fails the worker, naming the cap. Codex
decoding reads the JSONL stream in one pass, a line at a time, parsing
every line and keeping only the facts its rules need, and requires no
`exec_command failed` router error on stderr (a sandbox that could not
run commands at all, which the stream does not show), exactly one
`thread.started` (its id is the session, and on a continuation the
session continued; when none started, the reason quotes the last 1000
characters of stderr, where Codex says why it refused its command line,
such as a `--config` key it does not know), exactly one
`turn.completed` as the last event, no `turn.failed` event, no
`mcp_tool_call` or `web_search` item, no item left started without
completing, no failed item other than a command that ran and exited
nonzero or a file change that did not apply (the model saw either and
could work around it), and a final message file equal to the last
`agent_message`; `denials` is `null`. A turn that completed is judged
by its answer: an `error` event, which is how Codex reports a stream
reconnect it survived, and an `error` item, a warning, do not fail it,
and their text stays in the frozen stdout. The last `error` event is
named in the reason of a turn that did not complete. Every rule is
applied only after the whole stream is read, so a malformed later line
cannot hide the thread an earlier one started. A Codex stream has no
size limit, since one command can print more than any cap and its
answer is still worth judging; a single line above 64 MiB is not
decoded, and is a malformed line. stderr, the final message, and a
stdout read whole (Claude's) are not decoded above 16 MiB and are still
frozen as evidence; the session ids are still read from the outputs
with stderr and the final message cut to 16 MiB, and from every stdout
line, so a worker whose output ran long can be continued.

The launcher decides the outcome in a fixed order: a process that never
started is `failed`; one killed at its timeout is `timeout`, its error
saying whether the whole tree or only the root was killed; then the
adapter's result, a budget stop being `budget` and a failure `failed`
with its reason; then an answer from a process that exited nonzero or by
a signal is `failed`; then the answer is checked against the schema. A
denial never changes the outcome. A decoder that throws is `failed` with
what it threw. A session id the ledger's session id pattern cannot hold
is named in the error and left off the record, so a finish can always be
appended, and an answer is then not recorded: a completed worker becomes
`failed`, since the session its answer belongs to could not be recorded.

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
`completed`. Two rules of that shape are part of the version-1 schemas,
checked when an event is appended and when a ledger is read: a finish
holds `output` exactly when it is `completed`, and a launch that resumes
a session runs under it, its `sessionId` equal to `resumes`. The effort
and access values of `worker.launched@1` are written out in its schema
rather than taken from the invocation contract's enums, so a level the
contract gains later cannot change what version 1 accepts. Both events
are declared in `src/checkpoint/events.ts` and reduced in
`src/checkpoint/fold.ts`. `RunState` gains `workers`, keyed
by id, each `running` (launch only) or `finished` (launch and receipt). A
finish without a launch, a second finish, or a second launch with the
same id, is invalid history. A run created before this element folds with an empty `workers`.
Golden fixture `schema-1-03` is added; `schema-1-01` and `schema-1-02`
stay.

### Smoke script (R12)

`scripts/smoke-runtime.ts`, run as `npm run smoke -- --claude <path>
--codex <path> --codex-model <model>` with an optional
`--codex-windows-sandbox elevated`, opens a checkpoint in a temporary
repository and runs three workers through each given CLI: a read-only
worker, its session continued once, and an editor. It prints every
receipt's outcome, version, session ids, answer, denials and usage. The
two read-only prompts ask the worker to create a file in the repository
with its shell, so the run also shows whose read-only mode stops the
write, fresh and continued; the editor must write one file in the
repository and one in its scratch directory. The smoke fails unless
every worker completes and every editor writes both files. A worker the
launcher refuses fails its runtime without stopping the other, and the
repository and checkpoint are kept and their path printed whatever
happened. It is not part of `npm run check`.

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
  copy of a large stdout; accepted. Amended after review: the reviewed
  design capped what is decoded at 16 MiB per output, which threw away a
  paid, valid Codex answer whose stream ran past it on one large command
  output. A Codex stream is now read a line at a time with no limit on its
  length, which keeps every rule of its decoding, and only a single line
  above 64 MiB goes undecoded. Raising the cap was rejected: decoding the
  whole stream as one text and one array of events grows the heap with the
  stream, and an engine killed for memory appends no finish. Claude's
  envelope, one JSON value, and stderr and the final message keep the
  16 MiB cap.

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
  transcript exists to read after a timeout. Amended after review: the
  inherited environment is not where every machine keeps its
  credentials. Claude Code's credential helpers and settings `env`, and
  Codex's model providers, live in the configuration the flags switch
  off, so each adapter takes them as an explicit, allowlisted option
  from the engine's caller, the way it takes the Windows sandbox.
  Rejected: reading the user's settings file and forwarding its
  credential keys, which re-implements each CLI's config location and
  precedence, and which for a project or local file would run a
  repository's own helper; a generic `--config` or settings passthrough
  with a denylist, which leaks every key the list does not yet name; and
  loading the user's configuration again with each isolation key
  overridden, which reopens isolation to every new source a CLI adds.

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
  backreference in a pattern, a `patternProperties` key included, is
  accepted by one runtime's validator and not the other's. Codex sends
  the schema to the model in strict mode, which refuses an object that
  allows properties it does not list or leaves one optional. One runtime
  refuses it, so it is refused everywhere: a schema that compiles is one
  every runtime takes, and a worker is never failed for its runtime
  alone.

- **TD12: Two events, launched before spawn and finished after, with the
  session id on the first.** (D15.) Recording only a receipt was rejected
  because a worker that never answers would be invisible (pilot D5). The
  launch event carries a free-text label and no role schema, so the role
  element can attach meaning without a new event version.

- **TD13: Timeout kills the process tree with the platform's own tool;
  no third-party process library.** `taskkill /T` and a POSIX process
  group are what the platforms provide, and neither needs a dependency.
  A tree walk through `wmic` or `ps` was rejected as slower and no more
  complete. The same kill serves the preflight's probes and the engine's
  own exit: every worker and every probe is tracked while it runs and
  killed with its tree when the engine exits or, on POSIX, is
  interrupted, so a wrapper CLI's child, a worker or a probe outliving
  the engine is not left running either. The kill, `taskkill` included, runs
  synchronously, so the event loop cannot see the process exit and free
  its pid between the check that it still runs and the signal; the price
  is that the loop waits for `taskkill`, at most its ten second limit.

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
- Deferred: a runtime-neutral view of usage. The receipt and the finish
  keep usage as each runtime reports it, and nothing outside an adapter
  reads its shape; the smoke script prints it raw. A neutral view now
  would fix two meanings before anything consumes them, and the second
  smoke run shows both are unlike across the runtimes: a Claude
  continuation's `total_cost_usd` (0.0120 USD) and `modelUsage` cover the
  whole session while its top-level `usage` covers this process alone
  (17 input and 261 output tokens against 34 and 692), and Claude's
  `input_tokens` excludes cached tokens (17, beside 18498 read from and
  1682 written to the cache) while Codex's includes them (29646, of which
  14464 cached). Summing either naively double-counts or compares unlike
  numbers. The target, when the role element adds the first consumer of
  cost and settles what a continuation costs: a pure
  `RuntimeAdapter.summarizeUsage(recorded)` over
  `JSON.parse(finish.usage)`, so a live receipt and a replayed ledger are
  read by one decoder and the version-1 events stay as they are.
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
  mismatched final message, a failed item of an unknown kind, a nonzero
  command and a failed patch that are not failures, an `error` event and
  an `error` item in a completed turn that are not failures, a
  `turn.failed` that is, an MCP item, a completed turn whose stream is
  above 16 MiB because one command printed that much, a line above 64
  MiB whose thread is still recorded, CRLF line endings and an empty
  stream; a Claude stdout above 16 MiB is failed by name.
- R5 (outcome): the launcher's decision is tested alone for every
  result and process ending, including a timeout whose tree kill reached
  only the root; on Windows a timeout run with `taskkill` made unreachable
  shows that error on the receipt while the descendant still runs.
- R6: every reference on both events verifies against the evidence store,
  and the bytes equal what the fake printed.
- R7: the scratch directory exists under the scratch root, the prompt
  names it, `TEMP`, `TMP` and `TMPDIR` in the fake's environment point at
  it, and a Codex read-only worker gets none; in a real main worktree the
  default is outside both the worktree and the git directory; one inside
  the tree or the checkpoint is refused.
- R8: pins are applied over mixed-case inherited names on Windows and
  over the exact name elsewhere, where a case variant is kept; an
  inherited thinking override is refused, in any spelling on Windows only;
  an enclosing Claude Code session's markers are dropped; `WindowsApps`
  is removed from every `PATH` spelling on Windows; the Claude
  `--settings` object and `--setting-sources ''` are in the snapshot.
  Adapter options: the `--settings` value is unchanged without settings
  and merges given settings under the isolation keys; an unknown or
  isolation key and each reserved `env` name are refused, in any spelling
  on Windows only; a Codex provider is in the fresh and the continued
  command, each malformed field is refused, odd values are escaped as
  TOML; `defaultRuntimes` passes both options on, and the fakes receive
  them through the launcher.
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
- Changes after review of the pull request: a Codex `error` event or
  `error` item, or a failed patch, no longer fails a turn that completed;
  environment names compare case-insensitively on Windows only, and
  `TMPDIR` gets forward slashes on Windows only; an enclosing Claude Code
  session's markers are dropped, and a command line too long for the
  platform is refused before launch; the tree is also killed when the
  engine exits or, on POSIX, is interrupted, the preflight's probes are
  killed with their trees at their limits and when the engine exits or is
  interrupted, and a timeout that reached only the root says so;
  scratch containment resolves links and compares whole segments; a
  refused launch leaves no process files or scratch directory of its own;
  a finish is appended even when the evidence store fails, keeping what
  was already settled; the pinned session id is added by the launcher to
  every finish; a session no worker of which started cannot be
  continued; and the version-1 worker schemas hold the output and
  continuation rules above.
- Also after review: Codex runs under `--strict-config`, so a `--config`
  key it does not know fails the worker instead of being ignored, and a
  Codex that started no thread is failed with the end of its stderr in
  the reason (Context); an output schema must be closed with every
  property required, which Codex's strict structured output demands, and
  a `patternProperties` key is held to the pattern rules (TD11); every
  field of `worker.launched` is classified for a continuation in one
  table, kept or its own, and a continuation may run under another
  qualified executable of the same runtime.
- Also after review: `createClaudeAdapter({ settings })` takes Claude
  Code's credential helpers and a settings `env` block, and
  `createCodexAdapter({ provider })` a model provider, both explicit and
  allowlisted, because the switched-off user configuration was the only
  place such a machine kept them (TD8, R8); `defaultRuntimes` takes
  `claude` options beside `codex`. A Codex `--config` string now escapes
  DEL and refuses a lone surrogate.
- Also after review: a Codex stream is decoded a line at a time and is no
  longer refused above 16 MiB, so a completed turn is judged by its answer
  however much its commands printed (TD6); a Claude stdout above 16 MiB
  is failed by the Claude adapter, naming the cap, instead of by the
  launcher. The smoke script prints usage as the runtime reported it and
  no longer reads a cost out of it (Open Questions).

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
- `taskkill` can fail outright, such as with access denied to a
  descendant running as the elevated Codex sandbox's user; the root is
  then killed alone. Accepted; the timeout error names the failure and
  says descendants may still run, so the receipt does not claim a tree
  kill that did not happen.
- A Codex stream has no size limit: the launcher reads all of stdout into
  memory as bytes, as it always did to freeze it, and decodes one line at a
  time, so memory grows with the stream's bytes but not with a text and an
  array of events for all of it. Accepted; a stream too large for memory
  would also be too large to freeze as evidence.
- Claude Code has no strict mode for the keys of its `--settings`
  object: a key a Claude Code update renamed would be ignored without a
  word, and the source it switched off would come back on. Accepted;
  Claude Code offers no flag that refuses one, and the recorded version
  says which CLI ran.
- A managed Codex configuration with a field this Codex does not know now
  fails every Codex worker under `--strict-config`, loudly, with Codex's
  message in the reason. Accepted: a worker that fails with its cause
  named is better than one whose isolation lapsed unnoticed.
- The Codex provider and the Claude settings are not on the ledger:
  `worker.launched` version 1 is frozen and has no field for them, so a
  worker's record does not say which provider or credential helper it
  ran with, and a continuation is not held to its worker's. A
  continuation runs with the options of the adapter it is given, which
  the caller builds; nothing reads them from a file or the environment,
  so a continuation changes provider only when its caller passes other
  runtimes, and passing none is choosing the defaults. Accepted, as for
  the Windows sandbox; the settings hold helper paths and variable
  names, never a key, and a later launch event version can record them.
- Credentials are configured twice on a machine that keeps them in the
  user's configuration: once for the CLI, once in the options the engine
  is built with. Accepted: the explicit copy is what keeps the worker's
  isolation whole, and the engine has no configuration surface yet, so
  only a program that builds the adapters can give them.
- The Claude credential keys are listed by hand from Claude Code 2.1.283;
  a helper a later CLI adds is refused until the list names it. Accepted:
  a refused key is named, and allowing an unknown key would let any
  setting through.
- Claude Code's `--effort` is outranked by its environment variable, so
  both are set; a future CLI may change the precedence. Accepted; the
  preflight records the version and the fake tests pin the argument list.
- Migration: the registry gains two kinds and the golden fixture serial
  advances to `03`. No ledger schema change, no migration step; an older
  ledger folds with empty `workers` (R11). A newer ledger under an older
  engine is refused by the unknown kind, as the checkpoint proposal's D4
  already promises.
