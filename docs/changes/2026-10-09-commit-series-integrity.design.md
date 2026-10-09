# Technical Design: Commit series integrity

Product part: [2026-10-09-commit-series-integrity.requirements.md](2026-10-09-commit-series-integrity.requirements.md).

## Summary

A cluster comes to hold a file in one more way: a claim, made by its
fixer through a new subcommand, `deep-review claim`, before the first
edit of a file no cluster owns. The claim is one file created
exclusively in a directory the engine prepares per run and per round
under the scratch root, where the snapshot manifests already live, so
the command starts no process and runs under every sandbox the snapshot
command runs under. The engine reads the directory when it records any
unit's answer, failed attempt or lost worker, and appends every claim
the ledger does not hold yet, whichever cluster made it, as one new
event kind, `files.claimed@1`, which the fold keeps as
`FixState.claims`. A claim lasts until its cluster settles, and a
settled cluster's file may be claimed again (PD3). Wherever the fix
pass asks "which cluster owns this path", the answer is now "which
cluster holds it, by its plan or by a claim": the files a fixer's task forbids, the violations an answer is
checked for, the paths a refused attempt's revisions take, and the
second round's eligibility. The fixer's prompt gains the claim step and
the quick checks before each snapshot. No existing event changes shape;
`fixes.replanned@1`'s reducer accepts a required file another cluster
claimed as it accepts one another cluster owns, and the golden fixture
`schema-1-09` is committed for the new kind. A check that writes the
tree revises every tracked file it changed, judged against a manifest
taken before it ran, so a generated tree outside the scope is committed
once, at the series' tail (PD9).

## Non-Goals

As the requirements state them. Technically: no change to
`tree.revised@1`, `fix.recorded@1`, `fixes.planned@1` or
`fixes.replanned@1` in shape; no watch on the worktree; no engine-run
check between snapshots; no per-batch worktree; no change to the commit
command or the patch series, which read revisions as before; no change
to the checks phases, which the interrupted-check proposal takes.

## Context

What the change works against, as the code stood at `2163eab`:

- **Ownership is the plan's `files`.** `planFixes` (`src/review/fixes.ts`)
  clusters the fixer-routed findings over the located files of their
  candidates, and a cluster's `files` are what every batch of it owns
  (`ownedFiles` in `src/checkpoint/fix-state.ts`). `othersOwned` in
  `src/review/fix-events.ts` maps every file the other clusters of the
  unit's round own to its cluster (`roundClusters`), and feeds the
  answer's violation check and the attempt's path filter.
- **The task lists both file sets.** `fixerTaskOf` (`src/review/phases.ts`)
  gives `fixerTask` (`src/review/tasks.ts`) the cluster's files and the
  other clusters' files; the task prints "Files you own while this
  batch runs", "Files other clusters own, which you must not edit; a fix
  that needs one is `blocked`, naming it in `requiredFiles`", and "You
  may edit any other file of the repository, existing or new, when a
  fix or its tests need it". `snapshotBlock` quotes the snapshot command
  with `snapshotIndexPlaceholder`, built by `snapshotCommandFor` in
  `src/review/controller.ts` from the engine's entry and the worker's
  scratch.
- **An answer's revisions read snapshots, and the last reads the
  worktree.** `fixAnswerEvents` resolves the answer's paths
  (`resolveFixerAnswer` in `src/review/fix-answer.ts`, violations
  against `othersOwned`), refuses an unreported owned edit
  (`requireOwnedReported`), and builds one revision per finding with
  `revisionsFromSnapshots` (`src/review/tree.ts`) over the owned files
  and every file the answer names; the batch's last finding is read
  from the worktree at that moment, which is how SCAN-3's revision took
  SCAN-4's edit on run `71ae22a2`.
- **A refused attempt's revisions read git's list of changes.**
  `attemptRevisionEvents` takes the unit's owned files plus every path
  its snapshots listed or `changedPaths` reports, less other units'
  owned files, the strays already listed and what git ignores, and
  builds them with `unfinishedRevisions`; its comment names #23.
- **The second round needs owned files.** `planSecondRound`
  (`fixes.ts`) takes a blocked finding only when each of its required
  files is owned by another first-round cluster; `secondRoundOf`
  (`src/review/steps.ts`) calls it when the first round has settled;
  the `fixes.replanned@1` reducer (`fixesReplanned` in
  `src/checkpoint/fix-fold.ts`) refuses a required file "which no other
  first-round cluster owned".
