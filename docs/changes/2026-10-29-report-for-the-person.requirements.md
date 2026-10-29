# Product Requirements: The report for the person

Technical part: [2026-10-29-report-for-the-person.design.md](2026-10-29-report-for-the-person.design.md).

## Summary

After a fix run, the person asks two questions: what must I look at myself, and can this change merge now? The report of the run holds the answers, but in the order of the steps of the engine. One finding is told in three to seven sections. The headline counts the questions and the fixes against a written rule, while a check that the change breaks, the uncommitted patches and the fixes that no fixer applied sit in other sections. How each fix was checked comes near the end of the report. The report names each finding by the id of the engine, such as `RIPPLE-3`, and it uses the terms of the engine. The report [`2026-10-23-skill-ux.md`](../reports/2026-10-23-skill-ux.md) calls this a report that serves two readers at once (U7), and the gate of [the facts before a merge](2026-10-28-facts-before-a-merge.design.md) shows a host that took a failure that the base shares as a reason to wait.

This proposal orders the report by what the person must settle, and it tells each finding in one place. The brief starts as today, with the change as submitted, and a status line follows. "What needs you" is a numbered list that the engine computes from a closed table of conditions, in the order of what doing nothing costs. Each item says what happens if the person does nothing, and gives the command. "Before you merge" gives one row per check, with its result on the base, as submitted and in its last run, and one meaning from a closed table that says who compared the failures. "What deep-review fixed" gives one row per fix, with how its fixer reports checking it and its patch. After the brief, each finding has one block, numbered by its rank, from the problem to the checked patch. The statistics of the engine leave the Markdown for `deep-review report --stats`. The brief uses plain words, and the chat shows the top of the brief as the engine prints it.

The proposal revises parts of [the brief of a run](2026-10-20-run-brief.requirements.md), [the questions in the chat](2026-10-24-questions-in-the-chat.md), [the documentation step](2026-10-23-documentation-step.requirements.md) and the facts before a merge, and names each part where it applies. It is the first of three steps. It renders from what the ledger records today and adds no event. A later proposal records the facts that the design here still lacks, and #87 builds the reading of the host on the new brief.

## Problem

### What the person asks after a run

The person who ran the review wants to know what waits for them, what the run fixed and how well, and whether the change can merge. The report on the surface of the skill shows that the report of a run answers each of these from a different section, or not at all (U3, U7). U7 names the cause: the report serves two readers at once, the person who decides and the author or the auditor of the engine.

### One finding in many places

The report of a fix run follows the steps of the engine. After the brief come the change in full, Decisions, Findings, Fixes, Documentation, Checks, Changed files, Angles, Conventions, Refuted at verification, Statistics, Notes of the run, and The run. Each step writes its part of a finding in its own section. The three gate runs of the facts before a merge, on pallets/click #3878, show what this costs. In the run of PD10, an applied fix appears in five sections, and the fix against a written rule, `RIPPLE-3`, appears in seven. In the run in Codex, with 19 findings, a finding appears in 4.2 sections on average. The three reports have 433 to 614 lines and 8,404 to 9,503 words, and 7.8 to 13.3 percent of their words sit in a run of 12 words that the same report printed before.

### What needs the person is not in one place

The headline counts the questions, the fixes against a written rule, the documents that the fixes left out of date, and the checks that the edits of the run made fail. Other things need the person before a merge, and the headline does not count them. A check that the change breaks, and a fix that the decision step chose and no fixer applied, are listed under "What the review did not cover" (PD6 of the documentation step, PD4 of the facts before a merge). The uncommitted patches are one clause of the paragraph "What deep-review changed". An edit from an attempt that ended without an answer is named only in the table of changed files and in the list of patches: in the run in Codex, the documentation patch came from such an attempt, at lines 498 and 510 of 614.

The headline also does not tell a question whose default is the choice of deep-review from one whose default is not. In the run in Codex, deep-review's choice is option 2 for each of the three questions, and option 1 is the default in place. The headline says "3 things need you: 3 questions. Nothing waits for you: each question has a default in place."

### The facts for a merge and for a commit come late

In the run of PD10, the facts for a merge are part of a paragraph of about 130 words in "What deep-review changed", at line 62. How the fixers report checking each fix is in "Notes of the run", at lines 398 to 415 of 433. A person who reads the patches before `deep-review commit` finds the fix under Fixes and how it was checked at the end.

### The words of the engine

The brief names a finding by the id of the engine, such as `RIPPLE-3`, `SWEEP-2` or `DUPLICATION-10`. The id says which angle found the finding, and nothing that the person needs. The brief speaks of the account of the triage, the reading of the repair and each angle. The evidence speaks of clusters, batches and `Held by`. A host translates these words for the person, and a person who opens the report learns them first. Angles, Statistics and the column `Held by` of Changed files serve a maintainer of deep-review, and the person reads past them (U7).

