# Technical Design: Repository survey

Product part: [2026-10-03-repository-survey.requirements.md](2026-10-03-repository-survey.requirements.md).

## Summary

A new first phase, `survey`, launches one read-only worker of a new role,
`surveyor`. Its answer, checked for structure, is one new event,
`survey.recorded`. When the phase completes the engine combines the
answer with the `--check` and `--no-check` flags into `checks.planned`
version 2, whose origins are `flag`, `survey` and `none`, and from then
on the run reads its checks and its convention sources from the ledger.
The scope block's rules section is rendered from the recorded sources
instead of from `conventionFiles`. `src/review/checks/discover.ts` keeps
its manifest rules but its result becomes a hint in the surveyor's task,
no longer the plan; `src/review/conventions.ts` loses its file-name
list and keeps the user-level two, which a new policy setting decides
the use of.

The phase can end three ways: completed; degraded, for a read-only
review whose surveyor failed twice; and blocked, for a fix run whose
surveyor failed twice or returned a check whose tool this machine lacks.
A blocked survey is the one place a run asks the operator something,
through the blocker's action and the flags of the next invocation.

## Non-Goals

- **No interactive question.** The operator's confirmation of R15 is a
  blocker and a flag. A channel for questions belongs to steering.
- **No engine-side test of a command.** The engine does not parse a
  command line to see whether its tool exists (PD12). It reads the
  surveyor's word, and the baseline run is the measurement.
- **No change to the check runner.** `src/review/checks/run.ts`, the
  order of kinds, the skip after a failed `build`, the pins and the
  timeout stay as they are.
- **No per-tool outcome within a kind.** One command per kind (PD8); a
  kind's two tools joined with `&&` report one exit code.
- **No rewrite of the `CONVENTIONS` finder's rule.** Its precision-first
  contract (quote the rule, quote the line) is kept; only the files it
  is pointed at change.

## Context

Verified at `3029053` (main).

- **Checks are planned at configuration.** `openRun` in
  `src/review/controller.ts` calls
  `discoverChecks(readRootManifests(worktree), fix)` before a run exists,
  and the run's first append records `review.configured@2` with
  `checks.planned@1` (`controller.ts`, the `configure` block). The fold
  (`src/checkpoint/fix-fold.ts`, `checksPlanned`) refuses a second plan,
  and `check.ran` is refused for a kind before its plan.
- **Discovery is a pure precedence over root manifests**
  (`src/review/checks/discover.ts`): flag, Taskfile, Makefile, justfile,
  `package.json` script through the manager the lock file names, then a
  language default for `go.mod`, `Cargo.toml`, `pyproject.toml` or
  `pytest.ini`, and a root `.sln` or `.csproj`. `checkOrigins` in
  `src/review/vocabulary.ts` has one word per source.
- **Convention files are listed by name**
  (`src/review/conventions.ts`): `~/.claude/CLAUDE.md` and
  `~/.codex/AGENTS.md`, then `CLAUDE.md`, `CLAUDE.local.md` and
  `AGENTS.md` at the root and in each ancestor directory of a changed
  file. `scopeBlock` in `src/review/prompts.ts` renders the list under
  "Rules files that govern the change", and the block is rendered once
  per run and shared by every worker.
- **The fragments name the three files.**
  `roles/fragments/angles-conventions.md` and `conventions-brief.md`
  tell the finder to find `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`
  and to verify the engine's list itself; the rubric and the sweep
  mention the same names (read-only review R12).
- **The phase list is frozen per event version.**
  `reviewVocabularyV2` in `src/checkpoint/events.ts` holds the phases,
  the recorded blocker codes and the check origins, and a test holds it
  equal to today's vocabulary, so a new phase, code or origin needs new
  versions of the events that carry them. The fix pass did this for
  `phase.started`, `phase.finished`, `worktree.checked`,
  `attempt.failed` and `worker.lost`.
