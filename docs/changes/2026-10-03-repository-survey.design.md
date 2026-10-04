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
review whose surveyor failed twice, or a fix run whose flags settle
every kind; and blocked, for a fix run whose surveyor failed twice with
a kind left unsettled or returned a check whose tool this machine lacks.
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
- **A read-only Codex worker on Windows can look a tool up.** Probed on
  2026-10-03 with codex-cli 0.157.1 through `codex exec` with the
  adapter's settings for a read-only worker (`sandbox_mode="read-only"`,
  `windows.sandbox="unelevated"`, the isolation settings, the adapter's
  `Path` without the WindowsApps directories), in the click clone. Asked
  for a lookup and a `--version` of eleven tools, the worker found
  `git`, `node`, `npm`, `uv` and `dotnet` with their paths and
  versions, and reported `python`, `ruff`, `mypy`, `pnpm`, `make` and
  `cargo` as not found, which is what the machine holds. Issue #10's
  refusals are of processes started by a process the worker started, and
  a lookup is one process from the worker's shell. Two things the probe
  showed beside the answer: the worker's shell is PowerShell while a
  check runs under `cmd.exe`, and on this machine the shell's error
  text came back in a legacy code page, unreadable but still plainly a
  failure. The elevated sandbox was not probed; the adapter does not
  default to it.
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
  `cmd.exe /d /s /c`, as `run.ts` starts it), which is not always the
  shell the worker's own commands run in, so a lookup is to be made as
  that shell would resolve the name (`where.exe` on Windows) and judged
  by whether it succeeded, not by the wording of an error;
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

The surveyor's own prompt gets only the scope block's opening, the
header and the table of changed files (`surveyScopeBlock`): no rules
section, which does not exist yet, and no patch, which it does not
read and which would cost up to 256 KiB on every launch and retry.
Every later worker's block is that opening, the convention sources and
the patch.

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
  offered, or a path repeats; a user-level path names an offered file
  only when it is absolute, compared with every link followed, so a
  relative one names none rather than whatever it would resolve to from
  the directory the engine runs in;
- `userRules` does not cover the offered files once each, or disagrees
  with `conventions` on whether one is applied, or an applied one has no
  `grounds`; under `ignore` and `apply` no file is offered, so any
  `user` entry is refused;
- `checks` is present in a read-only run, absent in a fix run, misses an
  unsettled kind, or names a settled one;
- a check has a command and no source or no basis, a source whose path
  is not a regular file in the worktree, no command and no reason, a
  `missingTool` without a command, or the basis `hint` with a command
  the engine gave no hint for that kind;
- a command is empty, holds a NUL character, which no shell runs, or
  spans more than one line: `cmd.exe /d /s /c` runs only the first line
  and `sh` judges only the last, so one line's exit code would decide
  the check. The reason tells the retry to join the commands with `&&`.

Every path is refused in these terms too when it holds a NUL or the
file system cannot resolve it (denied, too long, a loop of links): the
path came from the model, so it costs the attempt, never the run. A
path into the git directory is refused as holding git's own data, not
a file of the repository.

The quote is not matched against the file. It is evidence for a reader,
and a paraphrase is not a reason to pay for the survey twice.

### Ledger events and fold (R6, R12)

- `survey.recorded@1`: the worker id and the answer as checked, with
  paths normalized to repository-relative forward slashes.
- `survey.failed@1`: the degradation of a read-only review, or a fix
  run going on without its survey on flags that settle every kind (R9),
  with the reason, as `angle.failed` is for a finder.
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
- a fix run whose surveyor failed twice with no worker lost among the
  failures, and whose invocation's flags already settle all four kinds,
  goes on at once: the engine records `survey.failed@1`, plans the
  checks from the flags alone and goes on without convention sources,
  since a block would only ask for the flags it was given;
