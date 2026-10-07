# Technical Design: Decision step

Product part: [2026-10-08-decision-step.requirements.md](2026-10-08-decision-step.requirements.md).

## Summary

One phase, `decision`, joins the review's fixed order between
`merge-rank` and `baseline-checks`. It is a reading phase like
`merge-rank`: one unit, keyed by the phase's name, run by a `decider`
worker, read-only with a shell, and the planner's generic rules launch,
retry, block and await it. Its answer is one `decisions.recorded@1`
event that the fold keeps as `ReviewState.decisions`, one decision per
ranked finding in the ranking's order. The fix plan routes each finding
by its decision through one rule, `routeOfDecision`, which the fold also
holds a recorded plan to; `routeOf` and its `Route` type are gone. A
fixer's task carries the decision, every merged candidate's own verdict
and evidence, and the findings left as superseded by it. The report
gains a Decisions section after the header and a decision line per
finding, rendered by a new module beside the survey's and the fix
pass's. The phase list is frozen in the events, so the six kinds that
carry a phase get a version 4, and the configuration's version 5, with
version 4's payload, is what says a run decides; every older
configuration folds with the phase skipped.

## Non-Goals

As the requirements state them. Technically: no change to the fix
plan's event (`fixes.planned@1` keeps its `fixer` and `held` routes), to
merge and rank's output or to the verifier's schema; no new blocker
code; no answer command, memory or adversarial decider.

## Context

What the change works against, as the code stood at `1811a86`:

- **The phase list is frozen in the events.** `phase.started`,
  `phase.finished`, `worktree.checked`, `attempt.failed`, `worker.lost`
  and `report.written` each carry a phase from a vocabulary frozen in
  `events.ts`, and `events-vocabulary.test.ts` holds the newest frozen
  copy equal to today's. A sixteenth phase is a version 4 of all six.
- **A phase opens only after every earlier one settled.** `phaseStarted`
  refuses a phase while an earlier one is `pending`. A ledger recorded
  before the step has `merge-rank` followed by `baseline-checks` or
  `report`, so for such a run the new phase must be `skipped` from its
  configuration on, as the survey was for runs before it.
- **Three places hold the role set**: `reviewRoles` in `vocabulary.ts`,
  `roles/policy.json`, which `resolvePolicy` holds to exactly those
  roles, and the manifest, which must declare each.
- **Exhaustive switches over phases and roles**: `taskFor` and
  `contributionEvent` in `phases.ts`, `unitsOf` and `degradationOf` in
  `steps.ts`, `outputSchemaOf` in `schemas.ts`, and the golden script's
  `Record<Phase, number>`. Each fails to compile until it has a case.
- **The fakes answer by role.** `defaultOutput` in
  `test/helpers/fake-runtime.ts` gives every role an empty valid answer;
  without one for the decider, every whole-run test would block.
- **Routing lived in `routeOf`** (`src/review/fixes.ts`): verdict and the
  primary's angle. The replay used it for each candidate's outcome, and
  the scored outcome a label asks for (`labeledOutcome`) is defined
  against that rule.

## Design

### Phases (R1)

`phases` gains `decision` after `merge-rank`. It is in none of the
groups (`fixPhases`, `checkPhases`, `editingPhases`, `candidatePhases`,
`deduplicationPhases`, `verificationPhases`), since it runs no check,
edits nothing and records no candidate, deduplication or verdict.
`singleUnitKey('decision')` is `decision`. The controller needs nothing
phase-specific: the drift check before an answer, the budget block and
the lost-worker rules apply as for `merge-rank`.

### Role and policy (R1)

`reviewRoles` gains `decider` before `fixer`; the policy names it with
the strong tier, high effort, 8 USD and 1800 s. The manifest assembles it
from `decider-brief.md`, `worker-scope.md`, `lead-verify.md`,
`rubrics.md` and `decider-rubric.md`: the verifier's rubrics, so the
decider reads each grade as the verifier meant it, and its own rubric
last.

### Task and output schema (R2, R3)

