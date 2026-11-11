# Technical Design: A model writes the review's sentences, and code shows its facts

Product part: [2026-11-12-review-in-the-writers-words.requirements.md](2026-11-12-review-in-the-writers-words.requirements.md).

## Summary

This design says code, with no article, for the program of deep-review that other documents call the engine, and a templated sentence for one that code builds from facts or a worker's text, as the requirements define both.

A run that explains its review is configured at a new version, `review.configured@13`, whose payload is version 12's; the version alone says that its writer answers in a fourth form. The writer's answer of version 4 keeps the core, the conditions, the areas and the refuted lines of version 3, turns the conclusion into a summary, gives each finding its own text of the decision (one sentence of what deep-review would do, then the fix in full or the question option by option, and why a `PLAUSIBLE` verdict is not confirmed), and gains two parts: a title and a reason for each finding left as is, and what the review did not examine. Code checks each part against the ledger and records the explanation at `explanation.recorded@4`. The form reads an answer of any version into one shape and renders it one way: the writer's text where a part stands, the recorded words of the other workers under a label where it does not, and every fact as data. The table of words that code writes becomes a table of strings, with no entry that takes a number or a text. No plan of the page, no slot and no token is added: the form's view stays the one model of the review, and what changes is how its fields are shown.

## Non-Goals

### NG1: No change to the other workers, the brief or the report on the machine

The tasks, prompts and schemas of the finders, the verifiers, the triage, merge-rank and the decider stay, and so do `Brief`, `briefOf` and the report. The form reads the brief's gaps and the triage's account as it does today.

### NG2: No change to the placement of a finding, the cleaning, the cuts or the record of a publication

`placeFindings`, the Speaker and its cleaning, `bodyCuts` and the order in which they are tried, the markers, `publish.prepared` and `publish.posted` stay. A cut still replaces a folded part with a note, which becomes a fixed notice with a count as a labeled value.

### NG3: No change to how a text names a finding

`namedFindings`, `namedInDiagram` and `FindingNaming` in `src/review/finding-names.ts` stay as [the finding names in the review](2026-11-08-finding-names-in-the-review.md) built them. They apply to the writer's text of version 4 as to every worker's text. `naming` is the one entry of the table of words that keeps functions (TD4).

### NG4: No new unit of the explanation

The explanation stays one unit with one writer (`singleUnitKey('explanation')`), asked again once as a whole, as today. PD9 of the requirements says when that would change.

## Context

### The form today

`renderBody` in `src/review/pull-request-form.ts` joins twelve sections: `headingSection`, `coreSection`, `summarySection`, `needsSection`, `notExaminedSection`, `howSection`, `areasSection`, `inFullSection`, `minorSection`, `leftSection`, `trustSection` and `lastSection`. `commentOf` builds the comment of a finding from `findingParts`, which a finding in full in the body shares. Each reads `FormView`, built once by `formViewOf` from the run's state, the brief, the writer's answer as `recordedAnswerOf` reads it, and the places `publish` computed. Every text that code did not write passes the Speaker (`speakerOf`), which cleans it and names each finding id.

### The words in code today

`PullRequestWords` in `src/review/pull-request-words.ts` has 119 entries, 54 of them functions, and `FollowingWords`, the entries that differ for a run continued into its fix pass, has 8, 6 of them functions. Some functions state facts in a sentence (`summaryCounts`, `howWorked`, `trust`, `minorLead`, `reviewed`, `excluded`). Some wrap a worker's text in a sentence (`needsQuestion`, `recommends`, `wouldDo`, `whyPlausible`, `choice`, `departure`, `rejected`, `refutedItem`, `coreWhy`). Some state a late fact (`standing`, `answeredOption`, `answeredAccept`, `answeredReject`, `predates`, and every entry of `FollowingWords`).

### The recorded words the form posts today

