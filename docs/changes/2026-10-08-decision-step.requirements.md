# Product Requirements: Decision step

Technical part: [2026-10-08-decision-step.design.md](2026-10-08-decision-step.design.md).

## Summary

After merge and rank, and before anything is fixed, one `decider` worker
decides every ranked finding: `fix` it, with the approach a fixer
applies and the options it rejected; `leave` it, for one of three
stated reasons; or `ask` the author one question, with a default
applied now so the run never waits. A fixer is then given the decision
together with every merged candidate's own verdict and evidence, and the
report opens with what was decided: the questions as a checklist, the
findings to fix and how, the rules a fix departs from, and the findings
left and why. The step runs in every run, `--fix` or not, since its
questions are the author's work list either way; it costs one worker.

The decision replaces `routeOf`, which routed a finding by its merged
verdict and its primary's angle alone. Three places answered the same
question, who decides and how: the verifier's `Needs the author:` note,
which is prose the engine never read; merge and rank, which folds
candidates and with them those notes; and `routeOf`, which looked only
at the angle. They now feed one decision, made with the whole finding in
view and recorded on the ledger before any edit.

## Problem

Measured on the verifier rubric's replay corpus (`C:\Users\josep\projects\gate\replay`),
the notes of 2026-10-07 (`projects\gate\notes\2026-10-07-decision-step`):

- **The verifier's note is prose.** Under the current rubric Claude
  attached `Needs the author:` to 31 of the 89 candidates it kept and
  Codex to 18 of 92; of the ten correctness candidates labeled as the
  author's call, Codex noted one. Nothing reads the note: every
  correctness finding went to a fixer whatever it said, 17 of them
  labeled as the author's call, on both runtimes.
- **Merging buries the note.** A merged finding is CONFIRMED when any
  member is, and its evidence is the first confirming member's. In the
  R11 pytest run three merged findings lost a member's note this way; in
  a simulation of the five replayed runs under the current rubric, 17
  candidates were escalated by merging and 7 merged findings dropped a
  note. The escalation itself was right in every case read; what it
  dropped was who should decide, mostly a design member asking how to
  fix the defect the confirmed member names.
- **Routing reads the angle, not the finding.** A PLAUSIBLE design
  finding is held for the author whatever it says, even inside the
  change with one sound result, and a correctness finding goes to a
  fixer even when acting on it means choosing between two behaviors.
- **A fixer decides by default.** A fixer that meets a choice either
  makes it silently or defers it, and its task gives each merged member
  only as `<id> at <location>`, so it cannot see which member raised the
  choice.

The author's goal for the engine, stated 2026-10-07, is the least human
involvement: the engine decides and discloses, a question only a person
can answer is asked once and never blocks, and a rule, like a person's,
can be departed from when it is found wrong.

## Goals

- Every ranked finding gets one recorded decision, made before any edit,
  with the whole finding and every member's verdict and evidence in view.
- A question goes to the author only when the repository holds no
  answer, never stops the run, and carries a default that is applied.
- A finding is left only for a stated, closed reason the report shows.
- A fixer applies the decision and is told everything the decider read
  about the finding.
- The step is measured before it is proposed, on both runtimes, against
  the replay labels.

## Non-Goals

- **A memory of answers.** An answer the author gives is not recorded
  or reused by the engine; each option's rule text is what a person adds
  to a convention source so the next review settles the question alone.
- **An `answer` command** that records the author's answer and fixes
  that finding again: a new command, event and resume path, a later
  proposal.
- **An adversarial second decider**, a re-run of the decision after the
  fixes, a debate between workers, or a model that reconciles deciders.
- **A mode where a person decides before the fixes.** The ledger
  records every decision before any edit, so such a mode can stop there
  later.
- **The verifier's output and rubric grades.** No field is added to the
  verifier's answer and its grade tables are unchanged; R11 changes only
  the sentence of each rubric that says what a grade does next.
- **Renaming phases** (`triage` to `scan`, `merge-rank` to `merge`): the
  phase names are frozen in the events, and a rename needs every
  phase-carrying kind again; a refactor of its own.
