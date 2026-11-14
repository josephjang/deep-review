# Technical Design: Every review is posted, and what does not fit leaves in the order of what it is worth

Product part: [2026-11-14-review-that-always-posts.requirements.md](2026-11-14-review-that-always-posts.requirements.md).

## Summary

This design uses the terms of the requirements: the body, a comment, the limit, a piece, the record of a decision, the line of a finding, a finding that waits on a person, the weight of a finding and the floor.

The form that renders the review of a pull request, `pullRequestForm` in `src/review/pull-request-form.ts`, today cuts a body over the limit by four cuts of whole sections and returns a refusal when the body is still over, or when one comment is. After this change it returns a review for every run. A pure function builds the order of R2 for the run as a list of steps, each a piece to leave out. The form renders the body, and while the body is over the limit it takes the next step of the list and renders again. The last step is the floor, which holds no text whose length a run decides. A comment over the limit is rendered again without its record, and then as its facts alone. The form reports what it left out, the dry run and the log print it, and the posted text says it. The ledger gains no event, no version and no value of a closed list.

## Non-Goals

### NG1: No change to the ledger

`publish.prepared@1` freezes the posted text in the evidence store and records where each finding goes. The cuts of a body were never an event: they are in the posted text and in the log. This design keeps that, so there is no new version, no new fixture of the golden test, and an older engine reads a run that this one posted.

### NG2: No change to the placement, the cleaning, the writer or the report

`placeFindings`, the cleaning of each text, the writer's answer with its checks, and the report on the machine stay as they are. `deep-review report --run <id> --finding <n>` already prints the block of one finding, and the notices name it.

### NG3: No change to the limit

`maxPostedLength` stays 60,000.

## Context

### The body and its cuts today

`renderBody` joins twelve sections: the heading, the core of the change, the summary, what needs a person, what the review did not examine, how the review worked, the major findings by area, the findings in full, the minor findings, the findings left as is, how far to trust the review, and the last line. `pullRequestForm` renders the body with no cut, and while it is over `maxPostedLength` renders it again with one more of `bodyCuts`, in this order: `refuted`, `left`, `minor-table`, `area-diagrams`. A cut that would take nothing from this run is not in the list (`cutApplies`). A body still over the limit after the last cut is a `FormRefusal` with the size of each section, and `publish` throws it as a `ReviewRefusedError` before anything is recorded.

The cut `left` keeps each finding left as is that `keptByCut` passes, one whose verifier named a choice, settled or not. No cut takes anything from `inFullSection`, and none takes the record of a decision.

### A finding's block

`findingParts` builds the block that a comment and a finding in full share: the facts line, what goes wrong, a diagram and why the verdict is not `CONFIRMED`; then the decision, which is the sentence of what deep-review would do, the facts of a settled choice, a departure or a question, and `recordBlocks`, the folded record; then, for a major finding, how it was checked; then its code. A finding left as is has its own block in `leftSection`, which ends with the same `recordBlocks`, or with `choiceRecord` alone when the writer gave it no text. `findingLine` already renders one line for a finding, its title, its verdict, its decision and the sentence of what deep-review would do: the areas use it for each major finding.

### A comment today

`commentOf` renders the heading of the finding, its block, the line that traces it to the run, and its marker. A comment over `maxPostedLength` is a `FormRefusal`, and it refuses the whole review.

### What reads the result

`publish` in `src/review/publish.ts` prints the cuts in a dry run ("Cut from the body to fit"), logs them when it posts, and throws the refusal. The replay of the decider, `src/replay/decider.ts`, renders the form of a decided run and prints the refusal as a line. `publish-fold.ts` reads the recorded places to know which findings must have a comment when it settles a stopped publication, by `place === 'line'`.

## Design

### The order as data (R2, R3, R4)

A new file, `src/review/pull-request-fit.ts`, holds the order. A step names one piece:

```ts
export type FitStep =
  | { readonly piece: 'minor-table' }
  | { readonly piece: 'record'; readonly finding: string }
  | { readonly piece: 'refuted' }
  | { readonly piece: 'left'; readonly finding: string }
  | { readonly piece: 'diagrams' }
  | { readonly piece: 'text'; readonly finding: string }
  | { readonly piece: 'line'; readonly finding: string }
  | { readonly piece: 'floor' };

export function fitOrder(view: FormView): FitStep[];
```

`fitOrder` is a pure function of the view. It returns the steps of this run in the order of R2, and, as `cutApplies` does today, only the steps that name a piece the run has: no `minor-table` for a run with no minor finding that acts, no `diagrams` for a run whose areas and core have none. The table gives what each row of R2 becomes.

