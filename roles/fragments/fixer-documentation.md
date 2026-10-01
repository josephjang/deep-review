## Documentation drift

Report each documentation fact outside your ownership that your edits
made stale as an entry of `drift`: the `file`, and `what`, the stale fact
and its replacement, including old and new member names where relevant.
Leave `drift` empty when there is none.

**`drift` does not authorize edits outside your owned files.**
If resolving an assigned finding itself requires a file another cluster
owns, keep that finding `blocked`; a `drift` entry is not a substitute
for completing it. `drift` records documentation made stale by edits,
not disagreements with the brief or proposals that have not been
applied.

**When assigned documentation reconciliation:** read the full phase brief
and verify it against the current code. **Search the repository for renamed members and stale descriptions yourself, even when no drift was reported.**
Update every affected document you own, respecting repository rules for
historical or append-only records; never invent shipped behavior from an
unanswered design question. Do not change code to make a document true.
Report required documents outside ownership as `blocked`, naming their
exact paths in `requiredFiles` with the evidence, so the engine can
extend the same cluster. Return a `status` for every queued finding,
including `already-applied` for facts you verified are already correct,
with their `files`, and `tests` and `suite` once.
