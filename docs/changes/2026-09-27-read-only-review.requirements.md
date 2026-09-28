# Product Requirements: Read-only review

Technical part: [2026-09-27-read-only-review.design.md](2026-09-27-read-only-review.design.md).

## Summary

One command reviews a change and delivers a report, editing nothing. The
engine runs the `SCAN` triage, every one of the ten finder angles,
deduplication, one verifier per file group, a gap sweep with its own
verification, and the merge and rank pass, then writes a Markdown report
into the checkpoint and prints its path. It runs in the foreground and is
resumable: the same command, run again after an interruption, continues
from the last step the ledger holds and pays for no completed worker
twice. Every worker runs under a role policy this repository declares and
the run pins on its ledger; a worker that does not complete is run once
more and then degraded by role rather than stopping the run; a run has a
budget of its own. The engine ships as one bundle inside both skill
artifacts, and the element is accepted by a real run on a change from a
well-known open-source repository, on each runtime.

This is the fifth element of the plan and the first end-to-end milestone.
It joins the four that exist (the checkpoint ledger and evidence store,
scope capture, the runtime adapter and the role prompts) into a review,
and it is the first element whose acceptance gate is a real run, not the
suite.

## Problem

The proof of concept could run a full review but never delivered a report
without a hand on it: five pilot runs on the Tarkov repository, forty-one
workers, 23.93 USD, no report. The elements built so far each took one
boundary the pilots broke on. What is left is the controller that joins
them, and the pilots say as much about it as about the boundaries.

- The control surface was the worst boundary. The skill's model called a
  detached supervisor and polled its status, and that seam produced four
  defects on its own: a `database is locked` misreported as a blocked run
  (D6), an abandoned run still reporting itself blocked (D8), workers
  invisible while they ran (D9), and a retry that wedged the run while
  status said healthy (D11). The runtime adapter left this decision open
  as PD4 until the case existed.
- Blockers had no recovery path. Workspace drift, termination unknown
  after drainage, a stale answered question, a blocker shape the status
  schema rejected: each ended a run, and the last was finished by hand.
- There was no read-only review. The phases were fixed at thirteen,
  editing and steering included, so the cheapest complete run was the most
  complex one, and the read-only pipeline that finds and verifies was
  never proven on its own.
- Angle selection cost a second lead worker and still went wrong. `SCAN`
  recommended run or skip per angle, an `angle-decision` worker vetted the
  recommendation, and the pilots and the prompts both record wrong skips
  that the sweep had to catch.
- Cost was invisible. The engine capped each worker but summed nothing;
  the pilot's cost table was built by hand from forty-one stdout files,
  and budget exhaustion surfaced as a result-contract failure.
- Ninety-two offline test files passed while every real run blocked.
  Offline fixtures were not the right acceptance gate.

In this repository, the ledger records runs and workers, scope capture
freezes the change, the launcher runs one worker on either runtime, and
the prompts are assembled from files here, but nothing joins them: there
is no controller, no policy, no output schema, no report, and no bundle.
The installed skill says the engine has not shipped. Each earlier element
deferred something to this one: the control surface (runtime adapter,
PD4), how the engine is shipped (runtime adapter and role prompts,
Non-Goals), the role policy, the output schemas, the phase narration
and the `CONVENTIONS` scope (role prompts, Non-Goals and D6, D9), the
Claude continuation budget question and the runtime-neutral usage view
(runtime adapter, Open Questions).

## Goals

- A user of either runtime invokes one skill and receives a report on the
  change, with no human step between start and report when every worker
  behaves.
- Everything a phase decided is on the ledger, so a run interrupted at any
  point continues from its last completed step with the same command and
  pays for no completed worker twice.
- Every way a run can stop short of a report names the operator's action,
  and the actions are few: run the command again, raise the budget, put
  the tree back, or abandon.
- Cost is bounded per worker and per run, and the report says what each
  phase spent.
- The policy a run used, model tier, effort, budget and timeout per role,
  is declared in one file here, pinned on the run, and readable from the
  report.
- The engine and its prompts reach an installed skill through the plugin
  marketplace and the Codex skill directory that already exist, with
  nothing else to install but Node.
