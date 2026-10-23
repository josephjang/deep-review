# Implementation plan: the documentation step

This is the plan of the work for the [requirements](2026-10-23-documentation-step.requirements.md) and the [design](2026-10-23-documentation-step.design.md). It stays in the pull request while the work continues, and the commit that records the verification deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the commands that prove it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit. `npm run test:contract` runs before each commit that changes how the engine stops, resumes, launches a child or appends to the ledger: steps 2, 6 and 9.

`npm run verify` passes at each head that is pushed, as `AGENTS.md` says, and CI runs it too. Thus each batch of commits that goes to origin ends with `npm run build`, and with a `chore(dist)` commit when `dist/` changed.

The proposal can change during the work. If the code needs a different design, a commit of its own amends the proposal before the code commit. Thus the pull request shows each change of the proposal beside the code that needed it. A role prompt changes in two kinds of commits, as `AGENTS.md` asks: one that moves text, and one that changes what it says.

## 0. The branch, the proposal and this plan

- The branch is `feat/documentation-step`, from `main` at `eda4e82`. It holds the proposal, this plan and the implementation. Its name is set before the first push, because a rename of a pushed branch closes its pull request.
- `npm ci` in the worktree.

```sh
git switch -c feat/documentation-step
git add docs/changes/2026-10-23-documentation-step.requirements.md docs/changes/2026-10-23-documentation-step.design.md
git commit -m "docs(changes): Propose the documentation step"
git add docs/changes/2026-10-23-documentation-step.plan.md
git commit -m "chore(changes): Add the working plan for the documentation step, for now"
```

## 1. The draft pull request

- `npm run check` and `npm run verify` at the head.
- Push the branch, and open a draft pull request with the proposal and this plan, so the author reviews the proposal before the code. The body has the three sections Motivation, Modifications and Result, and it says that the implementation follows in the same pull request.
- CI runs on Linux, macOS and Windows from then on.

## 2. The ledger and the fold (R1, R11; TD1, TD2, TD4, TD5, TD11, TD12)

Files:

- `src/review/vocabulary.ts`: `phases`, `fixPhases`, `editingPhases` and `budgetDegradingPhases` get `documentation`, with their comments. `reviewRoles` waits for step 3.
- `src/checkpoint/events.ts`: `reviewVocabularyV8`, the ten new versions of the table "The events and the fold" of the design, and `reviewConfiguredV7`. Also `documentationPlannedV1` with `refineDocumentationPlan`, and the registry. The exported types move to the new versions.
- `src/checkpoint/review-fold.ts`: `configure` takes the flag of version 7 and keeps it as `documentationStep`. `skipReason` takes the flag, for the reason of `documentation`. The reducers of the phase events take their new versions.
- `src/checkpoint/fix-state.ts`: `FixState.documentation`, `emptyFixState` and `documentationItemsOf`, which takes the resolver as a parameter. `unitIdsOf`, `ownedFiles` and `budgetStoppedUnits` take the new phase. `fixPassRevisedPaths` takes the place of `fixesRevisedPaths`, and `stalingPhases` changes.
- `src/review/phases.ts`: the task of the repair takes its owned files from `fixPassRevisedPaths`.
- `src/review/report.ts`: `stoppedUnitWords` takes the unit of the step and names it "the documentation step".
- `src/checkpoint/fix-fold.ts`: the reducer `documentationPlanned`, which refuses a plan while the run budget leaves a unit of the fixes not attempted. `fixRecorded` marks no answer of a person in the new phase. `unitUnattempted` takes version 2. `pinFix` keeps `documentation` skipped in a run with no step. `fixReopened` takes version 2. In a run with the step, it makes the phase `pending` when it makes `fixes` `pending` or lists the unit of the step.
- `review.configured@7` in `src/review/controller.ts`. Each writer of the ten kinds writes the new version only for an event of the `documentation` phase or its unit (`grep -rn "kind: '<kind>'" src/`). The comments beside the versions of `worktree.checked` and `attempt.failed` name the new case.
- Each exhaustive switch that the compiler names for the new phase gets its case. The case is the final one where it is one line, as in `degradationOf`, `attemptOwner` and `fixerTitle`. `unitsOf` gives no unit of the new phase until step 6 plans one, and `taskFor` refuses the phase until step 4.
- `scripts/golden-checkpoint.ts`: a run configured at version 7 whose fixes report a `drift` line, with the plan of the step, its answer and a revision.
- `test/fixtures/checkpoints/schema-1-15`: new, from `npm run golden`.

