# Technical Design: The documentation step

Product part: [2026-10-23-documentation-step.requirements.md](2026-10-23-documentation-step.requirements.md).

## Summary

The documentation step is a new phase, `documentation`, between `fixes` and `checks`, in which one worker edits the tree. It has one unit, `documentation`, of the `documentation` role. Its worker is alone in the tree, as the repair worker is: it claims nothing, and it can edit any file. When the fixes changed a file and the run budget stopped none of their units, the engine records `documentation.planned@1` with the items of the step. Each document that the `drift` lines of the fixes name is one item, and the search is one more item.

The task lists the items, what each fixer did, the patches of the fixes, and the decisions and the answers. The worker answers with the answer of a fixer, whose ids are the items. Its snapshots become revisions, and `commit` makes one commit of each.

The phase vocabulary gets a version 8 with the new phase, so ten kinds of events get a new version. The engine writes a new version only for an event of the step. `review.configured@7` marks a run with the step, as version 5 marked a run with the decision step. A run configured before it records the phase as skipped.

The fixer prompt tells a fixer to update a document that its own edit made stale, in the same finding. The `documentation` role gets its own prompt. The brief computes the documents left out of date from the plan and the answers. Its headline counts them, a part lists them, the short form of a fix run gets a line, and the JSON form gets version 2.

## Non-Goals

### No change to the claims and the rounds of the fixes

The step runs after the fixes, so it needs no claim, no round and no change of the plan of the fixes. Claims stay a matter of the `fixes` phase (`claimingPhases`).

### No new kind of answer

The worker answers as a fixer does, with the items as its ids, as the repair answers with the kinds of its checks. The proposal adds no answer schema and no reducer of answers.

### No documentation phase in the answer pass

The answer pass keeps its two phases. Its fixer updates the documentation that its edits make stale (R6 of the requirements).

### No rule of the engine for what documentation is

The engine does not decide which file is documentation. The fixers name the documents, and the worker of the step judges the rest. The engine only groups the `drift` lines by the path that they name.

### No second run of an answered step

A step that answered does not run again in its run. A reopen after it can give back only the repair, because the step waits for each unit of the fixes (TD12). The brief counts the `drift` lines of the repair and of an answer pass as left (R7).

## Context

Verified at `eda4e82`.

### The phases and the planner

`phases` in `src/review/vocabulary.ts` lists the eighteen phases. The five of the fix pass, `fixPhases`, are `baseline-checks`, `fixes`, `checks`, `repair` and `repair-checks`. The phases whose workers edit, `editingPhases`, are `fixes`, `repair` and `answer`. The run budget settles a unit of `budgetDegradingPhases`, `fixes` and `repair`, as not attempted instead of a block. Only `fixes` claims files (`claimingPhases`).

`unitsOf` in `src/review/steps.ts` gives the units of a phase: one fixer for each batch of the fixes, one repair unit when a check failed after the fixes, and one fixer for an answer pass. `nextStep` plans the fixes (`plan-fixes`) and the second round (`plan-second-round`) as steps of their own before it launches their units. It degrades a unit that failed twice by `degradationOf`. It settles each unit of a phase of `budgetDegradingPhases` as not attempted when the spend reaches the run budget. Once the last unit of a phase of `editingPhases` settled, it checks the tree once more (`check-worktree` with the moment `end`). `dueCheck` runs the `checks` phase only when the fixes changed the tree.

### The answers of the workers that edit, and their revisions

`fixAnswerEvents` in `src/review/fix-events.ts` records the answer of each unit of `editingPhases`. It appends `fix.recorded` with each finding by its id, then one `tree.revised` for each revision that the snapshots of the worker give. It works for each of these phases through `unitIdsOf`, `ownedFiles` and `isClaimingPhase` of `src/checkpoint/fix-state.ts` and `src/review/vocabulary.ts`. The ids of a repair answer are the kinds of the checks that it repairs. `fixedFindingSchema` in `src/checkpoint/events.ts` permits such an id: a candidate id or a check kind, at most 40 characters.

The reducer `fixRecorded` in `src/checkpoint/fix-fold.ts` refuses an answer whose ids differ from `unitIdsOf`. It marks the answers of the person that a fixer applied, but not for the repair, which answers checks. `ownedFiles` gives the repair each path that the fixes revised (`fixesRevisedPaths`). `stalingPhases` names, for each checks phase, the phases whose revisions make a run of it old.

### The tasks of the workers that edit

`repairTask` in `src/review/tasks.ts` numbers the checks that fail and names the files that the repair owns. It permits each other file, lists what each fixer did, and ends with the checks, the snapshot command and the answer fields of a fixer. `taskFor` in `src/review/phases.ts` gives each phase its task. `invocationFor` gives a unit of `editingPhases` edit access and a scratch directory. It gives a claims directory only in the `fixes` phase.

### The `drift` lines today

Each answer of a fixer holds `drift`: at most 50 lines, each with a file and what is stale (`fixRecordedV1`). `answerLines` in `src/review/fix-report.ts` lists the lines of each answer under "Documentation the fixers say their edits made stale, which nothing in this run updated". Its comment points to issue #29, and nothing else reads the lines.

### The prompts and the policy of the roles

