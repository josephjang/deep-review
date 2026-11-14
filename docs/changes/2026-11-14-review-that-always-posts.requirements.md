# Product Requirements: Every review is posted, and what does not fit leaves in the order of what it is worth

Technical part: [2026-11-14-review-that-always-posts.design.md](2026-11-14-review-that-always-posts.design.md).

## Summary

deep-review reviews a change with a series of model workers and records each answer on a ledger, the append-only record of a run. For a pull request, `deep-review review --pr <number>` runs the review and `deep-review publish` posts it as one GitHub review: a body, and a comment on the line of each finding that has one.

GitHub takes a body and a comment up to a fixed size. What a review holds has no bound. Today a body that is too long is cut in a fixed order of whole sections, and when it is still too long, or when one comment is, `publish` refuses and posts nothing. The first run that met this is the review of #135 ([#136](https://github.com/josephjang/deep-review/issues/136)): 37 minutes and 30.84 USD of review, of which nothing reached the pull request, while nothing in the run waited on a person and most of what did not fit was the folded record of decisions on minor findings.

After this change every review is posted. A text that does not fit is left out, one piece at a time, in an order that follows what the text is worth to the reader, and the review says what it left out and how to read it. A review that fits with nothing cut is posted exactly as today.

The illustration below is the review of #135, before and after. The sizes are those measured on that run. What the new form leaves out is an estimate from those sizes, not the output of a run.

```text
Today:

  refused: the body of the review, after every cut, is 72369 characters,
  over the 60000 a review posts [...]; nothing was posted or recorded

After this change, the review is posted, about 57,000 characters, with:

  Left out to fit the length GitHub takes:
    the table of the minor findings (each row repeats a comment or a text in full)
    the decision of each of the 23 findings in the body as the decider recorded
    it, which `deep-review report` prints (the writer's text of each stays)
    the list of the 18 refuted candidates (their count stays)
  Kept: the core of the change, what needs a person, the gaps in what the
  review examined, the text of all 11 findings with no line in the diff with
  the writer's text of each fix in full, the 12 findings left as is with the
  reason of each, and the 12 comments on their lines, whole.
```

## Terms

The **body** is the text of the review itself, and a **comment** is the text on the line of one finding. The **limit** is the most characters `publish` gives either, 60,000 today, a margin under what GitHub takes.

A **finding in full** is a fix or a question that cannot be a comment on its line, so the body holds its whole text: its line is not on the new side of the diff, or GitHub gives no diff of its file.

The **record of a decision** is the decider's recorded words under a finding, inside the fold "The decision as deep-review recorded it": its approach and each option it rejected, or each option of its question, then its grounds, and each choice a verifier left with how it was settled. `deep-review report --run <id> --finding <n>` prints the same decision from the ledger. The fold of a fix opens with the writer's text of the fix in full, which is not part of the record: no command prints it.

The **line of a finding** is one line that names it: its number, its title, its verdict, its decision, and the sentence of what deep-review would do.

A **piece** is a text that the form can leave out as a whole: a section, a fold, a diagram, or one part of one finding.

A finding **waits on a person** when it holds something that no one has settled: a question with no answer, a fix against a written rule that no one has accepted or rejected, or a choice that a verifier left to the author and the decision did not settle.

The **weight** of a finding is its place in the order of the run, which is its number: by severity first, then a `CONFIRMED` verdict before a `PLAUSIBLE` one. The last-ranked finding is the one with the highest number.

The **floor** is the smallest body the form posts: the counts of the run, what waits on a person as counts, and how to read the rest.

## Problem

### No part of the review has a bound, and some parts are never cut

