# Technical Design: The decider settles each choice on the record

Product part: [2026-11-06-choice-settled-on-the-record.requirements.md](2026-11-06-choice-settled-on-the-record.requirements.md).

## Summary

The decider's task gains one line per candidate: the choice its verifier leaves to the author, from the field `authorChoice` that `verdicts.recorded@3` already records. The decider's answer gains, on each decision, an optional settled choice `{choice, by, source}`, where `by` is one of seven steps, the five of the rubric's order and two the rubric gives a fix outside it, and a fourth reason to leave a finding, `settled`. `checkDecisions` and the fold both hold the table of R2, which decision may carry a settled choice, must carry one or must not, and with which steps. The ledger records the new answer as `decisions.recorded@2`, which any run may record, since a run records its decisions once, and the fold reads version 1 with no settled choice. The form drops the author rule, R9 of the review that reads as a report, for every run, a run decided at version 1 included. Wherever the form or the report shows a decision of `fix` or `leave` of a finding whose verifier named a choice, it shows that choice beside the settled one, or says that deep-review did not settle it. `checkDecisions` names in one refusal every rule that an answer breaks, which the decider's next attempt is given (R9), and the decider's task states the steps and the table of R2 in every run. The decider's rubric says that a fix edits and when a decision is left as `settled`, and that a choice between two behaviors that nothing stated settles is asked, with keeping the code as the default, even when the order would keep it.

## Non-Goals

### NG1: No change to the verifier

`verifierOutputSchemaV3`, `verdicts.recorded@3`, `notesParagraph` in `src/review/tasks.ts` and `roles/fragments/rubrics.md` stay. The verifier's `Needs the author:` note stays in its evidence, so in a read-only run of a pull request the decider reads the choice twice, once as the field and once in the evidence.

### NG2: No change to the fixer's routes

`routeOfDecision` in `src/checkpoint/fix-state.ts:1019` already routes a `leave` to `held`, so a finding left as `settled` reaches no fixer, and routes to `held` too an `ask` whose applied option does not edit, so an ask whose default keeps the code reaches no fixer either. The fixer's task gains the settled choice of its decision and of each finding that its fix removes, which "The fixer's task" below gives, and nothing else of the fixer changes.

### NG3: No change to what the writer explains

`findingsToExplain` in `src/review/explanation.ts` still gives the writer the findings decided `fix` or `ask`, and its answer and its checks stay. Its task gains one line, which "The writer's task" below gives.

## Context

### The decider's task today

`deciderFindings` (`src/review/phases.ts:214`) gives each ranked finding its id, severity, verdict, summary, reason and candidates, each candidate through `taskCandidate` (`phases.ts:203`). `TaskCandidate` (`src/review/tasks.ts:578`) has no field for the verifier's two notes. `candidateLines` (`tasks.ts:732`) prints a candidate's summary, detail and evidence, and serves both the decider's task (`deciderTask`, `tasks.ts:1210`) and the fixer's (`tasks.ts:903`). The decider's role prompt is assembled from `decider-brief.md`, `worker-scope.md`, `lead-verify.md`, `rubrics.md` and `decider-rubric.md` (`roles/manifest.json:121`).

### The decision and its record

`deciderOutputSchema` (`src/review/schemas.ts:216`) gives each decision `{index, decision, grounds, fix, leave, ask, departure}`, with `edits` only on the options of a question. `checkDecisions` (`schemas.ts:597`) holds one part per decision kind, a departure on a fix only, the option indexes and the superseded rule, and throws a `StructuralCheckError` at the first rule that an answer breaks, which the phase records as the reason of an `attempt.failed` that begins `structural check:` (`phases.ts:797`). The decision phase records the checked answer as `decisions.recorded@1` (`phases.ts:893`), whose schema (`recordedDecisionSchema`, `src/checkpoint/events.ts:1350`) takes its leave reasons from the frozen `vocabularyV4.leaveReasons` (`events.ts:1227`). `decisionsRecorded` (`src/checkpoint/review-fold.ts:820`) holds them in the ranking's order. The engine's list of leave reasons is `leaveReasons` in `src/review/vocabulary.ts:544`, and a test of `test/roles/repository.test.ts` holds the rubric's list to it.

### The verifier's choice in the state

