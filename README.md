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
fix run, choosing its checks; and the configuration, which lets a
repository state its review policy and an operator their preferences
in files the engine reads and records; and the review on the pull
request, which reviews a pull request on GitHub, explains the review
for the people who read the pull request and, when asked, posts it
there. The engine ships as one bundle inside both artifacts, and the
installed skill runs it.

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
src/github/              reading a pull request and posting its review through gh api
src/config/              the configuration: the settings registry, the four files, the two passes of resolution,
                         the record, and the config command
src/runtime/             running one model worker: the neutral contract, one adapter per runtime, the launcher,
                         and the guard each worker and check runs under
src/roles/               assembling each role's prompt from roles/
src/review/              the review: policy, schemas, prompts, planner, controller, report, the survey's check of
                         its answer, the decision step's report, and the fix pass's routing, expected tree, snapshots,
                         patches and commit command
src/review/checks/       the fix pass's checks: the manifest rules that hint the surveyor, running one
src/replay/              replaying a recorded run's verifiers: the recorded prompt, the samples, their summary,
                         and their score against labels; and replaying its decider
src/command.ts           the deep-review command: review, config, status, abandon, commit, answer, snapshot, claim
src/cli.ts               the command's entry point, which the bundle is built from, and of the guard
scripts/                 build, fixture, smoke, replay, replay score and decider replay entry points
test/                    node:test suites, mirroring src/
test/fixtures/checkpoints/  golden checkpoints, one per ledger schema
test/fixtures/reports/   the report renderer's snapshots
docs/changes/            change proposals, one per behavior change, in one file or a requirements and design pair
docs/reports/            measurements of real runs and the levers they suggest, kept for later decisions
docs/YYYY-MM-DD-vision.md  vision and design principles, dated; a later note supersedes an earlier one; .ko.md is the Korean copy
AGENTS.md                conventions every agent follows here
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
listed beside it without changing it. A Claude Code worker prints the
stream of its turns (`--output-format stream-json --verbose`), whose last
`result` event is the envelope the adapter reads its answer from, and a
Codex worker prints its event stream, so on both runtimes the frozen
stdout holds each shell command the worker ran with the output it saw;
the adapter reads these shell runs, the worker's record, from it, and no
event holds them a second time. A worker writes temporary files to
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
ten finder angles, the verifier, the sweep, the decider, the writer, the
fixer and the rest, twenty-one in all. Each role's prompt is assembled from the fragments
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
runs with is declared in `roles/policy.json` for the nineteen roles a
review runs, the surveyor, the decider, the writer, the fixer and the
documentation step's worker among them; what each must
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
decision step); in a read-only run of a pull request, the explanation
(see Reviewing a pull request); the report. Every angle runs on every review. Before each phase, and before each answer is
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

Each verdict gives its basis: `ran` when a run of code showed the
result, `traced` when the verifier followed the code line by line, and
`read` when the lines alone settle the claim. A verdict that rests on a
run cites it, at most three: the command, one to five lines it printed,
copied exactly, and the probe file in the verifier's scratch directory
when it wrote one. The engine looks for each cited run in the verifier's
record, as the last shell run whose output holds the cited lines in
order, ignoring line endings, terminal colors and trailing spaces, and
whose command names the probe's file, and freezes the probe in the
evidence store when its real path is inside the scratch directory and
it holds at most 64 KiB. An answer that cites a run the record does not
hold, or a probe that cannot be frozen, fails as an answer that fails a
structural check does: the group runs again, and a second failure
leaves it unverified. The engine runs no probe itself. A run that an
earlier engine configured keeps the answers it was configured with, also
when this engine resumes it, and its verdicts have no basis. See
`docs/changes/2026-10-31-runs-on-the-record.requirements.md` and its
design.

The report is Markdown rendered by the engine into the evidence store,
and a copy of it beside the ledger, under `reports/` in the checkpoint,
named by the day the run started and the run, is what a person opens.
`review`, `answer`, `commit` and `report` write the copy again, so it
shows each answer and commit; the record in the store stays the report
of its moment. The report starts with the brief of the run: what the
change does and why, as deep-review read it from the change's own words,
and its judgments of the change; a status line that counts the findings
by what became of them; What needs you, a numbered list computed from a
closed table of conditions in the order of what doing nothing costs,
from a check the edits of the run made fail, a check the change breaks
and a check not compared with the base, through work the run did not
finish and documents left out of date, the fixes that go against a
written rule and the questions only a person can answer, each with its
options, to the patches to commit, each item with what happens if the
person does nothing and its command; Before you merge, one row per check
with its result on the base, as submitted and in its last run, and one
meaning that says who compared the failures; and What deep-review fixed,
one row per fix with how its fixer reports checking it and its patch.
Each finding is named by its number, its rank in the run. One block per
finding follows, from where it is and why to its decision, its fix, its
patch and each validation its fixers report, with the basis of its
verdict and each run the verdict cites after its evidence, and after
each validation which of its cited runs its worker's record shows, a
worker's scratch directory, and every directory under the run's scratch
base, reading `<scratch>` in every worker's text it quotes; then the
evidence:
Documentation updates, Checks, Patches, What the review covered, Refuted
at verification, and About this run, with the repository, the commits,
the engine, the runtime, the models and the settings, the one part that
names a local path. The command prints the top of the brief, the title,
the line of the change, the status line, What needs you and Before you
merge, with every list held to a cap so it has at most 52 lines, then
the copy's path as the last line of stdout, and exits 0. The line of the
change gives the first sentence of the account whole, and in a run whose
fixes or answers changed the code it reads `The change before the
fixes:`, since the account was written before them. `deep-review report`
shows the top of the brief of the run of this worktree with a report
whose last event is the latest, after a `Not shown:` line for each later
run it passed over that says why that run has no report; `--run` names
another run by its id or its first eight characters. With `--json` it
prints the JSON form, version 5, which names those runs in `notShown`;
with `--brief`, the whole brief as a chat shows it; with `--finding
<number>`, the block of any finding, by its number or its id; with
`--fixes`, a line for each fix with the subject of its commit message;
and with `--stats`, the statistics per phase, the angles, the digest of
the roles and the clusters of the fix pass, which the report leaves out,
and in a run whose verdicts cite runs, the verdicts of each grade by
basis and the cited runs of each editing phase, found or not.
See `docs/changes/2026-10-20-run-brief.requirements.md` and its design,
`docs/changes/2026-10-24-questions-in-the-chat.md`,
`docs/changes/2026-10-28-facts-before-a-merge.requirements.md` and
`docs/changes/2026-10-29-report-for-the-person.requirements.md`.
A finding's location is matched to a file of the
repository: one the change touches, or an unchanged file such as a
caller, marked outside the change; a location that names no such file
and line is kept and marked unlocated, never dropped. A blocked
run exits 2 with the blocker and its action on stderr, and so does a
refusal, such as another engine holding the run, a runtime that does not
qualify, or an active run that belongs to another worktree or runtime.
While it runs, stderr has a line per phase and per worker: each phase
line ends with the time since the run was created and the spend so far
against the run budget, as the budget check counts it (or `no cost
reported`), and each fixer's start line says `batch <k> of <n>` of its
round.
A resumed run keeps the scope, policy, executable and Codex Windows
sandbox it pinned, and refuses a `--codex-windows-sandbox` naming
another; only
`--concurrency` and `--budget-usd` apply to each invocation, and
`--check` and `--no-check` until the checks are planned. Until then
they are not recorded, so every invocation must give them again: a
resume that leaves one out drops it. The log names the kinds it can
tell were dropped, those a flag settled when the survey answered, and
the survey is asked again for them. `deep-review
status` prints the fold of the active run, as text or `--json`, with
the `Scope:` line of the scope it captured, and with `--json` the paths
it reviews and at most the first 2000 paths it left out, as the run
recorded them, with `excludedCount` counting them all; `status --run
<id>` prints another run, and `status --all` lists the 20 newest runs
of the checkpoint, newest first, each with the first eight characters
of its id, its state, its scope and the copy of its current report,
and counts the others; `status --all --every` lists every run. Both
count the runs this engine cannot read, which a newer one lists.
`deep-review abandon --reason <text>` closes an active or blocked run.
Each command that takes `--run` takes the whole id or its first eight
or more characters.
The engine ships as one esbuild bundle, `engine/main.mjs`, in both
artifacts, with a sidecar holding its version and hash and a copy of
`roles/`; every event the installed engine writes carries
`<version>+<hash prefix>` as its engine.
See `docs/changes/2026-09-27-read-only-review.requirements.md` and its
design.

