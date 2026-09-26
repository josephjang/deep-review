# Change Proposal: Checkpoint ledger and evidence store

## Summary

Add the durable record every later element writes to: an append-only event
ledger in SQLite under the repository's git common directory, a content-
addressed evidence store beside it, a registry of event kinds with versioned
schemas, and a pure fold that derives run state from events. Two event kinds
exist at the end of this change, run creation and run abandonment. Scope
capture, the control surface, phases and workers arrive in later elements.

## Problem

A deep review runs for an hour across dozens of model calls, and its value
depends on what survives an interruption: which work finished, who owns which
file, what evidence each decision rests on. The proof of concept got this
right in one respect, which is why every pilot defect could be traced to a
line: its SQLite checkpoint kept its evidence through every failure. It got
the shape of that record wrong in four ways that each cost a run.

- The run's state was one JSON document, validated by one large schema and
  rewritten whole on every transition, with an event table kept beside it as
  a secondary trail. When the status projection's schema drifted from the
  writer's by one field (`subject` on a blocker, 0.3.4), every command that
  read the run threw, and the run could not be inspected, answered or
  abandoned. The "migration" from schema 1 to 2 changed the version number
  and nothing else, because the document had no smaller unit to migrate.
- The checkpoint lived in the worktree's own git directory. When worktree
  `rqr` was emptied, the run's artifacts, logs and engine snapshot went with
  it; the run stayed `active` and blocked every later init there.
- Runs pinned a frozen copy of the engine beside the checkpoint, so that a
  run could be finished by the engine that started it. When that copy was
  lost, `abandon` failed on a missing file. A second mode, adoption, was
  added so an installed engine could take a run over. Two modes, an engine
  directory per run, and a version gate were the price of a compatibility
  promise that a forward-compatible ledger gives for free.
- Opening the checkpoint took the write lock unconditionally, so a monitor
  reading status every thirty seconds made the controller's own command fail
  with `database is locked` (D6). Fixed later with a busy timeout and a
  lock-free open, but the shape that made it possible remained.

The repository skeleton now exists and has no place to write a run. This
element is the ground the scope capture, the control surface and every phase
stand on, and its shape is the hardest thing in the project to change once a
checkpoint exists on someone's disk.

## Goals

- A run's history is a sequence of typed, versioned events that no later
  code path can rewrite; the run's state is derived from them and can be
  re-derived at any time.
- A checkpoint written today is readable by every later engine version
  without a frozen engine, an adoption step or an operator attestation.
- A checkpoint survives the deletion of the worktree it was started in.
- Evidence (file bytes, patches, model outputs) is stored once by content,
  verified on every read, and never referenced by an event before it exists
  on disk.
- Two processes can read and write the same checkpoint without corrupting it
  or blocking each other's reads, and a writer that raced another learns so
  by a typed error rather than by a partial write.
- A change to the ledger's schema or event registry cannot ship without a
  committed fixture proving the previous schema still opens.

## Non-Goals

- No scope capture. Which files are reviewed, what is frozen and what drift
  means are the next element, 2b, which writes its results through this
  ledger.
- No control surface: no CLI, no `status` or `abandon` command. This element
  is a library with tests; the commands come with the element that needs to
  be driven from a skill.
- No phase, obligation, worker or ownership model. The registry holds two
  event kinds; later elements add theirs.
- No materialized state cache. A fold over a run's events is cheap at the
  sizes a review produces; a cache table is added when a measurement says
  otherwise (D1).
- No garbage collection of evidence. Nothing is deleted; a collector is its
  own element once there is something worth collecting.
- No migration content. The mechanism exists from schema 1 so that schema 2
  has somewhere to go; the migration list is empty.
- No engine freezing or adoption. See D4.
- No compatibility with the proof of concept's `.git/deep-review-node/` or
  the prompt-only skill's `.git/deep-review/`. Neither is read, written or
  deleted.

## Requirements