`resolutionOf` and `mergedResolution` (`src/review/state.ts:75`, `:137`) give a finding the `authorChoice` of its shown candidate, else of the first other candidate that names one. Verdicts recorded at version 1 or 2 fold with `authorChoice: null` (`review-fold.ts:780`). A run records its verdicts at version 3 only when it is configured at `review.configured@11`, a read-only run of a pull request (`verdictsVersionOf`, `review-fold.ts:728`).

### The author rule in the form

`forAuthor` (`src/review/pull-request-form.ts:250`) is true for a finding decided `leave` with an `authorChoice`. It puts the finding in full in the body (`inFull`, `:253`), gives it `authorBlocks` (`:453`) in `decisionBlocks` (`:468`), lists it in what needs a person (`:591`), counts it in the summary (`:565`), and keeps it out of `leftAsIs` (`:655`). Its words are `needsAuthor`, `authorChoice`, `whyLook` and the summary's count in `src/review/pull-request-words.ts`, in English and Korean. The report on the machine does not read `authorChoice`.

### The status of a fix

`findingStatusOf` (`src/review/brief.ts:369`) makes every `fix` of a read-only run `planned` or `planned-against-rule`, and the form counts and words it as a fix. In a fix run, `routeOfDecision` sends every `fix` to a fixer.

## Design

### The decider's task (R1, R2)

`DeciderTaskFinding` gives each candidate `authorChoice`, read from the candidate's verdict, null for a run whose verdicts lack it. `candidateLines` prints it when it is given, as `choice left to the author: <text>`, after the evidence. The verdict's `unconfirmed` is not passed: no rule reads it, and the evidence line already ends with what keeps a `PLAUSIBLE` verdict from `CONFIRMED` (`roles/fragments/rubrics.md`). The fixer's task passes no `authorChoice`, so its lines do not change. `deciderTask`'s text names the line and the settled choice of the answer. It also states the seven steps, one line each, and the table of R2 of the requirements, which decision may carry a settled choice, must carry one or must not, and with which steps. The task states them because `deciderTask` is engine code that every run receives, while a run resumed with its old roles directory has a rubric that defines neither the steps nor `settled` (RK4 of the requirements).

### A refused answer, named to the next attempt (R9)

`checkDecisions` collects every rule that an answer breaks, the rules of today and those of R2 and R3, each worded with the index of the decision and the rule, and throws one `StructuralCheckError` that lists them within `maxRecordedTextLength`, the limit of a recorded reason, in place of throwing at the first. The phase records it as today. The decision phase builds the next attempt's task from the failures that the decision unit holds (`UnitFailure` in `src/checkpoint/review-fold.ts:121`, which the fold keeps from each `attempt.failed`), keeping those whose `cause` is `unit` and whose reason is a structural-check failure, and `deciderTask` names their reasons under a section "What failed in the earlier answer" and asks for the whole answer again, as `writerTask` does for the parts it drops (`src/review/explanation.ts:998`). The failures are cleared when a blocked phase is resumed, so a resumed run starts its decider without them, as the fold does for every unit today; the requirements accept this (R9). No event changes.

### The answer and its check (R2, R3)

`deciderOutputSchema` adds to each decision `settled: {choice: text up to 400, by: settleStep, source: text up to 400} | null`, where `settleSteps` in `vocabulary.ts` is `['intent', 'contract', 'before', 'kept', 'shape', 'scope', 'none']`: the five steps of the rubric's order in its order, then the scope of a fix that keeps to the part inside the change, and no choice remaining. `leaveReasons` becomes `['outside-change-not-regression', 'superseded', 'intended', 'settled']`. `checkDecisions(output, findings)` takes, for each index, whether the finding's resolution names an `authorChoice`, and holds the table of R2 of the requirements. It refuses an answer in which:

- a decision of `fix` with no departure, or of `leave` as `intended`, `settled` or `superseded`, of a finding whose resolution names a choice, has no settled choice;
- a decision of `leave` as `settled` has no settled choice, whatever its finding's resolution names;
- a decision of `leave` as `outside-change-not-regression`, or of `ask`, has one;
- a settled choice names a step that its decision does not allow: `intended` allows `intent` and `contract`, `settled` allows `shape`, `superseded` allows every step but `before`, and `fix`, with or without a departure, allows all seven.

### The event and the fold (TD1, TD3, TD5)

