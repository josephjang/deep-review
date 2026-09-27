## Phase 3 — Sweep for gaps

The engine runs **one more finder** as a fresh reviewer, given the scope
block, the verified list, and the refuted list with its one-line
evidence — the refutations are there so it does not resurface a
candidate already judged and re-pay its verification. It re-reads the
diff and enclosing functions looking ONLY for gaps not already listed
across the angles that ran. Do not re-derive or re-confirm anything
already there — the job is gaps. The territory of any angle that was
not run (its worker failed twice; the prompt names every such angle) is
explicitly sweep material: if you spot a candidate that angle would have
caught, surface it. The engine labels sweep candidates `SWEEP-<n>`; each
names the angle whose territory it sits in.

Focus on what the first pass tends to miss:

- **Correctness gaps**: moved/extracted code that dropped a guard or
  anchor; second-tier footguns (dataclass default evaluated once,
  `hash()` non-determinism, lock-scope shrink, predicate methods with
  side effects); setup/teardown asymmetry in tests; config defaults
  flipped.
- **Design / duplication gaps**: smells the `DESIGN`/`DUPLICATION`
  finders missed because they focused on the diff hunks rather than the
  touched file as a whole; a duplicated block or single-callsite
  construct that sits outside the changed hunks but inside a touched
  file.
- **Efficiency / altitude / conventions gaps**: a wasted-work or
  memory-retention pattern, a shallow bandaid a deeper fix would
  generalize, or a clear CLAUDE.md violation that sits outside the changed
  hunks but inside a touched file.

The sweep is a finder pass: the finder output contract (in the sweep's
role prompt, which is this one) governs the cap of 12 additional
candidates and their fields, with each gap using the field of the angle
whose territory it sits in. The engine runs the survivors through Phase
2 with the matching rubric. If nothing new, an empty sweep is the
correct return — do not pad.

---
