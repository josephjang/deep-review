# deep-review

Deep review of a change, driven by a Node engine, delivered as a Claude Code
plugin and as a Codex skill.

This repository is being built one element at a time from what the
`deep-review-node` proof of concept in `agent-skills` showed. Each element
arrives with a change proposal under `docs/changes/` that records why it is
here, what it leaves out and what was rejected. So far: the repository
skeleton (toolchain, build, install path, continuous integration), the
checkpoint ledger the engine will record every run in, scope capture, the
runtime adapter that runs one model worker on Claude Code or Codex, and
the role prompts those workers are given. The engine has not shipped yet,
and the installed skill says so.

## Layout

```
skill/claude/            sources of the Claude Code plugin
skill/codex/             sources of the Codex skill
roles/                   the role prompts: one manifest and the fragments it joins them from
dist/claude/             the plugin, built from skill/claude, committed
dist/codex/              the Codex skill, built from skill/codex, committed
.claude-plugin/          marketplace.json: this repository as a marketplace
src/build/               assembling and verifying dist/
src/checkpoint/          the run ledger: location, SQLite, event registry, fold
src/evidence/            content-addressed evidence store
src/scope/               capturing the reviewed change from git and comparing the worktree to it
src/runtime/             running one model worker: the neutral contract, one adapter per runtime, the launcher
src/roles/               assembling each role's prompt from roles/
scripts/                 build, fixture and smoke entry points
test/                    node:test suites, mirroring src/
test/fixtures/checkpoints/  golden checkpoints, one per ledger schema
docs/changes/            change proposals, one per behavior change, in one file or a requirements and design pair
AGENTS.md, CLAUDE.md     conventions every agent follows here
```

## The checkpoint

A run's record lives in the repository being reviewed, at
`<git-common-dir>/deep-review-checkpoint/`: one per repository, shared by
every worktree, so it survives the removal of the worktree a run started
in. Inside are `ledger.sqlite`, an append-only event ledger, and
`artifacts/`, a content-addressed evidence store whose blobs are verified on
every read. Run state is never stored; it is folded from the run's events,
each of which has a kind, a schema version and the engine version that
wrote it. A newer engine always reads an older ledger; an older engine
refuses a newer one by name. See
`docs/changes/2026-09-26-checkpoint-ledger.md` for the reasoning.

The change a run reviews is captured once, as a `scope.captured` event: the
mode it was named in (the last commit of a clean tree, the dirty worktree,
everything since a ref, or a range ending at HEAD), every changed path, and
the bytes of each file before and after the change, frozen into the
evidence store. Before bytes are read through git's checkout filters, so a
CRLF checkout compares like for like. The after state is always the
worktree at capture, so a later comparison of the worktree against the
scope is a per-file question, answered by `compareWorktree`. See
`docs/changes/2026-09-27-scope-capture.md`.

## The runtime adapter

The engine runs a model worker through one function, `runWorker`, given a
runtime-neutral invocation: the runtime, the absolute path of its CLI, the
model and effort, the access (`read-only` or `edit`), whether it has a
shell, the prompt, the output schema, the timeout, and optionally a budget
and a session to continue. Each runtime is an adapter that builds a
command line and decodes the answer; Claude Code and Codex ship, and a
third is one module and one registration. What a runtime cannot do is
declared once and refused by name before anything runs.

A worker is on the ledger as `worker.launched` before its process exists,
with its session id whenever the runtime lets the engine choose it, and is
closed by `worker.finished` whatever the process did. The prompt, the
schema, stdout, stderr and the answer are evidence. The outcome is
`completed`, `budget`, `timeout` or `failed`, and refused tool calls are
listed beside it without changing it. A worker writes temporary files to
its own scratch directory under the system's temporary directory, never
into the reviewed tree or the git directory, and at a timeout its whole
process tree is killed. On Windows, Codex workers use Codex's unelevated
sandbox unless the adapter is built with `windowsSandbox: 'elevated'`,
which needs Codex's one-time elevated setup on the machine.