`decisionsRecordedV2` holds `recordedDecisionSchemaV2`: each variant of version 1 with `settled` beside `departure`, and the leave reasons of a new frozen vocabulary, `reviewVocabularyV13.leaveReasons`, with `settled`; the settled choice's `by` takes `reviewVocabularyV13.settleSteps`. The fold applies to version 2 the same rules as to version 1, and every rule of R2 and R3 that `checkDecisions` holds, the one that depends on the verifier's choice included: a finding names a choice when the verdict of its primary or of one of its members, as the ranking records them, records an `authorChoice` at version 3 (TD3). The reducer of version 1 gives every decision `settled: null`. The review state does not record the version that its decisions were recorded at, since nothing reads it (TD5).

### The rubric (R1, R2, R3)

`decider-rubric.md` changes in seven places, in a commit of its own:

1. Its first paragraph names the choice left to the author as a line of the candidate, and still calls it a verifier's view to settle or ask about, not an answer.
2. "Settling a choice" lists the five steps of the order as list items in the form ``- `intent`: the change's stated intent``, in place of its numbered list, as a list that a test of `repository.test.ts` reads. The paragraph on a choice between two shapes that only a maintainer would see becomes the fifth item, `shape`, with its whole rule: the one the surrounding code already uses, else the one that adds less. R2's words for `shape` are this rule. Two more list items follow, marked as the steps outside the order, `scope` and then `none`, so the section lists the seven steps in the order of `settleSteps`.
3. The table of the three decisions says that a `fix` edits the code, names in its `fix` row the two steps outside the order, `none` for "acting needs no choice" and `scope` for the part of a result inside the change, and says that a choice the order settles without an edit is not fixed: it is left as `intended` or `settled`, or, when it is a choice between two behaviors that a caller or a user would see and only keeping a behavior that was there before settles it, asked, with a default that keeps the code and does not edit. Its `ask` row names that case, and its `leave` row says four reasons, not three.
4. Its list of reasons to leave gains `settled`, in the form the test reads: "`settled`: acting needs a choice between two shapes that only a maintainer reading the code would see, nothing stated settles it, and the rule for shapes keeps the code as it is; give the settled choice, by `shape`." The text of `intended` gains its second case: a choice that the change's stated intent or the repository's stated contract settles in favor of the code as it is, given with its settled choice by `intent` or `contract`. The text of `superseded` says to give, when the verifier named a choice, the settled choice that the superseding fix makes for the finding, by any step but `before`, and the text of `outside-change-not-regression` says that such a finding carries no settled choice.
5. A sentence after "Your decision names the choice and its answer" says to record a choice that the decision settles in `settled`, with its step and the source it rests on, and that the choice and the source are written as a question is, in plain words for a person who did not read the change, with no file, line, requirement number or internal name of the code, while the grounds cite; and that a `fix` with a departure may record its choice in the departure instead.
6. The paragraph on a result that lies partly past the change names `scope` as the step of such a fix.
7. The section of the three decisions ends with the table of R2 of the requirements, which decision may carry a settled choice, must carry one or must not, and with which steps, with the reason of each row.

The rubric then has two lists in the same form, the steps and the reasons to leave, and the test that holds the reasons to `leaveReasons` reads the whole fragment today (`test/roles/repository.test.ts:332`), so it would take the steps for reasons. Each of the two tests therefore reads only its own section, which it slices with `indexOf` from the section's first line to the next heading, as the test of the severities slices its part of `phase4-list.md`. The test of the reasons reads only the section that begins "The reasons a finding is left, and no others:" and holds its labels to `leaveReasons`. A new test reads only the section "Settling a choice" and holds its labels, in order, to `settleSteps`.

### The form (R4, R5, R7)