| Row of R2 | Steps |
|---|---|
| 1 | `minor-table` |
| 2 | `record` for each finding left as is that waits on no one, then for each finding in full that waits on no one |
| 3 | `refuted` |
| 4 | `left` for each finding left as is that waits on no one |
| 5 | `diagrams` |
| 6 | `text` for each finding in full that waits on no one |
| 7 | `line` for each of the same findings that is minor |
| 8 | `record` for each finding of the body that waits on a person |
| 9 | `left` for each finding left as is that waits on a person |
| 10 | `floor` |

Within a row that names each finding, the steps go from the highest number of a finding down, which is the last-ranked first (TD2). A finding waits on a person when one of three holds, each read from what the view already has: its question has no answer with an option; its departure has no review; or, for a decision of `fix` or `leave`, or no decision, `choicesShown` of its choices and its settled choices gives one with no settlement, which is a choice a verifier named and the decision did not settle. A finding with no decision, which a decision phase that failed leaves, settles no choice, and the body shows each choice of its verifiers as not settled by deep-review, so it waits on a person as the requirements define it. A question settles no choice by rule, so the choices of its verifiers do not make it wait once it is answered. `keptByCut` goes away.

`fitOrder` gives a `record` step only for a finding whose block holds the fold of a record: a finding with a decision, and, for one left as is, with the writer's text of it. A finding left as is with no writer's text shows its choices in view with no fold, and a finding with no decision shows nothing. Neither has a record to take, and what such a finding shows leaves with it at `left`. The Codex run of the gate of #135, whose writer failed, held 11 findings of the first kind.

### The body with pieces left out (R2, R6)

`leftOutOf(steps)` folds a prefix of the order into what the sections read: whether the table of the minor findings, the refuted candidates and the diagrams are left out, whether the body is the floor, and for each finding of the body the most that was taken from it, one of `record`, `text`, `line` or `left`. `renderBody(view, leftOut)` takes it in place of today's set of cuts, and each section renders as follows.

The minor findings, what the review did not examine and the areas render as with today's cuts `minor-table`, `refuted` and `area-diagrams`. The core of the change leaves its diagram out at the same step, with a notice of its own that stands in the core.

`recordBlocks` takes whether the record is left out. It then leaves the decider's recorded words and their notice out of the fold, and puts one facts line after it: a label that says the decision as recorded is not here, and the command `deep-review report --run <id> --finding <n>` as code, which prints that decision from the ledger (`decisionBlockLines` in `src/review/decision-report.ts`). The fold of a fix keeps the writer's text of the fix in full, under a summary that names it, since the summary "The decision as deep-review recorded it" is no longer true of it. A fold with no writer's text, that of a finding left as is or of a question, is left out whole, and the line stands in its place. Each choice that no settled choice answers is rendered in view after that line, as `choiceRecord` gives it today, labeled as the verifier's with the statement that deep-review did not settle it. So the record of a finding that waits by such a choice leaves without the choice (R4).

`inFullSection` renders the blocks of the findings in full first, as today, each under its heading. After the last block, under a label of its own, one list holds an item for each minor finding at `text`: its anchor, its line as `findingLine` gives it, and the command that prints it. The list stands apart from the blocks, so no item falls under the heading of another finding or joins the list of cited cases that ends a major finding's block. A major finding at `text` gets no item: its area already holds its line, and a second one would repeat it. Its line in the area gains the command that prints it instead, as a fact after the line, so the command that row 6 of R2 puts in place of the text stands where the reader meets the finding. So the `line` step exists for minor findings only, and a major finding keeps its line in its area until the floor. After the list the section gives the count of the findings at `line`, under the label "Not listed here", with a notice. `leftSection` leaves a finding at `left` out and counts it in the same way, as today's cut does for the findings it does not keep.

A link to a finding that the body no longer holds would point at no anchor. `hrefOf` returns none for such a finding, and `findingRef` then shows the label and the number as text.

