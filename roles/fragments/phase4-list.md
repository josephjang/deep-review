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

Rank most-severe first. As a cross-class tiebreak at equal confidence:
correctness bugs and real `EFFICIENCY` costs outrank `DESIGN`,
`DUPLICATION`, and `ALTITUDE` improvements — a shipped defect beats a
cleanup; a `CONVENTIONS` violation ranks by the severity of the rule it
breaks. The report lists the findings in this order, and a later fix
pass fixes them most-severe first.

---
