# Change Proposal: A rubric for the severity of a finding

## Summary

Merge-rank, the worker that folds the verified findings of a review that share one root cause, gives each finding a severity: `critical`, `major` or `minor`. No prompt says what makes a finding one or the other. The engine still treats the value as the key of what a reader sees: a critical or major finding goes in the body as what matters before the merge, and a minor one is folded into a table. The report [`2026-11-05-review-written-and-read.md`](../reports/2026-11-05-review-written-and-read.md) names this as the largest judgment of the review that has no stated rule (W1), and puts a rubric first among its ways to improve.

After this change, merge-rank gives each finding three values, each a fact of its evidence with one example: its effect, what happens when the defect occurs; its reach, who meets it; and its recovery, what follows once it has happened. It reads the severity from a table of effect and reach, moved one step by recovery, and the role prompt says what a severity is not graded by. A `CONVENTIONS` violation takes its effect from what its rule's own reason says goes wrong. Merge-rank's `reason` for each finding names its three values and the fact that gives each. The structure follows the report [How other fields grade severity, and what a review can take from them](../reports/2026-11-05-severity-across-fields.md), which the first gate of this proposal asked for. Its task names the severity as the role prompt defines it, so the rubric is one text. The change edits one role prompt fragment and one task, which changes merge-rank's role prompt and its hash, and the sentence of the posted review that explains the severity (PD6); no event or schema changes.

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

### A severity chosen whole is a feeling

The first rubric of this proposal defined each severity by a few consequences in words, and settled a finding between two by asking whether a reviewer who knew of it would hold the merge. Its gate, recorded under Verification, graded one consequence two ways in one run: of four findings whose consequence is a secret posted in public, one was `critical` as "a security hole that cannot be undone" and three were `major`. It moved two different defects of one change together, one met by any documented use and one only by a caller that catches an abort and reads on, since the rubric had no value for how a defect is met. Every `reason` named a consequence, and none could say which value gave the grade, since the rubric had none. The author judged that the rubric is a feeling and gives no independent dimensions that can be applied consistently. Fields that grade defects for a living reached the same conclusion long ago: a severity chosen whole disagrees with itself about half the time, and a repeatable grade comes from a few axes, each answered by a fact, combined by a table (F1, F2 and F7 of the report).

## Goals

A severity follows from values that the ranker is given, each answered by a fact of the finding's evidence, and from a table that the ranker reads, not from a judgment of the whole. A reader of the ledger can see from each finding's `reason` the value of each axis and the fact behind it, and check the severity against the table. The rubric has one text, and a test fails when the severities of the engine and the rubric's table stop matching.

## Non-Goals

### NG1: The set of severities and the engine's order

The three values and the order the engine derives from them (TD9 of the read-only review) stay. A fourth value, or a fold of `critical` into `major`, is a change of the form and the ledger, not of the rubric.

### NG2: A severity floor for the fixes

Fixing only findings at or above a severity was deferred on 2026-10-02 (D3 of the report on preferences and policies). A rubric makes such a floor easier to state, and this proposal does not add one.

### NG3: A repository's own table

Which cells of the table hold the merge is a rule about the risks a repository accepts, and principle 4 of the vision note gives such rules to the person (V7 of the report; SSVC decides by stakeholder for the same reason). The engine ships one table here, and a setting that lets a repository state its own, or the cells that hold the merge, belongs with the severity floor of D3.

### NG4: How the form presents the severities

How the summary counts the findings and where a minor finding goes are the review that reads as a report and #102 and #115. This proposal changes which findings land on each side of the line, not the line.

### NG5: A replay of merge-rank

`npm run replay` reruns the verifiers of a recorded run, not merge-rank. A replay of merge-rank would measure a rubric against recorded working lists at low cost, and is later work; the gate here is a real run.

### NG6: Whether the change introduced a defect decides the form

A reviewer often lets a change through when it only finds a defect that was there before, and asks for a fix only of what the change made or made worse (V6 of the report). Letting the origin keep a finding out of what matters before the merge would change the line that the form draws, and is a proposal of its own. This proposal records the origin, so that proposal can count how often it would apply.

## Requirements

### R1: A severity is read from three values and a table

Merge-rank gives each finding three values, each answered by a fact of the finding's evidence. Its effect is what happens when the defect occurs: `loss`, data lost or corrupted or a secret reaching someone who must not have it; `wrong`, a wrong result, a broken contract or a failure of what the change promises, a cost past a bound that the code or its documents state included; `degraded`, the right outcome reached at a cost, such as a message that misleads its reader a little or work slower than it needs to be, while a message that leads its reader into a mistake with a wrong result or a loss takes the effect of that mistake (PD16); or `none`, right behavior with a cost on the next reader or the next change. Its reach is who meets it: `always`, every use of what the change adds or alters; `ordinary`, a use that the documents, the tests or a caller in the repository make, under a condition, with input that an outside party controls counted here; or `contrived`, only an input or sequence that no documented use makes, or a later change. Its recovery is what follows once it has happened: `visible`, seen at once and undone or worked around by the person who meets it; `operator`, seen, but undone only by a maintainer, an operator or a fix; or `silent`, unseen or beyond undoing.