- One real run on a change from a well-known open-source repository, on
  each runtime, delivers a report.

## Non-Goals

- No editing, no fixer, no documentation pass, no test assessment, no
  check execution. The report is the product; the fix loop is the sixth
  element.
- No audit, no steering, no questions to the author. `CONFIRMED` and
  `PLAUSIBLE` are reported as the verifier gave them; what to do with each
  is the reader's call. The `auditor` and `answer` roles are not run.
- No angle skipping and no `angle-decision` worker. All ten angles run on
  every review (PD3). The `angle-decision` role leaves the manifest.
- No correction of a worker within its session. A worker that does not
  complete is replaced by a fresh worker, once (PD6). The Claude
  continuation budget question therefore stays open; nothing here
  continues a session.
- No detached process and no status polling. The engine runs while its
  command runs, and its state is the fold of the ledger (PD1).
- No mixed runtimes. Every worker of a run uses the run's runtime (PD13);
  a role policy names tiers, not runtimes.
- No per-runtime policy overrides. The proof of concept's Codex-only
  changes to `deduplication` and `verifier` are not carried (PD5).
- No transcript viewer and no streaming of worker output. Progress is
  what the engine prints as each worker starts and ends.
- No suspend detection and no proof that every descendant of a worker
  exited, as the runtime adapter left them (its PD2 and Non-Goals).
- No denials from Codex JSONL. Codex receipts keep `denials: null`; a
  read-only review has nothing to correct with them.
- No configurable list of convention files. `CONVENTIONS` reads
  `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` (PD11); a flag can be
  added when a repository with another name for its rules asks for it.
- No report written into the reviewed tree (PD9).

## Requirements