The form posts these texts of other workers through the Speaker: the decider's question, each option and its cost (`questionBlocks`), its grounds for a question and for a finding left as is, its approach and each rejected option with its reason (`decidedFixLines`), a departure's rule, source and fact (`departureLines`), and each settled choice with its source (`choiceBlocks`); a verifier's reason for a `PLAUSIBLE` verdict (`whyPlausible`) and the choice it leaves to the author; the first sentence of merge-rank's summary as the title of a finding the writer did not explain (`titleOf`) and the finder's detail as its problem (`problemParagraphs`); the triage's account and its sentence on each condition (`coreSection`, `reasonsToLook`); and the summary of a refuted candidate. It also posts each gap of the brief, which is no worker's text: `notExaminedOf` in `src/review/brief.ts` builds each as an English sentence from facts of the run, with its plurals and pronouns chosen in code (`notExaminedSection`).

### The writer's answer and its versions

`explanationVersionOf` in `src/checkpoint/review-fold.ts` gives the version of the writer's answer from the run's configuration: 3 for `review.configured@12` (`coreForm`), 2 for version 11 (`reportForm`), 1 for version 10. `writerOutputSchemaFor` in `src/review/schemas.ts` gives the schema of that version, `checkAnswer` in `src/review/explanation.ts` checks each part, `mergeAnswers` keeps each part from the first answer that passed it, with the conclusion and the areas from one answer, and `explanationRecord` freezes the merged answer and returns `explanation.recorded` at that version, whose `dropped` names parts of the vocabulary's `explanationParts`. `recordExplanation` in the fold refuses an event at another version than the configuration asks for. In version 3 the writer gives, for each finding, a `decision` in plain words that the form does not post, and a sentence of what deep-review would do in `conclusion.actions`, which the form posts for a fix and not for a question.

### What is known only when the review is posted

`publish` gives the form four things the writer cannot know. `fixPass` is `continued` when `run.review.continuedFrom` is set (`src/review/publish.ts`), and `followingOf` then swaps eight texts. The answers recorded since: `whyNotAnswerable` in `src/review/answer.ts` takes an answer only on a run that wrote its report, so every answer is later than the explanation. The places: `placeFindings` reads the pull request's files from GitHub again. And the cuts, which `pullRequestForm` chooses from the size of the rendered body. An answer also changes what `findingStatusOf` in `src/review/brief.ts` gives: an answered question becomes planned or left, a rejected departure is no longer a fix against a rule, and `summarySection` counts the fixes, the questions and the findings left by that status. [PD2 of the review of a fix run](2026-11-08-review-of-a-fix-run.requirements.md#pd2-the-posted-review-is-the-ledger-before-the-continuation) makes the posted review the ledger before the continuation, so nothing the fix pass does is in the review beyond the fact that it ran.

## Design

### The configuration, version 13 (TD1)

`reviewConfiguredV13` is `reviewConfiguredV12`. The controller writes version 13 where it writes 12 today. The fold's reducer for version 13 sets `reportForm`, `coreForm` and a new flag of `ReviewState`, `writtenForm`; the reducers of versions 10 to 12 set it false. `ExplanationVersion` gains 4, `explanationVersionOf` gives 4 for `writtenForm`, and `explanationConfiguredAt` names `review.configured@13` for it.

### The writer's answer, version 4 (R2, R3, TD2, TD7)

`writerOutputSchemaV4` is a strict object. The table gives its parts; the lengths of the new texts are first values, which the measure of OQ1 can change before the schema is committed.

| Part | Shape | Against version 3 |
|---|---|---|
| `core` | title, what, why, whyFrom, diagram | The same |
| `conditions` | condition, explanation or unexplained | The same |
| `summary` | one text, to 1500 characters | Replaces `conclusion`: `why` becomes the summary, `actions` move to the findings, `diagram` goes |
| `areas` | title, intro, diagram, findings | The same |
| `findings` | id, and `explanation` or `unexplained` | `explanation` changes as below |
| `left` | for each finding left as is: id, `title` to 200, `why` to 600 | New |
| `refuted` | id, claim, why | The same |
| `notExamined` | one text, to 1500 | New |