The severity is read from a table of effect and reach, then raised one step by `silent` or lowered one step by `visible`. `silent` does not raise an effect of `degraded`, and an effect of `none` stays `minor` (PD16). When two values of one axis both fit, merge-rank takes the lower and names the other in the reason. Each value has one example. The tie question of the first rubric, whether a reviewer would hold the merge, goes: the decision a severity feeds is not a test of the severity.

The wording planned for `phase4-list.md`, in place of its sentences on the severity and the tie, is below. It is a prompt, so the implementation may still change its words, and the gate reads the prompt as built.

```
**Give each finding a severity** in two steps: give it three values,
then read its severity from the table below. Each value is a fact of
the finding's evidence; when two values of one axis both fit, take the
lower and name the other in the reason.

Effect, what happens when the defect occurs:

- `loss`: data is lost or corrupted, or a secret or private data
  reaches someone who must not have it. For example, a log line that
  prints the user's token.
- `wrong`: a caller gets a wrong result, a contract it relies on
  breaks, or an operation the change promises fails: an error, a
  refusal, a hang, or a cost past a bound the code or its documents
  state. For example, an option renamed where it is defined that one
  caller still passes under its old name, so that caller's setting is
  silently ignored.
- `degraded`: the caller still reaches the right outcome, at a cost: a
  misleading message, a missing next step, or work slower than it
  needs to be within any stated bound. For example, a refusal that
  names the wrong file while it still refuses as it should.
- `none`: the behavior is right, and the cost falls on the next reader
  or the next change. For example, two copies of a helper that the
  next change can let drift apart.

Reach, who meets it:

- `always`: every use of what the change adds or alters. For example,
  a step that runs on every invocation.
- `ordinary`: a use that the documents, the tests or a caller in the
  repository make, under a condition such as an option, an input or a
  failure from outside. Input that an outside party controls is
  ordinary. For example, a flag that the README shows.
- `contrived`: only an input or a sequence that no documented use
  makes, or a later change. For example, a caller that catches an
  internal error and goes on as if it had not happened.

Recovery, what follows once it has happened:

- `visible`: the person who meets it sees it at once and can undo it
  or work around it alone. For example, a refusal that names the
  action to take.
- `operator`: it is seen, but undoing it needs a maintainer, an
  operator or a fix. For example, a crash that stops the command.
- `silent`: no one is told, or it cannot be undone. For example, a
  result written wrong with no error.

| effect \ reach | always   | ordinary | contrived |
|----------------|----------|----------|-----------|
| `loss`         | critical | critical | major     |
| `wrong`        | critical | major    | minor     |
| `degraded`     | major    | minor    | minor     |
| `none`         | minor    | minor    | minor     |

Then `silent` raises the severity one step and `visible` lowers it one
step; `operator` leaves it. An effect of `degraded` never reaches
`critical`, and an effect of `none` stays `minor`. The engine puts a
`critical` or `major` finding in the body as what matters before the
merge, and folds a `minor` one into a table.
```

### R2: What a severity is not graded by

The role prompt says that a severity is not graded by how sure the verdict is, how large the fix would be, which angle found the finding, or how old the code is. The verdict already says how sure; `rubrics.md` already says that the size of a fix decides no grade; the engine already uses the angle as a tiebreak below the severity. A severity that rose with certainty or fell with the size of the fix would count one fact twice, or count the wrong fact.

Nor is a severity graded by whether the change introduced the defect, made it worse or found it there: the severity grades the harm, and whether a harm that was already there should hold the merge is a decision about it (F5 of the report). The reason records the origin instead (R4). A ranker of the first gate lowered a grade because the change did not create the defect, which the first rubric already forbade by the age of the code; naming the origin as a fact to record, not a ground to grade by, gives that observation a place.

### R3: A convention violation takes its effect from its rule's reason

A `CONVENTIONS` violation takes its effect from what the rule's own reason says goes wrong when it is broken, or `none` when the rule states no reason, and its reach and recovery as any finding does. When breaking the rule also has a larger effect of R1, whether or not the rule states a reason, the violation takes that one. This replaces "takes the severity of the rule it breaks" in the role prompt and in the task, which pointed at a value that no rule carries.

### R4: The reason names each value

