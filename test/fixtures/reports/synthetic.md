# The uncommitted change on 22222222

deep-review recorded no account of this change, because an engine before this change reviewed it.

deep-review's review run run-1 has 2 findings. It changed no file and ran no check. It left 2 findings as is.

## What needs you

Nothing needs you. No fix against a written rule waits for your review, no question is open, and deep-review decided no fix.

## Before you merge

No check ran: this run only reviewed. The major findings stay open: finding 1. The footguns review pass did not run, and a later pass looked for what it would have found. No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible. Left as is: findings 1 and 2, with no decision, since an engine before the decision step reviewed this run.

## What deep-review would fix

deep-review decided to fix no finding.

## Findings

<a id="finding-1"></a>

### 1. null dereference

Left as is. Major, CONFIRMED.

- Where: src/a.ts:4 (RIPPLE-1; merged into it: SWEEP-2 at src/a.ts:7)
- Reason: same root cause at lines 4 and 7
- Evidence: line 4 dereferences null

<a id="finding-2"></a>

### 2. extract the helper

Left as is. Minor, PLAUSIBLE, which no verifier examined.

- Where: C:\elsewhere\b.ts:9 (unlocated: C:\elsewhere\b.ts:9; unverified) (SWEEP-1)
- Reason: one improvement
- Evidence: none; the verifier of this group failed twice

## What the review covered

The review passes that ran: first (SCAN), removals (REMOVALS), ripple effects (RIPPLE), wrappers (WRAPPERS), efficiency (EFFICIENCY), design (DESIGN), duplication (DUPLICATION), altitude (ALTITUDE) and conventions (CONVENTIONS).

- The footguns review pass (FOOTGUNS) did not run: 2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout. A later pass looked for what it would have found.
- No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible.
- Group g1 of sweep-verification was not verified (2 attempts did not complete: failed; failed again): its candidates are SWEEP-1, SWEEP-2.
- Unlocated candidates on a path the repository does not hold, or on a line past the end of an unchanged file: SWEEP-1 (C:\elsewhere\b.ts:9).

## Refuted at verification

None.

## About this run

Repository: /w
Base: 1111111111111111111111111111111111111111
Head: 2222222222222222222222222222222222222222
Mode: worktree
Run: run-1
Engine: 0.0.0+dev (run created by 0.0.0)
Runtime: claude 2.1.283 at /bin/claude
Models: strong opus, fast sonnet
Findings: 2 (1 CONFIRMED, 1 PLAUSIBLE); 0 refuted at verification
Findings by number: 1 RIPPLE-1 (also SWEEP-2); 2 SWEEP-1
Totals: 9 workers, 22.5 wall seconds, 4.50 USD; `deep-review report --stats` gives each phase
Evidence store: /w/.git/deep-review-checkpoint/artifacts; a name such as `artifacts/<hash>` in this report is the file `<hash>` in it.

- Worktree checks: 9, none found a difference from the reviewed change.
- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD.
- Workers with no reported cost: 1. A worker that times out, fails before the runtime prints its usage, or is lost with its engine reports none; the costs above leave such workers out, so the run cost more than the totals show. The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out.
- Lost with the engine: the worker of finder-WRAPPERS finders:WRAPPERS, and ran again.