- **A unit out of attempts degrades or blocks by its role**
  (`src/review/steps.ts`): a finder records `angle.failed`, a verifier
  group `group.unverified`, every other role blocks its phase with
  `worker-failed`. A re-entered phase gives its units fresh attempts.
- **A configured run ignores check flags** (`resumePinned` in
  `controller.ts`), because its checks are already pinned.
- **Evidence from the click gate**, run `92fbe0f2`: the facts under
  Problem in the requirements. Confirmed by reading the repository at
  `fc518e41`: `[tool.tox]` in `pyproject.toml`,
  `.github/workflows/tests.yaml`, `docs/contributing.md`, and no
  `AGENTS.md` or `CLAUDE.md`.

## Design

### The phase (R1)

`survey` is the first entry of `phases`. It has one unit, key `survey`,
role `surveyor`, read-only access with a shell, as every non-editing
unit has. The worktree check that opens every phase opens this one. The
planner treats it as any worker phase: launch, record the contribution
or the failed attempt, retry once, finish.

The triage waits for it, since the triage's prompt carries the scope
block and the block lists the convention sources.

### The surveyor's task (R2, R3, R4, R5)

The role prompt is new fragments (R13). The task the phase writes names
what the engine knows and the surveyor cannot see:

- the platform and the shell a check will run under (on Windows,
  `cmd.exe /d /s /c`, as `run.ts` starts it);
- whether the run fixes, and if so which kinds a flag settled, with the
  flag's command or its drop, so the surveyor leaves them alone;
- under the policy value `judge`, which user-level rules files exist,
  by absolute path, with the statement that they are the reviewer's own
  and govern only on the grounds R3 gives; under `ignore` and `apply`
  the task does not mention them, since the engine settles them;
- in a fix run, the hints (R11): for each unsettled kind, the command
  the manifest precedence gives and the manifest it read, or that it
  gives none, under a heading that calls them mechanical guesses to use
  only for a kind the repository states nothing about;
- the changed paths, which the scope block already lists, so "applies
  to" can be judged against them.

The surveyor's own prompt gets the scope block without the rules
section, which does not exist yet.

### Output schema and structural checks (R8)

```
conventions: [{ path, level: "repository" | "user", governs, appliesTo: [glob] | null, grounds: string | null }]
userRules:   [{ path, applied: boolean, reason }]          one per user-level file offered
checks:      [{ kind, command: string | null, basis: "stated" | "hint" | null,
                source: { path, quote } | null,
                missingTool: string | null, reason: string | null }] | null
note:        string
```

`checks` is null in a run without `--fix` and otherwise holds exactly
the kinds no flag settled, once each. The engine refuses the answer
whole (`StructuralCheckError`, so a failed attempt) when:

- a `conventions` path with level `repository` is not a regular file
  inside the worktree, or one with level `user` is not a file the task
  offered, or a path repeats;
- `userRules` does not cover the offered files once each, or disagrees
  with `conventions` on whether one is applied, or an applied one has no
  `grounds`; under `ignore` and `apply` no file is offered, so any
  `user` entry is refused;
- `checks` is present in a read-only run, absent in a fix run, misses an
  unsettled kind, or names a settled one;
- a check has a command and no source or no basis, a source whose path
  is not a regular file in the worktree, no command and no reason, a
  `missingTool` without a command, or the basis `hint` with a command
  the engine gave no hint for that kind.

The quote is not matched against the file. It is evidence for a reader,
and a paraphrase is not a reason to pay for the survey twice.

### Ledger events and fold (R6, R12)

- `survey.recorded@1`: the worker id and the answer as checked, with
  paths normalized to repository-relative forward slashes.
- `survey.failed@1`: the degradation of a read-only review (R9), with
  the reason, as `angle.failed` is for a finder.
