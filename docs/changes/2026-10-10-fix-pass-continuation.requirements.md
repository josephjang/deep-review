# Product Requirements: Fix pass continuation

Technical part: [2026-10-10-fix-pass-continuation.design.md](2026-10-10-fix-pass-continuation.design.md).

## Summary

A read-only run that has written its report can be continued as a fix
run. `deep-review review --fix`, given the scope flags of a change a
finished read-only run reviewed in this worktree, and with that change
unchanged since, continues that run instead of starting another: it
asks the surveyor which commands are the repository's checks, runs the
five phases of the fix pass on the findings and decisions the run
already holds, and writes a second report. No finder, verifier,
merge-rank or decider runs again. Today whether a run fixes is pinned
when it is configured and a finished run is never reopened, so "review,
read the report, then fix" costs a second full review; after the change
it costs the fix pass alone. A run started with `--fix` is unchanged,
and so is a read-only run that nobody continues.

This is the first item of the plan reoriented on 2026-10-10 around the
review as the one gate an agent-written change passes through: the
person's step between reading and fixing should cost nothing but the
fixing.

## Problem

A run is one review of one change. `deep-review review` without `--fix`
runs the survey, the ten finder angles, deduplication, verification, the
sweep, merge and rank and the decision, and writes a report; with `--fix`
the same run goes on through baseline checks, fixes, checks, repair and
the repair's checks before its report. Whether a run fixes is recorded
on its configuration event and never changes: a resumed run that is
given `--fix` logs the flag as ignored (R1 of the fix pass,
`resumePinned` in `src/review/controller.ts`), and a run whose report
is written is complete and is never resumed; the next `review` command
creates a new run (R1 of the read-only review, `isResumable`).

The natural way to use the engine is to read before fixing. The skill
text says so: without a request to fix, `--fix` is not passed, so that a
user who has not read the findings does not find the tree changed (PD2
of the fix pass). A user who reads the report and then asks for the
fixes therefore pays for the whole review a second time. On this
repository a run costs 10 to 55 USD, and the fix run's second review of
the same bytes produces, at best, the same findings again, and at worst
different ones from a different sampling, so the fixes that land are
not the ones the person read.

Everything the fix pass needs after the decision is already on a
read-only run's ledger. Since the decision step, every run decides every
ranked finding, `--fix` or not (PD8 of the decision step), and a fix run
routes its findings by those decisions alone (R6 of the decision step).
The frozen scope, the ranking, the decisions and the convention sources
are all events, and the planner is a pure function of the fold (TD1 of
the read-only review). What a read-only run lacks is only what it was
never asked for: the checks, which the surveyor chooses only in a run
that fixes (PD10 of the repository survey), the per-check timeout and
the fixer batch size the configuration pins only when it fixes, and
the five phases, which the fold marks skipped at configuration (TD9 of
the fix pass).

The fix pass considered a continuation and rejected it then: a finished
run was closed, the fix phases needed the worktree the review saw, and a
continuation was to be designed together with the audit (PD2 of the fix
pass). The audit has since been set aside, because the decision step
made its population disappear, and the fix run's routing now comes from
decisions a read-only run already recorded. The two things PD2 waited
for have been answered by other elements; what remains is the pin and
the checks.

## Goals

- A person who ran a read-only review and read its report gets the
  fixes by running the same command again with `--fix`, paying for the
  fix pass and nothing of the review again, with no hand on the run.
- The fixes that land are fixes of the findings the person read, under
  the decisions the person read, on the bytes the review saw.
- The engine decides whether to continue and says what it decided and
  why; a continuation is never silent, and a new run started instead of
  one says why the finished run did not qualify.
- A continued run is one run on the ledger: one scope, one set of
  findings and decisions, one series of commits, and a report that
  stands on its own.
- An older engine still reads every ledger it could read before, and
  this engine reads every ledger written before it.

## Non-Goals

- **No continuation of an active read-only run.** A read-only run that
  is interrupted and resumed with `--fix` keeps ignoring the flag, as
  today; the log now adds that the run can be continued once its
  report is written (PD4).
- **No second review.** No finder, verifier, deduplication, sweep,
  merge-rank or decider runs in a continuation; the findings and
  decisions are the first pass's. A person who disagrees with a
  decision has no way to say so here; that is the `answer` command of
  the plan's second item.