## The decision step

Every run configured since the decision step, `--fix` or not, runs a `decision` phase after merge and rank: one `decider` worker, read-only with a shell, is given every ranked finding with each candidate merged into it and that candidate's own verdict and evidence, and decides each finding whole. It grades nothing again. A finding is decided `fix`, with the approach a fixer applies and the options rejected; `leave`, for one of four reasons and no other (acting on it would edit only code outside the change, which neither caused nor worsened it; another finding's fix removes it; the repository states the behavior on purpose and the rule's reason reaches the case, or the change's stated intent or the repository's stated contract settles a choice in favor of the code as it is; or, the reason `settled`, acting needs a choice between two shapes only a maintainer would see, which the `shape` step settles in favor of the code as it is); or `ask`, one question the repository cannot answer, with its options, what each costs, the rule a convention source would state for it, the option recommended and the default applied, which is the option easiest to take back. An ask never stops the run. A choice is settled by the change's stated intent (`intent`), then the repository's stated contract (`contract`), then for a regression the behavior before the change (`before`), then keeping what was there (`kept`), then for two shapes only a maintainer would see the one the surrounding code uses, else the one that adds less (`shape`); the order is a presumption the decider may rebut, with the rule's own reason found first and a fact, not a preference, against it, and a departure is named on the decision. Two steps stand outside the order: `scope`, a fix that keeps to the part inside the change, and `none`, when no choice remains. Each decision records the choices it settles, each with the candidates whose verifiers named it, the step that settles it and the source that step rests on. One table of rules says, for each kind of decision, whether it must, may or must not settle a choice and by which steps: an ask and a leave of code outside the change settle none, and a leave as `settled` settles each choice by `shape`. The engine refuses a decider answer that breaks a rule, naming every fault, and the ledger refuses an event that breaks one when it folds. A run with no finding launches no decider; a decider that fails twice blocks the run with `worker-failed`, since no fixer may act on a finding nobody decided. The brief at the top of the report asks the questions and names the fixes that depart from a rule; its Decisions section lists how each question stands, the findings to fix with their approach and any rule departed from, and the findings left with their reason. A run configured before the decision step records the phase as skipped and reads as it did. See `docs/changes/2026-10-08-decision-step.requirements.md` and `docs/changes/2026-11-06-choice-settled-on-the-record.requirements.md`, each with its design.

## The fix pass

`deep-review review --fix` runs seven more phases between the decision
and the report: baseline checks, fixes, documentation, checks, checks on
the base, repair and repair checks. A run without `--fix` records them as
skipped and is the
read-only review exactly. Whether a run fixes is pinned when it is
configured, and which checks it runs when its survey completes; a
resumed run keeps both and says when the command asks otherwise.

A finished read-only run is continued rather than reviewed again. With
no run active, `review --fix` given the scope flags of a change that a
read-only run of this worktree reviewed to its report continues the
newest such run, when it was configured with the decision step and the
change is unchanged since: the same mode, base and paths, every file
holding what the run froze, compared as git would store it, and `HEAD`
at its head. The run
pins the fix pass, asks its surveyor only for the checks the flags leave
unsettled, the convention sources its review recorded standing, runs the
seven phases on the findings and decisions it holds, and writes a second
report whose header names the first. No finder, verifier or decider
runs again, and the run budget is the run's over both passes. A run
whose decisions send no finding to a fixer is refused, and so is one
that went on without its survey unless the flags settle every check.
When no finished run qualifies, the log names the newest finished
read-only run of the worktree and why, and a new run is created;
`--fresh` creates one without looking. An active read-only run still
ignores `--fix`, and, when it was configured with the decision step,
says how to continue it once its report is written. A run whose spend
already reaches the run budget is refused before anything is pinned,
naming `--budget-usd`, and stays continuable. See
`docs/changes/2026-10-10-fix-pass-continuation.requirements.md`
and its design.

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
`already-applied`, `deferred`, `blocked`), a note, and for a finding
it edited, the files and their commit message, which for a blocked or
deferred finding says the change is partial, and per finding how it
validated the fix, each entry citing the shell runs it rests on in the
form of a verifier's cited run. The engine looks for each in the
fixer's record as it looks for a verifier's and records whether it
found it, but never refuses an answer for a run it did not find, so the
edits stand and the report names that run. A fixer's task gives each
candidate's cited runs and frozen probe, and asks it to run the probe
on the code before its fix and after it, when it can, and cite both.
The documentation worker, the repair worker and an answer pass cite
their runs in the same way.
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