- `checks.planned@2`: as version 1, with origins `flag`, `survey` and
  `none`, each check carrying its source (path and quote) when the
  origin is `survey`, and no `manager` field. Version 1 keeps its schema
  and its reducer, so an older ledger folds as before.
- A third vocabulary, `reviewVocabularyV3`: the phase `survey`, the
  recorded blocker code `check-unavailable`, and the check origins
  above. The five events that carry a phase get version 3 reading it.
- `review.configured@3`: version 2 with `survey: { userRules }`, the
  policy value the run pinned (R3). Versions 1 and 2 read as `apply`,
  which is what the engine did when they were recorded.
- The fold keeps the last `survey.recorded` of the run. It refuses one
  after `checks.planned`, and refuses `checks.planned@2` before a
  survey is recorded or failed, so a plan always stands on a survey or
  on its recorded absence.
- `checks.planned` moves from the run's first append to the end of the
  survey phase. `review.configured` no longer has a plan beside it.
- A new golden fixture, `schema-1-06`, holds a run with the new events.
  The five older fixtures stay and must still open and fold.

A run configured by an older engine cannot be resumed by this one for a
reason that predates this change: its roles digest differs, and
`resumePinned` refuses it with the abandon action. It still opens and
folds, which is what R12 promises.

### Planning the checks (R5, R6, R15)

When the unit is answered, a planner step combines flags and survey,
kind by kind:

| The kind | Planned as |
|---|---|
| has `--no-check` | no command, origin `flag`, reason "dropped by --no-check" |
| has `--check` | the flag's command, origin `flag` |
| survey gave a command, no missing tool | that command, origin `survey`, with its source |
| survey gave a command and a missing tool | not planned: the phase blocks (below) |
| survey gave no command | no command, origin `none`, the surveyor's reason |

If no kind is in the fourth row, the step appends `checks.planned@2` and
the phase finishes completed. A read-only review plans nothing, as
today.

The flags are read from the invocation that completes the survey phase,
not pinned at configuration, since the operator's answer to a block
arrives as flags on a later invocation. `resumePinned` ignores check
flags only once `checks.planned` is on the ledger.

### The block for a check that cannot run (R15, PD12)

With one or more kinds in the fourth row, the phase finishes blocked
with code `check-unavailable`. The detail lists each kind with its
command, its source and the missing tool. The action, held in
`blockerActions` so the enumeration test covers it:

> install the missing tool and run the command again, or run it again
> with `--no-check <kind>` to go without that check, or with
> `--check <kind>=<command>` to name one that runs

The exit code is 2, as for every blocker, and the skills already show a
blocker and its action verbatim.

On the next invocation the phase is re-entered, as a blocked phase is
today. The planner then looks at the last recorded survey against this
invocation's flags:

- every fourth-row kind is now settled by a flag: no worker is launched,
  the checks are planned from the recorded survey and the flags, and the
  phase completes;
- otherwise the surveyor is launched again with a fresh attempt, told
  which kinds are settled, and its new answer replaces the old one in
  the fold. A tool the operator installed is found, or the same block
  comes back.

A kind dropped this way is recorded as origin `flag`, reason "dropped by
--no-check", and the earlier `survey.recorded` event still holds the
command and the missing tool, so the report can say that the project
defines the check and the operator chose to go without it.

### Failure of the surveyor (R9, PD6)

The role's rule in `steps.ts` reads the run's mode:

- a read-only review degrades: `survey.failed@1`, the phase finishes
  degraded, the convention list is empty, and `CONVENTIONS` is recorded
  in `anglesNotRun` with the survey's failure as its reason, so the
  sweep is told to cover its territory as for any angle not run;
- a fix run blocks with `worker-failed`. Its action gains a clause for
  this phase: run again, or settle every kind with `--check` and
  `--no-check`. On re-entry, if flags settle all four kinds, the engine
  records `survey.failed@1`, plans the checks from the flags alone and
  goes on without convention sources; otherwise the surveyor gets its
  fresh attempts.

