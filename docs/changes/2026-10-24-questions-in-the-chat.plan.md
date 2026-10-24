# Implementation plan: the questions in the chat, the way back and the scope

This is the plan of the work for the [proposal](2026-10-24-questions-in-the-chat.md). It stays in the pull request while the work continues, and the commit that records the verification deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the commands that prove it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit. No step changes how the engine stops, resumes, launches a child or appends to the ledger. Thus `npm run test:contract` runs once, at the head before the gate.

`npm run verify` passes at each head that is pushed, as `AGENTS.md` says, and CI runs it too. Thus each batch of commits that goes to origin ends with `npm run build`, and with a `chore(dist)` commit when `dist/` changed.

The proposal can change during the work. If the code needs a different design, a commit of its own amends the proposal before the code commit. A commit that changes what a skill says is apart from each commit of the engine.

Each test of a step fails on the code before the step and passes after it. A test that pins an old line changes in the same commit as the line, and the commit message says so.

## 0. The branch, the proposal and this plan

- The branch is `feat/questions-in-the-chat`, from `main` at `3c4e3ec`. It holds the proposal, this plan and the implementation. Its name is set before the first push, because a rename of a pushed branch closes its pull request.

```sh
git add docs/changes/2026-10-24-questions-in-the-chat.md
git commit -m "docs(changes): Propose the questions in the chat, the way back and the scope"
git add docs/changes/2026-10-24-questions-in-the-chat.plan.md
git commit -m "chore(changes): Add the working plan for the questions in the chat"
```

## 1. The draft pull request

- `npm run check` and `npm run verify` at the head.
- Push the branch, and open a draft pull request with the proposal and this plan, so the author reviews the proposal before the code. The body has the three sections Motivation, Modifications and Result, and it says that the implementation follows in the same pull request.
- CI runs on Linux, macOS and Windows from then on.

## 2. A run named by the start of its id (R11)

Files:

- `src/review/runs.ts`: a new `runIdOf(checkpoint, given)`. It gives `given` when the ledger holds that id. Else, when `given` has 8 or more characters, it gives the one run whose id starts with `given`. It reads the ids from `checkpoint.listRuns()`, with the unreadable runs.
- In the same function, a start that names two or more runs is a `ReviewRefusedError` that names them. A start that names none, or a start of fewer than 8 characters, goes on to `checkpoint.fold`. Its `UnknownRunError` gets the same report as today in each command.
- `src/command.ts`: `resolveRun` takes the id from `runIdOf` before `checkpoint.fold`. This covers `status`, `report` and `abandon`.
- `src/review/answer.ts`: `chooseAnswerRun` takes a given id through `runIdOf`.
- `src/review/commit.ts`: `chooseRun` takes a given id through `runIdOf`. Its comment cites R6 of fix pass continuation for the order by the last event. That rule is R9, so the comment names R9.

Tests:

- `test/review/runs.test.ts`, new. It takes a whole id and a start of 8 characters. It refuses a start of 7 characters as an unknown id, and a start that two runs share with both ids. It names an unreadable run by its start.
- `test/cli.test.ts`: `status --run`, `report --run` and `abandon --run` with the first 8 characters of an id.
- `test/review/answer.test.ts` and `test/review/commit.test.ts`: `--run` by the start of an id.

```sh
npm run check
git commit -m "feat(cli): Take a run by the first eight characters of its id"
```

## 3. The state of a run with no report, and the run that `report` takes (R8, R9)

Files:

- `src/review/status.ts`: a new `noReportWords(state)`, the state of a run with no current report in its own terms. An abandoned run gives `state.abandonReason` and the phase that `currentPhase` names. A blocked run gives the code of its blocker. A run in progress gives its phase.
- In the same function, a run that works again names the open answer pass, the continuation or the reopened fix pass. The fold has `review.answerPasses` and `review.continuedFrom` for this. A run with no review says that its review is not configured.
- `src/command.ts`: `report` with no `--run` takes the run of the worktree with a current report and the highest `lastSequence`, as `chooseRun` and `chooseAnswerRun` do. Before the short form, it prints one `Not shown:` line for each run of the worktree with a higher `lastSequence`, with `noReportWords`.
- In the same command, a worktree with no run that has a report gets a refusal. The refusal gives the state of the newest run and names `status --all`. A refusal of `report --run <id>` uses `noReportWords`, and it still names `status --run <id>`. The comment of `report` says so.
- `src/review/brief-json.ts`: `briefJsonV3` is version 2 with `version: 3` and `notShown`, a list of the runs that `report` passed over, each with `run` and `state`. `briefJson` takes that list beside the local facts and writes version 3. The comment of the module says that the engine writes version 3 after this change.
- `src/command.ts`: `report --json` gives `briefJson` the runs that its choice passed over, with `noReportWords`, and it prints no `Not shown:` line. The comment of `report` names version 3.

