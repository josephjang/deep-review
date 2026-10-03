# deep-review

Deep review of a change, driven by a Node engine, delivered as a Claude Code
plugin and as a Codex skill.

This repository is being built one element at a time from what the
`deep-review-node` proof of concept in `agent-skills` showed. Each element
arrives with a change proposal under `docs/changes/` that records why it is
here, what it leaves out and what was rejected. So far: the repository
skeleton (toolchain, build, install path, continuous integration), the
checkpoint ledger the engine records every run in, scope capture, the
runtime adapter that runs one model worker on Claude Code or Codex, the
role prompts those workers are given, the read-only review: one
command that runs a change through the triage, nine more finder
angles, deduplication, verification, a gap sweep and a merge-and-rank
pass and writes a Markdown report, editing nothing; and the fix pass,
which on request carries that review on to apply the fixes through
its own workers and run the project's checks, committing nothing until
a person asks. The engine ships as one bundle inside both artifacts,
and the installed skill runs it.

## Layout

```
skill/claude/            sources of the Claude Code plugin
skill/codex/             sources of the Codex skill
roles/                   the role prompts: one manifest, the fragments it joins them from, and the role policy
dist/claude/             the plugin, built from skill/claude with the engine bundled under engine/, committed
dist/codex/              the Codex skill, built from skill/codex with the same engine, committed
.claude-plugin/          marketplace.json: this repository as a marketplace
src/build/               assembling and verifying dist/, and bundling the engine into it
src/checkpoint/          the run ledger: location, SQLite, event registry, fold
src/evidence/            content-addressed evidence store
src/scope/               capturing the reviewed change from git and comparing the worktree to it
src/runtime/             running one model worker: the neutral contract, one adapter per runtime, the launcher
src/roles/               assembling each role's prompt from roles/
src/review/              the review: policy, schemas, prompts, planner, controller, report, and the fix pass's
                         routing, expected tree, snapshots, patches and commit command
src/review/checks/       the fix pass's checks: discovering the repository's commands, running one
src/cli.ts               the deep-review command: review, status, abandon, commit, snapshot
scripts/                 build, fixture and smoke entry points
test/                    node:test suites, mirroring src/
test/fixtures/checkpoints/  golden checkpoints, one per ledger schema
test/fixtures/reports/   the report renderer's snapshot
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
twenty in all. Each role's prompt is assembled from the fragments
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
that the engine's narration of a review is not its task. The read-only
review then rewrote the four fragments that narrate the phases for the
engine's workers, in a commit of its own, and the `angle-decision` role
left the manifest. Which model tier, effort, budget and timeout a role
runs with is declared in `roles/policy.json` for the fourteen roles the
read-only review runs; what each must return is the output schema of the
phase that runs it. `npm run roles -- --output <dir>`
writes every assembled prompt for reading to a new directory outside
`roles/`. See `docs/changes/2026-09-27-role-prompts.md`.

## The read-only review

`deep-review review` reviews one change and writes a report, in the
foreground, and is resumable. It creates a run, captures the scope, and
runs the phases in a fixed order: the `SCAN` triage, which also returns
one lead per other angle; the nine other finder angles in parallel, each
given its lead; deduplication; one verifier per group of candidates in
one file; a gap sweep told which angles did not run; the sweep's own
deduplication and verification; merge and rank; the report. Every angle
runs on every review. Before each phase, and before each answer is
recorded, the worktree is compared with the captured scope, and a
difference blocks the run until the tree is restored; an answer that
arrives after the difference is set aside, neither recorded nor counted
as a failure, and its unit runs again once the tree is restored.
Everything a phase decides is an event, so the same command run again
after an interruption records the workers it lost, re-enters the phase,
and launches only the units whose answer is not on the ledger.

Every worker runs read-only with a shell under the policy in
`roles/policy.json`, pinned on the run's ledger before the first launch:
a tier (`strong` or `fast`, the models coming from `--strong-model` and
`--fast-model` or the runtime's defaults), an effort, a per-worker
budget and a timeout. A worker that does not complete, or whose answer
fails its schema or a structural check, is run once more as a fresh
worker; a second failure degrades by role: a finder's angle is recorded
as not run, a verifier's group as unverified with its candidates
`PLAUSIBLE` and marked, and the triage, deduplication, sweep and
merge-rank block the run. A worker lost when the engine stops uses an
attempt too, but a unit whose attempts run out with a lost worker among
them blocks the run whatever its role, so an interruption never costs
coverage: running again gives the unit fresh attempts. At most
`--concurrency` workers run at once (4 by default), and on a runtime
that reports cost the run has a budget (`--budget-usd`, 60 USD by
default on Claude Code) checked before every launch; the check counts a
worker that ran but reported no cost, such as one that timed out, at its
per-worker budget, and names but does not charge a worker lost with an
earlier engine. Every way a run stops short of a report names the
operator's action: run again, raise the budget, restore the tree, or
abandon.

The report is Markdown rendered by the engine into the evidence store;
the command prints its path as the last line of stdout and exits 0. Its
sections are the header, Angles, Findings (most severe first, with the
merged ids, verdict, evidence and the outside-the-change, unlocated and
unverified marks), Refuted at verification, Statistics per phase and
Limitations. A finding's location is matched to a file of the
repository: one the change touches, or an unchanged file such as a
caller, marked outside the change; a location that names no such file
and line is kept and marked unlocated, never dropped. A blocked
run exits 2 with the blocker and its action on stderr, and so does a
refusal, such as another engine holding the run, a runtime that does not
qualify, or an active run that belongs to another worktree or runtime.
A resumed run keeps the scope, policy and executable it pinned; only
`--concurrency` and `--budget-usd` apply to each invocation. `deep-review
status` prints the fold of the active run, as text or `--json`;
`deep-review abandon --reason <text>` closes an active or blocked run.
The engine ships as one esbuild bundle, `engine/main.mjs`, in both
artifacts, with a sidecar holding its version and hash and a copy of
`roles/`; every event the installed engine writes carries
`<version>+<hash prefix>` as its engine.
See `docs/changes/2026-09-27-read-only-review.requirements.md` and its
design.

## The fix pass

`deep-review review --fix` runs five more phases between merge and rank
and the report: baseline checks, fixes, checks, repair and repair
checks. A run without `--fix` records them as skipped and is the
read-only review exactly. Whether a run fixes, and with which checks,
is pinned when it is configured; a resumed run keeps both and says
when the command asks otherwise.

Every ranked finding is routed by its merged verdict and its primary's
angle: a `CONFIRMED` finding, or a `PLAUSIBLE` one from a correctness
angle or `CONVENTIONS`, goes to a fixer; a `PLAUSIBLE` finding from
`DESIGN`, `DUPLICATION` or `ALTITUDE` is held for the author. The
fixer-routed findings are clustered one per file, a merged finding kept
whole, so no file is owned by two clusters. Each cluster's findings go
in batches of the policy's `fixes.batchSize`, four by default, to
`fixer` workers with edit access, one batch after another, and the
batches of the whole run launch best-ranked first. A fixer owns its
cluster's files while its batch runs, may edit any file no cluster owns
when a fix or its tests need it, never touches another cluster's, and
returns a schema the engine validates: per finding a status
(`applied`, `already-applied`, `deferred`, `blocked`), a note, the
files it changed and, for an applied finding, a commit message. After
each finding it runs `deep-review snapshot`, which copies what it
changed into its scratch directory, so the engine records one revision
of the tree per finding. The command finds what changed against a
manifest of the worktree the engine wrote at launch and starts no
process, so it works in a sandbox, such as Codex's on Windows, where a
worker's process cannot start another. Once every batch of this first round has
settled, a finding a fixer reported blocked only on files another
cluster owned gets one second round, owning those files too.

The engine never writes the reviewed tree during a run. It records the
bytes every worker or check left in the files it changed as a revision,
and compares the worktree with the scope overlaid by the revisions: an
edit an answer accounted for is not drift, and one nobody accounted for
still blocks, the blocker naming where the expected bytes are. A fixer
that fails, or is lost with its engine, has what it left recorded when
it fails, a revision per finding its snapshots tell apart, so its
retry's revisions are its own. Files are compared as git would store
them, so a formatter turning a CRLF checkout to LF changes nothing. A file
another cluster owns that a fixer reports editing is recorded as a
violation, a file no answer names as a stray, and neither stops the
run.

The checks are the repository's own `build`, `typecheck`, `lint` and
`test` commands: a `--check <kind>=<command>` flag, else a Taskfile
task, a Makefile target or a justfile recipe of that name, else a
`package.json` script (its `<name>:check` variant beside it preferred)
run through the package manager the lock file names, else a language
default; `--no-check <kind>` drops one. They run one at a time through
the platform shell, `build` first and the other three only when it
passed, with the build-server and non-interactive pins, stdin at end of
input and a timeout from `roles/policy.json`; a check passes by its
exit code, and its output is frozen. A check that fails after the fixes
goes to one repair worker: one the baseline passed to make it pass
again, and one that failed before any fix too with both outputs, to fix
only the failures the baseline's does not show. Every fixer is told
which checks failed before any fix and where their output is. Which
failures are new is the worker's reading; the engine parses no output. In the fixes and repair
phases the run budget stops new launches instead of blocking the run:
what was not launched is reported not attempted, and the run still
reaches its report.

The report gains Fixes, Checks and Changed files, and beside it the
engine writes a patch series, one patch per revision, rendered from the
frozen bytes, as git would store them, so it holds none of the user's
own uncommitted change;
`git am --keep-cr` applies it in order to a tree at the scope. Nothing
is committed by the run. Afterwards, on request, `deep-review commit`
builds one commit per revision from the same bytes with git's plumbing,
the captured change first in `--worktree` mode with
`--change-message`, moves the branch once and resets the index, writing
no file and running no hook. See
`docs/changes/2026-10-01-fix-pass.requirements.md` and its design.

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
npm run review -- review --runtime claude --last-commit [--fix]   # run the engine from the sources; also status, abandon and commit
```

