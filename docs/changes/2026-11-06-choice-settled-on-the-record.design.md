# Technical Design: The decider settles each choice on the record

Product part: [2026-11-06-choice-settled-on-the-record.requirements.md](2026-11-06-choice-settled-on-the-record.requirements.md).

## Summary

The decider's task gains one line per candidate: the choice its verifier leaves to the author, from the field `authorChoice` that `verdicts.recorded@3` already records. The decider's answer gains, on each decision, an optional settled choice `{choice, by, source}`, where `by` is one of seven steps, the five of the rubric's order and two the rubric gives a fix outside it, and a fourth reason to leave a finding, `settled`. `checkDecisions` and the fold both hold the table of R2, which decision may carry a settled choice, must carry one or must not, and with which steps. The ledger records the new answer as `decisions.recorded@2`, which any run may record, since a run records its decisions once, and the fold reads version 1 with no settled choice. The form drops the author rule, R9 of the review that reads as a report, for every run, a run decided at version 1 included. Wherever the form or the report shows a decision of `fix` or `leave` of a finding whose verifier named a choice, it shows that choice beside the settled one, or says that deep-review did not settle it. The decider's rubric says that a fix edits, when a decision is left as `settled`, and that a choice between two behaviors that nothing stated settles is asked, with keeping the code as the default, even when the order would keep it.

## Non-Goals

### No change to the verifier

`verifierOutputSchemaV3`, `verdicts.recorded@3`, `notesParagraph` in `src/review/tasks.ts` and `roles/fragments/rubrics.md` stay. The verifier's `Needs the author:` note stays in its evidence, so in a read-only run of a pull request the decider reads the choice twice, once as the field and once in the evidence.

### No change to the fixer's routes

`routeOfDecision` in `src/checkpoint/fix-state.ts:1019` already routes a `leave` to `held`, so a finding left as `settled` reaches no fixer, and routes to `held` too an `ask` whose applied option does not edit, so an ask whose default keeps the code reaches no fixer either. The fixer's task gains the settled choice of its decision and of each finding that its fix removes, which "The fixer's task" below gives, and nothing else of the fixer changes.

### No change to what the writer explains

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

### The event and the fold (TD1, TD3)

`decisionsRecordedV2` holds `recordedDecisionSchemaV2`: each variant of version 1 with `settled` beside `departure`, and the leave reasons of a new frozen vocabulary, `reviewVocabularyV13.leaveReasons`, with `settled`; the settled choice's `by` takes `reviewVocabularyV13.settleSteps`. The fold applies to version 2 the same rules as to version 1, and every rule of R2 and R3 that `checkDecisions` holds, the one that depends on the verifier's choice included: a finding names a choice when the verdict of its primary or of one of its members, as the ranking records them, records an `authorChoice` at version 3 (TD3). The reducer of version 1 gives every decision `settled: null`. The review state does not record the version that its decisions were recorded at, since nothing reads it (TD5).

### The rubric (R1, R2, R3)

`decider-rubric.md` changes in seven places, in a commit of its own:

1. Its first paragraph names the choice left to the author as a line of the candidate, and still calls it a verifier's view to settle or ask about, not an answer.
2. "Settling a choice" labels each step of the order with its value, as a list the test of `repository.test.ts` reads, in the form ``- `intent`: the change's stated intent``. The paragraph on a choice between two shapes that only a maintainer would see becomes the fifth item, `shape`, with its whole rule: the one the surrounding code already uses, else the one that adds less. R2's words for `shape` are this rule.
3. The table of the three decisions says that a `fix` edits the code, names in its `fix` row the two steps outside the order, `none` for "acting needs no choice" and `scope` for the part of a result inside the change, and says that a choice the order settles without an edit is not fixed: it is left as `intended` or `settled`, or, when it is a choice between two behaviors that a caller or a user would see and only keeping a behavior that was there before settles it, asked, with a default that keeps the code and does not edit. Its `ask` row names that case, and its `leave` row says four reasons, not three.
4. Its list of reasons to leave gains `settled`, in the form the test reads: "`settled`: acting needs a choice between two shapes that only a maintainer reading the code would see, nothing stated settles it, and the rule for shapes keeps the code as it is; give the settled choice, by `shape`." The text of `intended` gains its second case: a choice that the change's stated intent or the repository's stated contract settles in favor of the code as it is, given with its settled choice by `intent` or `contract`. The text of `superseded` says to give, when the verifier named a choice, the settled choice that the superseding fix makes for the finding, by any step but `before`, and the text of `outside-change-not-regression` says that such a finding carries no settled choice.
5. A sentence after "Your decision names the choice and its answer" says to record a choice that the decision settles in `settled`, with its step and the source it rests on, and that the choice and the source are written as a question is, in plain words for a person who did not read the change, with no file, line, requirement number or internal name of the code, while the grounds cite; and that a `fix` with a departure records its choice in the departure instead.
6. The paragraph on a result that lies partly past the change names `scope` as the step of such a fix.
7. The section of the three decisions ends with the table of R2 of the requirements, which decision may carry a settled choice, must carry one or must not, and with which steps, with the reason of each row.

A test of `repository.test.ts` holds the labels of the order and the two steps of the table, in order, to `settleSteps`, as the test of the leave reasons holds the list of reasons to `leaveReasons`.

### The form (R4, R5, R7)

`forAuthor` and `authorBlocks` are removed for every run, with the item for the author in what needs a person, the summary's count `authors`, and their words `needsAuthor`, `whyLook`, the word `authorChoice` and the summary's sentences on findings left for the author, in English and Korean. A finding decided `leave` with an `authorChoice` then goes in `leftAsIs` in every run, is not in full in the body unless it was there for another reason, and is not counted or listed as for the author. Each line of the findings left as is gives after the reason and the grounds, for a finding with an `authorChoice`, `words.verifierChoice(authorChoice)`, the choice labeled as its verifier's, followed by `words.settledChoice(choice, words.settleSteps[by], source)` when the decision settles a choice; when it settles none, the line gives `words.unsettledChoice(authorChoice)` instead, which names the choice as the verifier's and says deep-review did not settle it. A finding with no `authorChoice` gives `words.settledChoice(...)` when its decision carries a settled choice, and nothing more. The `left` cut of `bodyCuts` (`pull-request-form.ts:111`) changes with it: `leftSection` cut keeps the lines of the findings that carry either line and gives `words.leftCut` for the others only, so a body over the limit still shows each choice that a verifier named. Each such line holds at most about 1,200 characters of the workers' text, the verifier's choice (`verifierNoteLengthV1`), the settled choice and its source being up to 400 each, and the cuts after `left` still apply if the body stays too long. `decisionBlocks` gives a `fix` the same lines by the same rule after the sentence of what deep-review would do, or for a minor finding after its paragraph, in its comment and in its text in the body. The folded table of minor findings does not change, since its cell of what deep-review would do is one sentence. An ask's question is the record of its choice, so `decisionBlocks` gives an `ask` none of these lines. The words gain `settleSteps` in English and Korean, `verifierChoice`, `settledChoice`, `unsettledChoice`, and the label of `settled` in `leaveReasons`.

### The writer's task (R5)

The writer's task prints each candidate's verifier choice through `noteLines` (`explanation.ts:876`), and the decision through `decisionLines` (`explanation.ts:851`), which shows no settlement. A writer that explains a fix could then present the verifier's choice as open beside the engine's line that says how it is settled. `decisionLines` gains, for a decision with a settled choice, `        settled: <choice>, by <step>: <source>`, labeled as the decision's, and the task says that a choice the decision settled is not the author's to make. No check of the answer changes.

### The fixer's task (R5)

