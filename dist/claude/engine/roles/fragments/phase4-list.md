## Phase 4 — Findings list

After verification + sweep, you have the working list. **Keep every
CONFIRMED or PLAUSIBLE finding** — no cap. Every finding already carries
its `<ANGLE>-<n>` ID from Phase 1 (or `SWEEP-<n>` from Phase 3); the ID
stays with it into the final report so every item stays traceable to
the angle that found it.

**Merge same-root-cause findings across locations.** Phase 2's dedup
only collapses candidates at the same location, but one root cause often
surfaces at several sites (`RIPPLE` flags three call sites of the same
broken signature). Fold such findings into ONE item: keep the
best-described site as primary, name the other sites in the summary
("same root cause also at: …"), carry every merged finding's ID, and
escalate the merged verdict to CONFIRMED if any member was CONFIRMED.
Merge only on a genuinely shared root cause — same defect, one fix; two
defects that merely look alike stay separate.

**Give each finding a severity** by what it costs once the change is
merged as it is. The engine shows a `critical` or `major` finding to the
reader as what matters before the merge, and folds a `minor` one into a
table.

- `critical`: the harm reaches every user or cannot be undone: data is
  lost or corrupted, a hole in security opens, or the program or its
  build breaks for everyone. For example, a migration that drops a
  column the code still reads.
- `major`: the change gives a wrong result, breaks a contract that a
  caller relies on, or fails on a path its users reach, and someone
  must fix it before relying on the change. For example, an option
  renamed where it is defined that one caller still passes under its
  old name, so that caller's setting is silently ignored.
- `minor`: the code does what every caller needs, and the cost falls on
  the next reader or the next change. For example, two copies of a
  helper that the next change can let drift apart.

When a finding sits between two severities, ask whether a reviewer who
knew of it would hold the merge for it: held, `major`; merged and
followed up, `minor`. How sure the verdict is, how large the fix would
be, which angle found the finding and how old the code is decide no
severity. A `CONVENTIONS` violation is graded by these tests, applied
to what the rule's own reason says goes wrong when it is broken; a rule
that states no reason makes its violation `minor` unless breaking it
also breaks behavior. Say in each finding's `reason` which consequence
gives its severity.

The engine, not the order you return, ranks the report: most-severe
first, then CONFIRMED before PLAUSIBLE, then, as a cross-class
tiebreak, correctness bugs, real `EFFICIENCY` costs and `CONVENTIONS`
violations before `DESIGN`, `DUPLICATION`, and `ALTITUDE` improvements
(a shipped defect beats a cleanup), then by ID. A later fix pass fixes
them in that order.

---