`deciderTask` (`tasks.ts`) numbers `deciderFindings(review)`, the ranked
findings in the engine's order, each with its id, severity, merged
verdict, merge and rank's summary and reason, and every candidate,
primary first, as a `TaskCandidate`: angle, location as
`describeLocation` writes it, summary, detail, own verdict and own
evidence. The text is the one the experiment measured.

`deciderOutputSchema` (`schemas.ts`) is one entry per index: `decision`,
`grounds`, and `fix`, `leave`, `ask` and `departure`, each nullable, as
`compileOutputSchema` requires every field be. `checkDecisions` holds
what the schema cannot: each index once and in range; exactly the part
the decision names non-null; a departure only on a fix; an ask's
recommended and applied indexes among its options; `supersededBy`
exactly for `superseded`, naming another index decided `fix`. A refusal
is a failed attempt, as for every role.

### Ledger events and fold (R10)

- `reviewVocabularyV4` freezes the sixteen phases, the decision kinds
  and the leave reasons. The six phase-carrying kinds get a version 4
  over them; `phase.finished@4` reuses version 3's blocker, which the
  step does not widen. The exported types `PhaseStarted`,
  `PhaseFinished`, `WorktreeCheckV4`, `AttemptFailed`, `WorkerLost` and
  `ReportWritten` move to version 4, so the controller cannot write an
  older one.
- `review.configured@5` is version 4's schema object. `configure` takes
  `decided` beside `surveyed`; versions 1 to 4 pass false and record the
  phase skipped, version 5 passes true.
- `decisions.recorded@1` is `{ workerId, decisions }`, each decision by
  its finding's primary id, `supersededBy` an id too. Its schema holds
  each decision's parts to its kind and the ids to be unique; the
  reducer holds the rest: the phase running, recorded once, its unit
  unanswered, the decided ids exactly the ranked ones, and a superseding
  id another finding decided `fix`. It stores them in the ranking's
  order and answers the unit.
- `fixes.planned@1` keeps its shape. Its reducer, for a run whose
  decision is not skipped, refuses a plan recorded before any decision
  when findings were ranked, and a route `routeOfDecision` would not
  give.

### Routing and the plan (R6)

`routeOfDecision` lives in `fix-state.ts`, where both the planner and
the fold can import it without a cycle: `fix` to `fixer`, `leave` to
`held`, `ask` by whether its applied option edits. `planFixes` takes the
decisions and throws for a ranked finding with none. `fixPlanOf` passes
`review.decisions` and throws when findings were ranked and none was
decided, which only a run configured before the step can reach; the
controller refuses such a fix run in `resumePinned`, before the roles
digest is compared, so the operator is not first sent to `--roles`.

### Fixer task (R7)

`FixerTaskFinding` loses `also` and gains `members` (each a
`TaskCandidate`), `decision` and `supersedes`. The primary's evidence is
its own, not the merged one. `fixerTask` prints each member with its
verdict and evidence, the decision's lines (approach, rejected options,
departure; or the ask's default and question), the superseded findings
to check, and, when any finding carries a decision, one paragraph on
applying it, deferring only for an unseen fact, and saying which pinned
test a fix changed. A finding of a run configured before the step has
no decision and the task says nothing of decisions.

### Planner steps (R1, R9)

`unitsOf('decision')` is one `decider` unit when `rankedFindings` is not
empty, none otherwise, so a run that ranked nothing completes the phase
with no worker and `decisions` stays null. `degradationOf('decision')` is
null: two failures block with `worker-failed`.

### Report and status (R8)

`decision-report.ts` renders the Decisions section (null for a skipped
phase and for a run that ranked nothing) and each finding's decision
line, every model text through `inlineText`. `report.ts` places the
section after the header and closes each finding block with the line.
`fix-report.ts` gains two outcomes, `left by decision` and `asked, kept
as is`, chosen by the held finding's decision; `held for the author`
stays for a run configured before the step, whose header counts it as
before, so the committed report snapshots do not change. `status` prints
`Decisions:` with the counts and puts them in `--json`, and words a fix
run's held findings by whether it decided.

### Replay

