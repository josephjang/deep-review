# Implementation plan: resumable runs

This is the plan of the work for the [requirements](2026-10-18-resumable-runs.requirements.md) and the [design](2026-10-18-resumable-runs.design.md). It stays in the pull request while the work continues, and the commit that records the verification deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the commands that prove it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit, and `npm run verify` passes at each head that is pushed, as `AGENTS.md` says. A step that closes a point of the contract test removes the mark of that point in the same commit.

The proposal can change during the work. If the code needs a different design, a commit of its own amends the proposal before the code commit. Thus the pull request shows each change of the proposal beside the code that needed it, with one commit for each finding.

The work is done on Windows, so the paths of POSIX run only in CI. Thus the pull request opens as a draft after step 1, and CI runs on Linux, macOS and Windows from then on. The branch goes to origin only on the author's word.

## 0. The branch and this plan

- The branch is `feat/resumable-runs`. It holds the proposal, this plan and the implementation. Its name was set before the first push, because a rename of a pushed branch closes its pull request.
- `npm ci`, when the worktree has no `node_modules` or an old one.

```sh
git add docs/changes/2026-10-18-resumable-runs.plan.md
git commit -m "chore(changes): Add the working plan for resumable runs, for now"
```

## 1. The contract test on the engine as it is (R1, R2)

### 1a. Two cases that the condition of PD1 needs

The condition of PD1 keeps a requirement for a way that no run showed only when the contract test shows that way. Two ways cannot show in the test that the design gives. A fake that outlives the engine and writes nothing changes nothing that the four parts check (W2 and W3, for R8). And no person edits the tree in the test (W8, for R10). Thus one commit amends the design before the code:

- A fifth part of the check: no process that the stopped engine started is alive a short time after the stop. The fakes write their pids, as they do for the fourth way.
- At one point while a fixer runs, the helper edits another file of the change, as a person does. It does this after the stop and before the next command.
- The text goes into R2 of the requirements, and into The contract test and the Test Strategy of the design. The STE checker passes on both files.

```sh
git commit -m "docs(changes): Let the stop test show orphans and a person's edit"
```

### 1b. The test

- `test/helpers/stop-preload.ts`, new: the preload of TD1. It wraps `Checkpoint.prototype.append` and counts the appends of the command. After the append that `RESUME_STOP_AT` names, it writes a marker file and acts as `RESUME_STOP_WAY` names. The way `signal` emits SIGINT in the process, so the path of `releaseOnExit` runs. The other ways block the event loop with `Atomics.wait`, so that the helper kills the engine at that point. The preload also wraps the synchronous git call, so that a test can stop `commit` right after `update-ref`.
- `test/helpers/resume-contract.ts`, new: the helper of the design. It makes the repository and the roles directory as `ReviewSandbox` does, and it scripts the fakes. It starts `src/cli.ts review --fix` in a child process with `--executable`, `--executable-arg`, `--roles`, a scope flag and the checks. On POSIX the engine starts detached, so that a kill of the tree reaches its process group.
- The helper stops the engine in the four ways. Then it starts the same command again with no preload, until the report or a block. For the points of `commit`, the second command is `src/cli.ts commit`. Last, it checks the five parts against a run with no stop, after the normalization of the reports.
- The fourth way: the helper ends the pid in the start marker with a kill mark, SIGTERM on POSIX and the `kill` of Git for Windows on Windows. It finds `kill.exe` from `git --exec-path`. 100 milliseconds later, it kills the engine alone.
- `test/helpers/fake-check.mjs` and `test/helpers/fake-runtime.ts`: each fake writes its pid to a start marker in the directory that `FAKE_START_DIR` names. A new rule of the check rewrites a file of the run before the marker, as a formatter does. The script of the fakes lets the first attempt of one unit fail.
- `test/review/resume-contract.test.ts`, new: the fixed set of points of the design, in each way that applies to the point. Each point passes, or it has a mark of a known failure. A mark names the part that fails and the requirement that closes it. A marked point asserts that its part fails, so a point that starts to pass fails the test until a step removes its mark.
- `scripts/resume-test.ts`, new, and the script `resume-test` in `package.json`: each append of the run in the first three ways, and each child in the fourth way. It prints a table of the results, and it exits with 1 on a result that the marks do not expect.
- The time (Open Questions): measure the suite before and after this step, in alternate runs on one machine, and measure the script. If the fixed set makes the suite much longer, the suite keeps fewer points and the script keeps the rest. A commit amends the design first.
- The time of the fourth way: a point of the fourth way can give different results from one run to the next under the load of the suite. Then the helper waits for the end of the child on the ledger, not for 100 milliseconds, and a commit amends the design first.