### What the hosts answered

The gate of the facts before a merge records what each host answered to "can this change merge now?" Claude Code ran the typecheck again in a worktree of the base before it answered. Codex counted failures that the base has too as something still to confirm (#87).

Before this proposal, a model was given only the brief of two of the gate runs, once in the form of today and once in the form that this proposal describes, with the lines that need a new record left out, and was asked the two questions of the person. Its answers were scored on six facts per run. With the brief of today it got 5 of 6 facts on the run of PD10 and 3 of 6 on the run in Codex. With the new brief it got 6 of 6 on both. On the run in Codex, with the brief of today, it took the failures that the base shares as a reason to wait, called the 10 findings left outside the change unresolved, and did not name the edit of the attempt that ended without an answer. Each brief was asked once, so the numbers show a direction and are not a measure, and one of the six facts of the run in Codex, that attempt, is stated only in the new brief. The author keeps the briefs, the answers and the reports of the gate runs outside the repository; the numbers here are from them.

## Goals

In the first screen of the brief, the person reads what needs them, in the order of what doing nothing costs, with what happens if they do nothing and the command for each; what each check means for a merge, and who compared its failures; and what the run fixed and how each fixer reports checking it. Each finding has one number and one block, and each statement of the brief leads to it. A host answers "what must I look at myself" and "can this merge now" from the brief alone, with no check of its own. On the same run, the report is shorter than today.

## Non-Goals

### New records in the ledger

This proposal renders from what the ledger records today. More facts would make the brief better, and each needs a new record: the failures in each output of a check, as a list that the engine compares; the fixes whose plan rests on the default of a question; why deep-review's choice is not the default; the finding that a failing check follows from; whether a fix changes what callers see; a short headline per finding; one sentence on why a verifier refuted a candidate; and a run of the tests of each fix by the engine, with and without the fix. They change events and role prompts, so a later proposal takes them, with a fixture of the ledger. Until then the brief says only what the ledger holds.

### The reading of the host

How the host reads the brief and answers the person is U4, and #87 follows it. That rule rests on the words of the brief, so it comes after this proposal. The skills change here only where the brief changes, and in one sentence on the language of the answer (R12).

### The report in the language of the person

The report stays English, and the host translates it (PD10). U7 asks to think the language again; this proposal thinks it again and keeps English.

### A verdict on the merge

The report states the result of each check, what it means, and who compared the failures. It never says whether to merge, as in the facts before a merge.

### A brief in a file of its own

The brief and the evidence stay in one file, as PD9 of the brief of a run chose, and no finding gets a file of its own either. A host that reads a separate brief answers without the evidence, and a preview of Markdown cannot follow a link between two files in a hidden directory.

### The role prompts

No role prompt changes. The renderer escapes what a preview of Markdown would hide in the text of the workers (R11). A request to the workers to write code in backticks waits for the proposal of the new records, which changes the role prompts anyway.

### The order of the findings

The findings keep the order that the merge and rank step gives them. Their numbers follow that order.

### The place and the name of the file

The report stays where it is, under the git directory, with the name it has (U7 names the date in UTC). This proposal changes what the file says.

## Requirements

### R1: The brief puts first what the person must settle

The report starts with the brief, which ends at the heading "Findings". The brief holds, in this order: the title and the account of the change as submitted, as today; a status line; "What needs you" (R2 and R3); "Before you merge" (R4); and "What deep-review fixed" (R5). This revises R2 of the brief of a run, which orders five parts as principle 5 lists them, with a headline before them and a paragraph on what deep-review changed after them.

The account says, as today, that deep-review wrote it of the change as submitted, before its fixes, and that no verifier examined it. It says when the change alters a public interface, and when it affects many files beyond those it changes, each in deep-review's judgment; today "Where to look" says both. The status line names the kind of run and its id, and counts the findings by their outcome. An example, from the run of PD10:

```text
deep-review's fix run 97b8fcf5 has 8 findings. It fixed 6 in your working tree, one of them against a written rule. It asks you 1 question and left 1 finding as is.
```

"What needs you" starts by line 14 of the report. The brief has a fixed maximum of lines for any number of findings, as the short form has today (R13 of the brief of a run): each list of the brief shows a fixed number of entries and names the others in one more line (R2, R3, R5). The design gives the maximum.

### R2: What needs you is computed from a closed table

The engine computes the items of "What needs you" from the fold of the run. Each condition of the table below that holds gives its items: one item for each check, question, fix, edit or document that it names, in the order of the table. The order is the order of what doing nothing costs. No other item appears, and each question has one rank.

| Rank | Condition | If you do nothing |
|---|---|---|
| 1 | A check that the edits of this run made fail | `deep-review commit` commits a tree in which the check fails |
| 2 | A check that fails because of the change, or that has failures that the base does not have | the check keeps failing, since no step of the run fixes a failure that the change brings |
| 3 | A check that fails, in a run that takes its checks to the base, and that the run did not compare with the base | nobody knows whether the change causes the failure |
| 4 | Work that the run did not finish: the edits of an attempt that ended without an answer, when no later attempt of the same unit answered (R20 of the fix pass); a fix of the kind `fix` that no fixer applied, deferred, blocked, not attempted, or stopped by the run budget; an answer the person recorded that no answer pass applied, with `--record-only` or a pass that was refused; or a document named out of date that no step updated (R7 of the documentation step) | `deep-review commit` commits the edits as they are, the finding stays as it is, or the document stays out of date |
| 5 | A fix against a written rule that the person has not accepted or rejected | the fix stays, and the rule stays as it is written |
| 6 | A question whose default is not deep-review's choice | the default stands, and deep-review's choice is another option |
| 7 | A question whose default is deep-review's choice | the default stands, and it is deep-review's choice |
| 8 | Fixes that are not committed | the fixes stay uncommitted in the working tree |

Each item says what happens if the person does nothing, in the words of the table, and gives the command that acts, when one exists. Rank 4 shows at most three items, and one more line names the others: a finding by its number, a document by its file, and edits that name no finding by their patch. An item of rank 4 for work that the run budget stopped says so and points to "About this run", which holds the command that continues the fix pass, since that command names local paths. The item of rank 8 names what to read first among the patches: the fixes of findings that the verifier did not confirm, and the edits of an attempt that ended without an answer when a later attempt of the same unit answered.

A line above the items counts them, one part for each condition that holds, with the number of its items or, for rank 8, of its patches. An example, from the run of PD10:

```text
Before a merge: 1 check fails because of the change, 1 fix against a written rule to review, 1 question whose default is deep-review's choice and 7 patches to commit. The edits of this run made no check fail, and the run left no work unfinished and no document out of date.
```

Its second sentence names each of ranks 1 and 4 that does not hold, so the brief still says, after a fix run, that the edits made no check fail and that no document was left out of date, as R4 of the facts before a merge and the documentation step have it say today. When no condition holds, the part says "Nothing needs you" and names the conditions that it checked.

Below the items, one line says that each question has a default, the option that is the easiest to reverse, so no item holds up the run; that the person can ask their agent to run the commands, or type them at a terminal as "About this run" shows; and that `deep-review report --finding <number>` prints the block of any finding. The brief names no local path (R15 of the brief of a run).

This revises what the headline counts (PD6 of the documentation step, PD4 of the facts before a merge): a check that the change breaks, a fix that no fixer applied and the uncommitted patches are now items, and "What the review did not cover" no longer lists them (R5 of the facts before a merge). PD4 below gives the reason. R4 of the facts before a merge stays as rank 1, and R7 of the documentation step stays as rank 4, with a cap of three documents shown in full.

### R3: A question and a fix against a written rule in their items

The item of a question gives the question and, in one line per option, what the option does, what it costs, and the rule that it makes. It marks the default and deep-review's choice. It says whether the tree holds the default, as the brief does today: the tree does not hold a default that edits the code in a run that only reviews, or when no fixer applied it. It says what happens if the person does nothing, and gives the command for each other option. Why deep-review asks and where it looked are in the block of the finding.

The item of a fix against a written rule gives the rule, where it is written, why deep-review went against it, and that the fix is in the working tree. It gives the command to accept the fix and change the rule, and the command to follow the rule. The evidence is in the block of the finding. These items keep R8 and R9 of the brief of a run.

The questions and the fixes against a written rule show at most three items in full, in the order of their ranks, and one more line names the others by number, each of whose blocks holds its options and its commands. This revises PD2 of the questions in the chat: its two caps of three, one for the questions and one for the fixes against a rule, become one cap of three for both. It revises PD1 there too: the options and the costs of a question are now in the chat.

Each command names the run with `--run` and the first 8 characters of its id, and names the finding by its number (R7).

### R4: Before you merge gives each check one meaning

"Before you merge" is a table with one row per check: its result on the base, as submitted, and in its last run, and what it means. The cell of the last run says when it ran: after the fixes, after the fixes for the checks, or after your answers (R3 of the facts before a merge, which says "after the repair"; R10 keeps the word out of the brief). The meaning comes from a closed table. The first row that fits the check gives its meaning, and a timeout counts as a failure:

| The check | Meaning | Rank in "What needs you" |
|---|---|---|
| passed earlier in this run, and fails in its last run | the edits of this run made it fail | 1 |
| fails, and passes on the base | fails because of the change | 2 |
| fails, and the worker that compared the failures found failures that the base does not have | fails on the base too, and the change adds failures, by a model's comparison | 2 |
| fails, and the run took it to the base and could not compare | fails, not compared with the base, and why | 3 |
| fails, and the worker that compared the failures found the same failures on the base | fails the same way on the base, by a model's comparison | none |
| fails, or failed as submitted and did not run after the fixes, in a run configured before the checks on the base | fails | none |
| failed as submitted, and did not run after the fixes, since no fix changed a file | fails as submitted, not compared with the base | 3 |
| passed as submitted and in its last run | passes | none |
| failed as submitted, and passes in its last run | passes; it failed as submitted | none |
| passed as submitted, and did not run after the fixes, since no fix changed a file | passes as submitted; no check ran after the fixes | none |
| did not finish its last run: skipped, not started, or cut by a kill | did not finish its last run | none |
| did not finish as submitted, and passes in its last run | passes; it did not finish as submitted | none |
| fails in its last run, in a run that takes its checks to the base, which never took it there, since it did not fail as submitted | fails, not compared with the base, and why | 3 |
| never ran | did not run | none |

Below the table, one paragraph gives a fixed sentence on the shared case, a check that fails the same way on the base has no failure that the change adds; names the base; says what the run did not examine, each gap of R10 of the brief of a run that is not an item; and names the findings left as is, by their reason. The report never says whether to merge. The table replaces the line `Checks:` of the short form and the sentences on the checks of "What deep-review changed" (R6 of the facts before a merge). A run that an engine before the checks on the base configured says nothing of the base, as R10 of the facts before a merge has it: its table has no column for the base, and its rows read the meanings that do not rest on the base.

### R5: What deep-review fixed says how each fixer reports checking its fix

"What deep-review fixed" is a table with one row per applied fix and per documentation update, in the order of the findings. The default that a fixer applied to a question still open is a fix too, and the status line names it beside the question. A row gives the number of the finding and its severity, with "against a written rule", "the default of a question" or "plausible" when so; the subject of the commit message of the fix; how its fixer reports checking it; and the numbers of its patches. The table holds at most 10 rows, and one more row names the others by number and marks those that are plausible or against a written rule, so the brief names every fix whose finding the verifier did not confirm.

The column of the checking lists the kinds of the validations that the fixer reported, from a closed list, strongest first: "a new test fails on the code before the fix", "a test fails when the fix is undone", "existing tests and checks rerun", "read against the source", "a limited check", and "none reported". Its heading says that the fixer reports them, as the sentence of R7 of the facts before a merge does, which the column replaces. This revises PD3 of the questions in the chat, which keeps the fixes out of the brief (PD9 below).

### R6: One block per finding, numbered by its rank

Each finding has a number, its rank in the run, from 1. It has one block under "Findings", in that order. The block has the anchor `finding-N`, and its heading is the number and the first sentence of the summary of the finding. Its first line gives the status (a question for you, fixed, fixed against a written rule, left as is, or not fixed), the severity, and the verdict as the verifier gave it.

Then come these fields, each once and only when it has content: where (the path and the line, the id of the engine and the ids merged into it); the reason and the evidence of the verifier; the decision with its plan, its grounds and the options it rejected (a question adds why it asks, the rule that each option makes and where it looked); the fix with its commit message and its patch; the corrections that the fixer made to the plan; and one line for each validation that a fixer of the finding reported, with its kind, its test or command, and its result, oldest first, naming the fixer when more than one worked the finding.

The sections Decisions (R8 of the decision step), Findings (R9 of the read-only review) and Fixes (R13 of the fix pass), and the validations of Notes of the run, become these blocks. The anchor by the number replaces the anchor by the id of R12 of the brief of a run, and the batch of each finding (R18 of the fix pass) moves to `--stats` (R9).

The text that a worker wrote is quoted as written (PD5 of the brief of a run). Where it names another finding by the id of the engine, or a fixer names a finding by its index in the batch, such as `[0]`, the renderer adds the number after it, as in "REMOVALS-6 (finding 1)".

### R7: The commands take the number of a finding

`deep-review answer --finding` and `deep-review report --finding` take the number of a finding, and they still take the id of the engine. R1 of the answers takes the id of a finding as the report prints it; the report now prints the number, and an id from an earlier copy, a pull request or a commit still works. `deep-review report --finding` prints the block of any finding, where today it prints only a question or a fix against a written rule (R7 of the questions in the chat). Every command that the report prints names its run with `--run`. "About this run" maps each number to the id of the engine.

### R8: The evidence follows the blocks

After the blocks come, in this order: "Documentation updates", one block for each record of the documentation step; "Checks", one block for each check, with its command, where it came from, each of its runs with the result, the time and the output files, and the words of the repair; "Patches", in the order of the commits, each with its subject, its finding, its files and its artifact; "What the review covered", with the review passes by their plain names, the convention sources read, and each gap of what the run did not examine; "Refuted at verification", as today, under the name that the prompt of the verifiers gives it; and "About this run", with the facts of "The run" of today but the digest of the roles, one line of totals, one line on the checks of the worktree, what a stop of the run did, the command that continues a fix pass that the run budget stopped, the map of numbers to the ids of the engine, and how to type the commands at a terminal. "About this run" holds each local path that the engine writes, as the facts of the run do today (R15 of the brief of a run). This revises the order of the evidence of R12 of the brief of a run.

### R9: The statistics move to a form of their own

`deep-review report --stats` prints what leaves the Markdown: the statistics per step, the angles with their leads, the digest of the roles, and the clusters, the batches, `Held by` and `First blocked on` of the fix pass. The ledger keeps all of it, and `deep-review status --json` gives the statistics as it does today. This revises R9 of the read-only review, R13 of the fix pass and R12 of the brief of a run where they keep these parts in the report. A metric of an earlier proposal that reads the statistics of a report reads them from `--stats`.

### R10: The brief uses plain words

The words that the renderer writes above "Findings" hold no id of the engine and none of these: `CONFIRMED`, `PLAUSIBLE`, `REFUTED`, departure, angle, triage, cluster, batch, attempt, phase, `Held by`, repair, sweep, scope. The text of a worker that the brief quotes, such as the account, an option or a reason, keeps its words (PD5 of the brief of a run). The renderer changes these words of today:

| Today | The report says |
|---|---|
| the id of a finding, such as `REMOVALS-6` | finding N |
| the account of the triage | deep-review's account of the change |
| an angle | a review pass, by its plain name |
| the reading of the repair | a model's comparison, or the worker that compared the failures |
| before the fixes, for a result of a check | as submitted |
| `CONFIRMED`, `PLAUSIBLE` | in the brief, confirmed and plausible, and the brief says once that a plausible finding is one that the verifier did not confirm; in a block, the verdict as the verifier gave it |

"The default", "in place now", "deep-review's choice" and "a fix against a written rule" keep the words that R8 and R9 and PD6 of the brief of a run gave them. Below "Findings", the blocks quote the workers as they wrote. This carries R12 of the brief of a run, which keeps the names of the engine out of the brief, to the ids and to the words of the verdicts and of the comparison.

### R11: The report reads the same raw and rendered

The only HTML in the report is the anchor line before the block of a finding or of a check. The report has no `<details>`, which the question block of today uses. In the text of a worker, the renderer escapes a tag such as `<stdin>`, a `__` and a `*` outside a code span, so a preview shows what a terminal shows. Each paragraph is one line, and a table has at most 5 columns.

### R12: The chat shows the top of the brief

After a run, and for `deep-review report` with no flag, the engine prints the chat form: the title with the run, the first sentence of the account with its mark (R4 and R5 of the questions in the chat), the status line, "What needs you" and "Before you merge" as the brief has them, then one line that names `deep-review report --fixes`, then the path of the report. The chat form names findings by number with no link, as `report --brief` does today. It has a fixed maximum of lines for any number of findings, which the design gives. Each of its lines keeps its sense when a model rewords it, as PD12 of the brief of a run asks: an item names its finding or its check, and its condition, in its first words.

This replaces the short form of R13 of the brief of a run, of R1 to R4 of the questions in the chat and of R6 of the facts before a merge, and its maximum of 23 lines, which R6 of the facts before a merge set. The skills show these lines as printed, as R17 of the brief of a run asks. They tell the host to answer the person in the language that the person writes, and to quote ids, paths and commands as printed. The skills and the README name the parts of the report as the report names them.

### R13: The JSON form gives the same facts

Version 5 of the JSON form gives the facts of the new brief: the status, each item of "What needs you" with its condition, its rank and its finding, check or document, each check with its results, its meaning and who compared it, each fix with the kinds of its validations and its patches, and each finding with its number, its ids and its verdict. It keeps the run, the title, the state and the account of the change, the questions, the departures, the documents, the local paths and what the brief does not show. It replaces the headline, the gaps, what was covered, where to look and what changed. It keeps the version of PD11 of the brief of a run.

### R14: Each kind of run

The report of a run that only reviews says in its status line that deep-review changed no file and ran no check. "What needs you" lists the questions and the planned fixes against a written rule, and then the command to fix. "Before you merge" says that no check ran and names the major findings that stay open. "What deep-review fixed" becomes "What deep-review would fix", one row per planned fix, and each block shows the plan.

After `deep-review commit`, the item of the uncommitted fixes leaves, the status line says that the fixes are committed, each patch names its commit, and an item of rank 1 says that the commits hold a tree in which the check fails. An answer that no pass applied yet stays in "What needs you" as work not finished, and the status line says it is not applied. After an answer pass, the status line says which answers the report follows, the answered items leave "What needs you", the cell of the last run says that it ran after the answers, and the answered block gains the answer, its fix and its checks (R10 of the answers). The top still describes the change as submitted.

### R15: An older run renders in the new form

This proposal adds no event, so the report of a run that an older engine recorded renders in the new form when a command writes its copy again, as R18 of the brief of a run lets an older run show what it has. A fact that an older ledger does not hold reads as not recorded. A run configured before the checks on the base says nothing of the base, and gives no item of rank 3 (R10 of the facts before a merge).

### R16: The gate

The gate is three real runs, and the reading of their briefs by the hosts. The run of deep-review on this pull request is one. A fix run in Claude Code and a fix run in Codex on pallets/click #3878, the change of the gates before, are two and three, and one of them has a check that the change breaks, as PD10 of the facts before a merge had. The report of each run passes the checks of the design. After each run, the person asks the host, in a new session, what they must look at themselves and what the run fixed, and if the change can merge now. Each answer names each item of "What needs you", takes no failure that the base shares as a reason to wait, and runs no check of its own.

## Metrics

### Places per finding

The number of sections of the report that name a finding. Today a finding appears in 3 to 7 sections, 4.2 on average in the run in Codex. Target: 1 block, and in the brief only the rows and items that lead to it.

### Where the facts of the person start

The line at which "What needs you" starts, and the line at which "Before you merge" ends. Today the run of PD10 starts its first question at line 15 and its fix against a written rule at line 41, and gives the facts for a merge in a paragraph at line 62. Target: "What needs you" by line 14, and the brief within its maximum (R1).

### Text said twice

The share of the words that sit in a run of 12 words that the same report printed before. Today 7.8 to 13.3 percent. Target: under 4 percent.

### Needs not counted

The conditions of the table of R2 that hold in a gate run and that the headline does not count. Today, in the run of PD10, the check that the change breaks and the 7 uncommitted patches; in the two other runs, the uncommitted patches. Target: none.

### The answers of the hosts

The facts that the answer of the host gets right, out of those that the brief states, after each gate run (R16). Target: all of them, with no check run by the host.

### The length of the report

The words of the report of a fix run. Today 8,404 to 9,503 for 8 to 19 findings. Target: fewer than today on a run of the same size.

## Product Decisions

### PD1: The top stays the change as submitted

The title and the account describe the change under review, as submitted, never the tree after the fixes. The fixes are in "What deep-review fixed" and in the blocks. This keeps PD7 of the facts before a merge and PD5 of the questions in the chat.

### PD2: A finding is named by its rank

A finding is "finding N", N its rank in the run. The id of the engine says which angle found the finding, which the person does not need, and it does not say where the finding is in the report. A number is short, says the order, and is the same in the brief, the blocks, the tables and the commands. The ids stay the keys of the ledger, of the decisions, of the answers and of the trailers of the commits; the Where line of each block and the map of "About this run" name them, and the commands take both.

Ids by kind, such as Q1 for a question and F2 for a fix, were weighed and rejected: a fix against a written rule would wear the letter of a question or of a fix, and a finding would change its id when an answer changes its kind. One order is simpler to learn and to compute.

### PD3: What needs you is in the order of what doing nothing costs

The items follow one rule that the engine can test: what happens when the person does nothing. A check that the edits of the run made fail comes first, since `deep-review commit` would commit it. A fix against a written rule comes before a question, since the default of a question is the option that is the easiest to reverse (principle 4), while a fix against a written rule stays in the tree against the rule. This order departs from the order of principle 5, which puts the questions before the departures, and from R2 of the brief of a run, which follows it. It also revises the metric of the brief of a run that puts the first question within 20 lines: checks, unfinished work and fixes against a written rule now come before it. The section "Against the vision note" names it.

### PD4: What needs you counts a fault of the change too

PD6 of the documentation step and PD4 of the facts before a merge count in the headline only what the run itself did and knows: a question, a departure, a document that its edits left out of date, a check that its edits made fail. A check that the change breaks and a fix that no fixer applied are faults of the change, and they go under "What the review did not cover". PD4 of the facts before a merge rejected counting a check that the change breaks, since a fix that no fixer applied would then have to count too.

This proposal counts both, and the uncommitted patches. The list answers the question that the person asks, what must I do before a merge, and each of these costs something before a merge if nobody acts: no step of the run fixes a failure that the change brings, a fix not applied leaves its finding as it is, and an uncommitted patch is not in the change. "What the review did not cover" read them as gaps of the review, and the list now reads them as tasks. The distinction of PD4 stays in the words of each item and in the order: a fault of the run comes first and says so, and a fault of the change says that the change brings it. The cost is that "Nothing needs you" becomes rare after a fix run, and that the count of a run with many unapplied fixes grows; rank 4 shows three of them and names the rest, and the count line says which faults of the run do not hold.

### PD5: A question and a fix against a written rule keep their own shapes, in one list

A question has options, costs, rules and a default. A fix against a written rule has a rule, its source, a reason and two commands. One list holds both, so the person reads one numbered list of what needs them, but each item keeps its shape. A shape common to both was weighed and rejected: forcing a rule into a table of options made up a choice and costs that the ledger does not hold.

### PD6: A question whose default is deep-review's choice is an item

Every open decision is numbered and counted. The item says that the default is deep-review's choice, so the person sees that nothing is wrong and still sees a decision that is theirs. To leave such a question out of the list and out of the count was weighed and rejected: the list would then say "Nothing needs you" over a decision of direction (principle 4).

### PD7: The meaning of a check is a fact with its source, not advice

The meaning of each check comes from a closed table, and a meaning that rests on the comparison of a worker says so: "by a model's comparison". "No reason to hold the merge" was weighed as a meaning and rejected, since it is advice; the report states the fact and who compared, and one fixed sentence says what the shared case means.

### PD8: The chat shows the top of the brief

The chat shows the title, the first sentence of the account, the status line, "What needs you" and "Before you merge", instead of a short form of its own. The chat and the file cannot then say different things, and a decision is in the chat with its options, its costs, its rules and its command. The chat grows from at most 23 lines today to at most 52, and to about 38 and 43 lines in rewrites of two gate runs. PD1 of the questions in the chat rejected whole question blocks in the short form, since several questions fill the chat; the item of a question is not the whole block, and the brief shows at most three decisions in full.

TD5 of the brief of a run rejected a short form cut out of the Markdown, so that a change of the Markdown would not break the short form. This proposal sets that reason aside: the chat must change when the brief changes, and the coupling that TD5 avoided is the point. It keeps the means of TD5, since the chat form is made from the model by the functions that make the brief, and nothing is cut out of text.

### PD9: The fixes are in the brief, and not in the chat

PD3 of the questions in the chat keeps the fixes out of the short form and out of the brief, as principle 5 puts them in the evidence and a run with 23 fixes would add 23 lines to what the person reads first. It leaves to "Before you merge" (U3) which fixes a person must see before a merge. This proposal puts a table of the fixes at the end of the brief, at most 10 rows and one row for the others, and keeps it out of the chat, which names `report --fixes`. The person who reads the patches before `deep-review commit` then reads how each fixer reports checking its fix beside its subject, which U3 and U7 found at the end of the report. The sentence on the validation that PD6 of the facts before a merge put in the brief becomes the column of the table. This departs from principle 5, which puts the fixes in the evidence; the section "Against the vision note" names it.

### PD10: The report stays English, and the host translates

The workers write English, and so do the code, the commits and the pull request. A report in the language of the person would mix two languages in every block that quotes a worker, and the ledger would hold text that the engine translated. The host already answers in the language of the person, and the skill now tells it to quote ids, paths and commands as they are. The configuration requirements and the brief of a run put the language of the reader out of scope, and the questions in the chat left the short form and the brief in English as a non-goal; this proposal keeps them so. U7 asks to write at least the brief in the language of the person; this proposal rejects that part.

### PD11: The statistics move to `report --stats`

The statistics serve the maintainer and the auditor of deep-review, and the person reads past them (U7). U7 proposes a last section "For the engine". A form of its own is chosen instead: the person never meets the section, and the ledger keeps everything for those who need it.

### PD12: The verdicts and the words of a question keep their names

A design weighed "shown" and "likely" for `CONFIRMED` and `PLAUSIBLE`, and "the option in place" and "recommended" for the default and deep-review's choice. This proposal rejects both. For a design candidate, a verifier decides `PLAUSIBLE` by scope and choice alone (D5 of the verifier rubric), so "likely" would misread it, and the read-only review reports each verdict as the verifier gave it. The brief writes the verdicts in lower case, and says once that a plausible finding is one that the verifier did not confirm. PD6 of the brief of a run chose "in place now" and "deep-review's choice" to say why the two can differ, and the tree does not hold every default, so "the option in place" would be false for a default that no fixer applied.

### PD13: The text of a worker is quoted, with the number added

The renderer quotes a worker as the worker wrote, and adds the number of a finding after an id or an index that names it. Rewriting the text with the new numbers was weighed and rejected: a quote that the renderer changed is no longer what the worker wrote, and the ledger would disagree with the report.

### PD14: No collapsible section

The question block of today puts the rules of the options in a `<details>`. A terminal that shows the file prints the tags, a preview hides the evidence, and a model reads all of it either way; `report --brief` already turns the section into a paragraph (R7 of the questions in the chat), so the file now says what the chat says. The brief and the blocks give the layers instead.

### PD15: The first step renders from the ledger of today

Each requirement here renders from what the ledger records. The facts that need a new record wait for their own proposal, so this change adds no event and no fixture of the ledger, and an older run renders in the new form (R15).

### PD16: One pull request with the proposal and the work

The proposal and the work go in one pull request, as for the facts before a merge.

## Against the vision note

### Principle 1, evidence, not trust

Each block holds the reason and the evidence of the verifier in its words, and each fix lists the validations that its fixer reported, marked as the fixer's report. A meaning of a check that rests on the comparison of a worker says so. Nothing in the brief replaces the evidence: each statement leads to its block.

### Principle 3, rules can be wrong, and a departure is reported

A fix against a written rule is an item of "What needs you" with the rule, where it is written, the fact against it and the two commands.

### Principle 4, deep-review decides; the person answers and writes rules

A question keeps all its parts in its item: the options, the cost of each, the rule that each option makes, and the default, with whether the tree holds it. Why deep-review asks and where it looked are in the block. A question whose default is deep-review's choice stays an item (PD6).

### Principle 5, the core, the questions, and the departures go to the person

The core of the change stays first, in the brief and in the chat (PD1). The questions and the departures are in "What needs you", which the engine computes, so a person who reads only the list knows what to decide. The order departs from this principle in three places. A check that the edits of the run made fail, a check that the change breaks, a check not compared and work that the run did not finish come before the questions, and a fix against a written rule comes before a question (PD3). The first question can then come later than line 20. And the table of the fixes is in the brief, where the principle puts the fixes in the evidence (PD9). The reason of the first two is one order that the engine can test, by what doing nothing costs; the reason of the third is that the person who reads the patches before a commit needs how each was checked. The next note can say if the order of principle 5 is an order of importance or an order of the report, and whether the fixes of a run that leaves them uncommitted belong to what the person must know.

### Principle 6, easy to understand, with little context

The brief uses plain words (R10), names each finding by its number, and puts the evidence one step away: a link in the file, and `report --finding` in the chat. Each item says what happens if the person does nothing.

### Principle 7, nothing waits for a person

No item blocks the run, and the brief says so. Each command names its run, so an answer reaches the run that asked.

### Principle 8, say what was not examined, and when a person must look

"Before you merge" says what the run did not examine, each gap of today, and "What the review covered" gives it in full. The conditions of this principle each have a place: a departure is an item; a fix whose verdict the verifier did not confirm is marked "plausible" in the table of fixes, or in its row of the others, and named among the patches to read first; and a change to a public interface and a change that affects many files are in the account of the change, as deep-review judged them. "Where to look" (R11 of the brief of a run) leaves as a part, and each of its conditions keeps a place in the brief (R1, R2, R5).

### Principle 12, a real run is the gate

R16 makes three real runs and the answers of the hosts the gate.

### How to use this document

The vision note names more text to read as a way to go against a proposal. The report gets shorter. A rewrite of the report of the run of PD10 in this form has about 7,600 words against 8,404, by an estimate: the rewrite has 6,800 words with each refuted candidate in one line, and keeping "Refuted at verification" as it is today (R8) adds about 800. The chat gets longer, since it shows the decisions in full and the meaning of each check, and the brief gets a table of the fixes.

This is a conflict between principles 5 and 6 and that item of the list, as it was for the questions in the chat. This proposal follows principles 5 and 6. With the short form of today, the person or the host opens the report to answer a question, to learn what a check means or to learn how a fix was checked, and the brief now holds those facts in its first screen, with a fixed maximum. The proposal hides no question and no departure, and it makes no question block a run.

## Risks

### A person or a program uses the ids of the engine

A person who saw `RIPPLE-3` in an earlier report, or a script that reads ids, meets numbers. The commands still take the ids, each block names its id, the trailers of the commits keep them, and "About this run" maps them. The JSON form gives both.

### A number names another finding in another run

The numbers are ranks in one run, so finding 3 of one run is not finding 3 of the next. Every printed command names its run.

### `--finding` takes a third kind of value

`snapshot --finding` takes the index of a finding in a batch, from 0, and `answer` and `report` now take a rank, from 1, or an id. A person who mixes them up gets the wrong finding or a refusal. The usage of each command says which it takes.

### The table of needs misses a need

A condition that the table does not hold never reaches "What needs you". "Nothing needs you" names the conditions that it checked, so the person sees what the list covers, and a new condition comes with its own proposal.

### The count grows

Counting a check that the change breaks, the fixes not applied and the uncommitted patches makes "Nothing needs you" rare after a fix run, since a fix run leaves its patches uncommitted until `deep-review commit`. A person may read a long count as alarm. The count line names each condition, its second sentence names the faults of the run that do not hold, and the rank says what comes first.

### A host rewords or cuts the longer chat

A host may summarize 38 to 52 lines, whatever the skill says (PD12 of the brief of a run). Each line keeps its sense alone, and the gate checks what each host shows.

### A program reads the JSON form

Version 5 changes the shape. A program that reads version 4 sees the version change.

### The escaping changes a quote

The renderer escapes a tag, a `__` and a `*` in the text of a worker. A worker who meant them as Markdown loses the format, and the quote still reads the same raw.