Workers never read the user's own Claude Code settings or Codex config,
so credentials and providers kept only there are given to the adapters
explicitly: `defaultRuntimes({ claude: { settings }, codex: { provider } })`.
Claude `settings` take the credential helpers (`apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`proxyAuthHelper`) and an `env` block, such as `CLAUDE_CODE_USE_BEDROCK`;
a Codex `provider` is `{ id, baseUrl, envKey?, queryParams? }`, with the
API key in the inherited variable `envKey` names. Anything else is
refused by name, and neither can change the pinned effort. The ledger
does not record them, so a continuation runs with whatever options its
caller builds the runtimes with. See
`docs/changes/2026-09-27-runtime-adapter.requirements.md` and its design.

## The role prompts

A worker runs in a role: the `SCAN` triage, one of the ten finder
angles, the verifier, the sweep, the fixer, the auditor and the rest,
twenty-one in all. Each role's prompt is assembled from the fragments
under `roles/fragments/` in the order `roles/manifest.json` lists for
it, joined with one blank line. The manifest is the only place
composition is declared, and every fragment is held to a few invariants
when it is read (UTF-8 text, LF endings, no control character but tab
and LF, one final newline, no blank line at either edge, no front
matter, no include marker), so what a worker receives is what the files
say. The text came from the
prompt-only `deep-review` skill in `agent-skills`, which the proof of
concept assembled its roles from; the move kept it as it was, a second
commit replaced the wording that named Claude Code's subagents and
tools with wording true on every runtime, which a test now holds every
prompt to, and review corrected the few replacements that were wrong or
missed and added the one fragment written here, which tells a worker
that the engine's narration of a review is not its task. Which model,
effort, access and budget a role runs with, and
what it must return, are not declared here: each is decided with the
phase that first runs the role. `npm run roles -- --output <dir>`
writes every assembled prompt for reading to a new directory outside
`roles/`. See `docs/changes/2026-09-27-role-prompts.md`.

## Developing

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for
mise and asdf.

```sh
npm ci
npm run check     # lint, typecheck, test
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ matches skill/ byte for byte
npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>   # after a ledger schema or registry change
npm run smoke -- --claude <path> --codex <path> --codex-model <model> [--codex-windows-sandbox elevated]   # real runtimes, by hand
npm run roles -- --output <dir>   # write every assembled role prompt to <dir> for reading
```

`npm run check` runs ESLint with type-aware rules, `tsc --noEmit`, and the
`node:test` suites against the TypeScript sources directly; nothing is
transpiled. `npm run verify` assembles both artifacts into a temporary tree
and compares them with the committed `dist/`, so a commit that claims to
change only where text lives can be checked rather than trusted.
Continuous integration runs both on Windows, macOS and Linux.

The suite never calls a model: fake Claude and Codex CLIs stand in for the
real ones. `npm run smoke` is the real-runtime check, for each CLI named
on its command line, installed and signed in. Per runtime it runs three
workers: a read-only worker asked to create a file with its shell, that
worker's session continued and asked the same again, and an editor with
edit access asked to write one file in the repository and one in its
scratch directory. Whether read-only mode stops the first two writes
differs by runtime and is reported, not judged. The smoke fails unless,
for every runtime, all three workers run and complete and the editor
writes both files. A worker the launcher refuses, such as one asking for
an effort level the runtime lacks, fails its runtime without stopping
the other. It calls real models and costs real money (each Claude worker
is capped at $0.50), and it keeps its temporary repository and checkpoint
so every receipt can be read afterwards.

Never edit `dist/` by hand. See `AGENTS.md`.

## Installing

### Claude Code

The repository is its own plugin marketplace. In a Claude Code session:

```
/plugin marketplace add josephjang/deep-review
/plugin install deep-review@deep-review
```

The skill is then `/deep-review:deep-review`. The plugin carries no version
field on purpose, so `/plugin marketplace update deep-review` follows the
latest commit. The repository is private; adding it uses the git
credentials already on the machine.

From a local checkout, the same two steps take the checkout path instead of
the GitHub name, and the plugin then loads in place: edits under `dist/`
show up at the next session start or `/reload-plugins`.

### Codex

There is no installer. Copy the built skill directory:

```
dist/codex/**   ->   ~/.agents/skills/deep-review/
```

The skill is then `$deep-review`.