```sh
node --import ./test/setup.ts --test test/review/resume-contract.test.ts
npm run resume-test
npm run check
git commit -m "test(review): Check a resumed run against the contract at each point"
```

### 1c. The ways that the test does not show (PD1)

- Compare the marks with the ways of the requirements under the condition: R4 for units and R5 (W1), R6 (W5), the write back of R7 (W4), R8 (W2 and W3), R9 (W6) and R10 (W8).
- For each way that no point shows, one commit amends the proposal. It removes the requirement with its mechanism, its tests and its row in the steps, and it records the result in PD1. The later steps of this plan then leave out that work.
- Keep the list of the ways that the test showed, for the Verification of step 12.

### 1d. The draft pull request

- On the author's word, push the branch and open the pull request as a draft. CI must pass on Linux, macOS and Windows, with the marks of the known failures.
- The body has the parts Motivation, Modifications and Result, for a reader who does not know the repository. Its lines are not wrapped, it names no local path, and it says that the work continues. A figure of the proposal goes into it only after a render check.

```sh
git push -u origin feat/resumable-runs
gh pr create --draft --title "feat(review): Resume a stopped run with no hand" --body-file <body file>
gh pr checks --watch
```

## 2. The ledger (R16)

One commit adds each new kind and version, with its reducer and the new fixture (Golden fixture, in the design).

- `src/checkpoint/events.ts`: `check.started@1`, `check.ran@3` with the field `replaces` and the outcome `cut`, and `tree.restored@1`. Also `attempt.failed@7` with the fault `environment` in each phase and the fault `cut`, `fix.reopened@1`, `commits.prepared@1` and `commits.dropped@1`. Each goes into the registry.
- `src/review/vocabulary.ts`: the outcome `cut` goes into a list of its own for `check.ran@3`. The schemas of versions 1 and 2 keep the list of today, so an older version accepts nothing new (TD2). The faults of `attempt.failed@7` are a new list in the same way.
- `src/checkpoint/fix-fold.ts`: the reducers of `check.started@1`, `check.ran@3` with its three rules, `tree.restored@1`, `fix.reopened@1`, `commits.prepared@1` and `commits.dropped@1`. The fold keeps the order of each run and each revision (TD3), the last finished attempt of each checks phase, and an open series.
- `src/checkpoint/review-fold.ts`: the reducer of `attempt.failed@7`.
- `src/checkpoint/fold.ts`: the table of the reducers.
- `scripts/golden-checkpoint.ts`: one more run that writes each new record.
- `test/fixtures/checkpoints/schema-1-13`, new, from the script.
- `test/checkpoint/fix-fold.test.ts`, `test/checkpoint/review-fold.test.ts` and `test/checkpoint/events-vocabulary.test.ts`: each new version folds, and each refusal of its reducer holds. A fold on a model without these entries gives the run as unreadable, and `listRuns` passes over it.
- `test/checkpoint/golden.test.ts` does not change. It folds each fixture, and `schema-1-13` is one of them.

```sh
npm run golden -- --output test/fixtures/checkpoints/schema-1-13
npm run check
git commit -m "feat(checkpoint): Add the records that make a stopped run resumable"
```

## 3. Checks after a stop (R3, R7, TD3, TD7, TD11)

- `src/checkpoint/fix-state.ts`: `lastRun` gives the last current run, which no revision of a worker follows. `failedAtBaseline` and `repairTargets` read it.
- `src/review/steps.ts`: `dueCheck` returns a kind with no current run, and a kind whose last current run did not pass in a cut attempt. It also returns a kind whose last current run is its first timeout in the attempt (R7). The new step `restore-tree` comes in place of the block, for a drift that a cut check explains. It also comes after a timeout, when an expected file differs. `repair-checks` runs only after a revision of the repair (TD11).
- `src/review/controller.ts`: `runDueCheck` appends `check.started@1` before the check, and `check.ran@3` with `replaces` after it. It records no revision for a run that timed out, and it logs a rerun. The step `restore-tree` freezes each drifted file as evidence and appends `tree.restored@1`. Then it writes the expected bytes and checks the tree again.
- `src/review/drift.ts` and `src/review/tree.ts`: the drifted files of the run for that step, and the write of the expected bytes.
- `src/review/fix-report.ts`: the own `failedAtBaseline` of the Checks table goes. The table reads the last current run, and it keeps its mark for `not-started`. A column of old runs gets "(an earlier tree)", and the notes read the current runs.
- `src/review/phases.ts` and `src/review/status.ts`: the task of a fixer and `status` read the last current run.
- Tests: `test/review/fix-steps.test.ts` and `test/checkpoint/fix-state.test.ts`, for the cases of R3 and R7 in the Test Strategy. `test/review/fix-report.test.ts` and `test/review/status.test.ts`, for the table and its notes. `test/review/fix-pass.test.ts`, for whole runs: a cut check with a write back, a check that times out and runs again, and a repair that reads the tree of the fixes.
- `test/review/resume-contract.test.ts`: remove the marks that this step closes.

