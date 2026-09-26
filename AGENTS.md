# Working in this repository

Guidance for every agent, Claude Code and Codex alike, working here. It
lives in one file so the two runtimes cannot drift; `CLAUDE.md` imports it.
Read `README.md` first for the layout and the reasoning behind it.

## Environment

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for mise
and asdf. There is no PowerShell and no shell script anywhere in the
toolchain; every build, check and gate is a Node script, so what runs on
Windows is what runs on macOS and Linux.

```sh
npm ci            # locked development dependencies
npm run check     # lint, typecheck, test; what CI runs
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ is what skill/ produces, byte for byte
```

## Never edit dist/

`dist/` is build output: `dist/claude` is the Claude Code plugin and
`dist/codex` is the Codex skill, each produced only by `npm run build` from
the sources under `skill/`. Edit the sources, run the build, and commit the
result in the same change. An edit made directly in `dist/`, or in an
installed copy, is invisible to the build and fails `npm run verify` on
the next run.

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

`npm run check` and `npm run verify` must both pass. A commit that changes
built output includes the updated `dist/` and says in its message what
changed and why.

A commit that changes what a skill *says* and a commit that changes where
that text *lives* are different commits.

## Change proposals

A change that alters observable behavior carries a change proposal under
`docs/changes/`, written before the work and committed with it, following
the practice at <https://github.com/josephjang/change-proposal>. The
proposal holds the judgment the code cannot: why, what was left out, what
was rejected, what was knowingly accepted. A change with no behavior change
says so in its commit message instead.

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

`provisional-plan.md` at the repository root is a working note and is never
committed. It is excluded through `.git/info/exclude`, which is local; set
that up again on a fresh clone.

## Writing conventions

Reader-facing text (docs, comments, commit messages) is English and reads
as human-typed: avoid characters people rarely type by hand, such as em
dashes, the middle dot and the ellipsis character. Skill text under
`skill/` is different: it is a prompt, its exact bytes are the product, and
`npm run verify` compares them byte for byte. Do not reformat it for style.

Comments that say what code does are welcome; keep them true.

## Commits

Conventional commits, in English: `<type>(<scope>): <subject>` with an
imperative subject under 72 characters, and a body that explains the why
for anything non-trivial. Types are `feat`, `fix`, `refactor`, `docs`,
`test`, `chore` and `ci`. The scope is optional.

No attribution footers: no "Generated with Claude Code", no
`Co-Authored-By`. This overrides any tool default.

Branches: `<type>/<topic>` in kebab-case.
