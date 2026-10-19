# Implementation plan: resumable runs

This is the plan of the work for the [requirements](2026-10-18-resumable-runs.requirements.md) and the [design](2026-10-18-resumable-runs.design.md). It stays in the pull request while the work continues, and the commit that records the verification deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the commands that prove it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit. A step that closes a point of the contract test removes the mark of that point in the same commit.

`npm run verify` passes at each head that is pushed, as `AGENTS.md` says. CI runs it too. Thus each batch of commits that goes to origin ends with `npm run build`, and with a `chore(dist)` commit when `dist/` changed.

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

### 1a. The cases that the condition of PD1 needs (done)

The review of the proposal amended the design of the test before the work. A stop while a child runs is a point of its own kind, in each of the four ways (`552b581`). The test also checks R8 in a fifth part, and a file changes while the engine is down, as a person changes it (`3f29b69`).

### 1b. The test

- `test/helpers/stop-preload.ts`, new: the preload of TD1. It wraps `Checkpoint.prototype.append`. After the append that `RESUME_STOP_AT` names by its event kind and its unit, it writes a marker file and acts as `RESUME_STOP_WAY` names. The way `signal` emits SIGINT in the process, so the path of `releaseOnExit` runs. The other ways block the event loop with `Atomics.wait`, so that the helper kills the engine at that point.
- The preload also serves two other points. For the handled signal at a point while a child runs, it watches for the start marker of the fake. To stop `commit` right after `update-ref`, it wraps `execFileSync` of `node:child_process` and calls `syncBuiltinESMExports`.
- `test/helpers/resume-contract.ts`, new: the helper of the design. It makes the repository and the roles directory as `ReviewSandbox` does, and it scripts the fakes. It starts `src/cli.ts review --fix` in a child process with `--executable`, `--executable-arg`, `--roles`, a scope flag and the checks. On POSIX the engine starts detached, so that a kill of the tree reaches its process group.
- The helper stops the engine in the four ways, at an append or when a start marker appears. After the stop, it checks the fifth part, ends each process that outlived the engine, and writes the release file. At one point while a fixer runs, it edits another file of the change, as a person does. Then it starts the same command again with no preload, until the report or a block.
- For the points of `commit`, the second command is `src/cli.ts commit`. Last, the helper checks the other four parts against a run with no stop. The report comparison leaves out what a resume changes by its nature, as the design lists it.
- The fourth way: the helper ends the pid in the start marker with a kill mark, SIGTERM on POSIX and the `kill` of Git for Windows on Windows. It finds `kill.exe` from `git --exec-path`. 100 milliseconds later, it kills the engine alone.
- `test/helpers/fake-check.mjs` and `test/helpers/fake-runtime.ts`: each fake writes its pid to a start marker in the directory that `FAKE_START_DIR` names. Then it starts a grandchild and waits for the release file. A new rule of the check rewrites a file of the run before the marker, as a formatter does. The script of the fakes lets the first attempt of one unit fail.
- `test/review/resume-contract.test.ts`, new: the fixed set of points of the design, in each way that applies to the point. The point after the record of the report is not in the set. Each point passes, or it has a mark of a known failure for each system that shows it.
- A mark names the part that fails and the requirement that closes it. A marked point asserts that its part fails, so a point that starts to pass fails the test until a step removes its mark.
- `scripts/resume-test.ts`, new, and the script `resume-test` in `package.json`: each append of the run in the first three ways, and each child in each of the four ways. It prints a table of the results, and it exits with 1 on a result that the marks do not expect.
- The time (Open Questions): measure the suite before and after this step, in alternate runs on one machine, and measure the script. If the fixed set makes the suite much longer, the suite keeps fewer points and the script keeps the rest. A commit amends the design first.
- The time of the fourth way: a point of the fourth way can give different results from one run to the next under the load of the suite. Then the helper waits for the end of the child on the ledger, not for 100 milliseconds, and a commit amends the design first.

```sh
node --import ./test/setup.ts --test test/review/resume-contract.test.ts
npm run resume-test
npm run check
git commit -m "test(review): Check a resumed run against the contract at each point"
```

### 1c. The ways that the test does not show (PD1)

- Compare the marks with the ways of the requirements under the condition. These are R4 for units and R5 (W1), R6 (W5), R8 (W2 and W3), R9 (W6) and R10 (W8). In R7, they are the record of the start of each check, and the write back at the next command (W4). Both serve a check with no end.
- For each way that no point shows, one commit amends the proposal. It removes the requirement with its mechanism, its tests and its row in the steps, and it records the result in PD1. The later steps of this plan then leave out that work.
- Keep the list of the ways that the test showed, for the Verification of step 12.