`roles/manifest.json` declares the `documentation` role as the fixer prompt with `fixer-documentation.md` last. The last paragraph of `fixer-documentation.md`, "When assigned documentation reconciliation", is for that role, but each fixer gets it too. `roles/policy.json` names no `documentation` role. `resolvePolicy` in `src/review/policy.ts` refuses a policy that names a role that the review does not run (`reviewRoles` in `src/review/vocabulary.ts`). `outputSchemaOf` in `src/review/schemas.ts` gives a schema to each role of `reviewRoles`.

The fixer prompt says two things about documentation. `fixer-apply.md` asks a fixer to write "any documentation it touches" as the conventions ask. `fixer-documentation.md` asks it to report a stale fact outside its files as `drift`, and it says that `drift` permits no edit outside its files.

### The brief and its forms

`briefOf` in `src/review/brief.ts` computes the brief from the fold. `headlineText` counts the open questions and the departures that no person reviewed. `briefShortForm` gives seven lines, and the command prints the path of the report after them. `briefJsonV1` in `src/review/brief-json.ts` is version 1 of the JSON form.

### The versions of the events and older runs

`src/checkpoint/events.ts` freezes each vocabulary that an event holds. When the answers added two phases, `reviewVocabularyV6` gave nine kinds a new version. The exported types moved to the new versions, so that the controller writes only those (the events of the design of answers).

Resumable runs chose another way for the versions that it added. It writes `worktree.checked@6` only after a write back, and `attempt.failed@7` only for the faults `cut` and `limit`. Each other such event keeps the older version, which an engine before resumable runs reads.

`reviewConfiguredV5` is version 4 unchanged: the version alone says that the run has the decision step.

`configure` in `src/checkpoint/review-fold.ts` records as skipped each phase that the version of the configuration does not know. `pinFix` in `src/checkpoint/fix-fold.ts` makes each phase of `fixPhases` `pending` when a read-only run continues into the fix pass. `fixReopened` makes the phases after the fixes `pending` when the run reopens a fix pass that the run budget stopped. `listRuns` in `src/checkpoint/checkpoint.ts` gives a run that holds an unknown version as unreadable, and each command passes over it.

### The contract test and the golden fixtures

`npm run test:contract` stops a fix run on the fakes at fixed points and checks the contract of resumable runs (`test/review/resumable-runs.contract.ts`). `npm run resume-test` stops it at each point. The golden fixtures go up to `schema-1-14`, and `scripts/golden-checkpoint.ts` writes the next one.

## Design

### The phase (R1, R8, R9)

In `src/review/vocabulary.ts`, `phases` gets `documentation` after `fixes` and before `checks`, so the review has nineteen phases. `fixPhases` gets it, and has six phases. `editingPhases` becomes `fixes`, `documentation`, `repair` and `answer`, in the order of the phases. `budgetDegradingPhases` gets it, so the run budget settles the unit as not attempted (R8).

`claimingPhases` does not change. `reviewRoles` gets `documentation` after `fixer`. The unit key is `documentation`, which `singleUnitKey` gives already.

`roles/policy.json` gets `"documentation": { "tier": "strong", "effort": "high", "budgetUsd": 8, "timeoutMs": 1800000 }`, the values of `fixer` (PD8). `outputSchemaOf('documentation')` is `fixerOutputSchema`.

The planner in `src/review/steps.ts` changes in four places:

| Place | Change |
|---|---|
| `unitsOf('documentation')` | One unit `{ phase: 'documentation', key: 'documentation', role: 'documentation' }` once the plan is recorded, none before. |
| `nextStep` | In the `documentation` phase with no plan: when the run budget left a unit of the fixes not attempted, the phase finishes `degraded` with no unit (TD12). Else the step `plan-documentation` comes when a revision of the fixes exists, or the phase finishes `completed` with no unit. With a plan, the rules of each editing phase launch the unit, degrade it, settle it at the run budget, check the tree at the end and finish the phase. |
| `degradationOf('documentation')` | `unit.unattempted` with the cause `failures`, as for the fixes and the repair. A worker lost with its engine, cut by a kill or stopped at the usage limit blocks, as for each unit. |
| `dueCheck('checks')` | The phase runs when a revision of `fixes` or of `documentation` exists. |

In `src/checkpoint/fix-state.ts`, `stalingPhases` gets `documentation` in each set that holds `fixes`: `checks`, `repair-checks` and `answer-checks`, and `markingPhases` follows. `fixPassRevisedPaths` gives the paths that `fixes` and `documentation` revised. It takes the place of `fixesRevisedPaths` in `ownedFiles('repair')` and in the task of the repair (R9). `ownedFiles('documentation')` gives each path that the fixes revised and the `path` of each item that has one, sorted. `unitIdsOf('documentation', 'documentation')` gives the ids of the items of the recorded plan, and null with no plan or for another key. `budgetStoppedUnits` lists a documentation unit that the run budget left not attempted.

The warning for the unelevated sandbox of Codex in `src/review/controller.ts` names the documentation worker beside the fixers and the repair worker.

### The plan of the step: `documentation.planned@1` (R2, R5)

The record holds the items in order:

```ts
export const documentationPlannedV1 = z.strictObject({
  items: z.array(z.strictObject({
    /** `doc-1` to `doc-n` for the documents, then `search`. */
    id: z.string().regex(/^(doc-[1-9][0-9]*|search)$/),
    /** The path as the first `drift` line wrote it; null for `search`. */
    file: z.string().min(1).max(1000).nullable(),
    /** The repository path that `file` names, read as a reported path; null when the engine refuses it, and for `search`. */
    path: claimedPathSchema.nullable(),
    /** The lines the item holds, each with the batch that reported it; none for `search`. */
    drift: z.array(z.strictObject({ key: unitKeySchema, file: z.string().min(1), what: z.string().min(1) })),
  })).min(1),
}).superRefine(refineDocumentationPlan);
```

`refineDocumentationPlan` holds the ids in order, `doc-1` first, with `search` last. It holds each document item to a file and at least one line, and `search` to no file, no path and no line. No two items have the same `path`. A `path` has the shape of a claimed path (`isClaimablePath`): relative to the repository, inside it and outside `.git`.

`documentationItemsOf(fix, resolve)` in `src/checkpoint/fix-state.ts` computes the items. It reads the `drift` lines of the answer of each batch of the fixes, in the order of `allBatches`. In each answer, it reads the lines in their order. `resolve` reads the path of a line as `resolveReportedPath` in `src/review/fix-answer.ts` reads each path that a worker reports. It gives the path as the worktree writes it, or null when `resolveReportedPath` refuses it. `planPathOf(worktree)` in `src/review/documents.ts` is that resolver.

The function groups the lines by the resolved path. The lines with no resolved path form items by their path, folded as `src/review/grouping.ts` folds the path of an unlocated candidate: `normalizeFileName`, then lower case. An item keeps the path as its first line wrote it, and the resolved path. The items get the ids `doc-1` to `doc-n` in the order of their first line, and `search` comes last.

The planner names the step `plan-documentation` with no items. The controller computes the items and appends the record, because the resolver reads the worktree, as a check of the worktree does.

The plan has no limit of its own. Each answer holds at most 50 `drift` lines, so the count of batches bounds the plan (TD11).

The reducer `documentationPlanned` in `src/checkpoint/fix-fold.ts` takes the plan when the `documentation` phase runs and no plan is recorded. It holds the plan to the ledger in two ways. Each listed line must be a `drift` line of the answer of the batch that it names, with the same file and the same text. Each `drift` line of each answer of the fixes on the ledger must be listed once. Thus a line that a plan does not hold came after the plan, from the repair or an answer pass.

The reducer also refuses a plan while the run budget leaves a unit of the fixes not attempted (TD12). Thus no unit of the fixes runs after a plan, as the reducer of the second round holds it to a settled first round. It refuses a plan with no revision of the fixes too. Two equal lines of one answer are two lines, and the plan lists each once.

The reducer checks that the plan holds the lines, not how it groups them. The reducer of the second round does the same: it checks which findings qualify and does not compute them again. Thus a later engine with another rule of groups reads this plan as it was made. The reducer does not resolve a path again, because the fold reads no worktree. `FixState` gets `documentation: DocumentationPlanned | null`.

### The task of the step (R2, R3, R4, R5)

`documentationTask(input)` in `src/review/tasks.ts` follows the form of `repairTask`. It holds these parts, in this order:

| Part | What it says |
|---|---|
| Head | The count of items, numbered from [0], and the job: bring the documentation in line with the edits of the fix pass, and edit documentation only. |
| Each document item | Its index, its id, its file as the fixers wrote it, its path in the repository or the words that the engine refused the path, and each of its `drift` lines with the batch that reported it. |
| The item `search` | Other documentation that the edits of the fix pass made out of date, which no item above names. |
| What the fixes did | For each finding that a fixer answered: its id, its status, its note, the files of its edits and the subject of its commit. For a finding with a decision: the decision, and for an ask, the option in place or the answer of the person. Then the path of the patch of each revision of the fixes, in order. |
| Ownership | It owns each path that the fixes revised and the resolved path of each named document. It can edit any other file when an item needs it, and it reports each file under the item that it served. |
| Rules | It writes what the code of the tree, a recorded decision or an answer settles, and no behavior that an open question still leaves to the person. It leaves each convention source, which the scope block lists, with the amendment of a rule that a departing fix made. It also leaves each fact that was out of date before this run, and a historical or append-only record as the rules of the repository ask. It changes no code, test or configuration to make a document true. It leaves each path that the patterns of `scope.exclude` match, which this part lists, and names the setting for a stale fact there. |
| Statuses | `applied` for a document brought in line. `already-applied` for one that was correct, with no edits. `deferred` for one that it leaves, with the reason in the note: a choice that nothing settled, a rule, or a path that it cannot edit. No `blocked`: nothing holds a file from the step. `drift` lists each document that the edits of this run made out of date, which it found so at its end and did not bring in line; a fact that was out of date before this run is not drift. |
| End | The checks, the rule of the unelevated sandbox when the run has one, the snapshot command, the answer fields and the scratch rule, as for the repair. Then the warning of `earlierWork` after an earlier attempt. |

The patches let the worker read the edits of the run apart from the reviewed change, as issue #29 asks. A `git diff` mixes the two in a review of the worktree, and in a review of a range with changes that are not committed. Before the launch, the controller renders the patch of each revision of the fixes with `patchSeries` in `src/review/patch.ts`, as it does for the report. It puts each patch in the evidence store, and the task gives their paths.