`npm run check` runs ESLint with type-aware rules, `tsc --noEmit`, and the
`node:test` suites against the TypeScript sources directly; nothing is
transpiled. `npm run build` bundles `src/cli.ts` with esbuild into each
artifact's `engine/main.mjs`, writes the sidecar and copies `roles/`
beside it, then copies the skill sources; `npm run verify` assembles both
artifacts into a temporary tree and compares them with the committed
`dist/`, bundle included, so a commit that claims to change only where
text lives can be checked rather than trusted. Continuous integration
runs both on Windows, macOS and Linux.

The suite never calls a model: fake Claude and Codex CLIs stand in for the
real ones, and for the review they answer from a script per role and
unit, so a whole review runs through the controller in a test, with
failures, hangs, a killed engine and a drifted tree where a case needs
them. A scripted fixer edits the tree and runs the snapshot command its
prompt quotes, and a stand-in check passes, fails, hangs or writes as a
control file says, so a whole fix run runs there too, no toolchain
needed. `npm run smoke` is the real-runtime check, for each CLI named
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

The skill is then `/deep-review:deep-review`. It runs the bundled engine
with `--runtime claude` on the scope the user named (the dirty worktree
by default, else the last commit), waits for it, and shows the report's
path. Asked to fix the findings, it passes `--fix`, says first that the
engine's workers will edit the working tree, and afterwards offers to
commit the edits with `deep-review commit`. Node 26 or newer must be on
the machine. The plugin carries no
version field on purpose, so `/plugin marketplace update deep-review`
follows the latest commit. The repository is private; adding it uses the
git credentials already on the machine.

From a local checkout, the same two steps take the checkout path instead of
the GitHub name, and the plugin then loads in place: edits under `dist/`
show up at the next session start or `/reload-plugins`.

### Codex

There is no installer. Copy the built skill directory:

```
dist/codex/**   ->   ~/.agents/skills/deep-review/
```

The skill is then `$deep-review`. It runs the bundled engine beside its
`SKILL.md` with `--runtime codex`; Codex reports no cost, so a Codex run
has no budget and its report says so.