### 1d. The draft pull request

- On the author's word, run `npm run build`, and commit `dist/` if it changed. Then push the branch and open the pull request as a draft. CI must pass on Linux, macOS and Windows, with the marks of the known failures.
- The body has the parts Motivation, Modifications and Result, for a reader who does not know the repository. Its lines are not wrapped, it names no local path, and it says that the work continues. A figure of the proposal goes into it only after a render check.

```sh
npm run build
git push -u origin feat/resumable-runs
gh pr create --draft --title "feat(review): Resume a stopped run with no hand" --body-file <body file>
gh pr checks --watch
```

## 2. The ledger and fresh attempts (R5, R16)

One commit adds each new kind and version, with its reducer and the new fixture (Golden fixture, in the design). It also changes `phaseStarted` (R5), so that the fixture pins that rule.

- `src/checkpoint/events.ts`: `check.started@1`, `check.ran@3` with the field `replaces` and the outcome `cut`, `tree.restored@1`, and `worktree.checked@6` with the moment `restored`. Also `attempt.failed@7` with the faults `cut` and `limit`, `fix.reopened@1`, `commits.prepared@1` and `commits.dropped@1`. Each goes into the registry. The fault `environment` keeps its phase.
- `src/review/vocabulary.ts`: the outcome `cut` goes into a list of its own for `check.ran@3`. The schemas of versions 1 and 2 keep the list of today, so an older version accepts nothing new (TD2). The faults of `attempt.failed@7` and the moments of `worktree.checked@6` are new lists in the same way.
- `src/checkpoint/fix-fold.ts`: the reducers of `check.started@1`, `tree.restored@1`, `fix.reopened@1`, `commits.prepared@1` and `commits.dropped@1`. Also the reducer of `check.ran@3`, with the three cases of `replaces`: a failure of a cut attempt, a cut run, and a first timeout in the current attempt. A skipped run needs no start.
- The fold keeps the order of the ledger for each run and each revision (TD3), and the last finished attempt of each checks phase. It also keeps an open series.
- `src/checkpoint/review-fold.ts`: the reducers of `attempt.failed@7` and `worktree.checked@6`. `phaseStarted` gives fresh attempts when the phase was `running`, as it does when the phase was `blocked` (R5).
- `src/checkpoint/fold.ts`: the table of the reducers.
- `scripts/golden-checkpoint.ts`: one more run that writes each new record. It also re-enters a phase that a stop cut while it ran.
- `test/fixtures/checkpoints/schema-1-13`, new, from the script. A later step that changes what the fold gives for the golden run writes it again, before the merge.
- `test/checkpoint/fix-fold.test.ts`, `test/checkpoint/review-fold.test.ts` and `test/checkpoint/events-vocabulary.test.ts`: each new version folds, and each refusal of its reducer holds. After a stop, the units that did not settle have no failures, and the answers and the degradations stay. A fold on a model without these entries gives the run as unreadable, and `listRuns` passes over it.
- `test/checkpoint/golden.test.ts` does not change. It folds each fixture, and `schema-1-13` is one of them.

```sh
npm run golden -- --output test/fixtures/checkpoints/schema-1-13
npm run check
git commit -m "feat(checkpoint): Add the records that make a stopped run resumable"
```

## 3. Checks after a stop (R3, R7, TD3, TD7, TD11)