```sh
npm run check
git commit -m "feat(review): Run a cut check again after a write back"
```

## 4. Failures and attempts after a stop (R4, R5, R6)

### 4a. The outcome `cut`

- `src/runtime/process.ts`: `endedByKill`, with the list of the kill marks.
- `src/review/checks/run.ts`: `checkOutcomeOf` gives `cut`.
- `src/review/controller.ts`: `runDueCheck` records a second cut of a kind in one attempt as `failed`, with both marks. It records no revision for a cut run, and the write back of step 3 comes before the rerun.
- `src/runtime/launcher.ts`: `workerVerdict` reads the mark, and the receipt gets the cause `cut`.
- `src/review/phases.ts`: `contributionOf` records `attempt.failed@7` with the fault `cut`.
- `src/review/steps.ts`: `interrupted` counts the fault `cut`, so `exhaustedOutcome` blocks such a unit and never degrades it.
- Tests: `test/review/checks/run.test.ts`, for each mark, for real kills with SIGTERM and SIGINT on POSIX, and for the `kill` of Git for Windows and `taskkill` on Windows. `test/review/fix-steps.test.ts`, `test/runtime/launcher.test.ts` and `test/review/steps.test.ts`, for the other cases of R4.

```sh
npm run check
git commit -m "feat(review): Count a child that a kill ended as cut, not failed"
```

### 4b. Fresh attempts after a stop

- `src/checkpoint/review-fold.ts`: `phaseStarted` gives fresh attempts when the phase was `running`, as it does when the phase was `blocked`.
- `test/checkpoint/review-fold.test.ts`: the units that did not settle have no failures, and the answers and the degradations stay.

```sh
npm run check
git commit -m "feat(checkpoint): Give a unit its attempts again after a stop"
```

### 4c. One append for the end of a worker

- `src/runtime/launcher.ts`: the launcher no longer appends `worker.finished`. It returns the payload with the receipt, and it exports the one function that appends a finish alone.
- `src/review/controller.ts`: `record` appends the finish and the contribution in one append. When the contribution cannot be built, it appends the finish alone and throws.
- The other users of the launcher call the exported function: `src/review/phases.ts`, `src/review/fix-events.ts`, `src/replay/run.ts` and `src/replay/prompt.ts`. A search confirms the list first.
- Tests: `test/review/controller.test.ts` and `test/runtime/launcher.test.ts`.
- `test/review/resume-contract.test.ts`: remove the marks that step 4 closes.

```sh
npm run check
git commit -m "feat(review): Record the end of a worker with its answer in one append"
```

## 5. The guard (R8)

- `src/runtime/guard.ts`, new: the guard of the design. It reads the request file, starts the child and waits for it. When its standard input closes first, it kills the tree of the child with `killTreeNow` and exits. When the child ends, it writes the result file and exits with the code of the child.
- `src/cli.ts`: the subcommand `guard`, which only the engine starts.
- `src/runtime/process.ts`: `runProcess` starts each worker and each check through `node <engine entry> guard`. The guard is detached on Windows, and on POSIX it leads the process group of its child. The engine reads the end from the result file, and a guard with no result file gives a mark (R4). The timeout kills the tree of the guard.
- The entry of the engine: the callers of `runProcess` give it, as the commands of snapshots and claims get `ReviewOptions.engineEntry`.
- Tests: `test/runtime/process.test.ts` and `test/helpers/process-engine.ts`. A hard kill of the engine alone ends the worker and its grandchild on each system. A kill of the guard alone leaves no result file, and the check is cut. The cases of today stay: a timeout, a crash, an exit and the signals.
- `test/review/resume-contract.test.ts`: remove the marks that this step closes.

```sh
npm run check
git commit -m "feat(runtime): End each child with the engine through a guard"
```

## 6. Commits and lost attempts (R9, R10)

### 6a. A prepared series

