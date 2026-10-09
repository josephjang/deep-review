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
pass and writes a Markdown report, editing nothing; the decision step,
which decides of every finding whether to fix it, leave it or ask the
author, applying a default while the question waits; the fix pass,
which on request carries that review on to apply the fixes through
its own workers and run the project's checks, committing nothing until
a person asks; and the repository survey, which begins every run by
naming the files that state the repository's conventions and, for a
fix run, choosing its checks. The engine ships as one bundle inside
both artifacts, and the installed skill runs it.

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
src/review/              the review: policy, schemas, prompts, planner, controller, report, the survey's check of
                         its answer, the decision step's report, and the fix pass's routing, expected tree, snapshots,
                         patches and commit command
src/review/checks/       the fix pass's checks: the manifest rules that hint the surveyor, running one
src/replay/              replaying a recorded run's verifiers: the recorded prompt, the samples, their summary,
                         and their score against labels
src/cli.ts               the deep-review command: review, status, abandon, commit, snapshot, claim
scripts/                 build, fixture, smoke, replay and replay score entry points
test/                    node:test suites, mirroring src/
test/fixtures/checkpoints/  golden checkpoints, one per ledger schema
test/fixtures/reports/   the report renderer's snapshots
docs/changes/            change proposals, one per behavior change, in one file or a requirements and design pair
docs/reports/            measurements of real runs and the levers they suggest, kept for later decisions
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
wrote it. A newer engine always reads an older ledger. An older engine
refuses a newer ledger schema by name, and passes over a run holding an
event it does not know, naming the engine that wrote it. See
`docs/changes/2026-09-26-checkpoint-ledger.md` and
`docs/changes/2026-10-10-unreadable-runs.md` for the reasoning.

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
process tree is killed. On Windows, the Codex adapter confines its
workers by the `windowsSandbox` it is built with: `unelevated`, Codex's
unelevated sandbox; `elevated`, which needs Codex's one-time elevated
setup on the machine and runs every worker with PowerShell's execution
policy at `RemoteSigned` unless `PSExecutionPolicyPreference` is already
set; or `none`, which runs a worker with edit access in no sandbox and
every other worker read-only under the unelevated one. An adapter built
with none named uses `unelevated`, but a review launches every Codex
worker under the value its run pinned, whatever the adapter was built
with; that value is `none` unless the flag or the policy names another
(see the fix pass below).

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

A worker runs in a role: the surveyor, the `SCAN` triage, one of the
ten finder angles, the verifier, the sweep, the decider, the fixer, the
auditor and the rest, twenty-two in all. Each role's prompt is assembled from the fragments
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
runs with is declared in `roles/policy.json` for the seventeen roles a
review runs, the surveyor, the decider and the fixer among them; what each must
return is the output schema of the phase that runs it. `npm run roles -- --output <dir>`
writes every assembled prompt for reading to a new directory outside
`roles/`. See `docs/changes/2026-09-27-role-prompts.md`.

## The read-only review

`deep-review review` reviews one change and writes a report, in the
foreground, and is resumable. It creates a run, captures the scope, and
runs the phases in a fixed order: the survey, which names the
convention sources every later worker is given (see The repository
survey); the `SCAN` triage, which also returns
one lead per other angle; the nine other finder angles in parallel, each
given its lead; deduplication; one verifier per group of candidates in
one file; a gap sweep told which angles did not run; the sweep's own
deduplication and verification; merge and rank; the decision (see The
decision step); the report. Every angle runs on every review. Before each phase, and before each answer is
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
`PLAUSIBLE` and marked, and the triage, deduplication, sweep,
merge-rank and decider block the run; the survey degrades a read-only review and
blocks a fix run, unless that run's flags settle every check. A worker
lost when the engine stops uses an attempt too, but a unit whose
attempts run out with a lost worker among them blocks the run whatever
its role, so an interruption never costs coverage: running again gives the unit fresh attempts. At most
`--concurrency` workers run at once (4 by default), and on a runtime
that reports cost the run has a budget (`--budget-usd`, 60 USD by
default on Claude Code) checked before every launch; the check counts a
worker that ran but reported no cost, such as one that timed out, at its
per-worker budget, and names but does not charge a worker lost with an
earlier engine. Every way a run stops short of a report names the
operator's action: run again, raise the budget, restore the tree,
settle a check the machine cannot run, or abandon.

