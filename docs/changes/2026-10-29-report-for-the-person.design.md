# Technical Design: The report for the person

Product part: [2026-10-29-report-for-the-person.requirements.md](2026-10-29-report-for-the-person.requirements.md).

## Summary

The change is in the renderer alone. `briefOf` keeps building one typed model of the brief from the fold, and the model gains what the new brief says: the number of each finding, the items of "What needs you", the meaning of each check, and the rows of the fixes. Each is computed by a table that the code can read in one place: a table of the conditions of a need, a table of the meanings of a check, and an ordered list of the kinds of validation. `briefMarkdown` renders the new brief from the model, the chat form replaces the short form, and version 5 of the JSON form serializes the same model.

`renderReport` puts after the brief one block per finding, in the order of `rankedFindings`, made from what `findingBlock`, the Decisions section, the Fixes section and the notes of the run render today. The evidence parts follow, made from today's renderers of Documentation, Checks, Changed files, Conventions, Refuted at verification and The run. Statistics, the table of the angles, the digest of the roles and the clusters and batches of the fix pass move to a new form of the `report` command, `--stats`. A quote of a worker keeps its words; the renderer adds the number of a finding after an id or a batch index that names it, and escapes what a preview of Markdown would hide.

No event, no fold and no role prompt changes. The stored record of a report keeps the text that its engine wrote, and the copy that each command writes again is rendered by the current engine, so an older run gets the new form the next time a command writes its copy.

## Non-Goals

### No new event and no fixture of the ledger

Each fact that the new report gives is in the fold today. The facts that are not wait for their own proposal (PD15 of the product part). The golden test sees no change of the DDL or of the set of event kinds.

### No change to the role prompts

The prompts and their digest stay. The verifiers' prompt names the section "Refuted at verification", which keeps its name (R8).

### No change to the steps of a run

The engine runs the same steps, the same checks and the same workers. Only what `write-report`, `report`, `review`, `answer` and `commit` print changes.

### No change to the reading of the base

The comparison with the base stays the repair's, in `fix.recorded@4`, and the brief reads it through `briefChecksOf` as today.

## Context

### The brief and its forms

The brief of a run defines the brief, its short form, its copy and the `report` command; the questions in the chat, the documentation step and the facts before a merge add to it. The product part names each of their requirements that this change revises. `briefOf(state)` in `src/review/brief.ts` builds the model `Brief` from the fold: the title, the account of the change, the headline with its four counts, the questions, the departures, the documents left out of date, the gaps of "What the review did not cover", the conditions of "Where to look", what changed and the checks. `briefMarkdown(brief, form)` renders it for the report and, with the words of the chat that print ids as plain text, for `report --brief`. `briefShortForm(brief)` renders the short form, at most 23 lines, that `review` and `answer` print through `reviewEnded` in `src/command.ts`, followed by the path of the report. `briefBlock(brief, id)` renders one question or departure for `report --finding`. `briefJson` in `src/review/brief-json.ts` writes version 4, a strict schema built on versions 1 to 3, with no findings, evidence or statistics; only `report --json` and the tests read it.

### The report

The step `write-report` calls `renderReport(state, input)` in `src/review/report.ts`, stores the text as the record of the run, and appends `report.written` with the statistics and the patches. It writes a copy under the checkpoint, `reports/<date>-<run>.md`. `refreshReportCopy` writes the copy again on `commit`, `answer` and `report`, with the current engine. The report renders, in order: the brief; a rule; The change, in full; Decisions (`decisionsSection` in `src/review/decision-report.ts`); Findings (`findingBlock`); from `fixSections` in `src/review/fix-report.ts`, Fixes with its Repair, Documentation, Checks and Changed files; Angles; Conventions (`src/review/survey-report.ts`); Refuted at verification; Statistics; Notes of the run (`notesOfRun`); and The run (`factsOfRun`).

### The facts that the brief reads

