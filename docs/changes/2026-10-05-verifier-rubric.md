# Change Proposal: Verifier rubric

## Summary

The rubric a verifier grades candidates by, `roles/fragments/rubrics.md`,
is rewritten. Today each grade is defined by prose bullets, by defaults
("PLAUSIBLE by default", "Do not default to PLAUSIBLE") and by lists of
what may never refute. After the change each rubric is a short list of
checks answered from the code, a table that says which answers give
which grade, a statement of the one answer that separates each grade
from its neighbour, and an example on each side of it. One paragraph of
`roles/fragments/lead-verify.md`, which says what the grades do in words
that are true of the design rubric only, is replaced. The reason is
measured: the verifier prompts three runs recorded, sent again to both
runtimes and scored against labels, show the Codex verifier keeping
eleven and twelve of twelve candidates that do not hold, and the two
runtimes sending the same candidate to different outcomes one time in
four. Two questions the old text left open are answered as the author
decided on 2026-10-05: a candidate that calls an intended behavior wrong
is kept for the author, and the public interface of a published library
has callers outside the repository. Measured again on two reviews the
text was not written against, the result holds (R10). That measurement
raised a third question, which the author decided on 2026-10-06 and
which is landed without a measurement of its own: a comment that is
false about the code is a finding. Routing, the answer schema, the
engine's code, the three grade definitions of the `CONVENTIONS` rubric,
the finders, the fixers and the auditor's verdicts do not change.

## Problem

After deduplication the engine gives each verifier the candidates of one
file, at most eight, and the verifier returns for each of them
`CONFIRMED`, `PLAUSIBLE` or `REFUTED` with one line of evidence.
`REFUTED` removes the candidate; the other two are routed by verdict and
angle (fix pass, R2). The finders are told to "surface every candidate
you can articulate: the verify pass filters, not you" (`lead-brief.md`),
so this grade is the only filter between a finder's guess and a fixer's
edit, and its evidence line is what the report prints, what a fixer is
given with the finding, and what the sweep and the ranking read.

The rubric's text is the proof of concept's. It came in with the role
prompts, which put off rewriting any prompt for its reader "after the
first real run, with its evidence" (role prompts, D5). Since then the
names of the prompt-only skill's steps left it (`534324a`) and its
`CONVENTIONS` section followed the repository survey (`b5f0e52`,
`4a115c1`, `6480df9`, `38ce26a`); the other two rubrics and the closing
gate are as they were moved. `lead-verify.md` has not changed since the
move.

The evidence is a replay. `npm run replay` sends the verifier prompts a
run recorded, the same bytes but for the paths of the machine, to a
fresh verifier on either runtime, and `npm run replay-score` scores the
verdicts against labels (README, Developing). It was run on 2026-10-05
over the 112 candidates of three reviews: zod #6530 reviewed on Claude
Code (run `7daab352`, 58 candidates), and click #3818 reviewed on Claude
Code (`e0a1f834`, 31) and on Codex (`e9755671`, 23). The 60 candidates
on which those samples disagreed were then labeled by reading the code
and running probes: 39 real, of which 8 need no decision and 31 are the
author's to decide, 12 not real, 9 left unsure. Verification has the
method and its limits. What it showed:

- **The two runtimes read the same text differently.** On the same 112
  prompts Claude Code gave 44 and 45 `CONFIRMED`, 49 `PLAUSIBLE` and 19
  and 18 `REFUTED` in two samples; Codex gave 88, 17 and 7 in both of
  its two. A candidate got the same outcome (to a fixer, held for the
  author, dropped) from both on 83 of 112.
- **The Codex verifier keeps what does not hold.** Of the 12 candidates
  labeled not real it kept 11 and 12; Claude Code kept 2. In the first
  sample seven of the eleven went to a fixer. Its evidence for them
  says the change "is feasible", "is a mechanically applicable,
  behavior-preserving clarification", "a feasible local cleanup": true
  statements, which the rubric asks for, and none of them says the
  result is better than what is there.
- **Claude Code is the noisier reader, so its reading is not a
  standard to tune Codex toward.** Two replays of the same 89 prompts
  (zod and click) agree on the verdict for 77 candidates and on the
  outcome for 82. With the recorded verdicts as a third sample all three
  agree on the outcome for 78 of 89, and for 30 of the 38 design
  candidates. The two replays dropped 3 and 1 of the 39 real
  candidates.
- **The text states postures where it should state conditions.**
  "PLAUSIBLE by default for correctness & cost" and "Do not default to
  PLAUSIBLE for design & cleanup" tell the reader which way to lean, not
  what to establish. "Either way the real refactor is KEPT", "never
  quietly dropped" and "'Validatable' forbids REFUTING it" guard against
  dropping a real finding, and a reader that follows text to the letter
  takes them as a presumption to keep.
- **The same boundary is drawn in several places.** What may refute a
  design candidate is in the `REFUTED` bullet, in "Never grounds for
  REFUTED" and in the closing gate. What separates `CONFIRMED` from
  `PLAUSIBLE` there is in the last clause of the `CONFIRMED` bullet, in
  the `PLAUSIBLE` bullet and in a fork written in capitals; the
  `PLAUSIBLE` definition runs to 27 lines. A reader must reconcile them,
  and two readers reconcile them differently.
- **Nothing counts what a design change adds.** `CONFIRMED` asks that
  the change "would clearly improve the code" and that its
  `value_statement` be accurate; the closing gate asks that it be
  feasible. What the result adds, a new function, parameter, flag or
  hop, is weighed only as the judgment that a refactor "would trade one
  smell for a worse one", which names nothing to look for.
