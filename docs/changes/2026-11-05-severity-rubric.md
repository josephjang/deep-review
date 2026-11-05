# Change Proposal: A rubric for the severity of a finding

## Summary

Merge-rank, the worker that folds the verified findings of a review that share one root cause, gives each finding a severity: `critical`, `major` or `minor`. No prompt says what makes a finding one or the other. The engine still treats the value as the key of what a reader sees: a critical or major finding goes in the body as what matters before the merge, and a minor one is folded into a table. The report [`2026-11-05-review-written-and-read.md`](../reports/2026-11-05-review-written-and-read.md) names this as the largest judgment of the review that has no stated rule (W1), and puts a rubric first among its ways to improve.

After this change, merge-rank's role prompt defines the three severities by what a finding costs once the change is merged, each with a test and one example, and says what a severity is not graded by. A `CONVENTIONS` violation is graded by what its rule's own reason says goes wrong. Merge-rank's `reason` for each finding says which consequence gives its severity. Its task names the severity as the role prompt defines it, so the rubric is one text. The change edits one role prompt fragment and one task, which changes merge-rank's role prompt and its hash; no event, schema or posted word changes.

## Problem

### The value decides the form, and nothing defines it

`roles/fragments/phase4-list.md` tells merge-rank to "give each finding a severity: `critical`, `major` or `minor`", and the task in `src/review/tasks.ts` (`mergeRankTask`) repeats the three values. Neither says what any of them means. The design of the review that reads as a report records the same gap: the body "calls a severity a worker's judgment, as no prompt defines major and minor".

The engine reads the value in more places than any other judgment of a worker. It orders the findings by it (`compareFindings` in `src/review/state.ts`, TD9 of the read-only review). The form puts a finding that is not minor in an area with its cited lines and folds a minor one into a table (`isMinor` in `src/review/pull-request-form.ts`, `isMajor` in `src/review/explanation.ts`). The summary counts the major findings as "what matters before the merge" (`src/review/pull-request-words.ts`). The brief's "Before you merge" names the major findings that stay open (`mergePart` in `src/review/brief.ts`). A grade that no rule governs therefore decides what a reader sees first and what they never open.

### The reader is told a meaning that the ranker is never given

The body of the review on a pull request explains the severity to its reader: "a critical or major finding is what matters before the merge, and a minor one is smaller, such as a wrong message or repeated code that the next change can let drift" (`severityMeanings`, in English and Korean). Merge-rank never reads this sentence. The engine states a rule to the reader that no worker was asked to follow, so the sentence is true only as far as the ranker's own sense of the words agrees with it.

### A rule has no severity to take

Both texts say that "a `CONVENTIONS` violation takes the severity of the rule it breaks". A rule in a convention source carries no severity: `AGENTS.md` says what code must be, and sometimes why, but never how bad a departure is. The sentence sends merge-rank to read a value that is not there.

### What a real review showed

The review that the gate of the review on the pull request posted on #96 opened with 27 fixes, 8 of them major and 19 minor (#102). The independent read of that review found the claims of the findings right, 15 of 15 checked, and #102 does not dispute the grades; its complaint is how the body weighs them. So no real run has yet shown a wrong severity. The case for this change is that the value carries the form, the reader is told a rule, and no worker is given it; the gate measures whether the grades move once it is given.

## Goals

A severity follows a stated test that the ranker is given, and that test is the one the body states to its reader. A reader of the ledger can see from each finding's `reason` which part of the test gave its grade. The rubric has one text, and a test fails when the severities of the engine and the rubric's list stop matching.

## Non-Goals

### The set of severities and the engine's order

The three values and the order the engine derives from them (TD9 of the read-only review) stay. A fourth value, or a fold of `critical` into `major`, is a change of the form and the ledger, not of the rubric.

### A severity floor for the fixes

Fixing only findings at or above a severity was deferred on 2026-10-02 (D3 of the report on preferences and policies). A rubric makes such a floor easier to state, and this proposal does not add one.