- any other fix run blocks with `worker-failed`. Its action gains a
  clause for this phase: run again, or settle every kind with `--check`
  and `--no-check`. On re-entry, if flags settle all four kinds, the
  engine records `survey.failed@1`, plans the checks from the flags
  alone and goes on without convention sources; otherwise the surveyor
  gets its fresh attempts. When an earlier attempt answered and blocked on a
  missing tool, that answer stays the run's survey: the flags plan the
  checks over it, no `survey.failed@1` is recorded, and its convention
  sources govern the review, as the action says.

### Using the survey (R7)

- `scopeBlock` takes the recorded sources. The section becomes
  "Convention sources", one line per source with its level, what it
  governs and what it applies to, or a sentence that the survey found
  none, or that the survey failed. The block is still rendered once per
  run, after the survey phase.
- `conventionFiles` and `ancestorDirectories` leave `conventions.ts`.
  What stays there is the list of user-level paths and the function
  that says which exist.
- A run configured before the survey existed recorded no source. When
  one resumes, its later workers' scope block lists the files the engine
  that configured it listed, found as it found them: the user-level
  ones that exist, then `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`
  in the root and every ancestor directory of a changed path, under the
  old heading and in the old words, since its pinned role prompts expect
  them (`presurveyRulesFiles` in `controller.ts`, with its own
  `ancestorDirectories`).
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

