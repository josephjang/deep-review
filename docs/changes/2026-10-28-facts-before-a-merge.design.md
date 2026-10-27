# Technical Design: The facts before a merge

Product part: [2026-10-28-facts-before-a-merge.requirements.md](2026-10-28-facts-before-a-merge.requirements.md).

## Summary

A new check phase, `base-checks`, runs between `checks` and `repair`. It takes each kind of check that the repair takes and that failed before the fixes. It runs the planned command of that kind once in a detached linked worktree of `scope.base`, after the build of the base as each check phase builds first, made with the hooks of the repository turned off, and with the repository variables of git and each path into the reviewed tree removed from the environment. It freezes the output as each check does. Git holds the record of the worktree: it is locked with a reason that names the run, and the phase removes it when an attempt starts, before the phase ends and when the run is abandoned.

The repair task gets the output on the base beside the outputs before and after the fixes. The repair compares the output before the fixes with the output on the base, and answers with a comparison for each check that failed on the base, in a schema of the repair alone, and the engine records it in `fix.recorded@4`. The instruction is in the task text, so no role prompt changes and the digest of the roles stays.

The brief computes from the fold when the last run of each check ran, which check the edits of the run made fail, and what the base says of each other failure. It records nothing new for that, so R3 and R4 hold for older runs too. The short form gets a line `Checks:`, the headline a count, "What the review did not cover" two kinds of gap, and "What deep-review changed" a sentence on the validation. The JSON form goes to version 4. `review.configured@8` marks a run with the phase, and only the events that name the phase or carry the comparison get a new version.

## Non-Goals

### No install step in the worktree

The phase runs the planned command as it is, in a tree where nothing is installed (PD2). A repository setup step is issue #83.

### No change to the checks in the reviewed worktree

The checks of `baseline-checks`, `checks`, `repair-checks` and `answer-checks` run where and as they run today. Only the run on the base removes the repository variables of git and the paths into the reviewed tree from its environment (TD11). The same fault for the other checks and for the git calls of the engine stays with #27.

### No change to the role prompts

The repair learns of the base from its task, and its answer gets a field from its schema. No fragment under `roles/fragments/` changes (TD6).

### No new worker

The repair worker reads the comparison (PD3). The phase itself runs no worker.

### No run on the base in an answer pass

An answer pass opens `answer` and `answer-checks` only, as today.

### No change to the scope of the repair

The repair fixes only the failures that the fixes added (PD8). Its task says so for a check whose base passes, as it says today for a check that failed before the fixes.

## Context

Verified at `4c764a7`. No uncommitted change was used.

### The check phases and the planner

`phases` in `src/review/vocabulary.ts` orders the fix pass as `baseline-checks`, `fixes`, `documentation`, `checks`, `repair`, `repair-checks`, and an answer pass as `answer`, `answer-checks`. `checkPhases` holds the four phases that run checks and no worker. `nextStep` in `src/review/steps.ts` returns `run-check` for a check phase while `dueCheck` names a kind, and `finish-phase` when it names none. `dueCheck` takes the first kind, in the order `build`, `typecheck`, `lint`, `test`, whose `runStanding` is not null. When the last current run of `build` did not pass, it skips each later kind with a reason. Each phase has its own gate: `checks` runs only after a revision of `fixes` or `documentation`, and `repair-checks` only after a revision of `repair`.

`runDueCheck` in `src/review/controller.ts` appends `check.started@1`, takes a manifest of the tracked files of the reviewed worktree, calls `runCheck` and appends `check.ran@3`. It records a `tree.revised` when the check wrote files, and a `tree.restored@1` with a write back when a stop cut it. `runCheck` in `src/review/checks/run.ts` runs the command through the platform shell with `cwd` set to the reviewed worktree, under a guard that kills the tree of the process at the timeout. Its environment is `checkEnvironment`: the environment of the engine with the build server and non-interactive pins. It freezes stdout and stderr in the evidence store and takes the outcome from the exit: `passed`, `failed`, `timeout`, `cut` or `not-started`. Today the planner alone sets `skipped`. The timeout is the pinned `checks.timeoutMs`, 20 minutes by default in `roles/policy.json`.

When an attempt of a check phase starts with a drift that a check cut short in an earlier attempt explains, `restoreStep` in `steps.ts` writes the expected bytes back and records `tree.restored@1`, whose `phase` names the four check phases. `cutShortChecks` and `cutShortBefore` in `fix-state.ts` find such a check: a run that a kill ended, or a start with no run after it (R7 of resumable runs).

### The events of a check run, and the fold

`check.started@1`, `check.ran@3` and `tree.restored@1` each fix their `phase` to the four check phases. `refineCheckRan` ties each outcome to its termination: a `skipped` run has no termination and no output, and it records an error. The reducers in `src/checkpoint/fix-fold.ts` keep the runs in `fix.checks.runs[phase]`, each as a `CheckRunState` with its `revisionsBefore`. In `src/checkpoint/fix-state.ts`, `lastFreshRun`, `lastRecordedRun` and `lastCurrentRun` read them. `isOldRun` makes a run old when a later revision belongs to a phase in `stalingPhases[phase]`, a table keyed by every check phase.

