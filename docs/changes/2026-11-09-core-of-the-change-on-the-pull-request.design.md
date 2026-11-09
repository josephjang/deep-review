# Technical Design: The core of the change in the review on a pull request

Product part: [2026-11-09-core-of-the-change-on-the-pull-request.requirements.md](2026-11-09-core-of-the-change-on-the-pull-request.requirements.md).

## Summary

A run that explains its review is configured at a new version, `review.configured@12`, whose payload is version 11's; the version alone says that its writer answers in a third form. The writer's answer of version 3 keeps every part of version 2 and gains two: `core`, the core of the change with the sources of its reason, and `conditions`, one sentence for each condition of principle 8 that the triage judged to hold. The engine checks each new part on its own, holding each source of the reason to the change's commits and files, and records the explanation at `explanation.recorded@3`, whose dropped parts can name the two. The writer's task gains the commit messages of the change, read as the triage's are. The form opens the body with the core, from the writer's answer or, without one, from the triage's account in the brief; lists the reasons to look in what needs a person; and moves what the review did not examine up to follow it. A run configured before the change is posted in the new form with the triage's account.

## Non-Goals

### No change to the triage, the brief or the report on the machine

`triageTask`, `changeOutputSchema`, `normalizeTriageChange` and `candidates.recorded@2` stay as they are, and so do `Brief`, `briefOf`, `accountPart` and the report. The form reads the triage's account and its conditions from `view.brief.change`, as it reads the brief's gaps today.

### No change to the placement of a finding, the cleaning or the cuts

`placeFindings`, the Speaker and its cleaning, the markers and `bodyCuts` stay. The core and what needs a person are never cut, as what needs a person is not today, and no new cut is added (NG7 of the requirements).

### No change to the other workers

The finders, the verifiers, merge-rank and the decider, with their prompts, tasks and schemas, stay as they are.

## Context

### The body today

`renderBody` (`src/review/pull-request-form.ts:861`) joins `headingSection`, `summarySection`, `needsSection`, `howSection`, `areasSection`, `inFullSection`, `minorSection`, `leftSection`, `notExaminedSection`, `trustSection` and `lastSection`, in that order. `needsSection` (626) lists each question and each departure, then the answer command with the flags of the kinds it listed, or `words.needsNothing`. `trustSection` (818) writes `words.modelLine` when `postsWriterText` says the body posts a text of the writer, and a note for each part the explanation dropped. The words come from `pullRequestWords(language)` in `src/review/pull-request-words.ts`, one table for English and one for Korean, which a test holds to the same keys and types.

### The writer's answer and its versions

`writerOutputSchemaFor` (`src/review/schemas.ts`) gives version 2, `writerOutputSchemaV2`, in a run whose state has `reportForm`, which the fold sets for a run configured at `review.configured@11`, and version 1 otherwise. `answerVersionOf` in `src/review/explanation.ts` mirrors it. `checkAnswer` checks each part and returns a `CheckedPart` for each; `mergeAnswers` keeps each part from the first answer that passed it, the conclusion and the areas from one answer; `explanationRecord` freezes the merged answer in the evidence store and returns `explanation.recorded` at version 1 or 2, whose `dropped` names the parts of `reviewVocabularyV11.explanationParts` or `reviewVocabularyV12.explanationParts`. The fold (`recordExplanation` in `src/checkpoint/review-fold.ts`) holds the event's version to the run's configuration.

### The triage's account

The triage's answer carries `change` (`changeOutputSchema`), normalized by `normalizeTriageChange` into a `ChangeReading`: `title`, `what`, `why`, `whyFrom`, `restsOn`, and `publicInterface` and `wideEffect`, each `{ holds, what, files }`. The brief folds it into `BriefChange`, whose `state` is `given`, `none` (the triage gave none) or `unrecorded` (an engine before the account ran the triage). `accountPart` in `src/review/brief.ts` renders it for the report. The writer's task already includes the brief in its report form, so the writer reads the account today.

### The commit messages

