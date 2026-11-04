# Report: What the writer writes and what the engine writes

This report was written on 2026-11-05, at `ddf8d62`. It reviews how the review on a pull request divides its text between the `writer`, the model worker of the explanation phase, and the engine, which renders the body and the comments from the ledger. It also asks the wider question of what a model decides and what code decides in a run. It rests on a read of the code, the role prompts, the two proposals of the review on the pull request, and issues #101 to #115. It ran no new review.

## Summary

- The principle of the split is right, and the report does not propose to move it. A model judges: whether a defect is real, how severe it is, what to do about it, how findings relate and how to name the problem. The engine states every fact from the ledger (numbers, verdicts, counts, decisions, places, links and commands) and checks of each answer only what it can count. This follows principle 1 of the vision note, evidence, not trust, and PD5 and PD6 of the review that reads as a report.
- The faults sit where the principle is applied, in nine places, W1 to W9 below. In four of them the engine decides or states what only a judgment could settle (W1, W4, W5, W9). In two, a model is asked to do what code does better (W3) or what nobody reads (W7). In two, the boundary leaves the text a person most needs in the wrong hands (W2, W6). One is a defect of the retry (W8).
- Most faults of form that the first posts showed came from the engine's own sentences, not from the writer. The engine writes 97 entries of words in each of two languages, 45 of which build sentences from parameters, and grammar that templating cannot follow reaches the post (W2).
- Six changes follow, in the order of section "Ways to improve". The first four are small and independent. The last two change the writer's answer and need a proposal.

## Data and method

### Sources

All the sources are in this repository or its issues:

- `src/review/explanation.ts`, which plans the writer's task, checks its answer part by part and merges the answers of a retry; `src/review/schemas.ts`, which holds the writer's output schemas and those of the other workers; and `src/review/phases.ts`, which builds each worker's task.
- `src/review/pull-request-form.ts`, which renders the body and the comments, `src/review/pull-request-words.ts`, which holds the engine's words in English and Korean, and `src/review/public-text.ts`, which cleans the text the engine did not write.
- The role prompts under `roles/fragments/`: `writer-brief.md`, `writer-explanation.md`, `phase4-list.md` and `rubrics.md`.
- The proposals `2026-11-01-review-on-the-pull-request` and `2026-11-04-review-that-reads-as-a-report`, each a requirements and a design file, and the vision note `docs/2026-10-11-vision.md`.
- Issues #101 to #113, the faults of form of the first post on #96; #114, the pull request that answered them; and #115, what the gate of #114 found and its fix pass did not address.

### Method

Each part of the posted body and of a line comment was traced to the function that renders it and to the source of its words: the writer, the engine's table of words, the ledger, or another worker's text. Each check of the writer's answer was read for what it holds and what a failure does. Each issue was read for where its fault began. Where the code departs from what the design intends, the report says what the design intends first.

### Limits

The report reads one commit and runs nothing. Where an issue's fault began is a reading of the issue and of the code, not a measurement. The report does not count how often a case fails to follow from the lines it cites, since no run records it.

## How the text is split today

The table gives the source of each part of the body, in the order the body posts them.

| Part | Writer | Engine | Other workers |
|---|---|---|---|
| Heading and reviewed line | | Words, commits, file count | |
| Summary | One paragraph naming the areas | Counts, what happens next | |
| What needs a person | | Frame of each item, the answer command | The decider's question, options and rule; the verifier's `authorChoice` |
| How the review worked | | All of it, with a fixed diagram | |
| Areas | Title, introduction, diagram, finding titles, fix sentence | Numbers, verdicts, order, the line of a question | The decider's recommended option |
| Findings in full | Title, problem, cases, diagram, check line | Grade line, labels, links | The decider's fix, question or grounds; the verifier's reason for `PLAUSIBLE` |
| Minor findings | Title, `kind` | Lead, counts, table | |
| Left as is | | Reason labels | The decider's grounds |
| Not examined | One line per refuted candidate | Settings, patterns | The brief's gaps, in English |
| How far to trust | | All of it | |

When the writer's part is missing or fails its check twice, the engine puts other text in its place. A title becomes the first sentence of merge-rank's summary, and a problem becomes the primary candidate's `detail`, which is the finder's text. Both are posted under a mark that calls them deep-review's own words.