### How the form presents the severities

How the summary counts the findings and where a minor finding goes are the review that reads as a report and #102 and #115. This proposal changes which findings land on each side of the line, not the line.

### A replay of merge-rank

`npm run replay` reruns the verifiers of a recorded run, not merge-rank. A replay of merge-rank would measure a rubric against recorded working lists at low cost, and is later work; the gate here is a real run.

## Requirements

### R1: Each severity has a test and one example

Merge-rank's role prompt defines each severity by what the finding costs once the change is merged as it is. `critical` is a harm that reaches every user or cannot be undone: data lost or corrupted, a hole in security, or the program or its build broken for everyone. `major` is a wrong result, a broken contract that a caller relies on, or a failure on a path that the change's users reach, which someone must fix before relying on the change. `minor` is a cost that falls on the next reader or the next change while the code does what every caller needs. Each test has one example, and a finding between two severities is settled by one question: would a reviewer who knew of it hold the merge for it.

The wording planned for `phase4-list.md`, in place of its sentence on the severity, is below. It is a prompt, so the implementation may still change its words, and the gate reads the prompt as built.

```
**Give each finding a severity** by what it costs once the change is
merged as it is. The engine puts a `critical` or `major` finding in the
body as what matters before the merge, and folds a `minor` one into a
table.

- `critical`: the harm reaches every user or cannot be undone: data is
  lost or corrupted, a hole in security opens, or the program or its
  build breaks for everyone. For example, a migration that drops a
  column the code still reads.
- `major`: the change gives a wrong result, breaks a contract that a
  caller relies on, or fails on a path its users reach, and someone
  must fix it before relying on the change. For example, an option
  renamed where it is defined that one caller still passes under its
  old name, so that caller's setting is silently ignored.
- `minor`: the code does what every caller needs, and the cost falls on
  the next reader or the next change. For example, two copies of a
  helper that the next change can let drift apart.

When a finding sits between two severities, ask whether a reviewer who
knew of it would hold the merge for it: held, `major`; merged and
followed up, `minor`.
```

### R2: What a severity is not graded by

The role prompt says that a severity is not graded by how sure the verdict is, how large the fix would be, which angle found the finding, or how old the code is. The verdict already says how sure; `rubrics.md` already says that the size of a fix decides no grade; the engine already uses the angle as a tiebreak below the severity. A severity that rose with certainty or fell with the size of the fix would count one fact twice, or count the wrong fact.

### R3: A convention violation is graded by its rule's reason

A `CONVENTIONS` violation is graded by the tests of R1, applied to what the rule's own reason says goes wrong when it is broken. A rule that states no reason gives its violation `minor`, unless breaking it also breaks behavior by R1. This replaces "takes the severity of the rule it breaks" in the role prompt and in the task, which pointed at a value that no rule carries.

### R4: The reason says what gave the severity

Merge-rank's `reason` for each finding says, in one sentence, which consequence of R1 gives its severity, and for a finding with members, the root cause they share. Today the task asks for a `reason` and says nothing of what it holds. The field is a string of up to 2,000 characters, so its shape does not change.

### R5: One text, held to the engine's list

The rubric is written once, in `phase4-list.md`. The task names the three values and tells merge-rank to give the severity "as your role prompt defines it", as the decider's task already says of its decisions, and drops its own sentence on convention violations. A test reads merge-rank's assembled role prompt and fails unless each value of `severities` in `src/review/vocabulary.ts` has exactly one line of the rubric, and the rubric has no other.

### R6: The gate

The gate is a real run (principle 12). deep-review reviews this pull request on Claude Code. Then the engine of this branch reviews again two changes whose reviews are public with their severities: the change of #96, on Claude Code in English, and the change of deep-review/click#1, on Codex in Korean, each with the base and the end its first review had.