- **Merge and rank folding two findings that share only a rule.** One
  case in the corpus (click CONVENTIONS-1 and CONVENTIONS-2); recorded as
  a risk.
- **A Codex fix gate.** Codex is a judging runtime here: the decision is
  measured on both runtimes, the fix run on Claude Code alone.

## Requirements

- **R1: A `decision` phase runs after merge and rank and before the fix
  pass, in every run configured with it.** It runs in a read-only run
  and in a fix run. Its one unit is `decision`, its role `decider`,
  read-only with a shell, pinned by the role policy like every role
  (strong tier, high effort, 8 USD, 1800 s). A run whose ranking holds
  no finding launches no decider and completes the phase.
- **R2: The decider sees every ranked finding whole.** Its task numbers
  the ranked findings in the engine's order, each with merge and rank's
  summary and reason and every candidate merged into it, primary first,
  with that candidate's angle, location, claim, own verdict and own
  evidence line. It decides each finding as one: when one member needs a
  choice, the decision makes it for every member. It does not grade a
  finding again.
- **R3: Every finding gets one of three decisions, each with its
  parts.** Every decision carries one sentence of grounds. `fix` gives
  the approach a fixer applies and the options rejected, each with why.
  `leave` gives one reason of three: `outside-change-not-regression`
  (acting on it would edit only code the patch neither adds nor changes,
  outside every function it edits, and the change neither caused nor
  worsened it), `superseded` (another finding decided `fix` removes it,
  named), or `intended` (the repository states the behavior on purpose
  and the rule's reason, quoted, reaches the case). `ask` gives one
  question, two to four options each with its cost, the rule a
  convention source would state if the author chose it and whether it
  edits the code, the option recommended, the option applied, and where
  the decider looked. A `fix` alone may depart from a rule, naming the
  rule, its source and why. An answer that misses or repeats a finding,
  gives a decision another's parts, or names an option or a superseding
  finding that does not exist is a failed attempt.
- **R4: An ask never stops the run.** Its applied option is the one
  easiest to take back: for a behavior the change altered, the behavior
  before it; for one that was there before, keeping it; for a public
  interface, leaving it unchanged. A fixer applies it when it edits the
  code; the author's answer is needed only to go another way.
- **R5: A choice is settled by a presumption the decider may rebut.**
  In order: the change's stated intent; the repository's stated
  contract; for a behavior the change altered, the behavior before it;
  for one there before, keeping it. A choice only a maintainer reading
  the code would see goes the way the surrounding code goes, else the
  way that adds less. Before departing from a rule the decider finds its
  reason; departing takes a fact, the reason not reaching the case or a
  harm shown by a probe or a trace, never a preference. A departure that
  is reversible and inside the change is decided `fix`, named, and the
  fix amends what states the rule; a rule that is public or hard to take
  back is followed, and whether it should change is asked, the rule as
  the default.
- **R6: A finding is routed by its decision.** A `fix`, and an `ask`
  whose applied option edits the code, go to a fixer; a `leave`, and an
  `ask` whose applied option keeps the code, go to none. `routeOf` is
  gone: no route depends on a verdict or an angle. A fix run configured
  before the decision step that has not planned its fixes is refused
  when it resumes, and must be abandoned.
- **R7: A fixer is given the decision and the whole finding.** Its task
  gives each finding's decision (the approach and the options rejected,
  or the ask's question and the default to apply, and any rule departed
  from), every merged candidate's own verdict and evidence, and every
  finding left as superseded by it, whose removal it checks. It never
  defers a finding over a choice its decision made: it defers only by
  the criteria its role prompt keeps (R12), and when the reason is a
  fact the decision did not see, it names that fact. A fix that changes
  a behavior a test pins changes that test and says which and why in the
  note and the commit message's body.
