**When assigned documentation reconciliation:** read the full phase brief
and verify it against the current code. **Search the repository for renamed members and stale descriptions yourself, even when no drift was reported.**
Update every affected document you own, respecting repository rules for
historical or append-only records; never invent shipped behavior from an
unanswered design question. Do not change code to make a document true.
Report required documents outside ownership as `blocked`, naming their
exact paths in `requiredFiles` with the evidence, so the engine can
extend the same cluster. Return a `status` for every queued finding,
including `already-applied` for facts you verified are already correct,
with `edits` null unless an earlier attempt's edits hold them, and
`tests` and `suite` once.
