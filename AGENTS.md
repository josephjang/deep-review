# Working in this repository

Guidance for every agent, Claude Code and Codex alike, working here. It
lives in this one file, which both runtimes read, so the two cannot
drift. Read `README.md` first for the layout and the reasoning behind it,
and the latest vision note, `docs/2026-10-11-vision.md`, for what
deep-review must become.

## Environment

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for mise
and asdf. There is no PowerShell and no shell script anywhere in the
toolchain; every build, check and gate is a Node script, so what runs on
Windows is what runs on macOS and Linux.

```sh
npm ci            # locked development dependencies
npm run check     # lint, typecheck, test; what CI runs, but for the contract test
npm run test:contract   # the contract test of resumable runs; CI runs it as its own job
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ is what skill/ produces, byte for byte
```

## Never edit dist/

`dist/` is build output: `dist/claude` is the Claude Code plugin and
`dist/codex` is the Codex skill, each produced only by `npm run build` from
the sources under `skill/`. Edit the sources, run the build, and commit the
result in the same change: in the same commit when you commit by hand,
or in the last commit of the series when a run of the engine made it. An
edit made directly in `dist/`, or in an installed copy, is invisible to
the build and fails `npm run verify` on the next run.

The build replaces each `dist/<runtime>` tree wholesale, so a renamed or
removed source never leaves a stale file behind.

## The ledger is append-only and forward-compatible

Events in the checkpoint ledger are never updated or deleted; the database
refuses it. A wrong event is corrected by a later event that says so. Every
event kind is declared once in `src/checkpoint/events.ts` with a strict
schema per version, and gets a reducer in `src/checkpoint/fold.ts`; a
changed payload shape is a new version, never an edit of the old schema,
because a newer engine must always read an older ledger.

A change to the ledger DDL or to the set of event kinds fails the golden
test until a new fixture is committed with
`npm run golden -- --output test/fixtures/checkpoints/schema-<schema>-<serial>`,
using the next serial. Older fixtures stay: each must still open and fold
under the current engine, which is the proof that a newer engine reads an
older ledger.

## Before every commit

`npm run check` must pass at every commit. `npm run test:contract`, the
contract test of resumable runs, is left out of it because it is by far
the costliest file of the tests: run it before a commit that changes how the
engine stops, resumes, launches a child or appends to the ledger, and CI
runs it as its own job on every pull request. `npm run verify` must pass at
every head that is pushed, a pull request's head and `main`, since those
are the commits the plugin marketplace and the Codex skill install from;
a commit in the middle of a series may leave `dist/` stale, and the
series then ends with the commit that rebuilds it. A commit that changes
built output includes the updated `dist/` and says in its message what
changed and why.

A commit that changes what a skill or a role prompt *says* and a commit
that changes where that text *lives* are different commits.

Every commit is written to pass `npm run check`, but a series is proven
once, at its head. After a rebase or at the end of a long series, run
`npm run check` at the head, and `npm run verify` where `dist/` matters.
A commit can replay cleanly and still not compile against a renamed
symbol, so type-check and lint each commit, which takes seconds:
`git rebase <base> --exec "npm run typecheck && npm run lint"`. Go back
through the series commit by commit only when the head fails. A rebase
conflict in `dist/*/engine/engine.json`, the bundle hash, is resolved by
`npm run build`, never by taking a side.

## Change proposals

A change that alters observable behavior carries a change proposal under
`docs/changes/`, written before the work and committed with it, following
the practice at <https://github.com/josephjang/change-proposal>. The
proposal holds the judgment the code cannot: why, what was left out, what
was rejected, what was knowingly accepted. A change with no behavior change
says so in its commit message instead.

A proposal is written and reviewed against the latest vision note,
`docs/YYYY-MM-DD-vision.md` (today `docs/2026-10-11-vision.md`), which
states the vision, the premise and the design principles, and lists what
makes a proposal go against them. Before writing a proposal, read the
note; a proposal that departs from a principle names the principle and
the reason, so the next note can revise the principle. A review of a
proposal reads it against the note too, and names the principle a
finding rests on.