Tests:

- `test/review/vocabulary.test.ts`: the lists of the phases, of the fix pass, of `editingPhases` and of the phases that the run budget degrades.
- `test/review/report.test.ts`: the line of the run budget names the documentation step when the budget stopped it alone.
- `test/checkpoint/events-vocabulary.test.ts`: `reviewVocabularyV8` equals the vocabulary of today. Each of the ten kinds refuses `documentation` at its old version and takes it at its new one.
- `test/checkpoint/review-fold.test.ts`: a fix run at version 7 has the phase `pending`, and a read-only run skips it as a run without the fix pass. Version 6 skips it as a run configured before the step. A continuation keeps it skipped at version 6 and makes it `pending` at version 7. The phase starts only after `fixes`, and `checks` only after it.
- `test/checkpoint/fix-fold.test.ts`: `documentation.planned` folds, and the fold refuses its nine cases of the design. `fix.recorded@3` of the step refuses ids other than the items, and it marks no answer of a person. `unit.unattempted@2` settles the unit. `fix.reopened@2` reopens the phase with the fixes, and when it lists the unit of the step.
- `test/checkpoint/fix-state.test.ts`: `documentationItemsOf` groups by the resolved path, and the lines with no resolved path by their folded path. It keeps the path of the first line, numbers the items in order and puts `search` last. `ownedFiles` and `unitIdsOf` of the step. The repair owns the paths of the step, and a revision of the step makes a run of `checks` old.
- `test/checkpoint/golden.test.ts`: `schema-1-15`, and each older fixture opens and folds.
- `test/review/fix-pass.test.ts`: a fix run configured at version 6 and resumed by this engine holds no event of a new version.

```sh
npm run golden -- --output test/fixtures/checkpoints/schema-1-15
npm run check
npm run test:contract
git commit -m "feat(checkpoint): Add the documentation phase to the ledger and the fold"
```

## 3. The role and its policy (PD8)

Files:

- `src/review/vocabulary.ts`: `reviewRoles` gets `documentation` after `fixer`.
- `roles/policy.json`: the entry of the role, with the values of `fixer`.
- `src/review/schemas.ts`: `outputSchemaOf('documentation')` is `fixerOutputSchema`.

Tests:

- `test/review/vocabulary.test.ts`: `reviewRoles`, and the roles that are not finders.
- `test/review/policy.test.ts`: the policy names the role. It still refuses `test-assessment`, which the review does not run.
- `test/review/schemas.test.ts`: the schema of the role.

```sh
npm run check
git commit -m "feat(review): Give the documentation role the policy of a fixer"
```

## 4. The task of the step (R2, R3, R4, R5)

Files:

- `src/review/tasks.ts`: `documentationTask`, with the parts of the table "The task of the step" of the design. `answerFields`, `snapshotBlock` and `earlierWork` take the word `item`. `repairTask` asks for `deferred` in place of `blocked` for a check that needs a file outside the repository.
- `src/review/phases.ts`: `taskFor('documentation')` builds the input from the fold and the plan. The input holds the items, what each fixer did with the decisions and the answers, and the paths of the patches. It renders each patch with `patchSeries` and finds its path in the evidence store by its content. The input also holds the owned files, the patterns of `scope.exclude`, the checks and the snapshot command.

Tests:

- `test/review/tasks.test.ts`: the task of two documents and `search`, and of `search` alone for a run with no `drift`. The words of an ask with its option in place, and with an answer of the person. The rules with the patterns of `scope.exclude`, and the statuses with no `blocked`. First, a test that the task of the repair asks for no `blocked` answer, which fails before the change.
- `test/review/phases.test.ts`: `taskFor` of the step from a fold with a plan. The task names the path of each patch of the fixes, from an evidence store that holds them.

```sh
npm run check
git commit -m "feat(review): Write the task of the documentation step"
```

## 5. The prompts (R3, R4, R6; TD10)

The move comes first:

- `roles/fragments/documentation-reconciliation.md`, new: the last paragraph of `fixer-documentation.md`, as it is.
- `roles/fragments/fixer-documentation.md`: the same file without that paragraph.
- `roles/manifest.json`: the new fragment follows `fixer-documentation.md` in the `fixer` role and ends the `documentation` role, so each assembled prompt keeps its bytes.
- `test/roles/repository.test.ts`: each assembled prompt keeps its bytes. The row of `carried` for "documentation reconciliation mode" of `postreview-fix-test.md` names the new fragment. The test of the end of the documentation role reads the new fragment.