### The repair

`repairTargets` in `fix-state.ts` gives the kinds whose last fresh run after the fixes failed or timed out, and that passed before the fixes or failed then too (`failedAtBaseline`). `repairTaskOf` in `src/review/phases.ts` gives the repair task, for each such kind, the last 16 KiB of its output after the fixes and, for a kind that failed before the fixes, of its output then. `repairTask` in `src/review/tasks.ts` tells the worker to fix only the failures that the output before the fixes does not show, and to answer `deferred` naming them when every failure was there before. The repair answers in `fixerOutputSchema`, with the check kinds as the ids of its findings, and the engine records the answer as `fix.recorded@2` under `fix.answers.repair`.

### The base of the scope

`scope.captured` records `base`: the commit or the empty tree that the change is measured from. `chooseMode` in `src/scope/capture.ts` sets it to the merge base or the start of a range, to a named ref, to the first parent of `HEAD` for the last commit, or to `HEAD` for the working tree. A root commit has the empty tree as its base, and no worktree can be checked out at it. `baseNameOf` in `src/scope/scope-line.ts` names a base as a person reads it, such as `the merge base with origin/main`.

### Git and the environment

The engine has no helper for a git worktree. `git` in `src/scope/git.ts` runs git through `runGitSync` with the environment of the engine. No code under `src/` removes `GIT_DIR` or the other repository variables from that environment. Only the test suite does, with the list in `test/helpers/git.ts` (#27). `mkdtempSync` with a removal in a `finally` is the pattern of `src/review/commit.ts`, and `scratchBase` in the controller is the scratch directory of the checkpoint under `tmpdir()`.

### The brief, its forms and the report

`checksOf` in `src/review/brief.ts` gives each check `before`, its last baseline run, and `after`, the current run of the latest of `answer-checks`, `repair-checks` and `checks` (`afterPhases`), else the newest run. `checksWords` words `after` as "after them", the fixes, whatever its phase (#78). `headlineText` counts the open questions, the departures that no person reviewed and the documents left out of date, and on a fix run "Nothing needs you" says that the run left no document out of date that it knows of. `fixGaps` gives the gaps of a fix run, and `briefShortForm` gives at most 22 lines. `briefJson` in `src/review/brief-json.ts` writes version 3. The Checks part of the report is `checksSection` in `src/review/fix-report.ts`, one column for each check phase that ran, titled by `phaseTitles`.

Each fixer reports `validation` for each finding, with a `method` among `old-code`, `mutation`, `static`, `existing` and `limited` (`roles/fragments/fixer-validation.md`). The report shows these lines only in its evidence.

### The versions of the events and older runs

`review.configured@7` marks a run with the documentation step. The documentation step wrote a new version only for an event that names its phase (TD5 of the documentation step), and this design follows that rule. At `4c764a7` the newest versions are `review.configured@7`, `phase.started@6`, `phase.finished@7`, `worktree.checked@7`, `check.started@1`, `check.ran@3`, `fix.recorded@3` and `report.written@6`. The golden fixtures end at `test/fixtures/checkpoints/schema-1-15`.

### The digest of the roles

`rolesDigest` in `src/review/policy.ts` hashes the key and the digest of each assembled role prompt. The output schema of a role and the text of a task are not in it. A run refuses to resume under another digest (PD8 of fix pass continuation), so a change that leaves the prompts alone lets a run that started before it continue and take answers.

### The contract test

`test/review/resumable-runs.contract.ts` lists the fixed stop points, and `npm run resume-test` stops at every append and every child start. In its fake repository, every check passes before the fixes, so a phase that runs only for a check that failed before and after the fixes never runs there today.

## Design

### The phase (R1, R11)

`base-checks` comes after `checks` and before `repair` in `phases` and `fixPhases`, and it joins `checkPhases`. It is a check phase: it runs checks and no worker, and the planner walks it as it walks the others, with the differences that this section names.

The kinds due in the phase are `baseKinds(fix)`: the kinds of `repairTargets(fix)` for which `failedAtBaseline(fix, kind)` holds. A kind is due while `runStanding` of the phase is not null for it, with one difference: in this phase a timeout is a result, and a kind that timed out on the base does not run there again (PD11, TD15). A cut run still runs again, as in each check phase.

When a kind of `baseKinds` other than `build` is due and the run has a command for `build`, the phase runs `build` on the base first, also when `build` passed before and after the fixes, because the other kinds read what it produces (TD4). Each attempt of the phase makes its worktree anew, so a `build` that passed on the base in an earlier attempt runs there again while another kind of `baseKinds` is still due, and that kind never runs in a worktree that no build prepared (TD16). The rule of the other check phases that skips each later kind after a failed `build` holds here too. When the build fails on the base, the other kinds get a `skipped` run there, and each of them is not compared, with the reason that the build failed on the base. A `build` that runs only to prepare the base is recorded as each run on the base, and the brief gives it no fault and no clause of its own. With no kind due, the phase finishes as completed at once, as `checks` does when no fix changed a file.

`stalingPhases['base-checks']` and `markingPhases['base-checks']` are empty: a run on the base never grows old, since no edit of the run changes the base (TD5).

A run on the base never writes the reviewed worktree, so the write back of a stopped check does not hold in this phase (TD14). `cutShortChecks` gives no run and no start of `base-checks`, so `cutShortBefore` and `restoreStep` never name one. A drift at the start of an attempt of the phase blocks as any drift does.

### The worktree of the base (R1, R11)

Git holds the record of the worktree (TD3). The phase makes it in a new private directory under the scratch directory of the checkpoint, made with `mkdtempSync` with a name that starts with the id of the run, and held outside the reviewed tree and the checkpoint by `requireOutsideRun`:

```text
git -c core.hooksPath=<a path that does not exist> worktree add --detach --lock --reason "deep-review <run id>" <path> <scope.base>
```

A `core.hooksPath` that does not exist turns off the hooks of the repository, such as a `post-checkout` hook, for this call. The lock keeps `git worktree prune` from removing the entry while the phase uses it, and its reason names the run. The call runs with the repository variables of git removed (TD11), with `GIT_LFS_SKIP_SMUDGE=1` so that the checkout downloads no large file, with `GIT_TERMINAL_PROMPT=0`, and with a timeout of its own.

The worktrees of a run are the entries of `git worktree list --porcelain` whose lock reason is `deep-review <run id>`. The phase removes each with `git worktree remove -f -f <path>`, which removes a locked entry, and its entry also when its directory is gone (checked with git 2.56). It removes them at three moments: when an attempt of the phase starts, before its check of the reviewed worktree, so that a drift block leaves none; before it appends `phase.finished`, so that no crash after the end of the phase leaves one; and in `deep-review abandon`. At the same moments it removes the directories of its earlier attempts that it finds under the scratch directory, since a stop before git made the entry leaves a directory with no entry. A removal that fails is logged and does not stop the run, and the next of these moments tries again. The phase never runs `git worktree prune`, which would remove the entries of other worktrees of the person whose directories are missing.

When `scope.base` is the empty tree, the phase makes no worktree. When git cannot make the worktree, the phase keeps the first line of its error. In both cases each due kind gets a `check.ran@4` with the outcome `skipped` and an error that says why: `the base of the change is the empty tree`, or `no worktree of the base could be made: <error>`. The error of git names local paths, so the brief gives only the fixed words before the colon, and the report gives the error of git in the facts of the run, the one part that names a local path (R15 of the brief of a run).

### The run of a check on the base (R1)

The phase runs the planned command of the kind through `runCheck`, with three differences from the other check phases. The `cwd` is the worktree of the base. The environment is `checkEnvironment` with the repository variables of git removed, and with no path into the reviewed worktree: the entries of `PATH`, `PYTHONPATH` and `NODE_PATH` inside that tree are removed, and `VIRTUAL_ENV` is dropped when it is inside it, so a check on the base does not load the code of the change through them (TD11). The log of the run names each variable that the phase changed: no event carries the environment of a check, so the report, which reads the events, cannot name them. And the run takes no manifest of the tracked files, records no `tree.revised` and writes nothing back, since it never touches the reviewed worktree. The timeout, the guard, the freezing of the output and the outcome are those of each check. A run on the base appends `check.started@2` before it and `check.ran@4` after it.

### The repair and the comparison (R2)

`RepairTaskCheck` gets a `base`: null for a kind that did not run on the base, else the outcome on the base and, for an outcome other than `passed` and `skipped`, the tail of its output with the frozen paths, as for the other outputs. A `skipped` base gets its error. `repairTask` adds one paragraph for each case:

- The base passed: the check passes on the base of the change, so the change brings its failures. They are not the repair's to fix, as the failures before the fixes are not.
- The base failed or timed out: the output there follows. The worker compares the failures before the fixes, on the change as submitted, with those on the base, and gives one entry in `comparisons`.
- The base was skipped: the reason follows, and the worker gives no entry.
- The base run did not start: the error of the start follows, and the worker gives no entry.

The repair of a run configured with the phase answers in `repairOutputSchema`: `fixerOutputSchema` with `comparisons`, an array of `{kind, reading, words}`. `reading` is `same` when the change has no failure that the base does not have, `adds` when the change has a failure that the base does not have, and `unknown` when the outputs cannot be compared. `words` says why, in at most 400 characters, and the task asks for words with no path. The comparison reads two outputs that no edit of the run changes: the output before any fixer edited the tree, and the output on the base. So it stays true after the repair and after each answer pass. Whether the fixes added failures to a check that failed before them is the reading that the repair makes today, and its answer for the kind keeps it (TD13).

`invocationFor` takes the schema from the unit, not the role, so only the repair of such a run gets it (TD6). The schema holds `kind` to the check kinds. The engine refuses no answer of the repair for its comparisons, since the comparison is a second product of the repair and must not cost the repair its edits. It drops an entry for a kind that did not fail or time out on the base, and a second entry for one kind, and logs each. A kind whose base run failed or timed out and that has no entry reads as not compared, with the reason that the repair gave no comparison (R5).

The engine records the answer as `fix.recorded@4`: version 3 with `comparisons`. It writes version 4 only for the repair of a run configured with the phase. Every other answer keeps the version that it is written at today: version 3 for the documentation step, and version 2 for the fixers, the repair of an older run and the answer passes (TD7). The fold keeps `comparisons` with the answer of the repair, empty for an earlier version.

When the run budget stops the repair, or its worker fails twice, no comparison exists. Each kind whose base failed then reads as not compared (R2).

### The checks of the brief (R3, R4, R5)

`BriefCheck` becomes:

```ts
interface BriefCheck {
  readonly kind: CheckKind;
  readonly before: string | null;
  readonly last: { readonly outcome: string; readonly when: 'fixes' | 'repair' | 'answers' } | null;
  readonly base: BriefBase | null;
  readonly fault: 'edits' | 'base-has' | 'change-breaks' | 'change-adds' | 'not-compared' | null;
}
```

`last` is the run that `after` is today, with `when` taken from its phase: `checks` gives `fixes`, `repair-checks` gives `repair` and `answer-checks` gives `answers`. `afterPhases` keeps its three phases, so a run on the base is never the last run (R3, #78). `base` holds the commit of the base, its name from `baseNameOf`, the outcome there with the reason of a `skipped` run in fixed words, and the reading of the repair. It is null for a kind that did not run on the base. The words of the repair stay in the report: the outputs that the worker compares name the paths of two worktrees, and the brief holds no local path that the engine writes.

`fault` follows from the fold. The rows apply in order, and a check takes the first row that holds:

| `fault` | When |
|---|---|
| `edits` | `last` failed or timed out, and an earlier run of the kind in this run passed: the baseline, or a run after the fixes, the repair or an earlier answer pass, in the order of the ledger |
| `change-breaks` | `last` failed or timed out, the kind ran on the base, and the base passed |
| `change-adds` | `last` failed or timed out, the kind failed or timed out on the base, and the repair read `adds` |
| `base-has` | `last` failed or timed out, the kind failed or timed out on the base, and the repair read `same` |
| `not-compared` | `last` failed or timed out, the run is configured with the phase, the kind is in `baseKinds`, and none of the rows above holds |
| null | Every other case |

A row that reads the base holds only for a kind that the phase took. A kind that the planner skipped after a failed `build`, or that did not start for a missing tool, never had a run on the base, so it gets no fault from the base and keeps the gap of today: a check that did not finish.

A row that reads the base also holds only while `last` failed or timed out. The merge question is about the tree now, and a check that a later run made pass, such as one that the repair or an answer pass fixed, no longer has the failure that the base explains. It gets no fault from the base, so no gap and no clause of the base: the line `Checks:` gives it the row of a check that failed before the fixes and passes now, and the brief does not say that no step of the run fixed its failure. The comparison stays a fact of the change as submitted (TD13), so the sentence of the checks and the report keep it. A check whose last run was skipped or did not start gets no fault from the base either, and keeps the gap of a check that did not finish, since the run does not know if it fails now.

The reason of `not-compared` comes from where the comparison stopped, in fixed words: the base of the change is the empty tree, no worktree of the base could be made, the build failed on the base, the check did not start on the base, the check did not run on the base, the repair gave no comparison, or the repair could not compare the outputs. A run that this change did not configure gets no `not-compared`, since it never had the phase, although the fold gives it `baseKinds` as for each run (R10). It gets `edits` as each run does.

The headline gets `checks`, the count of the checks with the fault `edits`, and its sentence names them as `N check(s) that the edits of the run made fail`, after the documents. On a fix run, the sentence "Nothing needs you" names the checks too: `Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, the run left no document out of date that it knows of, and its edits made no check fail.`

`fixGaps` gives a gap of the kind `check` for each check with the fault `change-breaks`, `change-adds` or `not-compared`, with the words of R5. The gap of `change-adds`, the sentence of the checks and each clause that rests on a reading of the repair say that it is the repair's reading, as the brief marks the account of the triage. A base that passed needs no such mark: the engine reads it from the exit of the check. The words name the base by its name and its first 8 characters, as the `Scope:` line does.

`checksWords`, the sentence of the checks in "What deep-review changed", gives each check its outcome before the fixes and its last outcome with `when`. It adds the base for a check that ran there, with the reading of the repair in fixed words.

### The short form (R6)

`briefShortForm` gives a fix run the line `Checks:` after the line of the documents left out of date. A kind takes the first row of the table that holds for it. The line names the kinds in the order of the rows, and two kinds of one row in the order of the kinds, so the kinds that need the person come first and a cut drops the kinds that passed first:

| Case | Clause |
|---|---|
| `edits` | `<kind> failed after <the fixes / the repair / your answers>, and passed <before the fixes / after the fixes / after the repair / after earlier answers>`, with `timed out` for a timeout and the last pass before it |
| `change-breaks` | `<kind> fails on the change and passes on the base (<commit>)` |
| `change-adds` | `<kind> fails on the change with failures that the base (<commit>) does not have, by the repair's reading` |
| `not-compared` | `<kind> failed before and after the fixes, not compared with the base` |
| `base-has` | `<kind> failed, as it does on the base (<commit>), by the repair's reading` |
| Failed before the fixes, passed at its last run | `<kind> failed before the fixes and passes now` |
| Failed after the fixes, passed at its last run | `<kind> failed after the fixes and passed after <the repair / your answers>` |
| Failed before the fixes, and no check ran after them | `<kind> failed before the fixes and did not run again` |
| Its last run timed out, was skipped or did not start | `<kind> did not finish` |
| No command | `no <kind> check` |
| Passed at each run | the kinds, then `passed` |

When each kind passed at each run, the line is `Checks: each passed before and after the fixes`. When no check ran after the fixes, because no fix changed a file, the line ends with `no check ran after the fixes, since no fix changed a file`, and a line whose kinds all passed before the fixes is `Checks: each passed before the fixes; no check ran after them, since no fix changed a file`. A run with no check command at all gets `Checks: none, since the run has no check command`. The line is cut at a word at 200 characters, so the short form has at most 23 lines.

### The validation (R7)

For each fix that "What deep-review changed" counts as applied, the brief takes the `validation` of the answer that applied it, and the strongest method of it: a test (`old-code` or `mutation`), then `existing`, `static` and `limited`, and none when the answer gave no entry (TD12). The sentence calls `static` a check of the source, since such a check can run a source assertion as well as read the source. The sentence counts the fixes that a test validated, and names each other fix under its method, with at most 8 ids shown for each method and the others counted. A fix run that applied no fix gets no sentence.

### The report (R8)

`phaseTitles` gets `'base-checks': 'On the base'`, so the Checks table gets a column for the runs on the base. Its cell is that of each other column, followed by the reading of the repair and its words, but with no mark "(failing before the fix pass)", which each kind on the base would carry. `status` shows the phase only when a kind ran there, so a fix run whose checks pass shows no line for it. The notes under the table name the base by its name and commit. They also say why no check ran on the base, or why a kind did not run there.

### The JSON form (R9)

Version 4 of the JSON form is version 3 with three changes. `headline` gets `checks`. Each entry of `changed.checks` gets `last` with `when`, `base` and `fault`, and `last` replaces `after`. `changed` gets `validation`, the ids of the applied fixes under each method. `briefJson` writes version 4 alone.

### The events and the fold (R10)

The vocabulary freezes as `reviewVocabularyV9`, with 20 phases and 5 check phases. These events get a new version, each written only where this change needs it (TD7):

| Event | New version | Written for |
|---|---|---|
| `review.configured` | 8 | Each run that this engine configures. The version alone marks a run with the phase (TD8) |
| `phase.started` | 7 | The phase `base-checks` |
| `phase.finished` | 8 | The phase `base-checks` |
| `worktree.checked` | 8 | A check of the reviewed worktree at the start of `base-checks` |
| `check.started` | 2 | A run on the base |
| `check.ran` | 4 | A run on the base |
| `fix.recorded` | 4 | The answer of the repair of a run configured with the phase |
| `report.written` | 7 | A report whose statistics hold the row of `base-checks` |

`tree.restored` gets no new version, because no run on the base is restored. The phase has no unit, so `attempt.failed` and `unit.unattempted` get none either.

In the fold, `ConfiguredSteps` gets `compared`, true from `review.configured@8`. `configure` skips `base-checks` in a run without it, with a reason in `skipReason`, as it skips `documentation` before version 7. `configuredPhases` in `fix-fold.ts` keeps the phase skipped when a fix pass is pinned or reopened in such a run. In a run configured with the phase, `fixReopened` reopens `base-checks` after `checks`, beside `repair`, `repair-checks` and `report`. A run on the base never grows old, so the reopened phase runs only the kinds that the reopened pass added to `baseKinds`, and each comparison made before stays. A kind added in this way that the repair of the reopened pass does not compare reads as not compared, with the reason that the repair gave no comparison. The reducers of `check.started` and `check.ran` take the new versions. The reducer of `check.ran@4` holds a run on the base to a kind of `baseKinds`, or to `build` when another kind of `baseKinds` is due. The reducer of `fix.recorded@4` holds `comparisons` to the kinds whose base run failed or timed out, at most once each, since the engine drops the other entries before it records the answer. The fold holds recorded data to such rules elsewhere too, as the reducer of the answer of a fixer holds its ids to its batch. The statistics of a run get the phase as each other phase, and `status` shows it only when a kind ran there (R8).

### Older runs and older engines (R10)

A run that an engine before this change configured skips `base-checks`, and it never had a run on the base. Its brief follows R3 and R4, since `last`, `when` and `edits` come from the fold, and it says nothing of the base. An engine before this change does not know `review.configured@8`, so it passes over a run of this engine, as for each new version of an event.

### A stop in the phase (R11)

The phase appends `check.started@2` before each run, so a stop leaves an open start, as in each check phase. The next command enters the phase again with a new attempt. `runStanding` then gives the kind again, and the phase removes the worktree that the stop left and makes it again. When `build` passed in an earlier attempt, it runs again first in the new worktree (TD16). A stop during `git worktree add` can leave a part of a worktree: an entry locked with the reason of the run, or a directory with no entry. The removal at the start of the next attempt finds both. A run on the base never touches the reviewed worktree, so a drift found when the phase starts again is an edit of a person, and it blocks as any drift does (TD14).

The contract test gets a repository whose `typecheck` fails before and after the fixes. So `base-checks` and the repair with a comparison run there, and the stop points of the phase join the fixed points. Its part "nothing false" compares the outcomes of the runs on the base too. Its part "no orphan" also holds that no worktree of the base is left after the run completes.

### The golden fixture

A change of the event kinds needs a new fixture: `npm run golden -- --output test/fixtures/checkpoints/schema-1-16`. Its fix run has a check that fails before and after the fixes, so the fixture holds `review.configured@8`, a run on the base and a repair answer with a comparison. The older fixtures must still open and fold.

### Where the code goes

The facts of the checks for the brief go to a module of their own, `src/review/brief-checks.ts`: `BriefCheck`, the table of `fault`, the clauses of the line `Checks:` and the sentence on the validation. `brief.ts` has 1001 lines today, and it calls that module. The worktree of the base and the environment of a run on the base go to `src/review/checks/base.ts`. The list of the repository variables of git goes to `src/runtime/git-sync.ts`, which every git call of the engine and every test process already loads. `runDueCheck` calls it for the phase, so the controller, 1677 lines today, gains a call and not the steps.

### The skills and the README

The skills show the lines of the short form as printed, so the line `Checks:` reaches the chat with no change of their text. The README gets the line `Checks:`, the limit of 23 lines, the phase on the base in the list of the phases of the fix pass, and version 4 of the JSON form.

## Technical Decisions

### TD1: A phase of its own between `checks` and `repair`

The run on the base is a check phase of its own, as the documentation step is a phase of its own (TD1 of the documentation step). The planner, the stop and the resume, the statistics and the report then treat it as each other check phase.

The design rejects three other places. In the phase `checks`, a run on the base reads as a run after the fixes, and each reader of `afterPhases` and of the staleness rules must tell the two apart. Inside the phase `repair`, before the worker, the runs belong to a phase of units, which the planner does not run checks in. After the repair, the repair cannot compare.

### TD2: A detached linked worktree, not a copy of the tree

`git worktree add --detach` gives a checkout of the base that shares the objects of the repository. A tool that reads the metadata of git, such as a version from a tag, works there as in the tree of the person. The cost is an entry in the git directory while the worktree lives, and hooks that the call must turn off.

The design rejects two other ways. A copy of the tree, with `git archive` or a checkout into a temporary index, has no git metadata, so such a tool fails on the base for a reason that is not in the code. A clone copies the history and takes longer.

### TD3: Git holds the record of the worktree

The lock reason names the run, so `git worktree list --porcelain` finds the worktrees of a run from any later command, whatever its temporary directory. No event records the worktree, since the fold needs nothing from it. The phase removes only the entries of its own run, with `git worktree remove -f -f`.

The design first fixed the path under the scratch directory of the checkpoint and removed what was there, with `git worktree prune` as a fallback. The review showed three faults. The scratch directory follows `TMPDIR`, so a later command can look in another place. A crash after `phase.finished` left the worktree for good, since the phase never ran again, and `abandon` refuses the run once it completed. And `git worktree prune` removes the entries of each worktree whose directory is missing, also the worktrees of the person on a disk that is not mounted.

### TD4: The kinds that need a fact of the base, after a build of the base

Only the kinds that the repair takes and that failed before the fixes need a fact of the base (PD1). The other kinds read what `build` produces (`checkKinds` in `src/review/vocabulary.ts`), so a fresh checkout of the base needs its build first, as each other check phase runs `build` first in its tree. The phase also keeps the rule that skips the later kinds after a failed `build`: a kind that runs after a failed build fails for a reason that is not its own, and its output would mislead the comparison.

The design first ran only these kinds, with no build of the base and no skip. The review showed that a typecheck or a test that reads generated code then fails on the base for a missing build, and reads as a failure of the base.

### TD5: A run on the base never grows old

No edit of the run changes the base, so `stalingPhases['base-checks']` is empty. A run on the base from an earlier attempt that completed stays the run of its kind.

### TD6: The comparison is a field of the answer of the repair, in a schema of the repair alone

The reading is the reading of the worker, so it comes in its answer. A schema of the repair alone, chosen by the unit, keeps the other fixers from a field that they must leave empty. A missing entry is never silent: the brief reads its kind as not compared, with the reason that the repair gave no comparison. The engine does not refuse the answer for it, so a fault in the comparison never costs the repair its edits. The instruction is in the task text, and neither is in the digest of the roles, so no role prompt changes. A run that started before this change can resume and take answers under the new engine.

The design rejects two other ways. The note of the finding is free text, so the brief cannot classify it. An event that the engine writes from its own reading of the outputs reads paths and lines as different (PD3).

### TD7: A new version only for an event that names the phase or carries the comparison

This is the rule of TD5 of the documentation step. A run that never enters the phase writes the versions of today, so an older engine reads more of a ledger of this engine than with a new version of each event.

### TD8: `review.configured@8` marks a run with the phase

The version alone marks the run, as version 7 marks the documentation step. The payload does not change.

### TD9: The brief computes `when`, the fault and the count

`when` comes from the phase of the last run, `edits` from the order of the runs, and the other faults from the run on the base and the comparison. Nothing new is recorded for them, so a run before this change gets R3 and R4 too (TD6 of the documentation step does the same for the documents).

### TD10: Version 4 of the JSON form

A change of the shape is a new version (TD8 of the brief of a run). Version 4 replaces `after` with `last`, which says when the last run ran.

The design first kept `after` beside `last`. The review showed that no reader gains from it: the schema of version 3 holds its version and refuses a field that it does not know, so a program of version 3 must change to read version 4 in any case. And `after` is the name that #78 showed to mislead.

### TD11: The repository variables and the paths into the reviewed tree are removed for the base

A variable such as `GIT_DIR` or `GIT_WORK_TREE` in the environment of the engine makes git act on the repository it names, not on the worktree of the base. The phase removes them from its git calls and from the environment of its checks. In the same way, a path into the reviewed worktree in `PATH`, `PYTHONPATH`, `NODE_PATH` or `VIRTUAL_ENV` can make a check on the base load the code of the change, which would read as the same failures on the base. The phase removes such paths from the environment of its checks. The list moves from `test/helpers/git.ts` to `src/`, and the test helper imports it. The other checks and the other git calls of the engine keep their environment (#27).

### TD12: The strongest method of a fix counts

A fixer can give more than one entry for a fix. The sentence takes the strongest: a test that failed on the code before the fix or on a mutation of the fix, then the tests that already exist, then a check of the source, then a named limit. `roles/fragments/fixer-validation.md` prefers an executed red run, which is the first of these, and sets no order among the others. This design orders them by how much of the behavior each runs: the tests that exist run the code, a check of the source proves only the invariant that it names, and a limit says what could not run.

### TD13: The comparison reads the change as submitted

The worker compares the output before the fixes with the output on the base. Both outputs come from trees that no edit of the run changes, so the reading is a fact about the change and never grows old.

The design rejects a comparison of the output after the fixes with the base. A failure that a fixer added would then read as a failure that the change adds, against PD4, which counts a fault of the run apart from a fault of the change. And the repair edits right after it compares, so the reading would describe a tree that the run has already changed.

### TD14: The write back of a stopped check leaves the phase out

R7 of resumable runs writes back the writes of a check that a kill cut short, because that check ran in the reviewed worktree. A run on the base runs in another tree. A drift of the reviewed worktree after a stop in this phase can only be an edit of a person, so it blocks.

The design rejects a new version of `tree.restored` that names the phase. The write back would then put the expected bytes over the edit of the person. With no change at all, `restoreStep` would name a run on the base, and the append of `tree.restored@1` would refuse its phase at each resume, so the run could only be abandoned.

### TD15: `runStanding` gives no second run after a timeout in the phase

`runStanding` takes the phase and gives `again` for a first timeout only in the other check phases. The other reasons to run again, a cut run and a cut attempt, hold in this phase too, since a stop says nothing of the check. This is the mechanism of PD11.

### TD16: Each attempt makes the worktree of the base again, and builds it again

The phase removes the worktrees of the run when an attempt starts, and the attempt makes a new one at its first due check. A `build` that passed in an earlier attempt prepared a worktree that is gone, and a `build` skipped in an earlier attempt that could make no worktree says nothing of the build. So `runStanding` gives `build` again in this phase, with the reason that it ran for the worktree of an earlier attempt, while another kind of `baseKinds` is due there. The run names the passed build that it replaces, as each run again names the run it replaces, and the fold accepts it by the same `runStanding`. Once `build` ran in the attempt, it is due again only in a later attempt that has another kind due. A `build` that failed or timed out on the base in an earlier attempt that finished stays its result, since the base does not change, and the other kinds are skipped after it as before.

The design rejects keeping the worktree from one attempt to the next. A stop can leave it half made: a checkout or a build that the stop cut leaves a tree that a later attempt cannot tell from a whole one. And its directory may be gone, since the scratch directory follows `TMPDIR`, and a temporary directory can be cleaned between two commands. A worktree kept across attempts would need a record of what was made in it, which the fold needs for nothing else (TD3).

## Open Questions

### How long does a run on the base take?

A tool such as `tox` makes its environment in the new worktree and downloads it. The metric of the time measures it on pallets/click #3878.

### Does the repair compare the outputs well?

The outputs on the base name other paths than those of the reviewed worktree. The gate reads each comparison against both outputs.

### Does a worktree under the scratch directory work on each system?

A long path on Windows, or a file that another program holds when the phase removes the worktree, can make a step fail. Each failure gives a check that the run did not compare, and the gate shows if it happens.

## Test Strategy

### R1: The run on the base

A test of the planner holds that `base-checks` takes only the kinds of `baseKinds`, after a run of `build` on the base when another kind is due and `build` has a command, that it skips the other kinds after a failed `build` there, and that it takes none when no kind failed before and after the fixes. It also holds that a kind that times out on the base runs once, and that a cut run there runs again. It holds that a stop after `build` passed on the base and before another due kind ran there runs `build` again before that kind in the next attempt, and that nothing more is due once both ran in that attempt. A test of the fix pass, with fake checks that fail before and after the fixes, holds that each due kind runs once with its `cwd` in a worktree whose `HEAD` is `scope.base`, and that the worktree is gone after the phase. A hook of the repository does not run. A base of the empty tree and a worktree that git refuses each give a `skipped` run with its reason. A test of the environment holds that `GIT_DIR` set for the engine does not reach the run on the base, and that an entry of `PATH` or `PYTHONPATH` inside the reviewed worktree does not either, while the other entries do. A test of the worktree holds that a worktree that a crash left, locked with the reason of the run, is removed at the next command of the run and by `abandon`, also when that command runs with another temporary directory, and that no other worktree entry of the repository changes, also one whose directory is missing.

### R2: The comparison

A test of the task holds its paragraph for each case of the base. A test of the answer holds that a valid answer is recorded as `fix.recorded@4` with its comparisons. It also holds that an answer with a missing entry is recorded and its kind reads as not compared, that an entry for a kind whose base passed and a second entry for one kind are dropped with a log line, and that the edits of the answer count in each case. A run whose repair the budget stopped reads each failed base as not compared.

### R3, R4 and R5: The checks of the brief

Tests of the brief hold `when` for each phase of the last run, the case of #78 (a test that fails after an answer pass reads as failed after your answers), each row of the table of `fault` and their order, a check whose last run timed out after a pass, a check that failed before the fixes, passed after them and failed after an answer pass, the headline and its clause, and the words of each gap with each reason of `not-compared`. A test holds that a kind skipped after a failed `build` gets no fault from the base and one gap only. A test holds that a kind that failed before and after the fixes, whose base passed or has the same failures, and that an answer pass made pass gets no fault, no gap and the clause of a check that passes now.

### R6: The short form

Tests hold each clause and the order of the rows, a kind that two rows match, the line when each kind passed, when no check ran after the fixes and when a kind has no command, a cut at 200 characters that keeps a kind with the fault `edits`, a run that only reviews with no line, and a short form of at most 23 lines.

### R7: The validation

Tests hold the sentence for each method, the strongest of several entries, a fix with no entry and a run with no applied fix.

### R8: The report

A test of `checksSection` holds the column, the reading and the notes.

### R9: The JSON form

A test holds that `briefJson` passes `briefJsonV4`, and that no entry of `changed.checks` has `after`.

### R10: Older runs and older engines

The fixture `schema-1-16` holds a run with the phase, and every older fixture still opens and folds. Tests of the fold refuse a run on the base of a kind that the phase does not take, and a comparison of a kind whose base passed or that has one already. A test resumes a fix run configured with version 7 under this engine and holds that it writes no event at a version that this change adds (TD7). A test holds that a run configured with version 7 skips the phase and gets no `not-compared`. Tests of `fix.pinned` and `fix.reopened` hold the phase on runs configured with versions 7 and 8, and that a reopened phase runs only a kind that the reopened pass added.

### R11: A stop in the phase

The contract test holds the five parts at each stop point of the phase, and `npm run resume-test` breaks at none. Its stop points include the moments before and after `git worktree add` and `git worktree remove`, which the test preload wraps as it wraps `update-ref` today, and a stop just before `phase.finished`. Its part "no orphan" also reads `git worktree list --porcelain` and holds that no entry locked with the reason of the run is left after the run completes, as it holds that no process is left. A test of the planner holds that a stop during a run on the base, then an edit of the reviewed worktree, blocks at the next command with the drift blocker and writes nothing back.

### R12: The gate

The gate records each run of R12: the line `Checks:`, the headline and the gaps, against the outputs of the checks and of the same command run by hand on the base, and each comparison of the repair against both outputs. It records the time of the phase as a part of the time of the run, and what each host does when the person asks if the change can merge.

## Verification

No checks have run yet.

## Risks & Migration

### Ledgers before this change

A ledger before this change folds as before. Its runs skip the phase, and their briefs get R3 and R4 from the fold.

### An older engine and a newer run

An older engine passes over a run that this engine configured, as for each new version of an event.

### A program that reads the JSON form

A program that reads version 3 must read version 4. Version 4 keeps each field of version 3 but `after` in each check, which `last` replaces.

### An entry in the git directory

While the worktree lives, the git directory of the person holds a locked entry for it, and `git worktree list` shows it with the reason `deep-review <run id>`. A run that crashes and is never resumed or abandoned leaves the entry until a person removes it with `git worktree remove -f -f`. A `git worktree prune` does not remove a locked entry.

### A long checkout of the base

On Windows, the git calls of the engine stop after 60 seconds (`runGitSync`). A checkout of a large base can take longer, so `git worktree add` gets a timeout of its own. A partial clone can fetch the blobs of the base over the network during the checkout. A checkout that fails or stops gives a check that the run did not compare.

### What the checkout of the base runs

The hooks are off, and `GIT_LFS_SKIP_SMUDGE=1` keeps Git LFS from a download. A check that reads a large file of Git LFS then sees its pointer on the base and can fail there for it, and the repair reads that it cannot compare. Another filter of the repository still runs at the checkout. Capture refuses a repository with a submodule (`refuseUnsupportedState` in `src/scope/capture.ts`), so no base has one.