- **The snapshot command's pattern.** `prepareSnapshots`
  (`src/review/snapshot.ts`) writes `manifest.json` under the worker's
  scratch at each editing launch (the controller's `launch` case);
  `takeSnapshot` reads it and starts no process; the `snapshot`
  subcommand in `src/cli.ts` refuses a directory inside the worktree.
  The scratch root is `defaultScratchRoot()` under the system's
  temporary directory, keyed per checkpoint by `checkpointScratchKey`
  (`src/runtime/scratch.ts`), and a Codex editor gets its scratch as
  the one writable root beside the worktree (`confinementOf` in
  `src/runtime/codex.ts`).
- **The fold and the registry.** `FixState` holds `checks`, `plan`,
  `secondRound`, `answers`, `revisions`, `notAttempted` and `commits`;
  every fix kind is version 1 with a reducer in `fix-fold.ts`;
  `reviewVocabularyV4` is the newest frozen vocabulary; the newest
  golden fixture is `schema-1-08`, and `golden.test.ts` names the
  serial after the newest as the one to write next.
- **The prompt guards.** `test/roles/repository.test.ts` pins the
  ownership sentences of `fixer-role.md` and the snapshot sentence of
  `fixer-apply.md` for the three roles that share the fragments.
- **The fakes.** `ScriptEdit` in `test/helpers/fake-runtime.ts` writes
  and deletes files and runs the snapshot command the prompt quotes for
  an index, so a whole fix run is tested without a model.

The evidence this design is measured against, from the two 2026-10-08
runs (requirements, Problem): on `71ae22a2` one unowned file had three
concurrent writers and five more were attributed to a refused attempt
that never wrote them; on `8dbe23ad` one commit of 17 was red inside a
batch. Under claim on first write `71ae22a2`'s second round grows from
seven findings in two batches to nine in three.

## Design

### The claim command and its directory (R1, R2)

`src/review/claims.ts`:

- `claimsDirectoryFor(scratchRoot, checkpoint, runId, round)` is
  `<scratchRoot>/<checkpointScratchKey>/claims/<runId>/round-<n>`,
  beside the workers' scratch directories, never inside the worktree or
  the checkpoint, so Codex's sandbox can write it and a stray can never
  be one of its files.
- `prepareClaims(dir, held, recorded)` creates the directory, writes
  `held.json` (`{ worktree, clusters: { [id]: files }, units: { [key]:
  cluster }, settled: [ids], caseInsensitive }` for the round, `settled`
  the clusters whose every batch has settled by this launch and
  `caseInsensitive` whether the worktree's file system folds case, TD4)
  and seeds a marker for the latest
  recorded claim of each path when none records it yet, at the path's
  next generation; an earlier claim of the path holds nothing, and seeded
  above the holder's marker it would make a settled cluster the holder
  again (2026-10-10, review SCAN-1). It removes nothing. The controller
  calls it at every editing launch of the fixes phase, beside
  `prepareSnapshots`, so a resumed run whose temporary directory was
  cleaned seeds the directory again from the plan and the ledger (R3),
  and so the command learns which holders have settled since the last
  launch.
- `claimFile(dir, path, unit)` is the command's one step: it refuses a
  path that is not repository relative, inside the tree and outside
  `.git` (`validateScopePath`, as the snapshot's `safePath`), answers
  `owned` for a file of the unit's own cluster and refuses one another
  cluster owns naming it, else reads the markers of the path,
  `<dir>/<sha256(path)>.<n>.json` with `{ path, cluster, unit,
  claimedAt }`, `n` counting from 1. The marker with the highest `n` is
  the holder: the unit's own cluster answers `claimed`; a cluster
  `held.json` lists as settled holds nothing any more, and so does no
  marker, and the command creates `<sha256(path)>.<n+1>.json` under the
  `wx` flag; any other cluster refuses naming the holder. Exclusive
  creation is the whole lock: two fixers claiming one path in the same
  instant, or two claiming it after its holder settled, aim at the same
  `n` and get one marker and one refusal.
- `readClaims(dir)` lists the markers with their generations, and
  `claimsOfCluster(dir, id)` those of one cluster, for the engine. A
  directory that is gone makes `claimFile` exit 1 with `the claims
  directory <dir> is gone: stop editing and answer` on stderr (R2,
  R12), and makes `readClaims` throw `ClaimsDirectoryLostError`, which
  the controller turns into the stop below.
- A marker that is empty or not yet whole JSON is one a sibling created
  under `wx` and is still writing. Its name already says the path's hash
  and its generation, so `claimFile`, which looks a path's markers up by
  that name, refuses the path as held by a cluster not yet known,
  `othersHeld` counts it as held the same way, and the append of R3
  leaves the marker for the next settle, when it is whole (2026-10-09,
  review F13).

`src/cli.ts` gains `claim --path <path> --unit <key> --in <dir>
[--repo <dir>]`, listed with `snapshot` as run by a fix worker, with
the same path and `--in` checks as `snapshot`; exit 0 for `owned` or
`claimed`, 2 with the holder's cluster on stderr for a refusal, 1
otherwise. `claimCommandFor(engineEntry, unit, into)` in `controller.ts`
quotes it as `node "<entry>" claim --path "<path>" --unit <key> --in
"<dir>"`, with `claimPathPlaceholder` (`<path>`) for the task, the
path quoted as the directory is so that a path with a space stays one
argument (2026-10-09, review F12).

The command never opens the ledger: Codex keeps the git directory
read-only, and the directory it reads is the launch's view of the plan
plus whatever claims have been made since, which is exactly what a
sibling needs to know.

### What a cluster holds (R1, R3, R6)

`fix-state.ts` gains `RecordedClaim` (`{ path, cluster, key, round,
claimedAt }`), `FixState.claims`, and `holdersOf(fix, round)`: a map
from path to `{ cluster, by: 'plan' | 'claim' }` over the round's
clusters' files and its recorded claims, the latest claim of a path
being its holder, and `settledClusters(fix, round)`, the clusters whose
every batch of the round has answered or is not attempted. `othersOwned`
in `fix-events.ts` becomes `othersHeld(state, phase, key, dir)`: the
fold's holders of the round, overlaid by the live markers of the
directory, less the unit's own cluster and less the claims of settled
clusters, whose files are free again (PD3); a running sibling's claim is
in the directory only, and this is the one place the engine reads it
before that sibling settles. `resolveFixerAnswer`'s context field is renamed
`othersHeld`, and the violation rule is unchanged in shape: a named
path another cluster holds is listed in `violations`. `requireOwnedReported`
covers the cluster's claimed files beside its owned ones (decided
2026-10-09, at implementation): a claim says the fixer will edit the
file, so an edit of it the answer leaves out is refused at the answer,
where the retry is told the tree may hold the work, rather than reaching
the phase's end check as drift and blocking the run.

When a unit's outcome is recorded, the engine appends, in the same
append, before the unit's own `fix.recorded@1`, `attempt.failed@5` or
`worker.lost@4` and before its revisions:

- `files.claimed@1` `{ phase: 'fixes', key, cluster, files: [{ path,
  claimedAt }] }` for every marker in the directory the ledger does not
  hold yet, whichever cluster made it, one event per claiming unit, with
  that unit's key and cluster read from the marker and `claimedAt` the
  marker's time; plus, for an answered unit, one entry with
  `claimedAt: null` for each named file nobody holds that the cluster
  never claimed, the late claim of R6, logged as "claimed late". Nothing
  is appended when there is none. (Amended 2026-10-09, review F1: as
  first written, only the settling unit's own cluster's markers were
  appended, so the fold could not check a violation against a claim a
  running sibling had made, since that claim reached the ledger only at
  the sibling's own settle.)

The reducer `filesClaimed` holds: the phase running; the unit a planned
batch of the round and the cluster its own; each path repository
relative, not owned by a cluster of the round, not held by a claim of
another cluster of the round that has not settled, and not claimed by
this cluster already while it holds the path; the entries then join
`FixState.claims`, and a later claim of a path the fold already holds
makes its cluster the holder. Before it builds the events, the engine
filters the markers by the same rules the reducer applies, against the
fold it is about to append to: a marker on a path a cluster of the
round owns, on a path an unsettled other cluster already holds on the
ledger, or from a unit the plan lacks, which is a marker the engine did
not write, is not appended as a claim. Each such marker is logged as
`claim lost: <path> by <unit> to <holder>` and recorded, in the same
append and before the claims, as an entry of `claims.lost@1` `{ phase:
'fixes', unit, cluster, files: [{ path, claimedAt, reason, holder }] }`,
one event per marker-writing unit, `reason` one of `owned`, `held` and
`unplanned` and `holder` the cluster that owns or holds the path, null
for `unplanned`. `unit` and `cluster` are the marker's own strings, not
plan keys, since a marker from a unit the plan lacks is one of the
things recorded; the reducer `claimsLost` holds only that the fixes
phase runs and the list is not empty, and the entries join
`FixState.lostClaims`, which Limitations and `status` read. (Decided
2026-10-09, at implementation: the first draft kept them in the
controller's memory, which a resumed engine does not have.) The path's
edits then fall under the violation rule (R6). A marker can lose this
way only through a spelling the command could not match (TD4) or a file
written outside the engine; a directory that vanishes stops the run
first (R12). (Added 2026-10-09, review F9.) The
`fixRecorded` reducer checks each violation against the paths the other
clusters of the round hold, by their plan's files or by a claim folded
before the answer, which the order above makes every claim made by then;
a violation on a path nobody holds on the ledger is refused as today.

### A lost claims directory (R12)

Added 2026-10-09 (review F5). The engine sees the loss in two places:
`prepareClaims` at a launch, when the round's directory does not exist
though an earlier launch of the round made it, and `readClaims` when a
unit's outcome is recorded. Either sets `claimsLost` on the fixes phase
for the rest of this engine's life, and the planner then behaves as it
does for a drift found mid-phase: `nextStep` launches nothing, awaits
the running units, and once none runs finishes the phase blocked with
`claims-lost`, a new blocker code whose action reads "the claims
directory <dir> was removed while the run was editing; run the command
again, which seeds it from the ledger and retries the units that ran
without it".

A unit that ends after the loss is not answered. Whatever its worker
returned, `record` appends `attempt.failed@5` with the reason "the
claims directory was removed while the unit ran" and `fault:
'environment'`, the field version 5 adds, with the attempt's revisions
(R20) in the same append; `interrupted` in `steps.ts` reads `fault:
'environment'` as it reads `lost`, so the failure exhausts nothing and
the unit blocks rather than degrades. `attempt.failed` goes to version
5 rather than changing in place (decided 2026-10-09, at
implementation): AGENTS.md says a changed payload shape is a new
version, never an edit of the old schema, and the 2026-10-08 decision
permits a new version as readily as an edit; `fault` is required on
version 5, every version before folds to `fault: 'unit'`, and
`schema-1-09` carries the new version. The `claims-lost` code goes the
same way: `phase.finished@5` with `blockerSchemaV5` over a
`reviewVocabularyV5` that adds the code, since `phase.finished@4` takes
the blocker codes frozen by `reviewVocabularyV3`, which a test holds
equal to the vocabulary of today, exactly as `check-unavailable` took
version 3 (TD10). The resumed run re-enters the phase, seeds the directory from
the recorded claims and launches the units afresh, their tasks naming
the findings the failed attempt left edits for, as a retry's task does
today.

### The fixer's task (R8)

`EditingTaskInput` gains `claimCommand`; `fixerTaskOf` passes
`othersHeld` as `[{ cluster, files, by }]`, the held files of every
other cluster of the round from the fold and the live directory at the
launch. `fixerTask` prints, in place of the two ownership lists:

- "Files you own while this batch runs, which no other worker edits",
  the cluster's files and the files it has claimed so far.
- "Files other clusters own or have claimed, which you must not edit; a
  fix that needs one is `blocked`, naming it in `requiredFiles`", each
  line `- <path> (<cluster>, claimed)` or `(<cluster>)`; a settled
  cluster's claims are left out, since those files are free again.
- `claimBlock(command)`: "Before your first edit for a finding, run
  this from the repository root once for each file outside your own
  that the finding and its tests will touch, existing or new, with the
  file's path in place of `<path>`", the command on a line of its own,
  "It claims the file for your cluster until your cluster's last batch
  has finished. Exit 0 means it is yours; exit 2 names the cluster that
  holds it, and the finding that needs it is `blocked` with the file in
  `requiredFiles`, as for a file another cluster owns, with no edit made
  for it. A refusal that comes after you edited leaves the edits in
  place, listed under the finding, with a message that says the change
  is partial. Report every file you edit or create under the finding it
  served."

The checks block's sentence on baseline failures, "A failure that
output does not show is yours, even when an earlier batch's tree
already had it", gains "unless it lies in a file you do not hold, which
is a sibling's work in flight" (F6), since under concurrency a failure
the baseline did not show may be a sibling's half-made edit.

The repair's task is unchanged: the repair is its phase's only unit and
owns every revised path (TD8 of the fix pass).

### The second round (R4)

`planSecondRound` takes `heldBy: ReadonlyMap<string, readonly string[]>`
in place of the owner map it built from the clusters: `secondRoundOf`
passes, per path, the cluster that owns it or every cluster that claimed
it during the round, since a holder that settled after refusing a
sibling still blocked that sibling (R4). A finding whose required files
were each owned or claimed by a first-round cluster other than its own
is eligible, and its second-round files are its cluster's files, its
cluster's claims and its required files, so a file it claimed in the
first round stays with it. `fixesReplanned` builds the same map and
words its refusal "which no other first-round cluster owned or
claimed". `fixes.replanned@1` keeps its shape. In the second round the
directory is `round-2`, prepared from the second-round plan, and claims
work among its clusters as in the first; `firstRoundBlock` words a file
the first round held by claim as "which c8 had claimed".

### A refused attempt's paths (R5)

`attemptRevisionEvents` builds its paths as the unit's owned files, its
cluster's claimed files, and every candidate path (its snapshots'
listings and `changedPaths`) that `othersHeld` does not name, less the
strays and what git ignores, as today. Its comment is rewritten to say
so, and the #23 link goes. `fixAnswerEvents` is unchanged in its paths:
the owned files and every file the answer names already cover the
cluster's claims, which a fixer names under the finding they served.

### Checks that write (PD9)

Added 2026-10-09 (review F3). `checkRevision` in `fix-events.ts` today
revises only the paths the expected tree holds, so a check that
rewrites a tracked file outside the scope, `dist/` on the two runs,
leaves it changed in the worktree and in no revision. Now:

- Before `runDueCheck` in `controller.ts` starts a check, it writes a
  manifest of the worktree's tracked files, size and time, through
  `prepareSnapshots`' manifest writer into the run's own scratch
  (`<scratchBase>/<runId>/checks/<phase>-<kind>`, under the run so two
  runs on one checkpoint never share one), never the worktree.
- After the check, `checkRevision(context, phase, kind, command,
  manifest)` revises the union of the expected tree's paths and the
  tracked paths whose size or time differ from the manifest
  (`changedSince` over the manifest's `files` alone, so a file new since
  the check is not listed), freezing them as today; the before state of
  a path the expected tree does not hold is the head's, as a fixer's is.
  A tracked file the user changed before the run and the check left
  alone is not listed, since it did not change during the check.
- The revision's message is unchanged, `chore: apply the <kind> check's
  rewrite`; the report's Changed files shows the check as the source,
  and the commit command commits the revision in ledger order, after
  the phase's fix revisions, which puts the rebuilt `dist/` at the
  series' tail. A file over `freezeLimitBytes` is frozen by hash and
  size as today, and the commit command refuses it as today
  (`commit.ts`), naming the file.
- Limitations gains "Generated path kept by a fixer: <path> in <unit>'s
  revision of <finding>" for each path of a fix revision that a later
  check revision of the same run rewrites, which is how the engine tells
  a kept generator output from a fix.

### The message follows the files (R11)

Added 2026-10-09 (review F4). `checkFixerAnswer` in `schemas.ts` drops
its two status rules, "applied and has no commit message" and "blocked
or deferred and has a commit message", and the #26 comment with them,
for one: a finding with files and no message, or with a message and no
files, is refused naming the index, whatever its status; the subject
rules stay. The comment on `message` in `fixerOutputSchema` says the
message goes with the files. `revisionMessage` in `fix-events.ts` keeps
its composed subject for a revision whose findings carry no message,
which after this one case of an answer still reaches: a finding whose
`files` is empty but whose snapshot differs in a file another finding of
the batch named, so its revision holds an edit it did not report; the
comment says so in place of its #9 link. A refused attempt's revisions
compose their own message and never pass through it. R20 of the fix pass gains a pointer at its sentence on
the already-applied finding's message, which this rule now covers.

### The report, status and the log

`changedFilesSection` (`src/review/fix-report.ts`) gains a column, "Held
by": the cluster that owns the path, `c8 (claimed)` for a claimed one,
and "nobody" for a path only a check or a late claim touched. The
Limitations lines of `fixLimitations` name a violation's holder as
"owned by c2" or "claimed by c2", add "Claimed late: <path> by
<unit>, edited before it was claimed" for each late claim, and add
"Claim lost: <path> by <unit> to <cluster>", or "which no batch of the
round has" for an unplanned unit, for each entry of `FixState.lostClaims`
(F9). `status` prints `Claims: N by M clusters, L late, K lost` for a
fix run and carries the claims and the lost claims in `--json`. The
controller logs `worker fixer fixes:c8-1: claimed 2 files` with the
answer, and the late and lost claims by name, all read from the events
it appends.

### The runtime (R2)

The neutral invocation (`src/runtime/contract.ts`) gains `shared:
string | undefined`, a directory outside the worktree and the scratch
that an editor may write and other editors of the run share; `invocationFor`
sets it for a fixes-phase unit to the round's claims directory, and the
launcher refuses it for a read-only worker as it refuses a scratch. The
Claude adapter needs nothing: its editor has no sandbox. `confinementOf`
in `codex.ts` adds it to `writableRoots` beside the scratch under
`workspace-write`; under `danger-full-access` it means nothing, as the
scratch means nothing there.

### Prompt fragments (R7, R9)

Three text commits, each recording the roles' hashes in Verification:

1. `fixer-role.md`: the ownership paragraph gains, after "You may also
   edit any file of the repository that no cluster owns", the claim
   rule: your first edit of such a file claims it for your cluster
   until your cluster's last batch has finished, through the command
   your task gives, and a file another cluster has claimed is as one it
   owns: never touch it, report the finding blocked and name the file.
2. `fixer-apply.md`: the "Snapshot after each finding" paragraph gains
   the quick checks: before each snapshot, run the checks your task
   gives that finish quickly, such as a typecheck and a lint, on what
   the finding touched, and correct within the finding what they show,
   since each snapshot becomes a commit the repository must accept on
   its own; the full suite stays at the end; and a failure in a file
   you do not hold is a sibling's work in flight, not yours, to leave
   and read past, with the lint scoped to the files you changed where
   the tool allows (R7, F6). The same paragraph says
   that a generator's output is not the fix: restore what a build, an
   install or a test rewrote before the snapshot, report a generated
   file only when changing it is the fix, and run a tool that writes
   over the files you hold, never over the whole tree (R7, PD9). A new
   paragraph before it, "Claim before the first edit for a finding",
   says to claim every file outside your own that the finding and its
   tests will need before editing anything for it, that a refused claim
   blocks the finding with no edits, and that a refusal after edits
   leaves them listed under the finding with a message that says the
   change is partial (R1).
3. `fixer-report.md`: the `message` field's line becomes: for every
   finding that names files, its commit message, whatever its status, a
   blocked or deferred one saying the change is partial and what it
   waits for; null for a finding that names no file (R11). The
   `answerFields` text in `tasks.ts` says the same, in the same commit
   as the engine change below, since it is task text and not a
   fragment.

The `documentation` and `answer` roles change with the fragments and
stay unrun. The guard tests in `test/roles/repository.test.ts` pin the
new sentences.

### Events and the golden fixture

`files.claimed@1` is a new kind with a strict schema (`phase` the
`fixes` literal, `key` a batch key, `cluster` a cluster id, `files` one
to 2000 entries of a repository-relative path and an ISO time or null,
no path twice), and `claims.lost@1` a second (`phase` the `fixes`
literal, `unit` and `cluster` as the marker spelled them, `files` one
to 2000 entries of a path, a time or null, a reason and a holder that is
null exactly for `unplanned`). No existing kind changes shape:
`attempt.failed@5` adds `fault` and `phase.finished@5` takes the
blocker codes of `reviewVocabularyV5`, each a new version beside the
old (TD10). The `fixes.replanned@1`
reducer is widened in place: it accepts every history it accepted, and
a ledger with no claims folds as before. The rule followed is
AGENTS.md's: a new kind is a registry change, so the golden test fails
until `schema-1-09` is committed with `npm run golden`, and the eight
older fixtures stay and must fold, with `claims` and `lostClaims` empty
and `fault: 'unit'` on every failure, which is the
proof a newer engine reads an older ledger. The author's decision of
2026-10-08 says the same for this case: new kinds are added freely, the
one compatibility requirement is that the measurement corpus stays
readable, and no kind the corpus holds changes shape here.

## Technical Decisions

- **TD1: A claim is its own event kind, not a field of
  `fix.recorded@1`.** A lost worker has no `fix.recorded`, a refused
  attempt's claims must be recorded with its failure, and a claim made
  by a batch that then fails twice must still hold for the second
  round's planning; one kind appended with whichever outcome the unit
  has serves all three. Changing `fix.recorded@1` in place, which the
  2026-10-08 decision would allow, was rejected for that reason, not
  for compatibility. A fourth reason came with the review of 2026-10-09
  (F1): a running sibling's claim must be on the ledger before an answer
  that violates it, so it is appended with whichever unit settles next,
  under the sibling's own key, which no field of the settling unit's
  event could carry.
- **TD2: The directory lives under the scratch root, per run and per
  round.** Under the checkpoint was rejected: Codex keeps the git
  directory read-only for every worker (PD21 of the fix pass). Under a
  worker's scratch was rejected: siblings must read and write the same
  markers. Per round, because the first round's claims end with it (R21
  of the fix pass) and a second-round fixer must not be refused by a
  first-round marker. Within a round a claim ends when its cluster
  settles (PD3), which the command learns from `held.json`, rewritten at
  every launch; a claim attempted between a holder's settle and the next
  launch is refused as if the holder still ran, a window of seconds,
  and the finding goes to the second round.
- **TD3: Exclusive file creation is the lock.** A lock file, a counter
  or a daemon was rejected: `O_EXCL` is atomic on every file system the
  engine runs on, the marker is the record, and the engine never
  deletes one. The marker's name is the path's SHA-256 and a generation
  number, so a path of any length or spelling makes one file name per
  claim, and a file claimed again after its holder settled gets the next
  generation rather than a deleted or rewritten marker (2026-10-09, F2).
- **TD4: The command compares path strings; the engine resolves.** The
  command cannot ask git (R23 of the fix pass), so it normalizes
  slashes, backslashes included, and `./`, and compares with the
  spelling `held.json` carries, which is the plan's, the worktree's own;
  a Windows spelling thus makes the same marker as the plan's. `held.json`
  also carries `caseInsensitive`, which the engine probes at launch by
  looking the worktree root up with its case changed, and when it is set
  the command compares case-insensitively, reading the `path` inside
  each marker of the directory rather than trusting the hash in its
  name, so `Src/A.ts` and `src/a.ts` meet one marker on such a file
  system (2026-10-09, review F8: the first draft left case to the
  answer, where the fold refuses the second claim, too late to stop the
  concurrent edit the claim exists to stop). (Implemented otherwise on
  2026-10-09: a marker's name hashes the path as the file system
  compares it, lowercased when `held.json` says `caseInsensitive`, so
  two spellings that differ in case aim at one name and the exclusive
  create settles their race by itself; the command never reads another
  marker's path, and a marker whose path does not hash to its name is
  read as one not yet whole. See Verification, Implementation.) A path spelled otherwise
  by a fixer still makes a marker under that spelling; at the answer
  the engine resolves the answer's paths through `resolveReportedPath`
  as today and reads the markers through the same lookup, so one file
  never has two holders through two spellings in the fold. The fold
  refuses a second claim of a path it already holds.
- **TD5: The live directory is read where a running sibling's claim
  matters.** The ledger holds a claim only once some unit settles after
  it was made (R3), so between two settles a violation check or an
  attempt's path filter against the ledger alone would miss a claim by
  a sibling still running. `othersHeld` overlays the markers on the
  fold, and the same markers become the events the settle appends
  first, so what the engine judged by and what the fold checks are one
  set; the fold stays the record and the directory the round's live
  state, as the snapshot directory is the fixer's live state and the
  revisions the record.
- **TD6: The second round's eligibility is widened in the reducer, not
  versioned.** The recorded shape of `fixes.replanned@1` does not
  change, a history without claims folds exactly as before, and a
  history with claims is one only this engine writes. A version 2 would
  freeze a shape identical to version 1.
- **TD7: The quick-checks rule lives in the prompt, not the task.** It
  holds for every fixer whatever the repository, and the task already
  names each check with its command; which of them are quick is the
  fixer's reading of the commands, which the repository prefers to a
  table of fast and slow tools in the engine.
- **TD8: The claims are not a plan.** Recording each claim as it is
  made, by polling the directory between steps, was rejected: the
  controller appends in steps and awaits workers between them, a poll
  is a new kind of step with its own timing to test, and nothing reads
  the ledger's claims before a unit settles (TD5). The directory is
  enough while the round runs. R3 as amended on 2026-10-09 widens what
  each settle records to every marker in the directory, not when the
  directory is read.
- **TD9: No change to `tree.revised@1` or the commit command.** A
  revision's files are the same shape, and the commit command reads
  revisions in ledger order as before; the series is right because the
  revisions are, not because the command knows about claims.
- **TD10: A widened enum is a new version of the kind that carries it.**
  (Added 2026-10-09, at implementation.) `phase.finished@4` takes
  `blockerSchemaV3`, whose code enum is `reviewVocabularyV3`'s frozen
  list, and `test/checkpoint/events-vocabulary.test.ts` holds that list
  equal to `recordedBlockerCodes` of today. Adding `claims-lost` to the
  live list without a new frozen vocabulary would either break that test
  or edit a frozen copy, which is what freezing forbids; so the code
  arrives as `reviewVocabularyV5`, `blockerSchemaV5` and
  `phase.finished@5`, the way `check-unavailable` arrived at version 3,
  and `attempt.failed@5` carries `fault` for the same reason. The
  2026-10-08 decision, that the corpus staying readable is the one
  compatibility rule, is met either way; the version is AGENTS.md's
  rule, kept because it costs one schema and keeps every frozen copy
  frozen.

## Test Strategy

- `test/review/claims.test.ts` (new): the directory's name per
  checkpoint, run and round; `prepareClaims` writes `held.json` and
  seeds the latest recorded claim of each path, and no earlier one,
  without removing a marker; `claimFile` answers
  `owned` for the unit's own file, refuses another cluster's owned file
  naming it, creates a marker once, answers `claimed` for the same
  cluster's second call and refuses another cluster's naming the
  holder; two claims of one path in one instant give one marker and one
  refusal (two processes); a claim of a path whose holder `held.json`
  lists as settled creates the next generation and succeeds, and two
  such claims in one instant give one marker and one refusal; a claim
  into a directory that is gone exits 1 with the stop message, and
  `readClaims` of it throws (R12); a path outside the tree, under `.git`
  or with `..` is refused, a backslash spelling makes the same marker as
  the plan's, and with `caseInsensitive` set two spellings of one path
  that differ in case meet one marker while without it they make two
  (TD4); an empty marker and a half-written one refuse a claim as held
  by a cluster not yet known and are left out of the append (F13); the
  command starts no process, with `node:child_process` made to throw as
  the snapshot test does.
- `test/cli.test.ts`: `claim` parses its flags, refuses unknown ones and
  `--in` inside the worktree, exits 0, 2 and 1 as designed, and runs
  from a fixer's shell.
- `test/checkpoint/events-vocabulary.test.ts`: `files.claimed@1`'s
  schema, its caps and the null time; `claims.lost@1`'s schema and its
  null holder exactly for `unplanned`; `attempt.failed@5`'s `fault`
  with its two values, required; `reviewVocabularyV5`'s frozen codes
  equal to today's, `blockerSchemaV5` taking `claims-lost` and
  `blockerSchemaV3` refusing it; `reviewVocabularyV4` unchanged.
- `test/checkpoint/review-fold.test.ts` and `test/review/steps.test.ts`:
  an attempt failed with `fault: 'environment'` does not exhaust its
  unit and blocks the phase as a lost worker does; every existing
  history folds with `fault: 'unit'`.
- `test/checkpoint/fix-fold.test.ts`: claims fold into `FixState.claims`
  and `holdersOf`, lost claims into `FixState.lostClaims` and are refused
  outside a running fixes phase; refusals for a claim before the plan, by a unit the
  plan lacks, under another cluster's name, of a file a cluster of the
  round owns, of a file another cluster claimed, of a file claimed
  twice by one cluster, and in a phase not running; a claim of a file
  another cluster claimed folds once that cluster has settled and makes
  the new cluster the holder, and is refused while it has not; a violation on a
  file another cluster claimed folds when that claim was recorded
  before the answer and is refused when it was not; the second round
  folds when a required file was claimed by another first-round
  cluster, and is refused when it was claimed by the finding's own
  cluster or by nobody; `fixes.replanned@1` histories of the existing
  tests fold unchanged.
- `test/review/fixes.test.ts`: `planSecondRound` with a held map: a
  finding blocked on a claimed file is planned with the file among its
  cluster's, one blocked on a file nobody holds is not, and a cluster's
  first-round claims stay in its second-round files.
- `test/review/fix-events.test.ts`: `othersHeld` overlays live markers
  on the fold; an answer naming a file a running sibling claimed is a
  violation; an answer naming a free unclaimed file records a late
  claim; an attempt's revisions leave out a file a sibling claimed and
  keep a file this cluster claimed; the claims events are built with the
  answer, the failure and the lost worker, every unrecorded marker once,
  a running sibling's under the sibling's own key, and not again at the
  sibling's own settle; a marker on an owned path, on a path an
  unsettled other cluster holds on the ledger, or from a unit the plan
  lacks is left out of the events and reported lost (F9);
  `checkRevision` with a manifest revises a
  tracked file outside the expected tree that the check changed, leaves
  out one the user had changed before the check and the check left
  alone, and lists no file new since the check (PD9).
- `test/review/tasks.test.ts`: the task lists owned and claimed files
  apart, names a sibling's claim with its cluster, quotes the claim
  command on a line of its own with the placeholder, says a refused
  claim blocks the finding, and excepts a file the fixer does not hold
  from the baseline-failure sentence (F6); the repair's task is
  unchanged.
- `test/review/fix-pass.test.ts`, whole runs on the fakes: two clusters
  run at once, the first scripted fixer claims a shared test file and
  edits it, the second is refused, reports its finding blocked on it and
  gets a second round that owns the file, and each revision holds only
  its fixer's edits; a fixer that edits a file a still-running sibling
  claimed, without claiming it, records a violation and completes, the
  sibling's claim reaching the ledger with that answer; a fixer that edits a free file
  without claiming it records a late claim; a refused attempt that
  snapshotted a finding while a sibling edited a file the sibling
  claimed records the sibling's file in no revision of its own; a run
  stopped with claims made and resumed with the directory removed seeds
  it again from the ledger and the retry's claim of its own file is
  `claimed`; a run whose claims directory is removed while two fixers
  run launches nothing more, records both units as failed attempts with
  `fault: 'environment'`, their edits as attempt revisions and no
  `fix.recorded`, finishes the phase blocked with `claims-lost`, and on
  the next run seeds the directory from the ledger, gives both units
  fresh attempts whose tasks name the earlier edits, and completes
  (R12); a cluster claims a shared file, settles, and a cluster
  launched later claims the same file, edits it and completes with no
  second round, each revision holding its own edits; the same change at
  `--concurrency 1` plans no second round at all; the second round
  claims among its own clusters; the report shows "Held by", the late
  claim and the holder of a violation; the fake Codex run gives its
  editors the shared directory as a writable root; a fake build check
  that rewrites a tracked file outside the scope after the fixes gives
  one check revision at the tail, which the commit command commits last,
  and a fake fixer that rewrites that file and restores it before its
  snapshot leaves no revision of it, while one that keeps it is named in
  Limitations once the check rewrites it (PD9); a scripted fixer
  refused a claim after editing answers the finding blocked with its
  files and a partial message, and the revision commits under that
  message, while one refused before editing answers it with no files
  and no message and no revision is made (R11).
- `test/runtime/codex.test.ts`: an editor's `writable_roots` holds the
  scratch and the shared directory, a read-only worker neither;
  `test/runtime/launcher.test.ts`: `shared` refused for a read-only
  worker.
- `test/review/fix-report.test.ts`, `test/review/report.test.ts`,
  `test/review/status.test.ts`: the "Held by" column, the Limitations
  lines, the `Claims:` line and its JSON; the committed report
  snapshots of runs without claims render as before but for the column.
- `test/review/schemas.test.ts`: `checkFixerAnswer` accepts a blocked
  or deferred finding with files and a message, refuses a finding with
  files and no message and one with a message and no files whatever its
  status, and keeps the subject rules; the test that pinned the refusal
  of a message on a blocked finding is inverted.
- `test/roles/repository.test.ts`: the claim sentences in every fixer
  role, the claim-before-the-finding paragraph, the quick-checks
  sentence, the sibling-failure sentence and the generator sentence in
  `fixer-apply.md`, the message
  sentence in `fixer-report.md`, and the old "any file no cluster owns"
  and "null for a deferred or blocked one" sentences gone from wherever
  they were pinned.
- `test/checkpoint/golden.test.ts`: `schema-1-09`, written by the golden
  script with a scripted claim, a refused claim, a late claim and a
  second round on a claimed file; every older fixture folds with
  `claims` empty.
- `test/helpers/fake-runtime.ts`: `ScriptEdit` gains `claims`, paths the
  fake claims through the command its prompt quotes before its writes,
  and the fake Codex editor writes under the shared root.
- R10, the gate, by hand, recorded in Verification.

Commands: `npm run check` and `npm run verify` before each commit;
`npm run golden -- --output test/fixtures/checkpoints/schema-1-09`
once, in the engine commit; `npm run build` in each commit that changes
the engine or a fragment.

## Verification

### Implementation

The element was built in commits `cd6f421` (the claim command) to
`f0c13e6` (the last prompt fragment), on `dfa6614`, the design as
amended for the ledger versions, and `754fdd7`, which added the
second-round task's naming of a claimed file the series had left out;
the rebuild of `dist/` follows them. Each commit passed `npm run
check` on Windows as it was made, on `2163eab`. The series was then
rebased onto `eec946a` (2026-10-10), which brought the suite's guard
against inherited git variables; there `npm run check` passed at the
head, 1741 tests in 254 suites, 1722 passing, 19 skipped as the
platform asks, none failing, and at the first eight code commits of
the series before the per-commit run was stopped by decision: the
series is tested at its head, and looked back over only when the head
fails. Continuous integration runs on the three platforms for the
pushed head.

The roles digest a run configured from the repository's roles pins:

| After | Digest |
|---|---|
| `dfa6614`, before the series | `c5db64a859bd6800f11e35df517d5223e921db30f0279c233a641c74605b1c71` |
| `4e53473`, `fixer-role.md` | `8f2bb7d8004479651c010be6660cbe0cef74b4a91c2494474964fe54a451b6a4` |
| `0a20a48`, `fixer-apply.md` | `b6ad355c8253d43a89dfe2954e3db0e1ceca0ba67bf819cc057d4778580ef78f` |
| `f0c13e6`, `fixer-report.md` | `18060bc439c642a4fa4e2c31e60d53e14045f202084162025370deac8aa12ea0` |

Decided at implementation, 2026-10-09, where the design said less or
otherwise:

- **A marker's name hashes the path as the file system compares it.**
  Lowercased when `held.json` says `caseInsensitive`, so the exclusive
  create settles a case race by name (TD4 as written read the path inside
  each marker instead, which this naming makes unnecessary). A marker is
  whole only when its content parses, its path is one the command
  writes, and that path hashes to the marker's name; any other is held
  by a cluster not yet known (F13), and is never recorded.
- **A marker's `claimedAt` is nullable,** so a late claim on the ledger
  is seeded back into a prepared directory as a marker of its own and
  holds the file there too.
- **The command refuses** a unit whose cluster `held.json` lists as
  settled, since a marker it made would read as one that holds nothing,
  and a run from a subdirectory of the worktree, where a relative path
  would seem to name another file; it takes no `--repo`, since
  `held.json` names the worktree.
- **The settle folds its claim events in memory first** (`settleClaims`
  in `src/review/claim-events.ts`): the violations and the attempt's
  paths are judged against the fold as it will be once the claims are
  appended, which is TD5's one set made literal. A path a sibling's marker
  not yet whole names is kept out of a refused attempt's revisions too.
- **A claims event per unit, unless the order forbids it.** Two markers
  of one path from two units in one settle go into events in the order
  they were made, so the fold takes them as the engine judged them.
- **A continuation does not keep `shared`.** The shared directory is
  not recorded on `worker.launched@1`, which stays as it is, so
  `continuationFields` has nothing to compare it with, and each launch
  takes the directory its invocation names. The engine resumes no fixer
  today; a continuation that needs the directory kept would record it
  first, as a new version of that event.
- **Claude Code's editor gets no `--add-dir` for the claims
  directory.** Only the quoted commands write there, run by its shell,
  and its file tools need no write in it.
- **The report's Held by** names a late claim's cluster as `c1 (claimed
  late)` rather than `nobody`, since the fold holds the file for that
  cluster; `nobody` is left for a path no cluster held, round by round.
- **The Limitations line for a fixer's path a later check rewrote**
  reads "Rewritten by a later check: <path>, in <unit>'s revision of
  <finding>, by the <kind> check in <phase>; a generated file the fixer
  kept, or a fix the check reformatted", since a formatter's rewrite of
  a fix looks the same on the ledger as a kept generator output.
- **The check's manifest** lists tracked files only and is written to
  `<scratch>/<checkpoint>/<runId>/checks/<phase>-<kind>`; a tracked file
  absent before the check and present after is listed as changed.
- **A lost claims directory and attribution.** A claim made after the
  last settle is lost with the directory (R12), so a unit settling first
  may take a sibling's edit of a file whose claim was lost into its
  attempt's after-the-last-snapshot revision. Accepted with R12; the
  test of the case orders the settles.

### The gate

The gate of R10 is filled in this form:

| | `71ae22a2`, parallel | `8dbe23ad`, one at a time | The gate |
|---|---|---|---|
| Concurrency in the fix pass | 4 | 1 | 4 |
| Engine commits, green alone | 13 of 23 | 16 of 17 | |
| Commits holding another cluster's edit (pass: 0) | 10 of 23 | 0 of 17 | |
| Red commits inside one batch (pass: each explained) | 0 of 23 | 1 of 17 | |
| Fixer workers | 14 | 13 | |
| Claims made, refused, late | | | |
| Second round | 7 findings, 2 batches | 6 findings, 2 batches | |
| Left blocked by a second-round refusal | 0 | 0 | |
| Fixes phase, wall seconds | 3905 | 5964 | |
| The run: workers, USD | 48, 37.86 | 47, 32.34 | |

The gate passes when the first of the two added rows is zero and every
commit of the second has its cause named (R10, F10); the first row is
read from the ledger, each revision's paths against what its cluster
owned, claimed or claimed late at that point. The per-commit check
checks out each commit detached in turn and runs
`npm run check` there, which writes nothing, as the decision step's
commits were checked after 2026-10-08's incident, and runs
`npm run verify` on the series' last commit, which the build check's
tail revision makes current (PD9); nothing is rebuilt by hand, and it is
never run under `git rebase --exec` (#27).

## Risks & Migration

- A run configured before this change and still active resumes only
  with `--roles <old dir>`, since the fixer fragments change the roles
  digest; its fix pass then runs without claims, as its task and plan
  were made.
- A ledger written before this change folds with `claims` and
  `lostClaims` empty and its second round as recorded; nothing is
  migrated. The measurement corpus under `projects\gate\replay` holds no
  `files.claimed` or `claims.lost` and folds as before, which the golden
  test and the corpus check in Verification show.
- The claims directory is under the system's temporary directory, as
  the scratch is; a cleaning mid-round stops the run with `claims-lost`
  once the engine sees it, the units then running are recorded as
  failed attempts whose edits are kept, and the next run seeds the
  directory from the ledger and retries them (R12). `attempt.failed@5`
  carries `fault` and `phase.finished@5` the `claims-lost` code, both in
  `schema-1-09` (TD10); every older ledger folds with `fault: 'unit'`
  and no `claims-lost`.
- `othersHeld` reads the live directory at the answer and the launch;
  a claim made by a sibling between a unit's launch and its answer is
  not in that unit's task, which is why the fixer runs the command
  rather than trusting the list. A holder that settles between two
  launches is still in `held.json` as unsettled until the next launch
  rewrites it, so a claim of its file in that window is refused and the
  finding goes to the second round (TD2).
- Two spellings of one path that differ in more than slashes or case
  (TD4) make two markers until the engine resolves them at the answer;
  the fold refuses the second claim, the violation rule then applies,
  and the report names it. Slashes are normalized by the command and
  case is compared as the worktree's file system compares it, so neither
  makes a second marker.
- The quick checks run inside the fixer's session, so the time they
  take is the fixer's wall time and the budget counts it; the gate
  measures the fixes phase against both earlier runs.
- The Codex Windows unelevated sandbox refuses a Node process a piped
  child; the command starts none, as the snapshot command starts none,
  which the no-process test holds.
- A check revision now covers tracked files outside the expected tree
  (PD9), so a run whose baseline build finds `dist/` stale makes that
  rebuild the series' first commit, and the drift check of every later
  phase covers those files too; a user who edits a generated file during
  the run is blocked by drift where before the edit went unseen. A
  generated file over the freeze limit cannot be committed by the
  command and is named for the operator. A check that creates new
  tracked files cannot exist, since a new file is untracked until added;
  such output stays a stray, listed and not committed.
