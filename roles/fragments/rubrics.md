### Rubric for the correctness & cost angles

- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash; for `EFFICIENCY`, the concrete wasted work or
  retained memory and the scale/frequency at which it bites. Quote the
  line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config, scale). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that), provably
  impossible (type/constant/invariant — show it), already handled in this
  diff (cite the guard), or pure style with no observable effect; for
  `EFFICIENCY`, no real cost (the work is trivial, off any hot path, or
  the captured scope holds nothing large).

**PLAUSIBLE by default for correctness & cost** — do not refute a
candidate for being "speculative" or "depends on runtime state" when the
state is realistic:
concurrency races, nil/undefined on a rare-but-reachable path (error
handler, cold cache, missing optional field), falsy-zero treated as
missing, off-by-one on a boundary the code does not exclude, retry
storms / partial failures, regex/allowlist that lost an anchor, and — for
`EFFICIENCY` — a cost that bites only at a scale the input can plausibly
reach (a list that grows unbounded, a hot path hit per keystroke or per
request). These are PLAUSIBLE.

**Never grounds for REFUTED** — the *age* of the code (pre-existing, in
scope per Post-review Step 1; or freshly-landed) and its *test coverage* (a
test exists, or passes — a green test can assert the bug or never hit the
case) say nothing about correctness. Neither can carry a REFUTED, and pairing
one with a real reason adds nothing; refute only on a substantive, code-level
reason from the list above.

### Rubric for the design & cleanup angles

The finder surfaced broadly — **you are the filter**. Read the
candidate's `value_statement` as the improvement claim and judge whether
it holds. **Do not default to PLAUSIBLE for design & cleanup** — that
posture applies to the correctness & cost angles only. For design &
cleanup findings you must be able to reconstruct a concrete improvement
to keep the finding; otherwise REFUTE.

- **CONFIRMED** — the refactor/extraction/inline would clearly improve
  the code today; you can name the resulting structure; you can point to
  the specific file(s) and line(s) the change touches; the
  `value_statement` accurately describes what gets better; AND it is
  in-scope — it fixes a flagged defect or cleans up code the change
  already touches, not a discretionary restructuring that expands beyond
  this change (those are PLAUSIBLE, per the split below).
- **PLAUSIBLE** — the improvement is real and reconstructable, but whether
  to apply it is a judgment a human should own for a reason that survives
  the "never grounds" list below: it turns on taste or on future direction
  the verifier can't see, OR it changes OBSERVABLE BEHAVIOR / semantics the
  current tests don't cover and you cannot pin with a new test, OR it is
  discretionary scope that expands this change rather than fixing a flagged
  defect. Such a refactor carries forward and surfaces as a Step 3
  NEEDS-STEERING item with clear pros/cons and a recommendation.

  A behavior-preserving refactor (extract, move, inline, rename, centralize
  a duplicated rule) is validatable — the existing test suite + typecheck
  confirm it preserves behavior — so it is SAFE to make. But being SAFE does
  not by itself decide CONFIRMED vs PLAUSIBLE; that turns on whether there
  is a real "should we, and how far?" judgment:
    - a CLEAR win with no such judgment — in-scope cleanup of code the change
      already touches (a dead branch, a misleading name, an obvious local
      duplicate) — is CONFIRMED, and Step 1 applies it with NO steering; a
      CONFIRMED refactor needs no authorization.
    - a DISCRETIONARY call — a restructuring that expands beyond this change
      (split a component, extract a subsystem, inline a standalone module),
      whose worth/scope is the author's to weigh — is PLAUSIBLE, and routes to
      NEEDS-STEERING so Step 3 ASKS (with pros/cons + a recommendation).

  Either way the real refactor is KEPT — applied (CONFIRMED) or asked
  (PLAUSIBLE), never quietly dropped. "Validatable" forbids REFUTING it for
  risk/coverage; it does NOT auto-promote a scope-expanding restructuring to
  CONFIRMED.