Merge-rank's `reason` for each finding names its effect, its reach and its recovery, each with the fact of the evidence that gives it; its origin, whether the change introduced the defect, made it worse or found it there; and for a finding with members, the root cause they share. Today the task asks for a `reason` and says nothing of what it holds. The field is a string of up to 2,000 characters, so its shape does not change.

### R5: One text, held to the engine's list

The rubric is written once, in `phase4-list.md`. The task names the three severities and tells merge-rank to give the severity and the `reason` "as your role prompt defines it", as the decider's task already says of its decisions, and drops its own sentence on convention violations and its own list of what a reason holds. A test reads the rubric's table in the fragment that merge-rank's role prompt is assembled from, and fails unless every cell of the table is a value of `severities` in `src/review/vocabulary.ts` and every value of `severities` is in a cell.

### R6: The gate

The gate is a real run (principle 12). deep-review reviews this pull request on Claude Code. Then the engine of this branch reviews again two changes whose reviews are public with their severities: the change of #96, on Claude Code in English, and the change of deep-review/click#1, on Codex in Korean, each with the base and the end its first review had.

The gate records, for each run, the count of findings at each severity before and after, and pairs the findings of the two reviews of each change by their location and their summary. For each pair whose severity differs, the author reads both findings and says which grade is right by the rubric and by their own judgment, and the record keeps their word. The gate also reads every `reason` of the two new runs, counts those that name the three values of R1 each with its fact, and counts those whose values and severity disagree with the table, the measure of consistency that a severity chosen whole cannot have. A finding that has no pair is listed, not graded, since two runs of the same change do not find the same set.

The gate ran once with the first rubric, three tests and a tie question, and did not pass; Verification records it. It runs again, on the same three changes, with the rubric of R1 as it stands.

## Product Decisions

### PD1: The values are facts, and the severity is read from them

Each axis asks one question that the evidence of a finding answers: what happens when the defect occurs, who meets it, and what follows once it has happened. These are the three questions on which safety and quality fields grade a defect (ISO 26262's severity, exposure and controllability, FMEA's severity, occurrence and detection; F1 of the report), and each can be checked against the evidence alone. The severity is then read, not judged: the ranker's judgment goes into three narrow answers, and the table turns them into the grade the same way every time. The line between `major` and `minor` is still drawn where the engine draws it, between what the body calls "what matters before the merge" and what it folds, and the table's cells say which combinations fall on each side.

### PD2: `critical` is narrow

The engine treats a critical finding as a major one everywhere but the order and the count "of them critical". A broad `critical` would add nothing a reader can act on and would dilute the one word that says "this is worse than the others". So the table gives `critical` only to a loss that a documented use can cause, to a wrong result on every use, and to a `major` wrong result or loss that no one sees or no one can undo; a `degraded` or `none` effect never reaches it.

### PD3: One example for each value, from no particular repository

deep-review reviews any repository, so each example names a shape of defect common to code in general, not a file of this one. One example for each value of each axis anchors the value without becoming a list that merge-rank matches against; the definition comes first and the example after. The examples of `wrong` and `none` are those of the first rubric's `major` and `minor`, and the example of `none` is the one the body already gives its reader, repeated code that the next change can let drift.

### PD4: The rubric is in the role prompt, and the task points to it

The way to improve that this proposal answers reads "define the three severities in `phase4-list.md` and in merge-rank's task". Written twice, the rubric would be two texts that the next edit lets drift, as the two sentences on convention violations already say the same wrong thing in two places. The decider's task already says "decide each one as your role prompt defines it". The rubric is therefore defined in the fragment, and the task names the values and points to it. The test of R5 is what keeps the engine's list and the rubric together, in place of a second copy.

### PD5: The ground of a severity goes in the existing `reason`

A new field for the ground of a severity would be a new payload of `ranking.recorded`, so a new event version, a golden fixture and a fold for both versions. The `reason` is already the free text that merge-rank gives each finding and that the decider and the writer read as "merge and rank". Asking it to name the consequence gives the same record at no cost to the ledger.

### PD6: The posted words say what makes a message minor

`severityMeanings` says that a critical or major finding is what matters before the merge and that a minor one is smaller, in English and Korean, and calls the severity a worker's judgment, which it remains. Its example of a minor finding was "a wrong message or repeated code that the next change can let drift", which the table did not hold to: a misleading message met on every use, or one that no one notices, read major. The review of this change asked whether to keep the sentence or drop the example, and the author answered neither: the sentence says what decides. A minor finding is now "such as a message that misleads its reader only a little or repeated code that the next change can let drift", and "a message that leads its reader into a serious mistake is graded by that mistake", in both languages, as the role prompt grades it (PD16). Repeated code is `none`, which always stays `minor`. Every posted review's body changes by this sentence.

### PD7: Rejected: the engine computes the severity

