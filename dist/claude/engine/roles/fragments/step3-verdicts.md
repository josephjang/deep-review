**Operating principle — FIX what you can validate AND are authorized to change;
route genuine-but-discretionary or un-validatable refactors to NEEDS-STEERING so
the author is ASKED** (the fork below draws the line). Two defer
rationales almost never survive this pass — but "survive" means the finding is
KEPT (fixed OR asked), never silently dropped:

- *"No automated test covers it."* A behavior-preserving pure refactor (extract
  / move / inline / rename) is validated by the EXISTING tests passing — so it
  is SAFE to apply; run them. But safe is not authorized: if it fixes a flagged
  defect or is in-scope cleanup, FIX it (regardless of size); if it is a
  standalone design improvement, route it to NEEDS-STEERING and ASK rather than
  applying it automatically. A structural correctness fix is
  unit-testable even when one calibrated constant isn't: test the structure or
  formula you CAN assert (e.g. "the per-line model sums to MORE than the flat
  model," "the matched tab is copy-on-written and the others keep their
  reference") and defer only the pixel-perfect constant. "Can't assert the exact
  pixel / real-browser layout" never excuses skipping the model fix.
- *"Diff size / tedium / out of scope / freshly-landed code."* Never a reason to
  DROP a finding (already true in Step 1; re-assert it here). How size interacts
  with NEEDS-STEERING is governed by the fork below — size is never grounds to
  refute or silently skip.

**The fork is risk and scope, not size.** The FIX-NOW bar on a refactor is
"safe AND validatable AND in-scope" — behavior-preserving with regressions you
can rule out now (existing tests pass, or a new non-tautological test does), AND
it either fixes a flagged defect or cleans up code the change already touches.
Apply THAT however large or tedious it is. A refactor goes to NEEDS-STEERING
(the author is ASKED, not overruled) when it fails that bar for one of two
reasons: it carries
regression risk you cannot validate now (high blast radius with only shallow
coverage; subtle timing/ordering or concurrency semantics), or its value is
genuinely discretionary scope the author should own (a restructuring that
expands this change rather than fixing a flagged defect). Size is a signal these
may be present, never the criterion itself: a large but mechanical,
fully-validatable refactor that fixes a flagged finding is FIX-NOW; a
discretionary restructuring is NEEDS-STEERING even when it is small. Never
REFUTE a real improvement for its size.

For proposed edits in FIX-NOW verdicts and steering options:
**Anchor each existing edit by file, member and quoted code; a line number alone is not an edit target.**
The tree can move before a fixer acts. Use a qualified member name and
enough quoted context to distinguish overloads or repeated statements;
for documents/configuration, use a unique heading or key instead of a member.
**For additions, identify the existing insertion anchor or explicitly name a new file and verify its expected absence.**
Do not fabricate a quote from a member or file that does not exist yet.

The three verdicts, exactly one per finding:

- **FIX-NOW** — re-verified as real and fixable now. MUST include the exact edit
  (anchored as above, old→new) AND the concrete validation plan below.
  "Fixable now" = concrete, low-risk, validatable,
  AND in-scope — it fixes a flagged defect or cleans up code the change already
  touches (a safe, validatable, but scope-expanding refactor is NEEDS-STEERING,
  not FIX-NOW, per the fork). Validatable = existing tests for a refactor; a new
  non-tautological unit test for a structural/correctness fix.
- **REFUTE** — on closer reading it is NOT real, cannot occur, or the fix would
  trade one smell for a worse one. MUST prove it with the code (cite the
  invariant / type / guard / lifecycle / single-writer / strict-`>` cursor that
  makes it safe) — not a restatement of the Step 1 defer rationale, and never
  merely that the bug is pre-existing or that a test exists/passes. Subject every
  refute to the *"verify before you judge"* gate: confirm the premise (read
  the source / run a probe), never assume it — if you can't, return FIX-NOW or
  NEEDS-STEERING. Per the fork, never REFUTE a feasible refactor for its size;
  refute a design finding only when the improvement itself fails (coincidental
  similarity, the construct documents intent / earns a test seam, the unified
  version reads worse, the benefit doesn't survive the code) or the target is
  *infeasible* (won't compile, consumers can't all route through it).
- **NEEDS-STEERING** — survives as a genuine decision a human must make: EITHER
  (a) a product/behavior call (which of two correct behaviors to converge on; a
  public-API contract whose consumers you cannot audit) OR (b) a genuine refactor
  that fails the FIX-NOW bar for risk or scope per the fork — route it here, not
  to REFUTE. State the precise question and the concrete options with their
  tradeoffs — for a refactor, give explicit PROS (what gets easier / stops
  drifting / becomes mechanically safe) and CONS (blast radius, regression
  surface, test-coverage gaps, indirection cost) — and recommend one with a
  reason. Per the *"verify before you judge"* gate, route a refactor here only
  once you've confirmed it is feasible (an unworkable target is REFUTE); carry
  that confirmed target into the options + "how to apply" so the chosen path is
  mechanical, not a fresh design problem.

**For each FIX-NOW, name the validation method and exact test file/member.**
For a structural/correctness fix, specify a new non-tautological assertion
and the defect it detects. Prefer a behavioral failure against the current
code. **When a new test cannot compile because it names an introduced member, specify a semantic mutation that keeps that member available.**
Name the piece of the fix to reverse and the assertion that should fail
for the finding's stated reason. Removing the new API or breaking the
test harness proves nothing about the behavior. The fixer must observe
the fixed test pass, the intended assertion fail under the mutation,
and the restored fix pass; an auditor's proposed outcome is not a run.

**For a behavior-preserving refactor, name the existing tests that cover the affected behavior; no artificial failing assertion is required.**
Source checks may validate a specific structural invariant, but do not
substitute for runtime coverage of changed behavior. If no meaningful
validation is available, retain the risk/scope fork above and route the
unvalidatable change to NEEDS-STEERING; missing new members alone are not
evidence of a behavioral failure or grounds to REFUTE the finding.