## Findings

### W1: Severity decides the form, and no prompt defines it

Merge-rank gives each finding `critical`, `major` or `minor`. `phase4-list.md` and the task in `src/review/tasks.ts` name the three values and say that a `CONVENTIONS` violation takes the severity of its rule. Neither says what makes a finding major. The design of the review that reads as a report records the same gap: "as no prompt defines major and minor".

The engine treats the value as a key of the form. It decides whether a finding goes in an area or in the folded minor table, whether the writer must cite lines for it, and whether the body says it "matters before the merge". A choice that no rubric governs therefore decides what a reader sees first. This is the largest judgment in the review that has no stated rule, and the rest of the form inherits it.

### W2: The engine writes most of the connecting sentences, and most faults of form came from them

`PullRequestWords` has 97 entries, and 45 of them are functions that build a sentence from counts, numbers and other words. Each entry exists in English and in Korean. The English functions branch by hand for singular and plural, and the Korean ones attach a fixed particle after an interpolated number. Korean chooses the particle by how the number is read, so `needsAuthor` writes "지적 사항 15은" and `minorNeeds` has the same fault. The test of the tables checks that the two languages have the same keys and the same types, which cannot catch a sentence that reads wrongly.

Most faults of form in #101 to #115 began here or in the layout around these sentences: the count of #102, the wording of a question's options in #104, who makes a fix in #108, the repetition of #109, the drifting links of #112, and the sentences of #115 that read wrongly. The writer's own text accounts for fewer: the titles of #113 and the ids of W3. The facts in these sentences belong to the engine, but the sentences that carry them do not need to be templates. The more of the body the engine writes as sentences, the more grammar each new language must hand-code.

### W3: Finding ids reach the post because a prompt asks for them

R14 of the review that reads as a report keeps finding ids to the trace line of a comment. The writer's prompt says the opposite: "Name a finding by its id, as `RIPPLE-2`", in `writer-explanation.md`. The decider's task in `src/review/tasks.ts` says the same. The form posts both texts as written, so ids reached the posted review in #106 and again in the Korean gate run of #115.

The engine knows each finding's number before the writer runs, in `brief.numbers`, and the report on the machine already adds "(finding N)" beside an id. A model is asked to follow a rule of form that code can apply. Changing the prompt again would leave the rule in text. The smaller step is for the form to apply `quoted` from `src/review/markdown.ts`, which finds ids in text and adds their numbers. The larger one is for the writer to name a finding by a token that the engine replaces with its number and link, with a check that refuses a token that names no finding, so that no code has to find ids in prose.

### W4: The renderer settles a disagreement between the decider and a verifier

R9 sends a finding to what needs a person when the decider leaves it as is while its verifier named a choice for the author. `forAuthor` in `src/review/pull-request-form.ts` applies this at render time. The decider sees the verifier's note only inside the free text of the evidence, and the structured `authorChoice` field never reaches its task, since `taskCandidate` in `src/review/phases.ts` passes the evidence text alone.

R9 intends this, and #107 showed why the post needs it. But the result is that two model judgments disagree, and the engine resolves the disagreement while it renders, after the decision is recorded. Principles 2 and 4 of the vision note place each decision with its grounds on the ledger before anything acts on it. #115 shows the cost: eight of nine English `PLAUSIBLE` verdicts said a choice remains, and 20 of 32 Korean findings carried "Needs the author". Each one bypasses the decider and reaches the first screen.

### W5: A fix that makes no edit is counted as a fix

The decider's schema gives each option of a question an `edits` flag but gives a fix none. In #115, three English findings were decided `fix` with the approach "Make no edit, and keep ...". The engine takes a finding's status from the kind of its decision alone, so it posted them as "deep-review would fix this" and counted them among the fixes. The schema can represent a state that the domain does not allow, and every consumer of the status inherits it.

### W6: The findings a person must read first are the ones the writer does not write

`findingsToExplain` gives the writer only the findings decided `fix` or `ask`. The findings of R9, left as is with a choice for the author, are listed in what needs a person and given in full, but in the finder's words under the engine's mark. R9 accepts this, and #115 measured it: five such findings took 9,664 characters, about a quarter of the English body, and kept the finder's titles, which name code instead of the problem (#113). These are exactly the findings that principles 5 and 6 of the vision note ask to be the easiest to read. #115 leaves open the option of having the writer explain them.