The Unified form, one file `YYYY-MM-DD-<slug>.md` titled
`Change Proposal: <name>`, is the default. A change whose technical side
needs its own explanation and review (interacting state transitions, a
migration, compatibility across components, a consequential architecture
choice) takes the Split form: `YYYY-MM-DD-<slug>.requirements.md` titled
`Product Requirements: <name>` and `YYYY-MM-DD-<slug>.design.md` titled
`Technical Design: <name>`, each linking the other below its title. The
two files together are one proposal. The design's Verification section
starts as "no checks have run yet" and is filled by the commit that
completes the element.

Each item of an itemized section (requirements, product and technical
decisions, non-goals, metrics, risks, the test strategy, open questions,
the vision checks) gets its ID and title as a header, such as
`### R1: No file, no change`, with its description and reasoning as
prose paragraphs below. No bullets with a bold title and clipped text,
and no sub-bullets inside an item. A table of reference data, such as
settings with their defaults, may stay when prose introduces it. This
is the form of the vision note's principles. Older proposals keep their
form unless the author asks.

When a review amends a proposal, each finding of high or medium severity
is its own commit whose body gives the reason, so each decision can be
read and reverted alone; low-severity wording fixes may share a commit.
Once the review settles, the author may have these commits squashed into
the proposal's commit.

The author keeps a provisional plan and working notes outside the
repository; they are private and never committed. A committed document
never cites them, by path or as "the plan's item 5": name the work by
what it is and anchor it where a reader can look, in a principle of the
vision note, an issue or a committed proposal. Evidence a committed
document relies on is public too.

## Before calling engine behavior a defect

A run's log shows what the engine did, not why. Before calling a
refusal, a retry or a degraded phase a defect, read the code path end to
end and the proposal under `docs/changes/` that its comments cite by
requirement or decision number (such as R11 and PD10 of commit series
integrity). Say what the design intends first, and only then whether the
run departed from it. Do not propose an issue or a fix from log lines and
a few search hits.

## Writing conventions

Reader-facing text (docs, comments, commit messages) is English and reads
as human-typed: avoid characters people rarely type by hand, such as em
dashes, the middle dot and the ellipsis character. Skill text under
`skill/` is different: it is a prompt, its exact bytes are the product, and
`npm run verify` compares them byte for byte. Do not reformat it for style.
The role prompt fragments under `roles/fragments/` are prompts in the same
sense: their bytes are what every worker in a role that names them
receives, and a change to one changes those roles' prompts and hashes.
Do not reformat them for style either.

Markdown documents (proposals, reports) put each paragraph and each list
item on one line, as the vision note does; do not hard-wrap them. An
older document, this file among them, is converted only when it is
rewritten anyway. Commit message bodies still wrap at 72 columns.

Comments that say what code does are welcome; keep them true.

## Commits

Conventional commits, in English: `<type>(<scope>): <subject>` with an
imperative subject under 72 characters, and a body that explains the why
for anything non-trivial. Types are `feat`, `fix`, `perf`, `refactor`,
`docs`, `test`, `chore` and `ci`. The scope is optional.

No attribution footers: no "Generated with Claude Code", no
`Co-Authored-By`. This overrides any tool default.

Branches: `<type>/<topic>` in kebab-case. Name the branch before the
first push: renaming a pull request's head branch on GitHub closes the
pull request, and it cannot be reopened onto the new name.

## Pull requests and merging

A pull request description has three sections, written for an engineer
who does not know this repository. **Motivation** says why the change
was needed: a short introduction of deep-review, the problem, and links
to the proposal and issues. **Modifications** is one compact bulleted
list of the notable changes, not of the commits; a breaking change comes
first in bold, and deprecations are always stated, as "none" when there
are none. **Result** says what a user experiences, in concrete words: a
fix says what no longer happens, and a feature shows how to use it with
real output checked against the code. Test counts and CI status are not
results. Define the repository's terms in plain words, and explain or
drop requirement IDs. Each paragraph and list item is one line. A Mermaid
diagram is welcome where it clarifies a flow; render it and look at it
before posting. Leave out what a reader of the pull request cannot see:
local paths, private plans and notes, machine details.

`main` must keep the commit hashes that proposals cite in their
Verification sections, and the only merge GitHub offers here, rebase and
merge, rewrites every hash. A pull request whose branch sits on `main` is
merged instead by fast-forwarding `main` to the exact head CI tested:
check `git merge-base --is-ancestor origin/main <head>`, then
`git push origin <head>:refs/heads/main`, and GitHub marks the pull
request merged. Ask the author before pushing to `main`.