- **No continuation of a changed change.** When a file of the scope
  differs from what the run froze, or `HEAD` moved, or the scope flags
  name another change, a new run is created and the log says which
  finished run did not qualify and why (PD3).
- **No continuation of a fix run** into more fixing, no second fix pass
  on a run that already fixed, and no way back from a fix run to a
  read-only one.
- **No `--run` on `review`.** The engine chooses the run by the scope;
  the only choice the person makes is `--fresh`, which declines a
  continuation (PD2).
- **No new survey of the conventions.** The convention sources a
  continued run was reviewed against stand; the surveyor is asked only
  for the checks (PD5). A completed survey is otherwise never repeated
  (PD11 of the repository survey).
- **No separate budget for the continuation.** The run budget is the
  run's, over both passes (PD7).
- **No change to a read-only run's events or report**, to a run started
  with `--fix`, to the fix pass's phases, routing, clustering, claims,
  checks, patches or `commit`, or to any skill text beyond the step that
  passes `--fix`.
- **No Codex gate.** The element is accepted on Claude Code, as the fix
  pass has been since the decision step (PD9).

## Requirements

- **R1: `review --fix` continues a finished read-only run of the same
  change.** When the command finds no active run to resume and is given
  `--fix`, and a run of this worktree qualifies (R2), the command
  continues it: the run becomes a fix run on the ledger, its checks are
  settled (R4), the five fix phases run on the ranked findings routed by
  the decisions the run recorded, and a report is written. No worker of
  a read-only phase is launched again, and the scope, the candidates,
  the verdicts, the ranking, the decisions and the convention sources
  are those the run holds. The command then behaves as a fix run's
  does: it exits 0 with the new report's path as the last line of
  stdout, or 2 with a blocker or a refusal.
- **R2: Which run is continued, and what the command says.** The run
  continued is the newest run of the ledger that was created in this
  worktree, is complete, ran without the fix pass, was configured with
  the decision step, and whose captured scope is the change the command
  names: the same mode, the same base and head, the same paths, and
  every captured file holding the contents the run froze, compared as
  git would store them (R22 of the fix pass), with `HEAD` at the scope's
  head. The log names the run it continues, where its read-only report
  is, and the run's spend so far against the budget in force. When no
  run qualifies, the log says so, names the newest finished read-only
  run of this worktree with the first reason it does not qualify (the
  scope differs, a file changed since, `HEAD` moved, or it was
  configured before the decision step), and a new run is created as
  today. `--fresh` declines a continuation: a new run is created and
  the log says no finished run was considered. `--fresh` without
  `--fix` is a usage error. An active run is still resumed first,
  `--fresh` or not; it is dropped by `abandon`, as today.
- **R3: A continuation obeys what the run pinned.** The run's runtime,
  roles digest, Codex Windows sandbox and executable are held to as a
  resume holds to them (`resumePinned`): a different `--runtime` or
  `--codex-windows-sandbox`, or roles that digest differently, refuse
  the continuation with the same message, whose way out names
  `--roles <dir>` or the flag that matches and, in place of abandoning,
  `--fresh`; a pinned executable that no longer qualifies refuses as
  today. `--strong-model` and `--fast-model` are named as ignored;
  `--concurrency` and `--budget-usd` apply to the invocation as they
  apply to every invocation; `--check` and `--no-check` apply until the
  checks are planned, as in every fix run (TD6 of the repository
  survey). The fixers and the repair worker run under the role policy
  the run pinned when it was configured, including its Codex Windows
  sandbox, whose warning prints as it prints for every fix run.
- **R4: The checks are settled before any fix phase, by the flags and
  the surveyor, with the conventions standing.** A continued run whose
  flags leave a kind unsettled re-enters its survey phase with one
  surveyor worker, which is told the convention sources and user-level
  decisions the run recorded and is asked only to choose the checks for
  the unsettled kinds, as a fix run's surveyor is asked; the answer is
  recorded with the standing conventions, and an answer that names
  conventions or user-level decisions of its own is a failed attempt
  with the one fresh retry every role has. From there the survey phase
  behaves as a fix run's: the checks are planned from flags and answer
  before any check runs, a check whose tool is missing blocks with
  `check-unavailable` and the operator's three actions, and a surveyor
  that fails twice blocks unless the flags settle every kind. When the
  flags settle every kind, the checks are planned with the continuation
  and no surveyor runs. A read-only run that went on without its survey
  is continued only by an invocation whose flags settle every kind;
  otherwise the continuation is refused naming the flags, and the run
  stays complete.