- **`lead-verify.md` tells the verifier something false.** It says the
  split between `CONFIRMED` and `PLAUSIBLE` "decides whether the fix is
  applied without asking or the question is put to the author". That is
  so for the three design angles. For the other seven both grades go to
  a fixer (fix pass, R2).
- **Two questions have no answer in the text, and the samples answered
  them both ways.** One: a comment, a test or the documentation shows
  that the behavior a candidate calls wrong is intended. Two: no code in
  the repository produces the state a candidate needs, and the code is
  the public interface of a library other people call. The second of
  the three rewrites (Verification) refuted "a state that only a caller
  nobody wrote could produce" and said nothing of intent, and Claude
  Code then refuted candidates of both kinds: in all it dropped 11 of
  the 39 real ones, 9 of them labeled as the author's to decide.
- **A comment that is false about the code can only be refuted.** The
  text refutes "pure style with no observable effect", and a comment
  changes nothing a program does. This was found while R10 was
  measured: the reviewed change added a comment that is untrue of the
  code beside it, a finder pointed at it, every sample refuted the
  candidate, and the two adjudicators who labeled it called it real.
- **The evidence line has a limit the rubric never states.** The answer
  schema refuses a line over 1000 characters (`src/review/schemas.ts`),
  and an answer that fails its schema costs the group one of its two
  attempts.

One thing the replay showed is not this change's problem. None of the 17
correctness candidates labeled as the author's to decide can reach the
author: under every text tried each went to a fixer unless it was
refuted, because the routing gives a correctness angle no other way. No
wording of the rubric can change that; it is named under Non-Goals.

## Goals

- A verifier on Claude Code and a verifier on Codex give one candidate
  the same outcome far more often than three times in four.
- A candidate whose claim does not hold is removed on both runtimes, and
  one that holds is removed on neither.
- Each boundary between two grades is one named answer to a named check,
  and the evidence line shows which answer decided.
- What the rubric says a grade does next is what the engine does with
  it.
- An intended behavior that a candidate calls wrong, and a state only a
  caller outside the repository can produce, each have one answer in the
  text.
- A comment that says something false of the code is kept as a finding.

## Non-Goals

- No change to routing. `routeOf` and R2 of the fix pass stay: a
  `PLAUSIBLE` correctness candidate still goes to a fixer. The new
  `Needs the author:` note is a clause of the evidence line, which the
  engine does not read (D10). Giving the verifier a field that says who
  decides, and routing on it, is a change to the answer schema, the
  ledger and the fix pass, and gets its own proposal; the 17 candidates
  above are its evidence. By the author's decision of 2026-10-06 that
  proposal is taken up once this change is closed, not within it.
- No change to the `CONVENTIONS` grades. Its three definitions stay
  byte for byte, as the tests of the repository survey pin them (its R7,
  R11 and R13). The replay gives no reason to touch them: the verdict
  counts on its 19 `CONVENTIONS` candidates barely move from one text
  to the next (Verification), and none of the four that were labeled
  could be settled. The section gains only a sentence saying what its
  grades do and a paragraph naming what separates them.
- No change to who carries the rubric. Seven roles name `rubrics.md`
  and `lead-verify.md`, and only `verifier` grades by them. Taking the
  rubric out of the six that do not is a change of composition, which is
  a commit and a decision of its own (role prompts, R8), and
  `phase2-verify.md` gives a reason for a lead role to carry it.
- No change to the auditor. `step3-verdicts.md` has its own three
  verdicts and names the rubric's "verify before you judge" gate, which
  the `auditor` prompt does not carry. The section keeps that title,
  so the pointer is no worse than it was; whether an audit runs at all,
  and from what text, is decided with the element that first runs it.
- No change to the finders. They still surface broadly; the rubric's
  "you are its filter" depends on it.
- No rubric per runtime, and no change of model, effort, budget, timeout
  or grouping (D2). An effort variant was left unmeasured at the
  author's request.
- No change to the verifier's task text in `src/review/tasks.ts`, to
  `verifierOutputSchema`, or to any event.
- No measurement of D14 in this change. The author decided on
  2026-10-06 to land the rule on comments and to measure it later; until
  then how either runtime reads it is unknown (Risks).
- No claim about fixes. Everything here is measured on verdicts: what a
  fixer then does with a finding graded under the new text is not
  measured.
- The replay tool and the labels are not part of this change. The tool
  is committed on its own (`dfbf51e`); the labels stay with the replay's
  results on the author's machine.

## Requirements

- R1: `roles/fragments/rubrics.md` holds four sections in this order:
  the rules for all rubrics, the correctness and cost rubric, the design
  and cleanup rubric, the `CONVENTIONS` rubric. The committed file is
  the text that was measured, whose SHA-256 is recorded under
  Verification, with one paragraph added to the correctness and cost
  rubric, the rule of D14, and no other byte changed; that is checked
  once and recorded. Any other edit to it is measured before it lands.
- R2: The correctness and cost rubric and the design and cleanup rubric
  each have a table of checks (the question, and how to answer it from
  the code), a table that gives the grade for each combination of
  answers, a statement for each boundary between two grades of the
  checks that decide it and that no other does, and at least one example
  on each side of each boundary.