Tests:

- `test/review/status.test.ts`: `noReportWords` for each state. The cases are an abandoned run in the triage with its reason, a blocked run with its code, and a run in progress. They also include an open answer pass, a continuation and a reopened fix pass.
- `test/cli.test.ts`, the case "shows the brief of the newest run of the worktree with report". A new run with no report no longer makes `report` refuse. `report` shows the second run, and its first line names the new run.
- In the same case, an abandoned newest run gives `abandoned` with its reason and its phase. `report --run <abandoned>` refuses with the same words. A worktree whose runs have no report refuses and names `status --all`.
- `test/cli.test.ts`, a continued run: a read-only run, then a later run with a report, then the first run continued into the fix pass to its report. `report` shows the continued run and prints no `Not shown:` line. This case fails on an order by `createdAt`.
- `test/review/brief-json.test.ts`: version 3 parses with `notShown`, and versions 1 and 2 still parse their outputs.
- `test/cli.test.ts`: `report --json` gives version 3, with `briefJsonV3`. With a later run that has no report, stdout parses as JSON whole, and `notShown` names that run with its state. `report --run <id> --json` gives an empty list.

```sh
npm run check
git commit -m "feat(report): Show the newest run with a report and say why others have none"
```

## 4. The list of runs (R10)

Files:

- `src/command.ts`: `options` and `allowed.status` get `all`. `status --all` refuses `--run` and `--json` with a usage error. The usage line becomes `deep-review status [--run <id> | --all] [--json] [--repo <dir>]`.
- `src/review/status.ts`: a new `runListLines(runs, worktree, copyOf)`. It gives the runs newest first by `createdAt`, at most 20, and then a line that counts the others.
- In the same function, each line gives the whole id, `createdAt`, and the state with the reason of an abandon. It gives the mode of the scope, with its number of files and both ends. It names the worktree when it is not this one. Last, it gives the path of the copy of the report, or `no report`. A run with no scope says so.

Tests:

- `test/review/status.test.ts`: a line for each state, a run with no scope, a run of another worktree, 21 runs, and a copy that does not exist.
- `test/cli.test.ts`: `status --all` with two runs, newest first. `--all --run` and `--all --json` are refused.

```sh
npm run check
git commit -m "feat(status): List the runs of the checkpoint with --all"
```

## 5. The `Scope:` line (R12)

Files:

- `src/scope/git.ts`: a new `commitCount(repo, base, head)`. It runs `git rev-list --count <base>..<head>`, and it gives null when git fails.
- `src/config/command.ts`: `ShownScope` gets the mode as the person asked for it and the name of the base. It also gets the counts of commits, of files and of the paths that `scope.exclude` leaves out. Last, it gets the count of uncommitted files, or null.
- In the same file, a new `scopeLine(scope)` builds the line, and `showLines` uses it. The comment beside the line names this proposal beside R11 of the skill surface corrections.
- `src/command.ts`, `config show`: it fills the new fields. The mode is `branch` when `--branch` or a `scope.default` of `branch` named the scope. The name of the base comes from the request. For `--branch`, it is the merge base with the `--base` or `review.base` ref. It is the ref of `--ref`, the revision of `--from`, `HEAD` for `worktree`, or the parent for `last-commit`.
- In the same command, the files and the paths left out come from `resolveScopeRequest`. The uncommitted files come from `changedAgainstHead`, for a change that ends at the working tree. The `--json` output gets the same fields in `scope`, and also `files`, the path of each of `listed.changes`, and `excluded`, the paths of `listed.excluded`. An empty change keeps its reason, with two empty lists.
- `src/review/status.ts`: `describeRun` gives a `Scope:` line from `state.scope` through `scopeLine`, with no count of uncommitted files. The caller in `src/command.ts` gives it the count of commits.
- In the same file, a new `askedModeOf(state)` gives the mode that the line names. It is `branch` when `state.scope.request.range` ends at `HEAD`, takes the merge base, and starts at the value of `review.base` in `review.configuration.settings`. Else it is the captured mode, also for a run with no recorded settings. `runListLines` of step 4 names the mode with it from this step on, and its test of a `--branch` run changes with it.
- In the same function, the JSON form gets `scope`: the facts of the line, `files` from `state.scope.files` and `excluded` from `state.scope.excluded.paths`. It is null for a run with no scope.

