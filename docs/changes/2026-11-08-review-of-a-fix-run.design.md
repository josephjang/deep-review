# Technical Design: The review of a fix run on the pull request

Product part: [2026-11-08-review-of-a-fix-run.requirements.md](2026-11-08-review-of-a-fix-run.requirements.md).

## Summary

`openRun` configures every new run whose scope names a pull request at `review.configured@11`, the configuration of a read-only run of a pull request, whether or not the command gives `--fix`. `runReview` becomes two passes of today's body. When the first pass ends with the report of a read-only run of a pull request and the command gives `--fix`, a second pass continues that run, named by its id, through the existing `continuationOf` and `fix.pinned@2`, with no read of GitHub. The fold keeps the sequence of the `fix.pinned` event in `continuedFrom`, and the checkpoint folds a run's events before a sequence. `publish` renders a continued run from the fold of its events before the continuation, and tells the form that the run went on into its fix pass, so the form takes the words of R6 from the table of its language. The ledger gains no event, no version and no DDL change, so no golden fixture is added, though the expected fold of the newest one is written again (TD1).

## Non-Goals

### NG1: No change to the ledger

Every event that this design writes, an engine before it writes too: a read-only run of a pull request configured at version 11, and a continuation recorded by `fix.pinned@2`. Only which configuration a command chooses, and when the continuation is appended, change.

### NG2: No change to a continuation that a person asks for later

`review --pr <n> --fix` with no active run still continues the newest finished read-only run of the pull request, chosen by `chooseContinuation` with a read of GitHub, as R4 of the review on the pull request says.

### NG3: No change to other scopes

A run whose scope names no pull request is configured as today, at version 9, with the fix pass from its start when the command gives `--fix`.

## Context

### How a run is configured

`openRun` in `src/review/controller.ts` configures a new run, or a run that a stop left with no configuration, at version 11 when the command gives no `--fix` and the scope names a pull request (`explains`), and at version 9 otherwise. The fold refuses version 10 or 11 with `fix: true` (`explainedConfiguration` in `src/checkpoint/review-fold.ts`), and records its verdicts at version 3 only in a run configured at version 11 (`verdictsVersionOf`). The phase `explanation` comes after `decision` and before the seven phases of the fix pass (`phases` in `src/review/vocabulary.ts`), and a run configured at version 9 records it as skipped.

### How a run is continued

With `--fix`, no active run and no `--fresh`, `openRun` looks for a finished read-only run to continue (`chooseContinuation`). For a run of a pull request it resolves the command's scope, which reads the pull request on GitHub, and passes over a run whose scope is not the command's. It then takes the run's lock, folds it again and calls `continuationOf`, which refuses a run with nothing to fix (`nothingToFix`), a run whose survey failed with checks unsettled, a run at its budget and a run whose runtime, roles digest or executable no longer qualify. The pin is appended as `fix.pinned@2` at the start of the pass (`runReview`), whose reducer (`src/checkpoint/fix-fold.ts`) sets the configuration to fix, clears the report into `continuedFrom` with the time and the count of the checks, and sets the seven phases of the fix pass to pending.

### How a run is posted

`publishLocked` in `src/review/publish.ts` settles an open publication, returns a run posted before, refuses what `whyNotPostable` names, checks the pull request with `requireUnmoved`, places the findings and renders the review with `pullRequestForm` from the folded run, the writer's recorded answer and the machine's context. `whyNotPostable` refuses a run continued into the fix pass and a run configured with the fix pass. The form's words come from `src/review/pull-request-words.ts`, a table for each language, English and Korean. These entries speak of what follows a read-only review: `reviewed`, which says that the run changed no file; `summaryNext`, which says that nothing changes until `--fix`; `departureStands` and `departure`, which say that `--fix` makes the fix unless it is rejected; the result of an option that edits, which says that `--fix` applies it; `answerQuestion`, which says that `--fix` then applies the answer; and the diagram of how the review works, whose last node is `review --pr <n> --fix`. `fixCommand` in `src/review/pull-request-form.ts` builds the command these sentences name.

## Design

### The configuration of a new run of a pull request (R1)

`explains` no longer depends on the command's `--fix`: a new run, or a run with no configuration yet, whose scope names a pull request is configured at version 11 with `fix: false`, `checks: null` and `fixes: null`. The check flags of the command are not recorded at configuration, as for any read-only run; the continuation resolves them (R4 of fix pass continuation). When the command gives `--fix`, the log line of the configuration adds that the command continues the run into the fix pass once its report is written, when its decisions send a finding to a fixer (R2). A command with `--fix` still refuses an old Node at configuration, before the review spends anything, and `continuationOf` checks it again.

