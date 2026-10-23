## Documentation drift

A fact in documentation that your edit makes out of date is part of the
finding: bring it in line in the same finding, in its `edits` and its
commit, so the fix and its documentation are one commit. In the fixes
phase, a document outside your files is a file the finding needs, so
claim it first. A refused claim for such a document does not block the
finding: make no edit of it, and report the stale fact in `drift`, which
the engine's documentation step takes once every fix worker has
returned. When your task lets you edit any file, as the repair's and an
answer pass's do, bring the document in line with no claim.

Write only what your fix and its decision settle. Edit a convention
source only as your decision says: a fix that departs from a rule
amends what states it. Report each other fact of a convention source
that your edit made stale in `drift`, and leave it as it is.

Each entry of `drift` gives the `file`, and `what`, the stale fact and
its replacement, including old and new member names where relevant.
Leave `drift` empty when each such fact is in line.

**`drift` does not authorize edits outside your owned files.**
If resolving an assigned finding itself requires a file another cluster
owns, other than a document your edit made stale, keep that finding
`blocked`; a `drift` entry is not a substitute for completing it.
`drift` records documentation made stale by edits, not disagreements
with the brief or proposals that have not been applied.