`forAuthor` and `authorBlocks` are removed for every run, with the item for the author in what needs a person, the summary's count `authors`, and their words `needsAuthor`, `whyLook`, the word `authorChoice` and the summary's sentences on findings left for the author, in English and Korean. A finding decided `leave` with an `authorChoice` then goes in `leftAsIs` in every run, is not in full in the body unless it was there for another reason, and is not counted or listed as for the author. Each line of the findings left as is gives after the reason and the grounds, for a finding with an `authorChoice`, `words.verifierChoice(authorChoice)`, the choice labeled as its verifier's, followed by `words.settledChoice(choice, words.settleSteps[by], source)` when the decision settles a choice; when it settles none, the line gives `words.unsettledChoice(authorChoice)` instead, which names the choice as the verifier's and says deep-review did not settle it. A finding with no `authorChoice` gives `words.settledChoice(...)` when its decision carries a settled choice, and nothing more. The `left` cut of `bodyCuts` (`pull-request-form.ts:111`) changes with it: the cut keeps the lines of the findings with an `authorChoice`, the rule of R4, and words the others as "the other N findings left as is", a new entry of the words in English and Korean, so a body over the limit still shows each choice that a verifier named. `words.leftCut` stays for a cut that keeps no line, when no finding left as is has an `authorChoice`. The lines that a kept finding adds hold at most about 1,200 characters of the workers' text, the verifier's choice (`verifierNoteLengthV1`), the settled choice and its source being up to 400 each, and the cuts after `left` still apply if the body stays too long. `decisionBlocks` gives a `fix` the same lines by the same rule after the sentence of what deep-review would do, or for a minor finding after its paragraph, in its comment and in its text in the body. The folded table of minor findings does not change, since its cell of what deep-review would do is one sentence. An ask's question is the record of its choice, so `decisionBlocks` gives an `ask` none of these lines. The words gain `settleSteps` in English and Korean, `verifierChoice`, `settledChoice`, `unsettledChoice`, the words of a cut that keeps some lines, and the label of `settled` in `leaveReasons`.

### The writer's task (R5)

The writer's task prints each candidate's verifier choice through `noteLines` (`explanation.ts:876`), and the decision through `decisionLines` (`explanation.ts:851`), which shows no settlement. A writer that explains a fix could then present the verifier's choice as open beside the engine's line that says how it is settled. `decisionLines` gains, for a decision with a settled choice, `        settled: <choice>, by <step in words>: <source>`, labeled as the decision's, where the step is given in the English words that the report on the machine uses for it, not as its raw value, and the task says that a choice the decision settled is not the author's to make. No check of the answer changes.

### The fixer's task (R5)

The fixer's task prints each candidate's evidence (`candidateLines`, `tasks.ts:738`), which in a read-only run of a pull request still ends with the verifier's `Needs the author:` note, and such a run can be continued into a fix pass with `--fix`. `decidedLines` (`tasks.ts:750`) prints the grounds, the approach, the rejected options and the departure, and no settlement. A fixer could then hold the verifier's open choice beside an approach that does not spell out how the decision settled it, and make the choice itself, which principle 2 does not permit. `decidedLines` gains, for a `fix` with a settled choice, `        settled: <choice>, by <step in words>: <source>`, with the step in words as in the writer's task, so the fixer applies the choice the decision made. Each `removes also:` line (`tasks.ts:906`), which names a finding left as `superseded` that the fix removes, gains that finding's settled choice when it has one, in the same form, since the fix acts on that finding too. The fixer's task does not get the verifier's choice as a field. A fix with a departure need not carry a settled choice, so its fixer can read the verifier's note in the evidence with no settlement beside it; the requirements accept this gap under principle 2.

### The report on the machine (R6)

`decision-report.ts` gains the label of `settled` and gives, after the grounds of each decision of `fix` or `leave`, the same lines as the form by the same rule, in English, since the report is in English today. It reads the finding's `authorChoice` from its resolution in the review state, which it does not read today.

### An older run (R7)

A run decided at version 1 folds with `settled: null` on every decision and is rendered as any other. A finding that it left as is with an `authorChoice` goes in `leftAsIs` with `words.unsettledChoice(authorChoice)`, and a fix of a finding with an `authorChoice` gives the same line in its comment. A run with verdicts at version 1 or 2 has no `authorChoice`, so its findings carry none of these lines, at either version of its decisions.

### The golden fixture

The change adds `decisions.recorded@2` and a vocabulary version, so a fixture `schema-1-20` is committed with `npm run golden -- --output test/fixtures/checkpoints/schema-1-20`, and the older fixtures still open and fold. The runs of `scripts/golden-checkpoint.ts` all record their decisions at version 1 today, so a fixture made from them would hold no version 2 and prove nothing about a later engine reading one. The script gains a run whose decisions are at version 2, with a `settled` leave, an `intended` leave with a settled choice, a fix with a settled choice and a leave as outside the change of a finding whose verifier named a choice, and `golden.test.ts` holds what that run folds to, as it holds each earlier run that brought a new version.

Two tests hold today's leave reasons through the frozen vocabulary: `test/checkpoint/events-vocabulary.test.ts:382` and `:507` hold `reviewVocabularyV4` equal to `leaveReasons`, and `test/review/vocabulary.test.ts:60` pins the list. The first two hold `reviewVocabularyV4` to a literal of the three reasons instead, as the file holds an older list of phases to `phasesBeforeAnswers`, and a new assertion holds `reviewVocabularyV13` to today's `leaveReasons` and `settleSteps`. The third gains `settled`.

