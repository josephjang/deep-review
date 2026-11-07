# Product Requirements: The decider settles each choice on the record

Technical part: [2026-11-06-choice-settled-on-the-record.design.md](2026-11-06-choice-settled-on-the-record.design.md).

## Summary

A review by deep-review runs workers in order. Finders propose defects, a verifier checks each one and gives its verdict, and the decider decides for each finding whether deep-review fixes it, leaves it as is with a stated reason, or asks a person. Since [the review that reads as a report](2026-11-04-review-that-reads-as-a-report.requirements.md), a verifier in a read-only run of a pull request also names, as a field of its verdict, the choice it thinks acting on the finding leaves to the author (`authorChoice`). The decider never receives that field. It reads the same choice only as a `Needs the author:` note in the free text of the evidence, and its rubric tells it to treat the note as a hint that the repository may answer.

Two judgments of one choice can therefore disagree, and today the engine settles the disagreement while it renders the review: a finding that the decider left as is, while its verifier named a choice, is posted in what needs a person (R9 of that proposal, which this proposal calls the author rule). The report [How the review on a pull request is written and read](../reports/2026-11-05-review-written-and-read.md) names this as W4. A judgment is made after the decision is recorded, by code that cannot weigh it, and it lengthened the first screen of the gate's review: the English list of what needs a person held 11 items where the template held 4, each finding left for the author an item with no action (#115).

The same report names a second fault of the decision, W5. In #115, three English findings were decided `fix` with an approach that begins "Make no edit, and keep ...". The review posted them as "deep-review would fix this" and counted them among the fixes. The decider's rubric leads there: it says to decide `fix` when its order of what settles a choice settles it, and that order can settle a choice in favor of the code as it is, for which no reason to leave a finding exists.

After this change the decider receives the verifier's choice as a field, and each decision that settles a choice records the choice, the step that settles it, and the source it rests on. A choice kept as the code is, is no longer a fix. It is left as is when the repository states the behavior, or when it is a choice between two shapes that only a maintainer would see; it is a question for the person, with keeping the code as the default, when it is a choice between two behaviors that a caller or a user would see and nothing stated settles it. A `fix` always edits. The form stops deciding: what needs a person holds only the questions and the departures from rules, and wherever the review shows the decision of a finding whose verifier named a choice, it shows that choice, labeled as the verifier's, beside the choice that the decision settles and what settles it, or beside a statement that deep-review did not settle it.

```mermaid
flowchart TD
    V["Verifier: a verdict, and the choice it leaves to the author"] --> D["Decider: reads the choice as a field"]
    D -->|"nothing stated settles a behavior that a user sees"| A["ask: a question for the person"]
    D -->|"the order settles it with an edit"| F["fix, with the settled choice"]
    D -->|"a statement or the rule for shapes keeps the code, or another fix removes the finding"| L["leave as intended, settled or superseded, with the settled choice"]
    D -->|"acting would edit only code outside the change"| O["leave as outside the change, with no settled choice"]
    A --> N["What needs a person"]
    F --> C["The comment: the verifier's choice, beside the settled choice and what settles it"]
    L --> E["Left as is: the verifier's choice, beside the settled choice and what settles it"]
    O --> U["Left as is: the verifier's choice, not settled by deep-review"]
```

Figure 1. Where a choice that a verifier names ends after this change. The form places each finding by its recorded decision alone.

## Problem

### The form decides after the decision is recorded

`forAuthor` in `src/review/pull-request-form.ts` puts a finding in what needs a person when its decision is `leave` and its verifier named a choice. The rule was right for the case that motivated it: on #96, finding 8, about a secret that a review could post, was left as "intended, as the repository states" while its verifier wrote that the author must decide which variables to clean (#107). A reader saw a confirmed major finding folded with the findings they may skip. But the rule puts the verifier's view above the decider's every time, without knowing whether the repository answers the choice. Principle 2 of the vision note asks that each decision be recorded with its grounds before anything acts on it, and principle 4 asks deep-review not to hold for the person a finding that the repository already answers.

### The decider settles a choice without saying how

The decider's rubric says that "your decision names the choice and its answer", and its order says how a choice is settled: the change's stated intent, the repository's stated contract, the behavior before the change, keeping a behavior that was there before, and, for a shape only a maintainer would see, the shape the surrounding code uses. None of this is recorded apart from the free text of the grounds. A reader of #107 could not tell whether the decider had weighed the verifier's choice at all, and no code can tell either.

