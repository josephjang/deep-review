# Technical Design: The review that reads as a report

Product part: [2026-11-04-review-that-reads-as-a-report.requirements.md](2026-11-04-review-that-reads-as-a-report.requirements.md).

## Summary

The form of `src/review/pull-request-form.ts` is rewritten to the order and the parts of the template: the body gets a summary, what needs a person, the counts of the run, the major findings by area, and folded sections for the minor findings, the findings left as is and the refuted candidates; each comment states each fact once, links its code at the reviewed head, and folds the decided fix and one line of how it was checked. Two answers gain fields. The verifier gives why a verdict is `PLAUSIBLE` and the choice it leaves to the author, recorded by `verdicts.recorded@3`. The writer gives areas, a kind for each minor finding, one line of how each finding was checked and one line for each refuted candidate, and no longer writes the account of the change, recorded by `explanation.recorded@2`. The engine's words for both languages change with the form. A run recorded before the change is posted in the new form, with the engine's words where its answers lack a part.

## Non-Goals

### No change to the place of a finding or to the cleaning

`placeFindings`, the Speaker and its cleaning of every text that the engine did not write, the marker of a publication and of each comment, and the record before the post stay as they are.

### No change to the brief

`Brief` and `briefOf` keep their fields, so the report, the chat and `briefJson` do not change. The counts that the form needs are read from the run's state by the form (TD3).

### No change to the finders, the deduplication, the ranker or the decider

Their prompts and schemas stay. The decider still reads the verifier's choice as a hint, now from a field as well as from the evidence.

## Context

### The form today

`renderBody` (`pull-request-form.ts:689`) joins, in order: the heading; `conclusionSection`, with the engine's needs line, the writer's `conclusion.why`, one line per acting finding with its `actions` sentence, and the conclusion's diagram; `changeSection`, with the title, the core of the brief and the writer's account folded; `statusSection`; `gapsSection`; `tableSection`, a table of all findings; `inFullSection`, each fix or question with no line in the diff; `leftSection` and `refutedSection`, folded; `excludedSection`; `legendSection`; and `lastSection` with the marker. `commentOf` (412) gives the title, the status paragraph, the writer's problem, cases and diagram, the engine's decided fix and rejected options or the question with its options, the writer's `decision`, and the folded evidence: summary, reason, evidence and cited runs. A finding on a line links to the diff by `lineUrl` (273), `files#diff-<sha256>R<line>`; the others link by `blobUrl` (268). `pullRequestForm` (742) fits the body under 60,000 characters with `bodyCuts` (116): the account's diagrams, the account, the refuted candidates, the findings left as is.

### The writer's answer

`writerOutputSchema` (`schemas.ts:225`) holds `conclusion {why, actions[{id, sentence}], diagram}`, `account {terms, problem, change}` and `findings[{id, explanation {title, problem, cases, diagram, decision} | null, unexplained}]`. `recordedAnswerSchema` (`explanation.ts:56`) flattens it, and `explanation.recorded@1` (`events.ts:2665`) records the answer as an artifact with the parts it dropped, whose `part` is `conclusion`, `account` or `finding`. `checkAnswer` (`explanation.ts:444`) checks one sentence per acting id, no verdict word, the cited lines and the diagrams; `writerTask` (700) gives the brief and the findings with their decisions and candidates.

### The verifier's answer

`verifierOutputSchemaV2` (`schemas.ts:153`) holds `{index, verdict, evidence, basis, runs}` per verdict, recorded by `verdicts.recorded@2` (`events.ts:2371`). The rubric (`roles/fragments/rubrics.md:39-45`) tells the verifier to end its evidence with `Not CONFIRMED: ...` and to add `Needs the author:` with a choice that the code leaves open; the decider's rubric (`roles/fragments/decider-rubric.md:5`) reads that note as a hint.

### The words

`pullRequestWords` (`pull-request-words.ts:463`) returns one of two tables, `english` and `korean`, of about 96 keys each, strings and functions that build sentences.

## Design

### The verifier's two fields (R7, R9, TD1)