The report is Markdown rendered by the engine into the evidence store;
the command prints its path as the last line of stdout and exits 0. Its
sections are the header, Decisions, Angles, Conventions, Findings (most severe first, with the
merged ids, verdict, evidence, the outside-the-change, unlocated and
unverified marks, and the decision made), Refuted at verification,
Statistics per phase and Limitations. A finding's location is matched to a file of the
repository: one the change touches, or an unchanged file such as a
caller, marked outside the change; a location that names no such file
and line is kept and marked unlocated, never dropped. A blocked
run exits 2 with the blocker and its action on stderr, and so does a
refusal, such as another engine holding the run, a runtime that does not
qualify, or an active run that belongs to another worktree or runtime.
A resumed run keeps the scope, policy, executable and Codex Windows
sandbox it pinned, and refuses a `--codex-windows-sandbox` naming
another; only
`--concurrency` and `--budget-usd` apply to each invocation, and
`--check` and `--no-check` until the checks are planned. Until then
they are not recorded, so every invocation must give them again: a
resume that leaves one out drops it. The log names the kinds it can
tell were dropped, those a flag settled when the survey answered, and
the survey is asked again for them. `deep-review
status` prints the fold of the active run, as text or `--json`;
`deep-review abandon --reason <text>` closes an active or blocked run.
The engine ships as one esbuild bundle, `engine/main.mjs`, in both
artifacts, with a sidecar holding its version and hash and a copy of
`roles/`; every event the installed engine writes carries
`<version>+<hash prefix>` as its engine.
See `docs/changes/2026-09-27-read-only-review.requirements.md` and its
design.

## The decision step