```sh
npm run check
git commit -m "refactor(roles): Move the reconciliation rules into their own fragment"
```

Then the rule of the fixer (R6):

- `roles/fragments/fixer-documentation.md`, `fixer-apply.md`, `fixer-role.md`, `fixer-brief.md` and `fixer-report.md`: the rows of the table "The prompts" of the design.
- `roles/manifest.json`: the `fixer` role drops `documentation-reconciliation.md`.
- `src/review/tasks.ts`: the claim block and the part on ownership of `fixerTask` name the exception for a stale document.
- `test/roles/repository.test.ts`: the prompt of the `fixer` role holds the rule, and each of its sentences on a blocked finding names the exception.
- `test/review/tasks.test.ts`: the claim block and the part on ownership name the exception.

```sh
npm run check
git commit -m "feat(roles): Have a fixer update the documentation its edit makes stale"
```

Then the prompt of the step (PD8):

- `roles/fragments/documentation-role.md`, new.
- `roles/fragments/documentation-reconciliation.md`: the rules of R3 and R4.
- `roles/manifest.json`: the `documentation` role as the design says.
- `test/roles/repository.test.ts`: the prompt of the role starts with its own fragment and holds no claim rule. It holds the rules of the convention sources, the quick checks, a generator, a historical record and a defer. The tests of the fixer roles change with it. The row of `carried` for the test rules of `postreview-fix-test.md` names only the `fixer` role: that sentence speaks of the fixer, and the step edits no test. The test of the defers holds as it is, because the new fragment carries the defer sentence of `fixer-apply.md` word for word.

```sh
npm run check
git commit -m "feat(roles): Give the documentation step its own prompt"
```

## 6. The step in the run (R1, R2, R5, R8, R9)

Files:

- `src/review/steps.ts`: the step `plan-documentation`. `unitsOf` gives the unit once the plan is recorded. `dueCheck('checks')` reads the revisions of the step too.
- `src/review/documents.ts`, new: `planPathOf`, the resolver of the plan.
- `src/review/controller.ts`: the step `plan-documentation` computes the items with `planPathOf` and appends `documentation.planned@1`. Before the launch of the step, the patch of each revision of the fixes goes to the evidence store, rendered by `patchSeries`. The warning for the unelevated sandbox names the step.
- `src/review/commit.ts`: `namedFindings` for the revisions of the step.
- `test/helpers/fake-runtime.ts` and `test/helpers/fix-pass-fixture.ts`: the fakes answer the `documentation` role, and one fixer of the fixture reports a `drift` line.

Tests:

- `test/review/steps.test.ts`: the plan comes after the second round and before the checks. A run whose fixes revised nothing plans nothing and has no unit. At the run budget the unit is not attempted, and the run reaches the checks. When the run budget stopped a unit of the fixes, the phase finishes `degraded` with no plan. Two failures degrade it, and a lost worker blocks.
- `test/review/fix-pass.test.ts` and `test/review/controller.test.ts`: a fix run on the fakes runs the step, records its answer and its revision, and runs its checks after it. A resumed run plans once. Each patch of the fixes is in the evidence store before the launch, and holds the edits of its revision only.
- `test/review/documents.test.ts`, new: `planPathOf` on `./`, a backslash, another case, an absolute path inside the worktree, `../` and a path in `.git`.
- `test/review/fix-events.test.ts`: an answer of the step with two items and two snapshots. Items whose paths need the resolver, through an answer, a failed attempt and a lost worker.
- `test/review/commit.test.ts`: the trailers of the step, of a revision of two items and of an attempt, and the order of the commits.
- `test/review/fix-reopen.test.ts`: a reopen that gives back units of the fixes runs the step after them, with their lines. A reopen that gives back the unit of the step runs it with its plan.

```sh
npm run check
npm run test:contract
git commit -m "feat(review): Run the documentation step between the fixes and the checks"
```

## 7. The documents left out of date and the brief (R7)

Files:

- `src/review/documents.ts`: `leftDocumentsOf`, with the three sources and the four kinds of reasons of the design.
- `src/review/brief.ts`: `Brief.documents`, the headline, the part "Documents left out of date" and the line of the short form. Also the sentence on the step in what deep-review changed, the gap of the kind `documentation` and the gap of the budget.
- `src/review/brief-json.ts`: `briefJsonV2`, which it writes alone, and a frozen list of the kinds of gaps of `briefJsonV1`.
- `src/review/phases.ts` and `src/review/tasks.ts`: the task of an answer pass lists the documents left out of date. It asks its fixer to bring in line each one that an answer settles.
- `test/fixtures/reports/*.md`: the snapshots that hold a brief.