### Where the code goes

- `src/review/vocabulary.ts`: `settleSteps` and the fourth leave reason.
- `src/review/schemas.ts`: the answer and `checkDecisions`.
- `src/review/phases.ts`: the task's findings, the failures given to the next attempt and the event's version.
- `src/review/tasks.ts`: the candidate lines, the decider's task, and the fixer's decided lines and `removes also:` lines.
- `src/review/explanation.ts`: the writer's decision lines.
- `src/checkpoint/events.ts`: the event and the vocabulary.
- `src/checkpoint/review-fold.ts`: the reducers and the rules of R2.
- `scripts/golden-checkpoint.ts`: the run at version 2.
- `src/review/pull-request-form.ts` and `src/review/pull-request-words.ts`: the form, without the author rule.
- `src/review/decision-report.ts`: the report.
- `roles/fragments/decider-rubric.md`: the prompt.
- `dist/`: rebuilt in the last commit of the series.

## Technical Decisions

### TD1: A new version of `decisions.recorded`, which any run may record

`verdicts.recorded` follows the run's configuration, because a run records many of them and must never mix two answers (R9 of runs on the record). `explanation.recorded` follows it too, though a run records it once: a run of a pull request that an earlier engine configured keeps its writer's answer as it was when this engine resumes it (`events.ts:2722`, `review-fold.ts:855`). Decisions depart from that precedent. Tying them to the configuration would take a new version of `review.configured` for each of the two configurations an engine writes today, version 11 for a read-only run of a pull request, which explains its review, and version 9 for every other run (`controller.ts:1414`), to spare a run configured before the change and resumed after it the new answer. A run records its decisions once, so it cannot mix two versions, and the fold accepts either version in any run without a new version of `review.configured`. The engine of this change always records version 2. A run configured before the change and resumed after it with its old roles records version 2 too, from a decider whose rubric does not name the settled choice, its steps or `settled`. The schema still asks for the field, the decider's task states the steps and the table of R2 ("The decider's task" above), and a check that refuses the answer runs the decider again with what failed (R9 and RK3 of the requirements).

### TD2: The step is an enum that the engine words, and the source is text

The seven steps are the rubric's order and the two other ways its table reaches `fix`, so an enum costs no judgment the decider does not already make, and it lets the form give the step in the review's language and the gate count the steps across runs (PD6 of the requirements). The source is the decider's sentence in plain words, which the review shows, and the grounds keep its citation.

### TD3: The phase and the fold both hold the rules of the settlement

`checkDecisions` refuses an answer that breaks R2 or R3, so the decider is run again before anything is recorded, and the fold refuses a `decisions.recorded@2` that breaks them, so no engine fault and no hand-edited ledger can record one. This is how `verdicts.recorded@3` holds that a `PLAUSIBLE` verdict says what keeps it from `CONFIRMED`: the verifier's check and the fold both hold it (`recordVerdicts` in `review-fold.ts`). Whether a finding names a choice is a fact of the ledger, the members the ranking records and their verdicts at version 3; `mergedResolution` only picks which candidate's choice the form shows, and a finding has a non-null one exactly when one of its candidates records one (`state.ts:137`), so the fold reads the fact and not the engine's rule for showing it.

The cost is that the rules of version 2 are fixed: an older ledger must always fold, so a later change to what a settlement must hold, such as a new step, is a new version of the event, not an edit of these rules.

### TD4: A frozen vocabulary for the new reason

`decisions.recorded@1` reads its leave reasons from `reviewVocabularyV4`, so adding `settled` to `leaveReasons` in `vocabulary.ts` does not change the old schema. Version 2 reads them, and the seven steps, from `reviewVocabularyV13`, the next frozen vocabulary after `reviewVocabularyV12`, which a test holds equal to today's vocabulary as it holds each earlier one. A newer engine still reads an older ledger, and the golden test sees the change.

### TD5: The form does not read the version of the decisions

The author rule is removed for every run (PD7 of the requirements), so nothing in the form depends on the version at which a run recorded its decisions. A run decided at version 1 folds with `settled: null`, and the form shows each choice that its verifiers named as not settled by deep-review, which is true of it. The review state needs no `decisionsVersion`, and the fold keeps no field for it.

## Open Questions

### OQ1: Closed: does the decider fill the settled choice when its verifier named none?