### Two passes of a review (R1, R2, R4)

Today's body of `runReview` becomes `runPass`. `runReview` runs it once, and runs it a second time when all of these hold: the command gives `--fix`; the first pass ended with a written report; the run is read-only, so its review has no fix state; its scope names a pull request; and `notContinuable` gives no reason against it. Before the second pass, `nothingToFix` is read from the run: when it gives a reason, `runReview` logs that the run has nothing to fix, with that reason, and returns the first outcome (R2).

The second pass gets the run's id as `continuing`, with the run's lock, which the first pass does not release when it ends with a report that the second pass continues, so no `publish`, `answer` or other command takes the run between the read-only report and `fix.pinned`. `openRun` then skips the search for an active run and for a continuation, and both of its reads of GitHub, the one before the start lock and the one under it: it folds the named run again under the lock it holds. It refuses with `ReviewRefusedError` when the run is no longer complete and read-only, or `notContinuable` names a reason, when its files no longer hold what it froze or `HEAD` is not its head, which is the part of the scope comparison of R2 of fix pass continuation that reads the tree and not the command's scope, and then calls `continuationOf`. No branch of this path creates a run, and none reads GitHub (R4, PD4).

A refusal of the second pass, from `openRun` or from `continuationOf`, is caught by `runReview` and thrown again as a `ReviewRefusedError` whose message starts with the refusal and adds that the run's review is written, where its report is, and that the same command continues the run once the refusal's action is taken. The exit code is 2, as for any refusal. The run stays complete and continuable, because nothing was appended.

### A resumed read-only run of a pull request (R3)

`resumedFixFlags` logs for a read-only run of a pull request resumed with `--fix` that the command continues it into the fix pass once its report is written, when its decisions send a finding to a fixer, in place of the line that says `--fix` is ignored. Since the run recorded no check flags at configuration (R1), the line also says that this command's `--check` and `--no-check` settle the checks of the fix pass, so every one the command that started the run gave is given again. The first pass resumes it as any read-only run, and the rule of the two passes continues it.

### The review of a continued run (R5)

The fold's `continuedFrom` gains `sequence`, the sequence of the `fix.pinned` event. This is state, not a payload: no event changes. `Checkpoint` gains `foldBefore(runId, sequence)`, the fold of the run's events whose sequence is lower, read through the same check of unknown events as `fold`.

Without `--run`, `publish` chooses with `chooseReportRun` given a rule of its own, a current report or a `continuedFrom`, in place of its default of a current report, since the continuation clears the report until the fix pass writes its own. So it chooses the newest run of the worktree that has a current report or a `continuedFrom`. `publish` reads `reviewed`, the run it renders: the fold before `continuedFrom.sequence` for a continued run, and the run itself for any other. `whyNotPostable` reads the current report, the scope, the fix state and `--path` from `reviewed`, so a fix state there is a fix run that did not review first (R7), since the fold before a continuation has none. It reads from the whole run its status, to refuse a run abandoned in its fix pass, which the fold before the continuation shows active, and the words of why it has no report. The checks of the pull request, the placement and the form read `reviewed`, and the writer's recorded answer is `reviewed.explanation`, the same as the whole run's. The publication is still prepared, posted and settled on the whole run, since its events come after the fix pass, and `publishPrepared` holds the places to the run's ranking, which the fix pass does not change.

### The words of a continued run (R6)

The input of `pullRequestForm` gains `fixPass: 'to-come' | 'continued'`, which `publish` sets from the whole run's `continuedFrom`. `PullRequestWords` gains a member `continued` with the entries of the Context that speak of what follows the review, the label of the diagram's step of the read-only review among them, each worded for a run that went on into its fix pass, and the form chooses `words.continued.*` over the read-only entries when `fixPass` is `continued`. The member also holds `noCheck`, the line on the checks, which for a read-only run says that the run only reviewed, so no test ran. `fixCommand` is not used in a continued run's words, since no command remains to run for the fixes. `answerCommand` stays: `deep-review answer` on a fix run runs the answer pass itself. The English and the Korean tables both gain the member. The words of a finding's status do not change (NG2 of the requirements).

### A fix run that did not review first (R7)