### Using the survey (R7)

- `scopeBlock` takes the recorded sources. The section becomes
  "Convention sources", one line per source with its level, what it
  governs and what it applies to, or a sentence that the survey found
  none, or that the survey failed. The block is still rendered once per
  run, after the survey phase.
- `conventionFiles` and `ancestorDirectories` are deleted. What stays in
  `conventions.ts` is the list of user-level paths and the function that
  says which exist.
- The sources a run uses are the survey's, joined with the user-level
  files by the pinned policy: under `apply` the engine adds each that
  exists, with the reason "applied by policy"; under `ignore` none, with
  "ignored by policy"; under `judge` what the surveyor listed. After a
  failed survey in a read-only run the list is the policy's part alone,
  so under `apply` `CONVENTIONS` still runs on the home rules.
- `checksBlock` in `tasks.ts` and the fixer and repair tasks read
  `checks.planned` through the fold as today; the version does not
  matter to them.

### The manifest rules as hints (R11)

`discover.ts` keeps its readers and its precedence, and changes what it
returns and who calls it:

- it is called when the survey unit's task is written, not at
  configuration, and only in a fix run;
- its result is a hint per unsettled kind (the command, the manifest
  and the rule that gave it, such as "package.json script `lint` through
  pnpm"), or no hint; it no longer applies the flags, which the planning
  step does;
- lock files of two package managers give a hint that says so and names
  both, where today the run is refused;
- nothing it returns is recorded as a check. The planning table has no
  row for a hint: a hinted command runs only when the surveyor returned
  it, with basis `hint`.

The hints are not an event of their own. They are in the surveyor's
prompt, which is frozen as evidence with every worker's exchange, and
the answer's `basis` says which commands came from one.

`checkOrigins` in `vocabulary.ts` becomes the three words; the old seven
live on in `reviewVocabularyV2` and as the rule names a hint carries.

### Policy

`roles/policy.json` gains `"survey": { "userRules": "judge" }`, with
`ignore` and `apply` the other values, read by `resolvePolicy` and
pinned on `review.configured@3`; a resumed run uses the pinned value,
as it does for every policy value. It also gains the role `surveyor`:
strong tier, medium effort, 8 USD, 600 s. The commands it picks run on the operator's machine and steer the
whole fix pass, which argues for the strong model; the task is reading,
which argues against high effort. The gate's survey cost and time decide
whether it stays.

### Report, status and log (R10)

- The log, when the phase completes: one line per convention source, one
  per user-level decision, and the `check <kind>:` lines the
  configuration prints today, each with its origin and source path.
- The report: a Conventions section after Angles (sources, what each
  governs, the user-level files with applied or not and the reason); the
  Checks table gains a Source column; a kind dropped by the operator
  after a `check-unavailable` block reads "dropped by the operator; the
  project defines `<command>` (`<source>`), `<tool>` not found"; the
  statistics gain the survey row; Limitations names a failed survey.
- `status` shows the phase and, when blocked, the blocker with its
  action, through the existing projection.

### Prompt fragments (R13)

New fragments for the surveyor: its brief, what counts as a convention
source, how to choose a check (CI and contributor documentation first,
the verifying form, one command per kind, the platform's shell, tools
looked up and not run), the user-level rule, and the output contract.
Reworded, in their own commit: `angles-conventions.md`,
`conventions-brief.md`, the rubric's and the sweep's mentions of the
three file names, and the fixer fragments, which gain the instruction to
keep their edits within the listed sources. The wording guard test is
updated with them. Every role whose fragments change gets a new hash,
and so does the roles digest.

### Build, skills and README (R10, R13)

The bundle and `dist/` are rebuilt. The skills' text changes only where
it describes `--check`: a flag now settles a kind the survey would
otherwise choose, and a `check-unavailable` block is answered with one.
The README's sections on checks and on `CONVENTIONS` are rewritten, and
it gains the warning of the requirements' first risk.

## Technical Decisions

- **TD1: The survey is a phase, not a step of configuration.**
  Configuration happens before a run exists so that a refusal creates
  nothing. A worker needs a run, a ledger to be launched on, and a
  retry rule, which are what a phase is. This also gives the later
  approval step a phase boundary to sit on.
- **TD2: One event for the answer, a second for the plan.** Putting the
  chosen commands straight into `checks.planned` was rejected: the plan
  is what the run executes, after flags, and R15 needs the survey's
  command for a kind the operator then dropped. Two events keep what the
  model said apart from what the engine decided.
- **TD3: `checks.planned` gets a version 2, not a wider version 1.**
  The origins are frozen in version 1's schema, and an event's payload
  shape is never edited (the ledger rule in `AGENTS.md`).
- **TD4: The missing tool is the surveyor's report, not the engine's
  probe.** PD12 gives the product reason. Technically, the engine would
  need the first word of each segment of a shell command line, across
  `&&`, environment prefixes, `uv run` and `npx`, which is a parser for
  two shells.
- **TD5: The block is a new blocker code, not `worker-failed`.** The
  operator's action differs, and the enumeration test holds each code to
  one action. It is recorded on `phase.finished`, so it joins the
  recorded codes.
- **TD6: Check flags stay live until the plan is recorded.** Pinning
  them at configuration, as today, would leave the operator no way to
  answer a block short of abandoning the run. After the plan they are
  ignored and named as ignored, as today.
- **TD7: A re-entered blocked survey launches a worker only when flags
  do not settle the block.** Launching always was rejected: an operator
  who answered with `--no-check` would pay for a survey whose answer the
  flag overrides.
- **TD8: The quote is not verified against its file.** A check that the
  quoted text occurs would fail honest answers on whitespace and line
  endings (the checkouts under test are CRLF), and a passing check would
  prove little about the command.
- **TD9: Paths are checked to exist, and nothing else about a source
  is.** This is the same light check the locations get: it catches an
  invented file, which is the failure worth a retry, and leaves
  judgment to the model the decision gave it to.
- **TD10: The scope block is rendered after the survey and still once.**
  Rendering it per worker was rejected: a shared block is what lets the
  runtimes cache the prompt prefix.
- **TD11: The hints are computed by today's code, frozen, and not
  extended.** PD5 gives the product reason. Rewriting the hint logic
  into something smaller was rejected: the precedence is tested and its
  known mistakes are documented, and a hint only has to be a reasonable
  first guess that the surveyor checks.
- **TD12: A hinted command is recorded with origin `survey` and basis
  `hint`, not a fourth origin.** The origin says who decided, and the
  surveyor did; the basis says what it stood on. A fourth origin would
  suggest a path to the checks that does not pass through the answer.
- **TD13: The user-level setting is in the policy file and pinned, not a
  flag.** PD7 gives the product reason. Pinning it puts it under the
  rule that a configured run reads its configuration and not the file,
  so an edit of the policy between a block and a resume does not change
  which rules a run in flight applies.

## Open Questions

- Whether the surveyor on Codex for Windows can look up a tool at all,
  given issue #10. A probe through the adapter before the gate settles
  it; if it cannot, the task tells it to leave `missingTool` empty there
  and the README says that R15 does not hold on that runtime.
- Whether a convention source outside the repository that the
  repository links to (click's guide points at palletsprojects.com) is
  ever listed. The design says no, since a worker has no network; the
  surveyor's note may name it.
- The strong tier for the surveyor, until the gate's numbers are in.

## Test Strategy

Unit and integration tests under `node:test`, with the fake runtime the
suite already scripts workers with, then the gate by hand.

- R1: a scripted run's log and fold show `survey` first, one unit, its
  worker read-only; a run without `--fix` has the phase too.
- R2, R8: the structural check accepts a valid answer and an empty
  convention list; refuses each malformed shape named under Output
  schema, one test per refusal, each asserting a failed attempt and a
  retry.
- R3: under `judge` the task names the user-level files that exist
  under a fake home and none when there are none, and an answer applying
  one without grounds is refused; under `ignore` the task names none and
  the sources hold none; under `apply` the sources hold each that
  exists whatever the surveyor returned, and after a failed survey too;
  the value is pinned on `review.configured@3` and a resume ignores an
  edited policy file; versions 1 and 2 fold as `apply`; the report shows
  each file applied or not with its reason.
- R4, R5: the task of a fix run names the settled kinds; of a read-only
  run asks for no checks; the planning table, one test per row, and
  flags over a survey's command for the same kind.
- R6: `checks.planned@2` is appended at the end of the phase and not at
  configuration; a resumed run after the plan launches no surveyor and
  logs ignored check flags; the fold refuses a survey after the plan and
  a plan before a survey.
- R7: the scope block of a triage worker lists the recorded sources, an
  empty list reads as none found, and the surveyor's own block has no
  such section; the fixer task still carries the planned checks.
- R9: two failed attempts in a read-only run degrade, `CONVENTIONS` is
  in `anglesNotRun`, the run reaches a report; in a fix run they block
  with the action; a re-entry with all four kinds flagged goes on, and
  one with three launches the surveyor.
- R10: report and log snapshots for a completed survey, an operator
  drop after a block, and a failed survey.
- R11: the surveyor's task in a fix run carries a hint per unsettled
  kind and none for a settled one, and no hints in a read-only run; a
  repository with a `package.json` whose surveyor returns no command for
  a hinted kind plans no check for it; an answer with basis `hint` for a
  kind that had no hint is refused; two package managers' lock files
  give an ambiguity hint and no refusal; the existing rule tests stay,
  retargeted from planned checks to hints.
- R12: the golden test over `schema-1-01` to `schema-1-06`; the
  vocabulary test holds `reviewVocabularyV3` equal to today's words and
  versions 1 and 2 unchanged.
- R13: the manifest test for the new role, the wording guard over the
  reworded fragments, the roles' hashes.
- R15: a survey naming a missing tool blocks with `check-unavailable`
  before the triage launches; the blocker enumeration test covers the
  new code; a re-entry with `--no-check` for the kind launches no worker
  and completes; with `--check` likewise; with no flag launches the
  surveyor again, and a second answer without the missing tool
  completes; a kind with no command at all does not block.
- R14: the gate by hand, recorded in Verification: click #3818 on both
  runtimes and eslint #21247 on Claude Code, each from a fresh clone
  with no `--check` flag and an unprepared `PATH`, and for R15 one click
  run started on a shell where a chosen tool is absent.
- `npm run check` and `npm run verify`.

## Verification

No checks have run yet.

## Risks & Migration

- **The exposure of an unapproved command** is the requirements' first
  risk. Technically nothing contains a check: it is a child of the
  engine with the operator's environment. A later approval step would
  sit between `survey.recorded` and `checks.planned`, which is why the
  two are separate events (TD2).
- **A blocked survey leaves a run active.** The operator who walks away
  has a run that `status` shows blocked, and a new `review` in that
  worktree resumes it. This is every blocker's behavior; `abandon`
  clears it.
- **Every role's prompt hash changes** with the reworded fragments, so
  no run started before this change resumes after it. The engine is
  unreleased (`0.0.0`), and the gate clones are disposable.
- **The golden fixture** `schema-1-06` is new; fixtures 01 to 05 are
  untouched and prove the older ledgers still fold.
- **Order of commits:** the vocabulary and events with their fold and
  fixture; the phase, the schema and the planning; the block and the
  failure rule; the scope block, the hints and the user-level setting;
  report, status and log; the new fragments; the reworded fragments,
  alone; the surveyor's role policy; skills and README; then the gate
  and Verification.