A finding's `explanation` keeps `title`, `problem`, `cases`, `diagram`, `checked` and `kind`. Its `decision`, the text of version 1 that the form never posted, goes. It gains `action`, to 400 characters: one sentence of what deep-review would do, or, for a question, what it asks and what it recommends. It gains `unconfirmed`, to 600 or null: why the verifier could not confirm a `PLAUSIBLE` verdict. And it gains exactly one of two objects, the other null. `fix` holds `text`, to 2000, which says what the fix changes, each choice the decision settles and what settled it; and `departure`, to 800 or null, which says for a fix against a written rule the rule in plain words, the fact against it and what the fix does instead. `ask` holds `question`, to 800, which says what is asked and why the repository does not answer it; `options`, up to four entries of `number`, `means` to 400 and `cost` to 400; and `recommendation`, to 600, which says why deep-review recommends its option.

### The checks (R2, R3, PD11, TD7)

`checkAnswer` gains a branch for version 4 that keeps every check of version 3 for the parts that did not change. For a finding it adds: `fix` is given for a finding decided `fix` and `ask` for one decided `ask`, and the other is null; `fix.departure` is given exactly when the decision departs from a rule; `ask.options` holds one entry for each option the decision recorded, numbered from 1, each number once; `unconfirmed` is given exactly when the verdict is `PLAUSIBLE`, a verifier examined it and its verdict records why it is not confirmed; and `action` is given for a question as for a fix. The check of version 3 that the sentence of what deep-review would do is exactly one sentence is not kept (TD8). `checkLeft` holds `left` to one entry for each ranked finding that does not act, by its id, and none other. `summary` and `notExamined` are not blank. Every new text is held to the rules every text of the writer is held to today: no verdict of the review, no id that names no finding of the run. The lengths stay in the schema, where a text that is too long fails the answer before any check, as today (TD7).

### The merge and the record (TD2)

The parts of an answer of version 4 are `core`, `conditions`, `conclusion`, `areas`, one for each finding, `left`, `refuted` and `not-examined`. The summary keeps the part name `conclusion`, so the rule that the conclusion and the areas come from one answer stays as `mergeAnswers` has it. A finding's `action`, which was the conclusion's, is the finding's own, so a failure in it drops that finding's part alone. `reviewVocabularyV15` adds `left` and `not-examined` to `explanationParts`, and `explanationRecordedV4` names its dropped parts from it. `explanationRecord`, `writerContribution` and `droppedExplanation` gain the version.

### The writer's task and prompt (R2, R6, R7, R12, TD6)

`writerTask` gains, for version 4: the counts of the run as lines of data (the `ReviewCounts` the form computes, and the counts of the findings by decision: to fix, to ask and to leave); the findings left as is, listed as the ones to give a title and a reason; the gaps, each as its kind and its facts, which `notExamined` explains; and, for each question, the options numbered as the answer numbers them. Each finding's decision, its settled choices and its verifiers' notes are already in the task (`decisionLines`, `noteLines`). The task is built from the run's state while the explanation runs, which holds no answer and no continuation (TD6), and it gives no place of a finding in the diff.

`roles/fragments/writer-explanation.md` is rewritten for the parts above, and `roles/fragments/writer-brief.md` says that the writer writes every sentence of the review and code shows the facts. The prompt puts being understood first (R14): it tells the writer that a reader with the least context must follow each text at the first read, and that this comes before being short, before the wording of the worker it restates and before a uniform form, while what the text says stays what the evidence and the decision hold. It tells the writer to explain each name where it first appears, to name each option by its number, to say nothing of what happens after the review (an answer, the fix pass, where a finding is shown), to state each decision as deep-review decided it and not as what will happen, to write a count only as its task gives it, and to write no verdict, severity, link or command. "Name a finding by its id" stays (NG3). Both fragments change, so the digest of the roles changes.

### One shape for every version (R10, TD5)

`recordedAnswerOf` reads a frozen answer of any version into one `RecordedAnswer`, as it does today, extended with the parts of version 4, each null when the answer has none. From an answer of version 3 it takes the core, the conditions, the areas, the refuted lines, the summary from `conclusion.why`, and for each finding its title, problem, cases, diagram, `checked` and `kind`, and its `action` from `conclusion.actions` when the finding is a fix; the sentence of a question, which the checks of version 3 did not hold, is not taken. From version 2 it takes the same without the core and the conditions, and from version 1 the findings and the summary. The form has no branch by version.