A fixer brings in line a document its own edit made stale in the same
finding, claiming the file first, so a fix and its documentation are
one commit. When the claim is refused the finding is not blocked: the
fixer reports the stale fact as `drift`, a file and what is stale. Once
every unit of the fixes has settled, the second round too, the
documentation step runs one `documentation` worker, when the fixes
changed a file and the run budget stopped none of them. The engine first
records its plan: one item per document the `drift` lines name, its path
read as the engine reads any path a worker reports, and one more for the
worker's own search of the repository for documentation the edits of
the run made stale. The worker gets the lines, the patch of each
revision of the fixes, the decisions and the answers. It owns the files
the fixes revised and each named document, may edit any other file an
item needs, and answers each item once: brought in line, already
correct, or left with a reason, such as a choice nothing settled, a
convention source, a historical record or a path `scope.exclude` keeps
out. Each item it edited becomes one revision and one commit. A path the
engine refuses, such as one outside the repository, stays an item the
worker can only leave. The step never blocks the run: when its worker
fails twice or the budget is reached first it is not attempted, and the
run goes on to the checks, which run after it and so check its edits;
the repair owns its files as it owns those of the fixes. The repair and
the fixer of an answer pass are alone in the tree, so they update a
document their own edits make stale with no claim, and the task of an
answer pass lists the documents the run left out of date. A run
configured by an engine before the step never gets it, also when a newer
engine continues it.

Each document the run knows its edits made stale and did not bring in
line is an item of What needs you in the brief, counted in the line
above the items: one the step left or found out of date at its end,
every `drift` line of the fixes when the step did not run, and one the repair or an answer pass reported after it. A part of
the brief lists each with its file, what is stale and why it was left,
and the count of one ends when a later answer pass edits its file and
reports it stale no more. See
`docs/changes/2026-10-23-documentation-step.requirements.md` and its
design.

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
of them stops the run. A tracked file outside the change that a fixer's
own tool rewrote and nobody claimed, such as `dist/` after a fixer ran
the build, is a stray too, in no fixer's commit. A check that rewrites tracked files, a build that
regenerates `dist/`, is recorded as the check's revision, judged against
a list of every tracked file taken just before it, so the rebuilt
tracked files are the series' last commit rather than a change left in
the worktree. A file the check creates, such as a new file a build
writes under `dist/`, is not tracked, so it stays a stray, named in
the notes of the run and in no commit.

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
failures are new is the worker's reading; the engine parses no output.
A check that failed before any fix and fails after the fixes too first
runs once more on the commit the change starts from, `build` before it,
in a temporary git worktree that git keeps locked with the run's id and
the engine removes. Nothing is installed there and the hooks of the
repository are off. The check's environment there loses git's
repository variables, a `VIRTUAL_ENV` inside the reviewed tree, and the
entries inside the reviewed tree of `PATH`, `PYTHONPATH`, `NODE_PATH`,
`PERL5LIB`, `PERLLIB`, `RUBYLIB`, `GEM_PATH` and `CLASSPATH`; every
other variable, such as `PWD`, `HOME` or `CLAUDE_PROJECT_DIR`, is
inherited as it is, and may still name the reviewed tree. The repair
worker also gets that output and says whether the change as submitted
has a failure the base does not have; the brief
gives that as the repair's reading. See
`docs/changes/2026-10-28-facts-before-a-merge.requirements.md` and its
design. In the fixes and repair
phases the run budget stops new launches instead of blocking the run:
what was not launched is reported not attempted, and the run still
reaches its report.

On Windows a Codex run chooses how its workers are confined with
`--codex-windows-sandbox`, else the policy's
`runtimes.codex.windowsSandbox`, shipped as `none`, the one value under
which a gate on zod reached its report untouched with editors that ran
the build and the tests. The value is pinned on the run and named in
the facts of the run at the end of the report; on another platform the flag is ignored with a
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

The report gains Documentation updates, Checks and Patches, and beside it the
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

## Answers

A person answers a question the decision step asked, or accepts or
rejects a fix's departure from a rule, with `deep-review answer
--finding <number>` and one of `--option <n>`, `--accept` or
`--reject`, after the run has written its report; an id of the engine
names its finding too. The brief at the top of the report gives each
question and each departure with the command that answers it, and
About this run at its end says once how a person
at a terminal types it: no `deep-review` executable is installed, so
they name `node "<entry>" answer ...` with the path of the engine that
wrote the report. The answer is recorded on the run's ledger first, with an optional
`--note`. On a run that only reviewed, `review --fix` then continues
the run and gives the answered finding to a fixer, which is told the
answer. On a run that fixed, the command opens an answer pass: one
fixer, told every answer that still owes an edit and what the run did
with each finding, makes the tree hold what the person decided, the
checks run again, and a second report is written; `deep-review commit`
commits the pass's edits on top of the commits it already made for the
run. An answer that confirms the applied default, the option an earlier
answer applied, or a departure as the fix made it owes nothing and runs
no fixer; any other option owes an edit, even one that keeps the code
as it is. The pass is refused, the answer staying recorded, when
`HEAD` or a file the run expects moved, or when the spend has reached
the run budget; `--record-only` records without a pass, and when the
answer owes an edit the next answer given without it applies that
answer with every other recorded answer that owes one; of an answer
that owes nothing, it says so, as an answer without it does.

An answer is applied to its run and recorded there. Nothing yet carries
it to the next review, which may ask the same question again. See
`docs/changes/2026-10-11-answers.requirements.md` and its design.

## Reviewing a pull request

`deep-review review --pr <number>` reviews a pull request on GitHub: the change from the merge base that GitHub gives for its base branch to its head, which must be the `HEAD` of a clean tree. A number names a pull request of the repository that `gh` takes as the clone's. A URL, such as `--pr https://github.com/<owner>/<repo>/pull/42`, names the host and the repository as well, and is the way to name the pull request when `gh` cannot tell the repository of the clone. A URL whose host names a port is refused, since `gh` names a host without a port. `--pr` is a scope as `--branch` is: it goes with `--path`, `scope.exclude` and `--fix`, and is refused with another scope flag or with `--base`. `config show --pr` prints the scope that the review would capture, and refuses what the review would refuse.

The engine reads GitHub and posts to it through the GitHub CLI, `gh`, with `gh api`, as the account and on the host that `gh` uses: the one that `gh auth login` stored, or the one that `GH_TOKEN` gives (`GH_ENTERPRISE_TOKEN` on a GitHub Enterprise Server). It never asks for, keeps or sends a token, and no token reaches its ledger or its logs. `github.executable`, `gh` as found on `PATH` by default, and `github.args` are operator-only settings, so a file of the repository never chooses a program that runs on the operator's machine. A read-only run of a pull request records both with its settings, but every command that calls `gh` resolves them again, `publish` included, which takes no `--set` and runs `gh` as the operator's and the clone's file name it when it starts. A missing `gh` is refused with what to do, install it or name it with `github.executable`, and so is a `gh` with no account for the host: run `gh auth login`, or set `GH_TOKEN`.