- `src/review/commit.ts`: `commit` appends `commits.prepared@1` before `update-ref`.
- `src/checkpoint/fix-state.ts`: `runHead` does not move for an open series.
- `src/review/commit.ts` and `src/review/answer.ts`: a command that reads `runHead` settles an open series first. It completes the series, drops it, or refuses and names both heads. The reopen of step 7 does the same.
- Tests: `test/review/commit.test.ts`, for the three cases of R9, and `test/review/answer.test.ts`, for an answer after a cut `commit`.

```sh
npm run check
git commit -m "feat(review): Record a series of commits before the branch moves"
```

### 6b. A lost attempt

- `src/review/fix-events.ts`: `attemptRevisionEvents` takes the paths that the snapshots name, the owned files and the claimed files. It no longer takes `changedPaths`.
- `test/review/fix-events.test.ts`: the edit of a person stays out of the revision, and the next check of the tree finds it as a drift.
- `test/review/resume-contract.test.ts`: remove the marks that step 6 closes.

```sh
npm run check
git commit -m "fix(review): Record only its own files for a lost attempt"
```

## 7. The reopened fix pass (R11, R12, R13)

### 7a. Find the run and reopen it

- `src/cli.ts`: the scope source of `review` gives the named mode and request before the check of the tree in `scopeRequestOf` (TD9).
- `src/review/controller.ts`: `openRun` finds a complete fix run with a unit not attempted because of the budget, newest first, by the mode and the request. `findDrift` then chooses the reopen or a new run with its log line. Under the start lock and the run lock, `openRun` checks the runtime, the spend, the roles digest and the executable. It refuses a budget not above the spend, with exit code 2 and the message of the design. It appends `fix.reopened@1` and `limits.changed@1` in one append (TD8), after it settles an open series (step 6).
- Tests: `test/review/fix-reopen.test.ts`, new, and `test/cli.test.ts`, for the cases of the first two paragraphs of R11 to R13 in the Test Strategy. The same command with the same budget refuses, and it appends nothing.

```sh
npm run check
git commit -m "feat(review): Reopen a fix pass that the run budget stopped"
```

### 7b. The work of a reopened run

- `src/checkpoint/fix-state.ts`: a checks phase that runs each kind again moves its floor to its attempt at the last `fix.reopened`.
- `src/review/steps.ts`: `launchableUnit` lets a reopened unit launch. The second round is planned only when each batch of the first round settled, and none is not attempted because of the budget (PD13).
- `src/review/controller.ts`: at the end of a run that the budget stopped, the log names the command that continues it.
- Tests: `test/review/fix-reopen.test.ts`, for a second reopen, a committed run, the shape of run `0d63437e` and the two answer passes. An answer that an answer pass applied before the reopen reaches the fixer, which answers `already-applied` and keeps it. `test/review/fix-steps.test.ts`, for the second round.

```sh
npm run check
git commit -m "feat(review): Finish the rest of the fix pass in a reopened run"
```

### 7c. The report and status of a reopened run

- `src/review/fix-report.ts`: the header line `Reopened:` with the count, the phase of each revision after a committed series, and `committedWords`. Also the fate of a finding with no second round, and the budget line with its command.
- `src/review/status.ts`: the command that continues a run that the budget stopped.
- Tests: `test/review/fix-report.test.ts` and `test/review/status.test.ts`.
- `test/review/resume-contract.test.ts`: remove the marks that step 7 closes.

```sh
npm run check
git commit -m "feat(review): Report a reopened fix pass and how to continue one"
```

## 8. The usage limit (R14)

- `src/runtime/claude-limits.ts`, new: the words of a usage limit and of a session limit, in one list.
- `src/runtime/adapter.ts`: `DecodedResult` gets the kind `limit`.
- `src/runtime/claude.ts`: `decodeClaude` returns the kind `limit`, with the text and the reset.
- `src/runtime/launcher.ts`: the receipt gets the cause `limit`.
- `src/review/phases.ts`: `contributionOf` records `attempt.failed@7` with the fault `environment`, and it keeps the edits of a failed fixer.
- `src/review/steps.ts`: the phase blocks at the first such failure, after the workers in flight end. The blocker `worker-failed` names the limit and the reset.
- Tests: `test/runtime/claude.test.ts`, with the text of run `e21b026d`. A run on the fakes in `test/review/fix-pass.test.ts`, and `test/review/steps.test.ts`.

```sh
npm run check
git commit -m "feat(runtime): Block a run at a usage limit of Claude Code"
```

## 9. The record, the skills, the README and the comments (R15, R17)