The fixer's task prints each candidate's evidence (`candidateLines`, `tasks.ts:738`), which in a read-only run of a pull request still ends with the verifier's `Needs the author:` note, and such a run can be continued into a fix pass with `--fix`. `decidedLines` (`tasks.ts:750`) prints the grounds, the approach, the rejected options and the departure, and no settlement. A fixer could then hold the verifier's open choice beside an approach that does not spell out how the decision settled it, and make the choice itself, which principle 2 does not permit. `decidedLines` gains, for a `fix` with a settled choice, `        settled: <choice>, by <step>: <source>`, so the fixer applies the choice the decision made. Each `removes also:` line (`tasks.ts:906`), which names a finding left as `superseded` that the fix removes, gains that finding's settled choice when it has one, in the same form, since the fix acts on that finding too. The fixer's task does not get the verifier's choice as a field. A fix with a departure need not carry a settled choice, so its fixer can read the verifier's note in the evidence with no settlement beside it; the requirements accept this gap under principle 2.

### The report on the machine (R6)

`decision-report.ts` gains the label of `settled` and gives, after the grounds of each decision of `fix` or `leave`, the same lines as the form by the same rule, in English, since the report is in English today. It reads the finding's `authorChoice` from its resolution in the review state, which it does not read today.

### An older run (R7)

A run decided at version 1 folds with `settled: null` on every decision and is rendered as any other. A finding that it left as is with an `authorChoice` goes in `leftAsIs` with `words.unsettledChoice(authorChoice)`, and a fix of such a finding gives the same line in its comment. A run with verdicts at version 1 or 2 has no `authorChoice`, so its findings carry none of these lines, at either version of its decisions.

### The golden fixture

The change adds `decisions.recorded@2` and a vocabulary version, so a fixture `schema-1-20` is committed with `npm run golden -- --output test/fixtures/checkpoints/schema-1-20`, and the older fixtures still open and fold. The runs of `scripts/golden-checkpoint.ts` all record their decisions at version 1 today, so a fixture made from them would hold no version 2 and prove nothing about a later engine reading one. The script gains a run whose decisions are at version 2, with a `settled` leave, an `intended` leave with a settled choice, a fix with a settled choice and a leave as outside the change of a finding whose verifier named a choice, and `golden.test.ts` holds what that run folds to, as it holds each earlier run that brought a new version.

Two tests hold today's leave reasons through the frozen vocabulary: `test/checkpoint/events-vocabulary.test.ts:382` and `:507` hold `reviewVocabularyV4` equal to `leaveReasons`, and `test/review/vocabulary.test.ts:60` pins the list. The first two hold `reviewVocabularyV4` to a literal of the three reasons instead, as the file holds an older list of phases to `phasesBeforeAnswers`, and a new assertion holds `reviewVocabularyV13` to today's `leaveReasons` and `settleSteps`. The third gains `settled`.

### Where the code goes

- `src/review/vocabulary.ts`: `settleSteps` and the fourth leave reason.
- `src/review/schemas.ts`: the answer and `checkDecisions`.
- `src/review/phases.ts`: the task's findings and the event's version.
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

`decisions.recorded@1` reads its leave reasons from `reviewVocabularyV4`, so adding `settled` to `leaveReasons` in `vocabulary.ts` does not change the old schema. Version 2 reads them, and the steps of the order, from `reviewVocabularyV13`, the next frozen vocabulary after `reviewVocabularyV12`, which a test holds equal to today's vocabulary as it holds each earlier one. A newer engine still reads an older ledger, and the golden test sees the change.

### TD5: The form does not read the version of the decisions

The author rule is removed for every run (PD7 of the requirements), so nothing in the form depends on the version at which a run recorded its decisions. A run decided at version 1 folds with `settled: null`, and the form shows each choice that its verifiers named as not settled by deep-review, which is true of it. The review state needs no `decisionsVersion`, and the fold keeps no field for it.

## Open Questions

### Does the decider fill the settled choice when its verifier named none?