### The data forms (R1, R5, TD3)

Three small functions of `src/review/markdown.ts` render every fact, and take their labels from the table of words. A labeled value is the label, a colon and the value. A facts line is a run of labeled values, each ended by a period, as "Severity: major. Verdict: CONFIRMED. Checked by: running the code. Decision: fix." A facts table is a table whose header row is labels. A value is a number, code, a link, a list of these after the colon, or the name of a value of a closed list from the table of words. No function takes a sentence, and none puts a word after a value.

### The gaps as facts (R5, R8)

`notExaminedOf` computes the facts of each gap and words them in one step, so the form can post a gap only as the brief's sentence. The design splits it. One function gives each gap as its kind and its facts: the pass, the numbers of the findings and the count of the other candidates, the patterns with their count, the paths, the count of workers. The brief words those facts as it does today, so its text does not change (NG1). The form reads the facts and shows each as a labeled value under the label of its kind, with the writer's text or without it, and posts no sentence of the brief. The kinds that belong to the fix pass do not occur in a posted review, which is the ledger before the continuation.

### The parts of the form (R1 to R8)

The table gives, for each section of the body and for the block of a finding, what is the writer's, what code shows as data, which fixed notices it holds, and what stands in for a part of the writer's that is missing. A fact marked late is one of R6.

| Part | The writer's text | The data code shows | Fixed notices | Without the writer's part |
|---|---|---|---|---|
| Heading | None | Head, merge base, files changed; after the review: no file changed, or the run went on to fix (late) | For a continued run, where its edits are and that the review does not hold them | The same |
| Core | Title, what, why, diagram | The sources of the reason, as links | Whose reading it is | The triage's account, as recorded words, labeled as the triage's |
| Summary | The summary | A table: findings by severity, and by decision, to fix, to ask and to leave, as decided, which no answer changes | What happens next, with the command that fixes as code (late) | The table and the notice |
| What needs a person | For each question, the finding's `action`; for each fix against a rule, its `fix.departure`, which names the rule, the fact against it and what the fix does instead; the sentence of each condition | The finding's number and link; for a question, the option recommended, the one that stands and its status (late); for a departure, its status (late); the files of a condition; the fixes on a `PLAUSIBLE` verdict; when nothing is listed, questions: none, departures: none, conditions: none or not judged | Who answers and how, with the command as code; that nothing waits on a reason to look | The decider's question and the rule, and the triage's sentence, as recorded words |
| Not examined | `notExamined`; the claim and the reason of each refuted candidate | Checks run in the review: none. Each gap as a labeled value of its kind: a review pass that did not run, by its name; the findings and the count of other candidates that no verifier examined; the patterns that left paths out, the count and the layer; each file too large to give to a worker, by its path; the count of workers that a stop ended. The refuted candidates, each with its place | For a continued run, where the checks run | The same data, and each candidate's summary as recorded words |
| How the review worked | None | A table of the run's counts; the fixed diagram | What each role does; what each verdict and severity means | The same |
| Areas | Each area's title, intro and diagram; each finding's title and `action` | The finding's number and link, its verdict, the mark of a fix against a rule; for a question, the option recommended | None | One area under a label; the first sentence of merge-rank's summary and of the decider's approach, as recorded words |
| A finding, in its comment or in full | Title, problem, cases, diagram, `unconfirmed`, `action`, `fix` or `ask`, `checked` | A facts line: severity, verdict, how it was checked, decision, what became of the finding since when an answer changed it (late), and the note on its line (late). For a question: the table of options with the writer's `means` and `cost`, the option recommended, the one that stands, whether it edits, and its status (late). For a fix: the step that settles each choice. The links of the cases. The trace line | The command that answers a question; the commands that accept and reject a departure | The finder's detail, the decider's decision and the verifier's reason, as recorded words, with the mark of R19 of the review on the pull request |
| The record of a finding, folded | None | For a question: each option, its cost and its rule, as recorded. For a departure: the rule and its source. For a fix: the approach and each rejected option. Each choice a verifier left to the author beside the choice that settles it and its source | That these are the words an answer and the fix pass apply | The same, not folded where it stands in for the writer's text |
| Minor findings | Each row's title and `action` | Counts: all, those a user sees, those of the code alone, those on their line (late); the ones that need a person; the table | None | Recorded words in the rows |
| Left as is | Each finding's `title` and `why` | A facts line; the reason of the closed list; the finding that supersedes it; the step that settles each choice; the place; the record, folded | None | The first sentence of merge-rank's summary and the decider's grounds, as recorded words |
| How far to trust | None | Tables of the verdicts and of how the findings were checked; the parts of the explanation that are missing; the findings answered after the explanation (late) | That a model wrote the sentences and the data is the ledger's (R7); that the run has no explanation | The same |
| Last line | None | Engine, runtime, models, run, commits | None | The same |