Closed, since the design answers it. Where the verifier named no choice, R2's table makes a settled choice optional on a fix, an `intended` leave and a `superseded` leave, requires one on a `settled` leave, and the rubric invites the decider to record each choice it settles. The form, the report and the tasks of the writer and the fixer show a settled choice wherever a decision carries one, whether or not its verifier named a choice ("The form", "The writer's task", "The fixer's task" and "The report on the machine" above), so nothing is left to decide about showing it.

### OQ2: Should the verifier stop writing `Needs the author:` in the evidence of a read-only run?

The decider now reads the choice as a field, so the note in the evidence is read twice in those runs. Removing it changes the verifier's rubric, which NG1 of the requirements leaves out. It is a candidate for the change that tightens how readily a verifier names a choice.

## Test Strategy

### TS1: The decider's task (R1, R2)

A test of `deciderTask` that gives a candidate with an `authorChoice` and an `unconfirmed` and holds the line of the choice and no line of `unconfirmed`, and one that gives the fixer's task the same candidate and holds that the line of the choice is not printed. A test holds that the decider's task states each of the seven steps on a line of its own and each row of the table of R2.

### TS2: The answer and its check (R2, R3)

One table-driven test runs every case of the table of R2 through both `checkDecisions` and the fold. The cases are each kind of decision, an ask, a fix with and without a departure, and a leave for each of its four reasons, on a finding whose verifier named a choice and on one whose verifier named none, with no settled choice and with a settled choice by each of the seven steps. The test holds that the phase and the fold each accept or refuse every case as the table says. A test of the decision phase holds that it records version 2 and passes each finding's choice to `checkDecisions`, in place of the test that pins version 1 (`test/review/phases.test.ts:428`). The test of `repository.test.ts` that holds the rubric's leave reasons to `leaveReasons` reads only the section that begins "The reasons a finding is left, and no others:" and covers the fourth reason, and a new one reads only the section "Settling a choice" and holds its labels, in order, to `settleSteps`.

### TS3: The event and the fold (R2, TD1, TD3)

Tests of the fold that read `decisions.recorded` at versions 1 and 2 in one kind of run each, and give `settled: null` for version 1. The table-driven test of TS2 holds the fold's refusals, and a test refuses a version 2 in which a fix has no settled choice while the verdict of a member of its finding, not of its primary, records a choice. The golden fixtures `schema-1-19` and `schema-1-20`.

### TS4: The form (R4, R5, R7)

The four tests of `test/review/pull-request-form.test.ts` that pin the author rule are rewritten to the new behavior: on a run decided at version 1, a finding left as is whose verifier named a choice is not in what needs a person, not counted for the author, and in the folded section with the verifier's choice and the statement that deep-review did not settle it. New tests post a run decided at version 2 with a finding left as `settled` whose verifier named a choice, and hold that it is not in what needs a person and is in the folded section with its verifier's choice and its settled line, and one with a finding left as outside the change whose verifier named a choice, which holds the verifier's choice and the statement that deep-review did not settle it on its line. A test of a fix with a departure, a verifier's choice and no settled choice holds the verifier's choice and that statement in its comment, and a test of an ask whose verifier named a choice holds that its block shows neither. A test of a body cut at `left` holds that the lines of the findings whose verifier named a choice stay and the others are worded as the other findings left as is, and a test in which no finding left as is has a verifier's choice holds `words.leftCut`. A test holds the verifier's choice and the settled line in the comment of a fix, and a test of the words holds `settleSteps` in both languages.

### TS5: The writer's and the fixer's tasks (R5)

A test of the writer's task that gives a fix with a settled choice and holds its `settled:` line under the decision, with the step in words and not its raw value, and one of the fixer's task that holds the same line in its decided lines and the settled choice of a finding left as `superseded` on its `removes also:` line.

### TS6: The report (R6)

A test of `decision-report.ts` that gives a `settled` leave whose verifier named a choice and holds its label, the verifier's choice and its settled line, and one that gives a leave as outside the change whose verifier named a choice and holds the statement that deep-review did not settle it.

### TS7: The gate (R8)

The gate's runs, recorded under Verification with the metrics of the requirements, whether each met its target, and whether the run of #96's change reached the finding of #107 or left that case untested.

### TS8: A refused answer, named to the next attempt (R9)