### A verifier names a choice too readily

#115 says that "a choice remains" is given too readily: eight of nine English `PLAUSIBLE` verdicts said that a choice remains, three of them for the scope of a fix or for a choice that the design records as made, and 20 of 32 Korean findings carried a `Needs the author:` note. Those counts are of the verifiers' notes, not of the findings the author rule moved, which were only those decided `leave`. They show that a verifier's view of a choice is often one the repository answers, which the decider is there to settle, and that a rule which puts the verifier's view above the decider's moves many findings.

### A fix that edits nothing

The decision schema gives each option of a question an `edits` flag and gives a `fix` none, because a fix is meant to edit. The rubric's table sends to `fix` every choice that its order settles, including a choice settled by keeping the code as it is, and the three reasons to leave a finding (`outside-change-not-regression`, `superseded`, `intended`) do not cover it. The engine takes a finding's status from the kind of its decision, so a fix that edits nothing is counted and posted as a fix, and in a fix run it is routed to a fixer.

## Goals

Every judgment that decides where a finding goes in the review is made by a worker and recorded on the ledger before the form reads it. For each choice that a verifier named, a reader sees either a question for the person or the verifier's choice itself, labeled as the verifier's, beside the decision with the step and the source that settle it, or with a statement that deep-review did not settle it. What needs a person holds only questions and departures from rules. A choice between two behaviors that a caller or a user would see, which nothing stated settles, is a question for the person, even when the order would keep the code as it is. No decision of `fix` leaves the code as it is.

## Non-Goals

### NG1: The verifier's prompt and its fields

The verifier still names a choice as it does today, and still writes the `Needs the author:` note in its evidence. #115 says it names one too readily; this proposal has the decider settle each choice, and a change to how readily the verifier names one is a change of the verifier's rubric, measured on its own.

### NG2: The verifier's fields in other runs

The verifier gives `authorChoice` only in a read-only run of a pull request, which records its verdicts at version 3. In every other run the decider reads the note in the evidence, as today. Recording the fields in every run is a change of the verifier's answer in those runs, and is left for later.

### NG3: The writer's explanation of a finding left as is

The writer still explains only the findings that deep-review would fix or asks about. A finding left as is is folded with its reason and its settled choice, not posted in what needs a person, so it no longer needs to be in the writer's words to be read first (W6 of the report).

### NG4: The language of the decider's text