The patterns of `scope.exclude` come from the scope of the run (`scope.request.exclude`). A run excludes a path because it is not a part of the change, often built output, as `dist/**` in this repository. A search for documentation reaches such a path as easily as any other, so the task names the patterns (PD11).

`taskFor('documentation')` builds the input from the fold and the plan. `answerFields`, `snapshotBlock` and `earlierWork` get the word `item` beside `finding` and `check`.

The task asks for no `blocked` answer, because the engine refuses each one. `checkFixerAnswer` in `src/review/schemas.ts` refuses the status `blocked` in an answer of the step or of the repair, with or without `requiredFiles`. The task says that no item is `blocked`, since the parts of its prompt that it shares with a fixer offer it. Two such answers mark the step not attempted, and each item then counts as left, also an item that the worker brought in line.

`repairTask` asks today for `blocked` when a check needs a file outside the repository, named in `requiredFiles`. The engine refuses that answer in the same way, so a repair that follows its task fails, and after two failures it is not attempted. The task of the repair then asks for `deferred` with the reason, and says that no check is `blocked`, as the task of the step does.

### The answer and its revisions (R5)

The worker returns the output of a fixer, `fixerOutputSchema`. `fixAnswerEvents` records it as for the repair. It appends `fix.recorded@3` with the phase `documentation`, the key `documentation` and the items as its ids. Then it appends `tree.revised@3` for each item that a snapshot sets apart.

`fixRecorded` refuses ids other than the items of the plan. It records no violation, because the step is the one unit of its phase. It marks no answer of a person as applied, as for the repair. `attemptOwner('documentation')` is "the documentation step". A failed attempt keeps its edits as revisions of the attempt, as for each unit that edits (R20 of the fix pass).

### The commits (R5)

`namedFindings` in `src/review/commit.ts` gives a revision of the step its trailer. A document item gets `Deep-review: run <id>, documentation of docs/testing.md`, with the resolved path of the item. The item `search` gets `Deep-review: run <id>, documentation that the search found`. A revision that holds several items names each, joined by commas, as a revision of several findings does. A revision of an unfinished attempt gets the words of `trailer` for an attempt, with "the documentation step" from `attemptOwner`.

The message is the message of the worker, as for a fixer. The commits follow the order of the revisions on the ledger. The step plans after each unit of the fixes (TD12), so its commits come after each commit of the fixes.

### The prompts (R3, R4, R6, PD8)

Two commits change the prompts, as AGENTS.md asks for a move and a change of text.

The first commit moves the last paragraph of `fixer-documentation.md` to a new fragment, `documentation-reconciliation.md`. The manifest lists the new fragment in the `fixer` role right after `fixer-documentation.md`, and last in the `documentation` role. Thus each assembled prompt keeps its bytes, and the move changes no word of a prompt. The text commit of the fixer then drops the fragment from the `fixer` role, which loses the paragraph that was for the other role.

The second commit changes the text:

| Fragment | Change |
|---|---|
| `fixer-documentation.md` | A fact in documentation that the edit of the fixer makes out of date is part of the finding. The fixer brings it in line in the same finding, in its edits and its commit. In the `fixes` phase, a document outside the files of the fixer is a file that the finding needs, and the fixer claims it first. A refused claim for such a document does not block the finding: the fixer makes no edit of it and reports the stale fact in `drift`. The fixer writes only what its fix and its decision settle. It edits a convention source only as its decision says: a fix that departs from a rule amends what states it (R5 of the decision step). It reports each other stale fact of a convention source in `drift`. `drift` stays empty when each such fact is in line. |
| `fixer-apply.md` | The claim rule names the exception for a stale document. |
| `fixer-role.md` | The sentence that tells a fixer to report a finding blocked on a file that another cluster holds names the same exception. |
| `fixer-brief.md` | The sentence "Keep a required edit to a file another cluster owns `blocked`" names the same exception. `drift` is documentation that the change made stale and that the fixer could not bring in line. |
| `fixer-report.md` | `drift` is documentation that the change made stale and that the fixer could not bring in line. |
| `documentation-role.md`, new | The role: one worker after each fix worker returned and before the checks, alone in the tree, which brings the documentation in line with the edits of the fix pass. It answers each item as a fixer answers a finding. |
| `documentation-reconciliation.md` | The rules of R3 and R4 in the words of the task, what each status means, and one `static` validation line for each edited document, with the code that it compared. Also the rules of `fixer-apply.md` that a writer of documents needs, the rule of today for a historical or append-only record, and the sentence that each defer goes to the person. |
| `roles/manifest.json` | The `documentation` role becomes `documentation-role.md`, `fixer-brief.md`, `fixer-report.md` and `documentation-reconciliation.md`. |

The role does not get `fixer-apply.md`, because its claim rule is not for the step. Three of its rules are for the step, so `documentation-reconciliation.md` says them in its own words. The step writes each edit as the convention sources of the file ask, and where they say nothing, as the text around it. It runs the quick checks of its task before each snapshot, because each snapshot becomes a commit. It restores what a build or a test rewrote, because the output of a generator is not an edit of documentation.

The paragraph that moves out of `fixer-documentation.md` holds a fourth rule: the step respects the rules of the repository for a historical or append-only record. The text commit keeps it. The search of the step meets such records, as the dated proposals and the vision note of this repository.