Five decisions are each sound and cannot hold together under a fixed limit. The evidence of a finding that asks a person to act is never cut ([R12 of the review on the pull request](2026-11-01-review-on-the-pull-request.requirements.md#r12-the-review-fits)). A finding with no line in the diff goes in the body ([R10 of the same](2026-11-01-review-on-the-pull-request.requirements.md#r10-a-comment-on-its-line-for-each-fix-and-each-question)), in full ([R9](2026-11-01-review-on-the-pull-request.requirements.md#r9-the-body-is-the-brief-for-a-reader-of-the-pull-request)). A cut keeps each finding left as is whose verifier named a choice ([R4 of the settled choice](2026-11-06-choice-settled-on-the-record.requirements.md#r4-the-form-places-each-finding-by-its-decision-alone)). No text of the writer is held to a length (TD7 of the review in the writer's words). And the record of a decision stands beside the writer's text of it ([R4 of the review in the writer's words](2026-11-12-review-in-the-writers-words.requirements.md#r4-what-an-answer-applies-and-each-choice-a-verifier-named-is-shown-as-recorded)).

In the review of #135 the text that no cut takes is 54,916 characters after every cut, 76% of the body and 92% of the limit by itself: 38,138 in 11 findings in full, and 16,778 in 8 of the 12 findings left as is. The run did what the design says. [RK10 of the review in the writer's words](2026-11-12-review-in-the-writers-words.requirements.md#rk10-a-body-that-no-cut-can-fit) names the case and leaves it to a later change, which is this one.

### What a finding costs the body follows GitHub's diff, not the finding

A minor fix with a comment on its line costs the body one row of a table, about 420 characters. The same fix with no line costs about 3,470. Nine of the eleven findings in full of #135 are in `src/review/pull-request-form.ts`, a file that the change rewrote, and GitHub gave no diff of it. The run had room for 7 findings in full and held 11.

### The cuts take whole sections in a fixed order that does not follow what a text is worth

The first cut takes the refuted candidates, the only text of the review that says which candidates it examined and dropped, and why. That text leaves before the third wording of one decision does. Of the 38,140 characters that a print of the uncut body gives the 11 findings in full, 13,916 say the decision three times: the writer's sentence in view (2,119), the writer's text of the fix in full, folded (7,828), and the decider's recorded approach, folded (3,969). The other parts are what goes wrong (7,447), the decider's grounds and rejected options (4,906), the verifiers' choices and how each was settled (3,436), the links to the code (2,104), and the titles, facts and frames (about 6,300). The author keeps the print outside the repository.

### The refusal is whole, and it comes after the run is paid for

A body over the limit after every cut, or one comment over it, refuses the review, and what fits is not posted either: not the core of the change, not what the review did not examine, not the 12 comments of #135, each under 5,300 characters. The run is finished and paid for when `publish` refuses it, and no setting changes what the form posts. In a workflow the checkpoint goes away with the job, so the review is lost.

A large change is where this is likeliest. A file that a change rewrites draws many findings, and here it was a file with no diff. A large change is also where a person is least likely to read the diff, which is the premise of the vision note.

## Goals

Every run of a pull request ends with its review on the pull request. When the review is longer than GitHub takes, what reaches the reader is the part that is worth most, the reader is told what is missing and how to read it, and nothing is lost that a shorter loss would have saved.

## Non-Goals

### NG1: A shorter review

#109 and #115 ask for a review that reads shorter and for a lighter first screen. The same causes are behind both problems, but a review that reads long and a review that is not posted are different problems. This change leaves a review that fits with nothing cut exactly as it is, and shortens one that does not fit only as far as the limit.

### NG2: Where a finding is placed

Which finding gets a comment on its line and which goes in the body stays as it is, and so does what the form does when GitHub gives no diff of a file. A place for a finding with no line that costs the body less, such as a comment on its file, would make the limit rarer and would not remove it. It is left to a later change.

### NG3: The limit itself

The limit stays 60,000 characters. GitHub's exact limit is not known: the form's margin rests on the 65,536 that people report, and a Korean body of 49,007 characters, 76,324 bytes in UTF-8, was posted, so the limit is not counted in bytes.

### NG4: The evidence on the reader's side

What is left out stays on the machine of the person who ran the review: the records in the report of the run, and the writer's texts in the writer's answer in the checkpoint, which no command prints. A reader of the pull request who is not that person can open neither, and in a workflow both go away with the job. Keeping the checkpoint for the reader is the later change that the README already names.

### NG5: Leaving minor findings out of a review

A repository may later choose to leave minor findings out of a review. That would have let the review of #135 post, and it is not this change: a run whose major findings are off the diff meets the same refusal. Nothing in this change depends on a run having minor findings.

### NG6: The writer and the other workers

No worker changes and no model is called. The writer's answer, its checks and its prompt stay as they are, and the ledger gains no event and no version.

## Requirements

### R1: Every run posts its review

`publish` refuses no review for its size. A body that is too long is posted with pieces left out (R2 to R6), and a comment that is too long is posted with pieces left out (R7). The refusals that say something true of the pull request stay: a head that moved, a pull request that is closed, a run that is not finished, and a refusal by GitHub itself, which the ledger records as today. One bound that is not of size stays too: the record of a publication holds at most 2,000 places, so a run with more ranked findings than that cannot be published, before this change or after it. The largest run on record has 36.

### R2: What does not fit leaves in one order

When the body is over the limit, the form leaves out pieces in the order of the table below, from the first row down, and stops at the first piece after which the body fits. So what is left out is always the first pieces of the order and nothing after them, and no piece is left out while a piece before it in the order stays.

This order takes the place of three earlier items. [R12 of the review on the pull request](2026-11-01-review-on-the-pull-request.requirements.md#r12-the-review-fits) no longer holds where it refuses a body or a comment and where it says what a cut never takes. TD5 of the review that reads as a report, the order of the four cuts, gives way to the table below. And R9 and R10 of the review on the pull request, which give a finding with no line in full, hold until the body is over the limit. R4 names a fourth.

The order follows what a text is worth to the reader, which is what the reader loses when the text is gone from the pull request (PD1). A text that repeats another goes first, since the reader loses nothing. Then goes a text that a reader opens to check a statement that stays. Then the statements go, those that change nothing in the code before those that would. Within one kind, the text of a lighter finding goes before that of a heavier one (R3). A finding that waits on a person loses nothing until every other finding has lost all it can (R4).

| Order | What leaves | What stands in its place | Why it leaves here |
|---|---|---|---|
| 1 | The table of the minor findings | Their counts and a notice | Each row repeats the comment or the text in full of its finding, but for whether the finding reaches what a user sees, which the counts keep as totals |
| 2 | The record of the decision of each finding left as is, then of each finding in full | The command that prints the finding | The writer's text of the decision stays: the reason of a finding left as is, and for a fix its sentence in view and the fix in full in its fold. The record says the same decision again in the decider's words, with the grounds that a reader opens to check it |
| 3 | The refuted candidates | Their count and a notice | Nothing acts on them, and a verifier refuted each |
| 4 | Each finding left as is | Their count as not listed | The finding is verified, and nothing in the code changes for it |
| 5 | The diagrams of the areas and of the core of the change | A notice | Each draws what a text beside it says of the change or of a fix, so it outlasts the statements about what changes nothing in the code (rows 3 and 4) and goes before the text of any fix |
| 6 | The text of each finding in full | The line of the finding, which a major one already has in its area, and the command that prints it | The line still says what deep-review would do |
| 7 | The line of each such minor finding | Their count as not listed | The counts of the summary still hold the finding; a major finding keeps its line in its area until the floor |
| 8 | The record of the decision of each finding that waits on a person | As row 2 | The question, the departure or the choice that no one settled stays in view; the record is the decider's words behind it |
| 9 | Each finding left as is that waits on a person | Their count as not listed | Its choice is one that no one settled, on a finding that changes nothing in the code |
| 10 | Everything but the floor | The floor (R5) | Nothing less fits |

Rows 2, 4, 6, 7, 8 and 9 take one finding at a time (R3). Rows 1, 3 and 5 take their piece whole.

### R3: One finding at a time, the lightest first

A row that names "each finding" takes the piece of one finding, checks whether the body fits, and goes on to the next finding only when it does not. It takes the last-ranked finding first, so a critical finding keeps its text after a minor one has lost it, and a `CONFIRMED` finding after a `PLAUSIBLE` one of its severity. Row 2 takes the records of all the findings left as is, the last-ranked first, before the record of any finding in full, since a finding in full acts on the code and a finding left as is changes nothing. A fix on a `PLAUSIBLE` verdict stays named in what needs a person, as a reason to look, whatever its text loses.

### R4: What waits on a person is the last to go

A finding that waits on a person is skipped by rows 2, 4, 6 and 7. Its record, its text in full and its place among the findings left as is stay until every other finding has lost all that those rows take. Only then does row 8 take the record of each such finding, the last-ranked first, and row 9 the findings left as is among them. A question that waits for its answer and a fix against a written rule that waits for its review keep their text in full, and their item in what needs a person, until the floor: the text of a question holds its options with the cost of each, and a person cannot answer from its line alone. A question once answered and a fix against a written rule once reviewed wait on no one, so they lose their pieces in rows 2, 6 and 7 like any other finding. A choice that a verifier named and the decision did not settle is not part of the record that row 8 takes: it stays in view under its finding, labeled as the verifier's, with the statement that deep-review did not settle it, until the finding itself leaves. So a question with no answer, a fix against a written rule with no review and a choice that no one settled are the last texts of findings that the review loses.

This replaces the rule that a cut keeps every finding left as is whose verifier named a choice ([R4 of the settled choice](2026-11-06-choice-settled-on-the-record.requirements.md#r4-the-form-places-each-finding-by-its-decision-alone)). A finding left as is whose choices the decision settled waits on no one, so its record leaves in row 2 and the finding in row 4, like any other. One whose verifier named a choice that the decision did not settle waits on a person and is kept as this requirement says.

### R5: The floor always fits

When the body is still over the limit after row 9, the form posts the floor. The floor holds, in this order: the heading with what the run reviewed; the notice of R6; the table of the findings by severity and by decision, with the fixed notice of what happens next; how many questions, how many fixes against a written rule and how many choices that no one settled wait on a person, with the command that answers a question or a fix; each condition that holds, as its label, or, when none is listed, the fixed label that none holds or that none was judged for the run, as the full body says it; the fixed line that no check ran in the review, or, for a run continued into its fix pass, that the fix pass runs the repository's checks, as the full body gives it first in what the review did not examine; each kind of gap in what the review did not examine that the run has, as its label; the number of fixes on a `PLAUSIBLE` verdict; the tables of the verdicts and of how the findings were checked; the last line with the engine, the run and the commits; and the marker of the publication, by which a publication that a stop left open is found again. It holds no text of a worker and no text whose length a run decides, so it fits for every run. The comments on their lines are posted with the floor as with any other body.

### R6: The review says what it left out

A review with any piece left out says so in one notice directly under its heading: that it does not hold all of the run, which kinds of piece it left out with the count of each, and where each is read. The notice says what is true of each kind. A record is printed by `deep-review report --run <id> --finding <n>`, which gives the finding with its evidence and its decision in the words of the workers that recorded them. A text of the writer that was left out, which is a diagram, the text of a finding, a line of a refuted candidate or the reason of a finding left as is, is in the writer's answer in the checkpoint, on the machine that holds the run, and no command prints it; for such a piece the notice names the command that prints the finding in the report's words, and says that the writer's text is not in it. Where a piece stood, the form puts what the table of R2 names: a notice for a section, the command that prints the finding for a record or a text in full, a count for findings that are not listed. A link to a finding that is no longer in the body is shown as the finding's number with no link. A whole piece, such as the table of the minor findings, is named in the notice. A kind that is taken one finding at a time is counted, each finding once, at the last state the order left it in: a finding that lost its record and then its text counts among the texts. A review with nothing left out has no such notice and no such text.

### R7: A comment that does not fit is posted with less

A comment over the limit is posted without the record of its decision. When it is still over the limit, it is posted with the finding's number, its facts, the notice that its text did not fit, and the command that prints the finding, which always fits, then each choice its verifiers left to the author that deep-review did not settle, labeled as the verifier's, as R4 keeps such a choice in view until its finding leaves. A comment posted with its facts alone still shows each such choice, unless the choices themselves are over the limit, the one case in which they leave too. A comment is fitted alone, before the body: what one comment loses changes no other comment, and the body is fitted after, with the count of the comments that lost a piece in its notice of R6. The last form of a comment is the one place outside the floor where the review can hide what a person must decide, the options of a question or the rule of a departure on its line. Such a finding stays listed in what needs a person, with the command that answers it.

### R8: A review that fits is unchanged

A review whose body and comments fit with nothing left out is posted exactly as today, character for character. A review that fits today only after a cut is posted in the new order.

### R9: The dry run and the log name what is left out

`publish --dry-run` prints what the form left out of the body, in the order it left, with the number of each finding it took a piece from, and the same for each comment, in place of today's line of cuts, and for a review with nothing left out the line says that nothing was. `publish` logs the same when it posts a review that left something out. The posted text is frozen in the evidence store before the post, as today, and it holds the notices of R6, so the record of a publication says what was left out with no new event.

### R10: The README

The README says that a review is always posted, in what order a review that is too long loses its pieces, what the floor holds, and where the reader finds what was left out. It no longer says that a review can be refused for its size.

### R11: The gate

Before the change merges, real runs show three things. The recorded run of the review of #135 is rendered in the new form, and its body fits; what it leaves out is read against the order of R2, and each notice of R6 against what is missing. A real review whose body does not fit uncut is posted on a pull request, so that GitHub is seen to take a body near the limit; the author approves the run and its cost before it starts. And deep-review reviews the pull request of this change, and that review is posted, as for every change to deep-review. The design's Verification records each.

## Metrics

### M1: Reviews refused for their size

None, in the gate and in the tests, the test of a run far larger than any on record included (R5).

### M2: What the review of #135 keeps

The size of its body in the new form, each piece left out in its order, and each part kept, against the estimate of the Summary: the table of the minor findings, the records and the refuted candidates left out, and every other text in place. The gate records the numbers.

### M3: Reviews that fit and changed

None. Recorded runs that fit, printed by the engine before this change and by this one, are equal character for character (R8). The gate names the runs.

### M4: A reader told what is missing

A fresh session with no tools, given only the fitted review of #135, says what the review left out, which findings lost their record, and what to run to read one. The gate records its answer.

## Product Decisions

### PD1: What a text is worth is what the reader loses without it

Three things decide what a text is worth, weighed in this order. The first is whether the same content stays elsewhere on the pull request: a text that repeats another loses the reader nothing. The report on the machine of the person who ran the review does not count as elsewhere, since a reader of the pull request cannot open it. The second is whether the reader would judge or act differently without the text: a text that a reader opens to check a statement is worth less than the statement, and a statement about a finding that changes nothing in the code is worth less than one about a fix. The third is the weight of the finding the text is about. Repetition comes first because a repeated text costs nothing whatever its finding weighs. What the reader would do comes before weight because a question on a minor finding must outlast the diagram of a critical one: the person has to answer the first and can do without the second.

One measure stands before these three: whether the text belongs to a finding that waits on a person. For the person who must answer a question, its record is the exact words that the answer applies, and for a fix against a written rule it is the rule and the fact that the fix stands on. What repeats for another reader does not repeat for the one who decides. So the order takes nothing from a finding that waits on a person until every other finding has lost all it can (R4), its record included, though the record of any other finding is the first text of a finding to go.

What a text is worth belongs to the piece, not to its section. The part of the review that a reader reads first is not all worth the most: the diagram of the core leaves in row 5 with the other diagrams, before the text of any fix.

### PD2: Code decides what leaves, from the ledger and the shape of the page

All three measures of PD1 are facts that code holds: which text repeats which is the shape of the form, what acts on the code is the decision, and the weight is the rank. So the order is a list that code builds, the same for the same run, and a test can read it. The proposal rejects a model that chooses what to leave out or writes the review again shorter. `publish` runs no worker today, a model at that step would add a cost and a way to fail to the one step that must not fail, and it would make a second review of the same run differ from the first.

### PD3: A piece leaves whole

The form never cuts a text in the middle. A text cut in the middle of a sentence reads as a fault, and a cut inside a fold, a table or a fence of code can break the Markdown after it. Each piece is small beside the limit in every run on record, and the floor covers the run in which one is not.

### PD4: Rejected: hold each text to a length

A bound on each text of the writer, or on the number of findings in full, would move the limit and not remove it, and the author ruled a bound out for the writer's texts, since a text is not understood by being short alone (TD7 and PD14 of the review in the writer's words).

### PD5: Rejected: post what does not fit as more comments

The review could go on in a second comment, and a third. The proposal rejects it. One post is what the record of a publication and the settling of a stopped one rest on ([R13 of the review on the pull request](2026-11-01-review-on-the-pull-request.requirements.md#r13-the-record-comes-before-the-post-and-a-stop-is-settled-by-its-marker)), more posts are more for a person to read, which the vision note counts against a proposal, and a run can outgrow any number of posts as it outgrows one.

### PD6: Rejected: the one cut that #136 first named

#136 first asked for a cut of the folded records, each replaced by the command that prints its finding. That cut is close to row 2 of the order, and with the whole fold taken it would have let the review of #135 post. Alone it leaves the refusal in place for the next larger run, it takes the writer's text of each fix with the fold though no command prints that text, and it would stand before the refuted candidates only by habit, with no stated measure of what a text is worth.

### PD7: The record of a decision leaves before the writer's text of it

The fold of a fix says the decision twice: the writer's text of the fix in full, and the decider's recorded approach. One of them has to go first. The record is the one that an answer and the fix pass apply, and the writer's text is a model's wording of it that no verifier examined. The proposal still takes the record first and keeps the writer's text in its fold. The reader of the pull request is the reader with the least context, the writer's text is written for that reader in the language of the review, and the record is the decider's working words, often in another language. And the two are not equally lost: `deep-review report` prints the record for the person who ran the review, while no command prints the writer's text, so what leaves first is what can be read again. The fix pass and an answer read the record from the ledger, not from the page.

### PD8: A choice that the decision settled waits on no one

The settled choice kept, under every cut, each finding left as is whose verifier named a choice, so that a reader could see where the decision and the verifier differ. In the review of #135 those were 8 findings and 16,778 characters, the decision settled every one of their choices, and none waited on a person. The proposal keeps under the limit only what no one has settled (R4). The settled ones leave like any other record, and the notice of R6 says where each is.

### PD9: The floor is one step, not many

Between the last finding's text and the floor the form could go on in small steps: the paragraphs of the core, the text of each question. The proposal makes it one step. No run has come near it: the parts that stay until the floor took about 17,400 characters of the limit in the review of #135. Principle 11 of the vision note asks that recovery be built for the failure a run has shown. The floor exists so that R1 holds for every run, and it is kept as small as that needs.

### PD10: The notice comes first

The notice that the review is not whole stands directly under the heading, before the core of the change. A reader who reads only the top must know that the page leaves something out. It is one short paragraph of counts.

## Against the vision note

### Principle 1, evidence, not trust

The record of a decision is evidence, and principle 6 asks that the evidence of a statement be one step away. Under the limit the record of a finding can leave the pull request, and it is then one command away, on the machine of the person who ran the review, and not at all for another reader (NG4). A text of the writer that leaves is further away, since no command prints it. The proposal accepts this for a review that does not fit, since the other outcome is a review with no evidence and no statement.

### Principle 2, record before action

Nothing changes: the posted text is frozen before the post, and it now says what it left out.

### Principle 4, deep-review decides; the person answers and writes rules

The settled choice shows each verifier's choice beside the decision that settles it, so that a person can see a settlement that was not deep-review's to make. Under the limit that pair can leave with the record (PD8). The risk that the settled choice named is wider by this much, and only in a review that does not fit: a reader of such a review sees which step settled the choices of a finding, in its facts, and reads the choices themselves in the report.

### Principles 5 and 6, the core first, easy to understand with little context

The core of the change, the questions, the departures and what the review did not examine are the last to go, and a review that is too long now reaches the reader with all of them, where today it reaches the reader with none. The proposal departs from principle 5 in two cases, which the note counts against a proposal. The floor leaves the text of the core, of each question and of each departure out of the review. And the last form of a comment (R7) leaves out the options of a question, or the rule of a departure, whose comment alone is over the limit, so that a person can answer it only after reading the report, which principle 6 does not permit. The reason is the same for both: nothing else of such a run, or of such a comment, can be posted, and a count with the command that answers is more than no review. No run on record comes near either: the parts that stay until the floor took about 17,400 characters in the review of #135 (PD9), and the longest comment on record is 6,386 characters.

### Principle 8, say what was not examined, and when a person must look

A review that is the only gate must say where it is not a gate. A review with pieces left out says so first (PD10) and at each place (R6), and what the run did not examine stays until the floor. The floor keeps the coverage as labels and counts: that no check ran in the review, each kind of gap that the run has, each condition that holds, or that none holds or none was judged, and the number of fixes on a `PLAUSIBLE` verdict (R5). It leaves out their detail, such as the paths that were left out and the angles that did not run, since a run decides how long those are. The principle asks that the review name them, so this is a departure, taken for the reason the floor itself is: a floor that says which kinds of gap the run has is more than no review.

### Principle 11, recovery without a person

Today a review that does not fit stops with no action that the person who ran it can take. The proposal removes that blocker.

The principle also does not permit a recovery path for a failure that no run has shown, and the one run that showed this failure reaches only the first rows of the order: by the estimate of the Summary it fits after row 3. Rows 4 to 9, the floor (R5) and the forms of a comment (R7) answer runs that have not happened. The proposal departs from the principle there, for two reasons. The author decided that every run posts, and without the later rows the next larger run would fall from row 3 straight to the floor and lose the core of the change with everything else. And the rows are not paths of their own: each is one more step of the same list, taken by the same loop, so a row adds a piece that can be left out and the notice that stands for it, and no new way to fail. PD9 applies the principle where it can: between the last row and the floor there are no smaller steps.

### Principle 12, a real run is the gate

R11 is the gate: the run that showed the failure, a real post near the limit, and the review of this change. The gate reaches what real runs reach, which is rows 1 to 3 on the review of #135. Rows 4 to 9, the floor and the forms of a comment are held by tests on built runs alone, which the principle does not count as acceptance. The proposal says so here, and does not claim that the gate covers them.

### How to use this document

The proposal does not increase what a person must read. It hides the core, a question or a departure only in the floor and in the last form of a comment, which the section on principles 5 and 6 names. It makes no question block a run.

## Risks

### RK1: The order ranks kinds of text, not texts

A long text of little worth can outlast a short one of more, when the first is of a kind that leaves later. The order does not read a text. It is the price of an order that code builds and a test reads (PD2), and the gate reads what one real review loses.

### RK2: A reader who cannot open the report

The notice sends the reader to a report that only the person who ran the review holds (NG4), and for a text of the writer it can name no command at all. The notice says both in plain words, as each question already says who answers it. The rows that a real run has reached take the table of the minor findings, the records and the refuted candidates; of these only the writer's line of each refuted candidate is a text that no command prints.

### RK3: The writer's text names a piece that is gone

A text of the writer could point at a record or a diagram that the form left out. The writer is already told to write nothing of what a cut may leave out, a late fact ([R6 of the review in the writer's words](2026-11-12-review-in-the-writers-words.requirements.md#r6-the-writer-writes-only-what-is-settled-when-it-runs)), and the summary that names the areas leaves with them only in the floor.

### RK4: GitHub refuses a review that fits the limit

GitHub's limit is not known exactly, and a review with many comments may meet another one. Such a refusal is GitHub's, the ledger records it as today, and the gate posts one review near the limit (R11).

### RK5: A review at the limit is still long

A review that lost pieces is still 60,000 characters, and #109 and #115 stay open (NG1).

### RK6: The floor hides what a person must decide

In the floor a question is a count and a command. It is the departure from principle 5 named above, taken so that such a run posts at all.

## Open Questions

### OQ1: Should the text of a critical finding outlast the paragraphs of the core?

The order keeps the whole first part of the review, the diagram of the core aside, until the floor, as principle 5 puts it first. A core of many paragraphs can then outlast the text in full of a critical fix with no line. The proposal follows the principle. A measure of the core against the findings needs a run that meets the case.

The author answered this question during the gate. A review that cannot hold even this much is very unlikely, and if it happens, the first approach to consider is to shorten each text, not to remove a section. So the order stays as written: the core of the change outlasts the text of every finding until the floor, as principle 5 puts it first. A run that meets the case would be answered first by shortening each text, not by moving the core earlier in the order. That points toward the kind of bound that PD4 rejects for this change, so it belongs to a later change with a proposal of its own, which touches #109 and #115, and not to this one.

### OQ2: On which pull request does the gate post a review that does not fit?

#135 is merged, and `publish` posts to an open pull request only. The recorded run can be rendered in the new form but not posted. A copy of its change on the private repository of the gate would be a new run of about the cost of the first, 30.84 USD, and its findings would differ. The author chooses the pull request and approves the cost (R11).

### OQ3: By what rule does GitHub give no diff of a file?

Of the 172 files of #135, 8 have none. Three are source or test files with 639 to 1,189 changed lines, while `src/review/explanation.ts`, with 1,295, has one. The count of changed lines alone does not decide it, so how often a run meets a file with no diff cannot be told yet (NG2).