The settled choice and its source are the decider's words, which a review in Korean still shows in English, as it shows the decider's questions today (#111). The step of the order that settles a choice is shown in the engine's words, in the review's language.

### NG5: The core of the change and when a person must look

Posting the core of the change and the conditions of principle 8 is a proposal of its own (G1 and G2 of the report).

### NG6: The fixer and the answers

The fixer's routes and `deep-review answer` stay as they are, and a finding left as is goes to no fixer, as today. The fixer's task gains only the settled choice of its decision and of each finding that its fix removes (R5).

## Requirements

### R1: The decider is given the verifier's choice as a field

In a run whose verdicts record them, the decider's task gives, for each candidate of a finding, the choice its verifier leaves to the author and why a `PLAUSIBLE` verdict is not `CONFIRMED`, each on a line of its own and labeled, beside the evidence. The rubric calls the choice a verifier's view that the decider settles or asks about, not an answer, as it calls the note today.

### R2: A decision that settles a choice records how

A decision may carry a settled choice: the choice in one sentence; the step that settles it; and the source that the step rests on, in one sentence that names what the source is and what it says. Both sentences are written as a question is written, for a person who did not read the change: in plain words, with no file, line, requirement number or internal name of the code, since the review shows them to such a reader. The grounds keep the citation, as `file:line` or a commit, one step below.

A step is one of seven. Five are the rubric's order: the stated intent of the change (`intent`); the stated contract of the repository (`contract`); the behavior before the change (`before`); keeping a behavior that was there before (`kept`); and, for a choice between two shapes that only a maintainer would see, the one the surrounding code already uses, else the one that adds less (`shape`). Two are the ways the rubric's `fix` row reaches a fix outside that order: no choice remains, since acting on the finding has one sound way and the verifier's choice is not a real one, which the source says (`none`); and the scope, since the fix keeps to the part of the result inside the change, as the rubric decides when part of it lies past the change (`scope`).

Whether a decision may carry a settled choice, must carry one or must not, and which steps it may name, depend on the decision, as the table below gives. A finding's verifier named a choice when its verdict gives the choice it leaves to the author as a field (R1); in a run whose verdicts do not record that field, every finding falls under the column "Otherwise".

| Decision | Settled choice when the verifier named a choice | Otherwise | Steps it may name |
|---|---|---|---|
| `fix` without a departure | required | optional | all seven |
| `fix` with a departure | optional | optional | all seven |
| `leave` as `intended` | required | optional | `intent`, `contract` |
| `leave` as `settled` | required | required | `shape` |
| `leave` as `superseded` | required | optional | all but `before` |
| `leave` as `outside-change-not-regression` | refused | refused | no settled choice |
| `ask` | refused | refused | no settled choice |

A fix acts on the finding, so it records the choice it makes. A fix with a departure need not, since its departure records how the decision went against the order. `intended` names one of the two steps that are statements, and `settled` always names `shape` (R3). A finding left as `superseded` is acted on by the fix that removes what it names, so it records the choice that fix makes for it, with the steps of a fix but `before`: that step restores what the change altered by an edit of the finding's own, which would make the finding a fix of its own. A finding left as outside the change is one that deep-review does not act on, so no choice is settled for it, and an ask's question is the record of its choice. The engine refuses an answer that breaks the table, as it refuses an answer that breaks any other rule of the decisions today. Where the table makes a settled choice optional, the rubric still asks the decider to record each choice it settles.

### R3: A choice kept as the code is, is never a fix

The rubric says that a `fix` edits the code, and that a choice the order settles without an edit is not fixed. Such a choice goes one of three ways, by what settles it.

When the change's stated intent or the repository's stated contract settles it in favor of the code as it is, the finding is left as `intended`, since the repository then states the behavior on purpose. `intended` keeps its other case, a finding that says a stated intent is wrong.

When it is a choice between two shapes that only a maintainer reading the code would see, nothing stated settles it, and the rubric's rule for shapes, the one the surrounding code already uses, else the one that adds less, keeps the code as it is, the finding is left as `settled`, a fourth reason to leave a finding.

When it is a choice between two behaviors that a caller or a user would see, nothing stated settles it, and the order settles it only by keeping a behavior that was there before, the decision is an `ask`. Its default, the option that deep-review applies, keeps the code and does not edit (`edits: false`). Such an ask reaches no fixer, and the review already says that the code stays as it is until the person answers. A leave would decide inside deep-review which behavior a user sees when the repository does not say, which the vision note names a question of direction (PD4).

The step `before` restores what the change altered, which is an edit, so it settles a fix and never a leave. The engine holds the steps of each reason as R2's table gives them.

### R4: The form places each finding by its decision alone

What needs a person lists the questions and the fixes that depart from a written rule, and nothing else, in every run, a run decided before this change included (R7). A finding left as is goes in the folded section of findings left as is, whatever its verifier named, and its line there gives its reason and its grounds. When its verifier named a choice, the line then gives that choice, labeled as the verifier's, and beside it the choice that the decision settles, with the step that settles it and the source, or, when the decision settles none, as for a finding left as outside the change, a statement that deep-review did not settle it. When its verifier named none and its decision settles a choice, the line gives the settled choice alone. So no choice that a verifier named is missing from the review, and a reader sees at once when the choice that deep-review settled is not the one its verifier named (PD8). When the body is too long and the engine cuts the findings left as is, it keeps the lines of those whose verifier named a choice and replaces only the others with their count, since those lines are what PD2 and the principle-4 risk rely on. The summary no longer counts findings left for the author.

### R5: A fix says which choice it makes

The comment of a fix whose decision settles a choice, or its text in the body when it has no line in the diff, says under what deep-review would do the choice it makes, the step that settles it and the source, in one line. When the finding's verifier named a choice, the comment gives that choice before it, labeled as the verifier's, as R4 gives it on the line of a finding left as is; for a fix with a departure that settles no choice, the comment says beside the verifier's choice that deep-review did not settle it, and the departure says how the fix goes against the rule. The writer, whose text explains the fix in the same comment and who is given the verifier's choice, is given the settled choice as the decision's too, so its text does not present as the author's a choice that the decision settled. The fixer that applies the fix, whose evidence can still hold the verifier's note, is given the settled choice with its decision, so it applies the choice the decision made. The fixer of a fix with a departure that settles no choice can still read the verifier's note in the evidence with no settlement beside it; the proposal accepts this gap, which the section on principle 2 below names. A fix that removes what a finding left as `superseded` names acts on that finding too, so its fixer is given, beside each finding that the fix removes, that finding's settled choice when it has one.

### R6: The report on the machine

The report shows the reason `settled` in its own words, and, wherever it shows a decision of `fix` or `leave`, the same lines as the review by the same rule: the verifier's choice, labeled as the verifier's, when the verifier named one; the settled choice with its step and its source when the decision carries one; and, for a finding whose verifier named a choice and whose decision settles none, the statement that deep-review did not settle it.

### R7: An older run is posted as any other

A run whose decisions were recorded before this change has no settled choices, and it is posted as a run of this change is. What needs a person holds only its questions and its departures. A finding that it left as is while its verifier named a choice is in the folded section of findings left as is, with that choice labeled as the verifier's and the statement that deep-review did not settle it (R4), which is true of such a run. The author rule is removed for every run (PD7).

### R8: The gate

The gate is a real run (principle 12). deep-review reviews this pull request on Claude Code and posts the review with `publish --dry-run`. The engine of this branch then reviews again the change whose reviews #115 counted: #114, which the gate of the review that reads as a report reviewed twice, once in English and once with `review.language = "ko"`. #114 is merged, and `review --pr` and `publish` refuse a pull request that is not open, while a run with `--from` and `--to` has no pull request to post to and no writer. So the two runs review a pull request that holds #114's commits on the base they had, opened in a copy of this repository under an account the author controls, as R17 of the review on the pull request opened one with the commits of pallets/click #3878, and each posts with `publish --dry-run`. A third run reviews #96's change the same way, in English, since #96 holds the finding of #107, the case that the author rule was made for, and records what the decider decides for it and what the review shows. The gate records each metric below for each run, and the author reads each decision that settles a choice a verifier named and says whether it was a question of direction; the record keeps their word.

### R9: A refused answer is named to the next attempt

When the engine refuses the decider's answer, its next attempt is given what the refusal said, each broken rule with the finding it concerns, as the writer's next attempt is given the parts of its earlier answer that failed. The task says to give the whole answer again.

## Metrics

### M1: The length of what needs a person

The questions and the departures in what needs a person in each review, against the English review of #115, which held 11 items where the template of the review that reads as a report held 4. R4 makes every item a question or a departure, so the count measures RK2, the decider asking more, and not the form. The author reads each question and says whether only a person could answer it. The target is fewer items than #115's 11 in the English run of #114, and no question that the author judges the repository answers.

### M2: Fixes that edit nothing

The decisions of `fix` whose approach makes no edit, read by hand on the gate's runs. #115 found 3 in English. The target is none.

### M3: Where the verifier's choices end

Of the findings whose verifier named a choice, how many the decider asked about, fixed with a settled choice, fixed with a departure, left as `intended`, `settled` or `superseded` with a settled choice, and left as outside the change with no settled choice, with the steps that settled them. For each settled one, the author's word on whether it was a question of direction that deep-review should have asked.

## Product Decisions

### PD1: The decider settles the choice, and the form shows what it decided

The choice a verifier names is evidence for the decider, which owns the decision of whether a choice is the person's to make. The form shows the outcome and does not weigh it. Principle 2 places the judgment before the form, and principle 4 gives the decider the question of whether the repository answers a choice.

### PD2: Rejected: keep the author rule as a safety net

The report left open whether the form should still send to what needs a person a finding that the decider left as is while its verifier named a choice. The proposal rejects it for every run. With the rule kept, the decider's settlement would be overruled whenever a verifier disagreed, which is the disagreement this change removes, and the first screen would keep the items that #115 counted. The case of #107 is covered without it: the decider now sees the choice as a field, and a decision to leave it as `intended`, `settled` or `superseded` must say what settles it, which the review shows beside the verifier's choice. A decision to leave it as outside the change settles nothing, since deep-review does not act on the finding, and the review then shows the verifier's choice with the statement that deep-review did not settle it. So the reader of #107 would see the verifier's choice next to the decision in every case (PD8).

### PD3: The settlement is a field, not the text of the grounds

The grounds could be asked to name the choice and what settles it. Text is not a contract, which is why the verifier's reasons became fields (PD5 of the review that reads as a report): the engine cannot tell whether free text answered the choice, and the form cannot show the step in the review's language. A field that the engine checks is a contract, at the cost of a new version of the decisions on the ledger.

### PD4: A choice kept as the code is, is left or asked, never fixed

A decision that keeps the code as it is, is a decision not to act, and the review must say so rather than count it as a fix. Which decision it becomes depends on who may make the choice. The stated intent and the stated contract are statements, and a behavior the repository states is one it states on purpose, which is what `intended` says, so `intended` takes them. A choice between two shapes that only a maintainer would see is deep-review's to make, as the rubric already says, so the rule for shapes settles it, and when that rule keeps the code the finding takes the new reason `settled`. A choice between two behaviors that a caller or a user would see, which nothing stated settles, is the first question of direction that the vision note names: which behavior a change must have when the repository does not say. Keeping a behavior that was there before answers it only by presumption, so a leave by that step would decide the question inside deep-review and record no ask, which the note counts against a proposal. Such a choice is asked instead, and its default keeps the code, the option easiest to reverse that principle 4 asks deep-review to apply. The step `before` restores the behavior the change altered, which is an edit, so it settles a fix and never a leave. Each reason then has its own steps, the decider has one rule for choosing between a leave and an ask, and M3 can count them apart.

### PD5: Rejected: an `edits` flag on a fix

The report suggested recording on a fix whether it edits, as an option of a question records it, and refusing a fix that edits nothing. A flag that must always be true checks nothing: a decider that writes "make no edit" in its approach can also write that the fix edits. The fault is that the rubric has no right decision for the case, and R3 gives it one. The gate counts what is left of it (M2).

### PD6: The step is a value, and its source is text

The step that settles a choice is one of seven, so the engine can name it in the review's language and count it across runs. Five are the rubric's order. The other two are the ways the rubric reaches `fix` outside that order, no choice remaining and the scope of the fix, since #115 shows that a verifier names a choice too readily and names the scope of a fix as one: without them, a decider that judges the verifier's choice unreal, or keeps a fix inside the change, could pass the check only by naming a step that did not settle anything. A fix that departs from a rule need not name a step, since its departure is already the record of the choice. The source a step rests on is the decider's sentence in plain words, which the review shows, while the grounds keep the citation that a reader who doubts it follows. The two say one fact at two depths, as a question and the places it names where the decider looked do.

### PD7: Rejected: keep the author rule for runs decided before this change

A run decided before this change recorded no settlement, and posting it in the new way folds a choice that no decision answered. That was the reason to keep the author rule for such runs. The same holds for a run of this change: a finding that it leaves as outside the change settles no choice either, and is folded with the verifier's choice shown. So the reason separates nothing, and the rule is removed for every run. A run decided before this change is posted as any other (R7), with the verifier's choice and the statement that deep-review did not settle it on the line of each such finding (PD8), and the engine needs no record of which version its decisions were recorded at.

### PD8: The verifier's choice is shown beside every settlement

The engine checks that a settled choice exists where R2 requires one, not that it answers the choice the verifier named: a decider can settle a narrower choice, or another one. So wherever the review or the report shows a decision of `fix` or `leave` of a finding whose verifier named a choice, it shows that choice, labeled as the verifier's, and beside it the settled choice or the statement that deep-review did not settle it. A reader then sees at once when the two differ, and no settlement takes the place of the verifier's view in the review. A fix with a departure keeps its exemption from a settled choice (R2), and the verifier's choice is shown on it as on any other fix. An ask shows its question, which is the record of its choice, and not the verifier's choice beside it, so what needs a person does not grow. The cost is one line on each such finding, in the folded section of findings left as is and in the comments of the fixes, which a reader opens as evidence.

## Against the vision note

This proposal is read against the vision note of 2026-11-05.

### Principle 2, record before action

The form no longer makes a judgment that no worker recorded. Every placement of a finding in the review follows from its recorded decision, and the settlement of each choice that a verifier named is recorded with its step and its source before the form reads it. Each fixer that acts on a finding is given the choice its decision settled, the fixer of a fix that removes a finding left as `superseded` included, so no fixer makes a choice that the decision made.

One gap is accepted. A fix with a departure need not settle the verifier's choice (R2), so its fixer can read the verifier's note in the evidence with no settlement beside it, and could make that choice itself, which this principle does not permit. The proposal accepts the gap because the departure is the decision's record of how the fix goes against the order, and the fixer is given it; and because the review lists the departure in what needs a person and shows the verifier's choice in the fix's comment with the statement that deep-review did not settle it (R5), so a reader sees both. The fixer is given the settled choice whenever such a fix carries one.

### Principle 4, deep-review decides; the person answers and writes rules

The proposal serves this principle: a choice that the repository answers is settled by the decider and reported, not held for the person, and a choice that nothing stated settles is asked. A choice between two behaviors that a caller or a user would see is asked even when the order would keep the code as it is, with keeping the code as the default, since that choice is a question of direction (R3, PD4); only a choice between two shapes that a maintainer alone would see is left as `settled`. The vision note counts against a proposal one that "decides a question of direction inside deep-review and does not record an ask". The risk is still real, since a decider can settle a choice that was the person's by a step that does not reach it. The proposal accepts it because each settlement is recorded with the step and the source it rests on, shown in the review beside the verifier's choice (PD8), and read by the author at the gate (M3).

### Principles 5 and 6, the questions first, easy to understand with little context

What needs a person returns to the questions and the departures, which a reader can decide from the item alone. A finding left as is says in one line which choice it settles and why, with the step in the review's language, so a reader does not have to read the verifier's evidence to see why it is not a question. The verifier's choice that the review shows beside each settlement (PD8) is a line in the folded section or in a fix's comment, which a reader opens as evidence, and not on the first screen.

### Principle 8, say when a person must look

The four conditions of principle 8 do not include a choice that a verifier named, and this proposal does not add one. A finding left as is with a settled choice is folded with the findings left as is, where the reader of #107 found the secret-posting finding. The difference is that its line now gives the verifier's choice and what settled it, so a reader who disagrees can see it at a glance, and that the line stays when the body is cut, which the folded section does not today. The proposal names this as a choice: the first screen is kept for what only a person can answer. A run decided before this change is posted the same way, so a finding that it left as is while its verifier named a choice is folded too, with the statement that deep-review did not settle the choice (R7).

### Principle 10, answers are labels

No answer on the ledger is about a settled choice, since the person answers questions and departures. The gate measures the settlements against the author's reading of each (M3), which the principle calls an approximation. A later note can decide whether a person's correction of a settled choice becomes an answer.

### Principle 11, recovery without a person

The proposal departs from this principle in one case it adds. The rules of R2 and R3 are a new way for the decider's answer to be refused, and two refusals stop the run before its report, so a person must resume it, which the principle counts as a person back in the loop (RK3). R9 makes the second refusal less likely, and the stop names its action, a resume, which gives the phase fresh attempts. The proposal builds no further recovery, such as a degraded decision, since the principle permits recovery only for a failure that a run has shown; the gate records each stop, and a stop that real runs show is the case for it.

### Principle 12, a real run is the gate

R8 is a real run of this pull request, two of #114's change, in English and in Korean, and one of #96's change, each on an open pull request that holds the change's commits, since the engine refuses to review or post a merged one.

## Risks

### RK1: The decider settles a choice that was the person's

A decider can cite a step of the order that does not reach the case, or settle a choice other than the one its verifier named. The step and the source are shown beside the verifier's choice in the review and the report (PD8), and the gate reads each settlement (M3). A settlement that the author judges wrong is a case for the decider's rubric.

### RK2: The decider asks more

A decider that now sees the choice as a field may ask about it more often, and a choice between two behaviors that it would have kept as the code is, is now a question (R3); both lengthen what needs a person. Each question still has to say where the decider looked and found nothing, and the gate counts the items (M1).

### RK3: More answers refused

The new rules of R2 and R3 refuse a whole answer when one decision breaks them, and the Korean review of #115 had 20 of 32 findings whose verifier named a choice. The decider is tried twice and its phase has no degraded result, so two refused answers stop the run before its report, with the blocker of a worker that failed twice; resuming the run gives the phase fresh attempts. Principle 11 counts such a stop against a run, so the second attempt is told what the first broke (R9), which makes a second refusal for the same rule less likely. The gate records each refusal and each stop.

### RK4: A run started before the change cannot resume after it

The decider's role prompt changes, so a run configured before the change and resumed after it is refused with the action to name the old roles directory (`--roles <dir>`), as for every earlier edit of a fragment.

### RK5: A rerun differs for reasons other than the decider

The gate's runs review #114's and #96's changes again from the start, so their finders and verifiers may surface other findings and name other choices than the runs that #115 and #107 describe. A count against #115 mixes the decider's change with that difference. The author's word on each question and each settlement, not the count alone, is what the gate keeps.