A decision of the kind `ask` records its options, two to four, each with what it does, its cost, the rule it makes and whether it edits the code; the option it applied (`applied`, the default); and the option it recommends (`recommended`, deep-review's choice). `defaultInPlace` says whether the tree holds the default: it does not for a default that edits the code in a run that only reviews, or when no fixer applied it. A decision of the kind `fix` may carry a `departure` with the rule, its source and the reason. The standing answers are in the fold of the answers. `fateOf` in `fix-report.ts` gives each finding its last outcome: applied, already applied, deferred, blocked, not attempted, left by decision, asked and kept as is, or held for the author, with why a fix was not attempted, the run budget among the reasons.

`briefChecksOf` in `src/review/brief-checks.ts` gives each kind of check its outcome before the fixes, its last outcome and when it ran, when it last passed and failed before that, its result on the base with the repair's reading, and its first fault, in the order `edits`, `change-breaks`, `change-adds`, `not-compared`, `base-has` (`faultHolds`). The outcomes of a run of a check are `passed`, `failed`, `timeout`, `not-started`, `skipped` and `cut`. A check has no last run when no fix changed a file. Each fixed finding records the validations that its fixer reported, each with a method (`old-code`, `mutation`, `existing`, `static`, `limited`), a source and evidence; `validationOf` groups the fixes by their strongest.

The revisions of the tree (`tree.revised`) name their source: a fix, a check, or an `attempt`, the edits of an attempt that ended without an answer, with the key of its unit; an attempt's revision names one finding, or none for what it left after its last snapshot. The answers of the fix pass are kept by phase and by the key of the unit. `fixerTask` in `src/review/tasks.ts` numbers the findings of a batch from `[0]`, in the order of `findingIds`. The patches are one per revision, in the order of the commits, and `commits.created` records the commits of `deep-review commit` with the revisions that each holds. `leftDocumentsOf` gives the documents named out of date that no step updated. `budgetStoppedUnits` gives the units that the run budget did not start, and `continueCommand` the command that continues them, which names the engine and the worktree by their paths.

### Identifiers

`recordCandidates` names each candidate `<ANGLE>-<n>`, or `SWEEP-<n>`, in the order the worker returned them, and a finding keeps the id of its primary candidate, with the ids of the members merged into it. `rankedFindings` in `src/review/state.ts` orders the findings by severity, verdict, the class of the angle and the id; the order holds for the life of the run, since no later step changes a verdict or the ranking. Findings, Decisions and Fixes number their headings by this rank today; questions, departures and documents each count from 1. `--finding` of `report` and `answer` takes an id that matches `^[A-Z]+-[1-9][0-9]*$`, exactly: `report` looks it up among the questions and departures, `answer` among the decisions. `snapshot --finding` takes the index of a finding in its batch, from 0. `runIdOf` in `src/review/runs.ts` takes a run id, or a prefix of at least 8 characters that names one run.

### The commands

`reportFormOf` in `src/command.ts` allows one form at a time. With no flag, `report` prints the short form; `--json`, the JSON form; `--brief`, the brief as Markdown; `--fixes`, `fixLines` of `src/review/fix-lines.ts`, one line per fix; `--finding <id>`, a block of the brief. Each form writes the copy again first, under the lock of the run, and the text forms end with the path of the copy. `commit` reads no text of the report. `status` imports helpers from `report.ts` and `fix-report.ts`, and `status --json` gives the statistics.

### The skills

Step 4 of `skill/claude/skills/deep-review/SKILL.md` and of `skill/codex/SKILL.md` tells the host to show the lines before the path in a code block, as printed, then the path, and not to summarize the findings beyond those lines. It sends a question on one decision to `report --finding <id>`, the whole result to `report --brief`, and what the run changed to `report --fixes`. It names the parts "Changed files" and `## The run`, with its line `Settings:`, and the list of what the review did not cover. The skills set no bound of lines; the engine does.

### The tests

Three snapshots in `test/fixtures/reports/`, `synthetic.md`, `fix.md` and `survey.md`, must match the renderer byte for byte. `test/review/report.test.ts` lists every heading of a report. `test/review/brief.test.ts` holds the short form to 7, 21 and 23 lines of at most 200 characters. `test/cli.test.ts` matches two headings. `test/skills.test.ts` holds the words of the skills and looks for `'## The run'` and `'## Notes of the run'` in the source of `report.ts`. `normalizedReport` of the contract test, in `test/helpers/resume-contract.ts`, removes `## Statistics`, drops the lines of The run and sorts the lines after `## Notes of the run`, the parts that differ between a run and its resumed twin. The golden checkpoints are folded, never rendered.

## Design

### The model of the brief (R1 to R5, R13)

`Brief` keeps the account of the change, the questions, the departures, the documents, the checks and the local paths, and gains: `status`, the kind of run and the counts of the status line; `findings`, each with its number, its id and merged ids, its severity, its verdict, its status and the first sentence of its summary; `needs`, the items of "What needs you" (R2); `meaning` and `comparedBy` for each of `checks` (R4); `fixes`, the rows of "What deep-review fixed" (R5); and `notExamined`, the gaps of R10 of the brief of a run that are not needs. The fields that only the old layout used, the headline, the gaps, what was covered, the conditions of "Where to look" and `changed`, give way.

Every form reads this model and nothing else: the brief in the report, `report --brief`, the chat form and the JSON form. So the chat and the JSON cannot say what the brief does not.

### The numbers and the aliases (R6, R7)

The number of a finding is its place in `rankedFindings`, from 1. `findingNumbers(review)` maps the id of each finding, and the id of each candidate merged into it, to its number, and every renderer takes the number from it. The anchors become `finding-<n>`, and the id of the engine is printed only in the line Where of the block, in Refuted at verification for the candidates that are not findings, and in the map of "About this run".

A quote of a worker passes through `quoted(text, context)`. It keeps the words, and after each id of the map that names another finding than the block's own, it adds ` (finding <n>)`. In the text of a fixer, it adds the number after an index such as `[0]` when the index stands alone, not after a name or a closing bracket, and names a finding of the fixer's own batch, by the numbering of `fixerTask`. An id inside a path or a URL, such as `notes/RIPPLE-3.md`, stays as written, while an id that ends a sentence gets its number. A text with no such id or index comes out as it went in, but for the escaping below.

`--finding` of `report` and `answer` takes a whole number from 1 to the count of findings, or an id as today. `report --finding` looks up any finding and prints its block (R7), and `answer --finding` turns a number, or the id of a candidate merged into a finding, into the id of the finding before it checks the decision as today. The usage of each command says what its `--finding` takes, since `snapshot --finding` keeps its index from 0.

### The table of needs (R2, R3)

A new module, `src/review/needs.ts`, holds the table of R2 as data: for each rank, the condition, a function of the context of the brief that returns the items it gives, the words of its part of the count line for one and for several, the words of "If you do nothing", and the words that say it does not hold. `needsOf(context)` reads the table in order, so the order of the items is the order of the table, and no item comes from anywhere else.

The conditions read the fold as follows. Rank 1 is a check whose fault is `edits`. Rank 2 is a check whose fault is `change-breaks` or `change-adds`. Rank 3 is a check whose fault is `not-compared`, and, in a run configured with the checks on the base, a check that failed before the fixes and has no last run, or that fails in its last run with no fault. Rank 4 is each revision of the kind `attempt` whose unit has no answer recorded after it in its phase; each finding decided `fix` whose last outcome is deferred, blocked or not attempted, with the reason that `fateOf` gives; each answer of `owedAnswers` in a fix run, which no answer pass applied, with the command that applies it; and each document of `leftDocumentsOf`. A question is never in rank 4: its item says whether the tree holds its default. Rank 5 is each departure with no standing answer. Ranks 6 and 7 are each question with no standing answer, by whether `applied` equals `recommended`. Rank 8 is a fix run with revisions that no `commits.created` holds.

The items have fixed shapes, so the maximum of R1 can be counted. An item of a check, of unfinished work or of the uncommitted fixes is one line. An item of a question is one line for its lead and its question, one line per option with what it does, its cost, the rule it makes and its marks, the default and deep-review's choice, and one line for "If you do nothing" with the commands: at most 6 lines, with four options. An item of a departure is one line for its lead, one each for the rule, where it is written and why deep-review went against it, and one for "If you do nothing" with the two commands: 5 lines. They come from the model of today's `questionBlock` and `departureBlock`.

Ranks 5 to 7 together show at most three items in full, `shownQuestions` and `shownDepartures` of today becoming one cap, and one more line names the others by number. Rank 4 shows at most three items, and one more line names the others: a finding by its number, a document by its file, and the edits of an attempt that name no finding by their patch. An item of rank 4 for a unit that the run budget stopped says that the run budget stopped it, and that "About this run" gives the command that continues the fix pass, since `continueCommand` names local paths. The item of rank 8 names the patches to read first: the fixes of plausible findings, and the edits of an attempt whose unit answered later.

The count line has one part for each condition that holds, with the number of its items, or for rank 8 of its patches, and a second sentence that names each of ranks 1 and 4 that does not hold. The line below the items says that each question has a default, the easiest option to reverse, so no item holds up the run; that the person can ask their agent to run the commands or type them as "About this run" shows; and that `deep-review report --finding <number> --run <id>` prints the block of any finding. The brief names no local path.

### The meanings of the checks (R4)

`brief-checks.ts` gains `checkMeanings`, an ordered table of the rows of R4: each row a predicate over a `BriefCheck` and the configuration of the run, its meaning, its rank in the needs, and who compared, if anyone. `meaningOf(check)` takes the first row that holds. The rows of a fault read the fault that `faultHolds` gives, so the meanings and the faults cannot disagree; the other rows read the outcomes:

| Row | Reads | Meaning | Compared by |
|---|---|---|---|
| 1 | fault `edits` | the edits of this run made it fail | none |
| 2 | fault `change-breaks` | fails because of the change | the engine, from the outcome on the base |
| 3 | fault `change-adds` | fails on the base too, and the change adds failures, by a model's comparison | a model |
| 4 | fault `not-compared` | fails, not compared with the base, with the reason | none |
| 5 | fault `base-has` | fails the same way on the base, by a model's comparison | a model |
| 6 | a run configured before the checks on the base; fails, or failed before and has no last run | fails | none |
| 7 | failed before; no last run | fails as submitted, not compared with the base | none |
| 8 | passed before and in its last run | passes | none |
| 9 | failed before; passes in its last run | passes; it failed as submitted | none |
| 10 | passed before; no last run | passes as submitted; no check ran after the fixes | none |
| 11 | last run `skipped`, `not-started` or `cut` | did not finish its last run | none |
| 12 | `skipped`, `not-started` or `cut` before; passes in its last run | passes; it did not finish as submitted | none |
| 13 | a run that takes its checks to the base; fails in its last run, with no fault | fails, not compared with the base, with the reason | none |
| 14 | no run | did not run | none |

A timeout counts as a failure, as `faultHolds` counts it. "A model's comparison" names the reading of the repair, which is a model; the next proposal can say "the engine's comparison" where the engine compares lists. `comparedBy` is `engine` for row 2, `model` for rows 3 and 5, and absent for the others.

The table of the brief has five columns: the check, linked to its block under Checks; on the base, with its commit; as submitted; the last run, each cell with its outcome and its `when`, as "failed after your answers"; and the meaning. A run configured before the checks on the base has no column for the base.

### The kinds of validation (R5)

`validationKinds` lists the methods in order of strength, with their words: `old-code`, "a new test fails on the code before the fix"; `mutation`, "a test fails when the fix is undone"; `existing`, "existing tests and checks rerun"; `static`, "read against the source"; `limited`, "a limited check"; and none, "none reported". A row of a fix gives the kinds of its validations, each once, in that order, under the heading "How its fixer reports checking it". It refines the strengths of `validationOf`, which put `old-code` and `mutation` together as a test.

### The blocks (R6)

`findingBlock` renders one block from the finding, its decision, its fate and its answer: the anchor, the heading with the number and the first sentence of the summary, the line of the status, then Where, Reason, Evidence, Decision, Plan and Rejected, the parts of a question (why it asks, the rule of each option, where it looked), Fix, Commit message, Patch, the corrections of the fixer, and one line for each validation that a fixer of the finding reported, oldest first, which says that the fixer reports it and names the fixer when more than one worked the finding. A field with nothing in it is left out. The decision's line of today's Decisions section, the entry of today's Fixes section without its cluster and batch, and the validations of today's notes of the run move into it.

### The evidence parts (R8)

The parts after the blocks reuse today's renderers. Documentation updates is today's Documentation. Checks is today's table of the checks as one block per check, each with an anchor line of its kind, its command, its source, each run with its result, its time and its output files, and the words of the repair. Patches is today's list of patches, each with its finding by number and, from the revisions, the files it changes. What the review covered holds the review passes that ran by their plain names, Conventions, each gap of `notExamined`, the candidates outside the change, the unlocated candidates and the groups that no verifier examined. Refuted at verification stays as it is. About this run holds the lines of today's The run but the digest of the roles, one line of totals from the statistics, the line of the checks of the worktree, the lines of what a stop did, the command that continues a fix pass that the run budget stopped, the line of the cost not reported, the map of numbers to ids, and the line that says how to type the commands.

### The statistics (R9)

A new form of the `report` command, `--stats`, prints a Markdown document of four parts: Statistics, from `statisticsTable`; Angles, from `angleRow`, with the leads; the digest of the roles; and the fix pass, with the clusters, the batches, `Held by` from today's Changed files and `First blocked on`. It writes the copy first, as every form does, and ends with the path of the copy.

### Plain words and escaping (R10, R11)

The words of R10 live in the renderer's own strings. The test renders folds whose workers' texts hold none of the words that R10 lists, and checks that the brief above "Findings" holds none of them either; a word that a worker wrote stays, as PD5 of the brief of a run asks. The escaping is one function, `escapedText`, applied to a quote of a worker after the aliases: outside a code span, a backslash goes before `<`, before `*`, before an `_` that is not between two letters or digits, before a `[` whose balancing `]` is followed by `(`, and before an `&` that opens an entity, which CommonMark reads as the character itself, while a backslash that a backslash escapes escapes nothing and a backtick after an odd run of backslashes opens no code span, so a terminal shows one extra backslash and a preview shows the text. The only HTML that the renderer writes is the anchor line before the block of a finding, `<a id="finding-<n>"></a>`, or of a check, `<a id="check-<kind>"></a>`, and the question block no longer uses `<details>`.

### The chat (R12)

`briefChatForm(brief)` replaces `briefShortForm`. It joins the title with the run and the line of the change, as the short form makes them today (R4 and R5 of the questions in the chat), then the parts that `briefMarkdown` joins for the top of the brief, made by the same functions, `statusLine`, `needsPart` and `mergePart`, with the words of the chat that print a finding as plain text, and adds one line, `What deep-review fixed: deep-review report --fixes --run <id>`, for a fix run. `reviewEnded` prints the form and then the path, as today, and `report` with no flag prints the same.

The maximum follows from the caps and the shapes of the items. A check has one fault, so ranks 1 to 3 give at most 4 items, one per kind:

| Part | Lines in the brief | Lines in the chat |
|---|---|---|
| The title and the account: the title, then what the change does, why, and the judgments with whose account it is, each paragraph followed by a blank line | 8 | 3: the title, the line of the change, a blank line |
| The status line and a blank line | 2 | 2 |
| The heading "What needs you", the count line, and a blank line after each | 4 | 4 |
| Ranks 1 to 3, one item per kind of check | 4 | 4 |
| Rank 4, three items and the line of the others | 4 | 4 |
| Ranks 5 to 7, three items of at most 6 lines and the line of the others | 19 | 19 |
| Rank 8 | 1 | 1 |
| The line below the items, with a blank line before and after | 3 | 3 |
| The heading "Before you merge" and a blank line | 2 | 2 |
| The table of the checks: its heading row, its rule and four rows | 6 | 6 |
| A blank line and the paragraph below the table | 2 | 2 |
| The heading "What deep-review fixed", with a blank line before and after | 3 | none |
| The table of the fixes: its heading row, its rule, ten rows and the row of the others | 13 | none |
| A blank line and the sentence that says what a plausible finding is, when a fix of one is in the table | 2 | none |
| A blank line, then "Findings" in the brief or the line of `--fixes` in the chat | 1 | 2 |
| In all | 74 | 52 |

Each paragraph is one line, so the account, the count line and an item keep their number of lines however long their text, and "What needs you" starts at line 11 of the report. The chat form holds at most 52 lines, then the path; the brief holds at most 74 lines before "Findings", 73 of them its own and a blank line. The tests of the maximum replace the tests of the 23 lines.

### The JSON form (R13)

`briefJsonV5` is a strict schema of its own, not built on version 4. It holds `version: 5`; `run`, `title`, `changeState`, `change`, `questions`, `departures`, `documents`, `local` and `notShown` as version 4 has them, with the number of the finding added to each question and departure; and, in place of `headline`, `notCovered`, `covered`, `look` and `changed`: `status`, `needs` (rank, condition, the number of the finding, the kind of the check or the file of the document, and the words of the item), `checks` (kind, the outcomes, the base, the fault, the meaning and `comparedBy`), `fixes` (the number of the finding or `documentation`, the subject, the kinds, the patches, the marks), `findings` (number, id, merged ids, severity, verdict, status, first sentence) and `notExamined`. `briefJson` writes version 5, and the schemas of versions 1 to 4 stay for the tests that pin them.

### Each kind of run (R14)

A run that only reviews has no checks and no fix pass, so ranks 1 to 4 and 8 never hold, and "What needs you" lists its questions and its planned departures, then the command that starts the fix pass. "Before you merge" says that no check ran. The table of fixes takes its title and rows from the decisions of the kind `fix`. After `commits.created`, rank 8 no longer holds, the status line says that the fixes are committed, each line of Patches names its commit from the revisions that the commit holds, and the words of rank 1 say that the commits hold a tree in which the check fails. After an answer pass, the questions and departures with a standing answer leave the needs, the cell of the last run takes the `when` of the checks after the answers, and the block of the answered finding gives the answer, its fix and its validations, as `fateOf` reads the last pass.

### Older runs (R15)

The copy of an older run is rendered again by the current engine whenever a command writes it, so it takes the new form. A run configured before the checks on the base has no column for the base, and row 6 of the meanings reads its failing checks, so it gives no item of rank 3 and says nothing of the base (R10 of the facts before a merge). A run configured before the decision step has no decisions: its findings are numbered, their blocks leave out the fields of a decision, and ranks 5 to 7 never hold.

### Where each part of today goes

The table gives the new place of each part of today's report.

| Today | In the new report |
|---|---|
| The title and the headline | The title; the status line; the count line of "What needs you" |
| The change; The change, in full | The account at the top, once |
| Questions for you; Fixes that go against a written rule; Documents left out of date | Items of "What needs you", ranks 4 to 7 |
| What the review did not cover | Items of ranks 2 to 4; the paragraph below the table of the checks; What the review covered |
| Where to look | The account (public interface, many files); the items of rank 5; the mark "plausible" in the table of fixes |
| What deep-review changed | The status line; "Before you merge"; "What deep-review fixed"; rank 8 |
| Decisions; Findings; Fixes | One block per finding |
| Documentation | Documentation updates |
| Checks | Before you merge; Checks |
| Changed files | Patches; `Held by` to `report --stats` |
| Angles; Statistics | `report --stats`; the passes that ran to What the review covered |
| Conventions | What the review covered |
| Refuted at verification | Refuted at verification |
| Notes of the run | The blocks (validations); What the review covered (groups not verified, candidates outside the change or unlocated, limits); About this run (the worktree, the budget, the stops) |
| The run | About this run; the digest of the roles to `report --stats` |

### Where the code goes

`src/review/brief.ts` keeps the model and its Markdown, and gains the chat form; the short form leaves. `src/review/needs.ts` holds the table of needs. `src/review/brief-checks.ts` gains the meanings and the kinds of validation. `src/review/report.ts` keeps the order of the report, the blocks and the evidence of the review; `src/review/fix-report.ts` keeps the evidence of the fix pass and gives up what moves to `--stats`. A new `src/review/stats-report.ts` renders `--stats`. `src/review/decision-report.ts` gives its lines to the blocks and loses its section. `quoted` and `escapedText` go in `src/review/markdown.ts`. `src/review/brief-json.ts` gains version 5. `src/command.ts` gains `--stats` and the number for `--finding`, and `src/review/answer.ts` the number for `answer`.

The work goes in commits that each pass `npm run check`, the subtraction first: `--stats`, with the parts that leave the report and the second copy of the account; the numbers and the aliases; the table of needs and the meanings, with the model; the brief, the chat form and `report` with no flag; the blocks; the evidence parts; version 5 of the JSON form; the skills and the README; and the build of `dist/`. The snapshots change in each commit that changes what they render, and each is read by hand before it is committed. Two steps went together and one went apart as the work went: the blocks and the evidence parts are one commit, since both rewrite the same sections and their tests; and the numbers are two, the commands taking a number first and the report printing numbers with the new brief, since printing them in the old brief would have changed tests that the new brief rewrites.

### The skills and the README

Step 4 of both skills says that stdout ends with the top of the brief and the path, and keeps the rule to show the lines as printed. A question on any finding goes to `report --finding <number>`, with the number that the brief shows, and the statistics to `report --stats`. "Changed files" becomes "Patches", and `## The run` with its line `Settings:` becomes "About this run". One sentence tells the host to answer in the language that the person writes and to quote ids, paths and commands as printed. The README names the parts of the report where it names them today.

## Technical Decisions

### TD1: One model for every form

The brief, the chat, `report --brief` and the JSON form read one `Brief`, as TD5 of the brief of a run made them. A form that computed its own facts could say what the brief does not, as the short form and the headline do today with the needs that only "What the review did not cover" names. With one model, a fact is computed once and every form shows it or leaves it out. The chat form goes one step further: it is made of the same part functions as the top of the brief. TD5 rejected that coupling so that a change of the Markdown would not break the short form; here the coupling is the point, since the chat must change when the brief changes (PD8 of the product part).

### TD2: The needs are a table, read in order

The conditions of R2 are rows of one table, each a pure function of the context of the brief, with its words beside it. The order of the table is the order of the list, and a new condition is a new row. Conditions spread over the renderers, as the headline, the gaps and the look are today, let a need fall between two of them.

### TD3: The meaning of a check is an ordered table over the faults of today

`faultHolds` already decides what a check's results mean for the merge, in the order of the design of the facts before a merge. The rows of `checkMeanings` read those faults first and the outcomes after, and the first row that holds gives the meaning. So the meanings and the faults cannot disagree, a check that passed after the fixes and failed after the answers reads as the edits of the run, and every combination of outcomes has a row.

### TD4: The number is the rank, and the id stays a key

`rankedFindings` gives one order for the life of a run, so the number needs no record. The ids stay the keys of the ledger, of the decisions, of the answers and of the trailers of the commits; the number is a name in the report and in the commands, turned into the id at the edge.

### TD5: An alias only where the run says what the id or the index names

The renderer adds a number after an id that the map of the run holds, and after a batch index that stands alone in a fixer's text and names a finding of its batch, by the numbering that `fixerTask` gave the fixer. A name such as `argv[0]` is not an index, since a name comes before it. An id that the run does not hold, such as one a worker made up, is left as it is.

### TD6: Backslash escapes, not code spans or entities

A backslash before `<`, `_`, `*`, `[` and `&` is read by every preview of CommonMark as the character, and costs one character in a terminal. It goes only where the character would render: an `_` between two letters or digits, as in `snake_case`, and a `[` that opens no link, as in a batch index `[0]`, stay bare, since a backslash before every punctuation character would fill paths and dots with them. Writing an entity such as `&lt;` reads badly raw, and a code span around a word changes what the worker wrote and broke code spans when a draft of this design tried it.

### TD7: `--stats` is a form of `report`

The statistics are a view of a finished run, as the brief and the fixes are, so they take a flag of `report` and the same rules: one form at a time, the copy written first, the path last.

### TD8: Version 5 of the JSON form is a schema of its own

The headline, the gaps, what was covered, the look and `changed` leave the model, so a schema built on version 4 would keep fields that no longer have a source. Version 5 starts again, keeps every other field of version 4 as it is, and version 4 stays for the tests that pin it.

### TD9: Caps, not a bound that grows

Each list of the brief has a cap, and one line names what the cap leaves out, as PD2 of the questions in the chat did for the questions. The maximum of lines then follows from the caps, the shapes of the items and the four kinds of check, for any number of findings, as R13 of the brief of a run asks. A bound that grows with the decisions was weighed and rejected: a run with ten questions would put sixty lines of options in the chat.

## Open Questions

### Are the caps right?

The brief shows three decisions, three items of unfinished work and ten fixes in full, and names the others. Rewrites of the reports of the run of PD10 and of the run in Codex have briefs of 53 and 58 lines, under the maximum of 74. The gate runs had at most three questions and seven patches, so none of them reaches a cap; a run that does shows whether the line of the others is enough.

### Do the hosts show the top of the brief as printed?

In rewrites of two gate runs, the chat form is about 38 and 43 lines, against at most 23 today, and at most 52. Step 4 already tells the host to show the lines as printed; the gate checks that both hosts do, with the table of the checks.

### Does an alias of an index misfire?

A fixer may write `[0]` for something else than its batch. The test fixtures hold such text, and the gate reads each alias of the three reports.

## Test Strategy

### R1: The order and the maximum of the brief

A test of the shape reads each snapshot and checks that the brief holds its parts in order and that "What needs you" starts at line 11. A test renders a fold that reaches every cap, with four failing checks, four items of rank 4, five decisions with four options each and twelve fixes, and checks the maxima of 74 and 52 lines.

### R2 and R3: The needs

A test per rank builds a fold where the condition holds and checks the item, its words of "If you do nothing", its command with `--run`, and its place; a fold where no condition holds checks "Nothing needs you" and the conditions it names. A test checks that the count line has one part per condition that holds and names the faults of the run that do not hold. Tests check a question whose default the tree does not hold, in a run that only reviews and after a blocked fixer, and that it has one rank; the line of the others of rank 4 with a finding, a document and the edits of an attempt that name no finding; and an item of rank 4 for a budget stop, with no local path.

### R4: The meanings

A test per row of `checkMeanings`, from a `BriefCheck` and a configuration that fit the row, including a last run that was `cut`, a check with no last run, a check that passed, failed after the fixes and failed again after the answers, and a run configured before the checks on the base. A test checks that every meaning that rests on the repair's reading says "by a model's comparison".

### R5: The fixes

A test checks the kinds of a fix with several validations, in order, a fix with none, the heading that says the fixer reports them, and the row of the others with a plausible fix in it.

### R6 and R7: The blocks and the numbers

A test checks that the blocks run from 1 to the count of findings, each with its anchor, and that each link of the report has its target. A test of `quoted` checks an id of another finding, the block's own id, an id the run does not hold, a standing index, a name with an index, a code span, and an id inside a path and a URL. The tests of the command check `report --finding 3`, `report --finding RIPPLE-3`, `answer --finding 2 --accept`, a number out of range and an id of a finding that is not a decision.

### R8 and R9: The evidence and the statistics

`report.test.ts` lists the new headings of a report and of `--stats`. A test checks that the brief and the evidence hold no heading that moved to `--stats`, and that the brief and the chat hold no local path.

### R10 and R11: The words and the escaping

The test of the shape reads the brief of each snapshot for the words of R10, with workers' texts that hold none of them, and the whole report for HTML other than the anchor lines. A test of `escapedText` checks `<stdin>`, `__init__`, `*`, `_name_`, `[x](y)` and `&lt;` in a sentence, each of them in a code span, `snake_case` and `[0]` left bare, and a character after an escaped backslash or backtick.

### R12: The chat

The tests of the short form become tests of the chat form: its parts, its maximum, the line of the change with its mark, findings as plain text, and the line of `--fixes` in a fix run. `cli.test.ts` checks what `review` and `report` print. `skills.test.ts` holds the new words of step 4.

### R13: The JSON form

`brief-json.test.ts` parses version 5 from each snapshot run, checks the fields kept from version 4, and keeps the tests of versions 1 to 4.

### R14 and R15: Each kind of run, and older runs

The snapshots `synthetic.md`, `fix.md` and `survey.md` cover a run that only reviews, a fix run and a surveyed run. A test renders a fold after `commits.created` and after an answer pass. A test renders the report of each golden checkpoint, which no test renders today, and runs the test of the shape on it.

### R16: The gate

The gate runs as R16 says. The function that the test of the shape uses reads any report, and the gate runs it on the copy of the report of each gate run. The answers of the hosts are scored on the facts that each brief states, in the words of the person.

## Verification

The work is the series of the pull request of this proposal, from "Move the statistics of a run to report --stats" to "Rebuild the engine and the skills for the report for the person". Each commit of it typechecks and lints, `npm run check` passes at each commit that changes the engine and at the head, with 2,964 tests, `npm run test:contract` passes at the head, its 85 tests reading the new form, and `npm run verify` passes at the head.

The tests of the design are in place but for the gate. The tests of the needs, the meanings, the kinds of validation, the blocks, the numbers, the quotes, the escaping, the chat form and the JSON form are in `test/review/brief.test.ts`, `test/review/brief-checks.test.ts`, `test/review/report.test.ts`, `test/review/markdown.test.ts` and `test/review/brief-json.test.ts`. The test of the maximum renders a brief with every list at its cap and four checks: the brief has 73 lines, and with the blank line before "Findings" 74, against the 72 of the table as first written, which left out the sentence on a plausible finding; the chat form stays under 52. Versions 1 to 4 of the JSON form are held to outputs of the engine before this change, kept in `test/fixtures/brief-json/v4.json`. The test of the shape on the report of each golden checkpoint is not written; the snapshots and the report tests read the order of the parts instead.

Three snapshots were read by hand at each commit that changed them. They have 72, 153 and 174 lines, against 108, 181 and 199 before. The fix run holds two findings, so the snapshots do not show the length on a real run; the gate does.

The contract test leaves out three more facts that a stop changes by its nature: the first 8 characters of the run's id, which the brief and its commands now name; the patches that the item of the uncommitted fixes names to read first, which follow how the edits of a stopped fixer are split among patches; and the line of the totals in About this run, which holds the spend.

### The gate (R16)

The three runs ran on 2026-10-29 on Linux with the engine of this branch, from the commit that rebuilds `dist/`. Each was started with the command of the engine, not through a host, so the start of a run through a skill is not part of this gate. The reports, the ledgers and the transcripts of the hosts stay outside the repository, with the author; the numbers here are from them.

The two runs on pallets/click #3878 ran in fresh clones at the head `f8c5a8e` with the base `2247b35`, the merge base with `main`. Each named the typecheck as `tox exec -e typing -- mypy --platform win32`, as the gate of the facts before a merge did. The fix run in Claude Code also named its test: `pytest` of one test, kept with the author outside the clone, that sends input through `CliRunner` with `echo_stdin` and checks that every byte reaches the command; by hand it passes on the base and fails on the change. That run took 16 minutes 35 seconds and 7.74 USD and has 9 findings: it fixed 5 and left 4. Its "What needs you" holds two items, the test, which "fails because of the change" and passes on the base, and the 5 patches to commit, and its table says that the typecheck "fails the same way on the base, by a model's comparison". The fix run in Codex took 34 minutes and has 18 findings: it fixed 4, found 1 already fixed, asks 1 question and left 12. Its "What needs you" holds the question, whose default is not deep-review's choice, and the 5 patches, and its table gives the typecheck and the test, which fail on the base too, that same meaning. Their reports have 308 lines and 6,234 words, and 410 lines and 6,166 words, against 433 lines and 8,404 words, and 614 lines and 9,503 words, of the runs of the same change in the gate before. In each, "What needs you" starts at line 11.

The run of deep-review on this pull request, a fix run in Claude Code with `main` as its base, has 40 findings: it fixed 36, 2 of them against a written rule, found 1 already fixed and left 3. It stopped once at the usage limit of the provider and went on when the same command ran again; in all it took 108 minutes and 49.50 USD. Its report has 993 lines and 23,230 words, and "What needs you" starts at line 11. Its `build`, `npm run build`, failed before and after the fixes and on the base with the failure of #89: the build stages its artifacts in a temporary directory on another filesystem and cannot rename them into `dist/`. A model read the two outputs as not comparable, so the build is the first item of "What needs you", a check not compared with the base, and the typecheck, the lint and the test were skipped. The failed build also deleted `dist/claude`, and the run recorded the deletion as the build check's rewrite, the first of its 45 patches, so `deep-review commit` refused the tree once `dist/` was restored. The other 44 patches were applied by hand on the branch of the pull request of the review's fixes, which holds them, a rebuild of `dist/`, and the two fixes against a written rule that wait for the author; with them, `npm run check` (2,996 tests), `npm run test:contract`, `npm run build` and `npm run verify` passed by hand.

After each run, the person's two questions were asked in Korean in a new session in its worktree. In Claude Code the skill of this branch was given as a plugin directory under another name, with the installed plugin turned off. The skill sets `disable-model-invocation`, so it loads only when the person types its command. Asked without the command, three times after the fix run in Claude Code, the host had no skill: it found the report and the logs of the run by itself, ran the tests, and applied the patches in a worktree of its own, so those answers do not test the brief. Through the command, it answered in 22 seconds after the fix run in Claude Code and in 43 seconds after the run on this pull request, each time with only `report` and `report --fixes` of the engine. Each answer named each item of "What needs you", took no failure that the base shares as a reason to wait, and said that the change cannot merge yet, for the items the brief gives. One answer said that the scope of the run was the working tree, which it was not, when it offered to commit. In Codex the skill of this branch was read from its file, and the sandbox was off, since a session that cannot ask the person cannot grant the approval that `report` needs to write in the git directory, as in the gate before. It answered in 29 seconds with only `report` and `report --fixes`, showed the brief as printed, and took no failure that the base shares as a reason to wait. It did not say in its own words whether the change can merge, following the rule of step 4 not to interpret the findings beyond the printed lines; how a host answers from the brief is #87.

The test of the shape on a real report is not written, as said above; the three reports were read by hand against R1 to R11. The metrics of places per finding and of text said twice are not measured.

## Risks & Migration

### Older runs read in the new form

The copy of an older run changes when a command writes it again, and the stored record keeps the old text. A person who compares the two sees two forms of one run. The facts are the same, and only the copy changes.

### The contract test compares reports

`normalizedReport` removes the parts that differ between a run and its resumed twin, by their headings. The parts move: Statistics leaves the report, The run becomes About this run, and the lines that a resumed run orders differently move from the notes of the run into About this run and the blocks. The helper follows the new headings, and the contract test runs before the commit that changes it.

### A program reads the JSON form

Version 5 changes the shape. Only the tests read the JSON form in this repository; a program outside it sees the version change.

### The snapshots change at once

Most of the lines of the three snapshots change. Each commit changes the snapshots only for what it renders, so a reviewer reads each change beside its code.