- Whether a convention source outside the repository that the
  repository links to (click's guide points at palletsprojects.com) is
  ever listed. The design says no, since a worker has no network; the
  surveyor's note may name it. On the gate the Claude surveyor did
  exactly that for click's two palletsprojects.com pages.
- The strong tier for the surveyor, until the gate's numbers are in.
  Settled on 2026-10-04 (Verification): the strong tier stays.

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
  such section and no patch; the fixer task still carries the planned
  checks.
- R9: two failed attempts in a read-only run degrade, `CONVENTIONS` is
  in `anglesNotRun`, the run reaches a report; in a fix run they block
  with the action; a re-entry with all four kinds flagged goes on, and
  one with three launches the surveyor. A first invocation with all four
  flagged goes on with no block, unless a worker was lost.
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

## Amendment after the first gate runs

Added 2026-10-04. The first runs of the R14 gate (Verification) are the
evidence. On click #3818 the Claude surveyor answered as the design
intends, and the Codex surveyor (gpt-6-astra, medium effort) failed two
of its judgments, both on facts its own shell sees badly.

- **It applied the reviewer's home rules on invented grounds.** It ran
  `git config user.email; git log -8 --format=%ae` as one command. A
  worker runs isolated from the reviewer's git configuration, so the
  first printed nothing, and the first line of output was the first
  commit's author, `kevin@deldycke.com`, a click maintainer, which the
  surveyor took for the configured email. Both home rules files were
  listed as convention sources of a repository the reviewer does not
  own, the failure R3 exists to prevent.
- **It reported tools missing that its commands provide.** Each of its
  commands ran its tool through `uv run --group <group>`, which installs
  `tox` and `pre-commit` into the project's environment, and it looked
  up `tox` and `pre-commit` on `PATH`. The survey blocked with
  `check-unavailable` on three kinds that would have run.

**TD14: The engine gives the surveyor the reviewer's authorship as
counts.** The fragment named commits by the person `git config
user.email` names as grounds, which asks the surveyor for a fact it
cannot see. The engine reads `user.email` with the operator's own git
configuration and counts how many of the last 200 commits on HEAD were
authored with it or with an address the repository's `.mailmap` gives
as the reviewer's: `git check-mailmap` turns the configured address into
the one the mailmap gives, and the log compares each commit's author as
the mailmap gives it (`%aE`), so a reviewer who commits under two
addresses the repository declares as one person is counted under both.
When `git check-mailmap` fails or prints no address, the configured
address is compared as it is. The task states the counts, or that no
email is configured for the repository, and the fragment tells the
surveyor not to look the identity up and never to take a commit's
author for it. It reads them only for a task that states them, one
that offers a user-level file, so a survey under `ignore` or `apply`,
or on a machine with no such file, runs none of these git commands.
The address itself never reaches a prompt. Matching on `user.name` as
well was rejected: names collide, and that is the misattribution the
counts exist to prevent. Passing the address was rejected for that reason;
telling the surveyor to run `git config` on its own was rejected
because its environment does not hold the answer; raising the
surveyor's effort was rejected as the fix, since the fact was missing,
not the reasoning. Whether the counts are grounds stays the
surveyor's judgment (PD7).

**TD15: A tool run through what provides it needs only that to
resolve.** The task and the fragment now say to look up what a command
starts, and that `uv run --group dev tox` needs `uv` and `npx eslint`
in a project that depends on eslint needs `npx`. The engine still parses
no command line (TD4).

The Claude runs on click and eslint ran on the prompts before this
amendment; the Codex click run is run again on it from a fresh clone.

## Verification

Run on the author's Windows 11 machine on 2026-10-04, Node 26.10.0 and
git 2.55, over the five commits that build the element after the
proposal (`fd82a45`), from `8505906` to `194e870`. `npm run check` and
`npm run verify` passed before each commit, `npm run check` ending at
1352 tests, 1334 passing and 18 skipped, the platform-bound cases the
suite already skipped on this machine. Continuous integration on the
three platforms has not run yet for these commits; it runs when the
pull request opens, and its result is recorded here then. The gate of
R14 ran by hand on 2026-10-04 and is recorded below, after the commits;
its first runs led to the amendment above and to three more commits,
`790e088`, `903e825` and `7b92da7`, each with `npm run check` and
`npm run verify` passing before it, the last ending at 1355 tests,
1337 passing and 18 skipped.

The commits, in order, and what each carries:

- `8505906` the survey itself: the vocabulary of version 3, the events
  `survey.recorded@1`, `survey.failed@1`, `checks.planned@2` and
  `review.configured@3`, version 3 of the six kinds that carry a phase,
  their reducers and the fixture `schema-1-06`; the phase, the
  surveyor's task, output schema and structural check; the planning of
  the checks, the `check-unavailable` block and the failure rule; the
  hints, the user-level setting and the scope block's convention
  sources; the surveyor's five new fragments and its policy entry; the
  whole-run tests.
- `54dee68` the report's Conventions section, the Source column of
  Checks, the operator's drop of a check the project defines, and the
  third report snapshot.
- `4a115c1` the rewording of `angles-conventions.md`, `rubrics.md`,
  `phase3-sweep.md` and `fixer-apply.md` (R13), alone.
- `7129742` the skill texts, rebuilt into `dist/`.
- `194e870` the README.
- `790e088` the amendment after the first gate runs: the reviewer's
  authorship as counts in the surveyor's task (TD14), and the lookup of
  what a command starts (TD15), with their fragments.
- `903e825` the Codex fast tier on gpt-6.1-sol, which the catalog of
  codex-cli 0.160.0 lists first, in place of gpt-5.6-terra.
- `7b92da7` the report's reason for checks phases that ran nothing
  when no kind has a command, which the no-`uv` gate run showed.

The review of the pull request led to further commits after `7b92da7`,
among them the refusals and the surveyor's scope block described above.
The code they change is covered by unit tests added with it; the gate
of R14 has not run again on them.

The roles' hashes. `8505906` adds the surveyor, 5 fragments and 6908
bytes, `d497c899f721d30d975dc5a7b8764a8a562d3535927ba694733b166c0b34a643`,
and changes no other role. `4a115c1` changes the roles that read the
reworded fragments; every other role keeps its hash from `fd82a45`.

| Role | Fragments | Bytes at `fd82a45` | SHA-256 at `fd82a45` | Bytes at `4a115c1` | SHA-256 at `4a115c1` |
|---|---|---|---|---|---|
| triage | 10 | 24202 | `704cb575c920c7ec2b63beda108c3b2b25a0e5d8e9163e4fa06d2195cfc3e44f` | 24295 | `bd64b0938d8a815170ae6ed958adc117e6a8a939632eeed95d078739a6e43226` |
| finder-SCAN | 6 | 12512 | `b76d436076eef7f7eaf1a73883de94fa3d598246d1217cba21e474fa1825f14f` | 12523 | `dce993eb4b8e5cbbce774631b6b4bd9d9e42bc91491b3191e1ebe3988d5067e3` |
| finder-CONVENTIONS | 4 | 3579 | `25eebcce7c5ef0cfa706d478024fa2fc90253bd65ec45b2fc1b17b2db8537f84` | 3661 | `2061a87bcd7c36899aab65f9296e3112ec0b33cdf6ebb062b4ea6016c8983be4` |
| deduplication, verifier | 6 | 15658 | `0891f73b3af710f5ccfd850e76ae204543b75f40d47917b73a74e4147511a974` | 15669 | `87e880d8d6575ce2ea0457036929734cfba7ae70004d953c1546f38d51a71007` |
| sweep | 10 | 22711 | `7292146ec20360f7dd22fa2ae69169ada0686d7a913e9082423680160f6aae4a` | 22790 | `41dccd93a2a923f5f032b9df7038e16b353e10ceca42fbb8492d18765b93e3ca` |
| merge-rank | 6 | 13322 | `8504ff3d42b09c40914b084f61fe74f0a4dcc4f4cfeef0aa24b5ba4d4fadedba` | 13333 | `6ee7b948126544455f4529d8d968b61f26bf65a075f9f6f119d546e0eaf90bd7` |
| test-assessment | 6 | 28760 | `a57fc5ca3d6f7387a34964f735f8a9ee5192281c0e75d44bb6052d9ce154102f` | 28771 | `55ed861886a0d7fa2d33a07469adec7c343f0039e87ee9c5ce311528bffb5bf4` |
| fixer, answer | 7 | 13102 | `0d3cb33423bd8473b5123f3891b68e1a4fb7dcfa5be51d9777ac664a16f8b9f5` | 13500 | `54215ee16f9123adcca0a8c102326f56c70336fc313c14c81387f68acabce0b3` |
| documentation | 7 | 13102 | `949f9efead6f4b7d7f8e5d55c3be0edc904640624adc7ebfdc2a8ca51b054c06` | 13500 | `8bb25be37d774e001119edb0955b73369f2f18ce66131d9fae31f47cf80b0f0a` |

The `rolesDigest` a run pins changes with each, so no run configured
before `8505906` resumes under this engine, as Risks & Migration says.

What the implementation decided where the design left room, or departed
from its text, each recorded here rather than silently:

- **`report.written` gets a version 3 too.** The design named the five
  kinds that carry a phase, but the report's statistics carry one per
  row, and the survey's row needs the wider phase list, so six kinds
  carry version 3.
- **The survey's events record the policy's part.** `survey.recorded`
  holds the convention sources with the user-level files the pinned
  policy applies already joined, and `userRules` holds a decision on
  every user-level file that existed, the policy's or the surveyor's;
  `survey.failed` holds the policy's part alone. The design joined them
  when the scope block is rendered; recording them means a later
  invocation reads the sources the survey's own invocation saw, whatever
  the home directory holds by then.
- **The fold keeps every answer.** The run's survey is the last one, but
  an earlier answer is kept, so the report can name what the project
  defines for a kind the operator dropped after a survey run again.
- **Any re-entered survey opens its unit again**, not only one blocked
  on `check-unavailable`: an answer stands for an attempt, and an
  invocation whose flags leave a kind the earlier answer did not cover
  (it was settled by a flag then) surveys again instead of planning
  from an answer that never chose it. A survey left running by a
  stopped engine keeps its lost attempt.
- **A fix run that goes on without its survey records the failure and
  the plan in one append**, as one planner step, so no run is left
  without a survey and without checks for an invocation with other
  flags to stumble on.
- **The flags' promise outlives what blocks after it.** The fold keeps
  the survey's own last blocker, `worker-failed` or `check-unavailable`,
  and a drift or budget block of the phase leaves it, since neither
  says anything of the survey. A survey that blocked on its failures
  and never answered goes on without it once an invocation's flags
  settle every kind, whatever blocked since and whatever failed in the
  attempt a stopped engine left running, because that is what the
  block's action told the operator.
- **A hinted command is the hint's exact command.** An answer whose
  basis is `hint` and whose command differs from the hint is refused;
  a command the surveyor adapted is its own, with the basis `stated`
  and its source.
- **Under `apply` and `ignore` the task says the policy settles the
  user-level files**, without naming them, so a surveyor does not list
  one it was never offered.
- **A planned check of version 2 carries the basis in its source**, so
  the report reads where a command came from and what it stood on from
  the plan alone.
- **A surveyed run's report differs; an older run's does not.** The
  Conventions section and the Checks table's Source column appear for a
  run configured with the survey, and a run configured before it
  renders as it did, so the two committed snapshots are unchanged and a
  third covers the survey.

**R14 passed on 2026-10-04, after one amendment: every run reached a
report with no hand on it, and on the amended engine the Codex surveyor
met each criterion it failed before.**

Every run used the shipped bundle of this worktree's `dist/`, on the
author's Windows 11 machine with Node 26.10.0, from a fresh clone under
`C:\Users\josep\projects\gate\survey-2026-10-04`, with no `--check`
flag and a `PATH` that holds `uv` and no `python`, `tox`, `pre-commit`,
`mypy`, `pyright` or `ruff`. click #3818 was reviewed as its one commit,
`fc518e4`, with `--last-commit`; eslint #21247 as the range from its
merge base `c6cc6c592` to its head `48a3ad4d9`. click got no setup,
since its guide names none and `uv run` builds its own environment;
eslint got `npm install`. The first three runs ran at once, and so did
the last two, so their wall seconds are not a clean measure of one run.
The first three ran on engine `0.0.0+98f84e1016d9` (`22a8415`), the
last two on `0.0.0+635fefcbf69d` (`903e825`), after the amendment and
the Codex fast tier's change. codex-cli was updated from 0.157.1 to
0.160.0 between the two; each run's workers recorded one version.

| | click, Claude | eslint, Claude | click, Codex | click, Codex, amended | click, Codex, no `uv` |
|---|---|---|---|---|---|
| Run | `e0a1f834` | `40971dc2` | `58925e84` | `e9755671` | `fac9ba18` |
| Runtime | claude 2.1.288 | claude 2.1.288 | codex-cli 0.157.1 | codex-cli 0.160.0 | codex-cli 0.160.0 |
| Models | `claude-opus-5-5`, `claude-sonnet-5-5` | the same | gpt-6-astra, gpt-5.6-terra | gpt-6-astra, gpt-6.1-sol | gpt-6-astra, gpt-6.1-sol |
| Workers | 31 | 23 | 27 | 29 | 25 |
| Wall seconds | 1318 | 879 | 2477 | 3540 | 2638 |
| Cost | 10.15 USD of 60 | 7.63 USD of 60 | not reported | not reported | not reported |
| Input tokens (cached) | 6201501 (5417160) | 5456266 (4791307) | 8079429 (6895744) | 10390422 (9049344) | 7664900 (6563584) |
| Output tokens | 167737 | 104239 | 90688 | 106124 | 84096 |
| Surveyor | 33.9 s, 0.28 USD | 32.8 s, 0.37 USD | 89.4 s | 68.3 s | 78.6 s |
| Triage | 126.6 s, 0.59 USD | 147.4 s, 0.71 USD | 139.9 s | 161.8 s | 136.7 s |
| Survey | completed | completed | blocked, then flags | completed | blocked, then flags |
| Baseline | build, lint, test passed; typecheck failed | typecheck, lint, test passed | build, test passed; typecheck failed; lint dropped | build, lint, test passed; typecheck failed | no check |
| Findings | 20: 5 CONFIRMED, 15 PLAUSIBLE | 10: 4, 6 | 15: 13, 2 | 22: 21, 1 | 18: 10, 8 |
| Refuted | 10 | 4 | 3 | 0 | 0 |
| Patches | 13 | 5 | 14 | 21 | 12 |

The criteria, run by run:

- **`docs/contributing.md` listed:** in all four click runs, each with
  `.github/pull_request_template.md`; the first Codex run also listed
  `docs/contrib.md`.
- **The reviewer's home rules not applied under `judge`:** declined by
  both Claude surveyors, which saw `user.email` unset in their shells,
  and by the amended and the no-`uv` Codex surveyors, which cited the
  task's statement that no email is configured. The first Codex
  surveyor applied both on a commit author it read as the configured
  email: the evidence of the amendment (TD14). Even there, every
  `CONVENTIONS` finding quoted `docs/contributing.md` and none the home
  rules.
- **A `test` command that passes at baseline:** tox's `py3.13` on
  Claude, 6.9 s, and `py3.14` on the amended Codex, 6.8 s, both through
  `uv run --locked --no-default-groups --group dev` from
  `.github/workflows/tests.yaml`. The first Codex run passed `py3.14`
  too, but through `--check` after its false block.
- **At least one of `lint` and `typecheck` from the project's own
  configuration:** `lint` passed at baseline on Claude (`ruff check
  --no-fix` and `ruff format --check`, from `.pre-commit-config.yaml`)
  and on the amended Codex (`pre-commit run --all-files` through its
  dependency group, from `.github/workflows/pre-commit.yaml`).
  `typecheck`, tox's `typing` environment, failed at baseline in every
  click run on the seven mypy errors in `_termui_impl.py` and
  `testing.py` that the previous click gate measured by hand; each
  repair worker read both outputs, found no new failure and deferred
  the kind, as fix pass R24 intends.
- **A check whose tool is missing blocks with R15's action and goes on
  after `--no-check`:** the first Codex run blocked falsely, on `tox`
  and `pre-commit` its commands provide (TD15), and went on after
  `--no-check lint` and `--check` for the other two. The no-`uv` run
  is the design's run on a shell without a chosen tool: its survey
  blocked before the triage on all four kinds, `uv not found`, and went
  on after `--no-check` for each. Both re-entered the survey and
  planned with no second surveyor, and the no-`uv` report says of each
  kind that the operator dropped it and what the project defines.
- **eslint: `lint` and `test` commands that pass at baseline:** `node
  Makefile lint`, 17.7 s, and `node Makefile mocha`, 55.3 s, from
  `.github/workflows/ci.yml`, with `typecheck` `npx tsc -p
  tests/lib/types/tsconfig.json` passing and `build` not available,
  with the reason. The requirements call eslint at this commit a
  repository with no rules file; that holds for `AGENTS.md` and
  `CLAUDE.md` only. `.github/copilot-instructions.md` is there, and the
  survey listed it with four contributor documents.

What else the gate showed:

- `CONVENTIONS` on click held the change to `docs/contributing.md`: the
  80-column rule for Markdown that the previous click gate's fixer
  broke is what the fixers of the Claude and the amended Codex runs
  enforced, measuring the lines they rewrapped.
- The no-`uv` report said the checks after the fixes did not run since
  no fix changed a file, beside twelve patches; `7b92da7` fixes it.
- The survey costs less than the triage everywhere: on Claude 33 s and
  0.28 or 0.37 USD against 127 or 147 s and 0.59 or 0.71 USD, on Codex
  68 to 89 s against 137 to 162 s. The Open Question on the surveyor's
  tier is settled as the strong tier: the Codex surveyor's two failures
  were facts it could not see, which TD14 and TD15 supply, and the same
  model at the same effort answered rightly once they did.
- The two Claude runs ran on the surveyor's prompt before `790e088`;
  the author chose not to run them again. The amendment changes only
  the surveyor's task and two of its fragments, and both Claude
  surveyors already gave the answers it asks for.

**Continuous integration, 2026-10-04, on PR #13.** The first run, at
`f806970`, passed on all three systems: 1355 tests, with 1344 passing
and 11 skipped on windows-latest, 1348 and 7 on macos-latest, 1349 and
6 on ubuntu-latest.

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