- **R5: A run with nothing to fix is not continued.** When no ranked
  finding of the run routes to a fixer by its decision (every finding
  was left, or asked with an applied option that keeps the code, or the
  ranking is empty), the command refuses with exit 2, naming the run and
  the counts, and saying that `--fresh` starts a new run; nothing is
  appended to the run and no check runs.
- **R6: The ledger records the continuation as one event after the
  report, and every older ledger still reads.** One event records that
  the run now fixes, with the per-check timeout and fixer batch size
  the policy gives at that moment and, when the flags settled every
  kind, the planned checks; folded, the run reads as a fix run whose
  fix phases are pending, whose report phase and, when a surveyor is
  needed, whose survey phase are open again, and whose first report is
  kept beside the second. The event is refused on a run that has no
  report, already fixes, is abandoned, was configured before the
  decision step with findings ranked, or went on without its survey
  and is given no planned checks. The configuration event, every
  read-only event and the first report are unchanged. Every committed
  golden fixture and every recorded run of the replay corpus still
  opens and folds, and a new golden fixture holds a continued run.
- **R7: The continued run's report and `status` say so.** The second
  report is a full report with the fix sections, the patch series and
  the statistics of the whole run, both passes counted; its header
  says the run was continued into the fix pass, when, and where its
  read-only report is. The read-only report stays in the evidence
  store. `status` on a continued run shows the read-only report's path
  beside the current state and, once written, the second report; its
  `--json` carries both.
- **R8: A continued run resumes as a fix run.** Interrupted anywhere
  after the continuation, the same command run again resumes it as it
  resumes any fix run: `--fix` absent is logged as ignored, the check
  flags apply until the checks are planned, lost workers are recorded,
  and the phase is re-entered. A continued run is never continued
  again.
- **R9: `deep-review commit` commits a continued run as it commits any
  fix run.** The commits are built from the run's revisions with the
  fixers' messages and the run's trailer, under the same refusals.
- **R10: An active read-only run given `--fix` says how to continue.**
  The line a resumed read-only run logs for an ignored `--fix` adds
  that the run can be continued into the fix pass by running again with
  `--fix` once its report is written.
- **R11: The skills and the README say it.** Both skill texts say
  that, after a read-only run, when the user asks for the findings to
  be fixed, the same command is run again with `--fix` and the engine
  continues the finished run when the change is unchanged, reviewing
  nothing again; the warning that the workers edit the tree and run
  the checks is given before that command as before. The skill texts
  change in their own commit. `README.md` says a finished read-only
  run is continued by `--fix`, under what conditions, and points at
  this proposal.
- **R12: The gate.** One real change is reviewed read-only on Claude
  Code to its report, and the same command with `--fix` continues it
  to a second report with no hand on the run. The design's Verification
  records both reports, the spend of each pass, the workers each pass
  launched, which checks the continuation chose and how, and the
  author's reading of the fixes against the findings the first report
  listed.
- **Metric:** the cost of reading before fixing. Baseline: a read-only
  run plus a fresh fix run of the same change, which pays the review
  twice. Target: the read-only run plus its continuation, which pays it
  once. Measured on the gate change as the spend of each pass the
  reports' Statistics give; the saving is the read-only pass's spend,
  since that is what the fresh fix run would pay again.

## Product Decisions

- **PD1: The finished run is continued; no new run inherits its
  findings.** A new run that copies the first run's ranking and
  decisions was rejected: the ledger's rule is that a run is one review
  with its own evidence, the decisions are evidence of the run that
  made them, and a copy would have to re-freeze the scope, carry
  another run's ids in its commit trailers, and answer which of the
  two runs `commit` and `status` mean. One run, continued, keeps every
  reader of the ledger as it is.
- **PD2: The engine chooses the run; the person can only decline.** A
  `--run <id>` on `review` was rejected for now: the person would have
  to find the id in a report header or a status line, the skill would
  have to carry it between two turns, and the engine can tell from the
  scope flags and the tree whether a finished run reviewed this change
  as it is. `--fresh` exists for the cases a person may want a new
  review of an unchanged change, such as a new engine build or new
  prompts, and for the refusals of R3 to name a way out that is not
  abandoning a complete run. Revisit when a worktree accumulates
  several finished runs of one change that a person wants to choose
  between.