`whyNotPostable` replaces its refusal of a fix run with the words of R7, which name the run, that it reviewed and fixed in one pass, and the command that reviews the pull request again.

### The skills and the README (R8)

Both skill texts, `skill/claude/skills/deep-review/SKILL.md` and `skill/codex/SKILL.md`, drop the sentence that `publish` refuses a run that `--fix` continued and the order it asks for, and offer to post after a run of `--pr` with or without `--fix`. The paragraph on posting says that `publish` posts the review of a run of `--pr`, with or without `--fix`. The README's section "Posting the review" says what R8 of the requirements lists, and its list of the body says what a continued run's first line and summary say.

### Where the code goes

- `src/review/controller.ts`: `explains`, `runReview` and `runPass`, `continuing` in `openRun`, the refusal of the second pass, and `resumedFixFlags`.
- `src/checkpoint/fix-fold.ts` and `src/checkpoint/review-fold.ts`: `continuedFrom.sequence`.
- `src/checkpoint/checkpoint.ts`: `foldBefore`.
- `src/review/publish.ts`: `reviewed`, `whyNotPostable` and the form's input.
- `src/review/pull-request-form.ts` and `src/review/pull-request-words.ts`: `fixPass` and the words of a continued run.
- `README.md`, `skill/claude/skills/deep-review/SKILL.md` and `skill/codex/SKILL.md`.
- `dist/`: rebuilt in the last commit of the series.

## Technical Decisions

### TD1: No new event and no new version

The record that a posted review needs, a read-only run of a pull request with its report, already exists in every run that a person continues by hand. Making `review --pr --fix` produce that record reuses `review.configured@11`, `fix.pinned@2` and every reducer as they are, so an engine before this change reads every run that this engine writes, and no golden fixture is needed (AGENTS.md, "The ledger is append-only and forward-compatible"). `continuedFrom.sequence` changes the fold of the continued runs that the newest fixture holds, which `test/golden.test.ts` compares exactly, so that fixture's expected fold is written again, as an earlier change of the fold did. A new version of the configuration for a fix run that explains its review was rejected with PD1 of the requirements.

### TD2: The review is a fold of a prefix of the ledger

A ledger folds to a state at any sequence, and the state before `fix.pinned` is the finished read-only run, with its report current. Holding the sequence in `continuedFrom` costs one field of state. Telling the continuation's event apart by its kind in `publish` would put a rule of the fold in the publisher.

### TD3: Two passes of `runReview`, not a continuation inside the phase loop

The phase loop of `runReview` closes over the run's configuration as pinned when it starts, in many closures: the pinned runtime options, the tools path, the check settings and the workers' environment. A continuation inside the loop would have to rebuild them after `fix.pinned`. A second pass builds them as any continuation does today.

### TD4: The second pass names its run

`chooseContinuation` chooses the newest qualifying run whose scope the command names, and lets go of one that no longer qualifies, after which `openRun` creates a run. The second pass must never do that (R4), so it names the run it continues and refuses when that run does not qualify.

## Open Questions

### OQ1: Should a command with `--fix` continue a read-only run of another scope that it finishes?

R3 holds only for a run of a pull request, which is the only run that `review --fix` configures as read-only. A resumed read-only run of another scope still logs that `--fix` is ignored, as R10 of fix pass continuation says. One rule for every scope would be simpler to state, and a later proposal can make it.

## Test Strategy

### TS1: The configuration and the two passes (R1, R2, R4)

With the scripted runtime of the controller's tests and a pull request read from a fake `gh`, `review --pr --fix` with no run records `review.configured@11` with `fix: false`, runs `explanation` before any phase of the fix pass, writes the read-only report, appends `fix.pinned@2`, and ends with the fix report. A run whose decisions route nothing to a fixer ends with its read-only report, exit 0, and the log line of R2. A continuation refused in the second pass, by a run budget below the review's spend, leaves the run complete and continuable, creates no second run, and its message names the read-only report.

### TS2: A resumed run (R3)

A read-only run of a pull request stopped before its report and resumed with `--fix` logs the line of R3, writes its read-only report and is continued. The contract test of resumable runs gains a stop between the read-only report and `fix.pinned`, after which the same command continues the run.

### TS3: The fold before a sequence (R5)

`foldBefore` of a continued run at its `continuedFrom.sequence` folds to a complete read-only run whose report is the one `continuedFrom` holds.

### TS4: `publish` (R5, R7)