- `src/checkpoint/fix-state.ts`: a run is old when a later revision changed the state that its phase checks, by the table of the design. `lastRun` becomes `lastFreshRun`, the last run of a phase that no later revision made old. `lastRecordedRun` gives the last run, old or not, and `lastCurrentRun` gives the last fresh run past the phase's floor. `failedAtBaseline` reads the last baseline run, which never grows old. `repairTargets` reads it and the last fresh run of `checks`.
- `src/review/steps.ts`: `dueCheck` returns a kind with no current run, and a kind whose last current run did not pass in a cut attempt. It also returns a kind whose last current run is its first timeout in the current attempt. A cut attempt comes before the current attempt.
- In the same file: the new step `restore-tree` comes in place of the block, for a drift that a check cut short in the earlier attempt explains. The drift rule reads only the checks of the tree after the last `tree.restored` of the attempt. `repair-checks` runs only after a revision of the repair (TD11).
- `src/review/controller.ts`: `runDueCheck` appends `check.started@1` before the check, and `check.ran@3` with `replaces` after it. A skipped run has no start. After a run that the engine killed at its timeout, it records no revision, and it compares the files that the run expects.
- In the same step, it appends `tree.restored@1` with `check.ran@3`, empty when nothing differs. Then it writes the expected bytes and records the check of the tree as `worktree.checked@6` with the moment `restored`. The step `restore-tree` does the same at the next start. The log names a rerun and each file that it wrote back.
- `src/review/drift.ts` and `src/review/tree.ts`: the drifted files of the run for the write back, and the write of the expected bytes.
- `src/review/fix-report.ts`: the own `failedAtBaseline` of the Checks table goes. The table reads the last baseline run, with its mark for `not-started`, and the last current run of each other phase. A column of old runs gets "(an earlier tree)", but the column "After the fixes" takes no mark for an answer pass. The notes read the current runs.
- The two texts of the report that this step makes false: the line in `src/review/report.ts` on a drift that blocked until the tree was restored, and the note in `fix-report.ts` on the check after the repair.
- `src/review/phases.ts` and `src/review/status.ts`: the task of a fixer reads the last baseline run, and `status` reads the last current runs.
- Tests: `test/checkpoint/fix-state.test.ts`, for the old runs of each phase, with a baseline run that stays current after the fixes. `test/review/fix-steps.test.ts`, for the cases of R3 and R7 in the Test Strategy, and for a failure in the current attempt that does not run again. `test/review/fix-report.test.ts` and `test/review/status.test.ts`, for the table and its notes.
- `test/review/fix-pass.test.ts`, for whole runs: a check that times out and runs again after a write back, and a repair that reads the tree of the fixes.
- `test/review/resume-contract.test.ts`: remove the marks that this step closes.

```sh
npm run check
git commit -m "feat(review): Run a cut check again after a write back"
```

## 4. Failures after a stop (R4, R6)

### 4a. The outcome `cut`

- `src/runtime/process.ts`: `endedByKill`, with the list of the kill marks.
- `src/review/checks/run.ts`: `checkOutcomeOf` gives `cut`.
- `src/review/steps.ts`: `dueCheck` also returns a kind whose last current run is cut. `interrupted` counts the fault `cut`, so `exhaustedOutcome` blocks such a unit and never degrades it. `workerFailedBlocker` gets its own words for `cut`.
- `src/review/controller.ts`: `runDueCheck` records a second cut of a kind in one attempt as `failed`, with both marks. It reads the end from the process result. Thus a run that a kill ended records no revision, also a second cut, and the write back of step 3 follows it.
- `src/runtime/launcher.ts`: `workerVerdict` reads the mark right after its checks for a worker that did not start or ran past its timeout. The receipt gets the cause `cut`.
- `src/review/phases.ts`: `contributionOf` records `attempt.failed@7` with the fault `cut`.
- Tests: `test/review/checks/run.test.ts`, for each mark, for real kills with SIGTERM and SIGINT on POSIX, and for the `kill` of Git for Windows and `taskkill` on Windows. `test/review/fix-steps.test.ts`, `test/runtime/launcher.test.ts` and `test/review/steps.test.ts`, for the other cases of R4, with a second cut that records no revision.

```sh
npm run check
git commit -m "feat(review): Count a child that a kill ended as cut, not failed"
```

### 4b. One append for the end of a worker

Fresh attempts after a stop (R5) moved into step 2, so that the fixture pins them.

- `src/runtime/launcher.ts`: `runWorker` appends `worker.finished` as today, if its caller does not ask for the payload of the finish instead. Its other callers do not change: the replay in `src/replay/run.ts`, `scripts/smoke-runtime.ts` and the helpers of the tests.
- `src/review/controller.ts`: the controller asks for the payload, and `record` appends the finish and the contribution in one append. It appends the finish alone for an answer that it sets aside, because the tree of a phase that only reads drifted. It also appends the finish alone for a contribution that it cannot build or that the fold refuses, and then it throws.
- Tests: `test/review/controller.test.ts` and `test/runtime/launcher.test.ts`, for the one append, the answer set aside and the refused contribution.
- `test/review/resume-contract.test.ts`: remove the marks that step 4 closes.

```sh
npm run check
git commit -m "feat(review): Record the end of a worker with its answer in one append"
```

## 5. The guard (R8)