Tests:

- `test/scope/git.test.ts`: `commitCount` of a range, and null for a revision that does not exist.
- `test/config/command.test.ts`: the line of `last-commit`, `worktree`, `--branch`, `--ref` and `--from --to`. Also the line with paths that `scope.exclude` leaves out, with uncommitted files and with none, and with no count of commits. The two cases that pin the line of today change.
- `test/review/status.test.ts`: the `Scope:` line of a captured scope. The JSON form gives the paths of the files and the excluded paths, and null for a run with no scope.
- In the same file, `askedModeOf`: `branch` for the range that `--branch` records, and for the same range from `--from <base> --to HEAD --merge-base`. `range` for a range with another start, with another end, or with no merge base, and for a run with no recorded settings.
- `test/cli.test.ts`: `config show --branch` names `branch` and the merge base with the base ref. `config show --json` gives each reviewed path and each excluded path, and `status --run <id> --json` gives the paths that the run captured.

```sh
npm run check
git commit -m "feat(config): Give the Scope line the counts and the base a person can check"
```

## 6. The questions, the rules and one name in the short form (R1, R2, R3)

Files:

- `src/review/brief.ts`, `briefShortForm`: the line `Questions:` keeps its count and its words about the default, with no ids. After it come the lines of each open question, for at most `shownQuestions` (3): the question, the option in place and deep-review's choice, or one line for the two when they are one option. One more line counts the others with `idWords`.
- In the same function, the line `Against a written rule:` keeps its count, with no ids. After it comes one line for each open departure, for at most `shownDepartures` (3), with the source and then the rule. One more line counts the others.
- Each new line starts with two spaces and the id of the finding. The lines of a question, an option and a departure skip `cutAtWord`, since the schema of the decider holds each text to 400 characters. `lookWords` names a departure as a fix that goes against a written rule. The comments of `briefShortForm` and `shortLineLimit` give the new maximum of 22 lines and the lines that pass 200 characters.

Tests:

- `test/review/brief.test.ts`, the cases under `briefShortForm (R13 of the brief of a run)`: the lines of a question. The default in place and the choice as one option on one line, and as two options on two lines.
- In the same file: a question of 400 characters with two options of 400 characters each, given whole. A departure whose source and rule have 400 characters each, given whole with the source first.
- In the same file: a default that no fixer applied, in a run that only reviewed. Four questions, with the line of the count. The line of a departure, and the line of the count.
- In the same file: the words of `Look at:`. A run with many of each gives at most 22 lines and the path. Each line has at most 200 characters, but the lines of the change, the questions, the options and the departures. The case of the accepted departure keeps `Look at: nothing`.
- Each other test that pins a line of the short form or its count of lines, from `grep -rn "briefShortForm\|lines.length\|Questions: \|Against a written rule: " test/`.

```sh
npm run check
git commit -m "feat(brief): Name each open question and each rule in the short form"
```

## 7. The line of the change (R4)

Files:

- `src/review/brief.ts`: a new `changeLineLimit` (400). The line of the change gives the first sentence whole up to that limit, and only that line has that limit.
- `src/review/tasks.ts`: `accountLimits` gets `firstSentence` (160). The line of `what` in the task of the triage asks for one first sentence of at most that many characters. That sentence says alone what the change does.

Tests:

- `test/review/brief.test.ts`: a first sentence of 300 characters stays whole, and one of 500 is cut at a word with three periods.
- `test/review/tasks.test.ts`: the sentence of the task, with the limit.

```sh
npm run check
git commit -m "feat(brief): Keep the first sentence of the change whole"
```

## 8. The mark on the core of the change (R5)

Files:

- `src/review/brief.ts`: `changePart` takes the brief, and it ends with the sentence of R5 when `change.state` is `given` and `changed.patches` is more than 0. `briefShortForm` starts the line with `The change before the fixes:` in the same case. The states `none` and `unrecorded` keep their words of today.

Tests:

- `test/review/brief.test.ts`: a fix run with a patch gives the sentence and the label. A run that only reviewed and a fix run with no patch keep the words of today. An answer pass that makes the first patch gives both. A fix run with a patch whose triage gave no account, and one whose triage recorded none, keep the words of today.
- `test/review/report.test.ts` and `test/review/report-copy.test.ts`, where they pin the part "The change".
- The snapshots `test/fixtures/reports/fix.md`, `survey.md` and `synthetic.md` stay as they are. Each is the report of a run whose triage recorded no account. `test/review/fix-report.test.ts`, `test/review/survey-report.test.ts` and `test/review/report.test.ts` compare them, and each passes with no new snapshot.

```sh
npm run check
git commit -m "feat(brief): Say when the core describes the change before the fixes"
```

## 9. A line for each fix with `report --fixes` (R6)

Files:

- `src/review/fix-report.ts`: a new `fixLines(state)`. It gives a line for each fix that `briefOf(state).changed` counts, in rank order. A line has the id, the words of its fate, and the subject of the commit message of the answer that gave its last outcome. With no message, it has the first sentence of the note of that answer. With no answer, it has the reason that no fixer attempted the fix. Each line goes through `cutAtWord` at `shortLineLimit`. A run that only reviewed gets the sentence of `changedPart`.
- `src/review/brief.ts`: a new `fixFateWords`, the words of each fate as a line of `report --fixes` names it, beside `fateWords`.
- `src/command.ts`: `options` and `allowed.report` get `fixes`. `report --fixes` refuses `--json` and `--brief` with a usage error. It prints the lines of R8, then `fixLines(state)`, then the path of the copy. When the engine cannot write the copy, the last line is the path of the record. The comment of `report` names `--fixes`, and the usage line becomes `deep-review report [--run <id>] [--json | --fixes] [--repo <dir>]`.

Tests:

- `test/review/fix-report.test.ts`: `fixLines` for a fix of the fix pass with its subject, a fix that an answer pass applied, and a fix whose answer has no message. Also for each other fate, a line past 200 characters, and a run that only reviewed.
- `test/cli.test.ts`: `report --fixes` prints the lines and then the path. `--fixes --json` and `--fixes --brief` are refused.

```sh
npm run check
git commit -m "feat(report): Print a line for each fix with --fixes"
```

## 10. `report --brief` and `report --finding <id>` (R7)

Files:

- `src/command.ts`: `options` and `allowed.report` get `brief`. `report --brief` refuses `--json` and `--fixes` with a usage error. It prints the lines of R8, then `briefMarkdown(brief)`, then the path of the copy. When the engine cannot write the copy, the last line is the path of the record.
- `src/review/brief.ts`: a new `briefBlock(brief, id)`. It gives the block of a question, through `questionBlock`, or of a departure, through `departureBlock`, under the heading of its part, or null for an id with no such block.
- `src/command.ts`: `options` gets `finding`, a string, and `allowed.report` gets it too. `report --finding <id>` refuses `--json`, `--brief` and `--fixes` with a usage error. It prints the lines of R8, then `briefBlock`, then the path as `--brief` does. A null block is a usage error that names `report --fixes` for a fix. The usage line becomes `deep-review report [--run <id>] [--json | --brief | --fixes | --finding <id>] [--repo <dir>]`.

Tests:

- `test/review/brief.test.ts`: `briefBlock` of an open question, of an answered question, of a departure, and null for the id of a fix and for an unknown id.
- `test/cli.test.ts`: `report --brief` prints the Markdown brief, whose first line is the heading of the title and whose last line is the path of the copy. `report --run <id> --brief` takes the named run. `--brief --json` is refused.
- In the same file: `report --finding <id>` prints the block of a question and then the path. The id of a fix is refused with words that name `report --fixes`, and `--finding --json` is refused.

```sh
npm run check
git commit -m "feat(report): Print the brief, or the block of one finding, in Markdown"
```

## 11. The skills (R6, R7, R10, R11, R13, R14)

Files:

- `skill/claude/skills/deep-review/SKILL.md`, step 3: it runs `status`, then `config show` when no run is active, then the review as a background command. Then it writes the message with the lines that it copies, as the last text of the turn. For an active run, it copies the `Run`, `Scope:` and `Settings:` lines of `status`.
- In the same file, the three facts that step 2 tells the user before a fix run move into that message of step 3, and step 2 no longer tells the model to say them before the command. The Codex skill keeps them in step 2.
- In the same step, a user who stops the review gets the background command stopped first, and then `abandon`.
- In the same file, step 4 puts the short form in the last message of the turn.
- In the same file, step 5 runs `report` after `commit`. The last message shows the lines of `commit`, and then the short form that `report` printed, which names the commits. `skill/codex/SKILL.md` gets the same sentences.
- Step 4 also names `report --finding <id>` for a question about one question or one fix that goes against a written rule. It names `report --brief` for a document left out of date or for the whole result, and `report --fixes` for a question about what the run changed.
- In the same file, the paragraph about a finished run names `status --all` for a user who does not know the run. It says that `--run` takes the eight characters that the brief shows.
- `skill/codex/SKILL.md`: the same sentences for step 4 and for the paragraph about a finished run. Step 3 keeps its order, and its message for an active run copies the `Scope:` line of `status` too.