A test of `checkDecisions` that gives an answer breaking two rules in two decisions and holds that one refusal names both, each with its decision's index. A test of the decision phase whose first answer is refused, and that holds the second task to name, under "What failed in the earlier answer", the refused rules with their indexes, and not a failure of another cause.

## Verification

### Implementation

Seven commits implement the design, from "feat(review): Name every fault of a decider's answer in one refusal" to "chore(dist): Rebuild the engine for the settled choice". The rules of the settled choice are one table, `settlementRulesV1` in `src/checkpoint/events.ts`, beside `reviewVocabularyV13` and `decisions.recorded@2`, since the rules of version 2 are fixed with the event; `settlementFaultV1` reads it for `checkDecisions` and for the fold, and the decider's task states the steps and the table from the same source. `test/review/settled-choice.test.ts` writes the table of R2 out literally and runs every case, each decision kind with and without a verifier's choice and with no step or each of the seven, through both `checkDecisions` and the fold. The golden script gains a run at version 2, and the fixture `schema-1-20` holds it. The author rule, its words in both languages and its paths are removed, and the four tests that pinned it now hold the new placement. The rubric's change is its own commit, "feat(roles): Tell the decider how to record a choice it settles"; the commit before it holds the rubric's list of leave reasons to the three it still names, and that commit restores the strict test, scoped to the list of the reasons, with a new test of the list of the steps.

Choices made in the work, within the requirements: the cut of the findings left as is is not made when every one of them carries a verifier's choice, since it would remove nothing; when some do, the others are counted with their own words. The verifier's choice is shown beside fixes and findings left as is, in the form and in the report, and not beside an ask. The rubric asks a leave as `intended` or `settled` always to name its settled choice, which is more than the engine refuses for `intended`. The Korean words of the steps, of the choice lines and of the reason `settled` have not been read by a native speaker.

### Checks

At the head of the series, `npm run check` passed (3,590 tests: 3,577 pass, 13 skipped, none fail), `npm run test:contract` passed (104 of 104), and `npm run verify` found `dist/claude` and `dist/codex` matching the sources. Every commit of the series passed `npm run typecheck` and `npm run lint`.

### The gate (R8)

The gate ran once, by the engine built from the commit "docs(changes): Record the implementation of settled choices" (bundle hash `09cb37aa`), with Claude Code 2.1.318 and Node 26.12.1 on Linux. Each of the four runs had its own fresh clone with its dependencies installed, ran `review --pr` read-only with the defaults of the run's configuration, and was printed with `publish --dry-run`; no review was posted. The dry runs, the reports of the four runs and their checkpoints are kept by the author outside the repository; the numbers below are theirs.

The copy that R8 names is deep-review/deep-review-gate, a private repository of the author's organization, and its three pull requests hold the commits that the posted reviews of #114 and #96 reviewed, on the base those reviews had. deep-review/deep-review-gate#1 holds #114's commits from the merge base b5c68b92 to 34fb5a7c, the head that its posted review names: 13 commits and 40 files, with 113 more paths left out by `scope.exclude`. deep-review/deep-review-gate#2 holds the same commits replayed on 4d73ee3e, which is b5c68b92 with one commit that adds `review.language = "ko"` to `.deep-review/config.toml`, so the repository's file of the base sets the language, as in the gate of the review on the pull request; its head, 339f66cc, differs from 34fb5a7c only in that line. deep-review/deep-review-gate#3 holds #96's commits from the merge base 89e5499e to 7d22694c, the head that its posted review names: 27 commits and 91 files, with 115 more paths left out, the scope of the gates of the severity rubric. The heads of #114 and #96 when they were merged are not used: they add the commits of their fix passes, which deep-review made after those reviews, and #96's add changes to the cleaning that the finding of #107 is about. The review of this pull request ran on it at the commit named above: 34 commits and 34 files from the merge base with main, with 110 more paths left out.

| | #123, English | Copy of #114, English | Copy of #114, Korean | Copy of #96, English |
|---|---|---|---|---|
| Findings | 15 (2 major) | 30 (5 major) | 33 (5 major) | 33 (1 critical, 10 major) |
| Decisions | 7 fix, 8 leave, 0 ask | 22 fix, 7 leave, 1 ask | 23 fix, 9 leave, 1 ask | 27 fix, 2 leave, 4 ask |
| Departures | 0 | 4 | 3 | 0 |
| Verifier named a choice | 10 | 21 | 25 | 14 |
| Spent | 19.97 USD, about 25 min | 30.41 USD, about 35 min | 29.52 USD, about 34 min | 34.27 USD, about 37 min |
| Body, comments | 32,955, 5 comments | 37,879, 22 comments | 36,939, 20 comments | 30,074, 30 comments |