`commitMessagesSection` in `src/review/tasks.ts` turns `ChangeMessages`, read once per command by `changeMessages` in `src/review/controller.ts`, into the fenced subjects and whole messages of the change's commits, within 16 KiB of subjects and 32 KiB in all, with each commit named by its first 12 characters. `taskFor` in `src/review/phases.ts` passes them to the triage alone.

## Design

### The configuration, version 12 (TD1)

`reviewConfiguredV12` is `reviewConfiguredV11`, as version 11 is version 10. The controller writes version 12 where it writes 11 today, for a run that explains its review, and its log line names the language for both. The fold's reducer for version 12 calls `explainedConfiguration` with `reportForm: true` and a new flag, `coreForm: true`; the reducers of versions 10 and 11 give `coreForm: false`. `ReviewState` gains `coreForm`. Every rule that reads `reportForm` today holds for a run at version 12 too, since `reportForm` is set for it.

### The writer's answer, version 3 (R2, R3, R5, R8, TD2)

`writerOutputSchemaV3` is `writerOutputSchemaV2` with two more fields:

| Field | Shape | Bound |
|---|---|---|
| `core.title` | text | 200 characters |
| `core.what` | text | 4,000 characters |
| `core.why` | text or null | 2,000 characters |
| `core.whyFrom` | list of text, each a commit id or a path | 20 entries of 200 characters |
| `core.diagram` | Mermaid text or null | 8,000 characters |
| `conditions[].condition` | `public-interface` or `wide-effect` | 2 entries |
| `conditions[].explanation` | text or null | 1,000 characters |
| `conditions[].unexplained` | text or null | 1,000 characters |

The bounds are those of the schema, which a model must not break or the whole answer is refused; they are not limits the writer is asked to fill. `writerOutputSchemaFor` and `answerVersionOf` give version 3 for a state with `coreForm`, 2 for one with `reportForm` alone, and 1 otherwise. `recordedAnswerSchemaV3` freezes it, and `RecordedAnswer` gains `core` and `conditions`, null for an answer of an earlier version or a part that was dropped.

### The checks of the two parts (R3, R5, R8, TD3, TD6)

`checkCore` returns the failures of the core:

- the title or `what` is blank;
- `why` is blank but not null, or is null while `whyFrom` names a source, or is given with no source;
- a source is neither a commit of the change nor a file of the change. A commit is named by 7 to 40 hexadecimal characters that begin the id of exactly one commit in `base..head` of the scope. A file is the path of a file of `scope.files`, as the scope captured it;
- a text or the diagram holds a verdict word, as `verdictFailures` finds them;
- a text or the diagram names the id of a candidate of the run, found with the boundaries of an id that `src/review/finding-names.ts` uses;
- the diagram fails `diagramFailures`.

`checkConditions` returns the failures of the conditions against the conditions the triage judged to hold, from `briefOf(state).change`: none when its state is not `given`. It fails an entry for a condition that the triage did not judge to hold, a second entry for one condition, a held condition with no entry, an entry with both or neither of `explanation` and `unexplained`, a blank text, and a verdict word.

`AnswerCheckInput` gains what the two checks need: the ids of the change's commits, the paths of its files, the ids of the run's candidates and the conditions held. `checkedAnswers` reads the commit ids with git in the worktree from the scope's base and head, as `gitLineCounts` reads the line counts of the cited files there, so a check of a resumed run sees the same commits.

### The merge and the record (TD2)

`mergeAnswers` at version 3 keeps the core from the first answer that passed it, and the conditions likewise, each on its own: neither is paired with the conclusion and the areas, since the summary does not name them. A part that no answer passed is dropped with the failures of the latest answer that gave it, as every part is.

`reviewVocabularyV14` freezes `explanationParts: ['conclusion', 'areas', 'refuted', 'finding', 'core', 'conditions']` and `changeConditions: ['public-interface', 'wide-effect']`. `explanationRecordedV3` has version 2's fields, with `dropped` named by that vocabulary, and its refinement drops the conclusion, the areas, the refuted lines, the core and the conditions of an explanation that has no answer. The registry gains `'explanation.recorded': { 3: ... }` and `'review.configured': { 12: ... }`. `recordExplanation` holds version 3 to a run with `coreForm`, version 2 to one with `reportForm` and not `coreForm`, and version 1 to the others, and `recordedAnswerOf` reads the frozen answer by the event's version.

