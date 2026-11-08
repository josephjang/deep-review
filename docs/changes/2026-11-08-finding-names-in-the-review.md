# Change Proposal: The review on a pull request names a finding by its number

## Summary

deep-review gives each finding of a review an id, such as `RIPPLE-2`, which names the angle that found it and its place among that angle's candidates. The engine, the ledger and every worker use the id. The reader of the review on a pull request never meets it: the review numbers its findings 1, 2, 3 in the headings, the tables and the list of what needs a person, and [R14](2026-11-04-review-that-reads-as-a-report.requirements.md#r14-links-and-names) of the review that reads as a report keeps the id to the small trace line at the end of a comment.

Yet the text of the workers reaches the review with ids in it. The writer's prompt tells it to "Name a finding by its id, as `RIPPLE-2`", and the decider's task says the same, since a fixer reads the decider's text and names findings by id. The form posts both texts as written. #106 found ids in the diagram at the top of the body, in comments ("If ALTITUDE-6 merges the two into one share") and in the refuted candidates; the Korean gate run of #115 found them in the summary; and the review of #128 posted "an answer to one question about the writer's standing instructions on a retry (SWEEP-1)". The report [How the review on a pull request is written and read](../reports/2026-11-05-review-written-and-read.md) names this as W3.

After this change, the form replaces each id of a finding in the text it posts with the finding's name in the review's language, "finding 3" or "지적 사항 3", and the id of a refuted candidate with "a refuted candidate". It does so wherever a worker's text is posted: in prose, in a code span that holds only the id, and in the labels of a diagram. In Korean, a particle written right after the id is made to agree with how the number is read. The prompts do not change, and nothing the engine records changes. The trace line keeps the id.

## Problem

### An id is a reference the reader cannot follow

