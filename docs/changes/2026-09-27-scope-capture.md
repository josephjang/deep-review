# Change Proposal: Scope capture

## Summary

Give a run something to review. Scope capture reads the change from git,
freezes the bytes of every changed file before and after the change into
the evidence store, records one `scope.captured` event on the run, and
offers a per-file comparison of the worktree against what was frozen. The
four ways of naming a change from the proof of concept stay; the reviewed
"after" state is always the worktree at capture time; a file over 8 MiB is
recorded by hash only.

## Problem

The ledger from element 2a can record a run and close it, and nothing else.
Every later element (finders, verification, editing, checks) starts from
"the change": which files, what they were, what they are now. The proof of
concept's capture got the inventory right and never failed a pilot on it,
but three choices around it cost runs.

- It froze the patch and the untracked files, not the changed files' full
  contents. A worker that needed a whole file read the worktree, so the file
  a finder saw and the file a verifier saw were the same only as long as the
  worktree had not moved. Finding anchors were checked against the worktree
  too, which is how a fixer's edit to one file invalidated every earlier
  finding in it, and how a CRLF checkout produced an anchor rejection whose
  cause could not be reconstructed (D4 of the pilot).
- Drift was one hash over the whole tree: HEAD, the diff, and every
  untracked byte. A finder that wrote a scratch file into the repository
  root changed that hash, the failed attempt stored the changed hash, and no
  later state of the tree could match it. One stray file ended the run (D3).
- The evidence root was derived from the scope's git directory inside the
  capture module, so the scope record and the checkpoint location were
  coupled through a path the capture had no business knowing.

The second element of the split decided on 2026-09-26 is this capture. It
is the last piece that touches git before the engine starts calling
models, and the shape of its record is what every finding location, every
ownership claim and every drift decision will refer to.

## Goals

- A run holds an inventory of its changed files with the exact bytes of each
  before and after the change, so any worker can be handed the reviewed file
  independently of what the worktree looks like later.
- What "the change" is can be named the same four ways as before: the last
  commit of a clean tree, the dirty worktree, everything since a ref, or a
  commit range, each optionally limited to literal paths.
- The reviewed "after" bytes are always the worktree's bytes at capture, so
  a later comparison of worktree against capture is a per-file question with
  a per-file answer.
- Drift is reported per file, and changes outside the scope are reported
  separately, so a later element can decide what matters instead of
  inheriting one all-or-nothing hash.
- A repository state the capture cannot represent faithfully (unmerged
  paths, submodules, embedded repositories) is refused by name before
  anything is written.
- A ledger written before this element still opens and folds under the
  engine after it.

## Non-Goals

- No review instruction text. What the user asked for is part of starting a
  run, recorded by the control element, not part of what the change is.
- No re-freezing after edits. When an editor changes a file, a later
  revision of the scope will be recorded by the editing element, using the
  same freezing code; this element records the initial capture only.
- No drift policy. `compareWorktree` says what differs; whether that pauses
  a run, fails an execution or is ignored is the phase controller's decision.
- No finding-location validation and no anchor rules. Those belong with the
  finder contract; this element only guarantees the bytes they will be
  checked against exist.
- No test-file classification. Which paths are tests is a policy the check
  and ownership elements need; the inventory carries paths and bytes only.
- No support for submodules or embedded repositories, and no capture of
  commits that are not checked out (D1).

## Requirements

- R1: `captureScope(checkpoint, runId, request)` appends one
  `scope.captured` version 1 event to an active run that has no scope yet
  and returns the folded state, which now carries `scope`. A run with a
  scope, an abandoned run, or an unknown run is refused with a typed error
  and nothing is written.
- R2: The mode is chosen from the request and the tree. No selector and a
  clean tree: `last-commit`, base is HEAD's first parent, or the empty tree
  for a root commit. No selector and a dirty tree: `worktree`, base is HEAD,
  and staged, unstaged and untracked changes are all in scope. A `ref`:
  base is `ref^{commit}`. A range `from`/`to` with optional merge-base: base
  is `from` or `merge-base(from, to)`, and `to` must resolve to HEAD or the
  capture is refused naming both commits (D1). In every mode the after
  bytes are the worktree's. A ref and a range together are refused.
- R3: `paths` limits the inventory and the patch to those literal paths
  (files or directories, no globs). A path that is absolute, contains `..`
  or a `.git` segment, or names nothing in the diff is refused.
- R4: The inventory lists every changed path once, without rename
  detection, with: status `added`, `modified` or `deleted`; `symlink`; a
  `before` reference or `null` when the file did not exist at base; an
  `after` reference or `null` when it does not exist in the worktree. Before
  bytes are read through git's checkout filters, so a CRLF worktree freezes
  a CRLF before and a CRLF after. A symlink freezes its target text. A file
  over 8 MiB in either state is recorded with its SHA-256 and size and
  `oversized: true`, and no blob is stored (D2).
- R5: One patch artifact holds `git diff` from base to the worktree with
  binary content and git's rename detection, limited by `paths`, followed by
  one `--no-index` diff per untracked file, so a reader sees the change the
  way `git diff` shows it.
