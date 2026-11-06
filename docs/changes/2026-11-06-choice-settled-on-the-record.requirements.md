# Product Requirements: The decider settles each choice on the record

Technical part: [2026-11-06-choice-settled-on-the-record.design.md](2026-11-06-choice-settled-on-the-record.design.md).

## Summary

A review by deep-review runs workers in order. Finders propose defects, a verifier checks each one and gives its verdict, and the decider decides for each finding whether deep-review fixes it, leaves it as is with a stated reason, or asks a person. Since [the review that reads as a report](2026-11-04-review-that-reads-as-a-report.requirements.md), a verifier in a read-only run of a pull request also names, as a field of its verdict, the choice it thinks acting on the finding leaves to the author (`authorChoice`). The decider never receives that field. It reads the same choice only as a `Needs the author:` note in the free text of the evidence, and its rubric tells it to treat the note as a hint that the repository may answer.

Two judgments of one choice can therefore disagree, and today the engine settles the disagreement while it renders the review: a finding that the decider left as is, while its verifier named a choice, is posted in what needs a person (R9 of that proposal, which this proposal calls the author rule). The report [How the review on a pull request is written and read](../reports/2026-11-05-review-written-and-read.md) names this as W4. A judgment is made after the decision is recorded, by code that cannot weigh it, and it filled the first screen of the gate's review: 20 of 32 Korean findings carried "Needs the author", and the English list of what needs a person held 11 items where the template held 4 (#115).

The same report names a second fault of the decision, W5. In #115, three English findings were decided `fix` with an approach that begins "Make no edit, and keep ...". The review posted them as "deep-review would fix this" and counted them among the fixes. The decider's rubric leads there: it says to decide `fix` when its order of what settles a choice settles it, and that order can settle a choice in favor of the code as it is, for which no reason to leave a finding exists.

After this change the decider receives the verifier's choice as a field, and each decision that settles a choice records the choice, the step that settles it, and the source it rests on. A choice settled in favor of the code as it is becomes a finding left as is with a reason of its own, and a `fix` always edits. The form stops deciding: what needs a person holds only the questions and the departures from rules, and a finding left as is shows beside its reason the choice it settles and what settles it.

```mermaid
flowchart TD
    V["Verifier: a verdict, and the choice it leaves to the author"] --> D["Decider: reads the choice as a field"]
    D -->|"nothing stated settles it"| A["ask: a question for the person"]
    D -->|"the order settles it with an edit"| F["fix, with the settled choice"]
    D -->|"the order settles it as the code is"| L["leave, settled, with the settled choice"]
    A --> N["What needs a person"]
    F --> C["The comment says the choice and what settles it"]
    L --> E["Left as is, with the choice and what settles it"]
```

Figure 1. Where a choice that a verifier names ends after this change. The form places each finding by its recorded decision alone.

## Problem

### The form decides after the decision is recorded

`forAuthor` in `src/review/pull-request-form.ts` puts a finding in what needs a person when its decision is `leave` and its verifier named a choice. The rule was right for the case that motivated it: on #96, finding 8, about a secret that a review could post, was left as "intended, as the repository states" while its verifier wrote that the author must decide which variables to clean (#107). A reader saw a confirmed major finding folded with the findings they may skip. But the rule puts the verifier's view above the decider's every time, without knowing whether the repository answers the choice. Principle 2 of the vision note asks that each decision be recorded with its grounds before anything acts on it, and principle 4 asks deep-review not to hold for the person a finding that the repository already answers.

### The decider settles a choice without saying how

The decider's rubric says that "your decision names the choice and its answer", and its order says how a choice is settled: the change's stated intent, the repository's stated contract, the behavior before the change, keeping a behavior that was there before, and, for a shape only a maintainer would see, the shape the surrounding code uses. None of this is recorded apart from the free text of the grounds. A reader of #107 could not tell whether the decider had weighed the verifier's choice at all, and no code can tell either.

### A verifier names a choice too readily