The gate records, for each run, the count of findings at each severity before and after, and pairs the findings of the two reviews of each change by their location and their summary. For each pair whose severity differs, the author reads both findings and says which grade is right by the rubric and by their own judgment, and the record keeps their word. The gate also reads every `reason` of the two new runs and counts those that name a consequence of R1. A finding that has no pair is listed, not graded, since two runs of the same change do not find the same set.

## Product Decisions

### PD1: The tests follow what the engine does with each value

The line between `major` and `minor` is drawn where the engine draws it: a major finding is what the body calls "what matters before the merge", and a minor one is what it folds. So the test of `major` is a cost that someone must fix before relying on the change, and the tie question asks about holding the merge. The rubric's example of `minor` is the one the body already gives its reader, repeated code that the next change can let drift. The sentence posted to a reader is then the rule the ranker followed, which principle 2 asks of anything a person reads: it follows from what was decided.

### PD2: `critical` is narrow

The engine treats a critical finding as a major one everywhere but the order and the count "of them critical". A broad `critical` would add nothing a reader can act on and would dilute the one word that says "this is worse than the others". So its test names the harms that reach every user or that no later release undoes.

### PD3: One example each, from no particular repository

deep-review reviews any repository, so each example names a shape of defect common to code in general, not a file of this one. One example per severity anchors the test without becoming a list that merge-rank matches against; the test comes first and the example after.

### PD4: The rubric is in the role prompt, and the task points to it

The way to improve that this proposal answers reads "define the three severities in `phase4-list.md` and in merge-rank's task". Written twice, the rubric would be two texts that the next edit lets drift, as the two sentences on convention violations already say the same wrong thing in two places. The decider's task already says "decide each one as your role prompt defines it". The rubric is therefore defined in the fragment, and the task names the values and points to it. The test of R5 is what keeps the engine's list and the rubric together, in place of a second copy.

### PD5: The ground of a severity goes in the existing `reason`

A new field for the ground of a severity would be a new payload of `ranking.recorded`, so a new event version, a golden fixture and a fold for both versions. The `reason` is already the free text that merge-rank gives each finding and that the decider and the writer read as "merge and rank". Asking it to name the consequence gives the same record at no cost to the ledger.

### PD6: The posted words stay

`severityMeanings` already says what the rubric says, in English and Korean, and calls the severity a worker's judgment, which it remains. Changing the posted words would change what a reader of every review sees, for no gain once the ranker follows them.

### PD7: Rejected: the engine computes the severity

The engine could derive a severity from the angle and the verdict, deterministically and at no cost. The angle says where a finding came from, not what it costs: a `DUPLICATION` finding whose copies already disagree is a wrong result, and a correctness finding on a path no caller reaches is minor. Weighing a consequence in words is the model's work; the engine keeps the order it derives from the grade.

### PD8: Rejected: the verifier grades the severity

A verifier knows its candidate's evidence best, but it sees one candidate, and a severity is a property of the merged finding: three sites of one broken signature cost more than one. Merge-rank is the first worker that sees the merged finding, so the grade stays with it.

### PD9: Rejected: the rubric in `rubrics.md`

`rubrics.md` holds the rules every grading role shares, and eight roles name it. Only merge-rank gives a severity, so putting the rubric there would change seven other role prompts and their hashes for a rule none of them uses.

## Against the vision note

This proposal is read against the vision note of 2026-11-05.

### Principle 1, evidence, not trust

The severity was a value with no stated ground. With R4 each finding's `reason` names the consequence its grade rests on, so a reader of the ledger can check the grade against the finding without asking the ranker.

### Principle 2, record before action

The form already decides nothing about the severity, but it states a meaning that no worker was given. After this change, the judgment the form relies on is made by the worker that owns it, under the rule the form states, and recorded with its ground before the form reads it.

### Principles 5 and 6, the core first, easy to understand with little context

What reaches a reader first, the major findings in areas and "what matters before the merge", is chosen by the severity. A reader with little context cannot tell a grade from a guess; a stated test, the same one the body explains to them, makes the first screen mean what it says to every reader.