### The writer's task and prompt (R2, R3, R8, PD4, TD7)

For an answer of version 3, `writerTask` adds, after the brief:

- a section "The commit messages of the change", which is `commitMessagesSection` of the same `ChangeMessages` the triage was given. `taskFor` in `src/review/phases.ts` passes `context.commitMessages()` to the explanation phase of a run with `coreForm`, as it does to the triage, and `WriterTaskInput` gains it;
- a line that the triage's account in the brief is deep-review's earlier reading, not verified, to start from and to correct against the code, never to copy;
- the conditions to explain: each that the triage judged to hold, with its sentence and its files, and that `conditions` gets one entry for each and for no other; or, for a run whose triage gave no account, that `conditions` is empty;
- in the return line, `core` and `conditions` beside the four parts of version 2.

`roles/fragments/writer-explanation.md` gains the part **The core of the change**: who reads it, which is a reader who knows the craft and neither the repository nor the change; what `title`, `what`, `why`, `whyFrom` and `diagram` hold; that `what` is written from the patch and the code and says nothing the code does not show; that each name of the code or of the change is explained where it first appears or left out, and that the names the findings' titles use are introduced here; that `why` restates or quotes the commit messages and the documents the change adds or edits, and names each commit by its id as the task lists it and each document by its path, or is null when the change states no reason; and that the core names no finding or candidate and says nothing of what the review found. It gains the part **The conditions**: one or two sentences of what part of the change is the public interface and who reads or calls it, or which files its effect reaches and how, from the code; and, when the code does not show what the triage judged, a sentence in `unexplained` that says what the writer found instead. The paragraph "You give no account of the pull request" goes. `roles/fragments/writer-brief.md` says that the prompt carries the commit messages, and still neither the title nor the description of the pull request. Each prompt change is a commit of its own.

### The order of the body (R1, R9)

`renderBody` joins `headingSection`, `coreSection`, `summarySection`, `needsSection`, `notExaminedSection`, `howSection`, `areasSection`, `inFullSection`, `minorSection`, `leftSection`, `trustSection` and `lastSection`, in that order.

### The core (R1, R3, R4, R10, R11, TD4, TD5)

`formViewOf` gives the view a core of one of three kinds: `writer`, the core of a recorded answer of version 3 that kept it; `triage`, the brief's `change` when its state is `given` and the writer gave no core; or `none`, with the state `none` or `unrecorded`.

`coreSection` writes `words.coreHeading`, then:

- for `writer`: the title in bold; the paragraphs of `what`; `why` after `words.coreWhy`, followed by its sources, each a link, or `words.coreNoReason` when `why` is null; the diagram, fenced; and `words.coreWhoseWriter`;
- for `triage`: the title in bold; `what`; the reason as `accountPart` gives it, with `words.coreWhyTriage`, or `words.coreNoReason`; and `words.coreWhoseTriage`, which says that it is the account of deep-review's triage, written before the review, in the triage's words, and that no verifier examined it. A source of the triage's reason is linked when it resolves as a source of the writer's would, and is a code span otherwise;
- for `none`: `words.coreNone(state)`, which says that deep-review has no account of the change and why.

Each text of a worker goes through the Speaker, as every worker text does, so its places and secrets are cleaned and its ids of findings named. A commit source links to `https://<host>/<owner>/<repository>/commit/<id>` with the full id of the commit it names; a file source links to the file at the reviewed head with `blobUrl`'s form and no line anchor, or at the merge base for a file the change removed.

### What needs a person (R6, R7, R8)

`needsSection` builds the questions and the departures as today, then the reasons to look:

- for each condition the brief's `change` holds, in the order public interface, wide effect: `words.lookInterface` or `words.lookWide`, then the writer's sentence for it; or, with an `unexplained` sentence, `words.lookUnexplained` with the writer's sentence and the triage's; or, with no sentence of the writer's, `words.lookInTriageWords` with the triage's sentence, or the label alone when the triage gave none; then `words.lookFiles` with the triage's files, each linked at the head;
- when any finding whose status is `planned` or `planned-against-rule` has the verdict `PLAUSIBLE`: one item, `words.lookPlausible` with `words.findingList` of their numbers, each linked by `hrefOf`.

With questions or departures, the section lists them, then the answer command as today, then, when a reason to look holds, `words.needsLookAlso` and the reasons. With reasons to look alone, it writes `words.needsLookOnly` and the reasons, and no command. With neither, it writes `words.needsNothing` when the brief's `change` is `given`, which now also says that no fix rests on a `PLAUSIBLE` verdict and that, in deep-review's judgment, the change alters no public interface and affects no file beyond its own; and `words.needsNothingUnjudged` otherwise, which says the same of the questions, the departures and the verdicts, and that deep-review has no judgment of a public interface or of a wide effect for this run.

### The trust section

`postsWriterText` also returns true when the body posts the writer's core or a sentence of a condition, so `words.modelLine` is written exactly when a text of the writer is posted. `trustSection` adds `words.coreDropped` when the run's explanation dropped the core, and `words.coreBeforeWriter` when the run's writer answered at version 1 or 2, so a reader learns why the review opens with the triage's account.

### The words (R11, RK8)

Both tables gain `coreHeading`, `coreWhy`, `coreWhyTriage`, `coreNoReason`, `coreWhoseWriter`, `coreWhoseTriage`, `coreNone`, `needsLookAlso`, `needsLookOnly`, `needsNothingUnjudged`, `lookInterface`, `lookWide`, `lookUnexplained`, `lookInTriageWords`, `lookFiles`, `lookPlausible`, `coreDropped` and `coreBeforeWriter`, and `needsNothing` changes. Each is a label or a fixed line, or a function that takes worker text or a list of links; none puts a word after an interpolated number, so the Korean table needs no particle chosen by how a number is read. The reasons to look are written as a label and a colon before the list, as "PLAUSIBLE 판정에 기대는 수정: 지적 사항 2, 7".

### An older run (R12)

A run configured at version 10 or 11 has no `coreForm`, so its writer answered without a core and the view's core is `triage` or `none`. Its reasons to look come from its brief's `change`, with no sentence of the writer's, so each condition is `words.lookInTriageWords`. The account of an answer of version 1, which the writer wrote for a folded section, is not posted, as the review that reads as a report decided for every older run.

### The README

The list "The body of the review holds, in this order" in `README.md` gains the core as its second item, adds the reasons to look to what needs a person, and moves what the review did not examine to follow it; the paragraph on what the writer decides and what the engine checks names the core, its sources and the conditions.

### The golden fixture

The change adds `review.configured@12`, `explanation.recorded@3` and a vocabulary version, so a fixture `schema-1-21` is committed with `npm run golden -- --output test/fixtures/checkpoints/schema-1-21`, and the older fixtures still open and fold. `scripts/golden-checkpoint.ts` gains a run configured at version 12 whose triage records an account with both conditions held, and whose explanation at version 3 keeps a core with a commit and a file as its sources and one condition explained, and drops the other part, `conditions`, with its failures; `test/checkpoint/golden.test.ts` holds what that run folds to.

### Where the code goes

`src/checkpoint/events.ts` for the configuration, the vocabulary and the event; `src/checkpoint/review-fold.ts` for `coreForm` and the record of version 3; `src/review/schemas.ts` for the writer's schema; `src/review/explanation.ts` for the version, the checks, the merge, the record and the task; `src/review/phases.ts` and `src/review/controller.ts` for the commit messages and the configuration; `src/review/pull-request-form.ts` and `src/review/pull-request-words.ts` for the body; `roles/fragments/writer-explanation.md` and `roles/fragments/writer-brief.md` for the prompts; `scripts/golden-checkpoint.ts` and the fixture; `README.md`; and `dist/` rebuilt in the last commit of the series. The change appends new versions of events and changes what a resumed run's writer is asked, so `npm run test:contract` runs before the commits that change the ledger and the writer's phase.