`headingSection` gains the notice of R6 when any step was taken or any comment lost a piece: a fixed notice that the review does not hold all of the run, that the report of the run prints each finding with its evidence and its decision in the words of the workers, and that a text of the writer that is not here is in the writer's answer on the machine that holds the run, which no command prints; then one facts line with each kind of piece left out and its count, and the command `deep-review report --run <id>`. It is a fixed notice and data, so code writes no sentence of the run, as [R1 of the review in the writer's words](2026-11-12-review-in-the-writers-words.requirements.md#r1-code-writes-no-sentence-of-the-run) asks.

`trustSection` asks `postsWriterText` whether the review posts any text of the writer. That function reads what is left out in place of the cuts, and the findings on their lines as today, so the notice that a model wrote the sentences stands in a floor only when a comment posted with it holds a text of the writer.

### Fitting the body (R1, R2)

`pullRequestForm` renders the body with nothing left out. While the body is over `maxPostedLength` and a step remains, it takes the next step of `fitOrder` and renders the body again with that prefix. It stops at the first body that fits. So what is left out is a prefix of the order, and the body that is posted is the first of the sequence that fits, which is what R2 states and what a test can read from the result alone. The notice under the heading is part of each render, so its size is counted. The comments are fitted before the body, so the notice counts those that lost a piece.

A step is taken even when it shortens the body by little, and the loop does not depend on a step shortening it: it goes on to the next step either way. No step adds a line where no piece stood, since `fitOrder` names a piece only where the run has one.

The loop renders only the prefixes that could fit (`firstFit`). Each step that takes a piece of a finding has an upper bound of what it can take from the body: the finding's block and line in the body with nothing left out, the links to it that the body gives, and a margin for the counts and notices that a step can drop elsewhere. From a body over the limit, each prefix at which the body, less the bounds of the steps taken since, is still over the limit holds a body over the limit too, so it is not rendered. A step that takes a whole piece has no bound, and the body is rendered after it. So the body that is posted is the one a render after each step finds, and a test checks the two against each other.

### The floor (R5)

The step `floor` renders a body of its own, `floorBody`, which holds the list of R5 and nothing else, with the notice of R6 in its form for the floor, which says that the text of the review did not fit. Its last line is the marker of the publication, as `lastSection` ends every body today: `settleOf` in `src/review/publish.ts` finds a stopped publication by that marker, so a floor without it could be posted twice. The floor holds numbers, labels, fixed notices, commands, and ids of fixed length. It leaves out the version the runtime gave and the names of the models, which are strings that the form does not bound.

A floor over the limit is a defect of the form, not a property of a run, so `pullRequestForm` throws an `Error` for it and returns no refusal. A test renders the floor of a run far larger than any on record.

### A comment (R7)

`commentOf` renders the comment in full. Over the limit, it renders it again with the record left out, as the body does. Still over, it renders the facts form: the label and the number of the finding, its facts line, a fixed notice that the text of the finding did not fit, the command that prints it, the line that traces it to the run, and its marker. The facts form holds no text of a worker. `commentOf` returns the comment with what it left out, `record` or `text`, and no refusal. The comment keeps its line and its marker in every form, so the recorded place of its finding stays `line`, and the settling of a stopped publication finds it as today.

### What the form returns, and what reads it (R9)

`PullRequestForm` loses `cuts` and gains `leftOut`: the steps taken from the body, in order, and for each comment that lost a piece, its finding and the piece. `FormRefusal`, `formRefusalWords`, `bodyCuts` and `BodyCut` are removed, and `pullRequestForm` returns a `PullRequestForm`.

`publish` no longer throws for a form. `dryRunLines` prints, in place of "Cut from the body to fit", what was left out of the body in order, each kind with the numbers of its findings, and one line for each comment that lost a piece. The log line of a post that left something out says the same. The replay of the decider drops its line of a refusal.

The recorded places do not change: a finding that the body no longer lists keeps the place `body` with its reason, which says where the finding belongs, and the frozen text says that it is not listed (TD4).

### The table of words

`PullRequestWords` gains, in English and in Korean, the fixed notice of R6 and its form for the floor, the labels of the kinds of piece left out, the label and the notice of a record that is not here, the summary of a fold that holds the writer's text of the fix alone, the label of the list of findings whose text did not fit and the notice of those that are not listed, the notice of a comment in its facts form, and the label of the command that prints. `leftCut` changes its words, since the findings it stands for are no longer those whose verifiers named no choice. `minorCut` changes too: it says today that each minor finding has its comment on its line or its text above, which stops being true once a later step takes the text of one, or its comment falls to its facts form. The diagram of the core gets a notice of its own: today's notice names the diagrams of the areas and stands in the areas, a section that is one line when no major finding acts, as in the review of #135, whose core has a diagram. Each entry is a string, as the table's type asks.

### The README (R10)

The paragraph of "A body or a comment stays under 60,000 characters" and the sentence of the paragraph before it that says what a dry run prints of the cuts are written again: every review is posted, the order in which a review that is too long loses its pieces, the floor, what a comment loses, and where the reader finds what was left out.

### Where the code goes

The work lands as a series in which each commit passes `npm run check`. First the order: `pull-request-fit.ts` with `fitOrder`, `leftOutOf` and whether a finding waits on a person, and its tests, with no caller. Then the form: `renderBody` and its sections read what is left out, with the four old cuts expressed as steps so that the behavior of a run that fits is unchanged, then the new pieces one kind at a time, the record first. Then the floor, the comment, and the removal of the refusal with its callers in `publish.ts` and `replay/decider.ts`. Then the words in Korean, the README, and the rebuild of `dist/` as the last commit.

## Technical Decisions

### TD1: The order is a list that a pure function builds

The order could live in the loop of `pullRequestForm` as branches. A list that `fitOrder` returns can be read by a test without rendering a body, printed by the dry run as it is, and compared with R2 row by row. It is the same choice as `bodyCuts` today, with a finding in a step where a piece belongs to one.

### TD2: The weight of a finding is its number

`rankedFindings` already orders the findings of a run by severity, then a `CONFIRMED` verdict before a `PLAUSIBLE` one, then the kind of its angle, and the number of a finding is its place in that order for the life of the run. The steps of one row go from the highest number down. No new measure of weight is recorded or computed.

### TD3: The body is rendered again after each step

The form could add up the sizes of the pieces and compute the step at which the body fits. It renders again instead, as it does after each cut today. The size of a body is then never an estimate: the cleaning of each text, the notice under the heading and the counts of what is not listed all change with a step, and a render counts them all. A run with 100 findings in the body takes at most about 400 steps (OQ1). The bounds of `firstFit` only choose which prefixes to render, and the size of each prefix rendered is its render's, so the body posted is never chosen by an estimate.

### TD4: The recorded place of a finding does not say that the body left it out

A finding that is not listed in the body could get a place or a reason of its own in `publish.prepared`. That is a new value of a closed list, so a new version of the event and a new fixture, for a fact that the frozen text of the publication already holds and that no reader of the ledger uses: the fold reads the places only to know which findings have a comment. The design keeps the place as where the finding belongs.

### TD5: One search for the body, and each comment alone

The body and the comments have separate limits, and a comment's size takes nothing from the body. So a comment is fitted by itself, and the record in a comment on a line stays whatever the body loses. A finding on its line can then keep its record while a heavier finding in the body loses its own. The design accepts it: moving text between the body and a comment is a change of placement (NG2).

### TD6: The floor is a body of its own

The floor could be the last body of the sequence with every optional piece removed by flags. A function of its own lists what it holds in one place, so that a reader of the code, and the test of R5, can see that nothing in it has a length that a run decides.

### TD7: A refusal that cannot happen is an error

After this change a form that does not fit is a defect of the form. Keeping `FormRefusal` for it would keep a path that `publish` must word and a test must reach. The form throws instead, and the refusal types are removed.

## Open Questions

### OQ1: Is a render after each step fast enough?

Each render cleans every text of the body again. The implementation measures the fitting of the recorded run of #135 and of the test's largest run. If it is slow, the cleaned text of each finding is kept between renders, which changes no result.

### OQ2: How is the recorded run of #135 rendered for the gate?

`publish --dry-run` refuses a pull request that is merged, as #135 now is. The gate of R11 needs the form of that recorded run all the same. The implementation says how: by a script the author keeps outside the repository, which gives `pullRequestForm` the recorded run and the files GitHub still lists for the pull request, or by a replay beside those the repository has.

## Test Strategy

### R1 and R5: Every run posts

The tests that today expect a refusal of a body and of a comment expect a review. A test renders a run far larger than any on record, 2,000 findings with long texts in the body, which is the most a publication records, and expects the floor, under the limit, with each comment of the run beside it. A test of `floorBody` alone expects no text of a worker in it, and the marker of the publication as its last line.

### R2, R3 and R4: The order

Tests of `fitOrder` read the list for runs built to hold each kind of piece: the rows in the order of R2, the findings of a row from the highest number down, the records of the findings left as is before those of the fixes, and each finding that waits on a person, by a question, by a departure and by a choice no one settled, in rows 8 and 9 only. A finding left as is whose verifier named a choice that the decision settled is in rows 2 and 4, which is the rule this change replaces: a test that `keptByCut` under another name would fail. A fix on a `PLAUSIBLE` verdict that lost its text is still named among the reasons to look. Tests of the form pad a run step by step, as the tests of the cuts do today, and expect at each size the prefix of the order that R2 gives and a body under the limit.

### R6: The notices

For each kind of piece left out, a test expects what stands in its place and the count under the heading, in English and in Korean, and a finding's link shown as text once the body no longer holds it. A test expects no notice in a review with nothing left out.

### R7: A comment

A test pads the record of a finding on its line and expects its comment without the record, then pads its text and expects the facts form, each under the limit and each ending with the marker of its finding, with the body and the other comments unchanged but for the count under the heading.

### R8: A review that fits

The existing tests of the form, which render reviews that fit, pass with no change to what they expect. The gate adds recorded runs printed before and after (M3).

### R9: The dry run and the log

Tests expect the lines of what was left out in a dry run and in the log, in order.

### R11: The gate

The recorded run of #135 in the new form, a real post of a review that does not fit uncut, and the review of this change's pull request, each recorded in Verification.

## Verification

No checks have run yet.