Every run configured since the decision step, `--fix` or not, runs a
`decision` phase after merge and rank: one `decider` worker, read-only
with a shell, is given every ranked finding with each candidate merged
into it and that candidate's own verdict and evidence, and decides each
finding whole. It grades nothing again. A finding is decided `fix`,
with the approach a fixer applies and the options rejected; `leave`,
for one of three reasons and no other (acting on it would edit only
code outside the change, which neither caused nor worsened it; another
finding's fix removes it; or the repository states the behavior on
purpose and the rule's reason reaches the case); or `ask`, one question
the repository cannot answer, with its options, what each costs, the
rule a convention source would state for it, the option recommended and
the default applied, which is the option easiest to take back. An ask
never stops the run. A choice is settled by the change's stated intent,
then the repository's stated contract, then for a regression the
behavior before the change, then keeping what was there; the order is a
presumption the decider may rebut, with the rule's own reason found
first and a fact, not a preference, against it, and a departure is
named on the decision. A run with no finding launches no decider; a
decider that fails twice blocks the run with `worker-failed`, since no
fixer may act on a finding nobody decided. The report opens with a
Decisions section: the questions as a checklist, the findings to fix
with their approach and any rule departed from, and the findings left
with their reason. A run configured before the decision step records
the phase as skipped and reads as it did. See
`docs/changes/2026-10-08-decision-step.requirements.md` and its design.

## The fix pass

`deep-review review --fix` runs five more phases between the decision
and the report: baseline checks, fixes, checks, repair and repair
checks. A run without `--fix` records them as skipped and is the
read-only review exactly. Whether a run fixes is pinned when it is
configured, and which checks it runs when its survey completes; a
resumed run keeps both and says when the command asks otherwise.

Every ranked finding is routed by its decision: a finding decided `fix`,
and one decided `ask` whose default edits the code, goes to a fixer,
which is told the decision and each merged candidate's verdict and
evidence and applies it; a finding left, and an ask whose default keeps
the code as it is, goes to no fixer. A fix run configured before the
decision step, which routed by verdict and angle, is refused before it
plans its fixes and must be abandoned. The
fixer-routed findings are clustered one per file, a merged finding kept
whole, so no file is owned by two clusters. Each cluster's findings go
in batches of the policy's `fixes.batchSize`, four by default, to
`fixer` workers with edit access, one batch after another, and the
batches of the whole run launch best-ranked first. A fixer owns its
cluster's files while its batch runs. Before its first edit of a file
no cluster owns it runs `deep-review claim`, which claims the file for
its cluster until the cluster's last batch has settled, and a fixer
never touches a file another cluster owns or has claimed: a fix that
needs one is reported blocked. The command creates one marker file
exclusively in a directory the engine prepares per run and round beside
the workers' scratch, so two fixers claiming one file at once get one
claim and one refusal, and it starts no process. A fixer returns a
schema the engine validates: per finding a status (`applied`,
`already-applied`, `deferred`, `blocked`), a note, the files it
changed and, for every finding that names files, a commit message,
which for a blocked or deferred finding says the change is partial.
Before each snapshot it runs the quick checks it was given, since each
finding becomes a commit the repository must accept alone. After
each finding it runs `deep-review snapshot`, which copies what it
changed into its scratch directory, so the engine records one revision
of the tree per finding. The command finds what changed against a
manifest of the worktree the engine wrote at launch and starts no
process, so it works in a sandbox, such as Codex's unelevated one on
Windows, where a Node process cannot start a child whose output it
captures. Once every batch of this first round has
settled, a finding a fixer reported blocked only on files another
cluster owned or claimed gets one second round, owning those files too.
Every claim reaches the ledger when the next unit settles, so the fold
judges an answer against a running sibling's claims too, and a resumed
run seeds the claims directory again from the ledger. A claims
directory removed while fixers run stops the run with `claims-lost`:
the units then running are recorded as failed attempts with their edits
kept, and the next run retries them.

The engine never writes the reviewed tree during a run. It records the
bytes every worker or check left in the files it changed as a revision,
and compares the worktree with the scope overlaid by the revisions: an
edit an answer accounted for is not drift, and one nobody accounted for
still blocks, the blocker naming where the expected bytes are. A fixer
that fails, or is lost with its engine, has what it left recorded when
it fails, a revision per finding its snapshots tell apart, so its
retry's revisions are its own. Files are compared as git would store
them, so a formatter turning a CRLF checkout to LF changes nothing. A file
another cluster owns or has claimed that a fixer reports editing is
recorded as a violation, a file nobody held that a fixer edited without
claiming it as a late claim, a file no answer names as a stray, and none
of them stops the run. A check that rewrites tracked files, a build that
regenerates `dist/`, is recorded as the check's revision, judged against
a list of every tracked file taken just before it, so the rebuilt
tracked files are the series' last commit rather than a change left in
the worktree. A file the check creates, such as a new file a build
writes under `dist/`, is not tracked, so it stays a stray, named in
Limitations and in no commit.

The checks are the repository's own `build`, `typecheck`, `lint` and
`test` commands, as the survey chose them or a `--check <kind>=<command>`
names one; `--no-check <kind>` drops one. They run one at a time through
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

On Windows a Codex run chooses how its workers are confined with
`--codex-windows-sandbox`, else the policy's
`runtimes.codex.windowsSandbox`, shipped as `none`, the one value under
which a gate on zod reached its report untouched with editors that ran
the build and the tests. The value is pinned on the run and named in
the report's header; on another platform the flag is ignored with a
warning. Each value needs and gives up something:

- `unelevated` needs no setup, but a Node process there cannot start a
  child whose output it captures, so a fixer or the repair worker cannot
  run most build and test commands. A fix run under it warns at every
  start, and its fixers and repair worker are told what cannot run and
  to validate a fix by what does, recording it as `limited` otherwise;
  the engine's own checks still run after them.
- `elevated` runs every worker's commands as Codex's separate sandbox
  user. It needs Codex's one-time elevated setup, which an administrator
  approves, and package stores and tools under the operator's profile
  that the sandbox user can read; the engine sets PowerShell's execution
  policy for the worker's processes to `RemoteSigned`, so the `npm` and
  `pnpm` shims start, unless `PSExecutionPolicyPreference` is set
  already or a group policy overrides it, and its surveyor looks tools
  up with PowerShell's `Get-Command`, since `where.exe` finds nothing as
  that user, and then as `.\<tool>` for a script in the repository root
  such as `gradlew.bat`, which `Get-Command` does not look in by itself
  but `cmd.exe` runs. Two limits come from Codex and have no fix on this side:
  Codex logs the sandbox user on without a profile, so `os.userInfo()`
  throws and every tool that calls it, `tsx` among them, fails
  ([openai/codex#42753](https://github.com/openai/codex/issues/42753));
  and by design it gives that user no access to the operator's profile
  directory itself, so a tool that walks up through it from a repository
  inside the profile fails, as esbuild and vitest's default config
  loader do
  ([openai/codex#41237](https://github.com/openai/codex/issues/41237)).
  Which tools break depends on the repository, so under `elevated` an
  editor may not be able to run the build or the tests at all.
- `none`, the default, runs the workers that edit in no sandbox and
  leaves those that only read under `unelevated`, since Codex has no
  tool list to hold a reader. An editor then has an unconfined shell and
  the network, as a Claude Code editor does, for the whole of its
  session, so `none` suits a change the operator trusts, or a machine
  that is itself the boundary, such as a container or a virtual machine;
  for any other change, pass `--codex-windows-sandbox unelevated` or
  `elevated`.

The engine sets up neither the machine nor its package stores. See
`docs/changes/2026-10-04-codex-sandbox.requirements.md`.

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

## The repository survey

Every run, read-only or fixing, begins with a `survey` phase before the
triage. One read-only `surveyor` worker reads the repository the way a
new contributor would, its rules files, contributing guide, CI
workflows and manifests, and answers two questions: which files state
the conventions a change here must follow, and, in a fix run, which
command is each of the four checks. The answer is checked against the
tree (every path a regular file of the repository, every kind asked for
answered once, a hinted command exactly the hint) and recorded once as
`survey.recorded`; an answer the check refuses is a failed attempt and
gets the one fresh retry every role does.

The convention sources replace the three rules-file names the engine
used to look for. The scope block of every later worker lists them,
each with what it governs and the paths it applies to; `CONVENTIONS`
holds the change to them alone, and a fixer keeps its edits within
them. A repository that states no conventions is reviewed without
invented ones. The reviewer's own `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` are decided by `survey.userRules` in
`roles/policy.json`, pinned on the run: `ignore` never applies them,
`apply` always does, and `judge`, the shipped value, offers each that
exists to the surveyor, which applies one only on stated grounds that
the repository is the reviewer's own work or adopts those rules. The
engine tells it how many of the repository's recent commits were
authored with the reviewer's git email, which its isolated shell cannot
see, or with an address the repository's `.mailmap` gives as the
reviewer's; no address itself ever reaches a prompt.

In a fix run the checks are planned when the survey completes, before
the triage, from the invocation's flags over the survey: a
`--check <kind>=<command>` or `--no-check <kind>` settles its kind, and
the surveyor chooses the rest from what the repository's CI and
contributor documentation run, in the form that verifies, with the file
each command came from. The manifest rules the fix pass decided by (a
Taskfile task, a Makefile target, a justfile recipe, a `package.json`
script, a language default) decide nothing now: their result is a hint
in the surveyor's task for a kind the repository states nothing about,
and a hinted command runs only when the surveyor returns it. The
surveyor looks each tool up as the check's shell resolves it and runs
no check. When it reports a tool missing, the survey blocks with
`check-unavailable` before any other worker is paid for, naming the
kind, the command, its source and the tool: the operator installs the
tool and runs the command again, which surveys afresh, or runs it again
with `--no-check <kind>` or `--check <kind>=<command>`, which settles
the block with no new survey. A survey that fails twice degrades a
read-only review, `CONVENTIONS` not run when no source is left, and
blocks a fix run until the command runs again or flags settle all four
kinds; a fix run whose flags already settle all four goes on without
it. Once the checks are planned a resumed run never surveys again
and names its check flags as ignored.

The report gains a Conventions section and a Source column in its
Checks table, and a kind the operator dropped says what the project
defines. A command the survey chose runs with the operator's
privileges, unsandboxed, and no person approves it first: text in the
repository can steer the surveyor to any command line. Each chosen
command is printed with its source before the baseline runs and is on
the ledger with the file it came from, but anyone reviewing an
untrusted repository with `--fix` should settle every check with
`--check` or `--no-check`, and on Codex for Windows confine the editors
with `--codex-windows-sandbox unelevated` or `elevated`, or not fix. See
`docs/changes/2026-10-03-repository-survey.requirements.md` and its
design.

## Developing

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for
mise and asdf.

```sh
npm ci
npm run check     # lint, typecheck, test
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ matches skill/ byte for byte
npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>   # after a ledger schema or registry change
npm run smoke -- --claude <path> --codex <path> --codex-model <model> [--codex-windows-sandbox unelevated|elevated|none]   # real runtimes, by hand
npm run roles -- --output <dir>   # write every assembled role prompt to <dir> for reading
npm run review -- review --runtime claude --last-commit [--fix]   # run the engine from the sources; also status, abandon and commit
npm run replay -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>   # a recorded run's verifiers again, real runtimes, by hand
npm run replay-score -- --results <results.json> --labels <labels.json>   # the replay's samples against labels; calls no model
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
them. A scripted fixer edits the tree and runs the claim and snapshot
commands its prompt quotes, and a stand-in check passes, fails, hangs or
writes as a control file says, so a whole fix run runs there too, no
toolchain needed. `npm run smoke` is the real-runtime check, for each CLI named
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

`npm run replay` measures the verifier on what a real run recorded. It
reads one run from a checkpoint, takes every verification group the run
planned, and sends each the prompt its verifier was sent then to a fresh
verifier on the runtime named, in a clean checkout of the commit the run
reviewed. The prompt differs from the recorded bytes only in the
repository's path, the directory its frozen blobs are read from and the
launcher's scratch note. Each pass over the groups is a sample, kept in
`results.json` beside the verdicts the run recorded; `summary.md` counts
how every pair of samples agrees, by verdict and by what the verdict does
to the candidate taken alone (to a fixer, held, dropped), and lists the
candidates they disagree on with each sample's evidence. A later replay
into the same output directory adds its samples, so the recorded runtime
again says how stable a verdict is, and another runtime says how it
judges the same candidates. `--role-text current` puts this checkout's
verifier prompt in place of the recorded one, which measures an edit to
the rubric without a whole run. A tree that is not the reviewed commit,
unchanged, is refused, and so is an output directory inside the tree,
where the workers would read the samples, or one whose results lack a
candidate the run can now replay, as the replay of a copy taken before
the run planned that group leaves them. The checkpoint is only read,
but give the replay a copy, placed at `<tree>/.git/deep-review-checkpoint`
where the run recorded it, so the frozen blobs stay inside the worker's
working directory as they were then; the replay records its own workers in a
checkpoint under the output directory. It calls real models and costs
real money: `--budget-usd` stops new launches at a spend, and
`--dry-run` writes every prompt and launches nothing. A group whose
verifier gives no verdicts in either attempt, or in the first when the
budget is reached before the retry, is recorded unverified, as
a review records it, and the command then names every such group pass
and exits 1: a sample that holds one, because a verifier timed out twice
or the runtime reached a usage limit partway through, is not a pass over
every candidate and must not be scored as one. A group pass `--budget-usd`
kept from launching leaves its sample short the same way, so the command
names it too and exits 1.

Agreement says how alike two samples are, not which is right.
`npm run replay-score` scores the samples against labels: a file, written
by whoever adjudicated the candidates and never by the engine, that says
of each labeled candidate whether its claim is real (`yes`, `no` or
`unsure`) and, for a real one, whether acting on it needs no decision
(`apply`) or one the author owns (`ask`), with the basis. A label asks
for an outcome, dropped, to a fixer or held, and the score counts where a
sample's verdict alone leads elsewhere, as the fix pass routed a finding
by its verdict and angle before the decision step (a verifier replay
makes no decision): kept though not real, dropped though
real, sent to a fixer though the author should be asked, held though it
should be applied, over all labeled candidates and per class of angle. A
candidate labeled `unsure` scores no sample. The PLAUSIBLE an unverified
candidate carries is no verifier's judgment, so it scores nothing for
its sample, and `summary.md` compares it with no other sample. It reads the two files,
calls no model and writes only what `--output` names.

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
engine's workers will edit the working tree and that it runs the check
commands it chose from the repository, and afterwards offers to commit
the edits with `deep-review commit`. Node 26 or newer must be on
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