- R3: Each of the three rubrics names its angles and says in its first
  lines what `CONFIRMED`, `PLAUSIBLE` and `REFUTED` do next. Every angle
  is named by exactly one rubric, and a test holds each rubric's
  statement to `routeOf` for each of its angles, so the text cannot
  drift from the routing again.
- R4: The rules for all rubrics say: the claim is graded as written, and
  a narrower claim that survives is graded by the same table, announced
  with `Narrowed to:`, and for a design candidate may replace the
  proposed result but never the problem; every table has an `Against`
  check, and the evidence says what was looked for and what was found;
  each answer cites `file:line`, from a probe where one can run and a
  trace where none can; a check that cannot be answered here is named
  and the grade is `PLAUSIBLE`.
- R5: The evidence line gives each check's answer in the table's order
  and ends with the answer that separates the grade from its neighbour
  (`Not CONFIRMED:` or `Not REFUTED:`). The rubric states the limit of
  1000 characters, and a test holds that number to
  `verifierOutputSchema`. A `Needs the author:` note names a choice
  between two behaviors and never changes the grade.
- R6: The correctness and cost rubric says that a behavior shown to be
  intended is not for that reason refuted (D7), that a public interface
  of a library published for others has callers outside the repository
  while code only the repository calls does not (D8), that refuting
  takes a fact the verifier established (D9), and that a comment, a
  docstring or a line of documentation that is false about the code is
  a wrong result though nothing fails when the code runs (D14). A test
  pins each of the four.
- R7: No fragment says `PLAUSIBLE by default`, `Do not default to
  PLAUSIBLE` or `never quietly dropped`, and `lead-verify.md` no longer
  says that the split between `CONFIRMED` and `PLAUSIBLE` decides
  between applying and asking; a test holds the seven prompts to that.
- R8: The three grade definitions of the `CONVENTIONS` rubric are
  unchanged byte for byte, and every test that pins that section or the
  place of the rubric below `lead-verify.md` passes unchanged.
- R9: One commit changes what the two fragments say and nothing else
  under `roles/`, carries the tests of R3, R5, R6 and R7 and one that
  holds the text to the shape R1, R2 and R4 give it, each checked to
  fail on the fragments as they are today, and the rebuilt `dist/`,
  whose copy of `roles/` changes with them. `npm run check` and
  `npm run verify` pass. The seven roles whose prompt and hash change
  are recorded under Verification.
- R10: On the candidates of two reviews the text was not written
  against, pytest-dev/pytest #14447 reviewed on Claude Code and
  honojs/hono #5513 reviewed on Codex, both chosen and started before
  any verdict of theirs was read, with every candidate labeled by
  reading the code:
  - the Codex verifier keeps no more candidates labeled not real under
    the new text than under the current one, and fewer if the current
    one keeps two or more;
  - on neither runtime does the new text drop more than one more
    candidate labeled real than the current text drops there;
  - the two runtimes give the same outcome on a larger share of the
    candidates under the new text than under the current one.

  If one of the three is false the text is revised and measured again
  on the old and the new candidates, or the proposal records why it is
  accepted.
- R11: One read-only review on each runtime reaches a report under the
  new roles with no phase blocked and no unit degraded, on a change
  already reviewed under the current roles, so the candidates each phase
  produced can be compared. This is the only check of the six prompts
  that change without grading by the rubric.
- Metric: candidates labeled not real that the Codex verifier keeps, of
  12: baseline 11 and 12, target at most 2. Measured by `npm run
  replay-score` on the three reviews above.
- Metric: candidates labeled real that a verifier drops, of 39: baseline
  1 and 3 on Claude Code, 0 and 1 on Codex; target at most 3 on each.
- Metric: candidates given the same outcome by both runtimes, of 112:
  baseline 83, target at least 100.

## Decisions

- **D1: The rubric is rewritten as checks and grade tables, not
  amended.** Adding to the current text was tried first: one block, a
  value check and a scope check, added to the design rubric. On Codex
  the labeled outcome of the 27 design candidates rose from 6 to 14 and
  it still kept 9 of the 12 not real; on Claude Code the same block
  dropped 5 real design candidates where the current text drops none or
  one. More sentences in a text whose trouble is overlapping sentences
  moved each runtime a different way. The shape follows Microsoft's
  guidance on rubrics for the Copilot Studio Kit
  (<https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/kit-rubrics-best-practices>):
  criteria a reader can observe, the difference between adjacent grades
  stated, few dimensions, a reason beside each rule, examples on both
  sides. Revisit if a model reads tables worse than prose; the replay
  measures it for the price of one pass.

- **D2: One text for both runtimes.** A stricter text or a higher
  effort for Codex alone was rejected: the role prompts rejected
  per-runtime variants because two copies drift (their D5), and the
  third rewrite brings both runtimes to the same outcome on 103 of 112
  with one text. Revisit when a model update pulls them apart again.

- **D3: A grade is decided by the answers to checks, and the postures
  are gone.** "PLAUSIBLE by default", "Do not default to PLAUSIBLE" and
  "never quietly dropped" are replaced by which check decides each
  boundary. What they protected is kept as conditions: the age of the
  code, a passing test, and the size or risk of the fix are named once
  as deciding nothing, and "Scope, size and risk never refute" stands in
  the design rubric.
  Keeping the postures beside the tables was rejected because a posture
  and a table that disagree on a candidate leave the choice to the
  reader, which is the present trouble.

