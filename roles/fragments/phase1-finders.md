## Phase 1 — Find candidates (triage, then the nine other angles, up to 12 each)

Ten finder angles are defined below. `SCAN` runs first, as the triage
(Phase 1a); the engine then runs the nine other angles as independent
workers, in parallel (Phase 1b). Every angle runs on every review. What
a finder returns — the cap of 12, the four fields per candidate
(`file`, `line`, `summary`, and `failure_scenario` or `value_statement`
by angle group), the user-visible-consequence rule — is the **finder
output contract**, defined in this prompt. It is in every finder's role
prompt; it appears here because you consume what it specifies: Phase
2's dedup tiebreaks and verify grouping read those fields.

Do NOT let one angle's conclusions suppress another's — if two angles
flag the same line for different reasons, both are recorded. The source
rule is the same for all angles: surface every candidate you can
articulate. Finders that silently drop half-believed candidates bypass
the verify step and are the dominant cause of misses. For the
correctness & cost angles this means any nameable `failure_scenario`;
for the design & cleanup angles this means any nameable
`value_statement`, even a weak one ("would be cleaner" / "DRY").
**`CONVENTIONS` is the exception** — precision-first; see its angle
description. The verifier is the filter for every other angle, not the
finder.

The engine labels every candidate with a stable ID of `<ANGLE>-<n>`
(`SCAN-3`, `DESIGN-1`) as it arrives, numbered per angle in discovery
order. The ID follows the candidate through verification, merging and
the final report — including refuted candidates, which the report's
verification appendix lists by ID. A worker never assigns an ID.

### Phase 1a — Triage: `SCAN` runs first

The `SCAN` angle runs alone, before any other angle, as a single worker
whose prompt carries the scope block. That worker has two jobs:

1. **Its own review** — the line-by-line review described under `SCAN`
   below. Its findings enter the Phase 2 pool like any other angle's.
2. **One lead per other angle** — having read every hunk plus each
   enclosing function, `SCAN` finishes with the best view of what the
   diff actually contains. For EACH of the other nine angles it returns
   a lead: a concrete file, symbol or mechanism to inspect when the diff
   supports one ("the diff replaces 60 lines across three files"; "the
   new CachingProvider wraps SessionStore"), or nothing when none is
   apparent. Do not invent a lead when none is apparent. A lead is
   never a reason to skip an angle, and the absence of one never is
   either: every angle runs whatever the leads say.

### Phase 1b — The other nine angles run in parallel

The engine runs every other angle as a worker of its own, each prompt
opening with the same scope block, the angle to run, and one labeled
lead: `SCAN`'s lead for that angle as `SCAN lead`, its wording and
provenance preserved, or `Lead: none`. The receiving finder checks the
lead first and still performs the full angle search. No angle's findings
or conclusions are passed to another. The angle definition, the
lead-handling rule and the output contract are in the finder's role
prompt.

Each finder's return — its candidates verbatim, with IDs — is recorded
as it arrives. An angle whose worker does not complete is run once more
by a fresh worker; if that fails too, the angle is recorded as not run,
the report's Angles section says so, and the sweep (Phase 3) is told,
so that it can cover the angle's territory.