An id tells a reader of the ledger which angle found a candidate. On a pull request it is a name with no referent: nothing on the page says that `SWEEP-1` is the finding numbered 5. A sentence such as "coordinate with SCAN-1 so filtered intermediate chunks are not mistaken for exhaustion" (deep-review/click#1, where SCAN-1 is finding 3) hides the one fact it was written to give, which other finding a fix depends on. Principle 6 of the vision note asks that the core, the questions and the departures need no reference the reader must look up, and a question that names a finding by its id is such a reference.

### The rule is in text, and the text goes to two readers

R14 states the rule for the form, but the prompts ask the models for ids, and for a good reason in the decider's case: its approach and options go to a fixer, and the fixer names findings by id. The report on the machine already turns an id into "RIPPLE-2 (finding 3)" with `quoted` in `src/review/markdown.ts`. The form applies nothing. Asking the models to write numbers instead would move a rule of form that code can apply into a prompt that a model may not follow, and would take from the fixer the names it uses.

## Goals

The review on a pull request, body and comments, names every finding of the run by the number the reader sees, in the review's language, whatever worker wrote the text, and keeps the id only in the trace line. The text the models write, the ledger and the report on the machine stay as they are.

## Non-Goals

### NG1: The report on the machine

The report written on the machine keeps `quoted`, which adds "(finding 3)" after an id. Its reader can run `deep-review report --finding`, which takes an id or a number, so the id is a reference that reader can follow.

### NG2: The particles of the engine's own Korean sentences

The engine's Korean words attach a fixed particle after a number they interpolate, and `needsAuthor` writes "지적 사항 15은" (W2 of the report). This change makes the particle agree only after a name it puts in place of an id. The engine's own sentences are left to the change that reduces the engine's words to labels (step 8 of the report), which may use the same rule.

### NG3: The plan of the review with tokens

Step 7 of the report has the writer fill the slots of a plan and name facts by tokens such as `{finding:RIPPLE-2}`. This change does not build it. An id is already a token the engine can resolve, so this change resolves it where the text is posted, and step 7 can replace it.

### NG4: The prompts

The writer's role prompt and the decider's task keep asking for ids. Neither prompt nor any role hash changes.

### NG5: The operator's dry run

`publish --dry-run` lists where each finding goes by number and id, as "1 (REMOVALS-1)". Its reader is the person who runs deep-review, who reads the ledger by id.

## Requirements

### R1: A finding is named by its number

In every text of a worker that the review on a pull request posts, the form puts the finding's name in place of each id that the run numbers: the id of a ranked finding, and the id of each candidate merged into it, which names the finding it joined. The name is "finding 3" in English and "지적 사항 3" in Korean, the number being the one the headings and tables show. A finding's own id in its own comment is named by its number too. The text of a worker is every text the form cleans as a worker's before it posts it, which is the writer's, the decider's, a verifier's and a finder's wherever the form shows it, so the list is complete by construction; the engine's own words, its commands and the patterns of the settings name no finding by id. The names are put in once the secrets of the text are replaced by their marks, and before the rest of the cleaning, places included. That order splits no secret, since a secret is a mark before any id in it could be named. An id is named wherever it is not inside a URL, a file path or a longer word (R3), even when a hyphen joins it to a word or a slash to another id: no letter, digit or underscore is joined to it, no `#` comes right before it, no dot joins it to a letter, digit or underscore on either side, and a hyphen joins it only to a letter, so "a RIPPLE-2-style fix" becomes "a finding 3-style fix", "non-RIPPLE-2" becomes "non-finding 3", and "RIPPLE-2-1" stays. A dot that ends a sentence, as in "see RIPPLE-2.", or opens an ellipsis, as in "...RIPPLE-2", does not stop the id from being named.

### R2: A refuted candidate is named as such

The id of a candidate that the verifiers refuted has no number. The form puts "a refuted candidate" in its place in English, "반박된 후보" in Korean.

### R3: Only the run's ids, and code stays code

A word that has the shape of an id but is no id of the run, such as `UTF-8` or `SHA-256`, stays as it is. An id inside a path or a URL, such as `notes/RIPPLE-3.md`, `src\RIPPLE-3` or `RIPPLE-3.md`, stays. A text joined by slashes is a path unless it is ids alone, each with any words a hyphen joins to it, as "RIPPLE-2/SCAN-1", which names both, "finding 3/finding 2"; an id joined by a slash to any other word, as `docs/RIPPLE-3`, may be a path and stays. Inside a code span the text is code and stays, except a span whose whole text is one id of the run, which a model writes when it names a finding as the prompt's example `RIPPLE-2` shows: that span is posted as the finding's name, in plain text.

### R4: In a diagram, the texts it shows, or no diagram

In a diagram, the form replaces an id in each text that the diagram shows, the texts that `diagramFailures` already reads as labels: a quoted label, the text of an edge between bars or between the halves of an arrow, the label of a node's `@{ ... }` shape, the title of a subgraph, between brackets or, with none, the rest of its line, and in a sequence or state diagram the text after the first colon outside a quoted text, the label of a block such as `alt` or `loop`, the alias of a participant and the title, each of these three to the end of its line, colons included, and each line of a note that spans lines. Each such text is named as prose is, starting a sentence. A quoted Mermaid markdown string, whose text is between backticks as in ``"`RIPPLE-2 crashes`"``, is named inside its backticks, which it keeps; one whose text is one id alone, as ``"`RIPPLE-2`"``, is named whole, as a code span that holds only an id is in prose. An id that is left anywhere else in the diagram as prose would leave it, in a word, a path, a URL or a code span longer than the id (R3), or on a comment line, `%%`, which Mermaid does not show, is shown as it stands or not at all. Any other id left in the diagram is an identifier, of a node, a participant or a state, one joined to an arrow or to the opening of an edge, as in `RIPPLE-2-->A` or `--RIPPLE-2`, included, and Mermaid shows an identifier that has no label of its own. Rather than tell which identifiers are shown, the form leaves out a diagram in which an id of the run is left as an identifier after the replacement, with a line of its own in its place that says the diagram named a finding or a candidate by its id where the review cannot put its name, since the id left can be a refuted candidate's, which has no number. The diagram is checked again once cleaned, as today, and one that the replacement or the cleaning broke is left out with the line that says so.

### R5: The name reads right in its sentence

In English, a name that starts a sentence, a text, a paragraph or a list item starts with a capital letter, "Finding 3", as in "- RIPPLE-2 crashes", which becomes "- Finding 3 crashes"; the form names a text before it joins its lines, so it still sees where a list item starts. Emphasis, an opening parenthesis or bracket, or an opening quote between that start and the name does not keep the name from starting it, so "**RIPPLE-2** crashes" and "(RIPPLE-2 crashes.)" become "**Finding 3** crashes" and "(Finding 3 crashes.)". A line break inside a paragraph, which Markdown joins into one line, starts no sentence, and neither does a common abbreviation that ends in a period, i.e., e.g., vs., cf., etc. or viz., so "e.g. SWEEP-1" becomes "e.g. finding 1". In Korean, when the id is followed at once by a particle that has two forms, 은 or 는, 이 or 가, 을 or 를, 과 or 와, 으로 or 로, and 으로서, 으로써 and 으로부터 with their forms after a vowel, 로서, 로써 and 로부터, and then by no other Hangul letter, the form writes the form of the particle that agrees with how the name is read. A number is read in Sino-Korean, as 일, 이, 삼: 1, 7 and 8 end in ㄹ; 2, 4, 5 and 9 end in a vowel; 3 and 6 end in another consonant, and so does a number whose last digit is 0, which ends in 십, 백, 천 or 만. "No other Hangul letter" means the very next character. After a number whose reading ends in a consonant, 은, 이, 을, 과 and 으로, and 로 after a reading that ends in ㄹ; after one that ends in a vowel, 는, 가, 를, 와 and 로. A particle that starts with 으로 follows 으로: 으로서 after a consonant, 로서 after ㄹ or a vowel. "반박된 후보" ends in a vowel.

A word next to the id that already says what it names is not said twice. After "finding" or "findings" in English, or 지적 사항 in Korean, the form writes the number alone, so "finding RIPPLE-2" becomes "finding 3", not "finding finding 3", and so does each id of a list of them after "findings" or 지적 사항, joined by commas, "and" or "or", or 과 or 와, so "findings SWEEP-1 and RIPPLE-2" becomes "findings 1 and 3". A noun right after the id that says finding, "finding" or "findings" in English, 지적 사항 or 지적 in Korean, is taken into the name, so "the RIPPLE-2 finding" becomes "the finding 3" and "RIPPLE-2 지적 사항은" becomes "지적 사항 3은", the particle after the noun agreeing with the number as it does after the id. A noun "candidate" or 후보 right before or right after the id of a refuted candidate, or "finding" or 지적 사항 right before it, is taken into the name, and a "refuted" or 반박된 written right before the id is not written again: "the DESIGN-1 candidate" and "The candidate DESIGN-1" become "the refuted candidate" and "The refuted candidate", "finding DESIGN-1" becomes "a refuted candidate", and "후보 DESIGN-1은" becomes "반박된 후보는". A 후보 that 자 follows is the word 후보자, a person who stands for something, and is not taken in. In English, the name takes the article "a" only when no determiner, such as "the", "a", "an", "this", "that", "its", "our", "their", "each", "every", "another", "any" or "no", comes before it and its noun is not plural, so "this DESIGN-1" becomes "this refuted candidate", "DESIGN-1 candidate was refuted" becomes "A refuted candidate was refuted", and "DESIGN-1 candidates" becomes "refuted candidates". A writer chooses "a" or "an" for the sound of the id, which the name does not keep: a numbered finding takes no article, so an "a" or "an" right before the id is taken into the name, and "an ALTITUDE-6" becomes "finding 10"; an "an" right before the id of a refuted candidate is taken in and the name writes its own article, so "an EFFICIENCY-1" becomes "a refuted candidate". An article before an id that a hyphen joins to a word is that word's, so the name writes none of its own, an "a" stays, and an "an" becomes "a": "an ALTITUDE-6-style fix" becomes "a finding 10-style fix", and "DESIGN-1-based fixes" becomes "refuted candidate-based fixes". A particle right after the closing backtick of a code span that R3 replaces counts as right after the id, since the prompts' example writes the id in backticks and a Korean writer attaches the particle to the span, as in `` `RIPPLE-2`를 ``.

### R6: The trace line keeps the id

The small line at the end of a comment keeps the id and the run, as R14 states, so that a reader who wants to trace the finding in the run can.

### R7: The gate

The change is accepted by real runs, as principle 12 of the vision note asks, and a run counts only when its recorded texts name findings by id, since a run whose workers wrote no id tests nothing. Three renders make the gate. First, the review of this change's own pull request by the engine built from it, in English, printed with `publish --dry-run` before it is posted. Second, a read-only run of the same pull request in Korean, printed with `publish --dry-run`, since the particles of R5 run only in Korean. Third, the recorded run that reviewed #128, whose posted summary named "(SWEEP-1)", rendered again through the form by the engine built from this change; that run is posted already, so `publish --dry-run` refuses it, and a script the author keeps outside the repository folds its ledger and calls the form as `publish` does. For each render the gate's record names the ids that the writer's answer and the decider's decisions hold and how each was posted. The gate passes when no id of the run appears in the body or the comments outside the trace lines and the hidden markers, which hold the id by design, and each name that replaced one reads right in its sentence.

## Product Decisions

### PD1: The form names; the models keep writing ids

The form resolves the id where it posts the text, as the report on the machine already does with `quoted`. An id is a token the engine can resolve exactly, while a number a model writes cannot be checked against what it meant. The decider's text keeps the ids its fixer reads, and neither prompt changes, so no role hash changes and no run in progress meets a new prompt.

### PD2: Rejected: ask the models for numbers

Asking the writer for numbers would keep a rule of form in a prompt, which W3 found is where the rule failed, and asking the decider for them would give the fixer names it does not use. The prompts forbid a number, the writer's "never by a number" and the decider's "never by its index or its number here"; a number a model writes anyway is left as it is.

### PD3: Replace the id, not add the number beside it

`quoted` writes "RIPPLE-2 (finding 3)" for the report on the machine, whose reader can look the id up. On a pull request the id is noise that R14 keeps out, so the form writes the name alone.

### PD4: A name, not a link

The name is plain text. A finding in the body has an in-page anchor, but a link from a comment to the body's anchor is an open question of the review that reads as a report, and a finding with a comment is reached from the body by the lines of its comment. The number is the one the heading and the tables show, so the reader finds it there.

### PD5: A finding's own id is named by its number

A comment's text can name its own finding, and the form names it as it names any other, "finding 3", rather than "this finding". The heading of the comment shows the same number, and one rule for every id needs no knowledge of which finding a text belongs to.

### PD6: Rejected for now: refuse an id that names no finding

The report's larger step had a check that refuses a token naming no finding. An id-shaped word is often code or a standard's name, `UTF-8` or `ISO-26262`, so refusing every id-shaped word that the run does not hold would drop good text. The tokens of step 7 can carry such a check, since a token has a shape no other word has.

### PD7: The particle follows the name, only where the engine put the name

A Korean writer attaches a particle to the id as it reads the id, `SWEEP-1을`, and the particle can be wrong once the id becomes "지적 사항 5". The form rewrites only a particle that follows an id it replaced, and only when no Hangul letter follows the particle, so the copula of "SWEEP-1이고" and a word such as "이후" are left alone.

## Against the vision note

The note this proposal is read against is [the vision note of 2026-11-05](../2026-11-05-vision.md).

### Principle 6, easy to understand with little context

The change rests on this principle: an id is a reference that a reader of the pull request cannot follow, and the principle does not permit a question that the person can answer only after reading something else. Naming the finding by the number the review shows removes the reference without adding anything to read.

### Principle 5, the core first

The summary at the top of the review is where #115 and #128 posted ids. The change makes the first lines a reader meets name findings as the rest of the review does.

### Principle 12, a real run is the gate

R7 is the gate: a real run of the engine built from the change, on its own pull request, posted.

### The checklist of the note

The change does not increase what the person must read; a name is as long as an id or a few letters longer. It presents the questions and the departures in a form that needs less context. It does not touch how a run ends or what it asks.

## Risks

### RK1: A word of the repository has the shape of a run's id

A constant or a ticket key in the repository, such as `SCAN-1`, can match an id of the run and be named as a finding. The id must be one the run holds, and the angles' names are words a repository rarely uses as keys, so the case is rare; in a code span longer than the id, the word stays.

### RK2: Two refuted candidates in one sentence

"a refuted candidate" does not say which, so a sentence that contrasts two refuted candidates by id loses the contrast. Refuted candidates are named rarely, and the lines of the refuted candidates give each by its place. Naming a refuted candidate by its place in the text, such as "the refuted candidate at `src/a.ts:9`", was rejected: a candidate's place can be absent or outside the repository, and a place in the middle of a worker's sentence is a reference the reader must look up, where the list of refuted candidates already holds each place.

### RK3: A Korean particle the rule does not know

A particle outside the pairs R5 lists, or one followed by more Hangul, as 로서는, keeps the writer's form, which agrees with the id rather than the number. The sentence then reads with a wrong particle, as the engine's own "15은" does today.

### RK4: A diagram that uses an id as a hidden identifier is left out

A writer may give a node an id as its identifier and a label of its own, as in `RIPPLE-2["parse crashes"]`, where the id is not shown. R4 leaves such a diagram out all the same, since telling a shown identifier from a hidden one needs the grammar of each kind of diagram. The writer's prompt names nodes by short letters in its examples, so the case is rare, and the line in its place says why the diagram is gone.

### RK5: A merged candidate and its finding share one number

The id of a candidate merged into a finding names that finding, so a text that sets the two apart, "RIPPLE-2 and its member SCAN-4", becomes "finding 3 and its member finding 3". The member's id says nothing to the reader of the pull request either, and the comment of the finding lists what was merged into it, so the form names both by the one number the reader can find.

## Verification

### Implementation

The work is in pull request #129. The proposal came first, then the amendments of its design review, each finding of high or medium severity in a commit of its own. The form's naming is `namedFindings` and `namedInDiagram` in `src/review/finding-names.ts`, called by the speaker of `src/review/pull-request-form.ts` for every text it cleans as a worker's, with the words of each language in `src/review/pull-request-words.ts`. The README says what the form does to an id.

### Changes of the proposal during the work

A design review of the proposal, by a reader given the proposal, the code and the vision note but not the author's reasoning, found no finding of high severity and four of medium severity, each amended in its own commit: a particle after the closing backtick of a span that names an id (R5), every text a diagram shows and a diagram left out for an id it keeps (R4, RK4), a word next to the id that already says what it names (R5, RK5), and a gate that tests ids that runs recorded, in Korean too (R7). The findings of low severity shared one commit: the texts named, the order of naming and cleaning, the Korean reading of a number, PD2 on the prompts and RK2.

The review of the pull request by deep-review, at the gate below, changed the proposal again. Its fix pass made R1 state the boundaries of an id as the code applies them, taught the form the texts and nouns it now reads, and, against two rules this change had written, wrote each number of a list after "findings" alone and left a diagram out only for an id left as an identifier, not one in a comment line or a path; the author accepted both departures. The author answered its question on ids joined by a slash or a hyphen with its option 2: such an id is named unless it is in a URL or a file path. The Korean run found four faults of Korean that the English one could not; three were fixed by hand, one commit each (the particles that start with 으로, 후보자 after a refuted candidate's id, and the line that replaces a dropped diagram), and the fourth, a noun before a refuted candidate's id, the English fix pass had already fixed. Its question on a finding whose block a cut removes was answered with its default: the finding keeps its number.

### Checks

At the head of the work, `npm run check` passed: 3713 tests, 3700 passed, 0 failed, 13 skipped, against 3650 passed before the work. `npm run verify` matched both builds.

### The gate (R7)

Each render below counts ids of the run outside the trace lines, the hidden markers and the lines a dry run adds for the operator. A fixture id of this change's own tests, such as `RIPPLE-2`, quoted in a finding about the code, is no id of the run that reviewed it and is not counted. The renders of recorded runs were made by a script the author keeps outside the repository, which folds a copy of the ledger and calls the form as `publish` does; a run whose file list the script did not read from GitHub puts every finding in the body.

| Render | Ids of the run posted before the change | After |
| --- | --- | --- |
| Run `b856cf6f`, the review of #96, recorded | 8 | 0 |
| Run `b4e019b4`, the review of #121, recorded | 6 | 0 |
| Run `c6ed03ed`, the review of #126, recorded | 1 | 0 |
| Run `ff194d59`, the review of #128, recorded; its summary posted "(SWEEP-1)" | 1 | 0 |
| Run `fa5e702c`, the review of #123, recorded | 1, in a code example | the same, in a code example |
| Run `9b58f5d7`, the review of #129 in English, printed with `publish --dry-run` and posted | 3, by the form of `main` | 1 at the post, `SCAN-1` in "RIPPLE-2/SCAN-1", which the answer on joined ids then named; 0 outside code at the head |
| Run `43e57d31`, a read-only review of #129 in Korean, printed with `publish --dry-run` | not rendered | 0 outside code at the head, but one id of a range, "RIPPLE-2-SCAN-4", where the second id stays |

The English run of #129 cost 40.64 USD with its fix pass and the answer, and decided 17 fixes, one question and seven findings left as is; its review was posted on #129 with 18 comments, and a second `publish` posted nothing. The texts of its workers named three findings of the run by id, `RIPPLE-7`, `SCAN-1` and `SWEEP-1`, which the form of `main` would have posted as written. The Korean run cost 20.79 USD and decided 16 fixes, two questions and ten left as is; its dry run at the head of the work, printed by the engine built from it, names findings as "지적 사항 7이", "지적 사항 12와" and "지적 사항 1과", each particle agreeing with the number. A particle with more Hangul after it, such as 로서는, keeps the writer's form, as RK3 accepts. No diagram of any render was left out.

The gate passes, with two departures from R7 as written. The English run was posted before its fixes, so the review on #129 still shows the one joined id that the answer later named. The Korean run reviewed the change before the fixes, so its dry run is the review of that head printed by the engine of the final head, not a review of the final head.