## Technical Decisions

### TD1: A configuration version says that the writer gives the core

The shape of the writer's answer must be fixed when the run is configured, so that a run resumed by a later engine keeps the answer it was configured for, as [TD1 and TD2 of the review that reads as a report](2026-11-04-review-that-reads-as-a-report.design.md#td1-the-verifiers-reasons-are-fields-of-a-new-version-of-its-answer) fixed version 2 with `review.configured@11`. A new version with version 11's payload says it at no cost of a new field. The design rejects reading the shape from the version of the engine, which a resume changes, and a setting, which a person could set to the old shape and so keep the core off the review.

### TD2: The core and the conditions are two parts of the answer

Each part of the writer's answer is kept or dropped alone, so a failure of one costs no other. The core goes into neither the conclusion, whose failure would drop it with the summary, nor the areas. The conditions are one part and not one part per condition: there are at most two, the writer gives them together, and a dropped part falls back to the triage's sentence for each, which is the same result as dropping each alone. `explanation.recorded@3` is needed because `dropped` names its parts from a closed vocabulary, which version 2 cannot extend (AGENTS.md: a changed payload shape is a new version).

### TD3: The engine reads the change's commits with git at check time

The check of a source needs the ids of the change's commits. The ledger does not hold them; the scope holds its base and head, which the run pins. Reading `base..head` with git in the worktree, as the check of a cited line reads the file at its commit, gives the same list in the first attempt and after a resume, and costs no event. The design rejects recording the commits in a new event of the scope, which would change the capture for one check. A prefix of 7 characters is the shortest that git shows by default, and the triage's and the writer's tasks show 12, so a prefix that names two commits of the change is refused rather than guessed.

### TD4: A commit links to its permalink in the repository of the pull request

