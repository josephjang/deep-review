# The uncommitted change on 22222222

deep-review recorded no account of this change, because an engine before this change reviewed it.

deep-review's fix run run-1 has 2 findings. It fixed 1 in your working tree. It left 1 finding as is.

## What needs you

Before a merge: 1 document out of date and 3 patches to commit. The edits of this run made no check fail, and the run left no work unfinished.

1. **`README.md` is out of date.** Parse no longer throws on null (a fixer). The documentation step did not run: an engine before the documentation step configured this run. If you do nothing, the document stays out of date.
2. **Review the 3 uncommitted patches, then commit them.** If you do nothing, the fixes stay uncommitted in your working tree. To commit them: `deep-review commit --run run-1`.

Ask your agent with the deep-review skill to run a command, or type it at a terminal as the end of the report shows. `deep-review report --run run-1 --finding <number>` prints any finding.

## Before you merge

| Check | As submitted | Last run | What it means |
|---|---|---|---|
| [build](#check-build) | passed | passed, after the fixes for the checks | passes |
| [lint](#check-lint) | passed | passed, after the fixes for the checks | passes |
| [test](#check-test) | failed | failed, after the fixes for the checks | fails |

The footguns review pass did not run, and a later pass looked for what it would have found. No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible. No typecheck check ran: nothing names it. Left as is: finding 2, held for the author.

## What deep-review fixed

| Finding | The fix | How its fixer reports checking it | Patch |
|---|---|---|---|
| [1](#finding-1), major | fix: Guard the null in parse | a new test fails on the code before the fix | 2 |

## Findings

<a id="finding-1"></a>

### 1. null dereference

Fixed. Major, CONFIRMED.

- Where: src/a.ts:4 (RIPPLE-1; merged into it: SWEEP-2 at src/a.ts:7)
- Reason: same root cause at lines 4 and 7
- Evidence: line 4 dereferences null
- Fix: applied; guarded the null before its use
- Commit message: fix: Guard the null in parse
- Patch: 2
- Correction: src/a.ts parse: parse is at line 4 -> it moved to line 6 (git blame)
- Validation, as its fixer reports it: old-code, test/a.test.ts: failed on the old code for the null, passed on the fix

<a id="finding-2"></a>

### 2. extract the helper

Left as is. Minor, PLAUSIBLE, which no verifier examined.

- Where: C:\elsewhere\b.ts:9 (unlocated: C:\elsewhere\b.ts:9; unverified) (SWEEP-1)
- Reason: one improvement
- Evidence: none; the verifier of this group failed twice
- Fix: held for the author; a run configured before the decision step held a PLAUSIBLE finding of a design angle, and no fixer saw it.

## Documentation updates

The documentation step did not run: an engine before the documentation step configured this run.

Documentation the workers of this run say their edits made stale, which no step of this run took:

- README.md: parse no longer throws on null (c1-1)

## Checks

<a id="check-build"></a>

### build

- Command: `npm run build`
- As submitted: passed, 4.0 s
- After the fixes: passed, 4.0 s
- After the fixes for the checks: passed, 4.0 s

<a id="check-typecheck"></a>

### typecheck

- Command: not available (none: nothing names it)

<a id="check-lint"></a>

### lint

- Command: `npm run lint`
- As submitted: passed, 4.0 s
- After the fixes: failed, 4.0 s; output artifacts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, artifacts/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
- After the fixes for the checks: passed, 4.0 s
- Its fix: applied, formatted the guard; patch 3

<a id="check-test"></a>

### test

- Command: `npm run test`
- As submitted: failed, 4.0 s; output artifacts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, artifacts/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
- After the fixes: failed, 4.0 s; output artifacts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, artifacts/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd (failing before the fix pass)
- After the fixes for the checks: failed, 4.0 s; output artifacts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc, artifacts/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd (failing before the fix pass)
- Its fix: deferred, every failure was there before the fixes; no patch

## Patches

The patch series, one patch per change, applies in order to a tree at the scope with `git am --keep-cr`:

1. chore: apply the lint check's rewrite (the lint check), src/a.ts modified: artifacts/1111111111111111111111111111111111111111111111111111111111111111
2. fix: Guard the null in parse (finding 1, c1-1), src/a.ts modified, test/a.test.ts created: artifacts/2222222222222222222222222222222222222222222222222222222222222222
3. style: Format the guard (repair), src/a.ts modified: artifacts/3333333333333333333333333333333333333333333333333333333333333333

Tests the fixers say they added or tightened:

- test/a.test.ts: parse(null) returns 0 (c1-1)

## What the review covered

The review passes that ran: first (SCAN), removals (REMOVALS), ripple effects (RIPPLE), wrappers (WRAPPERS), efficiency (EFFICIENCY), design (DESIGN), duplication (DUPLICATION), altitude (ALTITUDE) and conventions (CONVENTIONS).

- The footguns review pass (FOOTGUNS) did not run: 2 attempts did not complete: failed: The answer does not match the output schema; timeout: The worker ran past its timeout. A later pass looked for what it would have found.
- No verifier examined finding 2 and a candidate merged into finding 1; it counts as plausible.
- No typecheck check ran: nothing names it.
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
Fix pass: 1 applied, 0 already applied, 0 deferred, 0 blocked, 0 not attempted, 1 held for the author; 3 patches; the edits are in the working tree, uncommitted
Totals: 9 workers, 22.5 wall seconds, 4.50 USD; `deep-review report --stats` gives each phase
Evidence store: /w/.git/deep-review-checkpoint/artifacts; a name such as artifacts/<hash> in this report is the file <hash> in it.

- Worktree checks: 16, none found a difference from what the run expected.
- Run budget: 30.00 USD, checked before every launch; spent 4.50 USD.
- Workers with no reported cost: 1. A worker that times out, fails before the runtime prints its usage, or is lost with its engine reports none; the costs above leave such workers out, so the run cost more than the totals show. The budget check counted each such worker at its per-worker cap, except a worker lost with its engine, which it could not price and left out.
- Files no answer names, left in the tree and in no patch: notes.txt.
- Fixer c1-1 ran its own suite: pass (npm test).
- The repair ran its own suite: pass (npm test).
- Lost with the engine: the worker of finder-WRAPPERS finders:WRAPPERS, and ran again.