`verifierOutputSchemaV3` adds to each verdict `unconfirmed: {kind: 'fact' | 'choice', text: string up to 400} | null` and `authorChoice: string up to 400 | null`. `unconfirmed` is required for `PLAUSIBLE` and must be null for the other verdicts; the phase refuses an answer that breaks this, as it refuses a missing basis today. `authorChoice` names the two behaviors, as the note does now. `verdicts.recorded@3` records both beside `basis` and `runs`; the fold reads versions 1 and 2 with both fields null. The rubric says to give the two fields and keeps the two notes in the evidence line for the decider, which reads them as it does today.

### The writer's answer, version 2 (R4, R6, R10, R11, R13, TD2)

`writerOutputSchemaV2` drops `account` and adds:

- `areas[{title up to 200, intro up to 600, diagram, findings: id[] up to 200}] up to 12`, for the major findings that ask a person to act;
- on each explained finding, `checked up to 400`, one line of what the verifier did and saw, and for a minor finding `kind: 'user' | 'code'`;
- `refuted[{id, claim up to 300, why up to 300}] up to 200`, one line for each refuted candidate.

`conclusion.actions` keeps its shape and becomes the sentence of what deep-review would do; `conclusion.why` becomes the sentence of the summary that names the areas. `checkAnswer` adds: each major acting finding is in exactly one area and no other finding is in any; each minor acting finding has a kind; each refuted candidate has exactly one line; each area diagram passes `diagramFailures`; no verdict word in any new text. A part that fails twice is dropped as today, with `part` now `conclusion`, `areas`, `refuted` or `finding`. `explanation.recorded@2` records that, and `recordedAnswerOf` reads the artifact by the version of its event.

The writer's prompt (`roles/fragments/writer-explanation.md`) says what each part is for, that a title names what goes wrong for whom (R6), that `checked` names no path and quotes no command (R10), and that the account is no longer asked for. `writerTask` adds the refuted candidates with their evidence, and for each finding its verdict's basis, runs and `unconfirmed`.

### The counts (R3, R12, TD3)

A function of the form, `reviewCountsOf(state)`, gives the candidates recorded, the groups after deduplication, the verdicts by kind, the members merged into another finding, and the findings ranked, from the events that hold them; and, over the ranked findings, the verdicts, the bases and the major findings `CONFIRMED`. The body's section on how the review worked and the section on trust write them with the language's words.

### The body (R1, R2, R3, R12, R13)

`renderBody` becomes, in order: `headingSection`, the heading and the line on what the run reviewed; `summarySection`, the counts, `conclusion.why` and the line on what happens next; `needsSection`, R2's list, built from the brief's questions and departures and the findings of R9; `howSection`, the counts and a fixed diagram from the words; `areasSection`, each area with its title, intro, diagram and one line per finding; `inFullSection`, as today, plus a finding of R9 with no comment; `minorSection`, the counts and the folded table; `leftSection`, folded, without the finding of R9; `notExaminedSection`, the checks, `excludedSection`'s patterns and the refuted candidates folded, each a link and the writer's two sentences; `trustSection`; and `lastSection`. `conclusionSection`, `changeSection`, `statusSection`, `tableSection` and `legendSection` go.

### The comment (R5, R7, R8, R10, R14)

`commentOf` gives, in order: the title; one line from `words.grade` with the basis words and the decision; the writer's problem, with `words.whyPlausible(unconfirmed)` for a `PLAUSIBLE` verdict; the writer's diagram; for a fix, `words.wouldDo` with the action's sentence and the decided fix with its rejected options folded under `words.asDecided`; for a question, the question, its options with their costs, `words.standing(recommended, applied)` and the answer command; for a departure, the rule, its source, the fact against it and the command; `checked`, folded under `words.howChecked`; the cases as code lines at the head; and a small line with the id, then the marker. A minor finding puts its problem and its action's sentence in one paragraph. The verifier's summary, reason, evidence and runs are no longer posted (PD4 of the requirements).

### Links (R14, TD4)

Every link to code is `blobUrl` at the head, or at the base for a case on removed lines. `lineUrl` goes. A finding in the body keeps its in-page anchor. A finding with a comment is linked from the needs list, the areas and the minor table by its lines at the head, the lines its comment sits on, since GitHub gives the URL of a comment only once the review is posted (an open question below).