Tests:

- `test/review/documents.test.ts`: the five cases of R7, the groups by file and each reason. The end of an entry by a later answer pass, and no end by a pass that reports the file again or by the repair.
- `test/review/tasks.test.ts`: the task of an answer pass with documents left out of date, and with none.
- `test/review/brief.test.ts`: the headline with documents and with none, and the part. Also the eight lines of the short form of a fix run and its limit of names, the sentence on the step and the gaps. A run that only reviews keeps its sentence and its seven lines. A run configured at version 6 counts its `drift` lines.
- `test/review/brief-json.test.ts`: version 2, and version 1 with its frozen kinds of gaps.
- `test/cli.test.ts`: `report --json` gives version 2. The short form of a run that only reviews keeps its seven lines and their names.

```sh
npm run check
git commit -m "feat(review): Count the documents a run leaves out of date in the brief"
```

## 8. The report (R10)

Files:

- `src/review/fix-report.ts`: `## Documentation`, and `answerLines` without the `drift` lines.
- `src/review/report.ts`: the new section in the order of the evidence.
- `test/fixtures/reports/fix.md`: the new snapshot.

Tests:

- `test/review/fix-report.test.ts` and `test/review/report.test.ts`: the section with each status, the lines of the own `drift` of the step, and the lines that no item holds.

The author reads the new snapshot in the review of the pull request.

```sh
npm run check
git commit -m "feat(report): Show the documentation step in the evidence"
```

## 9. The contract of resumable runs (R12)

Files:

- `test/review/resumable-runs.contract.ts`: the points `child documentation documentation:documentation#1` and `worker.finished documentation documentation:documentation`.
- `test/helpers/resume-marks.ts`: no mark for the new points.

```sh
npm run test:contract
npm run resume-test
git commit -m "test(review): Stop the engine in the documentation step"
```

## 10. The README, the comments and the skills

- `README.md`: the section on the fix pass, as the design says. Also the count of the roles of a review, the parts of the brief, and the lines of the short form.
- The comments that name the five phases of the fix pass, or that point to issue #29 for the `drift` lines.
- `skill/claude/skills/deep-review/SKILL.md` and `skill/codex/SKILL.md`: only a sentence that names the phases of the fix pass, if one does.

```sh
npm run check
git commit -m "docs(readme): Describe the documentation step"
```

## 11. The self-review and the build

- A review of the whole diff against the proposal and against the checklist of the self-review. Each finding gets a test that fails first, then its fix.
- An independent review by a fresh agent, which reads the proposal, this plan and the diff. Its findings get the same treatment, with one commit for each finding of high or medium weight.
- If `main` moved, a rebase onto it. A conflict in `dist/` resolves by `npm run build`, never by a pick of one side.
- `npm run build`, then `npm run check`, `npm run verify`, `npm run test:contract` and `npm run resume-test`.

```sh
git commit -m "chore(dist): Rebuild the engine with the documentation step"
```

- Push, and CI runs on the three systems.

## 12. The gate (R13)

Each paid run waits for the word of the author.

- The engine of the gate is a copy of `dist/claude` at the head, and of `dist/codex` for the run on Codex. It runs from outside the worktree of the gate, because the build check rewrites `dist/`.
- On this pull request: `review --runtime claude --branch --fix`, with the settings of the repository.
- On pallets/click #3878, at the commit and the base of the runs of the report on what a person gets from a run: one fix run on Claude Code and one on Codex, each in its own clone.
- The author reads each brief, the commits of the step and the documents that the fixers named.
- On the run on this pull request: `deep-review commit`, then typecheck and lint at each of its commits, and an audit of the ledger.
- The fixes of the gate go in a pull request stacked on this one, which merges into this branch by a fast-forward.

## 13. The verification, and this plan out

- The section Verification of the design gets the implementation, the gate and the metrics of the requirements.
- This plan goes out in the same commit.

```sh
git rm docs/changes/2026-10-23-documentation-step.plan.md
git commit -m "docs(changes): Record the verification of the documentation step"
```

## 14. The pull request ready

- `npm run check` and `npm run verify` at the head, and CI on the three systems.
- The title and the body of the pull request describe the work as done. Motivation stays. Modifications names the change of the JSON form that a program must follow. Result shows the brief of a gate run with its documents.
- The pull request leaves the draft state, and the author reviews it. The merge waits for the word of the author: `main` then moves to the tested head by a fast-forward push.