- **PD3: Only an unchanged change is continued.** Continuing and
  letting the worktree check block with `drift` was rejected: the
  blocker's action is to restore the tree, and a person who edited
  after reading the report wants the new tree reviewed, not the old one
  restored. The comparison is the one the run already makes before
  every phase, extended to the scope flags and the set of paths, so a
  file added since the review is a change too.
- **PD4: Only a finished run is continued.** Letting a resumed
  read-only run take `--fix` at any point before the fix phases was
  rejected: the survey would have to be asked again mid-run for the
  checks, the person's intent mid-run is unclear (they have not read a
  report), and the case the plan names is reading first. The log tells
  such a person what to do instead (R10). Revisit if runs are started
  read-only by habit and switched before they finish.
- **PD5: The checks are asked of the surveyor, once, with the
  conventions held.** Three alternatives were rejected. Asking every
  read-only run for its checks, so that a continuation needs no worker,
  would pay for tool lookups in every run and give a read-only run a
  `check-unavailable` answer it cannot act on, reversing PD10 of the
  repository survey for a case that may never come. Planning the checks
  from the manifest hints alone was rejected by the survey proposal and
  is not reopened. Requiring `--check` and `--no-check` for every kind
  would put four flags between the person and the fixes. The survey's
  conventions are not asked again, because every later worker of the
  run was held to them and a different answer would make the report's
  Conventions section untrue of the review it describes.
- **PD6: Nothing to fix is a refusal, not a run of the checks.** A
  fresh fix run cannot know in advance that no finding routes to a
  fixer and runs its baseline checks anyway; a continuation knows,
  because the decisions are on the ledger, and running the checks to
  write a report that applies nothing would spend minutes for no
  change. The refusal says what the decisions were, and `--fresh`
  remains for a person who wants the review again.
- **PD7: The run budget is the run's, over both passes.** A fresh
  budget for the continuation was rejected: a fresh fix run of the same
  change pays the review again inside the same budget, so a
  continuation under the run's budget has at least as much left for its
  fixes as that run would, and a budget blocker's action already names
  `--budget-usd`. The continuation's log names the spend so far and the
  budget in force, so a person raises it before paying for a surveyor
  that blocks.
- **PD8: The roles digest must match.** Pinning the fix roles again
  with their own digest, so that a run reviewed under one plugin version
  could be fixed under the next, was rejected: the report says one
  digest for every worker it ran, and a second digest would make every
  reader of that line ask which workers it covers. `--roles <dir>` runs
  the continuation with the prompts the run started with, and `--fresh`
  reviews again under the new ones.
- **PD9: The gate runs on Claude Code only.** Codex is a judging
  runtime in this repository and no fix run has used it since the
  decision step (its Non-Goals); the plan's tenth item is the cycle on
  Codex.
- **PD10: The continuation writes a full second report.** A fix-only
  addendum to the first report was rejected: the report is the one
  document a reader opens, the fix sections refer to the findings by
  number and the Decisions section is what the author reads first, so
  the second report must stand alone; the first stays where it was for
  whoever holds its path.

## Risks

- Risk: time passes between the review and the continuation, and only
  the tree is checked. The repository's rules files, CI and the tools
  on the machine may have changed; the conventions stand by PD5, and
  the checks are chosen afresh, so a change to CI is seen and a change
  to a rules file is not. Accepted: the fixers edit what the findings
  name, and a rules change between reading and fixing is a new run's
  concern, as it is for a resumed run (PD11 of the repository survey).
- Risk: the decisions bind the fixers though the person has read the
  report and may disagree with one. Accepted: the plan's second item
  gives the person the `answer`; until then, a person who disagrees
  edits the decision's rule or fixes by hand, as they would after a
  fresh fix run.
- Risk: two finished read-only runs reviewed the same unchanged change,
  and the newest is continued. Accepted: the older one is not touched,
  and the two reviews differ only by sampling.
- Risk: a read-only run that spent near its budget blocks the
  continuation at its first launch. Accepted: the log names the spend
  and the budget before the launch, and the blocker's action names the
  flag.
- Risk: one more surveyor worker per continuation, at the policy's cap
  of 8 USD and the strong tier. Accepted against the alternatives of
  PD5; the worker reads CI and manifests, not the change.
- Risk: a person expecting a fresh review with `--fix` on an unchanged
  change gets a continuation. Accepted: the log says so on the first
  line about the run, and `--fresh` is the one flag to add.