### Principle 10, answers are labels

The proposal departs from this principle. No answer in the ledger is about a severity, since a person answers questions and departures, not grades, so the ledger has no labels to measure the rubric against. The gate measures it against the author's reading of each grade that moved, which the principle calls an approximation. A later note can decide whether a person's correction of a severity becomes an answer.

### Principle 12, a real run is the gate

R6 is a real run on the two changes whose earlier reviews are public, on both runtimes, before the change is accepted.

## Risks

### The examples become the only pattern

A model given one example per severity may grade by resemblance to it. The tests come before the examples, and the gate reads the reasons of R4 for grades that name the example instead of a consequence.

### More findings become major

A rubric whose `major` is "someone must fix it before relying on the change" may move findings out of the folded table, and lengthen what a person reads, which the note's use counts against a proposal. The gate counts each severity before and after, and the author's reading of each moved grade says whether the move is right.

### A run started before the change cannot resume after it

A run pins the digest of its roles when it is configured, and a resume with other roles is refused with the action to name the old roles directory (`--roles <dir>`). Any edit of a role prompt has this effect, and it is accepted here as it was for every earlier edit of a fragment.

### Two runs of one change differ for reasons other than the rubric

The finders and verifiers of the two runs may surface other findings, and merge-rank may merge them otherwise. The gate pairs findings and grades only the pairs, and the author's word, not the count alone, is what the gate keeps.

## Verification

### Implementation

The commit "feat(review): Grade the severity of a finding by a stated rubric" implements R1 to R5. `roles/fragments/phase4-list.md` holds the rubric of R1 in the wording planned here, followed by one paragraph that carries the tie question, what a severity is not graded by (R2), the grading of a `CONVENTIONS` violation by its rule's reason (R3) and the ask that each `reason` name the consequence (R4). `mergeRankTask` in `src/review/tasks.ts` gives the severity "as your role prompt defines it", asks the `reason` of R4 and no longer says that a violation takes the severity of its rule (R5).

The test of R5 in `test/roles/repository.test.ts` reads `phase4-list.md`, which a test of the same file shows merge-rank's prompt is assembled from, and holds its rubric lines to the values of `severities` in order; renaming one line's severity makes it fail. It follows the decider's test that holds the leave reasons to the engine's list. The test of the task in `test/review/tasks.test.ts` holds the new sentence and the absence of the old one. `npm run build` rebuilt both plugins, whose fragment, engine and bundle hash changed, and `npm run check` passed at the commit.

### The gate (R6)

The gate ran once with the first rubric, the three tests and the tie question of R1, by the engine built from the branch of #121 at its implementation, with Claude Code 2.1.310 and Codex 0.164.0 on Linux. Each run had its own clone, and no review was posted. The reports of the three runs are kept by the author outside the repository; the numbers below are theirs.

The review of #121 ran with `--pr` on Claude Code over 3 commits and 6 files from the merge base with main, with 6 more paths left out by `scope.exclude`. It took 16 minutes and 10.12 USD, and found 16 findings: 0 critical, 4 major and 12 minor. Its four major findings and its question are about the rubric itself: the role prompt narrows R3's exception from a consequence of R1 to "breaks behavior"; the reason of a rule that R3 grades by is not in the working list, since a finder quotes only the rule; the posted `severityMeanings` calls a wrong message minor while the rubric's `major` names a wrong result; and no test covers a cost that users pay at run time while every result is right, which the run asks the author about.

The review of #96 again ran on Claude Code over the scope its first review had, 27 commits and 91 files from the merge base 89e5499e to the head that its posted review names, with 115 more paths left out by `scope.exclude`. Since #96 is merged and `--pr` refuses a merged pull request, it ran with `--from 89e5499e --to HEAD --merge-base`, which has no writer; the writer reads no severity, so the measure is the same. It took 43 minutes and 29.84 USD. The first review had 30 findings, 0 critical, 11 major and 19 minor; this one has 33, 1 critical, 17 major and 15 minor. Ten pairs share a location and a summary, and none of them moved: the continuation that matches no pull request, `publish` running the recorded `gh`, a 5xx read as a refusal, the cleaning with the publish command's environment, the URL of a renamed repository (all major), and the misplaced docstring, the rate limit read as missing access, the marker defined twice, the formatter defined twice and the 401 or 404 with no action (all minor).