The engine could derive a severity from the angle and the verdict, deterministically and at no cost. The angle says where a finding came from, not what it costs: a `DUPLICATION` finding whose copies already disagree is a wrong result, and a correctness finding on a path no caller reaches is minor. Weighing a consequence in words is the model's work; the engine keeps the order it derives from the grade.

### PD8: Rejected: the verifier grades the severity

A verifier knows its candidate's evidence best, but it sees one candidate, and a severity is a property of the merged finding: three sites of one broken signature cost more than one. Merge-rank is the first worker that sees the merged finding, so the grade stays with it.

### PD9: Rejected: the rubric in `rubrics.md`

`rubrics.md` holds the rules every grading role shares, and eight roles name it. Only merge-rank gives a severity, so putting the rubric there would change seven other role prompts and their hashes for a rule none of them uses.

### PD10: A table, not a score

The values are combined by a table, as ISO 26262 reads its integrity level and as the FMEA handbook of 2019 reads its action priority, not by a sum or a product of ratings. FMEA replaced its product of three ratings, and Microsoft its DREAD score, because the arithmetic was not consistent (F2 of the report): a product of ordinal numbers weighs every axis alike and gives one number to combinations that mean different things. A table can be read by a person, argued with cell by cell and changed one cell at a time, and the step of recovery is the one rule beside it, as Chromium lowers a grade for a precondition (F3).

### PD11: Recovery is its own axis

The first rubric put "cannot be undone" in `critical`, and its gate applied the phrase to one leak of a secret and not to three others (G1 of the report). Whether a harm is seen and can be undone is a different question from how bad it is: ISO 26262 asks it as controllability, FMEA as detection, CVSS as recovery, Mozilla as whether a workaround exists. As its own axis it moves a finding one step, and the size of the harm stays with the effect; `silent` does not raise a `degraded` effect (PD16).

### PD12: Rejected: the quality that suffers as a fourth value

SonarQube gives a severity for each quality a rule affects, and IBM's Orthogonal Defect Classification records the quality that suffers as its own attribute (F4 of the report). The form reads one severity per finding, so a severity per quality would need a rule to pick one, and a fourth value that no table cell reads would have no reader. The quality instead helps choose the effect: a slowdown is `degraded` while it stays within a bound that the code or its documents state, and `wrong` past it, and a secret posted in public is `loss`.

### PD13: Rejected: keep the tie question

"Would a reviewer who knew of it hold the merge" asks the decision that the severity feeds as the test of the severity, and each ranker answers it from its own sense of a reviewer (G4 of the report). It also cannot reach `critical`, as the review of #121 found. With three values, a finding between two grades sits between two values of one axis, and the rule to take the lower value and name the other settles it on a fact the reason states.

### PD14: The origin is recorded, not graded

IBM's Orthogonal Defect Classification records the age of the code a defect sits in as an attribute that grades nothing (F4 of the report), and Bugzilla and SSVC keep the grade of a harm apart from what to do about it (F5). The origin of a defect is the reviewer's question of whether to hold the merge for it, not a part of how bad it is, so it goes in the reason beside the three values and moves no cell. Recording it costs one clause of a string that already exists, and gives the proposal that may let it decide the form a count to start from.

### PD15: Rejected for now: the values as fields, and the engine reads the table

The three values could be fields of each finding in `ranking.recorded`, and the engine could read the severity from the table itself, so that no ranker can read it wrong and a reader can filter findings by value. That is a new version of the event, a golden fixture and a fold for both versions (PD5), and it would make the table code, which the next change of a cell then reaches. The values go in the `reason` first, where the gate can count how often a ranker's grade disagrees with its own values; if that count is not small, the fields are the next change, with the measure that asks for them.

### PD16: A message is graded by the mistake it leads to, and going unnoticed makes no cost larger

The rubric listed a misleading message under `degraded`, and `silent` raised one that no one notices to major whatever it misled its reader into. The author holds that a finding is major for the harm it does, not for going unnoticed alone, and that a message differs by what it makes its reader do: a small misunderstanding is small, and a message that leads someone into a serious mistake is not. So a message is `degraded` when the person it misleads still reaches the right outcome, and one that leads them into a mistake with a wrong result or a loss takes the effect of that mistake. `silent` raises no `degraded` effect, so such a finding reads major only on every use, and `visible` still lowers it; work slower than it needs to be, also `degraded`, moves the same way. A `wrong` result or a `loss` that no one notices is still raised, since there the harm grows while no one acts. This changes cells of the table that the second gate read: `degraded` at an ordinary reach with `silent` reads `minor`, not `major`, The caret echo of click#1, which that gate graded `degraded`, `ordinary` and `silent` and the author judged major, stays major only as `wrong`, a behavior its documentation promises that does not happen, as the report's table of the gate's cases predicted; graded `degraded` as in that gate, it would now read `minor`.