Two sentences of the task of a fixer say what the prompt says, so they change in the same commit. The claim block of `fixerTask` in `src/review/tasks.ts` says that "the finding that needs it is `blocked`". Its part on ownership says that "a fix that needs one is `blocked`". Each names the exception, so the prompt and the task of a fixer state one rule.

The answer pass and the repair use the fixer prompt, so they get the same rule. Their tasks already permit each file, so they make no claim.

### The documents left out of date (R7)

`leftDocumentsOf(review)` in a new module, `src/review/documents.ts`, computes the list from the fold, by file. It takes three kinds of lines:

| Source | Lines that it takes | Reason |
|---|---|---|
| A plan with an answer of the step | Each document item whose status is `deferred` or `blocked`, with its lines and the note of the answer. Each line of the own `drift` of the step, which names each document that the search left. | `left`, with the note, or `found` for an own line. |
| A plan with no answer | Each document item, with its lines. | `not-run`, with the cause from `notAttempted`: the run budget or two failures. |
| Each answer of `fixes`, `repair` or `answer` | Each `drift` line that no item of the plan holds. | `after`, with who reported it, when a plan exists. Else `not-run`: an engine before the step configured the run, the run budget stopped a unit of the fixes, or the fixes changed no file. |

The `file` of the answer for the search is not a document left. The task asks for the first document that the search brought in line there, or `.`, and a `deferred` search can hold edits, as a partial change. Each document that the search leaves is a line of the own `drift` of the step, which the task asks for.

Each entry of the list is `{ file, facts: [{ what, by }], reasons: [{ kind, text }] }`, and the entries are grouped by the folded path. The count of the brief is the number of entries. `by` says who reported the fact in the plain words of the brief: "a fixer", "the documentation step", "the repair" or "the fixer of an answer pass". The brief names no batch (R12 of the brief of a run).

An entry ends when a later answer pass revised its file, and the answer of that pass did not report the file in `drift` (PD10). A later pass is one that opened after each line of the entry, so its task listed the entry. A revision of the repair does not end an entry, because the task of the repair does not list it.

The order comes from the ledger, not from the clock. `fixReopened` keeps on each reopening how many answer passes the run held and whether the repair had answered. A line of the fixes or an item of the plan comes after the last reopening that gave back a unit of the fixes. The answer of the step comes after the last one that gave back a unit of the fixes or the unit of the step. A line of the repair comes after the last one before the repair answered. A reopening of the repair alone therefore does not count again a document that an answer pass brought in line.

`answerTaskOf` in `src/review/phases.ts` gives `fixerTask` the list of `leftDocumentsOf` when the pass opens: each file with its facts. The task asks the fixer to bring a document in line when an answer that it applies settles what the document must say. The fixer names it under the finding of that answer, and it leaves the other documents. When it changes such a file and leaves a fact stale, it reports the fact in `drift`.

Each reason has its plain words:

| Kind | Words |
|---|---|
| `left` | The documentation step left it: the note of the answer. |
| `found` | The documentation step found it out of date at its end. |
| `not-run` | The documentation step did not run: the run budget was reached first, its worker failed twice, an engine before the documentation step configured this run, or the fixes changed no file. |
| `after` | The repair or the fixer of an answer pass reported it after the documentation step. |

### The brief and its forms (R7, R10)

`Brief` gets `documents: readonly BriefDocument[]`, and its headline gets `documents`, the count.

The headline counts the documents beside the questions and the departures. The block below gives an example with a count, and the sentence with nothing to count:

```text
2 things need you: 1 question and 1 document that the edits of the run left out of date.
Nothing needs you: no question is open, no fix that goes against a written rule waits for your review, and the run left no document out of date that it knows of.
```

The clause on documents is for a fix run. A run that only reviews keeps the sentence of today.

The part "Documents left out of date (N)" comes after the departures. One sentence comes first: "The edits of this run made each document below out of date, and the run did not bring it in line. Bring each in line before a merge." One line follows for each document: its file in code, its facts with who reported each, then its reasons.

The short form of a fix run gets a line after the line of the departures: `Documents left out of date: none`, or the count and at most `shownIds` files. It then has eight lines. The short form of a run that only reviews keeps its seven lines.

`briefJsonV2` is version 1 with `headline.documents`, `documents`, and the kind of gap `documentation` in `notCovered`. `briefJsonV1` takes its kinds of gaps from `gapKinds` of `brief.ts` today, so the new kind widens version 1 too. Version 1 thus gets a frozen list of its own kinds. `brief-json.ts` writes version 2 only (TD7).

The paragraph "What deep-review changed" of a fix run gets one sentence on the step. Examples: "The documentation step updated 2 documents and left 1.", "The documentation step found no document out of date." and "The documentation step did not run: its worker failed twice."

"What the review did not cover" gets a gap of the new kind `documentation` when the step did not answer, as in this example:

```text
The documentation step did not run: its worker failed twice. The documents left are in Documents left out of date.
```

The gap of the run budget names the step among the work that the budget stopped.

### The report (R10)

The evidence gets `## Documentation` after `## Fixes`. It says if the step ran. For each item, it gives the status, the note and the files. It also gives the subject of the commit and its patch, the lines that the item took, and the validation. It lists the lines of the own `drift` of the step, and the lines that no item holds, with who reported each.