`publish --dry-run` of a continued run, with its fix pass finished and with it blocked, prints the review of the read-only run with the words of R6, and none of the read-only entries they replace. `publish` of it records `publish.prepared` on the whole run, and a second `publish` returns the review posted before. A run configured with the fix pass from its start is refused with the words of R7.

### TS5: The words (R6)

For each language, a continued run's body and comments hold the entries of `continued`, and no sentence of a continued run's review names `--fix`.

## Verification

### Implementation

Six commits implement the design, from "feat(checkpoint): Fold a run before a sequence" to "chore(dist): Rebuild for the review of a fix run". `runReview` runs `runPass` once or twice. A pass that ends with an outcome keeps the run's lock, and `runReview` releases it once, so the lock is held from the first pass to the end of the second. The second pass opens its run in `openContinuing`, which returns before every read of GitHub and every search for a run, holds the run to `treeMismatch`, the part of `scopeMismatch` that reads the tree, which `src/scope/compare.ts` now exports, and then calls `continuationOf`. `publish` chooses its run with `chooseReportRun` and a rule of its own, a current report or a `continuedFrom`, and renders `reviewedOf(run)`.

Choices made in the work, within the requirements:

- The refusal of the second pass wraps only the refusals of `openRun`. A refusal later in the fix pass, after `fix.pinned`, keeps its own words.
- The words of what follows a review share one type, `FollowingWords`, which the form chooses once, in `followingOf`. `fixCommand` is gone, and a read-only review's text is unchanged byte for byte.
- The diagram of a continued run hangs the fix pass beside `publish`, not after the answers, since the fix pass starts before a person answers.
- `publish` refuses a run abandoned in its fix pass, since the ledger takes no publication on a closed run.
- The refusal of a run of another scope comes before the refusal of R7, so a fix run of `--branch` is told that it reviewed no pull request.
- The usage line of `publish` in `src/command.ts` and the replay of the decider in `src/replay/decider.ts` change with the form's input.
- The contract test's new scenario, a stop before `fix.pinned`, is not in the list that `npm run resume-test` runs, so the cost of that gate does not change.
- `npm run golden` into a scratch directory wrote a ledger, identity and artifacts byte for byte the same as `schema-1-20`. Only its `expected.json` differed, by the two `sequence` fields, and that file is written again.

The Korean words have been read by the author's agent but not yet by a native speaker on GitHub.

### Checks

At the head of the series, `npm run check` passed (3,657 tests: 3,644 pass, 13 skipped, none fail), `npm run test:contract` passed (109 of 109), and `npm run verify` found `dist/claude` and `dist/codex` matching the sources. Every commit of the implementation passed `npm run typecheck` and `npm run lint`.

### The gate

The gate of R9 ran on 2026-11-08, on Claude Code 2.1.318, as run `c6ed03ed`, with the bundle committed at the head of this pull request. `review --runtime claude --pr 126 --fix` wrote the read-only report and continued the same run into the fix pass in one command, and exited 0 with the fix report (R1). The run kept 26 findings: 19 decided fix, one of them against a written rule, 5 left as is and 2 asked. Its fix pass left 23 patches. Both passes took 52 minutes and 60.75 USD of the 120 USD budget that the repository's file sets.

For M2, the writer cost 1.97 USD and three minutes. The continuation asked no surveyor, since the repository's file settles every check, so the continuation's survey cost nothing. For M3, no continuation was refused.

The checks of the fix pass rebuild `dist/` in the working tree, so the engine there was no longer the one this pull request ships. `publish` ran with the bundle taken from the pull request's head. `publish --dry-run` placed each of the 26 findings of the read-only report, 19 on their lines and 7 in the body, with no cut and no secret replaced. Its body opened with the line of R6, held the line on the checks and the diagram of R6, and held neither "changed no file" nor a sentence that says `--fix` applies a fix or an answer: each `--fix` in it is in the text of a finding. `publish` then posted the review with 19 comments on lines, and a second `publish` printed the URL of that review and posted nothing.

The review asked two questions and gave one fix against a written rule. The author accepted the departure of finding 2, so a resumed run is continued only when the command's `--pr` names its pull request, and R3 says so now. The author chose option 2 of finding 17, so the skills offer to post before the fixes are pushed, which the answer pass applied for 1.52 USD. The author kept option 1 of finding 20. The fixes of the run are a pull request of their own, stacked on this one, whose commits `deep-review commit` made from the run.
