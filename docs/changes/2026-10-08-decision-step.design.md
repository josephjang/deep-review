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
applying it, never deferring over a choice the decision made but only by
the role prompt's criteria, naming an unseen fact, and saying which
pinned test a fix changed. A finding of a run configured before the step has
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

Run on the author's Windows 11 machine on 2026-10-08, Node 26.10.0, over
the four commits that build the element after the proposal (`cf8f02f`):
`b3869b1` (the decider's prompt), `cf51077` (the engine), `f02dee2`
(R11) and `025290b` (R12). `npm run check` and `npm run verify` passed
before each commit; the last ends at 1618 tests, 1599 passing and 19
skipped, the platform-bound cases this machine always skips.
Continuous integration on the three platforms runs when the pull
request opens.

### Step 0: the decider before the proposal (R13)

Run on 2026-10-08, on the author's Windows 11 machine, by a scratch
script beside the corpus
(`projects\gate\notes\2026-10-08-decider-experiment\decide.ts`) that
imported a frozen copy of the engine at `1811a86` and ran the
`decider-brief.md` and `decider-rubric.md` this element commits, byte for
byte. Input: the five replayed runs (zod `7daab352`, click `e0a1f834`,
click-codex `e9755671`, pytest `64250a74`, hono `4e135100`), each
finding's merges as recorded and each member's verdict and evidence from
that runtime's rewrite-3 replay sample, refuted members dropped, as the
2026-10-07 audit simulated them. Each worker decided a whole run; Claude
Code (Opus, high) and Codex (gpt-6-astra, high), two samples each, and a
third whole sample of which only the findings the first two split on
are read.

| | Claude | Codex |
|---|---|---|
| Workers answered, of launched | 15 of 15 | 15 of 15 |
| Wall time per worker | 119 to 361 s | 187 to 777 s |
| Cost per worker | 0.57 to 1.61 USD | not reported |

Over the first two samples (20 run samples, 400 decisions): 223 fix
(9 departing from a rule), 152 leave (72 outside the change, 44
superseded, 36 intended), 25 ask, of which 22 applied a default that
keeps the code.

| Metric | Result |
|---|---|
| Asks per run sample | 1.25 on average; 4 of 20 above 2 |
| Asks on a finding labeled `apply` (false alarms) | 0 |
| Leaves for a reason other than `superseded` on a finding labeled `apply` | 0 |
| Leaves as `superseded` on a finding labeled `apply` | 21, each naming a finding decided fix whose fix removes it; the fixer of that finding is now told to check it is gone (R7) |
| Same decision kind in all four samples, of the 96 findings both runtimes decided | 64 |
| Findings split between the samples of one runtime | Claude 15 of 97, Codex 7 of 103 |
| Split findings, within a runtime or across, with an `ask` label | 17 of 32 (53 percent) |

Of the 32 splits, 14 are only `fix` against `leave` as `superseded`,
which changes no edit. A majority of three samples settles 27 of the 32
within each runtime, but the runtimes' majorities differ on 21: Claude
asks or leaves as intended where Codex fixes. The fold of R11 in the
plan this proposal started from therefore did not qualify (PD9).

The 51 findings labeled as the author's call were read against each
label's basis, sample by sample: of the first two samples' 200 decisions
on them, 185 applied the side easiest to take back and 15 committed to
the author's side (Claude 5, Codex 10): fixes of behavior the change did
not alter (pytest SCAN-6, hono SWEEP-1), widening a policy to untouched
code (click-codex SWEEP-2), extending a fix to names a walrus does not
rebind (pytest ALTITUDE-7, Codex), and replacing a design a commit
states on purpose (zod EFFICIENCY-3, Codex, as a departure).

The slowest worker, Codex over zod's 30 findings at 777 s, sets the
decider's timeout at 1800 s.

### The rubric's first lines (R11)

The verifier was replayed with this element's `rubrics.md` and
`lead-verify.md` (verifier prompt `12f0d323`) on the two validation
runs, one sample per runtime, `--role-text current`, into the replay
corpus beside the rewrite-3 samples (`210c2e4f`) the rubric's R10 was
measured on. Two Claude samples a usage limit cut short were removed
(`results.before-drop-*.json` keep them) and taken again.

| | rewrite 3 (`codex-2`, `claude-2`) | this text (`codex-3`, `claude-3`) |
|---|---|---|
| Not real kept, Codex | 2 of 6 | 2 of 6 |
| Real dropped, Claude | 4 of 41 | 4 of 41 |
| Labeled outcome, both runtimes, of 94 | 57 | 60 |
| Same outcome as rewrite 3, same runtime | | Codex 43 of 47, Claude 44 of 47 |
| Codex and Claude on the same outcome, of 47 | 40 | 36 |

The labeled counts are rewrite 3's, and each runtime gives the outcome
it gave under rewrite 3 on 43 or 44 of 47 candidates, near what two
samples of one text agree on. The agreement between runtimes is four
lower, from one sample each; it is named, not taken as a change of
grade, since no sentence of a grade table changed.

### The gate (R14)

Three runs of the engine from these sources: pytest #14447 read-only on
Claude Code and hono #5513 read-only on Codex, in the replay corpus's
trees, and pytest #14447 with `--fix` on Claude Code in a clone of its
tree, from the plugin bundle `npm run build` makes. The two read-only
runs ran on the tree before two defects they showed were fixed in
`cf51077`: the decider named other findings by their index in its task
(`[0]'s fix`), which means nothing in the report or to a fixer, and is
now told to name them by id; and an option that ended with a stop was
printed with two. The fix run ran on the final tree, and its decisions
name findings by id.

| | pytest, Claude | hono, Codex | pytest `--fix`, Claude |
|---|---|---|---|
| Run | `c45c7ec0` | `57a305c2` | `0faec159` |
| Every phase completed, no unit degraded | yes | yes | yes |
| Findings | 17 | 23 | 11 |
| Decided fix, leave, ask | 10, 7, 0 | 10, 12, 1 | 6, 5, 0 |
| Leaves by reason | 6 superseded, 1 intended | 10 outside the change, 2 intended | 5 superseded |
| Departures | 0 | 0 | 0 |
| The decider: seconds, USD | 136, 0.85 | 227, not reported | 215, 1.09 |
| The run: workers, USD | 23, 9.25 | 23, not reported | 28, 12.73 |

Questions per run: 0, 1 and 0, within the target of 2. The one question,
on hono, keeps the code by default and was routed to no fixer. These
reviews were made fresh, so no label covers their findings, and false
alarms are not counted here; the experiment above counts them.

The fix run's survey first blocked with `check-unavailable`: pytest
states its checks through `tox`, which this machine lacks. Run again
with `--no-check` for build, typecheck and lint and `--check` naming
pytest on the assertion-rewriting suites, it went on with no new survey.
Of the six findings decided fix, five were applied and one reported
already applied, none deferred or blocked; one finding blocked on a file
another cluster owned was applied in the second round; the test check
passed before and after the fixes, and the repair had nothing to do.
The five findings left as superseded each name the finding whose fix
removes them, and that fixer was told to check them.

Once in each pytest run the decider decided `fix` with an approach of
no edit, to keep a test file's existing idiom; in the fix run the fixer
reported it already applied, and nothing changed. Such a decision is a `leave` in
substance, and costs one finding of a fixer's turn.

No fix run before this one was made on pytest, so the share a fixer
defers has no before to compare with on the same change: it was 0 of 6.

## Risks & Migration

- A run configured before this change and still active resumes only
  with `--roles <old dir>`, because the roles digest changed; a fix run
  of that kind is refused until abandoned, whatever roles it is given.
- The decider was measured with the rubric's first lines as they stood
  before R11, which the decider's prompt includes; R11's text is
  measured on the verifier, not on the decider.
- A merge that binds two findings sharing only a rule binds their
  decision (requirements, Risks).
- A choice settled toward keeping the code can come back as `fix` with
  no edit rather than `leave` (Verification, the gate); a fixer then
  reports it already applied. The rubric names no leave reason for "the
  surrounding code's shape is kept", and adding one is a rubric change
  that is measured before it lands.
