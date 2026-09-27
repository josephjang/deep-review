## Phase 1 — Find candidates (triage, then chosen angles, up to 12 each)

Ten finder angles are defined below: `SCAN` runs first as the triage
(Phase 1a), then you choose the set and fan out (Phase 1b). Every angle
that runs is an independent `Agent` call, using its `subagent_type`
from the tier table above. What a finder returns — the cap of 12, the
four fields per candidate (`file`, `line`, `summary`, and
`failure_scenario` or `value_statement` by angle group), the
user-visible-consequence rule — is the **finder output contract**,
defined after the angles. It is in every finder's agent definition, so
do not restate it in prompts; it appears here because you consume what
it specifies: Phase 2's dedup tiebreaks and verify grouping read those
fields.

Do NOT let one angle's conclusions suppress another's — if two angles
flag the same line for different reasons, record both. The source rule
is the same for all angles: surface every candidate you can articulate.
Finders that silently drop half-believed candidates bypass the verify
step and are the dominant cause of misses. For the correctness & cost
angles this means any nameable `failure_scenario`; for the design &
cleanup angles this means any nameable `value_statement`, even a weak one
("would be cleaner" / "DRY"). **`CONVENTIONS` is the exception** —
precision-first; see its angle description. The verifier is the filter
for every other angle, not the finder.

Label every candidate with a stable ID of `<ANGLE>-<n>` (`SCAN-3`,
`DESIGN-1`) as it arrives, numbered per angle in discovery order. The ID
follows the candidate through verification, merging, fixing, and the
final report — including refuted candidates, which the report's
verification appendix lists by ID.

### Phase 1a — Triage: run `SCAN` first

Run **the `SCAN` angle alone**, before any other angle, as a single
`Agent` call (`subagent_type: "deep-review-lead"`) whose prompt opens
with the Phase 0 scope block. The prompt carries two jobs:

1. **Its own review** — the line-by-line review described under `SCAN`
   below. Its findings enter the Phase 2 pool like any other angle's.
2. **An angle recommendation** — having read every hunk plus each
   enclosing function, `SCAN` finishes with the best view of what the
   diff actually contains. For EACH of the other nine angles it returns
   `run` or `skip` with a one-line reason grounded in what it saw ("run —
   the diff replaces 60 lines across three files"; "skip — no wrapper,
   cache, proxy, decorator, or adapter type is added or modified"). Paste
   the full descriptions of the other nine angles below into its prompt
   so it knows exactly what each angle hunts. A `skip` reason must cite
   the concrete absence of the angle's subject matter from the review
   scope — never expected yield, diff size, or effort.
   **For a run recommendation, name a concrete file, symbol or mechanism to inspect when the diff supports one.**
   Do not invent a lead when none is apparent.

### Phase 1b — Vet the recommendation, choose the set, run it in parallel

The `SCAN` angle's recommendation is advisory input — the decision is
yours, and you must be able to defend every skip in the final report.

- **Default is run.** This is a maximum-effort review: skip an angle ONLY
  when its subject matter is provably absent from the review scope and
  you can verify that absence yourself from the Phase 0 diff. Low
  expected yield, diff size, and agent cost are never skip reasons.
- **Spot-check every `skip` against the diff** before accepting it.
  `SCAN` claims "the diff deletes nothing" → check the hunks for removed
  lines; it claims "no CLAUDE.md governs the changed files" → check
  user-level, repo-root, and ancestor directories yourself. If the cited
  absence doesn't hold, override to run.
- **Override in either direction** when the evidence disagrees — run an
  angle `SCAN` skipped, or (rarely) skip one it recommended if its cited
  reasoning is demonstrably wrong — and note each override.
- Absence tests that legitimately justify a skip: **`REMOVALS`**
  — the diff deletes or replaces nothing (pure additions); **`WRAPPERS`**
  — no wrapper, cache, proxy, decorator, or adapter type is added or
  modified; **`CONVENTIONS`** — no CLAUDE.md governs any changed file;
  **`RIPPLE`** — every changed symbol is demonstrably file-local with no
  outside callers (confirm with Grep, not assumption). **`FOOTGUNS`,
  `EFFICIENCY`, `DESIGN`, `DUPLICATION`, `ALTITUDE`** apply to
  essentially any nontrivial code diff — skip them only when the scope
  contains no code at all (docs-only or config-only changes) or an
  equally provable absence.

**A RIPPLE skip must also rule out shared contracts clarified or fixed at changed call sites.**
A changed function being file-local does not establish that absence:
the callee whose contract it uses may have other, unchanged consumers.

Record a per-angle decision log — angle, run/skip, one-line reason, and
whether you overrode the `SCAN` recommendation — you will reproduce it in
the final report's Angles section.

Then run every chosen angle as parallel `Agent` calls, all in a single
message block — each with its angle's `subagent_type` from the tier
table, each prompt opening with the same Phase 0 scope block. A finder
prompt contains the scope-block pointer, the angle to run, and one labeled
lead. **Pass SCAN's one-line run reason for that angle as `SCAN lead`.**
Preserve its wording and provenance; the receiving finder checks it first
and still performs the full angle search. Do not pass other angles'
findings or conclusions. The angle definition, lead-handling rule, and
output contract are in the agent's own definition; do not restate them.

**An overridden skip uses the driver's verified reason labeled `Driver lead`, not an invented SCAN run reason.**
**No concrete lead available: send `Lead: none` and still run the chosen angle.**
Record the dispatched lead and its source in the per-angle decision log
alongside the run/skip decision and any override, so resumed dispatches
use the same evidence. A missing lead is not grounds to skip an angle.

Checkpoint `triage.md` — `SCAN`'s full return plus the decision log —
in the same block as that dispatch. As each finder returns, append its
`## <ANGLE>` section (its candidates verbatim, with IDs) to
`candidates.md`, terminated, under the checkpoint discipline above; do not
wait for another return just to batch the write.