### Fitting (TD5)

`bodyCuts` becomes the refuted candidates, then the findings left as is, then the minor table, then the area diagrams. The needs list, the areas and the findings in full are never cut, and a body that does not fit without them is refused as today.

### The words (R15)

Both tables gain the keys of the new sections and lose those of the legend, the table's columns, the account and the needs line. The Korean table is written with the English one, key for key, and the test that each key of one is in the other stays.

### An older run (R16)

A run whose explanation is at version 1, or has none, is posted in the new form. The form puts its major acting findings in one area named by `words.findingsArea`; a minor finding with no kind is listed with the code; `checked` falls back to `words.basisSentence(basis)`; a refuted candidate falls back to its summary and `words.refutedInReport`; a verdict before version 3 has no `unconfirmed`, and `words.whyPlausible(null)` says the verifier gave no reason. The conclusion's sentences of version 1 serve as the actions. The account of version 1 is not posted.

### The golden fixture

The change adds `verdicts.recorded@3` and `explanation.recorded@2`, so a fixture `schema-1-19` is committed with `npm run golden`, and the older fixtures still open and fold.

### Where the code goes

`src/review/schemas.ts` and `src/review/phases.ts` for the verifier's answer; `src/checkpoint/events.ts` and `src/checkpoint/fold.ts` for the two events; `src/review/explanation.ts` for the writer's answer, its checks and its task; `src/review/pull-request-form.ts` and `src/review/pull-request-words.ts` for the form; `roles/fragments/rubrics.md` and `roles/fragments/writer-explanation.md` for the prompts, each change of what a prompt says in a commit of its own; and `dist/` rebuilt in the last commit of the series.

## Technical Decisions

### TD1: The verifier's reasons are fields of a new version of its answer

The reasons are in the evidence line already, and parsing them would need no new event. The proposal rejects the parse: two of #96's thirteen `PLAUSIBLE` verdicts wrote `Not CONFIRMED:` with nothing after it, and an engine that reads free text depends on a worker's wording. A field the phase checks is a contract, at the cost of a new version of `verdicts.recorded` and of the verifier's prompt.

### TD2: The writer stops writing the account

The account was folded in the first post, and the template leaves it out (PD3 of the requirements). Asking for it would cost the writer's budget for a part that is never posted. The report on the machine never showed it either.

### TD3: The counts come from the run's state, not from the brief

The brief has no count of candidates, groups or members, and adding them changes `briefJson`, which the non-goals keep. The form already reads the state for the refuted candidates.

### TD4: Every link is a permalink