A commit is linked as `/commit/<id>` in the repository that `blobUrl` links files in, with the full id, so no later push moves it ([TD4 of the review that reads as a report](2026-11-04-review-that-reads-as-a-report.design.md#td4-every-link-is-a-permalink)). The design rejects `/pull/<number>/commits/<id>`, which ties the link to the pull request's page and adds nothing a reader needs. Whether GitHub shows the commit of a head in a fork under the repository of the base is an open question below.

### TD5: The fallback reads the brief

The form already builds the brief for its gaps. The triage's account and its conditions are `brief.change`, so the fallback and the reasons to look read them there, with no second reading of the ledger and the same normalization that the report shows.

### TD6: An id in the core fails it, rather than being named

The finding names in the review turn an id in a worker's text into "finding 3". In the core, an id means the writer described the review, which R5 does not permit, so the check refuses it and the retry is told why, instead of the form rewriting it into a reference to a finding that the reader has not met yet.

### TD7: The writer gets the commit messages the triage got

`changeMessages` is read once per command from git at the pinned head, and given to the triage. Giving the same value to the writer keeps the two workers on the same words of the change and the same limits, and a resumed run reads the same list from the same commits.

## Open Questions

### Does GitHub show a fork's head commit under the repository of the base?

A pull request whose head is in a fork has commits that GitHub serves under the repository of the base, since a pull request's commits are reachable from its ref there. The gate's run of deep-review/click#1, whose head is in a fork, opens each commit link of its core and records whether it resolves.

### Should the report on the machine show the writer's core?

The report shows the triage's account and the post the writer's core (RK5 of the requirements). Showing both in the report, or the writer's in place of the triage's when there is one, would give the person who ran the review what the readers of the pull request read. It is a change of the brief, which this change does not touch (NG1 of the requirements).

### Should a condition's files be listed whole?

The triage names up to 30 files for a condition, and the item lists them all. The gate records how many each run lists (M5), and a later change can fold them past a count.

## Test Strategy

### R1 and R9: The order of the body

A test of `pullRequestForm` holds the order of the sections, with the core second and what the review did not examine right after what needs a person, for a run with a writer's core and for one without, and that a body cut to fit keeps the core whole.

### R2, R3 and R5: The core and its checks

Tests of `checkCore` hold each failure: a blank title or `what`; a blank `why`; a `why` with no source and a null `why` with one; a source that is a commit of the change by a prefix of 7 and of 40 characters, a prefix of 6, a prefix that two commits share, a commit outside the change, a path of the change, and a path that is not; a verdict word in each text and in the diagram; an id of a finding and of a refuted candidate in each text; and a diagram that fails. A test of `checkedAnswers` on a repository with two commits holds that the ids come from `base..head`. A test of `writerTask` holds the commit messages section and the conditions line for a run with an account and for one with none.

### R4, R10, R11 and R12: The core in the body

Tests of `coreSection` hold the writer's core with its links to a commit and to a file at the head and at the base, `coreNoReason`, and `coreWhoseWriter`; the triage's account when the core was dropped and when the run is configured at version 11, with `coreWhoseTriage` and the trust note of each; `coreNone` for an account of state `none` and `unrecorded`; and both in Korean.

### R6, R7 and R8: What needs a person

Tests of `needsSection` hold: questions and departures with reasons to look after the answer command; reasons to look alone with `needsLookOnly` and no command; a condition explained, unexplained with both sentences, and in the triage's words, with its files linked; one item for several `PLAUSIBLE` fixes, a departure among them; `needsNothing` for a run whose account holds no condition, and `needsNothingUnjudged` for one with no account. A test of `checkConditions` holds an entry for a condition not held, a missing and a repeated one, and an entry with both and with neither sentence.

### The ledger

Tests of the fold hold `explanation.recorded@3` to a run configured at version 12 and refuse it in one at 11, refuse version 2 in a run at 12, and hold the refinement of version 3 for an explanation with no answer. Tests of `mergeAnswers` hold the core and the conditions kept from different answers and dropped alone. The golden test holds the fixture `schema-1-21`, and every older fixture still opens and folds. `npm run test:contract` runs with the change.

### R13: The gate

The gate runs as R13 of the requirements says, and the Verification section records each run, each metric and each reading.

## Verification

### Implementation

The work is in pull request #132, after the proposal. It came in units, each a commit that passes typecheck and lint alone: the ledger (`review.configured@12`, `reviewVocabularyV14`, `explanation.recorded@3`, `coreForm` in the fold, `writerOutputSchemaV3` and the reading of its frozen answer, and the golden fixture `schema-1-21`), which no engine configured yet; the writer's answer of version 3 (`checkCore`, `checkConditions`, the merge of the two parts each on its own, the commits read with git for the check, the writer's task with the commit messages and the conditions held), with a read-only run of a pull request now configured at version 12; the writer's role prompt; the body with what the review did not examine moved up; the core of the change in the body, with its words in both tables, the trust notes and the commit ids that `publish` reads for the links; the reasons to look in what needs a person, with the new sentences of nothing that needs a person; a test that a body cut to fit keeps the core; the README; the changes below; and the build of `dist/`.

### Changes of the proposal during the work

The form takes the full ids of the change's commits as an input, `commits` of `PullRequestFormInput`, which `publish` reads with git from the run's base to its head in the worktree it runs in, as the check of the core reads them (TD3). The design linked a commit by its full id (TD4) and did not say where the form, which reads nothing itself, takes that id from. A history that git cannot read when `publish` runs costs the links, never the post: the body then names a commit source as code, with no link. A replay of the decider, which renders the form with no answer of the writer, passes none.

When git cannot read the commits of the change at check time, `checkCore` fails a commit source with a sentence that says so and asks for the files of the change that state the reason instead, and the writer's retry is told why; a core that fails again gives way to the triage's account, as any dropped core does. TD3 read the commits with git and said nothing of a failure. Stopping the explanation on it would hold the run for a gap that the triage meets the same way: `changeMessages` gives the triage no commit messages when git cannot read them, and the run goes on (principle 11).

The notes of how far to trust the review, `coreDropped` and `coreBeforeWriter`, take whether the review opens with the triage's account, since a run whose triage gave none opens with no account and its note must not say otherwise. A file that a condition names is linked when it is a path of the repository that the cleaning leaves as it is, and is code otherwise, so no link carries a local path. The check that the core names no id of the run reads its every text, its code spans, paths and URLs included, since the core names no finding anywhere. `checkConditions` and the writer's task read the conditions from the triage's account in the fold, which the brief's `change` is built from.

### Checks

At the head of the work, `npm run check` passed (3777 tests: 3764 passed, 0 failed, 13 skipped, against 3721 passed before the work), `npm run verify` passed, and `npm run test:contract` passed 109 of 109, at the commit that configures a read-only run of a pull request at version 12 and again at the head. Every commit of the series passed `npm run typecheck` and `npm run lint` alone. `npm run golden` wrote the fixture `schema-1-21`, and every older fixture still opens and folds. `npm run build` changed the engine bundle of each artifact and its hash, and the two role prompt fragments of the writer, so the digest of the roles changes, and a run configured before this change and resumed after it is refused with the action to name the old roles directory (RK6 of the requirements).

### The gate (R13)

The gate ran once, on 2026-11-09, by the engine built from the commit "chore(dist): Rebuild the engine for the core of the change" (bundle hash `f9f16eaa`), with Node 26.12.1 on Linux, Claude Code 2.1.319 (`opus` and `sonnet`) and Codex 0.167.0. Each of the four runs had its own fresh clone, ran `review --pr` read-only with the defaults of the run's configuration, and was printed with `publish --dry-run`. The four runs started at once; none stopped or met a usage limit, so none was resumed. The dry runs, the reports, the checkpoints, the reading sheets and the reader's answers are kept by the author outside the repository; the numbers below are theirs. After the gate, the author had the review of the first run posted on this pull request, as [its review](https://github.com/josephjang/deep-review/pull/132#pullrequestreview-5826587536) with 14 comments on lines.

The copy that R13 names is deep-review/deep-review-gate#4, which holds #130's commits from the merge base 5c264af9 to dee57ae4, the commits its posted review reviewed: 10 commits and 22 files, with 4 paths left out by `scope.exclude`, the two engine bundles and their `engine.json`. The review of this pull request covered 13 commits and 31 files from eb3be9f9 to 2298607b, with 114 paths under `dist/**` and `test/fixtures/checkpoints/**` left out. deep-review/click#1 is 1 commit and 4 files from 9dd417f6 to 976ab180, its head in a fork, reviewed in Korean as the repository's `.deep-review/config.toml` sets `review.language = "ko"`.

| | This pull request, Claude Code | Copy of #130, Claude Code | click#1, Korean, Claude Code | This pull request, Codex |
|---|---|---|---|---|
| Run | `e833f2a5` | `b6ecb050` | `e71add5e` | `a2041e24` |
| Spent | 20.51 USD, about 26 min | 13.70 USD, about 24 min | 7.05 USD, about 14 min | no cost reported, about 53 min |
| Findings | 25 (3 major) | 18 (0 major) | 12 (4 major) | 29 (6 major, 3 of them critical) |
| Decisions | 16 fix, 9 leave, 0 ask; 2 departures | 8 fix, 9 leave, 1 ask | 5 fix, 7 leave, 0 ask | 21 fix, 7 leave, 1 ask; 2 departures |
| Explanation | `explanation.recorded@3`, nothing dropped | @3, nothing dropped | @3, nothing dropped | @3, all 27 parts dropped |
| Writer | 186.6 s, 1.28 USD | 91.8 s, 0.85 USD | 108.2 s, 0.70 USD | two attempts, 216.5 s and 222.6 s, both failed |
| Body | 38,848 characters, nothing cut | 36,240, nothing cut | 19,569, nothing cut | 28,767, nothing cut |

On Claude Code, each writer's core and conditions passed the engine's checks at the first attempt, and each body opens with the writer's core, under the line of R4. On Codex, both attempts of the writer failed with "Codex used mcp_tool_call, which the worker is not given" (#99), every part was dropped, and the body opens with the triage's account under the line that it is the triage's, as R10 and RK7 intend. Two verifier answers on Codex and one in the review of click#1 were refused by the structural check of a cited run; the retry passed in click#1, and on Codex the group failed twice, so the verification degraded and 6 findings have no verifier. No earlier writer of the same change exists to compare M5 with: the writer of #130's posted review failed on Codex, and the other changes had no earlier run.

M5, what the change adds to the review. The core is 5,820 characters of 38,848 in the review of this pull request (15.0 percent), 5,746 of 36,240 in the copy of #130 (15.9 percent), 2,100 of 19,569 in click#1 (10.7 percent), and 1,698 of 28,767 for the triage's account on Codex (5.9 percent). The reasons to look are 2,152, 1,859, 991 and 1,971 characters, 5.1 to 6.9 percent of each body. A condition lists 5, 6, 3 and 4 files, which bears on the open question of whether a condition's files are listed whole.

M4, the reasons to look. In every run the triage judged a public interface to hold and a wide effect not to hold, so each body lists one condition and an item of the fixes on a `PLAUSIBLE` verdict, and no body says that nothing needs a person. On Claude Code the writer explained the condition from the code in each run, and none was marked as one it could not explain; on Codex the condition is in the triage's words. The fixes on a `PLAUSIBLE` verdict are 5, 2, 1 and 6. The triage of the copy of #130 did not judge the wide effect that the triage of #130's posted run judged, so the condition the problem statement of the requirements leans on is not listed there, and both its triage and its writer still count the local typecheck cache in the public interface beside the outputs of CI (RK3). On Codex, 3 of the 6 fixes in the item had no verifier, since the verification degraded, and the item's sentence that the verifier did not confirm the claim does not fit them.

The open question of a fork's head. The core of click#1 links its commit as `https://github.com/deep-review/click/commit/976ab1801d4dffdee5113bb548d3aceefeaef278`, whose head branch is in the fork josephjang/click; the page resolves, and so do the two file sources and the condition's three files linked at that commit.

M3, a reader with only the core. Each core, from its heading to the line of R4 and nothing else, was given to a fresh Claude Code session with no other context, which wrote what the change does and why and listed each name it could not follow. Whether each account matches the change is the author's judgment and has not been made. The names the reader could not follow are many in the review of this pull request, which names functions, events and flags of the code such as `renderBody`, `coreSection`, `checkConditions`, `reportForm` and `review.configured@12`, and in the copy of #130, which names the contract test, `inventory-unavailable`, `planStatus` and the posting cap; fewer in click#1, where they are the names of Click's own code; and on Codex, the terms of deep-review that the triage's account uses. The target of no name left unexplained is not met in any run.

M1 and M2, the core against the code and each source against what the core says it states, are the author's reading, and have not been made. A sheet for each run lists each statement of the core and each source of its reason with what the source says, quoted. The worker that ran the gate added a reading of its own, which is not the author's: it found no statement that the code at the reviewed head contradicts, and every source stating what the core says, with four places to look at.

The reviews of this pull request found faults of this change. On Claude Code, two major findings are `CONFIRMED`: the writer's prompt still says that the refuted candidates come last, while the body now posts them after what needs a person; and a file named as a source of the core's reason is posted and linked without the cleaning, which `fileLink` applies to the files of a condition. Fourteen minor findings follow, two of them fixes against a written rule: the sentence that nothing needs a person says the change affects no file beyond its own, which is stronger than the triage's judgment of many files; and a commit named in capitals or by a whole SHA-256 id is refused as no commit. The review on Codex found the uncleaned source link too, as finding 3, critical.

The outcome of the gate is not decided: M1 to M3 wait for the author's reading, and M3 already misses its target of no name left unexplained, so the core as the writer writes it is not yet one that a reader with the least context can follow (principle 6).