### W7: The writer is held to a sentence the review does not post

The conclusion's `actions` must hold one sentence for each finding the writer explains, questions included, and `checkConclusion` checks each for a verdict word. The form never posts the sentence of a question: the line of a question in an area, and its comment, use the decider's recommended option in the engine's words. A verdict word in a sentence no reader sees therefore drops the whole conclusion, including the summary paragraph that is posted.

The design stopped checking the conclusion's diagram and each finding's `decision` for this reason: neither is posted, so neither should drop a part whose posted words passed. The action sentence of a question is the same case and is still checked.

### W8: A retry can join the summary of one answer to the areas of another

`mergeAnswers` keeps, for each part, the first answer that passed it. The conclusion's paragraph names the areas, but it is one part and the areas are another. When the first answer's conclusion passes and its areas fail, the body posts the first answer's paragraph above the second answer's areas. The form leaves the paragraph out only when no answer's areas passed.

### W9: The trust section can contradict itself

`trustSection` always ends its count line with `modelLine`, "A model wrote the explanations from the verifiers' evidence". For a run that recorded no explanation, it also posts `noExplanation`, which says the review is in deep-review's own words. Such a run states both. #115 says the fix pass of #114 removed a false sentence of the trust section. This is a second one, and it is present at this commit.

## What works

The engine places each finding, builds every link, counts, cuts the body to size and cleans the text of the workers. Each of these is mechanical, pure and tested, and none needs a model. PD5 is right: the verifier gives its two reasons as fields, and the engine never parses evidence. PD6 is right: grouping findings into areas is a judgment no recorded fact gives, and the engine checks only that each major finding that acts is in exactly one area.

The engine does not check whether a case follows from the lines it cites, and PD11 of the review on the pull request leaves that to the gate. The report agrees. A second model that checks the first is a recovery for a failure no run has measured, which principle 11 of the vision note does not permit yet.

## Ways to improve

The changes below are in the order the report recommends. The first four are each the size of one pull request and change no event. The last two change the writer's answer, so its recorded event takes a new version and a golden fixture, and each needs a proposal under `docs/changes/`.

1. Define the three severities in `phase4-list.md` and in merge-rank's task, with one example each. This answers W1 and changes a role prompt, which changes merge-rank's hash.
2. Give the decider the verifier's `authorChoice` as a field of its task, so that the decider asks or leaves with the choice in view and its decision records the outcome (W4). In the same change, refuse a `fix` that edits nothing, or record a fix's `edits` as an option already records it (W5). Whether R9's rendering rule then stays as a safety net or goes is a choice for the proposal.
3. Give the writer the findings of R9, so that what needs a person is in the writer's words with its evidence (W6). The writer's task and its check change; the event does not.
4. Stop checking the action sentence of a question, as the design stopped checking the diagram and the `decision` (W7). Take the conclusion and the areas from the same answer (W8). Leave `modelLine` out when no explanation was recorded (W9).
5. Have the writer and the decider name a finding by a token that the engine replaces with its number and link, and refuse a token that names no finding (W3). This puts R14 in code instead of in a prompt. Until then, the form can apply `quoted` to the text it posts, which needs no proposal and could join step 4.
6. Make the engine's words state facts as labels, tables and short fixed lines, and move the connecting sentences to the writer, with the engine's facts inside them by token as in step 5 (W2). A run whose writer fails then posts the labels and tables, which read plainly but correctly in any language. This is the largest change and the one that most reduces what each new language costs.

## Related

- [The review on the pull request](../changes/2026-11-01-review-on-the-pull-request.requirements.md) and its [technical design](../changes/2026-11-01-review-on-the-pull-request.design.md).
- [The review that reads as a report](../changes/2026-11-04-review-that-reads-as-a-report.requirements.md) and its [technical design](../changes/2026-11-04-review-that-reads-as-a-report.design.md).
- [The vision note](../2026-10-11-vision.md), principles 1, 2, 4, 5, 6 and 11.
- Issues #101 to #113, pull request #114 and issue #115.