- `src/runtime/guard.ts`, new: the guard of the design. It reads the request file: the command, its arguments and how Windows quotes them, the directory and the files of standard input and output. It gets the environment of the child as its own environment.
- The guard starts the child and waits for it. When its standard input closes first, it kills the tree of the child with `killTreeNow` and exits. When the child ends, or cannot start, it writes the result file and exits with the code of the child. The result file holds the termination, `exited` or `not-started`, the exit code, the signal and the error of a spawn that failed.
- `src/cli.ts`: the subcommand `guard`, which only the engine starts. The file dispatches it before it loads its other modules.
- `src/runtime/process.ts`: `runProcess` starts each worker and each check through `node <engine entry> guard`. The guard is detached on Windows, and on POSIX it leads the process group of its child. The engine reads the end from the result file. The timeout kills the tree of the guard.
- A guard with no result file, when the engine did not kill it, gives a cut with a null code and signal. Its error says that no result came. On POSIX, the engine kills the process group of the guard before the rerun.
- The entry of the engine: the callers of `runProcess` give it, as the commands of snapshots and claims get `ReviewOptions.engineEntry`.
- Tests: `test/runtime/process.test.ts` and `test/helpers/process-engine.ts`. A hard kill of the engine alone ends the worker and its grandchild on each system. A kill of the guard alone leaves no result file, and the check is cut. A command that cannot start is `not-started`. The cases of today stay: a timeout, a crash, an exit and the signals.
- Measure the suite before and after this step, in alternate runs, because each child now starts one more Node process.
- `test/review/resume-contract.test.ts`: remove the marks that this step closes.

```sh
npm run check
git commit -m "feat(runtime): End each child with the engine through a guard"
```

## 6. Commits and lost attempts (R9, R10)

### 6a. A prepared series

- `src/review/commit.ts`: `commit` appends `commits.prepared@1` before `update-ref`.
- `src/checkpoint/fix-state.ts`: `runHead` does not move for an open series.
- `src/review/commit.ts` and `src/review/answer.ts`: a command that reads `runHead` settles an open series first. It completes the series, drops it, or refuses and names both heads. The reopen of step 7 settles it in its own append.
- Tests: `test/review/commit.test.ts`, for the three cases of R9, and `test/review/answer.test.ts`, for an answer after a cut `commit`.

```sh
npm run check
git commit -m "feat(review): Record a series of commits before the branch moves"
```

### 6b. A lost attempt

- `src/review/controller.ts` and `src/review/fix-events.ts`: `recordLostWorkers` asks `attemptRevisionEvents` for the narrow paths of a lost worker. These are the paths that the snapshots name, the owned files and the claimed files, with no `changedPaths`. A worker that failed while the engine lived keeps the paths of today.
- `test/review/fix-events.test.ts`: the edit of a person stays out of the revision of a lost worker. The next check of the tree finds it as a drift. The edit of a file that a failed worker did not claim is still attributed as git reports it.
- `test/review/resume-contract.test.ts`: remove the marks that step 6 closes.

```sh
npm run check
git commit -m "fix(review): Record only its own files for a lost attempt"
```

## 7. The reopened fix pass (R11, R12, R13)

### 7a. Find the run and reopen it

- `src/cli.ts`: the scope source of `review` gives the mode and the request that `scopeRequestOf` resolves from the flags and from `scope.default`. It gives them before its check of the tree (TD9).
- `src/review/controller.ts`: `openRun` tries the reopen before the continuation of a read-only run (`continuable`). It finds a complete fix run with a unit not attempted because of the budget, newest first, by the mode and the request. The mode `auto` matches either mode.
- When a run matches, `openRun` takes the run lock, folds the run again and reads its open series. `findDrift` then compares the tree with the head that the settled series gives. It chooses the reopen or a new run with its log line.
- Under the start lock and the run lock, `openRun` checks the runtime, the spend, the roles digest and the executable. It refuses a budget not above the spend, with exit code 2 and the message of the design, and it appends nothing. Else it appends `fix.reopened@1`, `limits.changed@1` and the settle of an open series in one append (TD8).
- Tests: `test/review/fix-reopen.test.ts`, new, and `test/cli.test.ts`, for the cases of the first two paragraphs of R11 to R13 in the Test Strategy. Also the same command with the same budget, which refuses and appends nothing, and a run whose `commit` a stop cut, which the reopen completes.

```sh
npm run check
git commit -m "feat(review): Reopen a fix pass that the run budget stopped"
```

### 7b. The work of a reopened run

