# Product Requirements: Repository survey

Technical part: [2026-10-03-repository-survey.design.md](2026-10-03-repository-survey.design.md).

## Summary

Before the triage, one worker reads the repository the way a new
contributor would (its contributing guide, its CI workflows, its
manifests, its rules files) and answers two questions: which commands are
this repository's checks, and which files state the conventions its code
is held to. The engine records the answer once, on the ledger, and the
rest of the run uses it: the `CONVENTIONS` finder and the fixers read the
convention sources the survey named, and a fix run's baseline, checks and
repair run the commands it chose.

This replaces two fixed rules. The checks were found by a precedence of
manifest names (fix pass R8, PD6), and the conventions were three file
names at fixed places (read-only review R12, PD11). Both rules held on
the repository they were measured on and failed on the first repository
of another kind. The author decided on 2026-10-03 that both are the
model's work, that the choice is made early in the run and recorded, and
that no person approves it for now.

## Problem

The gate on pallets/click #3818 (run `92fbe0f2`, 2026-10-03, the first
gate on a repository that is not zod) reached a report with no hand on
the run, and showed what the fixed rules cost on a repository they were
not written for.

- **The checks the rule found were a fraction of the project's.** click
  states its checks in `[tool.tox]` of `pyproject.toml` and runs them in
  `.github/workflows/tests.yaml`: `pytest`, then `mypy` and `pyright` as
  `typing`, then `pre-commit` as `style`. The rule knows one thing about
  a `pyproject.toml`, the default `python -m pytest`, so a fix run
  measured the tests and nothing else. `lint` ran only because the
  operator passed `--check "lint=ruff check"` by hand.
- **The command the rule chose ran only because the operator prepared
  the shell.** `python -m pytest` resolved because `.venv\Scripts` had
  been put on `PATH` before the engine started. The repository holds a
  `uv.lock`, and its own CI runs everything through `uv run`; the rule
  reads neither.
- **The conventions the rule found were the wrong ones.** click has no
  `AGENTS.md` and no `CLAUDE.md`. Its rules are in `docs/contributing.md`:
  no ternary expressions, no unnecessary dependencies, Markdown wrapped
  at 80 characters. The rule looks for three file names, found none in
  the repository, and listed the reviewer's own `~/.codex/AGENTS.md`.
  `CONVENTIONS` then cited the reviewer's rule about comments against
  click's code, the finding was confirmed, and a fixer edited click's
  comment for it. The same fixer wrote a line of about 84 characters
  into `docs/exceptions.md`, against the rule the engine never read.
- **Every other repository examined fails the rule in its own way.**
  eslint's type check is the script `test:types`, a name outside the
  rule's list, so the kind reads as not available. urfave/cli has a
  `Makefile`, so the rule picks `make test`, and this machine has no
  `make`. zod's `lint` script rewrites files, which the rule answered
  with a special case (`<name>:check` outranks `<name>`, fix pass TD5)
  that is one repository's fix written as a rule.

The fix pass rejected a discovery worker "for now", because it would put
a model's reading in the control flow before the first measurement of
the mechanical rule (fix pass PD6). The measurement is in. Each new
repository would add a rule, and the rules would still not read a
contributing guide.

## Goals

- A repository whose checks are stated anywhere a contributor would look
  gets them run, with no flag and no prepared shell.
- A check the project defines is never dropped in silence. When this
  machine cannot run it, the run stops and the operator decides.
- A repository's own conventions are what `CONVENTIONS` holds a change
  to and what a fixer keeps to, wherever the repository states them, and
  a repository that states none is reviewed without invented ones.
- What was chosen, and from which file, is on the ledger and in the
  report, so a reader can tell why a command ran and why a rule applied.
- The choice sits in one place early in the run, so a later change can
  put a person's approval in front of it.

## Non-Goals

- **No approval of what the survey chose.** A command the survey chose
  runs without a person agreeing to it. The author accepts the risk for
  now (Risks); the survey is its own phase so that an approval can be
  added before it or after it without moving anything else. The one
  thing the operator is asked is the opposite case, a check that cannot
  run (R15).
- **No decision by the manifest rules.** They no longer choose a
  check. What they read off the manifests is handed to the surveyor as
  a hint for the case where the repository states nothing (R11), and
  the rules are not extended.
- **No new check kinds.** `build`, `typecheck`, `lint` and `test` stay,
  in that order, with one command each. A project with two type checkers
  gets one command that runs both.
- **No setup of the project.** Neither the survey nor the engine
  installs a tool, a dependency or an environment. A check whose tool is
  missing stops the run for the operator (R15), who installs it or says
  the run goes without.
- **No change to how checks run.** The order, the containment, the
  timeout, the baseline and the repair of the fix pass (R9 to R11, R24)
  are untouched; only where the commands come from changes.