- `src/review/fix-report.ts` and `src/review/status.ts`: the lines of the table of R15, and an open or a dropped series. Tests: `test/review/fix-report.test.ts` and `test/review/status.test.ts`.
- `skill/claude/skills/deep-review/SKILL.md`: two sentences in step 3, and one in step 4. The bytes of a skill are the product, so each new sentence goes in one time, and the other text keeps its lines. `skill/codex/SKILL.md` does not change. `test/skills.test.ts`: the new lines are lines of the Claude Code skill only.
- `README.md`: a section with the contract of R1, the budget case for a runtime that reports cost, and the limit of Claude Code.
- The comments that the change makes false (Steps of the work, in the design): `checkOutcomeOf` in `run.ts`, the decoder in `claude.ts`, and `contributionOf` in `phases.ts`. Also the comments on the reducers that move phases, in `review-fold.ts`, `fix-fold.ts` and `answer-fold.ts`, and `whyNotCommittable` in `commit.ts`.
- A commit that changes what a skill says is apart from a commit that moves text (`AGENTS.md`).

```sh
npm run check
git commit -m "feat(review): Say what a stop did in the report and status"
git commit -m "docs(skill): Tell the model how a stopped fix pass continues"
git commit -m "docs(readme): Describe what resumes after a stop"
git commit -m "docs(review): Correct the comments that the stop work made false"
```

## 10. The self-review and the build

- Read each hunk and its function, as the global rules ask. For each deleted line, name where the new code keeps its rule. One example is the mark for `not-started` of the old `failedAtBaseline` of the table. Others are the second append of `worker.finished`, for each user of the launcher, and `changedPaths` in `attemptRevisionEvents`.
- Search for each caller of `lastRun`, `failedAtBaseline`, `repairTargets`, `dueCheck`, `checkOutcomeOf`, `workerVerdict`, `runProcess`, `attemptRevisionEvents`, `runHead`, `openRun` and `scopeRequestOf`. Search also for each reader of `check.ran`, `attempt.failed`, `worker.finished` and `commits.created`.
- Compare this plan with the branch: each file, each test, each command and each mark.
- Run the STE checker on each changed document.

```sh
npm run resume-test
npm run build
npm run verify
git commit -m "chore(dist): Rebuild the engine for resumable runs"
```

## 11. The gate (R18)

- The engine is a copy of `dist/claude` of the head, outside the worktree, because the build check rewrites `dist/` in the worktree.
- A separate worktree at the head, with `npm ci`, on a local branch for the gate.
- The first run: `node <engine copy>/engine/main.mjs review --runtime claude --branch --fix`. While the baseline test runs, a script ends the check with the `kill` of Git for Windows, and the engine 0.3 seconds later. Then the same command resumes the run. One more stop uses the command of Claude Code that stops a background command, and the gate records its mark. A Ctrl-C by hand records the mark of Ctrl-C, and it shows that under the guard a Ctrl-C reaches the engine alone.
- The second run: a hard kill of the engine alone while fixers run. The processes of the fixers end at once, as a list of the processes shows.
- The third run: a budget that the fixes reach stops the fix pass, and the same command with `--budget-usd 120` continues it.
- After each run: `deep-review commit`, then `npm run check` and `npm run verify` at the head. Typecheck and lint run at each commit alone, and the audit of the claims runs on a copy of the ledger.
- The commits of the gate go into a stacked pull request onto this branch, which merges into it by fast-forward after CI.
- On the same commit, `npm run resume-test` runs, with the golden command.

## 12. The verification, and this plan out

- The Verification section of the design records the commits, `npm run check`, `npm run verify`, CI, `npm run resume-test` with its time, and the ways that the test showed (step 1c). It also records the three runs, with their spend, their findings and their marks.
- The Metrics of the requirements record three measurements. The first is the points that break the contract, before and after. The second is the cost that a continuation pays for the phases before the fixes. The third is the outcome of the killed check beside its rerun.
- The same commit deletes this plan, and the pull request leaves the draft state.

```sh
git rm docs/changes/2026-10-18-resumable-runs.plan.md
git commit -m "docs(changes): Record the verification of resumable runs"
npm run check
npm run verify
git push
gh pr ready
```

## 13. The merge

- On the author's word, `main` moves to the head of the branch by a fast-forward push, never by the rebase button. Thus the hashes that the Verification cites stay.
- The checkout that the plugin marketplace reads pulls `main`. Then the installed plugin updates, and `dist/codex` replaces the Codex skill.
- #25, #48 and #40 close, each with a comment that names the merge.

```sh
git push origin feat/resumable-runs:main
claude plugin marketplace update deep-review
claude plugin update deep-review@deep-review
```