Recorded words are posted through the Speaker as today, each under a label of the table that names its worker, and a text of the writer's is never joined to one. A cut replaces its part with a fixed notice and the count of what it left out as a labeled value.

### The table of words (R9, TD4)

`PullRequestWords` becomes a record whose every entry is a string, or a record of strings keyed by a closed list (`basisWords`, `leaveReasons`, `layers`, `settleSteps`, and new ones for the decisions, the statuses of a question and of a departure, and the two states after the review). Its entries are the headings, the labels of each fact, the names of each value, and the fixed notices. `FollowingWords` goes: what differs for a continued run is a value of a closed list and three fixed notices. The fixed diagram of how the review worked takes its node texts from the table, and the form adds the pull request's number as a value. `naming` keeps its functions (NG3). The type of the table says all this, so an entry that takes a number or a text does not compile, and the test that holds the two languages to the same keys now holds them to strings.

### The record that an answer applies (R4)

`questionBlocks`, `departureLines`, `decidedFixLines` and `choiceBlocks` give way to one function that builds the folded record of a finding from the decision and the verifiers' notes, as recorded words under labels: each option with its cost and its rule; the rule and the source of a departure; the approach and each rejected option; and, as [PD8 of the settled choice](2026-11-06-choice-settled-on-the-record.requirements.md#pd8-the-verifiers-choice-is-shown-beside-every-settlement) requires, each choice a verifier left to the author beside the settled choice that names its candidate, with its source, or the value that deep-review did not settle it. `keptByCut` still keeps the findings left as is whose verifier named a choice.

`deep-review answer` prints the answer it recorded in `src/command.ts`, today as "finding 3 option 2" through `answerWords`. It gains the recorded text of the option, as `saying` in `src/review/answer.ts` already words an owed answer.

### The replay of the decider

`src/replay/decider.ts` renders the form with no answer of the writer to print what a decided copy of a run would post. It renders the form of this change, with recorded words throughout, and its tests hold the new text.

### The README

The list "The body of the review holds, in this order" and the paragraph on a comment say, for each part, what the writer writes and what code shows as data, and that the record of a decision is folded beside it. The paragraph on what the writer decides and what code checks names the new parts and R7. The section on the language of the review says that a language other than English and Korean has its labels and fixed notices in English.

### The golden fixture

The change adds `review.configured@13`, `explanation.recorded@4` and a vocabulary version, so a fixture `schema-1-22` is committed with `npm run golden -- --output test/fixtures/checkpoints/schema-1-22`, and the older fixtures still open and fold. `scripts/golden-checkpoint.ts` gains a run configured at version 13 whose explanation at version 4 keeps a fix, a question and a finding left as is, and drops `not-examined` with its failures.

### Where the code goes

The first commits move code and change no behavior, since `src/review/explanation.ts` (1256 lines) and `src/review/pull-request-form.ts` (1200 lines) are each past the size at which a file is hard to review: the checks of an answer and the writer's task leave `explanation.ts` for files of their own, and the view (`FormView`, `formViewOf` and the types they read) leaves `pull-request-form.ts`. Then, in order: `src/checkpoint/events.ts` for the configuration, the vocabulary and the event, `src/checkpoint/review-fold.ts` for `writtenForm` and the record of version 4, with the golden fixture; `src/review/schemas.ts` and the checks, the merge and the task for the answer of version 4, with a read-only run of a pull request then configured at version 13; `roles/fragments/` for the prompts; `src/review/markdown.ts`, `src/review/pull-request-form.ts` and `src/review/pull-request-words.ts` for the form and the table of strings; `src/command.ts` for the answer's line; `src/replay/decider.ts`; `README.md`; and `dist/` rebuilt in the last commit of the series. The change appends new versions of events and changes what a resumed run's writer is asked, so `npm run test:contract` runs before the commits that change the ledger and the writer's phase.