`answerLines` no longer lists the `drift` lines, and the Fixes section points to the new section. The lines of the tests stay. `fixerTitle('documentation')` is "The documentation step".

### The events and the fold (R1, R11)

`reviewVocabularyV8` holds the nineteen phases, and `editingPhases` with `documentation`. Each new version below has the shape of the version before it, with the wider enum:

| Kind | Today | New |
|---|---|---|
| `phase.started` | 5 | 6 |
| `phase.finished` | 6 | 7 |
| `worktree.checked` | 6 | 7 |
| `attempt.failed` | 7 | 8 |
| `worker.lost` | 5 | 6 |
| `report.written` | 5 | 6 |
| `tree.revised` | 2 | 3 |
| `fix.recorded` | 2 | 3 |
| `unit.unattempted` | 1 | 2 |
| `fix.reopened` | 1 | 2 |

`review.configured@7` is version 6 unchanged, and `documentation.planned@1` is a new kind. The events of the checks keep their versions, because the checks phases do not change. The exported types move to the new versions. The controller writes a new version only for an event that names the `documentation` phase or its unit (TD5).

`configure` gets a flag, true for version 7, and `ReviewState` keeps it as `documentationStep`. A run with no step records `documentation` as skipped. `skipReason` takes the flag too. A run configured before version 7 skips `documentation` because "it was configured before the documentation step existed". A run of version 7 that only reviews skips it because "it was configured without the fix pass".

`pinFix` makes each phase of `fixPhases` `pending`, but `documentation` stays skipped in a run with no step. In a run with the step, `fixReopened` makes `documentation` `pending` at its attempt in two cases: when it makes `fixes` `pending`, and when the reopen lists the unit of the step, which only version 2 can list. `unitUnattempted` takes `documentation` at version 2.

### Older runs and older engines (R11)

A run configured at version 6 or before folds as it does today, with `documentation` skipped. Its brief counts its `drift` lines with the reason `not-run`: an engine before the step configured the run. `report --run` writes its copy in the new form.

An older engine finds `review.configured@7` or another new version, which it cannot read, and passes over the run.

### A stop in the step (R12)

The step appends as each phase that edits does. Its first appends are `phase.started`, the start check, `documentation.planned` and the launch. Then come the end of the worker with its answer and revisions in one append (R6 of resumable runs), the end check and `phase.finished`. A stop between two appends resumes from the ledger. A recorded plan stands, and an unanswered unit launches again, with the warning that the tree can hold its work.

The fake runtime answers the `documentation` role and edits a document. The fixers of the fixture revise a file, so the run of the contract test has the step. One of them reports a `drift` line, so the step has a document item. The fixed points get the worker of the step while it runs and the end of that worker.

### The golden fixture

`scripts/golden-checkpoint.ts` writes a run configured at version 7 with the step: its plan, its answer and a revision. `npm run golden -- --output test/fixtures/checkpoints/schema-1-15` writes the fixture. The fixtures `schema-1-01` to `schema-1-14` stay, and each still opens and folds.

### The skills and the README

The section of the README on the fix pass gets the step: six phases, the place of the step and what it owns. It also gets the rule of R6 for each fixer, and the documents left out of date in the brief.

Three more sentences of the README change. They give the count of the roles of a review, now eighteen, the parts of the brief, and the seven lines of the short form. The skills show the short form as the engine prints it (R17 of the brief of a run). Thus the new line needs no change of the skills. A sentence of a skill that names the phases of the fix pass changes with them.

### The steps of the work

The work follows the order of the design, and each step has its tests:

1. The vocabulary, the events, the fold and the fixture `schema-1-15`.
2. The role, its policy and its output schema.
3. The task of the step.
4. The prompts: the move, then the text.
5. The step in the run: the plan step, the unit, the degradation and the run budget. Also the checks, the files of the repair, the reopen, the trailer and the fakes.
6. The documents left out of date and the brief: the headline, the part, the short form, the JSON form, the sentences and the task of an answer pass.
7. The report.
8. The contract test.
9. The README, the comments and the skills.
10. The self-review, an independent review, the build and the checks.
11. The gate.
12. The record of the verification.

## Technical Decisions

### TD1: A phase of its own, not a unit of `fixes` or of `repair`

The step must run after each unit of the fixes, the second round too, and before the checks. A unit of `fixes` after the second round needs a third round in `roundOf`, the claims and the end check. The step uses none of them. A unit of `repair` comes after the checks, so the checks do not see its edits. The answers chose a phase of their own for the same reasons (TD3 of answers). The phase costs ten versions of events, each a schema over a wider enum, and the frozen vocabularies force each of them.

### TD2: The items are recorded before the worker starts

A later `drift` line must not change the items of an answer that is on the ledger. Such a line can come from the repair or an answer pass. A recorded plan holds them. It also gives the brief and the report the items of a step whose worker failed. The fixes and the second round record their plans in the same way.

### TD3: The answer of a fixer, with the items as its ids

The repair answers with the kinds of its checks as ids, and the step answers with its items. Thus the checks of an answer, its revisions, the snapshots and the commits work as they do. The reducer of answers needs only the ids of the new phase.

### TD4: `review.configured@7` marks a run with the step