- `src/checkpoint/fix-state.ts`: a checks phase that runs each kind again moves its floor to its attempt at the last `fix.reopened`.
- `src/review/steps.ts`: `launchableUnit` lets a reopened unit launch. The second round is planned only when each batch of the first round settled, and none is not attempted because of the budget (PD13). A batch of the second round does not launch while a batch of the first round did not settle, also across clusters.
- `src/review/phases.ts` and `src/review/tasks.ts`: `answeredFor` gives a reopened batch the answer that an answer pass already applied, with the note that the tree holds it.
- `src/review/controller.ts`: at the end of a run that the budget stopped, the log names the command that continues it.
- Tests: `test/review/fix-reopen.test.ts`, for a second reopen, a committed run, the shape of run `0d63437e` and the two answer passes. An answer that an answer pass applied before the reopen reaches the fixer, which answers `already-applied` and keeps it. `test/review/fix-steps.test.ts`, for the second round and its order of launch.

```sh
npm run check
git commit -m "feat(review): Finish the rest of the fix pass in a reopened run"
```

### 7c. The report and status of a reopened run

- `src/review/fix-report.ts`: the header line `Reopened:` with the count, the phase of each revision after a committed series, and `committedWords`. Also the fate of a finding with no second round, and the budget line with its command. The command names `--roles` when the run used other roles.
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
- `src/review/phases.ts`: `contributionOf` records `attempt.failed@7` with the fault `limit`, and it keeps the edits of a failed fixer.
- `src/review/steps.ts`: the phase blocks at the first failure with the fault `limit`, after the workers in flight end. This rule comes before the rule for a unit out of attempts. `workerFailedBlocker` names the limit and the reset.
- Tests: `test/runtime/claude.test.ts`, with the text of run `e21b026d`. A run on the fakes in `test/review/fix-pass.test.ts`, and `test/review/steps.test.ts`.

```sh
npm run check
git commit -m "feat(runtime): Block a run at a usage limit of Claude Code"
```

## 9. The record, the skills, the README and the comments (R15, R17)

- `src/review/fix-report.ts` and `src/review/status.ts`: the lines of the table of R15, and an open or a dropped series. Tests: `test/review/fix-report.test.ts` and `test/review/status.test.ts`.
- `skill/claude/skills/deep-review/SKILL.md`: two sentences in step 3, and one in step 4. The bytes of a skill are the product, so each new sentence goes in one time, and the other text keeps its lines. `skill/codex/SKILL.md` does not change. `test/skills.test.ts`: the new lines are lines of the Claude Code skill only.
- `README.md`: a section with the contract of R1, the budget case for a runtime that reports cost, and the limit of Claude Code.
- The comments that the change makes false, as the Steps of the work of the design list them. A step that changes a rule can correct its comment in its own commit, and this step corrects the rest.
- A commit that changes what a skill says is apart from a commit that moves text (`AGENTS.md`).

```sh
npm run check
git commit -m "feat(review): Say what a stop did in the report and status"
git commit -m "docs(skill): Tell the model how a stopped fix pass continues"
git commit -m "docs(readme): Describe what resumes after a stop"
git commit -m "docs(review): Correct the comments that the stop work made false"
```

## 10. The self-review and the build

- Read each hunk and its function, as the global rules ask. For each deleted line, name where the new code keeps its rule. One example is the mark for `not-started` of the old `failedAtBaseline` of the table. Others are the append of `worker.finished` in `runWorker` and `changedPaths` in `attemptRevisionEvents`.
- Search for each caller of `lastRun`, `failedAtBaseline`, `repairTargets`, `dueCheck`, `checkOutcomeOf`, `workerVerdict`, `workerFailedBlocker`, `runWorker`, `runProcess` and `attemptRevisionEvents`. Search also for each caller of `recordLostWorkers`, `runHead`, `openRun`, `continuable` and `scopeRequestOf`.
- Search for each reader of `check.ran`, `attempt.failed`, `worker.finished`, `worktree.checked` and `commits.created`.
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
- The first run: `node <engine copy>/engine/main.mjs review --runtime claude --branch --fix`. While the baseline test runs, a script ends the check with the `kill` of Git for Windows, and the engine 0.3 seconds later. Then the same command resumes the run.
- In the same run, one more stop uses the command of Claude Code that stops a background command, and the gate records its mark. A Ctrl-C by hand records the mark of Ctrl-C, and it shows that under the guard a Ctrl-C reaches the engine alone.
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