Tests:

- `test/skills.test.ts`: the new order of step 3 in the Claude Code skill, and the old order in the Codex skill. For an active run, both skills copy the `Scope:` line of `status` too, and the case checks that `describeRun` prints a line that starts with `Scope: `.
- In the same file, the case that pins the warning of a fix run: in the Claude Code skill, the three facts are in the message of step 3, after the review starts. In the Codex skill, they stay in step 2, before the command, as the case asks today.
- In the same file: the sentences of step 4, of step 5 with `report` after `commit`, and of the paragraph about a finished run, in both skills. The case checks that the words of `changedWords` name the commits once a run has them, so the short form that `report` prints after `commit` says so. The two texts stay one, except the lines of each runtime. The tests that pin the sentences of today change with them.

```sh
npm run check
git commit -m "feat(skill): Show the scope after the review starts and name the new commands"
```

## 12. The README, the usage and the comments

Files:

- `README.md`: the paragraph about the short form. It gets the questions, the rules, the mark on the core, `report --brief`, `report --finding <id>`, `report --fixes` and the run that `report` takes.
- In the same file, the paragraph about `config show` gets the new `Scope:` line. The paragraph about the skill gets the order of step 3, `status --all` and `--run` by its start.
- Each comment that describes the old behavior, from `grep -rn "newest run of the worktree\|seven lines\|an eighth\|has no current report" src/ README.md`.

```sh
npm run check
git commit -m "docs(readme): Describe the questions in the short form, the list of runs and the Scope line"
```

## 13. The self-review and the build

- Read the whole diff against each requirement of the proposal, and as a reviewer reads it: each changed function whole, each caller of a changed signature, each removed line and the rule that it kept.
- `npm run check` and `npm run test:contract` at the head.
- `npm run build` and `npm run verify`, then `git commit -m "chore(dist): Rebuild the engine with the questions in the chat"`.
- Push, and wait for CI on the six jobs.

## 14. The gate (R15), on the author's word

- Copy `dist/claude` and `dist/codex` of the head out of the worktree. Then the run on this pull request does not change the engine that it uses.
- deep-review on this pull request on Claude Code, with the command of the skill and the settings of the repository.
- Then `deep-review commit`, and typecheck and lint at each commit alone. Then `npm run check` and `npm run verify` at the head, the audit of the ledger, and a stacked pull request with the commits of the gate.
- pallets/click #3878 in fresh clones at the head `f8c5a8e` and the base `2247b35`, with a test identity. The Claude Code plugin and the Codex skill take the engine of the head for the sessions, and they go back to `main` after them.
- An interactive session of each host. It has a start with `--branch --fix`, the result, a question about the open question, and a commit. Then it has a start with a wrong scope that the user stops and abandons. A new session then asks for the last result and for the runs.
- When the run of a host asks no question, the same request runs once more in that host, on the author's word. With no question again, the record says that the gate did not measure the questions in that host.
- The record gives the measures of R15. On Claude Code, it gives the message of each start as a text block of the transcript, with the words of step 2 for the fix run. In each host, it gives the `Scope:` line of each start against the commits and the files that git gives for the clone.
- In each host, the record also gives the questions learned from the chat with no read of a report. It gives the last message of each turn with a result, against the stdout of the engine, also after `commit`.
- Last, it gives the stop and the `abandon` of the run with a wrong scope, with no refusal, and the last report after it with one command.

## 15. The verification, and this plan out

- The section Verification of the proposal records the implementation, the gate and the answers of the author. It also records each change of the proposal during the work.
- This plan is deleted in the same commit: `git commit -m "docs(changes): Record the verification of the questions in the chat"`.

## 16. The pull request ready

- The body of the pull request describes the finished work, and the pull request is marked ready.
- The merge goes to `main` by a fast-forward, on the author's word. Then the Claude Code plugin and the Codex skill take `main`.