Version 5 marked a run with the decision step, with the payload of version 4. The fold must know if a run has the step. It records the phase as skipped for an older run, and it keeps it skipped when the run continues into the fix pass. The version says it with no new field.

### TD5: A new version only for an event of the documentation phase

Each writer writes the new version of its kind only for an event that names the `documentation` phase or its unit. Each other event keeps the version that the engine writes today. Resumable runs did the same for `attempt.failed@7` and `worktree.checked@6`. The append checks each payload against the schema of its version, so an older version with the new phase fails there.

Thus a run configured before this change never holds a new version, also after this engine resumes it. Each engine that reads such a run today still reads it. A run configured with the step is unreadable to an older engine in any case, because of `review.configured@7`.

The rejected way writes the new versions for each event, as the answers did. It makes each older run that this engine resumes unreadable to the engine before, and it gains nothing for a run with the step.

On 2026-10-23, the author chose this way.

### TD6: The documents left out of date are computed, not recorded

The brief is a view of the ledger (TD2 of the brief of a run). The list follows from the plan and the answers, so each command computes the same list from the same ledger. An answer pass or the repair of a reopened fix pass adds `drift` lines, and the next brief counts them.

### TD7: Version 2 of the JSON form

The JSON form is a contract with a version (PD11 of the brief of a run). A new field of the headline, a new list and a new kind of gap change its shape, so the form gets a new version.

### TD8: Documents grouped by the repository path that the fixers named

The engine reads the path of each `drift` line when it records the plan, as it reads each path that a worker reports (`resolveReportedPath`). Thus each owned path is a path of the repository, as the worktree writes it. Two forms of the path of one file give one item.

The rejected way owns the path as the fixer wrote it. The head reader and the worktree reader compare paths literally. `./docs/testing.md` then reads as absent at the head and present in the tree, so each answer of the worker fails. `../x.md` makes `git ls-tree` fail, which stops the engine again at each resume, and the worktree reader reads it outside the worktree.

A path that the engine refuses stays an item with no path. The worker answers it, and the brief counts it as left.

### TD9: The worker owns the files of the fixes and the named documents

The worker is alone in the tree, as the repair worker is. It owns each path that the fixes revised and the resolved path of each item. For the files that it owns, the engine makes sure that it reports each one that it changed. An item with no path gives it no owned file. A file outside them is free, and the worker reports it under its item.

The rejected way owns only the paths that the fixes revised. A named document is then a free file. If the worker does not report its edit of such a file, the edit is a stray, and no commit of the step holds it. On 2026-10-23, the author chose to own the resolved path of each item.

### TD10: The role gets its own fragment, and its rules move before they change

The role prompt of a fixer describes clusters, batches and claims, which the step does not have. The fragment of the step says what the step is. The rules move out of `fixer-documentation.md` first, in a commit of their own, and change in the next commit, as AGENTS.md asks.

### TD11: The plan holds each `drift` line of the fixes, with no limit of its own

A limit on the plan puts a line that came before the plan outside it, beside the lines that came after it. The brief must tell the two apart, so the reducer holds the plan to each `drift` line of the fixes. The answers of the fixers bound the plan: each holds at most 50 lines, one answer for each batch. The task of a run with many lines is long, and the gate on this pull request shows the size of a real one.

### TD12: The step waits for each unit of the fixes, as the second round does

The engine plans the step only once each unit of the fixes settled, none of them because of the run budget. This is the rule of the second round (PD13 of resumable runs). Thus a plan never changes, and no unit of the fixes runs after it. A reopen that gives back units of the fixes makes the step `pending` too, and the step plans after them with each `drift` line.

The run loses nothing by the wait. A unit of the fixes that the run budget stopped means that the spend reached the budget. The budget then stops the step as well.

The rejected way plans the step at once and plans it again after a reopen. It needs a second record and a rule for which plan stands, and the brief must then tell an old item from a new one.

On 2026-10-23, the author chose the wait over a second plan.

## Open Questions

### Does one worker bring the documentation of a large run in line within 30 minutes?

The gate on this pull request shows the time of the step on a large change.

### Do models leave a rule and an older fault as they are?

The prompt tells the worker to leave each convention source and each fact that was out of date before the run. The gate reads each commit of the step.

### How often does R6 send a finding to the second round?

The gate counts the findings of the second round and reads each one that a claim of a document caused.

## Test Strategy

### R1: The place of the step

`test/review/steps.test.ts`: a fix run whose fixes revised a file plans the step after the second round and before the checks. A fix run whose fixes revised nothing finishes the phase with no unit. A run that only reviews skips the phase. `test/checkpoint/review-fold.test.ts`: the phase starts only after `fixes`, and `checks` only after it.

### R2 and R5: The plan, the answer and the commits

`test/checkpoint/fix-state.test.ts`: `documentationItemsOf` groups the lines by the resolved path, and the lines with no resolved path by their folded path. It keeps the path of the first line, numbers the items in order and puts `search` last.

`test/checkpoint/fix-fold.test.ts`: the fold refuses `documentation.planned` in nine cases. These are a plan before the phase runs, a second plan, a plan with no revision of the fixes, and a line of no answer. The others are a `drift` line of the fixes left out, ids out of order, and a `search` with a file. The last are two items with one `path`, and a plan while the run budget leaves a unit of the fixes not attempted. `fix.recorded@3` of the step is refused with ids other than the items.