- **REFUTED** — any of:
  - coincidental similarity (not real duplication);
  - the single-callsite construct actually documents intent or earns a
    test seam;
  - the refactor would trade one smell for a worse one (e.g. a shared
    helper that needs so many config knobs it reads worse than the focused
    copies);
  - the altitude finding's "deeper" version is speculative
    over-engineering, or trades a clear, correct local fix for a murkier
    abstraction;
  - the `value_statement` is vague ("cleaner," "DRY," "more idiomatic"
    with no specific benefit) AND you cannot reconstruct a concrete
    improvement from the candidate, the diff, or the touched files;
  - the `value_statement` is specific but doesn't survive contact with
    the code — the claimed benefit isn't actually delivered.

  **Never grounds for REFUTED (design & cleanup)** — none of these can
  kill a real improvement, only route it:

  - *Scale.* Big, risky, or spans-many-files is exactly the
    NEEDS-STEERING judgment — keep the finding PLAUSIBLE and let Step 3
    route it to a human with pros/cons + a recommendation.
  - *Regression risk / test coverage / documentation density.* "Heavily
    tested / heavily commented / load-bearing" makes a refactor SAFER to
    take on (the tests catch a regression; the comments move with the
    code), not skippable.
  - *"Works today."* A refactor's job is to make the design cleaner or an
    invariant mechanical, not to fix a live bug.

  REFUTE only when the improvement itself fails one of the reasons above
  (not-real, worse-smell trade, vague/unreconstructable,
  doesn't-survive-contact). A real but discretionary refactor is neither
  refuted nor dropped: routing it to the author via NEEDS-STEERING is the
  CORRECT outcome, not a failure to avoid.

### Rubric for the CONVENTIONS angle

`CONVENTIONS` is precision-first, so the verifier mostly confirms what the
finder already quoted.

- **CONFIRMED** — the cited CLAUDE.md genuinely governs the changed file
  (user-level, repo-root, or an ancestor directory of that file) AND the
  quoted line breaks the quoted rule. Both quotes present and accurate.
- **PLAUSIBLE** — the rule governs and the line looks like a violation, but
  whether it actually breaks the rule turns on a reading the verifier can't
  settle alone. State the ambiguity.
- **REFUTED** — the cited rule doesn't govern this file (an out-of-scope
  CLAUDE.md), the line doesn't actually violate it, or the "rule" is the
  finder's own style preference rather than something a CLAUDE.md states.

### All rubrics — verify before you judge

**A verdict that CLOSES a finding must rest on something you confirmed in the
code, not assumed — in both directions.** This single gate governs every
refute and every refactor call, here and in Step 3:

- **Before you REFUTE** (any angle): the refutation's premise — "this path is
  unreachable," "the library strips the trailing newline," "these two blocks are
  coincidental and will diverge" — must be *confirmed*, not asserted. Read the
  implementation, or run a throwaway probe that exercises the exact case, and
  cite the evidence. If you cannot confirm it, do NOT refute: keep the finding
  (PLAUSIBLE for correctness, cost & conventions; for design & cleanup
  keep it as a steering candidate) and note what needs checking.
- **Before you keep a refactor as a real improvement** (PLAUSIBLE here, or any
  Step 3 NEEDS-STEERING): confirm it is *feasible*. Sketch the concrete target
  (the new signature / module boundary / resulting structure) and check it (1)
  actually delivers the `value_statement`, (2) does not trade for a worse smell,
  and (3) is mechanically applicable from what you can see. An unworkable target
  — won't compile cleanly, the consumers can't all route through it, the unified
  version reads worse — is REFUTE ("doesn't survive contact"), not a finding to
  carry forward or a decision to hand a human.

The throughline: never DROP a finding on an unverified premise, and never ASK a
human to decide on (or carry forward) a refactor you have not shown can be done.
When unsure, verify — don't guess a verdict.