- R1: `locateCheckpoint(directory)` returns `<git-common-dir>/deep-review-checkpoint/`
  for any directory inside a git worktree, refuses a directory that is not
  inside one, and never creates, reads or removes anything under the legacy
  `<git-dir>/deep-review/` or `<git-dir>/deep-review-node/`.
- R2: Opening a checkpoint creates `ledger.sqlite` with WAL journaling,
  `synchronous=FULL`, foreign keys on, a 5 second busy timeout and
  `user_version` 1. Opening an established ledger takes no write lock. A
  ledger whose `user_version` is higher than the engine's is refused with an
  error naming both versions. A lower version is migrated forward inside one
  transaction after a `VACUUM INTO` backup beside the ledger; at schema 1 the
  migration list is empty and this path is exercised by a test fixture only.
- R3: An event carries a global monotonic sequence, a run id, a kind, the
  kind's schema version, a JSON payload, a UTC timestamp and the engine
  version that wrote it. The events table has triggers that abort any UPDATE
  or DELETE, and the store exposes no API that would issue one.
- R4: Every event kind is declared once, in one registry, with a zod schema
  per version. `append` refuses an undeclared kind or version and a payload
  that fails its schema. `fold` refuses an event whose kind or version it
  does not know, naming both, rather than skipping it.
- R5: `append(runId, expectedLastSequence, events)` writes all of its events
  or none. When the run's last sequence differs from the expectation, nothing
  is written and a `StaleRevision` error names both sequences.
- R6: `fold(events)` is pure and deterministic. With the two initial kinds it
  yields `{ id, worktree, createdAt, engine, status: 'active' | 'abandoned',
  abandonReason }`. `append` refuses any event on a run whose folded status
  is `abandoned`, inside the same transaction that would write it.
- R7: The evidence store under `artifacts/` stores a blob at its SHA-256 hex
  name. A blob is written to a temporary file, fsynced, and published by hard
  link, or by rename where the filesystem has no hard links; an existing blob
  is never replaced. `read` verifies size and hash and refuses a symlink or a
  non-file at the blob path. Identical content stored twice occupies one
  file.
- R8: A payload field that references evidence uses the registry's artifact
  reference schema, and `append` verifies every such reference exists and
  passes verification before the transaction commits.
- R9: Two processes appending to one run at once leave a consistent ledger:
  one append commits, the other fails with `StaleRevision` or a busy error
  and writes nothing. A reader folding a run while a writer appends sees a
  consistent prefix.
- R10: `test/fixtures/checkpoints/schema-1/` holds a checkpoint produced by
  a committed script, with its ledger, its artifacts and the fold result
  expected from it. A test opens it, folds every run and verifies every
  artifact. A second test records a hash of the DDL and the registry's
  kind/version list and fails when either changes without a new fixture.
- R11: zod is pinned at 4.6.5; `npm run check` and `npm run verify` pass on
  all three CI runners.

## Decisions

- **D1: The event ledger is the source of truth; state is a fold over it.**
  A state document per run, as the proof of concept had, was rejected: it is
  one schema that every reader and writer must agree on at once, it has no
  unit smaller than "the run" to version or migrate, and its failure mode is
  that the whole run becomes unreadable. With a ledger, a new field is a new
  event version, an old event stays readable forever, and a projection bug
  breaks one projection. The cost is that every state question is answered
  by a fold, and that the fold must keep understanding every event version
  ever written. No cache table is added until a fold is measured to be slow;
  a cache that can be rebuilt is easy to add and a cache that is trusted is
  the state document by another name.

- **D2: The checkpoint lives in the git common directory, under a name the
  legacy skills do not use.** The worktree's own git directory was rejected
  because the pilot lost a checkpoint with a worktree. The user's home was
  rejected because a checkpoint found by walking up from the checkout is the
  one a skill can locate without configuration. `deep-review-checkpoint` is
  used rather than `deep-review` because the prompt-only skill owns
  `<git-dir>/deep-review/` and has a cleanup rule that deletes run
  directories there. One ledger per repository means controllers in two
  worktrees share it; WAL, the busy timeout and R5 make that safe, and the
  proof of concept already ran two controllers against one file.