- **R8: The report and `status` show the decisions.** A Decisions
  section follows the header: a count of the decisions and of the fixes
  that depart from a rule; the questions for the author as a checklist,
  each with the default applied, the option recommended, every option's
  cost and rule, and where the decider looked; the findings to fix with
  their approach, rejected options and departures; and the findings left
  with their reason. Each finding under Findings closes with its
  decision. In a fix run, Fixes says of a finding no fixer saw that it
  was left by decision or asked with the code kept, and the header
  counts both. `status` prints the decisions' counts, and `--json`
  carries them. A run configured before the decision step reads as it
  did.
- **R9: The decider's failure blocks; nothing degrades.** A decider
  that fails twice blocks the run with `worker-failed`; a lost one
  blocks as any unit does; the run budget blocks the phase as it blocks
  every phase that reads. No fixer acts on a finding nobody decided.
- **R10: The ledger records the decisions, and an older ledger still
  reads.** The decisions are one `decisions.recorded@1` event, by
  finding id. A run configured at `review.configured@5`, whose payload is
  version 4's, runs the decision; one configured at version 4 or earlier
  records it skipped and has no decisions. The six kinds that carry a
  phase gain a version 4 that can name `decision`. Every committed
  golden fixture and every recorded run of the replay corpus still opens
  and folds.
- **R11: Each verifier rubric says its grades feed the decision step.**
  The first lines of each rubric and the last lines of the verify brief
  say that CONFIRMED and PLAUSIBLE go to the decision step and REFUTED
  removes the candidate, instead of naming where each grade went. Before
  it lands, the verifier is replayed with the changed text on the two
  validation runs, one sample per runtime, and its outcomes stay within
  the variation the verifier rubric's R10 measured.
- **R12: A fixer's defer is narrowed to what the decision did not
  see.** For a fixer given a decision, the defer criteria "semantics
  genuinely ambiguous and need a human design call" and "crosses a
  public API boundary" are replaced by "the decision you were given did
  not see a fact you found"; the others stay. A worker of the fixer role
  given no decision, the repair worker and a fixer of a run configured
  before the step, keeps those two criteria, since no decision made
  those calls for it.
- **R13: The step was measured before this proposal, and its numbers
  set its limits.** A draft decider ran over the five replayed runs, two
  samples per runtime and a third on the findings they split on (design,
  Verification). Its slowest worker sets the decider's timeout.
- **R14: The gate.** pytest #14447 on Claude Code and hono #5513 on
  Codex, read-only, once each, and one pytest fix run on Claude Code;
  every phase completes, no unit degrades, and the report's decisions
  are read against the metrics below.

## Metrics

- Questions per run: at most 2 on average, with every one carrying the
  places the decider looked.
- False alarms: no `ask` on a finding a member of which is labeled
  `apply`.
- Real defects left: no `leave`, for a reason other than `superseded`,
  on a finding a member of which is labeled `apply`.
- The two runtimes' decision kinds agree on most findings; the target is
  near the verdicts' agreement, 103 of 112.
- Every leave and its reason, and every departure, is in the report.
- The share of findings a fixer defers, before and after (R12).
- The overturn rate, the share of decisions an author reverses, is
  defined here and measured once authors answer questions; nothing
  records it yet.

The share of `ask` labels the decider asks about is not a metric. The
labels mark what an adjudicator judged to be the author's call; the
step's purpose is to settle as many of those as the repository allows,
so asking about all of them would be the failure, not the target.

## Product Decisions

- **PD1: The decision is its own step, after merge and rank.** The
  verifier was rejected as the decider: it sees one file's group, before
  merging, and a decision there costs every candidate a refuted one never
  needed, while its rubric was just measured and would move. Merge and
  rank was rejected: it reads the whole list in one pass, which suits
  ranking and not deep reading or probes, and its ranking would move
  with its prompt. The fixer was rejected: the one who fixes deciding
  whether to fix is biased toward fixing, and each cluster would decide
  alone, inconsistently. The auditor, which reads the fixer's defers,
  was left for later: its value is what only a finished fix pass knows,
  and the defer rate is measured first (R12).
- **PD2: One decider per run.** One per cluster was rejected: a run's
  findings often share one policy question (three of zod's merged
  findings asked how ASSUMED is handled), and separate deciders can
  answer it differently. The cost is one worker; its time is measured
  (R13).