Before a run exists, the engine reads the pull request and holds the worktree to it. It refuses, in this order, each refusal naming its action and leaving no run behind: a URL of a repository that GitHub now gives under another name, as after a rename or a move, naming the URL to give `--pr`; a pull request that is closed or merged; a `HEAD` that is not its head, to be checked out, for example with `gh pr checkout <n>`; a tree with uncommitted changes or untracked files; a merge base that the clone does not hold, to be fetched, such as with `git fetch --unshallow` in a shallow clone; and a change from that merge base whose paths are not the ones GitHub lists for the pull request, naming up to ten paths of each side. A pull request of more than 3000 files is refused before its files are listed, since GitHub lists no more. A path that `scope.exclude` leaves out is no difference: the run records it, and the posted review names the pattern that left it out. deep-review runs no `git fetch` of its own.

The capture records the pull request beside the change: its host, owner, repository, number and URL, its base branch and its title, with its body frozen in the evidence store as it stood. No worker reads the title or the body. The run reads GitHub to capture its change, and a later `review --pr` resumes the active run of the worktree, as a review of any scope does, with no call to GitHub. The `Scope:` line of `config show` and of `status` names the pull request, as in `Scope: pull-request #42 of acme/widgets, 1 commit and 3 files, from the merge base with main (3f2a9c1e) to the working tree, which has no uncommitted change`, and About this run gives its URL.

A read-only run of a pull request ends its review with one more phase, `explanation`, after the decision and before the report. One worker of the role `writer` explains the review for a reader of the pull request who knows neither the code nor deep-review. It writes these parts:

- A conclusion: a sentence that names the areas of the major findings, and one sentence for each finding that deep-review would fix or asks about, saying what it would do.
- Areas, for the major findings that ask a person to act: each with a title, a sentence or two on what it is, a diagram where it helps, and its findings.
- For each finding that goes on its line or in full in the body: a title that says what goes wrong for whom, the problem as who meets what, the cases in which it breaks, each citing the lines that show it, one line of how the verifier checked it, and for a minor finding whether it reaches what a user sees or the code.
- For each candidate that the verifiers refuted: one sentence of its claim and one of why it was refuted.

A finding and an area take a Mermaid diagram where the flow takes long to say. A run reviewed before this form, whose writer also gave an account of the change, is posted in the new form, with the engine's words where its answer lacks a part. The writer reads the code at the head, the brief, and the findings with their decisions and evidence, and never the title or the body of the pull request. On Claude Code it has no shell. On Codex, which gives every worker a shell, it has the read-only shell of a verifier. The shipped role policy runs it on the strong tier with a budget of 8 USD, and each read-only run of a pull request pays for it, whether or not its review is posted.

The writer decides nothing. The numbers, verdicts, severities, statuses, decisions, evidence and places stay as the ledger records them, and the engine writes them beside the writer's text. The engine also writes the counts of the summary and the list of what needs a person, and lists the findings of each area in their rank. It checks what it can count in the writer's answer: that each finding the answer names is one the writer was asked to explain, that each line that a major finding cites exists at the head, or at the merge base for code that the change removed, that no part it posts writes a verdict, and that each diagram it posts is a flowchart, a sequence diagram or a state diagram written so that GitHub draws it. An answer that fails runs once more. A second failure, or the run budget, leaves each part that still fails in the engine's own words, and the run writes its report all the same. A finding that the writer cannot explain from its evidence and the code is marked unexplained, and the review gives it in the engine's own words with a mark that tells the reader to look at it. The checks find a cited line that does not exist, not a wrong reading of one that does: each case is a model's account that no verifier examined. So the section on how far to trust the review says that a model wrote the explanations from the verifiers' evidence, which the report of the run holds, and that only that evidence was verified, and a finding that no verifier examined is marked unverified. The writer's text appears only on the pull request and in `publish --dry-run`. The report of the run does not change.

The role policy of every review names the writer, whatever its scope, so a directory of roles that `--roles` names must declare `writer` in its `manifest.json` and give it a tier, an effort, a budget and a timeout in its `policy.json`. Until it does, the engine refuses every run with that directory, since the policy must name exactly the roles that the review runs.

`review.language`, `en` by default, is the language of the review on the pull request, as a language tag such as `en`, `ko` or `pt-BR`. The writer writes in it. The words that the engine writes itself, such as its headings, the line of what the pull request needs and who answers a question and how, come from a table of that language. The engine has tables for `en` and `ko`, and for another language its own words stay in English. The gaps of the brief and the words of the other workers stay in English in a review of any language, and verdicts, severities, identifiers, paths and commands are never translated. The setting is repository-first: the repository's file sets it over the operator's, since the people who read a pull request share its repository, and the clone's file and the command set it over both. When a repository reviews in another language than the one the operator's file names, and its own file sets none, set it in the clone's file, `review.language = "ko"` in the `deep-review.toml` that `config init --clone` writes, or for one run on the command, `--set review.language=ko`. A read-only run of a pull request records the language with its other settings before its first worker, so a resume and `publish` use it whatever the files say later.

## Posting the review

`deep-review publish` posts a finished read-only run of a pull request as one review of that pull request, on the head that the run reviewed, and prints the URL of the review as the last line of stdout. It chooses the run as `report` does, and `--run <id>` names another. The review is always a comment: it never approves and never requests changes, so the merge stays with the people and the rules of the repository. GitHub shows it as the account that `gh` uses, which is often the person who ran the review, and its body says that deep-review wrote it. `review --pr` posts nothing: posting is a separate command, which a person or a workflow chooses to run. A run is posted once, so a second `publish` posts nothing, prints the URL of the review and exits 0.

`publish` refuses, with exit 2 and the action, and posts nothing: a run with no current report; a fix run, or a read-only run that `--fix` continued; a run of another scope than `--pr`; and a run that `--path` narrowed to part of the pull request. It then reads the pull request again through `gh`, and refuses a missing `gh` or one with no account for the host, a pull request that is no longer open, a head that is not the run's head, a base branch or a commit that GitHub no longer has, and a merge base that is not the run's base, since a run is posted only on the change that it reviewed. A read that times out, gets a server error, or gets an answer it cannot read exits 1 and posts nothing, so `publish` can run again. When the pull request has moved since the review, a new run of `review --pr` reviews its new head in full.

`review --pr <number> --fix` continues a finished read-only run of the pull request into the fix pass, as `--fix` continues a read-only run of the same change, and the run is then a fix run, which `publish` refuses. Only a `--pr` that names the pull request continues its run: `--fix` with another scope flag, or with `--pr` naming another pull request, creates a new run, and the log says why it did not continue the run of the pull request. To have the review on the pull request, post it with `publish` before you continue its run with `--fix`. The edits of a fix run never reach the pull request: not as suggestions, and not as commits pushed to its branch.

The body of the review holds, in this order:

1. A heading, and a line that names the head and the merge base that the run reviewed, how many files changed between them, and that the run changed no file.
2. A summary: how many findings the review keeps and how many of them are major, the writer's sentence that names the areas of the major ones, left out when the checks dropped the writer's areas, how many deep-review would fix, ask about and leave as is, and that nothing on the branch changes until the person who ran the review runs `review --pr <n> --fix`.
3. What needs a person, in one list: each question, with the option that deep-review recommends and the one that stands until someone answers; and each fix against a written rule, with the rule. The list ends with the one command that answers, and a run with nothing that needs a person says so.
4. How the review worked: what the finders, the verifiers and the decider do, the counts of the run as its ledger holds them (the candidates, how many remained after merging duplicates, how many the verifiers refuted and kept, how many joined another finding, and how many findings remain), a fixed diagram of the steps and of what follows the post, what each verdict and severity means, and the three values a severity is read from, which each finding's reason names; the run report defines the same values before its first finding.
5. The major findings that ask a person to act, by area: each area with its title, a sentence or two and a diagram where it helps, and one line for each of its findings, with its number and title linked to where it is read, its verdict, and what deep-review would do or, for a question, what it recommends. A run whose writer gave no areas has one area, named by the engine.
6. Each finding that has no comment and asks a person to act, in full, as its comment would give it.
7. The minor findings: how many there are, what they reach and which of them need a person, then their table, folded.
8. The findings left as is, folded, each with why and, when its decision settles a choice or its verifier left one to the author, the choice: the one deep-review settles, the step that settles it, such as the stated intent of the change or what the repository states, and the source that step rests on, beside the verifier's choice, or the verifier's choice and that deep-review did not settle it.
9. What the review did not examine: that no check ran; each pattern of `scope.exclude` that left paths out of the run, with its count and the layer of the settings that set it; each other gap of the brief, such as an angle that did not run; and the candidates that verification refuted, folded, each with its line, its claim and why it was refuted.
10. How far to trust the review: the counts of the verdicts, of the major findings `CONFIRMED`, of how the findings were checked and of the refuted candidates, and that a model wrote the explanations from the verifiers' evidence, which the report of the run holds, and that only that evidence was verified.
11. A last line with the version of the engine, the runtime and its models, the run, and the commits it reviewed, then the marker of the publication, an HTML comment that GitHub does not show.

Each finding that deep-review decided to fix, with or against a written rule, or that it asks about, gets a comment on its line when that line is on the new side of GitHub's diff of the pull request. The comment says each fact once, in this order: the number of the finding and the writer's title for it; one line with its severity, its verdict with how the verifier checked it, and what deep-review decided; what goes wrong, in the writer's words, with why a `PLAUSIBLE` verdict was not confirmed; the writer's diagram; then, for a fix, what deep-review would do in one sentence, the choice it makes when it settles one or its verifier left one to the author, as a finding left as is gives it, the departure from a written rule with its rule, its source and the fact against it, and the decided fix with the options it rejected, folded; or, for a question, why it is one, its options with the cost of each, the option that deep-review recommends and the one that stands until someone answers, and the command that answers it. Last come one line of how the verifier checked the finding, folded, the lines of code it rests on, and a small line with the id of the finding and the run. The comment of a minor finding gives its problem and what deep-review would do in one paragraph, then a paragraph for each choice its verifiers named or its decision settles, its departure if it has one, the folded fix and one line of code. A comment on a line that the pull request does not change, a context line of the diff, says so. Every other finding is in the body: one left as is, one whose line is outside the diff, one in a file that GitHub shows no diff of, and one with no place in the repository. Each link to code is a permalink to the file at the reviewed head, or at the merge base for lines that the change removed, so a later push does not move it; the body links a finding that has a comment by the line that its comment sits on, and a finding in the body by its anchor. Each question and each departure is in full once, in its comment or in the body.

A question and a departure end with who answers and how: the person who ran the review, on the machine that holds the run, with `deep-review answer`. A reply on the pull request is not read yet. An answer recorded after the writer and before the post changes what the engine writes, and the body names each finding that the explanation predates. A posted review is never posted again or edited, so an answer recorded after the post does not reach the pull request.

The rest stays on the machine: the report, with its About this run, which names local paths, and the evidence store, which a reader of the pull request cannot open. The evidence of each verdict and the runs it cites stay there too: the review gives one line of how the verifier checked each finding, and a reader who wants more asks the person who ran the review for the report. deep-review posts no check run, no approval and no request of changes.

GitHub makes each comment on a line a conversation that a person resolves, and a repository can require each conversation to be resolved before a merge, with the rule "Require conversation resolution before merging". In such a repository each comment of the review holds the merge until the author of the pull request or someone who can write to the repository resolves its conversation, in their own name, once they have read it. A finding left as is gets no comment, so it holds nothing. A request of changes would hold the merge in the name of the account that posted it, until that account or an administrator dismissed it, which is why the review is a comment.

Before it posts, the engine cleans each text that it did not write: the words of the workers and of the writer, the version and the models of the runtime on the last line, and the patterns of `scope.exclude`:

- A token of a known form, from GitHub, Anthropic, OpenAI, AWS, Slack or a private key block, becomes `[redacted <kind>]`, and so does the value, 8 characters or longer, of each variable of the command's environment whose name holds `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY` or `CREDENTIAL`, where it stands whole, not inside a longer word or path. The publication records how many it replaced, never a value.
- A path under the worktree becomes the path from the root of the repository. A scratch directory becomes `<scratch>`, the checkpoint `<checkpoint>`, the git common directory `<git>` and the directory of the engine `<engine>`. Any other path that starts at the root of the machine, at a drive letter, at a UNC share or at `~` becomes `<local path>`.
- Outside code, a mention such as `@name`, a reference such as `#12`, `GH-12` or `owner/repo#12`, and the URL of an issue, a pull request or a discussion are written as code, so they notify no one and leave no trace in another issue. The writer's text holds no link or image of its own: each link of the review is one that the engine builds.

A diagram of the writer is checked again once cleaned, and one that its cleaning broke is left out, with a line that says so in its place.

The cleaning finds only these forms. A secret of another form, or one that only the environment of a worker held, is posted, and so are words that name the machine without a path, such as a user name or a host name in a sentence. The cleaning does not judge what a text says: the change under review can hold text aimed at a model, and a sentence that such text puts in the words of a worker or of the writer is posted as written. A finding whose evidence does not bear out its verdict is posted as the run recorded it. Read the dry run before you post, and do not post on a repository that cannot take these risks in public.

`publish --dry-run` reads the pull request, makes every check, and prints where each finding goes and why, what was cut from the body to fit, how many secrets the cleaning replaced, then the body and each comment with its path and line. It posts nothing and records nothing. A publication that a stop left open is not settled either: the dry run looks for its review, and says what the next `publish` would record. When a review carries its marker, the dry run prints its URL as the last line and ends, since the next `publish` records it as posted and posts nothing. When none does, the dry run goes on as if the publication were dropped, and prints the review that the next `publish` would post.