## Against the vision note

This proposal is read against the vision note of 2026-11-05.

### Principle 1, evidence, not trust

The severity was a value with no stated ground. With R4 each finding's `reason` names the three values its grade is read from, each with its fact, so a reader of the ledger can check each value against the evidence and the grade against the table without asking the ranker.

### Principle 2, record before action

The form already decides nothing about the severity, but it states a meaning that no worker was given. After this change, the judgment the form relies on is made by the worker that owns it, under the rule the form states, and recorded with its ground before the form reads it.

### Principles 5 and 6, the core first, easy to understand with little context

What reaches a reader first, the major findings in areas and "what matters before the merge", is chosen by the severity. A reader with little context cannot tell a grade from a guess; a grade read from stated values by a table, which agrees with what the body explains to them, makes the first screen mean the same thing in every review.

### Principle 10, answers are labels

The proposal departs from this principle. No answer in the ledger is about a severity, since a person answers questions and departures, not grades, so the ledger has no labels to measure the rubric against. The gate measures it against the author's reading of each grade that moved, which the principle calls an approximation, and against the table itself, by counting the reasons whose values and grade disagree, which needs no label. A later note can decide whether a person's correction of a severity, or of one of its values, becomes an answer.

### Principle 12, a real run is the gate

R6 is a real run on the two changes whose earlier reviews are public, on both runtimes, before the change is accepted.

## Risks

### RK1: The examples become the only pattern

A model given one example per value may choose a value by resemblance to it. The definitions come before the examples, and the gate reads the reasons of R4 for values that name the example instead of a fact.

### RK2: More findings become major

A table may put more findings above the folded table than the ranker's sense did, and lengthen what a person reads, which the note's use counts against a proposal. The gate counts each severity before and after, and the author's reading of each moved grade says whether the move is right; a cell that moves too much is changed on its own.

### RK3: Three values are more to give than one

A ranker that gives three values and reads a table can still give a value the evidence does not bear out, or read the table wrong. The first is checked by the fact the reason names beside each value; the second is counted by the gate, and if it is common, the engine can read the table itself from values recorded as fields, which is a later change of the ledger.

### RK4: The cells are a judgment

Which combination is `major` is the author's choice, as each cell of ISO 26262's table was its committee's. The gate shows each cell's effect only on the findings the runs produce, and a cell that no finding reaches is not tested by it.

### RK5: A run started before the change cannot resume after it

A run pins the digest of its roles when it is configured, and a resume with other roles is refused with the action to name the old roles directory (`--roles <dir>`). Any edit of a role prompt has this effect, and it is accepted here as it was for every earlier edit of a fragment.

### RK6: Two runs of one change differ for reasons other than the rubric

The finders and verifiers of the two runs may surface other findings, and merge-rank may merge them otherwise. The gate pairs findings and grades only the pairs, and the author's word, not the count alone, is what the gate keeps.

## Verification

### Implementation

The commit "feat(review): Grade the severity of a finding by a stated rubric" implements the first rubric, three tests and a tie question, which R1 held before the gate. The commit "feat(review): Read a severity from three values and a table" implements R1 as it stands, with R2 to R5 as amended. In the first of these commits, `roles/fragments/phase4-list.md` holds the first rubric in the wording then planned, followed by one paragraph that carries the tie question, what a severity is not graded by (R2), the grading of a `CONVENTIONS` violation by its rule's reason (R3) and the ask that each `reason` name the consequence (R4). `mergeRankTask` in `src/review/tasks.ts` gives the severity "as your role prompt defines it", asks the `reason` of R4 and no longer says that a violation takes the severity of its rule (R5).

The test of R5 in `test/roles/repository.test.ts` reads `phase4-list.md`, which a test of the same file shows merge-rank's prompt is assembled from, and holds its rubric lines to the values of `severities` in order; renaming one line's severity makes it fail. It follows the decider's test that holds the leave reasons to the engine's list. The test of the task in `test/review/tasks.test.ts` holds the new sentence and the absence of the old one. `npm run build` rebuilt both plugins, whose fragment, engine and bundle hash changed, and `npm run check` passed at the commit.

In that later commit, `phase4-list.md` holds the rubric of R1 in the wording planned here: the three axes with one example for each value, the table, the step of recovery and the rule for two values that both fit, followed by one paragraph that carries what a severity is not graded by, the origin included (R2), the effect of a `CONVENTIONS` violation from its rule's reason (R3) and the ask that each `reason` name the three values with their facts and the origin (R4). `mergeRankTask` asks for a `reason` that names the values the role prompt gives the severity from, each with its fact, and the defect's origin.