`outcomeOf` becomes `verdictOutcome`, the verdict's own outcome by the
rule `routeOf` applied, kept local to the replay because it is what the
labels are scored against: a replay makes no decision.

### Build, skills and README

The skill descriptions name the decision pass; the README gains a
section on the step and states the new routing, phase order, role count
and report section. `npm run build` copies the roles and bundles the
engine into `dist/` in each commit that changes them.

### Prompt fragments (R11, R12)

`decider-brief.md` and `decider-rubric.md` are the experiment's text,
byte for byte. R11 rewrites the first lines of the three rubrics and the
last paragraph of `lead-verify.md`; R12 replaces two defer criteria of
`fixer-apply.md`. Each is its own commit.

## Technical Decisions

- **TD1: The configuration's version is the signal.** A boolean in the
  configuration was rejected: it would change version 4's shape, and the
  survey already set the pattern of a version that only says a phase
  exists.
- **TD2: One version 4 for all six phase-carrying kinds.** Widening
  version 3's enum in place was rejected: the ledger's rule is that a
  recorded version's shape never changes, and the frozen-vocabulary
  test exists to force exactly this.
- **TD3: The plan's event is unchanged.** A version 2 of
  `fixes.planned` carrying the decision kind was rejected: the decision
  is on the ledger already, and the fold now checks the routes against
  it, so a second copy could only disagree.
- **TD4: The decisions are recorded by id, not by index**, as every
  other contribution is: a later engine with another task order reads
  them the same.
- **TD5: The fake decider decides every finding `fix`.** Reproducing the
  old routing in the fake was rejected: tests that need a finding kept
  from a fixer script a `leave`, which says why.
- **TD6: One golden serial.** The eighth run of `schema-1-08` goes
  through the step with every event at the version the engine now
  writes; the seven older fixtures stay and fold with the phase skipped,
  which the golden test asserts.

## Test Strategy

- Vocabulary: sixteen phases, `decision` in no group, the decider among
  the roles, the decision kinds and leave reasons.
- Frozen vocabulary: version 4 equal to today's; versions 1 to 3 differ
  from today's only by the phases added since; each of the six kinds
  refuses `decision` at version 3 and accepts it at version 4;
  `decisions.recorded@1` holds parts to kinds, ids unique, caps.
- Fold: configuration versions 1 to 4 skip the phase and 5 runs it;
  decisions folded in ranking order; refusals for a decision before the
  phase, twice, missing or unknown ids, a superseding finding not
  decided fix, a start of a skipped phase, the report before the
  decision. Fix fold: the planner's plan from fix, leave and both kinds
  of ask folds; routes against the decisions are refused.
- Schemas: the decider's schema compiles; `checkDecisions` refuses each
  structural fault by name.
- Tasks and phases: the decider's task text; the fixer's members,
  decision lines, superseded findings and defer paragraph, and none of
  these for an older run; the decision's contribution resolved to ids.
- Planner: the decision's unit, its block after two failures and at the
  budget, no worker for an empty ranking, a whole decided run walked
  prefix by prefix; fixes planned from decisions; an older fix run
  cannot plan.
- Report and status: the section's order and parts, the escaping of
  model text, the decision lines, the fix outcomes and header counts,
  `status` counts.
- Whole runs on the fakes: a read-only run decides and reports; a
  decider failing twice blocks and a second invocation completes; an
  empty ranking launches no decider; an older fix run is refused before
  anything is recorded, and an older read-only run resumes; the fix pass
  with a scripted `leave`.
- Golden: `schema-1-08`, and every older fixture folds with the phase
  skipped.

## Verification

No checks have run yet.

## Risks & Migration

- A run configured before this change and still active resumes only
  with `--roles <old dir>`, because the roles digest changed; a fix run
  of that kind is refused until abandoned, whatever roles it is given.
- The decider was measured with the rubric's first lines as they stood
  before R11, which the decider's prompt includes; R11's text is
  measured on the verifier, not on the decider.
- A merge that binds two findings sharing only a rule binds their
  decision (requirements, Risks).
