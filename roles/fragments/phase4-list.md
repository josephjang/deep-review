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

**Give each finding a severity** in two steps: give it three values,
then read its severity from the table below. Each value is a fact of
the finding's evidence; when two values of one axis both fit, take the
lower and name the other in the reason.

Effect, what happens when the defect occurs:

- `loss`: data is lost or corrupted, or a secret or private data
  reaches someone who must not have it. For example, a log line that
  prints the user's token.
- `wrong`: a caller gets a wrong result, a contract it relies on
  breaks, or an operation the change promises fails: an error, a
  refusal, a hang, or a cost past a bound the code or its documents
  state. For example, an option renamed where it is defined that one
  caller still passes under its old name, so that caller's setting is
  silently ignored.
- `degraded`: the caller still reaches the right outcome, at a cost: a
  misleading message, a missing next step, or work slower than it
  needs to be within any stated bound. For example, a refusal that
  names the wrong file while it still refuses as it should.
- `none`: the behavior is right, and the cost falls on the next reader
  or the next change. For example, two copies of a helper that the
  next change can let drift apart.

Reach, who meets it:

- `always`: every use of what the change adds or alters. For example,
  a step that runs on every invocation.
- `ordinary`: a use that the documents, the tests or a caller in the
  repository make, under a condition such as an option, an input or a
  failure from outside. Input that an outside party controls is
  ordinary. For example, a flag that the README shows.
- `contrived`: only an input or a sequence that no documented use
  makes, or a later change. For example, a caller that catches an
  internal error and goes on as if it had not happened.

Recovery, what follows once it has happened:

- `visible`: the person who meets it sees it at once and can undo it
  or work around it alone. For example, a refusal that names the
  action to take.
- `operator`: it is seen, but undoing it needs a maintainer, an
  operator or a fix. For example, a crash that stops the command.
- `silent`: no one is told, or it cannot be undone. For example, a
  result written wrong with no error.

| effect \ reach | always   | ordinary | contrived |
|----------------|----------|----------|-----------|
| `loss`         | critical | critical | major     |
| `wrong`        | critical | major    | minor     |
| `degraded`     | major    | minor    | minor     |
| `none`         | minor    | minor    | minor     |

Then `silent` raises the severity one step and `visible` lowers it one
step; `operator` leaves it. An effect of `degraded` never reaches
`critical`, and an effect of `none` stays `minor`. The engine shows a
`critical` or `major` finding to the reader as what matters before the
merge, and folds a `minor` one into a table.

How sure the verdict is, how large the fix would be, which angle found
the finding, how old the code is and whether the change introduced the
defect decide no severity. A `CONVENTIONS` violation takes its effect
from what the rule's own reason says goes wrong when it is broken, or
`none` when the rule states no reason; when breaking it also has a
larger effect above, the violation takes that one. In each finding's
`reason`, name its effect, its reach and its recovery, each with the
fact of the evidence that gives it, say whether the change introduced
the defect, made it worse or found it there, and, for a finding with
members, name the root cause they share.

The engine, not the order you return, ranks the report: most-severe
first, then CONFIRMED before PLAUSIBLE, then, as a cross-class
tiebreak, correctness bugs, real `EFFICIENCY` costs and `CONVENTIONS`
violations before `DESIGN`, `DUPLICATION`, and `ALTITUDE` improvements
(a shipped defect beats a cleanup), then by ID. A later fix pass fixes
them in that order.

---