- R6: Capture is refused, before any write, when the index has unmerged
  paths, when any index entry is a gitlink, when an untracked entry is a
  directory (an embedded repository), or when the inventory exceeds 2000
  paths. The refusal names the offending path or count.
- R7: HEAD, the index and the digests of every scope file are read at the
  start and checked again after the evidence is written; a difference
  refuses the capture with `CaptureRacedError` and no event is appended.
- R8: `compareWorktree(checkpoint, scope)` returns, for every inventory
  path, `unchanged`, `modified`, `deleted` (frozen after exists, worktree
  file gone) or `restored` (frozen after is null, worktree file exists),
  comparing an oversized file by hash, plus `outside`: every path git
  reports as modified, staged or untracked that is not in the inventory.
  It writes nothing.
- R9: The event registry gains `scope.captured@1`; `RunState.scope` folds
  from it; a run created before this element folds with `scope: null`.
  A new golden fixture `schema-1-02` is committed and the previous fixture,
  renamed `schema-1-01`, still opens and folds (D10).
- R10: Tests run against real repositories created with git: each mode;
  root commit; staged plus unstaged plus untracked at once; a deleted file;
  a rename (which appears as a delete and an add); an empty file; a binary
  file with a NUL; a non-ASCII path; a CRLF checkout with `core.autocrlf`;
  a symlink where the platform permits; an oversized file; each refusal;
  the race guard; each `compareWorktree` outcome; `paths` limiting; and
  `npm run check` and `npm run verify` green on all three CI runners.

## Decisions

- **D1: `to` must be HEAD; after bytes are always the worktree's.**
  Capturing an arbitrary range, as the proof of concept did, was rejected:
  the after state would then come from a commit while every later element
  (drift, editing, checks) works on the worktree, and the two would agree
  only by accident. Reviewing a commit that is not checked out means
  checking it out or adding a worktree. Revisit if a read-only review of
  unfetched history becomes a use case.

- **D2: Files over 8 MiB are recorded by hash and size only.** Freezing
  everything was rejected because a generated asset in a commit would copy
  itself into every checkpoint that reviews it. Such a file cannot hold a
  finding location and is compared by hash for drift. 8 MiB is above any
  source file and below most assets; revisit with evidence from real scopes.

- **D3: The inventory uses no rename detection; the patch does.** A rename
  in the inventory would be one entry with two paths, which every consumer
  (ownership, drift, locations) would have to special-case. As a delete and
  an add, each path is independent and its before and after bytes say the
  content moved. The patch keeps git's detection because that is what a
  reader expects to see.

- **D4: The scope is one event carrying the whole inventory.** One event
  per file was rejected: the inventory is captured atomically or not at
  all, and one fold step that sets `scope` is simpler than assembling it
  from thousands of steps. The 2000-path cap (R6) keeps the payload small.

- **D5: Before bytes are read through git's checkout filters.** Reading the
  raw blob was rejected because on a CRLF checkout the raw before is LF and
  the after is CRLF, so a byte comparison of the two would differ on every
  line, and the pilot's anchor rejection came from exactly this mismatch.
  `git cat-file --filters` yields the bytes the worktree would have held.

- **D6: Paths are stored as git reports them: forward slashes, exact
  bytes, no case folding.** Folding case here was rejected: whether two
  spellings are one file is a property of the filesystem an ownership check
  runs on, not of the change. That check, when it exists, folds; the record
  does not.

- **D7: Unmerged paths, gitlinks and embedded repositories are refused, not
  skipped.** Skipping was rejected because a scope that silently omits a
  file is a review that silently omits it. The proof of concept refused the
  same states and no pilot tripped on it.

- **D8: The race guard is HEAD, the index and the scope files' digests, not
  a hash of the whole tree.** The whole-tree hash was rejected as the drift
  measure (decided 2026-09-26) and for the same reason here: it walks every
  untracked byte and fails on a change that cannot affect the capture.

- **D9: `compareWorktree` reports and never decides.** Putting a policy
  here (fail on drift, ignore outside changes) was rejected because the
  right policy depends on the phase: a stray file during finders is noise,
  the same file during a check run may be the check's output.

- **D10: Golden fixtures are named `schema-<schema>-<serial>`, the serial
  advances when the registry changes, and older fixtures stay and must
  still open.** Replacing the fixture was rejected: an older-registry
  ledger opening under the newer engine is the forward-compatibility
  promise of 2a's D4, and keeping the fixture is the cheapest proof of it.

## Risks

- Risk: a scope's evidence can reach 2000 files times 8 MiB. Accepted; real
  scopes are far smaller, and both limits are one constant each.
- Risk: `git diff --no-index` against the null device differs across
  platforms. Accepted; the proof of concept ran it on Windows and CI runs
  it on all three.
- Risk: `git cat-file --filters` needs git 2.11 or later and follows the
  repository's attributes, so a `.gitattributes` change between capture and
  comparison changes what "before" would have been. Accepted; before bytes
  are frozen once, at capture.
- Risk: symlink handling cannot be tested on a Windows machine without
  developer mode. Accepted; the test skips there and runs on the Linux and
  macOS runners.