#115 says that "a choice remains" is given too readily: eight of nine English `PLAUSIBLE` verdicts gave a choice, three of them for the scope of a fix or for a choice that the design records as made. Those three are choices the repository answers, which the decider is there to settle. Under the author rule each of them went to the first screen.

### A fix that edits nothing

The decision schema gives each option of a question an `edits` flag and gives a `fix` none, because a fix is meant to edit. The rubric's table sends to `fix` every choice that its order settles, including a choice settled by keeping the code as it is, and the three reasons to leave a finding (`outside-change-not-regression`, `superseded`, `intended`) do not cover it. The engine takes a finding's status from the kind of its decision, so a fix that edits nothing is counted and posted as a fix, and in a fix run it is routed to a fixer.

## Goals

Every judgment that decides where a finding goes in the review is made by a worker and recorded on the ledger before the form reads it. A reader sees, for each choice that a verifier named, a question for the person, the step and the source that settle it, or, for a finding that deep-review does not act on at all, the verifier's choice itself beside the reason it is left. What needs a person holds only questions and departures from rules. No decision of `fix` leaves the code as it is.

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

The fixer's routes and `deep-review answer` stay as they are, and a finding left as is goes to no fixer, as today. The fixer's task gains only the settled choice of its decision (R5).

## Requirements

### R1: The decider is given the verifier's choice as a field

In a run whose verdicts record them, the decider's task gives, for each candidate of a finding, the choice its verifier leaves to the author and why a `PLAUSIBLE` verdict is not `CONFIRMED`, each on a line of its own and labeled, beside the evidence. The rubric calls the choice a verifier's view that the decider settles or asks about, not an answer, as it calls the note today.

### R2: A decision that settles a choice records how

A decision may carry a settled choice: the choice in one sentence, in plain words; the step that settles it; and the source that the step rests on, cited. A step is one of the five of the rubric's order, the stated intent of the change, the stated contract of the repository, the behavior before the change, keeping a behavior that was there before, or the shape the surrounding code uses, or one of two that the rubric gives a fix outside that order: no choice remains, since acting on the finding has one sound way and the verifier's choice is not a real one, which the source says; or the scope, since the fix keeps to the part of the result inside the change, as the rubric decides when part of it lies past the change. A decision of `fix` without a departure, or of `leave` as `intended` or `settled`, on a finding whose verifier named a choice carries one, and a decision of `leave` as `settled` always carries one. A `fix` with a departure needs none, since the departure records how the decision went against the order. The engine refuses an answer that breaks this, as it refuses an answer that breaks any other rule of the decisions today. A decision of `ask` carries none, since its question is the record of the choice.

### R3: A choice kept as the code is, is left as settled

A fourth reason to leave a finding, `settled`, says that acting on the finding needs a choice and the rubric's order settles it in favor of the code as it is with nothing stated: by keeping a behavior that was there before, or by the shape the surrounding code uses. A choice that the change's stated intent or the repository's stated contract settles in favor of the code as it is, is left as `intended`, since the repository then states the behavior on purpose; `intended` keeps its other case, a finding that says a stated intent is wrong. The rubric says that a `fix` edits the code, and that a choice the order settles without an edit is left, not fixed. The engine refuses a `settled` leave whose step is not `kept` or `shape`, and an `intended` leave whose settled choice has a step other than `intent` or `contract`. The step `before`, the behavior before the change, restores what the change altered, which is an edit, so it settles only a fix.

### R4: The form places each finding by its decision alone

What needs a person lists the questions and the fixes that depart from a written rule, and nothing else. A finding left as is goes in the folded section of findings left as is, whatever its verifier named, and its line there gives its reason, its grounds and, when its decision settles a choice, the choice, the step that settles it and the source. A finding left as is whose verifier named a choice and whose decision settles none, as one left as outside the change or superseded may be, gives on its line the verifier's choice, marked as the verifier's and not settled by deep-review, so no choice that a verifier named is missing from the review. When the body is too long and the engine cuts the findings left as is, it keeps the lines of those whose verifier named a choice and replaces only the others with their count, since those lines are what PD2 and the principle-4 risk rely on. The summary no longer counts findings left for the author.