The engine records the publication on the ledger before it posts: the pull request, the head, the text frozen in the evidence store, and where each finding goes and why. After the post it records the review and the comment of each finding, which it matches to its finding by a marker on the comment's last line. A stop between the record and the post is settled by the next `publish`: it looks among the reviews of the pull request for the marker on the last line of the body, records the review that carries it as posted, and records the publication as not posted when none does, before it posts again. A review that GitHub made but does not list yet is the one case in which a stop can still post twice. A refusal of GitHub is recorded with its status and message, and `publish` exits 2 with the action: GitHub's message for a 422; the wait for a 403 or a 429 that names one, or the time of the reset when no request of the hour is left; `gh auth` for a 401 or a 404; and for another 403, that the account or the token cannot write to the pull request. A timeout, a server error, or an answer it cannot read leaves the publication open and exits 1, and the next `publish` looks for the review before it posts; so does a review whose comments cannot be read after the post. A settle whose read of GitHub fails records nothing and exits 1 too, and the next `publish` settles again. Once the run is posted, `status` and About this run name the review on a line of its own, `Review: <url>`, and `status --json` gives it as `postedReview`.

A body or a comment stays under 60,000 characters, a margin under what GitHub takes. A longer body is cut, first the refuted candidates, then the findings left as is, except those whose verifier left a choice to the author, so no such choice is missing from the review, then the table of the minor findings, each of which has its comment on its line or its text in full above, then the diagrams of the areas, and never in what needs a person, the areas or the findings in full. The body names each cut and where what it cut is kept: the report of the run holds the refuted candidates, the findings left as is and the minor findings, and the writer's answer on the machine that holds the run keeps the diagrams of the areas. A body that still does not fit, and a comment that does not, are refused with their size before anything is recorded.

### In a workflow

deep-review ships no workflow, but both commands run in one, such as a GitHub Actions job on `pull_request`, with what they need on any machine: Node 26, the engine, and a runtime that can run its workers. A job also needs the head of the pull request checked out with its history. By default `actions/checkout` checks out a merge commit of the pull request, which is not its head, and only that one commit, so the clone holds no merge base. Give it `ref: ${{ github.event.pull_request.head.sha }}` and `fetch-depth: 0`.

Both commands need a token that `gh` reads: `review --pr` to read the pull request, and `publish` to post its review. Set `GH_TOKEN: ${{ github.token }}` in the environment of each step, and give the job `permissions` with `contents: read` and `pull-requests: write`. A workflow that a pull request from a fork starts gets a token that cannot write, so GitHub refuses the post, and `publish` says that the token cannot write to the pull request.

A run of a pull request launches its workers without `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`, which only the engine's own calls of `gh` need. That keeps the token out of the workers' environment, not out of their reach: a worker runs as the same user as the engine, a verifier runs the code of the change, and that code can read the environment of the engine's process, or, on a person's machine, use the account that `gh auth login` stored. So review with a token that can write only code that the workflow would run with that token anyway, such as a pull request from a branch of the same repository. Never check out the head of a pull request from a fork in a workflow that `pull_request_target` starts: that event gives the job a token that can write, and the review would run the fork's code with it.

The record of the run is the checkpoint, under the git directory of the clone, which goes away with the job. A review that a workflow posts still says who answers each question and how, but no one can answer it once the job has ended, until a later change keeps the checkpoint across jobs.

See `docs/changes/2026-11-01-review-on-the-pull-request.requirements.md` and its design.

## Resuming after a stop

A run can be stopped at any point: a Ctrl-C, a kill of the engine
alone or with its process tree, or a kill of the worker or check it is
waiting on. The same command then resumes it, and needs nothing else
from a person. It does again only the work the stop cut short, pays for
no worker that settled before the stop, records nothing false, and
reaches the report the run with no stop would have written; only the
lines that say what the stop did, the statistics and the spend differ.
A check a kill ended (a signal, or an exit code a shell or Windows
gives a killed process) is cut, not failed: what it wrote is written
back, and it runs again. A fixer lost with its engine keeps only its own
files, so a person's edit made while no engine ran is found as a drift.
Each worker and check runs under a small guard process, the engine's own
`guard` command, which ends the child's tree when the engine is gone, so
no child outlives a killed engine. A `deep-review commit` cut short
records its series before the branch moves, and the next command
completes it or drops it by where `HEAD` is. A `deep-review publish`
cut short records its review before the post, and the next `publish`
records it as posted or not by whether a review of the pull request
carries its marker. The notes of the run in
the report and `status` name what each stop did. `npm run resume-test` stops a run
on the fakes at every point, in each way, and checks this contract; the
suite runs a fixed set of those points.

On a runtime that reports cost, a fix pass the run budget stopped is a
complete run with work left. The same `review --fix` with a
`--budget-usd` above the spend reopens it, launches only what the budget
left, and reviews nothing again; the end of the run, its report and
`status` name that command. A worker that meets a usage or session limit
of Claude Code blocks the phase at once, naming the reset, and the same
command after the reset resumes the run with no unit given up. See
`docs/changes/2026-10-18-resumable-runs.requirements.md` and its design.

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
the triage, from the check settings over the survey: a `checks.<kind>`
setting (see Configuration below), a `--check <kind>=<command>` or a
`--no-check <kind>` settles its kind, and the surveyor chooses the
rest from what the repository's CI and
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
the block with no new survey. The action also names `checks.<kind>` in
the clone's file, which `config init --clone` writes, for a new run in
place of the blocked one: a resumed run keeps the settings it recorded,
so only a new run reads that file, and no resume of it needs the flag.
A run that `review --fix` continued from a read-only review blocks in
its survey after that whole review, and an abandoned run cannot be
continued, so its action leaves the clone's file out and names the
three ways alone. A survey that fails twice degrades a
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

## Configuration

A run can take its values from up to four TOML files, each optional and
each starting with `schema = 1`. The repository's file,
`.deep-review/config.toml`, states the review policy of the repository
and is committed with it. The operator's file states one person's
preferences for every repository: `%APPDATA%\deep-review\config.toml` on
Windows, else `$XDG_CONFIG_HOME/deep-review/config.toml` or
`~/.config/deep-review/config.toml`. The clone's file,
`deep-review.toml` in the git common directory, holds what is true of
one clone, outside every commit and shared by its worktrees. The file
`--config <file>` names applies to one run, and so does each
`--set <setting>=<value>`, whose value is TOML or else plain text, so
`--set checks.test=npm test` and `--set 'scope.exclude=["dist/**"]'`
both work. The dedicated flags such as `--budget-usd` are the same
settings, and a flag and a `--set` for one setting are refused together.

Each setting has one owner, and the owner decides whose value wins when
the repository and the operator disagree, from the lowest layer to the
highest:

| Owner | Order, lowest first |
|---|---|
| repository-first | default, operator's file, repository's file, clone's file, `--config` file, flag |
| operator-first | default, repository's file, operator's file, clone's file, `--config` file, flag |
| operator-only | default, operator's file, clone's file, `--config` file, flag |

A rule or fact of the repository, such as `scope.exclude`, a check
command, `checks.timeout_minutes` or `review.language`, is
repository-first: an operator's
general preference only fills a gap. The money and taste of the
operator, `budget.usd` and the models, are operator-first: the
repository's value is a suggestion. A fact of the operator's machine,
such as `tools.path`, a runtime's executable or `github.executable`, is operator-only, and
so are `scope.default` and `review.base`, which choose the change. The
defaults are the role policy's, so with no file and no new flag a run
pins what it pinned before. `deep-review config explain` lists every
setting with its owner, default and flag.

The engine reads the repository's file as the base of the change holds
it, through git, never from the working tree or the change itself:
agents write most changes, and a change that could edit the file could
leave its own paths out of the review, drop a check, or replace one
with a command that always passes. An edit to the file applies from the
next change; the run says so on stderr and in its report. A file the
engine cannot read refuses the run before it exists, naming every
problem; when the repository's file at the base is the broken one,
`--no-repository-config` reviews the change that repairs it, and the
report says the policy was not applied.

With no scope flag, `scope.default` chooses the scope: `auto`, the
default, reviews the uncommitted change when the tree has one and the
last commit otherwise. `--branch` reviews the change from where the
branch left `review.base`, by default the branch `origin/HEAD` names,
and `--base <rev>` names another for one run. `scope.exclude` lists
glob patterns, in git's pathspec syntax, of changed paths that are
never part of the review: git leaves them out of every list of the
change and of the patch, and the report names each path they left out.
A change with no path left to review, or none at all, is refused before
a run exists. `checks.<kind>` settles a check as `--check` or
`--no-check` does, so the survey is not asked about it and a resumed
run needs no flag again; `tools.path` puts directories first on `PATH`
for every worker and every check, relative ones to the root of the
worktree. Since the fixers run the engine's own commands with the first
`node` on that `PATH`, a fix run refuses a `tools.path` whose `node` is
older than Node 26.

A run records each value with the layer it came from, and every file
it read with its hash, in `review.configured`, before its first worker.
A resumed run keeps those values, and says on stderr which file or
setting changed since and is not applied; the concurrency and the run
budget still change per invocation by flag. The facts of the run in the
report name the files a run read and, beside its `Settings:` line, each
path left out, each repository value a higher layer replaced and each
setting ignored; its brief names the paths left out as a gap.
`deep-review config show` prints what a run would use, without starting
one: the change, as `Scope: <mode>, <commits> and <files>, from <base>
to <end>`, with the mode as the person asked for it (`branch` for
`--branch` and for the same range from `--from <base> --to HEAD
--merge-base`, as `status` names it), the commits on the first parent
and the files the run
reviews, the paths `scope.exclude` leaves out counted apart, the base
by its name and short commit, and the end a commit or the working
tree, with how many reviewed files hold uncommitted changes; with
`--json`, also the path of each reviewed file and each path left out;
and each value with its origin; `config validate` checks a file as
its layer reads it, the repository's of the working tree by default;
and `config init --repository`, `--operator` or `--clone` writes a new
file with every setting commented at its default.

This repository's own file leaves out the build output and the golden
fixtures, names its four checks, and suggests the budget its fix runs
need:

```toml
schema = 1
scope.exclude = ["dist/**", "test/fixtures/checkpoints/**"]
budget.usd = 120

[checks]
build = "npm run build"
typecheck = "npm run typecheck"
lint = "npm run lint"
test = "npm test"
```

See `docs/changes/2026-10-16-configuration.requirements.md` and its
design.

## Developing

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for
mise and asdf.

On Windows, Defender scans every file the suite writes, most of them the
checkpoint artifacts of the reviews it sandboxes under `TEMP`. Two
per-machine steps shorten a local run, and the repository needs
neither. A Dev Drive that holds the checkout and `TEMP` took 7 to 13%
off a run when measured. Instead, a Defender exclusion of
`C:\Users\<user>\AppData\Local\Temp\deep-review-*`, written in full
because Defender expands `%TEMP%` as the system account, gives at most
the same by estimate, and gives up scanning there.
`docs/reports/2026-10-14-test-and-ci-time.md` (lever D) has the
measurement.

```sh
npm ci
npm run check     # lint, typecheck, test
npm run test:contract   # the contract test of resumable runs, left out of check
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ matches skill/ byte for byte
npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>   # after a ledger schema or registry change
npm run smoke -- --claude <path> --codex <path> --codex-model <model> [--codex-windows-sandbox unelevated|elevated|none]   # real runtimes, by hand
npm run roles -- --output <dir>   # write every assembled role prompt to <dir> for reading
npm run resume-test   # stop a fix run on the fakes at every point, in each way, and check that the same command resumes it
npm run review -- review --runtime claude --last-commit [--fix]   # run the engine from the sources; also status, abandon and commit
npm run replay -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>   # a recorded run's verifiers again, real runtimes, by hand
npm run replay-score -- --results <results.json> --labels <labels.json>   # the replay's samples against labels; calls no model
npm run replay-decider -- --checkpoint <dir> --run <id> --tree <dir> --output <dir> --runtime <claude|codex>   # a recorded run's decider again, with the current roles, by hand
```

`npm run check` runs ESLint with type-aware rules, `tsc --noEmit`, and the
`node:test` suites against the TypeScript sources directly; nothing is
transpiled. `npm run build` bundles `src/cli.ts` with esbuild into each
artifact's `engine/main.mjs`, writes the sidecar and copies `roles/`
beside it, then copies the skill sources. It replaces each
`dist/<runtime>` tree wholesale, so a renamed or removed source never
leaves a stale file behind. `npm run verify` assembles both
artifacts into a temporary tree and compares them with the committed
`dist/`, bundle included, so a commit that claims to change only where
text lives can be checked rather than trusted. Continuous integration
runs both on Windows, macOS and Linux. `npm run test:contract` stops a
fix run on the fakes at a fixed set of points and runs the same command
again (the contract of resumable runs); it starts the engine as a real
process for each case, which makes it the costliest file of the tests, so
`npm run check` leaves it out and continuous integration runs it as a job
of its own on the same three systems.

The suite never calls a model: fake Claude and Codex CLIs stand in for the
real ones, and for the review they answer from a script per role and
unit, so a whole review runs through the controller in a test, with
failures, hangs, a killed engine and a drifted tree where a case needs
them. A scripted fixer edits the tree and runs the claim and snapshot
commands its prompt quotes, and a stand-in check passes, fails, hangs or
writes as a control file says, so a whole fix run runs there too, no
toolchain needed. In a review sandbox the engine is given a process
runner that runs those fakes and the stand-in check inside the test's
own process (`test/helpers/in-process-runner.ts`), so a whole review
starts no process for them; a fake that must hang with a grandchild, the
runtime tests and the contract test start them as real processes, as a
real run does. So does a check the survey finds in the sandbox's
`package.json`: it runs as `npm run <kind>` through the real runner, which
starts npm, a shell and the stand-in check. `npm run smoke` is the real-runtime check, for each CLI named
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