The test of R5 now reads the rubric's table: it holds the values of the three axes to their lists in order, the table's rows to the four effects, and its twelve cells to the values of `severities`, each cell a severity and each severity in a cell; renaming one cell to a value outside `severities` makes it fail. The test of the task holds its new sentence. `npm run build` rebuilt both plugins, and `npm run check` and `npm run verify` passed at the commit.

### The gate (R6)

The gate ran once with the first rubric, the three tests and the tie question of R1, by the engine built from the branch of #121 at its implementation, with Claude Code 2.1.310 and Codex 0.164.0 on Linux. Each run had its own clone, and no review was posted. The reports of the three runs are kept by the author outside the repository; the numbers below are theirs.

The review of #121 ran with `--pr` on Claude Code over 3 commits and 6 files from the merge base with main, with 6 more paths left out by `scope.exclude`. It took 16 minutes and 10.12 USD, and found 16 findings: 0 critical, 4 major and 12 minor. Its four major findings and its question are about the rubric itself: the role prompt narrows the exception of R3 from a consequence of the first rubric to "breaks behavior"; the reason of a rule that R3 grades by is not in the working list, since a finder quotes only the rule; the posted `severityMeanings` calls a wrong message minor while the rubric's `major` names a wrong result; and no test covers a cost that users pay at run time while every result is right, which the run asks the author about.

The review of #96 again ran on Claude Code over the scope its first review had, 27 commits and 91 files from the merge base 89e5499e to the head that its posted review names, with 115 more paths left out by `scope.exclude`. Since #96 is merged and `--pr` refuses a merged pull request, it ran with `--from 89e5499e --to HEAD --merge-base`, which has no writer; the writer reads no severity, so the measure is the same. It took 43 minutes and 29.84 USD. The first review had 30 findings, 0 critical, 11 major and 19 minor; this one has 33, 1 critical, 17 major and 15 minor. Ten pairs share a location and a summary, and none of them moved: the continuation that matches no pull request, `publish` running the recorded `gh`, a 5xx read as a refusal, the cleaning with the publish command's environment, the URL of a renamed repository (all major), and the misplaced docstring, the rate limit read as missing access, the marker defined twice, the formatter defined twice and the 401 or 404 with no action (all minor).

Of #96, 20 findings of the first review have no pair, 6 major (the UNC pattern that eats escapes, secret values hidden inside words, the diagram label locator, the node walker over edge text, the model names that skip the cleaning, the diagrams checked before the cleaning) and 14 minor. Of the second, 23 have no pair: 1 critical (a PGP private key block that the cleaning does not know), 12 major (a home path with a space, `publish` moving its run to the front, a writer that passes and is recorded degraded, a writer paid for on a `--path` run, a dirty tree under a pull request, `--pr N` matching any repository, the `gh` credentials a worker can still reach, a settle that lists the reviews once, a subgraph title never checked, the tokens stripped after the run opens, a 4xx read as a refusal that posted nothing, secrets of names the cleaning does not match) and 10 minor. The first review's diagram finding and the second's subgraph title and entity check overlap in part, as do the secret values of the first and the unmatched names of the second, and they are listed, not paired.

The review of deep-review/click#1 again ran with `--pr` on Codex 0.164.0 with `--concurrency 2`, over the change its first review had: 1 commit and 4 files from the merge base 9dd417f6 to 976ab180, with `review.language = "ko"` from the repository's file. It took about 23 minutes and met no limit of Codex. Its writer failed twice on the `mcp_tool_call` that the gate of the review on the pull request recorded for Codex 0.166.0, so the explanation was degraded with its 10 parts dropped; merge-rank ran before it and is not touched. The first review had 18 findings, 0 critical, 6 major and 12 minor; this one has 17, 0 critical, 6 major and 11 minor. Fourteen pairs share a location and a summary. Twelve kept their severity: the raw byte replacement that corrupts multibyte input, the filtered chunk read as end of input and the `readinto` that bypasses the filter (major), and nine findings of duplicated code (minor). Two moved from minor to major: the visible prompt that does not show the caret echo the documentation promises (before 7 at `src/click/testing.py:66`, after 4 at `:68`), and the prompt interrupted by end of input that leaves the echo paused (before 8 at `:101`, after 5 at `:100`).

Of click#1, 4 findings of the first review have no pair: the `getchar` adapter that returns an empty character instead of raising `EOFError`, the `readlines` with no size hint and the wrapper that fails under `next()` (major), and the abort message printed before the prompt (minor). Three of the second have none: filtering while the echo is paused, which changes what `getchar` and a hidden prompt return and shares a symptom with the first of these (major), a conditional expression against `docs/contributing.md` (minor) and two copies of the echo and filter policy (minor).