### R5: A fix says which choice it makes

The comment of a fix whose decision settles a choice, or its text in the body when it has no line in the diff, says under what deep-review would do the choice it makes, the step that settles it and the source, in one line. The writer, whose text explains the fix in the same comment and who is given the verifier's choice, is given the settled choice as the decision's too, so its text does not present as the author's a choice that the decision settled. The fixer that applies the fix, whose evidence can still hold the verifier's note, is given the settled choice with its decision, so it applies the choice the decision made.

### R6: The report on the machine

The report shows the reason `settled` in its own words, and, wherever it shows a decision whose decision settles a choice, the choice, the step and the source.

### R7: An older run

A run whose decisions were recorded before this change has no settled choices. Such a run is posted as today, the author rule included: a finding it left as is while its verifier named a choice still goes in what needs a person, since its decider was not given the choice as a field and recorded nothing of it.

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

Of the findings whose verifier named a choice, how many the decider asked about, fixed with a settled choice, left as `intended` or `settled`, and left as outside the change or superseded with no settled choice, with the steps that settled them. For each settled one, the author's word on whether it was a question of direction that deep-review should have asked.

## Product Decisions

### PD1: The decider settles the choice, and the form shows what it decided

The choice a verifier names is evidence for the decider, which owns the decision of whether a choice is the person's to make. The form shows the outcome and does not weigh it. Principle 2 places the judgment before the form, and principle 4 gives the decider the question of whether the repository answers a choice.

### PD2: Rejected: keep the author rule as a safety net

The report left open whether the form should still send to what needs a person a finding that the decider left as is while its verifier named a choice. The proposal rejects it for new runs. With the rule kept, the decider's settlement would be overruled whenever a verifier disagreed, which is the disagreement this change removes, and the first screen would keep the items that #115 counted. The case of #107 is covered without it: the decider now sees the choice as a field, and a decision to leave it as `intended` or `settled` must say what settles it, which the review shows beside the reason. A decision to leave it as outside the change or superseded need not settle it, since deep-review does not act on the finding, and the review then shows the verifier's choice itself beside the reason, so the reader of #107 would still see the choice next to the decision.

### PD3: The settlement is a field, not the text of the grounds

The grounds could be asked to name the choice and what settles it. Text is not a contract, which is why the verifier's reasons became fields (PD5 of the review that reads as a report): the engine cannot tell whether free text answered the choice, and the form cannot show the step in the review's language. A field that the engine checks is a contract, at the cost of a new version of the decisions on the ledger.

### PD4: A choice kept as the code is, is a reason to leave

A decision that keeps the code as it is, is a decision not to act, and the review must say so rather than count it as a fix. The steps that can keep the code split by whether the repository states anything. The stated intent and the stated contract are statements, and a behavior the repository states is one it states on purpose, which is what `intended` says, so `intended` takes them. Keeping a behavior that was there before and the shape the surrounding code uses rest on no statement, which `intended` cannot say, so they take the new reason `settled`. The step `before` restores the behavior the change altered, which is an edit, so it settles a fix and never a leave. Each reason then has its own steps, the decider has one rule for choosing between them, and M3 can count them apart.

### PD5: Rejected: an `edits` flag on a fix

The report suggested recording on a fix whether it edits, as an option of a question records it, and refusing a fix that edits nothing. A flag that must always be true checks nothing: a decider that writes "make no edit" in its approach can also write that the fix edits. The fault is that the rubric has no right decision for the case, and R3 gives it one. The gate counts what is left of it (M2).

### PD6: The step is a value, and its source is text