`test/review/documents.test.ts`, new: `planPathOf` reads `./`, a backslash, another case and an absolute path inside the worktree as the path of the repository. It refuses `../` and a path in `.git`. `test/review/fix-events.test.ts`: an answer of the step with two items and two snapshots gives `fix.recorded@3` and two `tree.revised@3`. An answer, a failed attempt and a lost worker of a step whose items hold such paths own only the resolved paths. `test/review/commit.test.ts`: the trailer of a document item, of `search`, of a revision of two items and of an attempt, and the order of the commits.

### R3 and R4: The task and the prompt of the step

`test/review/tasks.test.ts`: the task lists each item with its lines, and the item `search`. It also lists what each fixer did with the decisions and the answers, and the patches of the fixes. Then come the owned files and the rules, with the patterns of `scope.exclude`. Neither the task of the step nor the task of the repair asks for a `blocked` answer. On the repair, this test fails before the change.

`test/roles/repository.test.ts`: the assembled prompt of the `documentation` role holds its role fragment and its rules, and no claim rule. Its rules include the convention sources, the quick checks before a snapshot, the output of a generator, a historical record and a defer. The role is in the policy, and the policy still refuses `test-assessment`.

### R6: The rule of each fixer

`test/roles/repository.test.ts`: the prompt of the `fixer` role holds the rule for a document that its edit made stale. Each of its sentences on a blocked finding names the exception for a stale document. It permits an edit of a convention source only as the decision says. `test/review/tasks.test.ts`: the claim block and the part on ownership of the task of a fixer name the exception too.

### R7: The documents left out of date

`test/review/documents.test.ts`: each of the five cases of R7, the groups by file, and the reasons of each kind. A later answer pass that revised the file of an entry, with no `drift` line for it, ends the entry. A pass that reported the file in `drift` keeps it, and so does a revision of the repair. `test/review/tasks.test.ts`: the task of an answer pass lists the documents left out of date.

`test/review/brief.test.ts`: the headline with and without documents, and the sentence with nothing to count. It also checks the part, and the line of the short form with its limit of names. A run that only reviews keeps the sentence and the seven lines of today. `test/review/brief-json.test.ts`: the JSON form matches `briefJsonV2`, and `briefJsonV1` still refuses the kind of gap `documentation`.

### R8: The step never blocks the run

`test/review/steps.test.ts`: a worker that fails twice degrades the step, and the run reaches the checks. At the run budget, the unit is not attempted. When the run budget stopped a unit of the fixes, the phase finishes `degraded` with no plan. A worker lost with its engine blocks the phase, and the next run gives it fresh attempts.

`test/review/fix-reopen.test.ts`: a reopen that gives back units of the fixes runs the step after them, with their lines. A reopen that gives back the unit of the step runs it with its plan.

### R9: The checks and the repair

`test/review/steps.test.ts`: `dueCheck('checks')` runs after a revision of the step. `test/checkpoint/fix-state.test.ts`: the repair owns the files of the step, and a revision of the step makes a run of `checks` old.

### R10: The report

`test/review/fix-report.test.ts` and `test/review/report.test.ts`: the section Documentation and the new snapshot `test/fixtures/reports/fix.md`. The author reads the snapshot in the review of the pull request.

### R11: Older runs and older engines

`test/checkpoint/review-fold.test.ts`: a configuration of version 6 records the phase as skipped, and a continuation keeps it skipped. `test/review/fix-pass.test.ts`: a fix run configured at version 6 and resumed by this engine holds no event of a new version. A run with the step holds a new version only for an event of the step. `test/checkpoint/golden.test.ts`: `schema-1-15` opens and folds, and so does each older fixture. `test/review/brief.test.ts`: the brief of a run with no step counts its `drift` lines.

### R12: A stop in the step

`test/review/resumable-runs.contract.ts` with the two new points, and `npm run resume-test` over each point.

### R13: The gate

The gate runs are paid runs, and each waits for the word of the author. The engine of the gate is a copy of `dist/claude` at the head, run from outside the worktree of the gate. The run on this pull request uses `review --runtime claude --branch --fix`. The runs on pallets/click #3878 use the same commit and base as the runs of the report on what a person gets from a run. The author reads the briefs, the commits of the step and the documents. The Verification records the metrics of the requirements.

## Verification

No checks have run yet.

## Risks & Migration

### Ledgers before this change

A run configured at version 6 or before folds as today, with no step. Its brief now counts its `drift` lines as documents left out of date, which is the purpose of R7.

### An older engine and a newer run

An older engine passes over a run that holds a new version. A person who goes back to an older engine cannot continue or answer such a run.

### The digest of the roles changes

The new prompts change the digest of the roles. A run pins the digest that it started with, so after the update it refuses to resume with the new roles. An answer pass on it refuses too, because `controller.ts` and `answer.ts` compare the digests.

The person has three ways out. They finish the run with the engine of before. Or they pass `--roles` with the roles that the run started with, which git keeps under `roles/` at an earlier commit. Or they record an answer with `--record-only` and apply it by hand.

### A program that reads the JSON form

`report --json` gives version 2 only. A program that reads version 1 must read version 2.

### The reports in the evidence store

The reports that older runs wrote stay as they are. `report --run <id>` writes a copy of an older run in the new form.