- **PD3: Every finding is decided, not only those with a note.** A
  CONFIRMED finding with no note can still hide a departure from a rule
  or a choice, and the note is unreliable on Codex. An obvious finding
  is decided in a sentence.
- **PD4: Three decisions, and `leave` closes on three reasons.** The
  plan this proposal started from named two reasons. The third,
  `intended`, came from the draft rubric: a finding that calls a stated
  rule wrong, where the rule's reason does cover the case, has nothing to
  fix and nothing the repository has not answered, and asking about it
  would be a question the repository answers. It is the reason most
  exposed to the decider talking itself out of a finding, so it requires
  the rule's reason quoted, and every such leave is listed.
- **PD5: An ask is answered by a default, not by waiting.** A blocking
  question was rejected outright: it would put a person back on the
  critical path of every run that has one.
- **PD6: An ask whose default keeps the code goes to no fixer.** In the
  experiment 22 of 25 asks applied such a default; sending them to a
  fixer would give it nothing to do but report the code unchanged. The
  answer records whether each option edits, so the route is mechanical.
- **PD7: Reversibility gates a departure.** A decider that departs from
  a public or hard-to-reverse rule on its own reading would change what
  callers rely on; such a rule is followed and the question asked.
- **PD8: The read-only run decides too.** Skipping the step without
  `--fix` was rejected: the questions are the author's work list whether
  or not the engine edits, and the report's Decisions section is what
  the author reads first. The price is one worker per run.
- **PD9: No two-plus-one fold.** Two deciders per runtime, with a third
  on the findings they split on, was to be proposed if two thirds of the
  splits fell on findings labeled as the author's call and false alarms
  stayed at one per run or fewer. 17 of 32 splits (53 percent) did, so
  the step runs one decider. A majority of three settled 27 of the 32
  within each runtime, but the runtimes' majorities still differed on
  21: the remaining spread is between runtimes, which a fold within one
  does not reach.
- **PD10: No degrade path.** Routing by `routeOf` when the decider fails
  was rejected with `routeOf`: a second routing rule that only runs on
  failure is a second behavior to keep correct, and a block costs one
  more invocation.
- **PD11: A fix run configured before the step is refused, not routed
  the old way.** Keeping `routeOf` for such a run would keep the rule
  this proposal removes; the repository has no users whose runs are in
  flight, so such a run is abandoned.

## Risks

- **A plausible reason for anything.** A model writes a convincing
  departure or `intended` leave as easily as a correct one. Each is
  listed in the report, counted, and read against the labels; the
  experiment found none on an `apply` label.
- **Too many questions.** Four of the twenty run samples asked three or
  four; the average was 1.25. A rubric that asks less is the next lever.
- **`leave` as a soft refute.** `intended` and `outside-change` keep a
  real finding out of the fix pass; the report says each with its rule
  or its reason, and the finding stays under Findings.
- **The runtimes decide differently.** Claude asks or leaves as intended
  where Codex fixes, on a stable set of findings (PD9). Which is right
  is a judgment the labels only partly settle.
- **Cost.** One more strong worker per run: 0.57 to 1.61 USD on Claude
  in the experiment, against a run of 30 to 60 USD.
- **A decider that reads the evidence and not the code.** Its task asks
  it to read and probe; the experiment's departures cite probes and
  traces, but nothing checks that it did.
- **A merge that binds unrelated findings binds their decision.**
  Folding two defects that share only a rule puts them under one
  decision (Non-Goals).
- **Calibrating the rubric costs runs.** Twenty workers for each draft;
  a second rewrite against the same five runs brings back a held-out set.
- **R11 rewrites a sentence the verifier reads.** It names no grade
  boundary, so the grades should not move, which is why it is replayed
  before it lands rather than assumed.
- **A run in flight cannot resume.** The roles digest changes with the
  decider's prompt, so a configured run refuses to resume without
  `--roles <old dir>`, and a fix run configured before the step is
  refused even with it (R6).