`npm run replay-decider` runs a recorded run's decider again with this engine and the current roles, which is how the second gate of [the settled choice](docs/changes/2026-11-06-choice-settled-on-the-record.requirements.md) (R8) measures the decider on the findings and verdicts a real run recorded, for the cost of one or two deciders. It reads a copy of the run's ledger up to the moment its decision phase records anything, so a run whose recorded decisions this engine cannot read still replays, and it refuses a run that never reached the decision phase. It builds the decider's prompt as the decision phase does, but with the decider prompt of `--roles`, this checkout's `roles/` by default, and not the roles the run pinned; launches one decider on the runtime named, in a clean checkout of the reviewed commit, with the model, effort, timeout, budget and Codex sandbox of the run's recorded decider launch when that launch ran on the same runtime, and with those of the policy of `--roles` on another runtime or for a run that recorded no decider launch; and checks its answer as the decision phase does. A refused answer gets one more decider whose task names what the check refused (R9), and a second refusal is recorded as such. Into `--output`, which must be absent or empty, it writes each attempt's prompt and answer, the accepted decisions, and the review as `publish --dry-run` prints it, rendered from the run and the new decisions with no writer, each finding placed against the patch the run captured rather than the files GitHub lists. `facts.json` holds what the gate's metrics read: the decider's model and effort, with `settingsFrom` saying whether they are the recorded launch's or the policy's; each attempt with its outcome, what the check refused, its wall time and its cost; what needs a person, split into questions and departures; each fix with its approach; and each finding whose verifiers named a choice, with its decision, its settled choices and each choice no settled choice answers. The recorded checkpoint is only read, and the replay records its deciders in a checkpoint of its own under the output directory. It calls real models and costs real money; `--print-task` writes the first attempt's prompt and launches nothing.

Never edit `dist/` by hand. See `AGENTS.md`.

## Installing

### Claude Code

The repository is its own plugin marketplace. In a Claude Code session:

```
/plugin marketplace add josephjang/deep-review
/plugin install deep-review@deep-review
```

The skill is then `/deep-review:deep-review`, and the autocomplete hints
what can follow it: a scope in words, `fix`, and paths. It runs the
bundled engine with `--runtime claude` on the scope the user named, or
with none named on the one `scope.default` names (the dirty worktree,
else the last commit), waits for it, and shows the report's path.
Before the run it runs `status`, and with no active run `config show`
with the same flags. It then starts the run as a background command,
without waiting for a reply, and only then writes its message, as the
last text of the turn: the `Scope:` line, the `budget.usd` line and
whether the run fixes, or for an active run, which the review resumes
with the scope and settings it recorded whatever the scope flags say,
that run's `Run`, `Scope:` and `Settings:` lines. A message in the
middle of a turn can land in the model's thinking, which a host may
hide. A user who sees a wrong scope stops the run; the skill stops the
background command, then abandons the stopped run before the corrected
request, so that request starts a new run. Asked to fix the findings,
it passes `--fix`, says in that message that the engine's workers will
edit the working tree, that it runs the check commands it chose from
the repository and that the run commits nothing, also when `--fix`
continues a finished read-only run, which starts its checks and fixes
at once, so the user can read it after they begin, and afterwards
offers to commit the edits with `deep-review commit`, after which it
shows the top of the brief again with `deep-review report`. It ends
each turn with the result it relays, in the language the user writes.
Asked for more on one finding, it runs `report --finding <number>`; for
the whole result, `report --brief`; for what the run changed,
`report --fixes`; and for the statistics of the run, `report --stats`.
Asked to review a pull request, it passes `--pr`, and after such a
review that did not fix it offers to post it; asked to post it, and
only then, it runs `publish` and shows the URL that it prints, with no
summary of the review. A review the user wants posted is posted before
`--fix` continues its run, since `publish` refuses a run that `--fix`
continued. Asked for a run the
user cannot name, it runs `status --all`. Asked for a
configuration file, it writes it with `config init --repository`,
`--operator` or `--clone`. Asked why a run reviewed what it did, it
answers from that run's record, `status` for the active run and, for a
finished one, the `Settings:` line of the report's facts of the run and
the gaps its brief lists, since
`config show` says only what a run would take now. The skill's `allowed-tools` approves the
engine's own command with any of its arguments, and nothing else, in
the Bash tool and in the PowerShell tool alike, for the turn in which
the user invokes it, so the run starts without a permission prompt. Those arguments include `--check <kind>=<command>`
and `--executable <path>`, which run what they name; the skill passes
`--check` only for a command the user names. A later
turn, such as one that commits or answers, prompts again. Node 26 or
newer must be on the machine. The plugin carries no
version field on purpose, so `/plugin marketplace update deep-review`
follows the latest commit. The repository is private; adding it uses the
git credentials already on the machine.

On Windows, when PowerShell 7 comes from the Microsoft Store, Claude Code
cannot check any command of its PowerShell tool ("malformed syntax ...
The command line is too long"), so each engine command asks for approval
despite the skill's `allowed-tools`. The fault is in Claude Code,
tracked in anthropics/claude-code#102430. The fix is to turn the
PowerShell tool off, so that Claude Code uses Git Bash, which needs Git
for Windows: add `"env": { "CLAUDE_CODE_USE_POWERSHELL_TOOL": "0" }` to
`~/.claude/settings.json`. To keep PowerShell instead, install
PowerShell 7 from the MSI or the zip and put its folder before
`%LOCALAPPDATA%\Microsoft\WindowsApps` on PATH. The plugin's
SessionStart hook (`deep-review hook session-start`) says the same once
at the start of a new session on such a machine, and nothing anywhere
else; the skill runs its commands with the Bash tool once the
PowerShell tool fails to check one.

From a local checkout, the same two steps take the checkout path instead of
the GitHub name, and the plugin then loads in place: edits under `dist/`
show up at the next session start or `/reload-plugins`.

### Codex

There is no installer. Copy the built skill directory:

```
dist/codex/**   ->   ~/.agents/skills/deep-review/
```

The skill is then `$deep-review`. It runs the bundled engine beside its
`SKILL.md` with `--runtime codex`, after the same `status` and
`config show`, but it writes its message with the scope before the
review, in the foreground of the turn, since Codex shows a message the
model writes before a command;
Codex reports no cost, so a Codex run has no budget and its report says
so. Codex has no counterpart of the argument hint or of `allowed-tools`.