Every `reason` of the two runs again names a consequence: 33 of 33 on #96 and 17 of 17 on click#1. On #96, one names a consequence outside the first rubric's tests, the wasted cost of a writer whose text no command can show; one lowers a grade because the change does not create the defect, which R2 says decides nothing; and three repeat the words of the example of `minor`, each on a helper that the change does copy. Of the four findings whose consequence is a secret posted in public, one is critical as "a security hole that cannot be undone" and three are major, one of them as "public and cannot be undone"; two findings of a review posted twice, which cannot be taken back, are major. On click#1 none repeats an example, and the conditional expression is graded by what its rule's own reason says goes wrong, as R3 asks.

The two pairs that moved were put to the author with both findings and the new reasons. The author did not grade them one by one, and judged the rubric instead: it is a feeling, and it gives no independent dimensions that can be applied consistently. The gate does not pass. The report [How other fields grade severity, and what a review can take from them](../reports/2026-11-05-severity-across-fields.md) reads how other fields make a grade repeatable and proposes the structure that the second rubric follows, and the gate runs again with it.

The gate ran a second time with the rubric of R1 as amended, the three values, the table and the step of recovery, by the engine built from the commit "feat(review): Read a severity from three values and a table", with Claude Code 2.1.310 and Codex 0.166.0 on Linux; Codex had moved on from the 0.164.0 of the first gate. Each run again had its own fresh clone, and no review was posted. The reports of the three runs are kept by the author outside the repository; the numbers below are theirs.

The review of #121 ran with `--pr` on Claude Code over 9 commits and 7 files from the merge base with main, with 6 more paths left out by `scope.exclude`. Its scope is not the first gate's 3 commits and 6 files, since the report on other fields, the record of the first gate, three amendments of this proposal and the implementation of the second rubric had been added. It took 22 minutes and 15.68 USD, and found 21 findings: 0 critical, 5 major and 16 minor. Its five major findings are about the rubric itself: a rule that its source marks as required but gives no reason for is graded `none`, which the run asks the author about; input that an outside party controls fits both `ordinary` and `contrived`, and the rule to take the lower then makes it `contrived`; the reason of a rule that R3 grades by is not in the working list, as the first gate found; "take the lower" gives no order on recovery, whose values are listed least severe first; and the rubric does not say which values a merged finding takes when its members differ. Among its minor findings, `silent` fits every secret posted in public, so the cell of `loss` and `contrived` never applies to one; the step does not say what `silent` does to a cell that is already `critical`; and the example of `wrong` reads as `critical` under the rubric's own definitions.

The review of #96 ran on Claude Code over the scope of the first gate, 27 commits and 91 files from the merge base 89e5499e to the head that its posted review names, with 115 more paths left out by `scope.exclude`, again with `--from 89e5499e --to HEAD --merge-base`, which has no writer. It stopped once in verification at the five-hour usage limit of Claude, and the same command resumed it after the reset, as the refusal named; it took about 47 minutes of work and 32.01 USD in all. The first review had 30 findings, 0 critical, 11 major and 19 minor; the first gate had 33, 1 critical, 17 major and 15 minor; this one has 41, 1 critical, 9 major and 31 minor. Thirteen pairs share a location and a summary with the first review. Eleven kept their severity: the values of secret-looking names redacted inside ordinary words, the cleaning with the publish command's environment and the URL of a renamed repository (major), and the misplaced docstring, the formatter defined twice, the git processes spawned per path, the 404 that gets the account advice, `refusingGitHub` written twice, the repository name formatted to be parsed back, the type defined twice and the merge-base read repeated (minor). Two moved: the `--fix` continuation that never checks the pull request, from major to critical, and the excluded section that posts the patterns uncleaned, from minor to major.

Of #96, 17 findings of the first review have no pair, 7 major (the UNC pattern that eats escapes, `publish` running the recorded `gh`, the diagram label locator, the node walker over edge text, a 5xx read as a refusal, the model names that skip the cleaning, the diagrams checked before the cleaning) and 10 minor. Of the second, 28 have none, 5 major (the changed `gh` settings that are no longer reported though the run records them, the path lookbehind that refuses `>` and `-` before a path, the continuation that skips the re-check under the lock, a mention after `.` or `/` that stays live, the closed list of token forms) and 23 minor. The recorded `gh` of the first review and the unreported settings of the second, the diagram findings of the first and the partial Mermaid grammar of the second, and the two copies of `refusingGitHub` of the first and the missing account action of the second overlap in part, and they are listed, not paired. Against the first gate's run of the same change, the continuation moved from major to critical, `--pr N` matching a pull request of any repository and a 4xx read as a refusal that posted nothing moved from major to minor, and the secret only the review's environment held, the closed list of token forms and the URL of a renamed repository stayed major.