## Technical Decisions

### TD1: A configuration version says that the writer answers in the fourth form

The shape of the writer's answer is fixed when the run is configured, so a run resumed by a later engine keeps the answer it was configured for, as [TD1 of the core of the change on the pull request](2026-11-09-core-of-the-change-on-the-pull-request.design.md#td1-a-configuration-version-says-that-the-writer-gives-the-core) fixed version 3. The fold already refuses an explanation at a version its configuration did not ask for, so `explanation.recorded@4` cannot fold without `review.configured@13`.

### TD2: The text of a decision is the finding's own

Version 3 keeps the sentence of what deep-review would do in the conclusion, apart from the finding it speaks of, which is why a fault in one sentence could drop the summary (W7 of the report). In version 4 each finding carries its `action` and its `fix` or `ask`, so the unit that is checked, kept and dropped is the unit a reader reads, and the only parts that depend on each other are still the summary and the areas. The design rejects a part of its own for the decisions, keyed by finding: it would be a second place where a finding can fail.

### TD3: No plan of the page

The report's structure has code build the review as a plan of slots before any text is written (its S2). The design does not build it. `FormView` already gathers every fact of the run once, and the brief already gives the writer's task its account of the run; a plan would be a third model of the same facts, and an answer keyed by its slots would mean what a later engine's plan says (PD2 of the requirements). The parts of the writer's answer are keyed by what the ledger holds, a finding's id, a condition's name, an option's number, which mean the same to every engine. The view moves to a file of its own so that a test can read it without rendering.

### TD4: The table of words is strings, and its type says so

A rule that code writes no sentence of the run would hold in a prompt or in a review only as long as someone remembers it, which is how W3 of the report says a rule of form failed. The type of the table holds it: with no entry that takes an argument, a sentence around a number or a text cannot be written in it. `naming` is the exception, because it builds no sentence of its own: it gives a finding its name inside a worker's own sentence.

### TD5: An older answer is read into the fourth form

The design rejects a renderer for each version of the answer. Each would keep the sentence functions of its time, in both languages, for as long as a run of that version can be posted. Reading an older answer into the one shape costs a mapping in `recordedAnswerOf`, which already does this for versions 1 to 3, and the form then treats a part that an older answer lacks as it treats a part the checks dropped.

### TD6: The task is built from the state of the run as the explanation runs

The writer must not see a late fact (R6). The design needs no filter for that: the explanation runs before the report, an answer is taken only after the report, and a continuation starts after it too, so the state the task is built from holds none of them, and the task has never been given the places of the diff. A test holds the task to a state with an answer and a continuation added, to show that neither changes it.

### TD7: The lengths stay in the schema

A text that is too long fails the whole answer at the schema today, before any part is checked. The design keeps that, since the retry is given the failure and a writer that passes its lengths on the second answer loses nothing. Moving the lengths into the checks of each part would let one long text drop alone, at the cost of a second place where the shape of the answer is defined. The measure of OQ1 sets the lengths so that the largest run on record fits.

### TD8: The checks hold the writer's text to the ledger, not to a style

R14 makes being understood the first aim of the writer's text, and a check that drops a text for its form works against it: a writer that needs a second sentence to say what a fix does would lose the part and the reader would get the decider's words. The checks of version 4 therefore hold a text to what code knows exactly, that it names the findings, the options and the conditions the ledger holds and states no verdict of its own, and to what would break the page, a blank text, a diagram GitHub cannot draw, a cited line that does not exist. The lengths in the schema are bounds that keep one text from filling the page, not targets, and the prompt says so. Whether a text is understood is read by the gate (M4 of the requirements), since code cannot check it.

## Open Questions

### OQ1: Does the answer of version 4 fit one call, on the largest run on record?