- **D4: For a design candidate the benefit is weighed against a
  price, and that a change can be made is not a benefit.** `REFUTED`
  takes one of four answers: the problem is not there, it is already
  solved or the construct earns its place, the benefit is not
  delivered, or the result adds as much as it removes. The current
  text's feasibility gate and its paragraph on validatable refactors
  are what the Codex verifier's evidence echoes when it keeps a
  candidate that is not real; the new text says in so many words that a
  change that "can be made, compiles and keeps behavior" has shown no
  benefit. The feasibility gate's own purpose survives in the Benefit
  check, which has the verifier write the result and test the
  `value_statement` against it.

- **D5: For a design candidate `PLAUSIBLE` is decided by Scope and
  Choice and by nothing else.** Scope is whether the edit stays inside
  the lines the patch adds or changes or the functions it edits. Choice
  is a decision the code does not settle, which the verifier must name:
  a change a caller could observe, a public interface, or two results a
  maintainer could each prefer. "Taste" and "future direction", the
  current grounds, were rejected as grounds a reader cannot check, and
  the rubric says that `PLAUSIBLE` is not a place for doubt about the
  benefit: the benefit is settled first, by D4.

- **D6: For a correctness candidate `CONFIRMED` and `PLAUSIBLE` differ
  by the trigger alone, and `PLAUSIBLE` names one condition.** The
  verifier that ran or traced the input to the wrong result confirms;
  the one that has the mechanism and a single condition it could not
  settle here (an interleaving, a platform, a configuration, an input
  size) says which, and what would settle it. The measured effect on
  Claude Code is a shift between two grades that route alike: of the 46
  correctness and cost candidates it graded 20 `PLAUSIBLE` under the
  current text and 9 under the new, and confirmed 32 where it had
  confirmed 21 and 24. For `EFFICIENCY` the cost is counted or measured
  at a size the input can reach and compared with the code before the
  change or the plain way to do the same thing. The first rewrite said
  instead that work on a path that runs once or rarely is refuted, and
  the Codex verifier refuted a regression it had itself reproduced as
  exponential, citing that rule; the text now says "Running once
  excuses nothing by itself".

- **D7: A behavior shown to be intended is not for that reason
  refuted.** When the mechanism and the trigger are real and the
  candidate names a result a user would call wrong, the candidate stays
  and carries `Needs the author:` with the two behaviors, because it may
  be saying that the intent is wrong. The author decided this on
  2026-10-05, against refuting on a comment, a test or a document that
  shows the intent, which is what the second rewrite's Claude Code
  samples did.

- **D8: A published library's public interface has callers outside the
  repository.** A caller that uses the interface as its signature and
  documentation allow is a producer, though the repository holds none.
  In code only the repository calls, a state none of its callers
  produces is still refuted. The author decided this on 2026-10-05,
  against "nothing in the repository produces it", by which Claude Code
  under the second rewrite refuted real candidates on zod and click,
  both libraries.

- **D9: Refuting takes a fact the verifier established.** The guard it
  cites, the search that found no producer, the run that showed no
  effect, the count that showed no added work. An argument that the
  effect ought to be harmless or the cost small is not one, and grades
  `PLAUSIBLE` with what would settle it. This is the half of the old
  closing gate that guards against dropping a finding on an assumed
  premise, kept as one rule. The second rewrite had no such rule, and
  under it Claude Code refuted cost candidates by reasoning that the
  added work is "a small constant factor", with nothing counted or
  measured.

- **D10: `Needs the author:` is a note and does not route.** Routing on
  it now was rejected: a phrase matched in a free line of text is not a
  contract between a worker and the engine, and the note is not reliable
  enough to be one. Under the new text Claude Code put it on 11 of the
  17 correctness candidates labeled as the author's and on 1 of the 4 it
  kept that need no decision; Codex put it on 5 of the 17 and on none of
  5. The note still reaches the reader of the report and the fixer,
  both of which are given the evidence line. Revisit with the proposal
  that gives the verifier a field for it.

- **D11: The claim is graded as written, and narrowing is allowed and
  announced.** A candidate whose central statement is false is refuted
  even if something near it is true; a narrower statement that survives
  is graded on its own by the same table and opens the evidence with
  `Narrowed to:`. Grading whatever nearby is true was rejected because a
  fixer acts on what the candidate says. Allowing no narrowing was
  rejected because it drops a real problem whose proposed remedy is
  wrong; for a design candidate the result may therefore be replaced by
  a smaller one, but never the problem.

- **D12: The rules for all rubrics come first, and the section keeps its
  title.** They define what the tables use: the claim, the `Against`
  check, the evidence line. The current text has them last, as a gate
  over what was already read. The title stays because
  `step3-verdicts.md` names it.

- **D13: Unified form.** The technical side is two fragments, six
  tests and a rebuild. What needs room is the evidence, and it has it
  under Verification.

- **D14: A comment that is false about the code is a wrong result.** A
  comment, a docstring or a line of documentation that says something
  untrue of the code as the change leaves it is graded as a correctness
  finding: its reader is the user and the false statement is what they
  see, so "no result a user could observe" does not refute it. One that
  is only less exact than it could be, and says nothing false, is
  refuted. The author decided this on 2026-10-06, against leaving such a
  candidate refuted, which the current text and the third rewrite both
  do: on the reviews of R10 every sample under either refuted pytest
  `SCAN-7`, a comment the change adds that is untrue for chained
  comparisons, and both adjudicators who labeled it called it real. The
  paragraph is added to the measured text without a replay of its own,
  also by the author's decision; `SCAN-7` is the first case to replay
  when it is measured.