Of #96, 20 findings of the first review have no pair, 6 major (the UNC pattern that eats escapes, secret values hidden inside words, the diagram label locator, the node walker over edge text, the model names that skip the cleaning, the diagrams checked before the cleaning) and 14 minor. Of the second, 23 have no pair: 1 critical (a PGP private key block that the cleaning does not know), 12 major (a home path with a space, `publish` moving its run to the front, a writer that passes and is recorded degraded, a writer paid for on a `--path` run, a dirty tree under a pull request, `--pr N` matching any repository, the `gh` credentials a worker can still reach, a settle that lists the reviews once, a subgraph title never checked, the tokens stripped after the run opens, a 4xx read as a refusal that posted nothing, secrets of names the cleaning does not match) and 10 minor. The first review's diagram finding and the second's subgraph title and entity check overlap in part, as do the secret values of the first and the unmatched names of the second, and they are listed, not paired.

The review of deep-review/click#1 again ran with `--pr` on Codex 0.164.0 with `--concurrency 2`, over the change its first review had: 1 commit and 4 files from the merge base 9dd417f6 to 976ab180, with `review.language = "ko"` from the repository's file. It took about 23 minutes and met no limit of Codex. Its writer failed twice on the `mcp_tool_call` that the gate of the review on the pull request recorded for Codex 0.166.0, so the explanation was degraded with its 10 parts dropped; merge-rank ran before it and is not touched. The first review had 18 findings, 0 critical, 6 major and 12 minor; this one has 17, 0 critical, 6 major and 11 minor. Fourteen pairs share a location and a summary. Twelve kept their severity: the raw byte replacement that corrupts multibyte input, the filtered chunk read as end of input and the `readinto` that bypasses the filter (major), and nine findings of duplicated code (minor). Two moved from minor to major: the visible prompt that does not show the caret echo the documentation promises (before 7 at `src/click/testing.py:66`, after 4 at `:68`), and the prompt interrupted by end of input that leaves the echo paused (before 8 at `:101`, after 5 at `:100`).

Of click#1, 4 findings of the first review have no pair: the `getchar` adapter that returns an empty character instead of raising `EOFError`, the `readlines` with no size hint and the wrapper that fails under `next()` (major), and the abort message printed before the prompt (minor). Three of the second have none: filtering while the echo is paused, which changes what `getchar` and a hidden prompt return and shares a symptom with the first of these (major), a conditional expression against `docs/contributing.md` (minor) and two copies of the echo and filter policy (minor).

Every `reason` of the two runs again names a consequence: 33 of 33 on #96 and 17 of 17 on click#1. On #96, one names a consequence outside the tests of R1, the wasted cost of a writer whose text no command can show; one lowers a grade because the change does not create the defect, which R2 says decides nothing; and three repeat the words of the example of `minor`, each on a helper that the change does copy. Of the four findings whose consequence is a secret posted in public, one is critical as "a security hole that cannot be undone" and three are major, one of them as "public and cannot be undone"; two findings of a review posted twice, which cannot be taken back, are major. On click#1 none repeats an example, and the conditional expression is graded by what its rule's own reason says goes wrong, as R3 asks.

The two pairs that moved were put to the author with both findings and the new reasons. The author did not grade them one by one, and judged the rubric instead: it is a feeling, and it gives no independent dimensions that can be applied consistently. The gate does not pass. The report [How other fields grade severity, and what a review can take from them](../reports/2026-11-05-severity-across-fields.md) reads how other fields make a grade repeatable and proposes the structure that the second rubric follows, and the gate runs again with it.