Each run recorded its decisions at `decisions.recorded@2` and its verdicts at version 3, and no body was cut.

Stops and refusals (RK3). The four runs ran at once, and each stopped once at the five-hour usage limit of Claude, three in verification and the review of #96 in its finders, with the blocker `worker-failed` and the action to run the command again. The same command after the reset resumed each, and each reached its report with no other stop. The decider's answer was never refused: each run's decision phase completed at its first attempt. Two verifier answers, one in each run of #114, were refused by the structural check of a cited run that the verifier's record did not hold, and the retry of each passed. The engine behaved as the README and the resumable runs proposal describe in each case.

M1, the length of what needs a person. The English review of #114 lists 5 items, 1 question and 4 departures, against the inferred baseline of 6, so it meets the target whatever the author judges of its question. The Korean review lists 4 items, 1 question and 3 departures; the review of #96 lists 4 questions and no departure; and the review of this pull request lists none, and says that nothing needs a person. In every run each item is a question or a departure, and no finding left as is is in the list. Whether each of the 6 questions could only be answered by a person is the author's judgment, and is pending.

M2, fixes that edit nothing. The approaches of the 79 decisions of `fix` were read by hand. One makes no edit: in the Korean review of #114, finding 6, a commit subject over the length that AGENTS.md allows, is decided `fix` with an approach that rewords the commit when the branch's history is next rewritten and says that no file in the tree changes, settled by `none`. A fixer cannot make it. So the gate misses M2's target of none by that one decision, unless the author reads a reworded commit as an edit. The English review of #114, which held 3 such fixes in #115, holds none. A fix that edits only documentation or a comment, such as the README, was counted as an edit.

M3, where the verifiers' choices end. Of the 70 findings whose verifier named a choice, the decider asked about 6; fixed 33 with a settled choice; fixed 6 with a departure, 4 of them with a settled choice and 2, both in the English review of #114, without one, whose comments show the verifier's choice with the statement that deep-review did not settle it; and left 25 with a settled choice, 13 as `intended` (12 by `intent`, 6 of them in the review of this pull request, and 1 by `contract`), 9 as `settled` by `shape`, and 3 as `superseded`, 2 by `kept` and 1 by `intent`. No finding was left as outside the change. The steps of these 62 settlements are `intent` 24, `contract` 14, `shape` 14, `before` 6, `kept` 3 and `none` 1, and 18 more decisions, all fixes but one leave as `settled`, settle a choice that no verifier named. Whether each settlement was a question of direction that deep-review should have asked is the author's judgment, and is pending; until it is given, M3 is not met or missed.

The case of #107. The review of #96 surfaced the finding again as finding 1, critical and `CONFIRMED`: `publish` cleans the posted text with the values of its own environment, not of the environment the review's workers ran with, so a secret given only to the review step and printed by a run a verifier cites is posted in clear. Its verifier named the choice, to clean with the review's environment or to keep the documented risk and tell the user to give the posting step the same variables. The decider asked: the question is the first item of what needs a person, with three options, keeping the code as documented (applied until someone answers), telling users in the README to give the posting step the review's secret variables (recommended), and cleaning the review's environment when the output is recorded. This meets R8's case of #107, which passes when the finding is asked.

Two observations, for the author. First, 79 of the 80 settled choices are written as the choice still open, as "Whether X or Y", so the review reads "deep-review settles it: Whether X or Y", and only the source sentence says which way it went. The rubric asks the decider to write the choice "as you write a question", meaning for a reader who did not read the change, and the decider took it literally; whether the line reads well for that reader is a matter of principle 6. Second, the review of this pull request found, as finding 2, major and `PLAUSIBLE`, that the line of a merged finding shows the choice of one member's verifier only, so a choice that another member's verifier named is missing from the review, against PD8; deep-review decided to fix it. Its finding 1, major and `CONFIRMED`, says that a choice that no decision settles no longer reaches the first screen, and is left as `intended` by this proposal's own R4 and R7, which the author reads first.

The gate is not settled. M1 is met, the case of #107 is met, M2 is missed by one decision, and M3 waits for the author. The author's judgments, of the 6 questions and of the 80 settled choices with the finding, the decision, the step, the source and the evidence of each, are on a sheet kept by the author outside the repository, and are pending.