## Risks

- **The text was written with its own test set in view.** Three
  rewrites each read the candidates the one before got wrong, so the
  numbers of 2026-10-05 under Verification flatter the third. Accepted
  only together with R10, whose two reviews were not read while the
  text was written; it holds there, by a smaller margin on Claude Code
  and on fewer candidates.
- **The labels are a model's.** They were made by adjudicating workers
  from blinded briefs and spot-checked, and the author has not reviewed
  them. Nine candidates are unsure because two adjudicators held
  opposite standards for a realistic trigger. Two labels are disputed by
  the result itself: zod `DESIGN-11`, which both runtimes refute under
  the new text for a reason the label's own basis concedes, and click
  `ALTITUDE-4`, labeled not real because the behavior is intended, which
  D7 now keeps for the author. The adjudicators of R10 called 23 of
  hono's 26 candidates real, several of them by their own account
  narrowly, so a stricter adjudicator would count some of Claude Code's
  refutations there as right.
- **The rule on comments is not measured.** D14 adds a paragraph to the
  text after its last replay, so every number under Verification is of
  the text without it. How either runtime reads the paragraph is
  unknown: a verifier may keep a comment that is only loose, and the
  triage, which carries the rubric and reads the change line by line,
  may surface more such candidates. Accepted by the author's decision
  to measure later; R11 gives a first look at what the finders do with
  it.
- **The numbers are small and one reader is noisy.** Twelve not real,
  39 real. Two replays of one text on Claude Code differ on 7 outcomes
  of 89, which is the size of some of the differences reported.
- **It is measured on two models at one effort.** `opus` at high effort
  on Claude Code 2.1.289 and `gpt-6-astra` at high effort on Codex
  0.160.0. Another model or effort may read the tables differently; the
  replay is how that is found out.
- **More correctness candidates reach a fixer marked `CONFIRMED`.** By
  D6 a fixer that was told which condition was unsettled is now told
  the finding is confirmed, for about ten more candidates in 46 on
  Claude Code. What a fixer does with the difference is not measured.
- **An intended behavior kept by D7 goes to a fixer when its angle is a
  correctness angle.** Nothing routes it to the author, so a fixer may
  change a behavior the project chose, with only the note in its
  evidence to stop it. Under the new text all 17 correctness candidates
  labeled as the author's went to a fixer on both runtimes; under the
  recorded prompts 15 to 17 did, the rest being refuted. Accepted until
  the routing proposal named under Non-Goals, which this makes more
  pressing and which the author has ordered after this change.
- **A narrowed claim travels only in the evidence line.** The
  candidate's summary still states the original, and the fixer is given
  both. Narrowing is also how Codex still keeps what is labeled not
  real: zod `ALTITUDE-7`, held for the author, and on the reviews of
  R10 pytest `DESIGN-10`, which it confirmed as a narrowed claim and
  sent to a fixer. Two cases of the four it keeps in all; if more
  follow, the rule to tighten is that a narrowed claim "must pass every
  check on its own".
- **Six prompts change that were not measured.** `triage`,
  `finder-SCAN`, `deduplication`, `sweep`, `merge-rank` and
  `test-assessment` carry the rubric without grading by it, and each
  grows by 3141 bytes. A finder that reads a stricter filter may
  surface less. Accepted with R11 as the check.
- **Verification costs more.** A pass of the Claude Code verifier over
  the three reviews cost 8.71 and 8.78 USD under the recorded prompts
  and 11.61 under the new text, a third more; on Codex the same pass
  took 692 seconds and then 1063. Accepted: the verifier answers more
  questions per candidate, and the run's budget default of 60 USD has
  room.
- **The rubric repeats a number the schema owns.** The limit of 1000
  characters is in both; the test of R5 fails when they part.

## Verification

Measured before this proposal, on the author's Windows 11 machine on
2026-10-05, against `a79010f` with the replay tool in the worktree,
which `dfbf51e` then committed. Results, labels and the roles
directories of every text tried are under `~/projects/gate/replay`
there.

- **The set.** Three recorded runs, 29 verification groups, 112
  candidates: 46 from the correctness and cost angles, 47 from the
  design angles, 19 from `CONVENTIONS`. Each replay sends every group's
  recorded verifier prompt to a fresh verifier in a clean clone at the
  reviewed commit; a variant replaces the role prompt inside it and
  keeps the task. A sample on the runtime that made the run uses the
  verifier settings the run recorded, and one on the other runtime
  those of `roles/policy.json`; both come to `opus` and `gpt-6-astra`
  at high effort, 600 seconds, and 8 USD a worker on Claude Code.