R2 asks for a settled choice only when the verifier named a choice or the decision is `settled`. A decider may also give one for a fix that makes a choice the verifier did not name, which the rubric's sentence invites. The gate counts how often it does, and whether the form should show those too is decided on what it shows.

### Should the verifier stop writing `Needs the author:` in the evidence of a read-only run?

The decider now reads the choice as a field, so the note in the evidence is read twice in those runs. Removing it changes the verifier's rubric, which NG1 of the requirements leaves out. It is a candidate for the change that tightens how readily a verifier names a choice.

## Test Strategy

### R1: The decider's task

A test of `deciderTask` that gives a candidate with an `authorChoice` and an `unconfirmed` and holds the line of the choice and no line of `unconfirmed`, and one that gives the fixer's task the same candidate and holds that the line of the choice is not printed. A test holds that the decider's task states each of the seven steps on a line of its own and each row of the table of R2.

### R2 and R3: The answer and its check

Tests of `checkDecisions` that refuse a fix of a finding with a choice and no settled choice, a `settled` leave with none, and an ask with one, an `intended` leave and a `superseded` leave of a finding with a choice and none, an `outside-change-not-regression` leave with one, a `settled` leave whose step is `kept`, an `intended` leave whose step is `kept`, and a `superseded` leave whose step is `before`, and accept an `outside-change-not-regression` leave of a finding with a choice and no settled choice. A test of the decision phase holds that it records version 2 and passes each finding's choice to `checkDecisions`, in place of the test that pins version 1 (`test/review/phases.test.ts:428`). The test of `repository.test.ts` that holds the rubric's leave reasons to `leaveReasons` covers the fourth reason, and a new one holds the rubric's steps of the order to `settleSteps`.

### R2 and TD1: The event and the fold

Tests of the fold that read `decisions.recorded` at versions 1 and 2 in one kind of run each, refuse a version 2 with a `settled` leave and no settled choice, with a fix of a finding whose member's verdict records a choice and no settled choice, and with an `ask` that carries one, and give `settled: null` for version 1. The golden fixtures `schema-1-19` and `schema-1-20`.

### R4, R5 and R7: The form

The four tests of `test/review/pull-request-form.test.ts` that pin the author rule are rewritten to the new behavior: on a run decided at version 1, a finding left as is whose verifier named a choice is not in what needs a person, not counted for the author, and in the folded section with the verifier's choice and the statement that deep-review did not settle it. New tests post a run decided at version 2 with a finding left as `settled` whose verifier named a choice, and hold that it is not in what needs a person and is in the folded section with its verifier's choice and its settled line, and one with a finding left as outside the change whose verifier named a choice, which holds the verifier's choice and the statement that deep-review did not settle it on its line. A test of a fix with a departure, a verifier's choice and no settled choice holds the verifier's choice and that statement in its comment, and a test of an ask whose verifier named a choice holds that its block shows neither. A test of a body cut at `left` holds that the lines with a choice stay and the others become their count. A test holds the verifier's choice and the settled line in the comment of a fix, and a test of the words holds `settleSteps` in both languages.

### R5: The writer's task

A test of the writer's task that gives a fix with a settled choice and holds its `settled:` line under the decision, and one of the fixer's task that holds the same line in its decided lines and the settled choice of a finding left as `superseded` on its `removes also:` line.

### R6: The report

A test of `decision-report.ts` that gives a `settled` leave whose verifier named a choice and holds its label, the verifier's choice and its settled line, and one that gives a leave as outside the change whose verifier named a choice and holds the statement that deep-review did not settle it.

### R8: The gate

The gate's runs, recorded under Verification with the metrics of the requirements.

### R9: A refused answer, named to the next attempt

A test of `checkDecisions` that gives an answer breaking two rules in two decisions and holds that one refusal names both, each with its decision's index. A test of the decision phase whose first answer is refused, and that holds the second task to name, under "What failed in the earlier answer", the refused rules with their indexes, and not a failure of another cause.

## Verification

No checks have run yet.
