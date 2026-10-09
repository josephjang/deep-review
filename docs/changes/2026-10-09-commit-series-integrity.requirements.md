# Product Requirements: Commit series integrity

Technical part: [2026-10-09-commit-series-integrity.design.md](2026-10-09-commit-series-integrity.design.md).

## Summary

A fix run's commits must each pass the repository's checks on their
own, with parallel fixers, and without a person at the keyboard. Three
things stop that today, all three found when the engine reviewed and
fixed its own decision step on 2026-10-08 and, for the first time, each
engine commit was checked alone rather than the final tree. A file no
cluster owns can be edited by two fixers at once, and each finding's
revision takes the file as the disk holds it at the snapshot, so a
sibling's edit lands in the wrong finding's commit (#22). A fixer
attempt the engine refuses has its edits kept as revisions over every
changed path no other unit owns, siblings' edits of shared files
included (#23). And a fixer runs the checks at the end of its batch, so
a later finding's correction of an earlier finding's edit leaves the
earlier commit red on its own (#24).

The change is one ownership rule, a few prompt lines and one rule for
the answer. A file no cluster owns belongs, until its cluster settles,
to the cluster whose fixer first claims it: the fixer claims every file
a finding will need through a command the engine ships before the
finding's first edit, and a fixer whose claim is refused reports the
finding blocked on that file and gets the second round the fix pass
already gives a finding blocked on an owned file (R21, PD18 of the fix
pass). Ownership and claims are one model, so a refused attempt's
revisions take only what its cluster owns or claimed, which closes #23
without a rule of its own. For #24 the fixer's prompt asks it to run the
quick checks it was given before each snapshot, since a snapshot is a
commit the repository must accept alone. A commit message goes with
every finding that names files, whatever its status, and with none that
names no file (R11, PD10), which closes #26 and #9: a refused claim
usually arrives after a finding's first edits, and such a finding would
otherwise land in one of the two.

The fix pass's PD5, which let a fixer edit any file no cluster owns, and
the two Risks entries that accepted blurred attribution on such a file,
are revised here (PD1, PD4). The gate is the engine on its own pull
request again, with parallel fixers at the default concurrency, every
engine commit passing `npm run check` alone, against the sequential
run's 16 of 17.

A fourth defect the same runs showed, a check killed by stopping the
engine and recorded as failed (#25), touches the checks phases alone
and has its own proposal, `2026-10-09-interrupted-check.md`.

## Problem

The engine reviewed and fixed the decision step's own change (#20) twice
on 2026-10-08, on Claude Code, from the plugin bundle of `75708ae`, as
the decision step's design records (Verification, "Review by
deep-review"). The first run, `71ae22a2`, ran its fixers at the default
concurrency of 4. The second, `8dbe23ad`, was stopped after its decision
and resumed with `--concurrency 1`, so its fixers ran one at a time.
Both reached a report with every check passing after the fixes. The
numbers below come from the two runs' ledgers in this repository's
checkpoint (`.git/deep-review-checkpoint`, folded read-only), the
fixers' Claude Code session transcripts (each tool call with its time),
the per-commit check logs under `projects\gate\decision\` and the local
branch `backup/decision-step-review-run1`, which keeps the first run's
commits.

| | `71ae22a2`, parallel | `8dbe23ad`, one at a time |
|---|---|---|
| Findings routed to fixers | 20 | 18 |
| First-round clusters, batches | 11, 11 | 10, 11 |
| Second round | 7 findings, 1 cluster, 2 batches | 6 findings, 1 cluster, 2 batches |
| Fixer workers | 14, one attempt refused | 13 |
| Fixes phase, wall seconds | 3905 | 5964 |
| Fixes phase, USD | 15.55 | 11.97 |
| The run: workers, USD | 48, 37.86 | 47, 32.34 |
| Engine commits | 23 | 17 |
| Commits that pass `npm run check` alone | 13 | 16 |

**Two fixers edit one unowned file at once, and the snapshot cannot tell
their edits apart (#22).** In the parallel run one unowned file was
written by fixers of three clusters: `src/checkpoint/fix-state.ts`, by
`c2-1` (first attempt, 22:33:28 UTC), `c8-1` (22:43:22) and `c10-1`
(22:59:06). `c2-1` and `c8-1` ran together from 22:42:38 to 22:58:34,
`c8-1` and `c10-1` from 22:58:38 to 23:04:37. All three were sent there
by their decisions: SCAN-2's approach names `fix-state.ts:203-204`,
DUPLICATION-6's says "Export `appliedOptionOf(ask)` from
src/checkpoint/fix-state.ts", and SCAN-4's says "Widen RoutedDecision
(fix-state.ts)". The revision of a batch's last finding reads the
worktree when the answer is recorded, so SCAN-3's revision, `c8-1`'s
last, recorded at 23:04:37, took the widening of `RoutedDecision` that
`c10-1` had written at 22:59:06; when `c10-1` answered at 23:09:49 the
file already matched what the run expected and SCAN-4's own commit
`130ef8f` holds the test for a type change it does not carry. SCAN-3's
commit `0001b4d` and the one after it, `99d53ed`, fail typecheck alone.
This is the only two-writer collision in the run, and it is the one the
decisions caused. With one fixer at a time there was none.

**A refused attempt's revisions take siblings' edits (#23).** `c2-1`'s
first attempt was refused by a structural check (#26) at 22:58:34, and
the engine kept its edits as revisions over every changed path no other
unit owned (R20 of the fix pass). Its SCAN-2 revision, commit `315550b`,
names nine files; its fixer had written four of them (`fix-report.ts`,
`fix-state.ts`, `fix-report.test.ts`, `fix-pass.test.ts`). The other five
were siblings' work in flight: `test/review/report.test.ts` and
`test/review/controller.test.ts`, rewritten by `c1-1` from 22:32:59;
`test/review/tasks.test.ts` and the design document, by `c8-1` from
22:43:37; `test/checkpoint/review-fold.test.ts`, by `c6-1` from
22:44:27. The DESIGN-3 revision after it took the requirements document
from `c8-1` the same way, and the closing revision took `c1-1`'s later
edit of `report.test.ts`. Those tests expect code that landed in the
siblings' own commits later, so `315550b` and the seven commits after it
fail alone; `1429cd5` is the first green one. Together with #22 that is
the 10 red commits of 23.

**A batch's per-finding commits need not each pass (#24).** With one
fixer at a time no edit crossed clusters, and one commit of 17 still
failed: batch `c2-1` fixed SCAN-1, FOOTGUNS-4, SWEEP-1 and SWEEP-2 in
that order, SWEEP-1's snapshot held a line in `test/review/report.test.ts`
that does not typecheck, and the fixer corrected it while applying
SWEEP-2, so SWEEP-1's commit `c376b0b` is red and SWEEP-2's is green.
The fixer runs the checks when its batch is done, as its prompt asks;
nothing asks it to have the tree passing at each snapshot. The line was
moved into SWEEP-1's commit by hand (`6363fe3`).

**What the sequential workaround costs.** Running the fixers one at a
time removed the cross-cluster mixing and nothing else. Its fixes phase
took 5964 s against 3905 s, and it took a person to stop the engine
after the decision and resume it with the flag, which is what killed a
baseline check in flight (#25). The author's goal for the engine, stated
2026-10-07, is the least human involvement; a fix run whose commits a
person must re-check and repair, or whose concurrency a person must turn
off by hand, does not meet it.

**Why it was not seen before.** The fix pass accepted both risks on
purpose: PD5 lets a fixer edit any file no cluster owns and its Risks
accept a lost edit there and a failed attempt's revision taking a
sibling's edit of such a file ("the expected tree is still right").
Neither weighed what the commits look like one by one, and every gate
before this one compared the final tree. The decision step made the
risks likelier: without `routeOf` 20 of the first run's findings went to
fixers where the old routing would have sent 15, and a decision's
approach names files outside its finding, which is how three clusters
met in `fix-state.ts`.

**How many files a fixer claims.** In the two runs a batch edited
between none and ten files outside its cluster, two to four as a rule
and the largest counts in second-round batches (the first draft said
one to seven; review F16, 2026-10-09): its tests, the proposal
documents a finding's fix amends, `dist/` after a rebuild, and a file a
decision named. The files two clusters both wrote in one round, the
case a claim decides, were the two proposal documents on both runs and
`src/checkpoint/fix-state.ts` on the first; no test file was written by
two clusters in either run (review of 2026-10-09, F11).

## Goals

- Every engine commit passes the repository's checks on its own, with
  fixers running at the default concurrency and no hand on the run.
- Each finding's commit holds that finding's edits and nothing of a
  sibling's, whether the batch answered or its attempt was refused.
- The mechanism is the ownership model the fix pass already has, not a
  second one beside it.
- The cost in wall time and money is measured on the same change the
  problem was found on.

## Non-Goals

- **Separate worktrees per batch.** Weighed and rejected (PD1).
- **An engine that reverts, merges or rewrites a fixer's edits.** PD3 of
  the fix pass stands: the engine never writes the reviewed tree during
  a run, and a revision records what a worker left, never what the
  engine made of it. A correction folded back into an earlier revision
  by the engine (#24's second option) is rejected (PD5).
- **Ownership enforced by a sandbox.** PD4 of the fix pass stands: the
  claim is a rule the prompt states and a command answers, and the
  engine records a breach rather than preventing it.
- **The decider naming the files a fix touches.** Weighed and left out
  (PD6).
- **A check per snapshot run by the engine.** The engine still runs the
  checks once before the fixes and once after; what a fixer runs between
  findings is its own judgment under its prompt (PD5).
- **The interrupted check (#25).** Its own proposal, on its own branch
  and pull request.
- **A Codex fix gate.** Codex is a judging runtime here; the gate runs
  on Claude Code alone, as the decision step's did.

## Requirements

- **R1: A file no cluster owns belongs to the cluster whose fixer first
  claims it, until that cluster settles.** Before its first edit of a
  file its cluster does not own, existing or new, a fixer claims it
  through the claim command its task quotes; a deletion is an edit of
  the deleted path, and a rename is an edit of both its paths
  (2026-10-09, review F15). The claim succeeds when no
  other cluster of the round holds the file, and holds it for the
  fixer's cluster until every batch of the cluster has settled (answered
  or not attempted): a later batch of the same cluster edits it freely,
  a fixer of another cluster does not until then. Once the holder has
  settled, the file is free to claim again, as a file no cluster owns
  is, since the holder's edits are then in the expected tree and a later
  claimant's revisions attribute only its own. A claim refused names the
  cluster that holds the file, and the fixer reports the finding
  `blocked` with the file in `requiredFiles`, as it does for an owned
  file today. The fixer's prompt and task state the rule in the same
  breath as ownership. Before the first edit for a finding, the fixer
  claims every file outside its cluster that the fix and its tests will
  touch, so that a refusal arrives before any edit and the finding is
  reported blocked with no edits; when a refusal comes after edits, the
  edits stay, are listed under the finding, and its message says the
  change is partial (R11). (Amended 2026-10-09, review F2: as first
  written a claim lasted the round, which sent a later cluster to the
  second round for a file whose holder had long settled, and so made
  `--concurrency 1` worse than today; PD3. Review F4: the claim before
  the finding's first edit, PD10.)
- **R2: The claim command starts no process and claims atomically.**
  `deep-review claim --path <path> --unit <key> --in <dir>`, run by a
  fixer from the repository root, records the claim as one file created
  exclusively under a directory the engine prepares for the round,
  outside the reviewed tree and outside the git directory, and exits 0
  for a claim made or already its cluster's, 2 naming the holder for a
  refusal, 1 for anything else, a directory the engine prepared that is
  gone included, which it names on stderr with the words to stop
  editing and answer (R12). It reads no ledger and starts no
  process, so it runs under every sandbox the snapshot command runs
  under (R23 of the fix pass). A path outside the repository or under
  `.git` is refused with the reason and exits 1, there being no holder
  to name; a file another cluster of the round owns is refused as a
  held file is, 2 naming the owner; an owned file of the fixer's own
  cluster answers 0 (2026-10-09, review F14).
- **R3: The engine records every claim on the ledger and the fold holds
  it.** When a unit's answer, failed attempt or lost worker is recorded,
  every claim in the directory that the ledger does not hold yet is
  appended before it, whichever cluster made it, as one event per
  claiming unit with each claim's time; so the ledger holds every claim
  made before any later answer, and the fold checks a violation against
  a running sibling's claim as it checks one against an owned file (R6).
  A resumed run seeds the directory again from the plan and the recorded
  claims before it launches a batch, and never removes a claim. The fold
  refuses a claim on a file a cluster of the round owns or another
  cluster claimed and has not yet settled, holds the latest claim of a
  path as its holder, and the report's Changed files names the cluster
  that last claimed each unowned path. The engine appends no claim the
  fold would refuse: a claim marker on a file a cluster of the round
  owns, or that an unsettled other cluster holds on the ledger, or from
  a unit the plan lacks, is left out, logged, and named in Limitations
  as a claim lost to its holder, and the file's edits then fall under
  R6 (added 2026-10-09, review F9). (Amended 2026-10-09, review F1: as first
  written, a unit's claims were appended only when that unit settled, so
  an answer naming a file a still-running sibling had claimed carried a
  violation the fold could not check, and the append was refused.)
- **R4: A finding blocked on a claimed file gets the second round.** A
  finding reported `blocked` whose required files are each owned, or
  claimed at any time of the round, by another cluster of the first
  round is planned into the second round as R21 of the fix pass plans
  one blocked on owned files, and the second round's cluster owns those
  files; that the holder has settled since the refusal changes nothing,
  since the blocked answer is already recorded. The first round's
  claims end with it, and second-round fixers claim among themselves the
  same way. A claim refused in the second round leaves its finding
  blocked, as R21 leaves a finding blocked twice: there is no third
  round. PD18 of the fix pass reasoned that a finding blocked twice had
  twice misjudged what it needed; a refused claim is a race lost, not a
  misjudgment, so the gate counts such findings (R10), and rounds that
  run until no finding is blocked, under a cap, are the next lever if
  the count says so (decided 2026-10-09).
- **R5: A refused attempt's revisions take only its cluster's work.**
  The paths of an unfinished attempt's revisions (R20 of the fix pass)
  are the unit's owned files, the files its cluster claimed, and every
  path its snapshots listed or git reports changed that no other
  cluster of the round owns or claimed, less the strays and the files
  git ignores as today. A sibling's edit of a file the sibling claimed
  is never attributed to the attempt.
- **R6: A fixer's edit of a file it neither owns nor claimed is observed,
  not reverted.** When an answer names a file another cluster of the
  round holds, by ownership or by claim, it is recorded as an ownership
  violation as today, revised like any other file, and named in
  Limitations with both clusters; the fold checks the violation against
  the plan's files and the claims recorded before the answer, which R3's
  order makes every claim made by then. When it names a file nobody holds, the
  claim is recorded late, at the answer, and Limitations says the fixer
  edited it without claiming it first. Neither stops the run.
- **R7: A snapshot is a commit the repository must accept on its own.**
  The fixer's prompt says that before each snapshot it runs the checks
  it was given that finish quickly, such as a typecheck and a lint, on
  what the finding touched, and corrects within the finding what they
  show, so that a later finding's work never has to repair an earlier
  finding's commit. A failure the checks show in a file the fixer does
  not hold is a sibling's work in flight, not its own: the fixer leaves
  it and reads past it, and runs the lint over the files it changed
  where the tool allows, since the typecheck reads the whole tree
  (added 2026-10-09, review F6, from run `71ae22a2`, where `c8-1` had
  to filter `c2`'s half-made `fix-report.ts` out of its typecheck
  output by its own judgment). The full suite stays at the end of the
  batch. Which of the checks are quick is the fixer's judgment; the
  engine runs no check per snapshot. A generator's output is not the fixer's fix: when
  a build, an install or a test it ran rewrote generated files, the
  fixer restores them to their launch state before the snapshot, and
  reports a generated file only when changing it is the fix, as a
  lockfile is when a dependency is added. A tool that writes runs over
  the files the fixer holds, never as a variant that rewrites the whole
  tree (PD9). (Added 2026-10-09, review F3.)
- **R8: The task tells a fixer what is held and how to claim.** A
  fixer's task lists, beside the files other clusters own, the files
  that other clusters which have not yet settled have claimed so far in
  the round, each with its cluster; quotes the claim command with the unit and the directory
  filled in, as the snapshot command is quoted; and says a file not
  listed is claimed before its first edit and reported blocked when the
  claim is refused.
- **R9: The prompts change in their own commits.** `fixer-role.md`
  states the claim rule with the ownership rule; `fixer-apply.md` adds
  the claim step before a finding's first edit, for every file the
  finding will need, and the quick checks before each snapshot (R7);
  `fixer-report.md` states the message rule of R11. The `documentation`
  and `answer` roles, which share the fragments, change with them and
  stay unrun.
- **R10: The gate.** The engine, built from this element, reviews and
  fixes this element's own pull request on Claude Code with `--fix` at
  the default concurrency of 4, with the checks named by flag as the
  decision step's review named them, the build check included this
  time, so that the engine itself makes the commit that rebuilds `dist/`
  at the series' tail (PD9). Every engine commit passes `npm run check`
  alone, measured by checking out each commit detached in turn, never
  under `git rebase --exec` (#27), and the series' last commit passes
  `npm run verify`, which is what the repository asks of a pushed head
  (AGENTS.md, "Before every commit", as amended on 2026-10-09). The run's commits, fixer
  workers, claims made and refused, second-round findings, findings left
  blocked by a claim refused in the second round, fixes-phase
  wall time and cost are recorded in the design's Verification against
  the two 2026-10-08 runs: 16 of 17 green commits, 47 workers and 32.34
  USD with one fixer at a time; 13 of 23, 48 workers, 37.86 USD and a
  3905 s fixes phase in parallel. The gate passes on three conditions
  (decided 2026-10-09, review F10). First, no commit holds a path its
  cluster neither owned nor claimed, late claims included, which the
  ledger and the revisions decide and which is the closing of #22 and
  #23: 10 of 23 on the parallel run, 0 of 17 on the sequential, and
  zero on the gate. Second, every commit red under `npm run check`
  alone lies inside one batch and has its cause named, the kind #24
  describes: 0 of 23 and 1 of 17 on the two runs, and on the gate each
  one explained. Third, the costs above are recorded. Every commit
  green is the aim and not the pass condition, since the Risks accept a
  failure only the full suite shows, and a single gate run on another
  change is one sample, not a measurement against the two runs.
- **R11: A commit message goes with the files, whatever the status.**
  (Added 2026-10-09, review F4.) A finding whose `files` is not empty
  carries a `message` that describes those edits, applied,
  already-applied, deferred or blocked alike, and one whose `files` is
  empty carries none; a message on a blocked or deferred finding says
  the change is partial and what it waits for. The structural check
  refuses an answer only where the two disagree, a finding with files
  and no message or with a message and no files, and no longer refuses a
  message on a blocked or deferred finding (#26). A revision's commit
  then always carries the fixer's message, and the message the engine
  composes stays only for a refused attempt's revisions (#9).
- **R12: A claims directory that disappears stops the run.** (Added
  2026-10-09, review F5.) When the engine finds the round's claims
  directory gone, at a launch when it prepares the directory or when it
  reads the directory to record a unit's outcome, it launches nothing
  more. Each unit still running is recorded, when it ends, as a failed
  attempt whose reason names the lost directory, whatever it answered,
  with its edits kept as attempt revisions (R20 of the fix pass) and the
  failure not counted against the unit's attempts, as a worker lost
  with its engine is not counted; the phase then finishes blocked with
  `claims-lost`, whose action is to run the command again. The resumed
  run seeds the directory from the plan and the recorded claims (R3)
  and gives those units fresh attempts, whose tasks say an earlier
  attempt left edits. Claims made after the directory vanished are lost
  with it; the edits they covered are in the attempt revisions, so the
  retry claims again and goes on from the tree it finds. A cleaned
  snapshot directory stays as the fix pass accepted it, a loss of
  granularity and never of correctness; a cleaned claims directory is a
  loss of the guarantee against concurrent edits, which the run must not
  go on under.

## Metrics

- Engine commits that pass `npm run check` alone: every one is the aim.
  The sequential run's 16 of 17 is the number to beat; the parallel
  run's 13 of 23 is the number the mechanism answers. The pass
  conditions are R10's (F10).
- Commits holding a path their cluster neither owned nor claimed, from
  the ledger and the revisions: 10 of 23 on the parallel run, 0 of 17 on
  the sequential; zero on the gate is the first pass condition.
- Red commits that lie inside one batch, the kind of #24, each with its
  cause: 0 of 23 and 1 of 17; each explained is the second pass
  condition.
- Fixes-phase wall time at the default concurrency, against 3905 s in
  parallel and 5964 s one at a time on the same change.
- Second-round findings and batches, against 7 in 2 batches. On the
  first run claim on first write would have sent two more findings to
  the second round (design, Context), about one more batch.
- Claims per batch, claims refused, late claims and violations against
  claimed files, from the ledger.
- Findings left blocked by a claim refused in the second round, from
  the ledger: zero on both 2026-10-08 runs, whose second rounds had one
  cluster each, so no claim could be refused there (R4).
- Blocked findings that carried edits, from the ledger (R11); on run
  `71ae22a2` two of the seven blocked findings did, `SCAN-2` and
  `DUPLICATION-6`.
- The per-commit check is a loop over detached checkouts, one commit at
  a time, running `npm run check`, which writes nothing; `npm run
  verify` runs on the series' last commit only (PD9). It is never run
  under `git rebase --exec`, which exported `GIT_DIR` into the suite's
  git calls and rewrote the shared git directory on 2026-10-08 (#27).
- Generated paths a fixer kept in a revision of its own, from the
  ledger: zero is the target, and each one is named in Limitations
  (PD9).

## Product Decisions

- **PD1: Claim before the first edit, revising PD5 of the fix pass.**
  PD5 gave a fixer every file no cluster owns and gave up the guarantee
  that two fixers never touch one shared file; it is revised to: a fixer
  may edit any file no cluster owns and no cluster has claimed, and
  before its first edit of it claims the file for its cluster, which
  holds it until the cluster settles (PD3, PD10). This is the ownership
  model the fix pass already runs, with one more way for a cluster to
  come to hold a file, and the second round it already has takes the
  finding that loses the file. Three mechanisms were weighed against
  the first run's evidence:
  - *Claim on first write.* On run `71ae22a2` the one collision was
    `fix-state.ts`, first written by `c2-1` at 22:33:28. `c8-1`'s SCAN-3
    and `c10-1`'s SCAN-4 would have been blocked on it and joined the
    second round, which the run already had for seven findings in one
    cluster: nine findings in three batches instead of seven in two, one
    more batch of 500 to 900 s on a 3905 s phase, by the two second-round
    batches' 716 and 921 s. (`c8-1`'s DUPLICATION-6 was blocked already.)
    The five single-writer misattributions of #23 produce no claim
    conflict at all, since each file had one writer; they end because
    the attempt's paths exclude what siblings claimed (R5). Cost per
    batch: one command per unowned file, two to four as a rule, a few
    seconds each.
  - *Separate worktrees per batch, revisions applied in plan order.*
    Attribution right by construction, and rejected. Each of the run's
    14 launches would need a worktree with its own install (this
    repository's `node_modules` is 66 MB and an `npm ci`; the zod gate's
    is a `pnpm install`), the engine would write trees, which PD3 of the
    fix pass forbids during a run, two batches' edits of one file would
    meet as a textual merge the engine makes and no fixer validated, so
    the checks phase would be the first to see the tree the run delivers,
    and the second round would still exist for owned files. A new
    failure class, a conflicting merge, for the one collision claims
    answer with a second round.
  - *Serializing units whose findings or decisions name a common unowned
    file.* Rejected. On the first run the three decisions naming
    `fix-state.ts` would have chained `c2-1` (1592 s and a 663 s retry),
    `c8-1` (1319 s) and `c10-1` (672 s): 4246 s, and with the second
    round after the chain, where R21 of the fix pass puts it, about
    2000 s longer than the phase took (the chain alone is 338 s longer;
    review F16, 2026-10-09). It reaches none of #23's five files, which
    no decision names: the files a refused attempt took from siblings
    there were tests and documents, and the files two clusters both
    wrote on the two runs were the proposal's documents four times and a
    decision-named source file once (Problem). It also needs the engine
    to read file names out of a decision's prose, or the decider to list
    them (PD6).
- **PD2: The claim is a rule and a command, observed by the engine, as
  ownership is (PD4 of the fix pass).** A watch on the worktree that
  claims on the fixer's behalf was rejected: the engine would see the
  write seconds after it, but a sibling that is about to write the same
  file has a task fixed at its launch and no way to be told, so the
  fixer must ask before it writes in any case. A command that answers
  from a directory is the snapshot command's pattern (R23 of the fix
  pass): it runs where the fixer's shell runs, under Codex's unelevated
  sandbox included, and the engine reads what it left. Claude Code's
  permission hooks and Codex's sandbox were rejected again for the
  reasons PD4 gave; a fixer that writes without claiming is observed
  (R6).
- **PD3: A claim belongs to the cluster and lasts until the cluster
  settles.** A claim per batch was rejected: a cluster's batches run one
  after another and share its files, so a file the first batch claimed
  is the cluster's for the next, as the files it owns are. Releasing a
  claim when a batch answers while the cluster has batches left was
  rejected for the same reason. A claim that lasts the whole round, the
  first draft, was rejected on 2026-10-09 (review F2): once a cluster
  has settled its edits are in the expected tree, so a later cluster
  that claims the same file attributes only its own edits, exactly as a
  later batch edits an unowned file today; holding the file past the
  settle only sends that cluster to the second round for nothing. On
  run `8dbe23ad`, with one fixer at a time, c9-1 edited the two proposal
  documents twenty minutes after c3 had settled; a claim lasting the
  round would have sent RIPPLE-2 to a second round the run never needed,
  so `--concurrency 1` would have run worse than today. A claim that
  ends at the settle leaves that run as it was and leaves run
  `71ae22a2`'s count unchanged, since c8-1 and c10-1 both wrote
  `fix-state.ts` before c2 settled. A claim that outlives the round was
  rejected: ownership ends with the round (R21 of the fix pass), and the
  second round reclusters over the files anyway. Owned files keep
  ownership for the round as R21 gives it; a cluster holds a file it
  claimed while it is unsettled, which is still one model.
- **PD4: The refused attempt's paths narrow to its cluster's, revising
  the fix pass's Risks.** The fix pass accepted that a failed attempt's
  revision takes a sibling's partial edit of a shared unowned file
  because the expected tree stays right. The expected tree does stay
  right; the commit series does not, and it is what the repository
  checks. #23 offered two fixes: narrow the paths to the attempt's own
  snapshots plus files changed after its last snapshot that no running
  sibling has reported or snapshotted, or remove the cause. The first
  was rejected on its own: a running sibling reports nothing until it
  answers, and its snapshots are in a scratch the engine reads only at
  its answer, so "no running sibling has reported" is not decidable at
  the failure. With claims the cause is gone: a sibling's edit of an
  unowned file is an edit of a file it claimed, and R5 leaves claimed
  files out. The attempt's last revision, what it left after its last
  snapshot, still reads git's list of changed paths, so an edit by a
  fixer that ignored the claim rule is attributed as today; R6 records
  it.
- **PD5: #24 by the fixer's prompt, not by engine detection.** The
  second option in #24, the engine noticing that a later revision of a
  batch changes lines an earlier revision added and folding the
  correction back, was rejected: it is a deterministic rule over model
  edits that rewrites what the fixer attributed, it needs a line-level
  diff of every pair of revisions, and a correction that spans lines the
  earlier revision did not add has no home. The repository prefers the
  model's judgment where a prompt can carry the rule, and the rule is
  one the repository states for every commit; the fixer already runs
  the checks, only later than the snapshot. On this repository a
  typecheck and a lint take 3 and 5 s, so the price is a few seconds per
  finding plus the turn; on a repository whose build is slow the fixer
  chooses what is quick. The evidence is one commit of 17; the gate says
  whether the prompt line is enough, and engine detection stays the next
  lever if it is not.
- **PD6: The decider does not name the files a fix touches.** Adding a
  `files` list to a `fix` decision and clustering over it would have put
  the three `fix-state.ts` findings in one cluster from the start, which
  is PD1's serialization through the plan, and SCAN-2's decision also
  names `decision-report.ts`, so `c1` would have joined too: nine
  findings in one serial cluster. It also changes the decider's schema
  and `decisions.recorded@1`, which was measured on 30 workers before it
  shipped. Claims handle a decision-named file as they handle a test
  file, with one second round at most; if the gate shows decision-named
  files costing second rounds often, the list is the next lever.
- **PD7: The gate is this element's own change, in parallel.** A new
  gate repository was rejected: the problem was found on this
  repository's own change with its own commit rule, the two 2026-10-08
  runs are the baseline, and only a third run on the same kind of change
  compares. zod #6530 was rejected for the same reason: no fix run there
  was ever checked commit by commit, and its `test` fails at baseline
  from the environment, so a green series cannot be measured there.
- **PD8: #25 is its own proposal.** It changes the checks phases'
  planner and reducer and nothing a fixer, a claim or a revision
  touches; folding it into this design would tie an unrelated gate to
  it. Its own branch and pull request too, so each is confirmed and
  lands on its own, though both came from the same runs.
- **PD9: A step that writes the tree puts its output at the series'
  tail, and the middle of the series stands without it.** (Added
  2026-10-09, review F3.) The review found that on run `71ae22a2` a
  fixer's `npm run build` had bundled siblings' half-made edits into
  `dist/`, which the fixer then restored by hand, and that R10's
  requirement of `npm run verify` on every commit could be met only by
  a person rebuilding `dist/` into each commit after the run. The cause
  is not the build but the repository's rule that every commit carry a
  current `dist/`, which that rule asked of commits nobody installs;
  AGENTS.md now asks it of pushed heads, and this decision follows.
  Nothing a run does per commit may write the tree, and what writes it
  writes once, at the end:
  - *The per-commit criterion writes nothing.* The gate's per-commit
    check is `npm run check`; a kind whose only command writes is taken
    in its checking variant where the repository has one (TD5 of the
    fix pass) and otherwise left to the head.
  - *A check the engine runs that writes the tree is a check revision at
    the tail.* As TD6 of the fix pass records it, with one change: the
    revision covers every tracked file the check changed, judged
    against a manifest taken just before the check, not only the paths
    the expected tree already held, so a generated tree outside the
    scope, `dist/` here, is recorded and committed last rather than left
    changed and unrecorded in the worktree. A check runs once per
    phase, with no editing worker alive and one kind at a time, so its
    output meets no batch's. New untracked files stay strays. A tracked
    file outside the expected tree is revised from the head, so when a
    fixer edited one without claiming or naming it and the check then
    rewrites it, the revision keeps that earlier edit under `chore:
    apply the <kind> check's rewrite`, and nothing names it apart.
    Whether the engine should name such an edit in Limitations, or
    leave a path that already differed from the head out of the check's
    revision, is left to the author.
  - *A fixer keeps no generator output as its fix* (R7): it restores
    what a build, an install or a test rewrote before the snapshot, and
    runs a writing tool over its own files only. The fixers of one
    round can reach one another only through such tools, and this is
    the rule that closes it.
  - *A generated file a fixer kept anyway is observed, not reverted.*
    The engine names it in Limitations, as PD3 and PD4 of the fix pass
    treat every edit; the tail revision overwrites it with the output of
    the final tree, so the head is right, and whether the middle commit
    still passes `npm run check` is counted by the gate.
  Rebuilding generated trees inside the commit command, once per
  revision, was weighed and set aside: it needs each revision's tree
  laid out and built, and once the repository asks for `verify` at heads
  only, nothing needs it.
- **PD10: The message follows the files, not the status.** (Added
  2026-10-09, review F4.) The fix pass tied a message to the applied
  status, as the commit message of an applied change, and let a blocked
  finding carry none. The invariant it meant is that a revision has a
  message and a finding without edits has none; the status is a proxy
  for it, and the proxy fails exactly where a blocked or deferred
  finding holds edits. Under claims that case is the normal one: a
  refusal usually comes after a finding's first edits, when the fixer
  opens its test file, and such a finding then lands in #26 if it keeps
  the message it wrote, the whole answer refused and the edits kept as
  fallback revisions, the path that made #23's commits, or in #9 if it
  drops it, a commit under a composed subject, as `DUPLICATION-6` on run
  `71ae22a2`. #26's first option, dropping the message and logging it,
  was rejected: it keeps a partial commit without a message, which #9
  then names. Its second, a schema that forbids the message per status,
  was rejected for the same reason. Tying the message to `files` closes
  both with one check, and R1's claim before the finding's first edit
  makes the partial case rare.

## Risks

- **A fixer forgets to claim.** The rule is in the prompt and the task.
  The snapshot rule in the same place was followed wherever a finding
  had edits on both runs (three batches skipped the snapshot of a last
  finding that had no edits, or whose edits the worktree read covered),
  and under R1 as amended a claim is one step per finding too, before
  the finding's first edit, rather than one step per write in the
  middle of the python scripts and `sed -i` calls that write several
  files at once, which the fixers of both runs used often: 37 such
  writes on the first run, 27 on the second. A missed claim is observed
  as a late claim or a violation (R6), and a sibling's concurrent edit
  of the same file then blurs attribution as today. The gate counts
  late claims. (Reworded 2026-10-09, review F7.)
- **More second rounds.** A file two clusters both need at the same
  time now costs the loser a second round where it cost nothing before;
  on the first run that is two findings and about one batch. A file a
  settled cluster claimed costs nothing (PD3). A change whose fixes all
  meet in one shared file serializes through the second round, which is
  what clustering does for an owned file already. On these runs the
  files two clusters shared were the proposal's documents, which the
  fixes amend; the documentation reconciliation (#29), if it takes that
  editing out of the fixers' hands, takes those second rounds with it
  (F11).
- **A claim made and never used holds a file until its cluster
  settles.** A fixer that claims a file it then does not edit blocks a
  sibling for nothing while its cluster runs; the report shows the claim
  with no revision of the file. Accepted; the prompt asks for the claim
  before the first edit, not before reading.
- **The claims directory is in the temporary directory.** An operating
  system that cleans it mid-round loses the live claims, and the run
  stops with `claims-lost` once the engine sees it (R12): the units then
  running are recorded as failed attempts with their edits kept, and a
  person runs the command again, which retries them on a directory
  seeded from the ledger. Accepted; going on with a directory seeded
  from the ledger alone, while siblings held claims nobody had recorded,
  would give up the guarantee the claims exist for, and the fix pass's
  acceptance of a cleaned scratch does not carry over, since a lost
  snapshot costs granularity and a lost claim costs correctness.
  (Rewritten 2026-10-09, review F5: the first draft sent the refused
  finding to the second round, which R4 does not do for a file nobody
  holds.)
- **The quick checks slow each finding.** A few seconds and a turn per
  finding here; on a repository whose fastest check is a long build the
  fixer may skip it and the commit may still be red. Accepted; the gate
  measures the time and the series.
- **A decision that names one file for several findings now costs
  second rounds.** PD6 leaves the lever for later with the gate's count.
- **A claim refused in the second round blocks a finding for good.** A
  second round with several clusters races for its unowned files as the
  first did, and the loser has no third round. Accepted for now: both
  2026-10-08 runs' second rounds had one cluster, the gate counts the
  case, and rounds until no finding is blocked, under a cap, are the
  lever (R4).
- **A blocked finding with edits is a commit of its own.** Its message
  says the change is partial, and the second round's commit completes
  it, so the series holds a half step and its completion. Accepted;
  R1's claim before the finding's first edit makes it rare, and the
  gate counts blocked findings with edits (R11).
- **The series is green commit by commit only as far as the fixer's
  quick checks reach.** A test that fails only in the full suite, run at
  the batch's end, can still leave an intermediate commit red. Accepted;
  the full series is checked after the run, and the count is the
  metric, which is why every commit green is the aim and not the pass
  condition (R10, F10).
- **A fixer keeps a generator's output in its revision.** Under
  concurrency that output holds siblings' half-made edits. Accepted;
  the prompt says to restore it (R7), the tail check revision overwrites
  it, Limitations names it, and the gate counts it (PD9).
- **A generated file larger than the run freezes.** A file over the
  8 MiB freeze limit is recorded by hash and size only, so the commit
  command refuses to build a commit for it and the operator commits it
  by hand; this repository's bundle is 1.2 MB. Accepted; the limit is
  the scope capture's, not this element's.
- **A stale `dist/` at the run's start.** The baseline build check then
  rewrites it before any fix, and that rewrite is the series' first
  commit, a check revision. Accepted; it records a fact about the
  repository.