- **No judging of the conventions' quality.** The survey names where
  conventions are stated. Whether a change breaks one remains the
  `CONVENTIONS` finder's work, with its precision-first rule unchanged.

## Requirements

- **R1: Every run begins with a survey phase.** After the scope is
  captured and the run configured, and before the triage, the phase
  `survey` launches one read-only worker, the surveyor. It appears in the
  progress log, in `status` and in the report's statistics as any phase
  does.
- **R2: The surveyor names the convention sources.** It returns the
  files that state rules a change to this repository must follow, each
  with its path, what it governs in a sentence, and the paths it applies
  to when that is narrower than the repository. It reads what a
  contributor would: rules files for agents, contributing guides, style
  and developer documentation, and files those import or link to inside
  the repository. A repository that states no conventions yields an
  empty list, and that is a valid answer.
- **R3: Whether the reviewer's own rules apply is a policy setting.**
  The user-level rules files (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`) are the reviewer's preferences, not the
  repository's. The role policy holds one setting with three values,
  pinned on the run: `ignore`, they are never a convention source and
  the surveyor is not told of them; `apply`, each that exists is a
  convention source of every run; `judge`, the surveyor is told which
  exist and lists one only when it has grounds that the repository is
  the reviewer's own work or adopts those rules, and states the
  grounds. The shipped value is `judge`. Whatever the setting, the
  report says of each file whether it applied and why.
- **R4: In a fix run the surveyor chooses the checks.** For each of
  `build`, `typecheck`, `lint` and `test` it returns one command that
  runs from the repository root on this platform, or says that the
  repository has none, with the reason. With each command it gives the
  file and the text it took the command from, and whether the command
  can start on this machine: it looks whether the tools the command
  names resolve, and when one does not it says which. It prefers what
  the project's CI and contributor documentation run, prefers the form
  that verifies over the form that rewrites, and does not run the checks
  themselves. In a run without `--fix` it is not asked for checks.
- **R5: A flag settles its kind.** `--check <kind>=<command>` and
  `--no-check <kind>` are applied as today and outrank the survey; the
  surveyor is told which kinds are settled and chooses the rest.
- **R6: The survey's answer is recorded and, once the phase completes,
  pinned.** One event holds what the surveyor returned; when the survey
  phase completes, the checks the run will execute are recorded with
  each one's origin (`flag`, `survey` or `none`), before the triage
  starts. From then on a resumed run reads both from the ledger, never
  surveys again, and ignores `--check` and `--no-check` as a configured
  run does today. Only a survey phase that ended blocked (R9, R15) is
  surveyed again, and only until it completes.
- **R7: The run uses what the survey named.** The scope block every
  later worker receives lists the survey's convention sources in place
  of the fixed three names. `CONVENTIONS` checks the change against
  those sources, and with an empty list returns nothing. A fixer and the
  repair worker are told to keep their own edits within them.
- **R8: An answer the engine cannot use is refused whole.** A convention
  source or a command's source that is not a regular file inside the
  repository (or one of the user-level files the engine offered, named
  by its absolute path), a command for a kind a flag settled, a missing kind, or a command that
  is empty, spans more than one line or holds a NUL character fails the
  attempt, and the surveyor gets its one fresh retry as every role
  does. So does a path the file system cannot resolve: an odd path from
  the model costs its attempt, never the run.
- **R9: A survey that fails twice stops a fix run and not a read-only
  one.** A read-only review goes on with no convention sources:
  `CONVENTIONS` is recorded as not run for that reason, and the report
  says so under Limitations. A fix run blocks, since going on would run
  no check the flags did not name: the blocker's action is to run the
  command again, which surveys afresh, or to settle every kind with
  `--check` and `--no-check`, after which the run goes on without
  surveying again: with the convention sources of an earlier answer of
  the run, one that blocked on a missing tool, and with none when no
  attempt answered.
- **R10: The report and the log show the choice.** The log prints each
  convention source and each check with its origin when the survey is
  recorded. The report gains a Conventions section (each source, what it
  governs, and the user-level decision of R3) and its Checks table names
  each command's source file.
- **R11: The manifest rules become hints and decide nothing.** In a
  fix run the engine still reads the root manifests as it does today and
  gives the surveyor, for each kind no flag settled, the command the old
  precedence would have chosen and the manifest it came from, labelled
  as a mechanical guess. The surveyor is told to choose what the
  repository states (its CI, its contributor documentation, its task
  configuration) and to fall back on a hint only for a kind the
  repository states nothing about, after reading that the hint's command
  fits this repository and this platform. It says of each command
  whether it was stated or taken from a hint, and the report shows
  which. No command reaches the checks without passing through the
  surveyor's answer or a flag. Lock files of two package managers are no
  longer refused: the hint says they are ambiguous. No engine code lists
  rules files by name, apart from the user-level two of R3: which files
  are sources, and what each applies to, is the surveyor's answer. The
  one exception is a run configured before the survey existed, which on
  resuming lists `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` as the
  engine that configured it did (R12).
- **R12: An older ledger still opens and folds.** A run recorded before
  this change, with its checks planned by rule and no survey, folds
  under the new engine as it did. Events whose payload changes get a new
  version, and a new golden fixture is committed.
- **R13: The role text says what the engine now does.** The surveyor's
  prompt is new fragments in the manifest; the fragments that name the
  three rules files (`CONVENTIONS`, the rubric, the sweep's mention) and
  the fixer's fragments are reworded in a commit of their own, apart
  from the code.
- **R14: The gate is three real runs.** With no `--check` flag and no
  prepared `PATH`:
  click #3818 with `--fix` on Claude Code and on Codex, where the survey
  must list `docs/contributing.md`, must not apply the reviewer's home
  rules under the shipped policy, and must choose a `test` command that passes at baseline and at
  least one of `lint` and `typecheck` from the project's own
  configuration, and where a check whose tool is not installed blocks
  with R15's action and goes on after `--no-check`; and eslint #21247 with `--fix` on Claude Code, a
  repository with no rules file at the reviewed commit, where the survey
  must choose `lint` and `test` commands that pass at baseline. Each run
  reaches a report with no hand on it.
- **R15: A check the project defines and this machine cannot run stops
  the run until the operator decides.** When the surveyor returns a
  command for a kind and says a tool it needs does not resolve, the
  survey phase ends blocked, before the triage and before any worker
  beyond the surveyor is paid for. The blocker names each such kind,
  its command, its source and the missing tool. The operator's action
  is one of three, and the run goes on only when every such kind is
  settled: install the tool and run the command again, which surveys
  those kinds afresh; pass `--no-check <kind>`, which records that the
  run goes without that check by the operator's decision; or pass
  `--check <kind>=<command>` with a command that does run. A kind the
  repository does not define at all is not this case: it is recorded as
  not available and the run goes on. The report's Checks table says of
  each kind which of these it was.

## Product Decisions

- **PD1: A model chooses the checks.** Decided by the author on
  2026-10-03, reversing fix pass PD6. The rule was rejected because it
  found a fraction of click's checks, needed the operator to prepare the
  shell, and grows by one special case per repository; the author's
  words were that discovery alone can cause problems and that
  deterministic rules are not wanted in the long run. Revisit only if
  the gate shows the surveyor choosing commands that do not run more
  often than the rule did.
- **PD2: A model names the convention sources.** Decided by the author
  on 2026-10-03, reversing read-only review PD11's fixed list. A rules
  file for agents is not required of a repository: other files state
  conventions, and a repository with none is a case the engine must
  handle. A flag-configured list of names was rejected again: it moves
  the rule to the operator, who would have to know each repository.
- **PD3: The survey is its own phase, before the triage.** Decided by
  the author on 2026-10-03. Putting the two questions to the triage
  worker was rejected: the triage's answer is the SCAN's candidates and
  the leads, its prompt is the longest in the run, and a later approval
  step needs a point in the run where the choice exists and nothing has
  used it.
- **PD4: No approval for now, and the risk is accepted.** Decided by the
  author on 2026-10-03. The engine runs in the foreground with no
  channel to ask a question; adding one is steering, a later element.
  The author expects to move the survey to the very start of a run and
  put a person's approval there later.
- **PD5: The manifest rules stay as hints for a repository that states
  nothing.** Decided by the author on 2026-10-03: where there is no
  explicit rule, a mechanically found hint to the surveyor is
  acceptable. My draft removed the rules outright, on the ground that a
  hint carries the old precedence's mistakes (`make test` on a machine
  with no `make`) into the prompt with the engine's authority behind
  them; the answer to that is in how the hint is given, as a guess the
  surveyor must check against the repository and the platform, and only
  for a kind the repository is silent on. A repository that states its
  checks nowhere is common enough (a small library with a
  `package.json` and no guide) that the hint saves the surveyor from
  guessing afresh each run. The rules are frozen as they are: a
  repository they miss is the surveyor's to read, not a reason for a new
  rule.
- **PD6: A failed survey degrades a read-only review and blocks a fix
  run.** Agreed by the author on 2026-10-03; it follows PD12. A review
  without convention sources is a run the engine knows how to finish
  and report. A fix run that went on after a failed survey would run no
  check at all, which is the silent omission PD12 rules out, so it
  blocks with an action. Degrading both, my first draft, was dropped
  for that reason.
- **PD7: Whether the reviewer's home rules apply is set in the policy.**
  Decided by the author on 2026-10-03: the default is a policy setting.
  My draft left it to the surveyor alone. Dropping user-level rules
  entirely was rejected, since on the reviewer's own repository they are
  the rules that matter, and this repository is such a case; always
  applying them is what the click gate showed to be wrong. The setting
  therefore has three values and the surveyor's judgment is one of them.
  The author confirmed the three values and `judge` as the shipped one
  on 2026-10-03: `judge` keeps the model deciding, as PD2 does for the
  repository's own sources, while a reviewer who only reviews other
  people's code sets `ignore` and never pays for a wrong judgment. A command-line flag was not added: the policy file is where
  every other default of a run lives.
- **PD8: One command per kind.** The four kinds and their order are what
  the baseline, the repair and the report are built on. A project with
  several tools of one kind gets them joined in one command; the cost is
  that the report shows one outcome for the kind, not one per tool.
- **PD9: The surveyor does not run the checks, and does look whether
  their tools resolve.** The baseline phase is the measurement, with
  containment, evidence and a timeout; running a test suite from a
  read-only worker would spend the run's time twice and write caches
  into a tree it does not own. Whether a tool resolves is a cheap look
  (`where`, `which`, a `--version`), and it is what R15 stands on.
- **PD10: Checks are asked for only in a fix run.** A read-only review
  runs no command, so a chosen command would be recorded and never used.
- **PD11: A completed survey is never repeated.** A resume reads it from
  the ledger, as it reads the pinned checks today. A repository whose
  guide changed mid-run is a new run's concern. The exception is a
  survey phase that blocked: its re-entry surveys again, because the
  operator's answer to the block may have been to install a tool, and
  only a new look can see that.
- **PD12: A defined check that cannot run is the operator's decision,
  never the engine's.** Decided by the author on 2026-10-03, while this
  proposal was being drafted: simply not running a check the project
  defines is not acceptable, and the operator must confirm it. With no
  channel to ask a question, the confirmation is a blocker and a flag,
  as every other operator decision in the engine is. Recording the kind
  as not available and going on was rejected as that silent omission;
  letting the surveyor pick a weaker command it can run was rejected
  too, since that is the same omission with a passing check in front of
  it. Having the engine test the tool itself was rejected: it would
  have to parse command lines, which is the kind of rule PD1 removes.
  The block comes at the survey, before the review's workers are paid
  for, so the operator is asked at the start of a run and not after
  twenty minutes of it.

## Risks

- **A command chosen by a model from the repository's text runs with the
  operator's privileges, unsandboxed, with no approval.** Accepted by
  the author (PD4). The exposure is wider than before in one respect:
  the rule could only run names it knew (`npm run test`, `make build`),
  which already execute whatever the repository defines, while the
  surveyor can be steered by text in the repository to any command line.
  What limits it today: a read-only review runs nothing; each chosen
  command is printed with its source before the baseline starts; and the
  command is on the ledger with the file it came from. A person
  reviewing an untrusted repository with `--fix` should know this, and
  the README says so.
- **The choice is not reproducible.** Two runs on the same commit may
  choose different commands or sources. Within a run it is pinned (R6);
  across runs the report names the choice, which is what makes two
  reports comparable.
- **A chosen command may not run.** The surveyor does not run it (PD9),
  so a wrong command shows as a baseline failure. The fix pass already
  treats a kind failing at baseline as known-broken and sends it to
  repair only with both outputs (R24), so the cost is a blind kind, as
  with a rule's wrong command, not a broken run.
- **The surveyor's word on a missing tool can be wrong both ways.** It
  may report a tool missing that resolves (a block the operator clears
  by running again or with `--check`), or miss one that is absent, in
  which case the kind fails at baseline as any wrong command does and
  the report shows it failed, not that it was skipped. Codex on Windows
  was the case to watch, since its sandbox refuses some process starts
  (issue #10); a probe on 2026-10-03 showed a read-only worker there
  looks tools up correctly (Technical Design, Context). What remains is
  that a worker looks from its own shell and the check runs under the
  engine's, so the two can disagree on a tool only one of them finds.
- **A fix run on a machine without the project's tools now stops where
  it used to go on.** That is the intent of PD12; the cost is one more
  invocation with a flag for an operator who knew.
- **The run is longer and dearer by one worker**, on every run,
  including read-only ones, since the triage waits for the survey. The
  gate measures it; the click triage took 118 s and 0.59 USD, and the
  survey reads less.
- **`CONVENTIONS` may find more, and less precisely.** A contributing
  guide is prose, not a rule list. The finder's precision-first rule
  (quote the rule and the line) is what holds this, and the gate's
  reports are read for findings that quote no rule.
