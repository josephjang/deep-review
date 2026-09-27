## Documentation drift

Report each documentation fact outside your ownership that your edits
made stale using this return field (omit it when there is no drift):

```
DRIFT   <file>:<what> — a fact outside your files that your change made stale
```

Name the stale fact and its replacement, including old and new member
names where relevant. **DRIFT does not authorize edits outside your owned files.**
If resolving an assigned finding itself requires another file, keep that
finding BLOCKED; a DRIFT line is not a substitute for completing it.
DRIFT records documentation made stale by edits, not disagreements with
the brief or proposals that have not been applied.

**When assigned documentation reconciliation:** read the full phase brief
and verify it against the current code. **Search the repository for renamed members and stale descriptions yourself, even when no DRIFT was reported.**
Update every affected document you own, respecting repository rules for
historical or append-only records; never invent shipped behavior from an
unanswered design question. Do not change code to make a document true.
Report required documents outside ownership as BLOCKED with exact paths
and evidence so the engine can extend the same cluster. Return a status
for every queued ID, including `APPLIED (already applied)` for facts you
verified are already correct, plus FILES, TESTS and SUITE evidence.