The review of deep-review/click#1 ran with `--pr` on Codex 0.166.0 with `--concurrency 2`, over 1 commit and 4 files from the merge base 9dd417f6 to 976ab180, with `review.language = "ko"` from the repository's file. It took about 22 minutes and met no limit of Codex. Its writer again failed twice on `mcp_tool_call`, so the explanation was degraded with 8 parts dropped; merge-rank ran before it and is not touched. The first review had 18 findings, 0 critical, 6 major and 12 minor; the first gate had 17, 0 critical, 6 major and 11 minor; this one has 13, 3 critical, 1 major and 9 minor. Eleven pairs share a location and a summary with the first review. Seven kept their severity, all of them duplicated code (minor). Four moved: the raw byte deletion that corrupts multibyte and binary input, the filtered chunk read as end of input and the `readinto` that bypasses the filter, from major to critical, the first as `loss` at an `ordinary` reach and the other two raised by `silent`, and the prompt that does not show the caret echo the documentation promises, from minor to major. Of the first review, 7 have no pair: the `getchar` adapter that returns an empty character, the `readlines` with no size hint and the wrapper that fails under `next()` (major), and the paused echo, the abort message printed before the prompt, the prompt handlers that duplicate line reading and the exception tests that duplicate their setup (minor). Of the second, 2 have none: the conditional expression against `docs/contributing.md` and the two copies of the line traversal (minor).

Every `reason` of the three runs names the three values: 41 of 41 on #96, 13 of 13 on click#1 and 21 of 21 on #121. Each value comes with its fact in 26 of 41 on #96, 13 of 13 on click#1 and 20 of 21 on #121; the 15 others on #96 name the recovery `visible` with no fact, all of them minor and 14 of them with the effect `none`, which no recovery moves. Every reason names the origin: 41, 13 and 21. No reason's values and severity disagree with the table and the step of recovery, in any of the three runs, so the count that PD15 waits for is zero. No value only repeats an example; five reasons on #96 say that two copies can drift, each on code that the change does copy. Merge-rank completed in one attempt in each run.

Of the first gate's cases, two of the four secrets posted in public recur on #96, the secret only the review's environment held and the secret of a name the cleaning does not match, and a third leak is new, a token in an exclude pattern. All three are `loss`, `contrived` and `operator`, so major: they are graded alike, though not as the report's table of the gate's cases predicted, `loss`, `ordinary` and `silent`, so critical. The rankers took `contrived` as the lower when `ordinary` also fit, since a worker must also print the secret, and `operator`, since the post is seen and is removed by deleting the review and rotating the secret. The PGP key block and the `gh` credentials a worker can reach do not recur. Of the two findings of a review posted twice, the 4xx read as a refusal recurs as `wrong`, `contrived` and `operator`, so minor, where the report predicted `silent` and major; the settle that lists the reviews once does not recur. On click#1, the caret echo recurs as major, with `degraded`, `ordinary` and `silent` where the report predicted `wrong`, `ordinary` and `operator`; the paused echo does not recur. The value that differs between findings of one kind is the recovery: the continuation whose fix pass runs the pull request's code with the `gh` tokens set is `silent`, as a token exposed to the code cannot be taken back, while the three secrets posted in public are `operator`.

The six pairs that moved against the first reviews were put to the author with both findings, the new values, and for each the grounds on which the new grade could be right and could be wrong. The author judged three new grades right: the continuation that never checks the pull request as critical, the filtered chunk read as end of input as critical, and the missing caret echo as major. The author judged the first review's grade right for the three others: the excluded section as minor, since a token in a glob pattern is practically never written and a pattern from the repository's file is already public, so the effect is an inconsistency of the cleaning; the raw byte deletion as major, since removing the two bytes from binary input is what the change documents, and the multibyte corruption needs a UTF-16 or UTF-32 charset with `echo_stdin` and raises an error; and the `readinto` bypass as major, since `TextIOWrapper` does not call `readinto` and only a rare direct call meets it. Each of the three grades the author rejected turns on one value, not on the table: twice a reach of `ordinary` taken from a public interface that no documented use calls, and once an effect of `loss` for a value that may already be public.

The gate showed four changes of the values' definitions, put to the author: `ordinary` needs a use that the documents, the tests or a caller in the repository make, not only an interface that allows it; the recovery's values have an order, and a harm that is seen but cannot be undone needs one value; the rule to take the lower does not apply where a definition settles the value, as for input that an outside party controls; and a value that is already public is not lost when it is posted again. The author judged that the gate passes, since every grade follows the table from its values, and left the definitions of the values, with the gaps that the review of #121 found, to a later change. The author also observed that a value can depend on the context and the assumptions of the repository: if click were built on the assumption that only UTF-8 is supported, input that breaks under UTF-16 would not be a critical defect. So some grades are unclear to a person too, at least to one who is not the change's author, and the criteria are to be refined with real use, against what people decide, as principle 10 asks; the repository's own table, a non-goal here, is where a repository could state such an assumption.