The step that settles a choice is one of seven, so the engine can name it in the review's language and count it across runs. Five are the rubric's order. The other two are the ways the rubric reaches `fix` outside that order, no choice remaining and the scope of the fix, since #115 shows that a verifier names a choice too readily and names the scope of a fix as one: without them, a decider that judges the verifier's choice unreal, or keeps a fix inside the change, could pass the check only by naming a step that did not settle anything. A fix that departs from a rule is not given a step, since its departure is already the record of the choice. The source a step rests on is the decider's citation, as its grounds are.

### PD7: An older run keeps the author rule

A run decided before this change recorded no settlement, so its disagreements are unresolved on the record. Posting such a run in the new way would fold a choice that no decision answered. The rule stays for those runs only, and is tied to the version of their decisions on the ledger.

## Against the vision note

This proposal is read against the vision note of 2026-11-05.

### Principle 2, record before action

The form no longer makes a judgment that no worker recorded. Every placement of a finding in the review follows from its recorded decision, and the settlement of each choice that a verifier named is recorded with its step and its source before the form reads it.

### Principle 4, deep-review decides; the person answers and writes rules

The proposal serves this principle: a choice that the repository answers is settled by the decider and reported, not held for the person, and a choice that nothing stated settles is asked. The vision note counts against a proposal one that "decides a question of direction inside deep-review and does not record an ask". The risk is real here, since a decider can settle a choice that was the person's. The proposal accepts it because each settlement is recorded with the step and the source it rests on, shown in the review beside the decision, and read by the author at the gate (M3).

### Principles 5 and 6, the questions first, easy to understand with little context

What needs a person returns to the questions and the departures, which a reader can decide from the item alone. A finding left as is says in one line which choice it settles and why, with the step in the review's language, so a reader does not have to read the verifier's evidence to see why it is not a question.

### Principle 8, say when a person must look

The four conditions of principle 8 do not include a choice that a verifier named, and this proposal does not add one. A finding left as is with a settled choice is folded with the findings left as is, where the reader of #107 found the secret-posting finding. The difference is that its line now says what settled the choice, so a reader who disagrees can see it at a glance, and that the line stays when the body is cut, which the folded section does not today. The proposal names this as a choice: the first screen is kept for what only a person can answer.

### Principle 10, answers are labels

No answer on the ledger is about a settled choice, since the person answers questions and departures. The gate measures the settlements against the author's reading of each (M3), which the principle calls an approximation. A later note can decide whether a person's correction of a settled choice becomes an answer.

### Principle 12, a real run is the gate

R8 is a real run of this pull request, two of #114's change, in English and in Korean, and one of #96's change, each on an open pull request that holds the change's commits, since the engine refuses to review or post a merged one.

## Risks

### RK1: The decider settles a choice that was the person's

A decider can cite a step of the order that does not reach the case. The step and the source are shown beside the decision in the review and the report, and the gate reads each settlement (M3). A settlement that the author judges wrong is a case for the decider's rubric.

### RK2: The decider asks more

A decider that now sees the choice as a field may ask about it more often, and lengthen what needs a person. Each question still has to say where the decider looked and found nothing, and the gate counts the items (M1).

### RK3: More answers refused

The new rules of R2 and R3 refuse a whole answer when one decision breaks them, and the Korean review of #115 had 20 of 32 findings whose verifier named a choice. The decider is tried twice and its phase has no degraded result, so two refused answers stop the run before its report, with the blocker of a worker that failed twice; resuming the run gives the phase fresh attempts. Principle 11 counts such a stop against a run, so the second attempt is told what the first broke (R9), which makes a second refusal for the same rule less likely. The gate records each refusal and each stop.

### RK4: A run started before the change cannot resume after it

The decider's role prompt changes, so a run configured before the change and resumed after it is refused with the action to name the old roles directory (`--roles <dir>`), as for every earlier edit of a fragment.

### RK5: A rerun differs for reasons other than the decider

The gate's runs review #114's and #96's changes again from the start, so their finders and verifiers may surface other findings and name other choices than the runs that #115 and #107 describe. A count against #115 mixes the decider's change with that difference. The author's word on each question and each settlement, not the count alone, is what the gate keeps.