- **R1: One command runs a review to its report, in the foreground, and
  is resumable.** `deep-review review` with a scope in one of the four
  capture modes creates a run, captures the scope, runs every phase and
  writes the report, then exits with the report's path on stdout. It
  blocks while it works. If it is interrupted, or the process dies, the
  worker tree dies with it (the launcher's rule), and the same command run
  again in the same repository finds the active run, folds its ledger and
  continues from the first step not completed, launching no worker whose
  completed answer is already on the ledger. There is no separate
  `resume` command: continuing is what running again means. A finished
  run is not reopened; the command starts a new one.
- **R2: The phases are fixed and every angle runs.** In order: triage
  (`SCAN`), finders (the nine other angles, in parallel, each given the
  lead `SCAN` returned for it or `none`), deduplication, verification (one
  worker per group), sweep, sweep deduplication and verification when the
  sweep returned candidates, merge and rank, report. No phase is optional,
  no angle is skipped, and the order is the same on every run.
- **R3: A role policy in one file names each role's tier, effort, budget
  and timeout, and the run pins it.** `roles/policy.json` declares, for
  every role this element runs, a tier (`strong` or `fast`), an effort,
  a per-worker budget and a timeout, and per runtime the default model
  for each tier and the default run budget. The command may override the
  models and the run budget. The whole policy as resolved for the run,
  runtime, executable, models, per-role values, concurrency and run
  budget, is one event on the ledger before the first worker, and a
  resumed run uses the pinned policy, not the file. The starting values
  are the proof of concept's (role prompts, D6), with no runtime
  overrides.
- **R4: Every role this element runs has an output schema, and the
  engine validates each answer against it.** Triage returns candidates
  and one lead per other angle; finders and the sweep return candidates;
  deduplication returns groups; verifiers return one verdict with evidence
  per candidate; merge and rank returns ranked findings. Each schema is
  strict and closed as the runtime contract requires, and the prompt's
  prose describes the same fields.
- **R5: A worker that does not complete is run once more as a fresh
  worker; a second failure degrades by role and never leaves the run
  without an operator action.** A `failed`, `timeout` or `budget`
  outcome, or an answer the schema rejects, is retried once with a new
  worker and the same task. On the second failure: a finder's angle is
  recorded as not run and the review continues; a verifier's group is
  recorded as unverified and its candidates carry `PLAUSIBLE` with an
  `unverified` mark, as the prompts already say; the triage,
  deduplication, sweep and merge-rank workers block the run. A blocked
  run records why and what the operator does: run the command again,
  raise the run budget, restore the tree, or abandon. The report names
  every degradation.
- **R6: Concurrency is bounded and the run has a budget.** At most
  `concurrency` workers run at once, 4 by default and 1 to 16 by flag.
  The run's spend, summed from each finished worker's usage through a
  runtime-neutral summary, is checked before every launch; when it has
  reached the run budget the engine launches nothing more and the run
  blocks, naming the spend, the budget and the flag that raises it. A
  runtime that reports no cost in USD has no run budget check, and the
  report says so.
- **R7: Workers receive the scope from the engine and read the live
  tree; the engine checks the tree before every phase.** Each prompt
  carries the base and head, the changed files with their status, and the
  patch itself when it is under a size cap, else the path of the frozen
  patch in the evidence store; the frozen before bytes of each file are
  named by path too. Workers run with the reviewed worktree as their
  working directory. Before each phase starts and before the report is
  written, the engine compares the worktree with the captured scope file
  by file; a difference blocks the run, naming the files, with the
  operator's action being to restore the tree and run again or to
  abandon and start a new run.
- **R8: Candidate locations are normalized and checked, and a candidate
  is never dropped for its location.** A finder's `file` is matched to
  one changed path of the scope, by suffix, accepting backslashes; its
  `line` must lie within the after state of that file. A candidate whose
  file matches no changed path, or whose line is outside the file, keeps
  its verdict path and is marked unlocated, in the verifier's input and
  in the report. No anchor text is required.
- **R9: The report is a Markdown file in the evidence store, named by
  one event, and the command prints its path.** The engine renders it
  deterministically from the fold. Its sections, in order: the header
  (repository, base and head, run id, engine, runtime and models), Angles
  (each of the ten, run or not run, with its lead and the reason when it
  did not run), Findings (every `CONFIRMED` or `PLAUSIBLE` finding after
  merge and rank, most severe first, with its id, merged ids, verdict,
  evidence line, location and the unlocated or unverified marks), Refuted
  at verification (id, location, summary and the verifier's evidence),
  Statistics (per phase and in total: workers, wall time, counting once
  the time workers ran at once, cost where known with the number of
  workers whose cost went unreported, and tokens), and Limitations (degraded angles and groups, the drift checks, and
  anything the run could not do). The skill shows the path and repeats
  nothing of the report in its own words.
- **R10: Every phase decision is on the ledger and the fold gives the
  run's next step.** The pinned policy, each phase's start and end with
  its outcome, each finder's or sweep worker's candidates, each
  deduplication grouping, each verifier's verdicts, the merge and rank
  result, each worktree check and the report are events, each with a
  strict schema. The fold exposes them so that the controller reads the
  next step from state alone, and a golden fixture for the new registry
  is committed with the change.
- **R11: The engine ships inside both artifacts as one bundle with the
  roles beside it, and its identity is its content.** `npm run build`
  bundles the command into `dist/claude` and `dist/codex` with a copy of
  `roles/`, `npm run verify` compares the bundle byte for byte like every
  other file, and every event the installed engine writes carries an
  identity derived from the bundle's bytes. The skill texts tell the
  model how to run the command, how to wait for it and what to show, and
  nothing else about the review.
- **R12: `CONVENTIONS` reads `CLAUDE.md`, `CLAUDE.local.md` and
  `AGENTS.md`.** The angle's fragment, the rubric and the sweep's mention
  name all three at the user level, the repository root and every ancestor
  directory of a changed file; the wording change is its own commit and
  the roles' hashes change with it.
- **R13: Two more commands: `status` and `abandon`.** `status` prints the
  fold of the active run, or of a named run, as text and as JSON: phase,
  workers running and finished, spend, blocker and its action. `abandon`
  closes the active run with a reason, so that `review` starts a new one.
- **R14: The element is accepted by a real run on each runtime.** The
  gate is a change from a well-known open-source repository that stands
  for a common review case, reviewed once with Claude Code and once with
  Codex, each to a report with no hand on the run. The design's
  Verification records both reports' statistics, and the repository, the
  change and why they were chosen.

## Product Decisions

- **PD1: The engine runs in the foreground and is resumable; there is no
  supervisor and no status file.** A detached supervisor with a polled
  status, as the proof of concept had, was rejected: it exists so the
  skill's model can return while workers run, and it cost four pilot
  defects at that seam alone (Problem). A phase controller driven by the
  skill's model, with the engine offering phase commands, was rejected
  too: it puts model judgment in the control flow, so no two runs take the
  same path and the ledger no longer explains a run on its own. The
  foreground engine is one process the model waits for, however its
  runtime waits (a background shell call, a long timeout), and the ledger
  is the only state, so an interruption costs at most the workers in
  flight. That is the case PD4 of the runtime adapter waited for.
- **PD2: The read-only pipeline runs whole, sweep included.** Leaving the
  sweep, or deduplication and merge-rank, to a later element was
  rejected: the prompts assume the whole flow, a report without merging
  or ranking is a list, and the first real run should measure the cost of
  the review the prompts describe, not a subset chosen before any measure
  existed.
- **PD3: All ten angles run; nothing is skipped and no worker decides.**
  Skipping by the engine on `SCAN`'s absence evidence was rejected because
  the engine cannot check the evidence, and a wrong skip is exactly the
  defect the sweep then has to catch. Keeping the `angle-decision` worker
  was rejected because it is a second strong-tier lead whose only output
  is a decision the prompts already say should default to run. `SCAN`
  still returns one lead per angle, and each finder receives its lead.
  Skipping returns as a cost measure if the real runs show one is needed.
- **PD4: The engine ships as one bundle, with the roles, committed under
  `dist/`.** An npm package run through `npx` was rejected: a private
  registry needs a token on every machine and does not fit the Codex
  install, which copies a directory. Running the TypeScript sources with
  Node's type stripping was rejected: the dependencies would have to be
  installed under the plugin, which neither install path does. The bundle
  needs only Node 26 on the user's machine, which `node:sqlite` already
  required. This is the cost the skeleton accepted in its D4.
- **PD5: The policy is a file in this repository with tiers, and the
  models come from flags with defaults per runtime.** One policy for
  every role (strong tier, high effort) was rejected as the most
  expensive guess; a policy held entirely in flags was rejected because
  the skill texts would then hold the values and drift apart. The starting
  values are the proof of concept's table (role prompts, D6), which the
  real runs are the first evidence against. The Codex-only overrides are
  dropped: their reasons hold for both runtimes or neither, and neither is
  measured.
- **PD6: A worker that does not complete is replaced once, then the role
  decides.** Stopping the run on every failure was rejected: an unattended
  run would stop often for what a fresh worker fixes. Correcting a
  schema-rejected answer in the same session, as the proof of concept did
  for read-only roles, was rejected: in a read-only review a new worker
  is simpler, the continuation budget question stays unanswered, and
  nothing here needs a session to continue. A finder or a verifier is
  degraded rather than fatal because the pipeline defines a meaning for
  their absence (an angle not run, a group unverified); the phases that
  every later step depends on block instead.
- **PD7: Concurrency defaults to 4 and the run has a budget.** Unbounded
  concurrency was rejected without a measurement of rate limits and local
  load. A per-worker cap alone, as the proof of concept had, was rejected:
  the worst case is the worker count times the cap and nobody sees it
  until the bill. The run budget is the first consumer of the
  runtime-neutral usage view the runtime adapter deferred, and it is
  known to work only for a runtime that reports cost; for Codex the view
  gives tokens and the report says the budget did not apply.
- **PD8: The report is rendered by the engine.** Handing structured
  findings to the skill's model to render was rejected: a model that
  summarizes can change what a finding says, and the report would no
  longer be reproducible from the ledger.
- **PD9: The report lives in the evidence store, not in the tree.** A
  file under the repository (such as `.deep-review/report.md`) was
  rejected: it dirties the tree being reviewed and could enter the next
  review's scope. The command prints the path, and the skill shows it.
- **PD10: Workers get the scope in the prompt when it is small and by
  evidence path when it is not, they read the live tree, and drift
  blocks.** Embedding the whole patch always was rejected: a scope may
  freeze up to 8 MiB and a prompt of that size wastes every worker's
  context. Continuing after a drift with a note was rejected: a finder
  and a verifier would then have read different code and the report could
  not say which tree it describes. The per-file check the scope element
  built for this gives the operator the file names, and the action is to
  restore the tree or start over.
- **PD11: `CONVENTIONS` covers `AGENTS.md` as well as `CLAUDE.md`.**
  Keeping `CLAUDE.md` alone would leave the angle blind on any Codex
  user's repository and on this one, which keeps its rules in `AGENTS.md`.
  A flag-configured list was rejected for now: the prompt would need a
  variable where it names the files, and no repository has asked for
  another name.
- **PD12: Locations are normalized and checked lightly, and never
  dropped.** Requiring an anchor string, as the proof of concept did, was
  rejected: it produced the CRLF defect (D4) and discarded a valid
  candidate over whitespace. No check at all was rejected: a file the
  scope does not contain breaks grouping by file. An unlocated candidate
  still reaches a verifier, which can read the code, and the report
  shows the mark.
- **PD13: One runtime per run.** Mixing runtimes by role was rejected for
  now: the policy would need a runtime column, the flags would double, and
  nothing measured says a mix is better. It can be added as one column
  later.
- **PD14: The phase narration in the fragments is rewritten for the
  engine, in its own commit.** The role prompts element left the
  narration as the proof of concept wrote it, on the ground that the
  element defining each worker's task decides what it needs to know. This
  element defines those tasks. The fragments that describe checkpoint
  files, dispatch, angle skipping and the fixer's Step 1 are cut to what
  a worker of this pipeline needs (what the phases are, what its answer
  feeds), so that a worker is not told about an `angle-decision` that
  does not exist or a `ranked.md` nobody writes. The text change is
  separate from the code, as AGENTS.md requires, and the guard tests
  that pin the prompts move with it.
- **PD15: The acceptance gate is a change from a well-known open-source
  repository, on both runtimes.** Reviewing this repository's own change
  was not taken: it tests one codebase the author knows, and a reader
  cannot judge the report against unfamiliar code. The Tarkov pilot
  repository was not taken as the gate: its .NET build servers and CRLF
  history belong to the editing element, where checks run. The change
  chosen is a merged pull request of moderate size in a popular
  repository whose rules file exists, so that `CONVENTIONS` runs on
  something real; the design's Open Questions carries the choice until
  the run.

## Risks

- Risk: the foreground engine may outlast the skill runtime's tool-call
  limit, and a model that does not know how to wait may report the run
  as failed while it continues. Accepted; the skill texts say how to
  wait on each runtime, an interrupted engine kills its workers and the
  next invocation resumes, so the cost is time, not correctness.
- Risk: a run budget that is checked before each launch, not during a
  worker, can be exceeded by up to `concurrency` workers' caps. Accepted;
  the per-worker cap bounds the overshoot, and the report shows the
  reported spend and how many workers' cost went unreported. The check
  sums reported costs only, so a worker that times out, fails before its
  runtime prints its usage, or is lost with its engine adds nothing to it.
- Risk: with no cost in USD from Codex, a Codex run has only per-worker
  timeouts and the worker count as its bound. Accepted and reported;
  a token budget can follow when a token price is known.
- Risk: always running ten angles costs more than the proof of concept's
  skipping did on small diffs. Accepted; the first real runs measure it,
  and skipping is a cost measure to add with a measurement, not before.
- Risk: the policy's starting values are the proof of concept's, chosen
  for Claude Code models, and may suit Codex models poorly. Accepted; the
  real run on Codex is the first evidence, and the policy is one file.
- Risk: rewriting the narration changes every prompt's hash, and a
  worse prompt would show only in review quality. Accepted; the rewrite
  removes text about mechanisms the worker does not have and adds no
  instruction, and the two real runs are read for quality, not only for
  reaching a report.
- Risk: a worker orphaned by a hard kill of the engine (which no exit
  handler sees) may still be running when the resumed engine records it
  lost and starts a replacement, paying twice. Accepted; the worker is
  read-only, the launcher's tree kill covers every ordinary exit, and job
  objects were rejected in the runtime adapter for good reason.