- **The labels.** The 60 candidates on which the samples under the
  recorded prompts disagreed, before any variant existed. Each was given
  to an adjudicating worker as a brief holding the candidate and the
  distinct readings of it, with no sample or runtime named, to settle by
  reading the code and running probes in a separate checkout. Where two
  adjudicators contradicted each other on one issue the labels were set
  to unsure. 51 are scored: 39 real (8 that need no decision, 31 the
  author's to decide) and 12 not real (10 design, 2 cost). The labeled
  outcome is dropped for a candidate that is not real, a fixer for a
  real one that needs no decision, held for a real one that is the
  author's. Because 17 of the 31 are correctness candidates, which no
  verdict can hold, no text can score above 34 of 51.
- **The texts.** The recorded prompts; the block of D1; and three
  rewrites, of which the third is this proposal's. The first rewrite
  was run on Codex only. Where a row gives two samples, each is a full
  pass over the 112, with one exception: the click review made on Codex
  was replayed on Claude Code once under the recorded prompt, so its 23
  candidates are the same in both of Claude Code's.

  | Text, runtime | C / P / R of 112 | Not real kept, of 12 | Real dropped, of 39 | Labeled outcome, of 51 |
  |---|---|---|---|---|
  | Recorded, Claude Code (two samples) | 44 / 49 / 19 and 45 / 49 / 18 | 2 and 2 | 3 and 1 | 28 and 28 |
  | Recorded, Codex (two samples) | 88 / 17 / 7 and 88 / 17 / 7 | 11 and 12 | 0 and 1 | 11 and 11 |
  | Block, Claude Code | 39 / 47 / 26 | 1 | 6 | 26 |
  | Block, Codex | 75 / 26 / 11 | 9 | 1 | 19 |
  | Rewrite 1, Codex | 69 / 11 / 32 | 1 | 6 | 24 |
  | Rewrite 2, Claude Code | 42 / 37 / 33 | 1 | 11 | 27 |
  | Rewrite 2, Codex | 73 / 13 / 26 | 1 | 2 | 27 |
  | Rewrite 3, Claude Code | 55 / 34 / 23 | 1 | 2 | 28 |
  | Rewrite 3, Codex | 73 / 19 / 20 | 2 | 1 | 27 |

- **Agreement between the runtimes.** The same outcome for a candidate
  from Claude Code and from Codex: 83 of 112 under the recorded
  prompts, 87 with the block, 89 under the second rewrite, 103 under the
  third. The same verdict: 60, 66, 74 and 90.
- **By kind of angle, third rewrite against the recorded prompts.**
  Design, of 47: Claude Code 9 / 21 / 17, where it gave 8 / 26 / 13 and
  6 / 26 / 15; Codex 11 / 19 / 17, where it gave 27 / 14 / 6 and
  28 / 14 / 5. Correctness and cost, of 46: Claude Code 32 / 9 / 5,
  from 21 / 20 / 5 and 24 / 20 / 2; Codex 44 / 0 / 2, from 43 / 3 / 0
  and 42 / 3 / 1. `CONVENTIONS`, of 19: Claude Code 14 / 4 / 1, from
  15 / 3 / 1 twice; Codex 18 / 0 / 1 under every text. The recorded
  prompts of the three runs predate one or more of the `CONVENTIONS`
  commits of 2026-10-04 and the rewrites were built on the current
  fragments, so on those 19 a rewrite differs from the recorded prompt
  by those commits as well; the counts show it did not matter.
- **The candidates without a label.** The 52 on which the samples under
  the recorded prompts agreed: the third rewrite changes the outcome of
  2 on Claude Code and of 1 on Codex. One is the same candidate on both
  (click `DESIGN-4`, held before, refuted by both for the same cited
  fact).
- **What the third rewrite still gets wrong by the labels.** Both
  runtimes refute zod `DESIGN-11` and keep click `ALTITUDE-4`, the two
  labels named under Risks. Claude Code alone refutes click
  `FOOTGUNS-3`, a real reference cycle, after a probe weaker than the
  adjudicator's; one of its two samples under the recorded prompt
  dropped it too. Codex alone keeps zod `ALTITUDE-7` as a narrowed
  claim.
- **The author's note.** Under the third rewrite Claude Code's evidence
  carries `Needs the author:` on 31 of the 89 candidates it keeps and
  Codex's on 18 of 92; D10 has how they fall on the labels.
- **Failures.** No sample in the table holds an unverified group. Three
  groups needed their second attempt: two when Codex reported its model
  at capacity, one when a Codex verifier under the first rewrite ran
  past 600 seconds. Two Claude Code samples taken while the account was
  at its session limit answered nothing; they were removed and taken
  again, and the replay now names a sample in which no verifier
  answered and exits 1.
- **The text and the prompts.** The two fragments as measured are in
  `roles/rewrite-3b/fragments/` of that directory, in a copy of this
  repository's `roles/` that differs from it in those two files only.
  The third rewrite of `rubrics.md` is 12242 bytes, 199 lines, SHA-256
  `3aa303c84c6e5084a0d2f1089137819f4d866f1b82015dbbf00384a905c29d10`
  (today 8984 bytes, 156 lines). `lead-verify.md` with its paragraph
  replaced is 523 bytes, SHA-256
  `d4229b892e87de7fd785a726413fdfe4a1304077f91e76663c27d2841f70e01a`
  (today 640). Assembled with the other fragments of `a79010f`, seven
  prompts change and every other role's is untouched:

  | Role | Bytes today | Bytes | SHA-256 |
  |---|---|---|---|
  | triage | 24750 | 27891 | `5661fe71d85e07f2fc8846e9309c3a6661cbf7e4784ecdca2983611edd64c23b` |
  | finder-SCAN | 12805 | 15946 | `ba99f0df108412d81dc328ad24ad573644577d8cd155c5be894bc1b667abcc7d` |
  | deduplication | 15951 | 19092 | `210c2e4fe19c5d38a595c8942aa3f626a2c85c8e494e0d8b9c5b3598d54b011a` |
  | verifier | 15951 | 19092 | `210c2e4fe19c5d38a595c8942aa3f626a2c85c8e494e0d8b9c5b3598d54b011a` |
  | sweep | 23245 | 26386 | `64b47d29c00b97eade3601a993f925b81ebf767e5304e7cba65358b3786d515a` |
  | merge-rank | 13615 | 16756 | `7726752f84a07859eb8823b97a2401205ede6866b2bd4a2a22c28d0a090b8a65` |
  | test-assessment | 29053 | 32194 | `aa0d70e214b82cc1a80a41a1a8278383cb455c261d5fd1eddf48906bb24216ae` |

R10, measured on 2026-10-05 and 2026-10-06 on the same machine. The
requirement and its three thresholds were written on 2026-10-05, after
both reviews had started and before any verdict of theirs was compared.

- **The set.** pytest-dev/pytest #14447 at `51e9a9f1`, reviewed
  read-only on Claude Code (run `64250a74`, 21 candidates in 5 groups,
  6.18 USD), and honojs/hono #5513 at `cbf4c290`, reviewed read-only on
  Codex (run `4e135100`, 26 candidates in 7 groups), both under the
  roles of `a79010f`. Of the 47 candidates 23 are from the correctness
  and cost angles and 24 from the design angles; neither review
  produced a `CONVENTIONS` candidate. For each review the samples are
  the recorded verdicts, one replay of the recorded prompts on each
  runtime, and one replay under the third rewrite on each runtime. So
  Claude Code has two samples under the recorded prompts on pytest and
  one on hono, and Codex one on pytest and two on hono; a row below
  that gives two samples repeats the single one where there is only
  one.
- **The labels.** All 47, not only the disputed ones, by five
  adjudicating workers from blinded briefs as before, with D7 and D8
  written into the definitions they labeled by: 41 real (18 that need
  no decision, 23 the author's to decide), 6 not real, none unsure. One
  worker said it had read this proposal while labeling. Its ten
  candidates were labeled again by a worker confined to the checkout
  and the brief, and the second labels are the ones used; the two agree
  on real or not for 10 of 10 and on the disposition for 9. Of the 23
  that are the author's, 10 are correctness candidates, so no text can
  score above 37 of 47 on the labeled outcome.

  | Text, runtime | C / P / R of 47 | Not real kept, of 6 | Real dropped, of 41 | Labeled outcome, of 47 |
  |---|---|---|---|---|
  | Recorded, Claude Code (two samples) | 19 / 20 / 8 and 17 / 21 / 9 | 3 and 3 | 5 and 6 | 28 and 26 |
  | Recorded, Codex (two samples) | 38 / 6 / 3 and 38 / 6 / 3 | 5 and 5 | 2 and 2 | 22 and 22 |
  | Rewrite 3, Claude Code | 21 / 17 / 9 | 1 | 4 | 28 |
  | Rewrite 3, Codex | 27 / 14 / 6 | 2 | 2 | 29 |

- **The three statements of R10 are true.** The Codex verifier keeps 2
  candidates labeled not real under the new text where it kept 5. The
  new text drops 4 real candidates on Claude Code, where the current
  one dropped 5 and 6, and 2 on Codex, the same two as before. The two
  runtimes give the same outcome on 40 of 47 candidates under the new
  text and on 30 under the current one (the same verdict on 39 and on
  26). The first statement does not rest on the labels: every candidate
  Codex refutes under the recorded prompts it also refutes under the
  new text, so no relabeling could make the new text keep more.
- **By kind of angle.** Design, of 24: Codex 7 / 14 / 3, where it gave
  18 / 6 / 0; Claude Code 2 / 16 / 6, where it gave 4 / 16 / 4 and
  3 / 17 / 4. Correctness and cost, of 23: Codex 20 / 0 / 3 under both
  texts; Claude Code 19 / 1 / 3, from 15 / 4 / 4 and 14 / 4 / 5, the
  shift of D6 again.
- **What the third rewrite gets wrong here by the labels.** Both
  runtimes drop pytest `FOOTGUNS-4` and `SCAN-7`, as most samples under
  the recorded prompts do: the verifiers that refuted `FOOTGUNS-4`
  probed it with a local name and saw no difference, and the
  adjudicator found one with a module-level function; `SCAN-7` is the
  comment that D14 was then decided on. Both keep pytest `DESIGN-10`,
  as every sample does, Codex as a narrowed claim sent to a fixer.
  Claude Code alone drops hono `DUPLICATION-8` and `DUPLICATION-1`, two
  design candidates their adjudicators called close. Codex alone holds
  hono `DUPLICATION-2` for the author. Both hold hono `ALTITUDE-1` for
  the author, naming a change a caller could observe, where the
  adjudicator saw no decision to make; with it the new text holds 4
  candidates on Claude Code and 2 on Codex that are labeled as needing
  no decision, against 2 and 3, and none, under the recorded prompts.
- **The author's note.** Claude Code's evidence carries
  `Needs the author:` on 13 of the 38 candidates it keeps: on 4 of the
  10 correctness candidates labeled as the author's and on none of the
  10 it keeps that need no decision. Codex's carries it on 6 of 41: on
  1 of the 10 labeled as the author's and on none of the other 10.
- **Cost.** The Claude Code verifier pass over the two reviews cost
  3.12 USD under the recorded prompts and 3.81 under the new text; the
  Codex pass took 302 seconds and then 452.
- **Failures.** No sample in the table holds an unverified group. The
  first attempt at three Claude Code samples ran into the account's
  session limit: two answered nothing, and one answered for 3 of 26
  candidates and still exited 0. All three were removed and taken again
  once the limit had reset, and the replay now names every group pass
  that went unverified and exits 1.

The change as committed, checked on 2026-10-06 on the same machine, Node
26.10.0, against `72d4326`.

- **The fragments (R1, R8).** `roles/fragments/rubrics.md` is 12731
  bytes, 207 lines, SHA-256
  `d200332f95a86431c3151c022195de0abe992ad2518c96ab2e6f5c28fe9747bc`.
  With the seven lines of D14's paragraph and the blank line after them
  taken out it is byte for byte the measured third rewrite
  (`3aa303c8`, above); the comparison was made on the file as written
  into `roles/`. `lead-verify.md` is the measured fragment
  (`d4229b89`). The three grade definitions of the `CONVENTIONS`
  rubric, 974 bytes, are those of `72d4326`.
- **The tests (R2 to R7, R9).** Six are new. Two, beside the routing
  tests, hold R3: every angle is named in the first lines of exactly
  one rubric, and what those lines say of `CONFIRMED` and `PLAUSIBLE`
  is what `routeOf` does for each angle named. Four, among the role
  pins, hold the order of the sections and the shape of the two graded
  rubrics (R1, R2, R4); the limit of the evidence line, by parsing with
  `verifierOutputSchema` an answer at the limit and one a character
  past it (R5); the four rules of R6; and the absence of the postures
  from all twenty-one prompts (R7). All six fail on the fragments of
  `72d4326` and pass on the new ones. No test that existed changed,
  and those that pin the `CONVENTIONS` section and the rubric's place
  below `lead-verify.md` pass as they were (R8).
- **Check and build (R9).** `npm run check` passes: lint, typecheck
  and 1529 tests, of which 1510 pass and 19 skip, the same 19 as before
  the change. `npm run build` changed two files in each of
  `dist/claude` and `dist/codex`, the copies of the two fragments
  under `engine/roles/fragments/`, and nothing else, and
  `npm run verify` matches both. Seven prompts changed, each by 3630
  bytes, and the other fourteen are those of `72d4326`:

  | Role | Bytes at `72d4326` | Bytes | SHA-256 |
  |---|---|---|---|
  | triage | 24750 | 28380 | `dafaf2d3c57eecc2e0765c0dbf26cf29c8fee3157ca17e6dac9c4e63202c8e8f` |
  | finder-SCAN | 12805 | 16435 | `3ad8478160c971c8c6dc6af9240729e6ad9c7583af92e3201a7e904922911e50` |
  | deduplication | 15951 | 19581 | `7571c485b9c9a57d7179db0d1f0f3fa55b6bd9580bb283ead85907dd01326688` |
  | verifier | 15951 | 19581 | `7571c485b9c9a57d7179db0d1f0f3fa55b6bd9580bb283ead85907dd01326688` |
  | sweep | 23245 | 26875 | `0fe7434981737dacc9d3689747d372869824b89c56cb8666b3266a305f00fe88` |
  | merge-rank | 13615 | 17245 | `7a891d802927250b0802b624eea3a88c129c1bd11bd6d2b78266062c2fdcb99e` |
  | test-assessment | 29053 | 32683 | `bd82379c64406c8a37b262153bbb72124b00ad9753429336ef625db26ce61951` |

- **Whole reviews (R11).** One read-only review on each runtime under
  the new roles, of the two changes of R10, so that each stands beside
  the review of the same change under the roles of `a79010f`. Both
  reached a report with every worker completed at its first attempt, no
  angle left out and no group unverified.

  | | pytest on Claude Code, before | after | hono on Codex, before | after |
  |---|---|---|---|---|
  | Candidates from the triage | 7 | 11 | 4 | 4 |
  | Candidates from the nine finders | 41 | 41 | 22 | 22 |
  | Candidates from the sweep | 1 | 3 | 3 | 1 |
  | Candidates verified, after deduplication | 21 | 32 | 26 | 21 |
  | C / P / R | 12 / 5 / 4 | 23 / 7 / 2 | 20 / 6 / 0 | 9 / 9 / 3 |
  | Findings ranked | 12 | 16 | 24 | 18 |
  | Workers | 19 | 23 | 22 | 21 |
  | Cost, time | 6.18 USD, 10 min | 8.59 USD, 12 min | 16 min | 11 min |

  Two runs of the finders never return the same candidates, so the two
  columns of a review are not the same candidates graded twice, and
  none of the new ones is labeled. What the table can say is that no
  phase broke and none collapsed: the nine finders, which do not carry
  the rubric, returned as many candidates as before, and the triage
  and the sweep, which do, returned more on one review and as many or
  fewer on the other. On Codex the verdicts moved as the replay of R10
  said they would. On Claude Code the verifier confirmed 23 of 32 and
  refuted 2, where it had confirmed 12 of 21 and refuted 4; the replay
  of R10 graded those 21 as before under the third rewrite, so the
  difference lies in the candidates or in the paragraph of D14, and
  this run cannot tell which. Its verifiers cost 3.09 USD for 8 groups,
  where 5 groups had cost 1.53.
- **A first look at D14.** In the review on Claude Code three
  candidates say that a statement about the code is false: a sentence
  of the changelog entry, a comment and a docstring, all three from the
  triage and all three confirmed. The earlier review of the same change
  had one, `SCAN-7`, refuted. The review of hono on Codex has none.

Not run. The paragraph of D14 has not been replayed on recorded
candidates or scored against labels, by the author's decision to measure
it later; `SCAN-7` of the pytest review is the first case for it.
