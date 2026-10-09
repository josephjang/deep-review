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
- **The fold and the registry.** `FixState` holds `plan`, `secondRound`,
  `answers`, `revisions`, `notAttempted` and `commits`; every fix kind
  is version 1 with a reducer in `fix-fold.ts`; `reviewVocabularyV4` is
  the newest frozen vocabulary; the newest golden fixture is
  `schema-1-08`, and `golden.test.ts` names the serial after the newest
  as the one to write next.
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
  cluster }, settled: [ids] }` for the round, `settled` the clusters
  whose every batch has settled by this launch) and seeds one marker per
  recorded claim that has none yet; it removes nothing. The controller
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
  `claimsOfCluster(dir, id)` those of one cluster, for the engine.

`src/cli.ts` gains `claim --path <path> --unit <key> --in <dir>
[--repo <dir>]`, listed with `snapshot` as run by a fix worker, with
the same path and `--in` checks as `snapshot`; exit 0 for `owned` or
`claimed`, 2 with the holder's cluster on stderr for a refusal, 1
otherwise. `claimCommandFor(engineEntry, unit, into)` in `controller.ts`
quotes it as `node "<entry>" claim --path <path> --unit <key> --in
"<dir>"`, with `claimPathPlaceholder` (`<path>`) for the task.

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
path another cluster holds is listed in `violations`.

When a unit's outcome is recorded, the engine appends, in the same
append, before the unit's own `fix.recorded@1`, `attempt.failed@4` or
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
makes its cluster the holder. A claim whose marker names a
cluster the plan does not have is a marker the engine did not write and
is refused by the command's reader before any event is built. The
`fixRecorded` reducer checks each violation against the paths the other
clusters of the round hold, by their plan's files or by a claim folded
before the answer, which the order above makes every claim made by then;
a violation on a path nobody holds on the ledger is refused as today.

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
- `claimBlock(command)`: "Before your first edit of any other file of
  the repository, existing or new, run this from the repository root
  with the file's path in place of `<path>`", the command on a line of
  its own, "It claims the file for your cluster until your cluster's
  last batch has finished. Exit 0 means it is yours; exit 2 names the
  cluster that holds it, and
  the finding that needs it is `blocked` with the file in
  `requiredFiles`, as for a file another cluster owns. Report every
  file you edit or create under the finding it served."

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
  (`<scratchBase>/checks/<phase>-<kind>`), never the worktree.
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

### The report, status and the log

`changedFilesSection` (`src/review/fix-report.ts`) gains a column, "Held
by": the cluster that owns the path, `c8 (claimed)` for a claimed one,
and "nobody" for a path only a check or a late claim touched. The
Limitations lines of `fixLimitations` name a violation's holder as
"owned by c2" or "claimed by c2", and add "Claimed late: <path> by
<unit>, edited before it was claimed" for each late claim. `status`
prints `Claims: N by M clusters, L late` for a fix run and carries the
claims in `--json`. The controller logs `worker fixer fixes:c8-1:
claimed 2 files` with the answer, and the late claims by name.

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

Two text commits, each recording the roles' hashes in Verification:

1. `fixer-role.md`: the ownership paragraph gains, after "You may also
   edit any file of the repository that no cluster owns", the claim
   rule: your first edit of such a file claims it for your cluster for
   the rest of the round, through the command your task gives, and a
   file another cluster has claimed is as one it owns: never touch it,
   report the finding blocked and name the file.
2. `fixer-apply.md`: the "Snapshot after each finding" paragraph gains
   the quick checks: before each snapshot, run the checks your task
   gives that finish quickly, such as a typecheck and a lint, on what
   the finding touched, and correct within the finding what they show,
   since each snapshot becomes a commit the repository must accept on
   its own; the full suite stays at the end. The same paragraph says
   that a generator's output is not the fix: restore what a build, an
   install or a test rewrote before the snapshot, report a generated
   file only when changing it is the fix, and run a tool that writes
   over the files you hold, never over the whole tree (R7, PD9). A new
   paragraph before it, "Claim before the first edit of a file you do
   not own", states the step and that a refused claim blocks the
   finding.

The `documentation` and `answer` roles change with the fragments and
stay unrun. The guard tests in `test/roles/repository.test.ts` pin the
new sentences.

### Events and the golden fixture

`files.claimed@1` is a new kind with a strict schema (`phase` the
`fixes` literal, `key` a batch key, `cluster` a cluster id, `files` one
to 2000 entries of a repository-relative path and an ISO time or null).
No existing kind changes shape, and no vocabulary is widened, so no
version 5 of the phase-carrying kinds is needed. The `fixes.replanned@1`
reducer is widened in place: it accepts every history it accepted, and
a ledger with no claims folds as before. The rule followed is
AGENTS.md's: a new kind is a registry change, so the golden test fails
until `schema-1-09` is committed with `npm run golden`, and the eight
older fixtures stay and must fold, with `claims` empty, which is the
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
  command cannot ask git (R23 of the fix pass), so it normalizes slashes
  and `./` and compares with the spelling `held.json` carries, which is
  the plan's, the worktree's own. A path spelled otherwise by a fixer
  makes a marker under that spelling; at the answer the engine resolves
  the answer's paths through `resolveReportedPath` as today and reads
  the markers through the same lookup, so one file never has two
  holders through two spellings in the fold. The fold refuses a second
  claim of a path it already holds.
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

## Test Strategy

- `test/review/claims.test.ts` (new): the directory's name per
  checkpoint, run and round; `prepareClaims` writes `held.json` and
  seeds recorded claims without removing a marker; `claimFile` answers
  `owned` for the unit's own file, refuses another cluster's owned file
  naming it, creates a marker once, answers `claimed` for the same
  cluster's second call and refuses another cluster's naming the
  holder; two claims of one path in one instant give one marker and one
  refusal (two processes); a claim of a path whose holder `held.json`
  lists as settled creates the next generation and succeeds, and two
  such claims in one instant give one marker and one refusal; a path outside the tree, under `.git`, with
  a backslash or `..`, is refused; the command starts no process, with
  `node:child_process` made to throw as the snapshot test does.
- `test/cli.test.ts`: `claim` parses its flags, refuses unknown ones and
  `--in` inside the worktree, exits 0, 2 and 1 as designed, and runs
  from a fixer's shell.
- `test/checkpoint/events-vocabulary.test.ts`: `files.claimed@1`'s
  schema, its caps and the null time; `reviewVocabularyV4` unchanged.
- `test/checkpoint/fix-fold.test.ts`: claims fold into `FixState.claims`
  and `holdersOf`; refusals for a claim before the plan, by a unit the
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
  sibling's own settle; `checkRevision` with a manifest revises a
  tracked file outside the expected tree that the check changed, leaves
  out one the user had changed before the check and the check left
  alone, and lists no file new since the check (PD9).
- `test/review/tasks.test.ts`: the task lists owned and claimed files
  apart, names a sibling's claim with its cluster, quotes the claim
  command on a line of its own with the placeholder, and says a refused
  claim blocks the finding; the repair's task is unchanged.
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
  `claimed`; a cluster claims a shared file, settles, and a cluster
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
  Limitations once the check rewrites it (PD9).
- `test/runtime/codex.test.ts`: an editor's `writable_roots` holds the
  scratch and the shared directory, a read-only worker neither;
  `test/runtime/launcher.test.ts`: `shared` refused for a read-only
  worker.
- `test/review/fix-report.test.ts`, `test/review/report.test.ts`,
  `test/review/status.test.ts`: the "Held by" column, the Limitations
  lines, the `Claims:` line and its JSON; the committed report
  snapshots of runs without claims render as before but for the column.
- `test/roles/repository.test.ts`: the claim sentences in every fixer
  role, the quick-checks sentence and the generator sentence in
  `fixer-apply.md`, and the old "any file no cluster owns" sentence gone
  from wherever it was pinned.
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

No checks have run yet. This section is filled by the commits that
build the element: the roles' hashes after each text commit, the test
counts, continuous integration on the three platforms, and the gate of
R10, in this form:

| | `71ae22a2`, parallel | `8dbe23ad`, one at a time | The gate |
|---|---|---|---|
| Concurrency in the fix pass | 4 | 1 | 4 |
| Engine commits, green alone | 13 of 23 | 16 of 17 | |
| Fixer workers | 14 | 13 | |
| Claims made, refused, late | | | |
| Second round | 7 findings, 2 batches | 6 findings, 2 batches | |
| Fixes phase, wall seconds | 3905 | 5964 | |
| The run: workers, USD | 48, 37.86 | 47, 32.34 | |

The per-commit check checks out each commit detached in turn and runs
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
- A ledger written before this change folds with `claims` empty and its
  second round as recorded; nothing is migrated. The measurement corpus
  under `projects\gate\replay` holds no `files.claimed` and folds as
  before, which the golden test and the corpus check in Verification
  show.
- The claims directory is under the system's temporary directory, as
  the scratch is; a cleaning mid-round refuses every claim until the
  next launch seeds it again, and the findings refused go to the second
  round (requirements, Risks).
- `othersHeld` reads the live directory at the answer and the launch;
  a claim made by a sibling between a unit's launch and its answer is
  not in that unit's task, which is why the fixer runs the command
  rather than trusting the list. A holder that settles between two
  launches is still in `held.json` as unsettled until the next launch
  rewrites it, so a claim of its file in that window is refused and the
  finding goes to the second round (TD2).
- Two spellings of one path (TD4) make two markers until the engine
  resolves them at the answer; the fold refuses the second claim, the
  violation rule then applies, and the report names it. A
  case-insensitive file system is handled where the plan's spelling is
  chosen, as grouping handles it.
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