The first unit of the work runs a writer with the schema and the prompt of this design on the largest run the author holds, the Korean run that #115 describes, with 32 findings, and records the size of its answer, its time and its cost against the writer's budget of 8 USD and timeout of 30 minutes. If it does not fit with room to spare, the design is amended before the form is built: the restatements (`fix`, `ask`, `left`, `notExamined`) become a second unit of the explanation that reads the ledger alone, which PD9 of the requirements holds back until a run shows the need.

### OQ2: Should a review in English restate the decider's options?

In English the decider's words are already in the language of the review, so the restatement adds a reader's wording and the risk of drift, and no translation. The design restates in every language, since the decider writes for a fixer and not for a reader with little context. R14 of the requirements points the same way: the restatement is for the reader's understanding, not for the language alone. The gate reads the English pairs (M3 of the requirements), and a later change can post the record alone in English if the restatement adds nothing there.

### OQ3: Should the report on the machine carry the writer's text?

The report is for the person who ran the review and is written before nothing else can change, so it could show the writer's summary and decisions too. NG1 of the requirements leaves it as it is. The question is whether two accounts of one run, one in English built by code and one in the writer's language, confuse the person who reads both.

### OQ4: Is `left` one part or one part for each finding?

As one part, a fault in one entry drops the title and the reason of every finding left as is, as one fault drops every refuted line today. One part for each finding is finer and adds a name to the vocabulary for each kind. The design starts with one part, and the gate counts how often it drops.

## Test Strategy

### R1, R5 and R9: The words in code

A test of the two tables holds each entry to a string or a record of strings, and the two languages to the same keys. Tests of the three data forms hold a labeled value, a facts line and a facts table, each with a number, code, a link and a list, and each kind of gap shown as data with the writer's `notExamined` and without it. A test renders one run in English and in Korean and holds that every line of the body and of each comment is the writer's text, a data form, a fixed notice of the table, or recorded words under a label.

### R2 and R3: The answer of version 4 and its checks

Tests of `checkAnswer` at version 4 hold each new failure: `fix` on a question and `ask` on a fix, both and neither; a departure text on a fix that departs from nothing, and none on one that does; an option missing, repeated, numbered 0 or past the last; `unconfirmed` on a `CONFIRMED` verdict and missing on a `PLAUSIBLE` one with a verifier's reason; a blank summary and a blank `notExamined`; an entry of `left` for a finding that acts, and a finding left as is with none; and a verdict word and an unknown id in each new text. A test holds that an `action` of two sentences passes (TD8). Tests of `mergeAnswers` hold a finding's part kept from the first answer and `left` from the second, and the summary taken only with its areas.

### R4: The record

Tests of the folded record hold each option with its cost and rule, the rule and source of a departure, the approach with each rejected option, and each verifier's choice beside its settled choice or the value that none settles it, for a fix and for a finding left as is. A test of the answer command holds the recorded text of the option in its line.

### R6 and R7: Late facts and numbers

A test of `writerTask` holds the task of a run unchanged when an answer and a continuation are added to its state. Tests of the form hold a question's status waiting and answered, a departure's status, the summary's counts by decision unchanged by an answer, what became of an answered finding as a value of its own, the heading and the summary's notice for a continued run, and the note on a finding's line for each state of the diff, all as data. A test holds the fixed notice of R7 present exactly when the review posts a text of the writer.

### R8 and R10: A missing part and an older run

Tests of the form hold, for each part, the recorded words under their label when the part was dropped, and a run with no explanation rendered throughout. Tests of `recordedAnswerOf` hold an answer of each of versions 1, 2 and 3 read into the one shape, a question's sentence of version 3 not taken, and the body of each rendered with no branch by version.

### The ledger

Tests of the fold hold `explanation.recorded@4` to a run configured at version 13 and refuse it at 12, and refuse version 3 in a run at 13. The golden test holds the fixture `schema-1-22`, and every older fixture still opens and folds. `npm run test:contract` runs with the change.

### R13: The gate

The gate runs as R13 of the requirements says, and the Verification section records each run, each metric and each reading.

## Verification

No checks have run yet.