- **D3: SQLite through `node:sqlite`, behind one module.** A directory of
  JSON files was rejected: atomic multi-event appends, a single global
  sequence and cross-process locking are what SQLite provides and what the
  ledger needs. `node:sqlite` is still marked release candidate in Node 26;
  accepted because the proof of concept ran on it for months, and because
  every SQL statement lives in one module so a switch to another driver is
  local. Revisit if a Node release changes its API.

- **D4: Compatibility runs forward only: a newer engine always reads an
  older checkpoint, and nothing else is promised.** Freezing an engine copy
  per run, and the adoption mode added when freezing failed, were rejected:
  both existed to let an old engine finish its own run, and both made the
  checkpoint depend on files that were not the checkpoint. With D1, reading
  an older ledger is the normal case, and an engine that sees a newer schema
  refuses it by name. Each event records the engine version that wrote it,
  so a report can still say which engine produced what.

- **D5: Append-only is enforced by the database, not by convention.**
  Triggers that abort UPDATE and DELETE on the events table were chosen over
  trusting the store's API surface, because a later element will be tempted
  to "fix" a bad event in place and the pilot showed how a corrected record
  hides what actually happened. A wrong event is corrected by a later event
  that says so.

- **D6: Event kinds are declared in one registry with a schema per version,
  not in one state schema.** This is what makes D1 migratable: the fold
  knows `run.created` version 1 and, later, version 2, and each is a small
  schema with a small reducer case. A test enumerates the registry and
  proves every kind and version has a reducer, so a kind cannot be declared
  without being understood.

- **D7: Optimistic concurrency by last sequence.** A separate revision
  counter in the state was rejected because the ledger already has a
  monotonic sequence and a second number is a second thing to keep in step.
  A writer folds the run, decides, and appends with the sequence it folded
  up to; a race is a `StaleRevision` error and a re-fold, never a partial
  write.

- **D8: Timestamps are UTC ISO strings from `Date`; order is by sequence.**
  Temporal is available in Node 26 and was not taken: ordering never depends
  on time, and a nanosecond instant buys nothing a millisecond string does
  not. Revisit when an element needs wall-clock arithmetic, such as suspend
  detection.

- **D9: Run ids are UUID v4; evidence is addressed by SHA-256.** Sortable ids
  were rejected because the sequence already orders everything within a
  ledger. SHA-256 matches git's newer object format and the proof of
  concept's evidence, so hashes can be compared across the two.

- **D10: Evidence is never deleted by this element.** A retention policy
  needs to know what later phases reference; it is decided with the
  collector, not here.

- **D11: Artifact references are checked at append time.** Trusting the
  writer to have called `put` first was rejected: the proof of concept had
  the same rule as documentation only. The registry marks reference fields
  with one schema, so the check is mechanical and a new event kind gets it
  for free.

- **D12: Golden fixtures are keyed by schema and registry, and the test
  fails closed.** A fixture that is regenerated whenever it drifts proves
  nothing. The test compares a recorded hash of the DDL and registry with
  the current one, so a schema change without a new fixture is a red build,
  and the previous fixture stays until the two most recent are kept.

## Risks

- Risk: `node:sqlite` is a release candidate and its API may change before
  it is declared stable. Accepted; D3 confines the exposure to one module.
- Risk: an event ledger asks more of the next elements than a state document
  would; every transition must be expressed as events and every question as
  a fold. Accepted; that discipline is the point, and the proof of concept's
  "no source record is deleted" principle already demanded it.
- Risk: one ledger per repository means a corrupt ledger affects every
  worktree's runs. Accepted; `synchronous=FULL` and WAL make corruption an
  operating-system or disk failure, and the backup taken before any
  migration is the recovery path.
- Risk: hard-link publication depends on the filesystem; exFAT and some
  network shares have no hard links. Accepted with a rename fallback (R7)
  that keeps atomic publication and gives up only the never-replace guarantee,
  which an existence check restores.
- Risk: a fold over a very long run could become slow before a cache is
  added. Accepted; a review produces thousands of events, not millions, and
  D1 names the trigger for adding a cache.