A diff anchor moves when the pull request moves (#112), and a permalink at the reviewed head never does. A finding on a line is read in its comment, which GitHub shows on the line; the link in the body only has to reach it.

### TD5: The minor table is cut before the areas

Each minor finding has its comment, so a cut table loses nothing that is not on the pull request, while the areas are the only place in the body where a major finding is named.

## Open Questions

### Does GitHub keep a table inside a folded section?

The template's minor table sits inside `<details>` with blank lines around it. The post on #96 shows whether GitHub renders it.

### Does a link to an in-page anchor of a review body reach its heading?

GitHub prefixes the ids of headings with `user-content-`. The first post linked findings in the body by their anchor; whether the link scrolls in a review body, and not only in a comment of an issue, is read on #96.

### Should `publish` link the body to the comments after the post?

The template links each finding of the body to its comment, which a reader of the body wants, but a comment's URL exists only after GitHub makes the review. `publish` could edit the body once after the post, with the comments that `publish.posted` records, and settle a stop between the post and the edit by the marker. That is an edit of a posted review, which the review on the pull request leaves to a later change, and a new event of the publication. The proposal links to the lines for now, and the gate shows how much the reader misses.

### Is one line of how each finding was checked enough?

The gate's independent read says whether a reader can weigh a verdict from it, or needs more of the evidence on the pull request.

## Test Strategy

### R1 to R3 and R12, R13: The body

Tests of `pullRequestForm` on a run with major and minor findings, a question, a departure, a finding of R9 and refuted candidates: the sections in order, the counts as the state gives them, the needs list with each kind, the minor table folded, and nothing of the removed sections.

### R4 and R6, R10, R11: The writer's answer

Tests of `checkAnswer` that refuse an area missing a major acting finding, a finding in two areas, a minor finding in an area, a minor finding with no kind, a refuted candidate with no line or two, and a verdict word in a new part; and that a part failing twice is dropped and recorded by `explanation.recorded@2`.

### R5, R7, R8 and R14: The comment

Tests of `commentOf` for a fix, a question, a departure and a minor finding: the parts in order, the standing sentence with a recommended option that differs from the applied one, the reason of a `PLAUSIBLE` verdict of each kind and of none, no evidence line posted, and every link a permalink.

### R7 and R9: The verifier

Tests of the verification phase that refuse a `PLAUSIBLE` verdict with no `unconfirmed` and a `CONFIRMED` one with it, and of the fold that reads `verdicts.recorded` at versions 1, 2 and 3.

### R15: The words

The test that both tables hold the same keys, and a test of the form in Korean that every heading and label is from the Korean table.

### R16: An older run

A test that posts a run recorded with `explanation.recorded@1` and `verdicts.recorded@2` in the new form, and the golden fixtures `schema-1-18` and `schema-1-19`.

### R17: The gate

Recorded in Verification.

## Verification

### Implementation

The work is in pull request #114, after the proposal, in two lanes and a last step. The ledger, the verifier and the writer came first: `review.configured@11`, `verdicts.recorded@3` and `explanation.recorded@2` with the golden fixture `schema-1-19`; the verifier's answer with its two fields; the writer's answer in the report form; and the two prompts, each in a commit of its own. The form came beside them, built from one view of the run whose newer parts it filled with the engine's words, with the language tables in English and Korean and the README. The last step read the newer parts into that view.

### Changes of the proposal during the work

The gate is the version of `review.configured`, as the features of earlier runs are: a read-only run of a pull request is configured at version 11, whose payload is version 10's, and only such a run asks for the verifier's two fields and the writer's report form. Every other run, and a run configured at version 10 that the new engine resumes, keeps the answers it had. The fold takes `verdicts.recorded@3` and `explanation.recorded@2` only in a run at version 11.

The prompts of the verifier and the writer are shared by every run of their role. The rubric's new paragraph applies when the answer has the fields, and the task of a run at version 11 states the contract. A run at version 10 resumed inside its explanation gets the new writer prompt, which no longer defines the account, while its task and schema still ask for one; the task now defines the account itself. The risk is accepted: such a run exists only across the upgrade.

The summary says that `--fix` applies the fixes and the answers in the clone of the person who ran the review, who pushes the result, since a fix run commits on the machine and posts nothing. The body calls a severity a worker's judgment, as no prompt defines major and minor. Each fix against a written rule is its own item of what needs a person, with the decider's rule. The single area of an older run takes no diagram, since the conclusion's diagram of the first writer names findings by their ids (#106). The line of a finding in an area names its fix as "Fix:" and the writer's sentence, instead of lowering its first word after "deep-review would", which read wrongly for a sentence that began with a phrase.

The writer's answer keeps the conclusion's diagram, which the form no longer posts.

### Checks

At the head of the work, `npm run check` passed (3426 tests: 3413 passed, 0 failed, 13 skipped, against 3362 passed before the work), and `npm run test:contract` passed 104 of 104 at the head of the ledger lane.

The form rendered the ledger of the read-only run that reviewed #96, run `b856cf6f`, cut to the events before its first post, through the engine at the head. The run is at version 10, so it took every fallback of R16. The body held 23,003 characters and the 29 comments 61,459, against 49,848 and 113,038 in the first post and 19,388 and 54,823 in the template; no id of a finding stood in the body, and no em dash, middle dot or ellipsis in either. The template's "89 files" was the count at an earlier head; the scope of the run holds 91, which the form gives.

### The gate (R17)

Not run yet. It needs a real read-only review of a pull request at version 11, in English and in Korean.
