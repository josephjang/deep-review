# Product Requirements: Runtime adapter

Technical part: [2026-09-27-runtime-adapter.design.md](2026-09-27-runtime-adapter.design.md).

## Summary

Give the engine a way to run one model worker without knowing which
runtime it is talking to. A runtime-neutral invocation names what the
worker may do, what it must return and what it may spend; Claude Code and
Codex are the first two runtimes behind it, and a third is added by
registering one more adapter. The worker is on the ledger before its
process exists, everything it was given and gave back is evidence, and a
permission denial, a budget stop and a timeout are each their own outcome
rather than one failure. There are no job objects: a worker is a child
process, killed with its tree on timeout.

## Problem

The proof of concept could launch a Claude or Codex worker, and the pilots
showed that the boundary between the engine and the runtime CLI was where
runs died. Each item below is a pilot defect from
`agent-skills/docs/handover/2026-09-22-deep-review-node-tarkov-pilot-defects.md`
and its follow-ups, or a design flaw the fixes for those defects exposed.

- Qualification pinned one exact CLI version, and Claude Code auto-updates,
  so every new user was refused at the door (D2). The later fix gated on
  the flags the engine needs instead; that rule belongs in the design, not
  in a patch.
- A read-only finder had no place to write a temporary file that both its
  shell and its file tools could see, wrote into the reviewed tree, and
  ended the run (D3). The scratch directory added afterwards was outside
  the directories the CLI allowed writes to, so the worker was denied and
  its otherwise complete result was failed (D10).
- A worker that timed out left a receipt with no session id, so the one
  case where a transcript was most needed had none to read (D5, D9).
- Budget exhaustion was reported as a malformed result, not as the pinned
  limit doing its job, so the operator raised the timeout twice before
  finding the real cause.
- A tool call the runtime refused failed the whole execution even when the
  worker recovered and returned a valid result, and an auditor was failed
  three times in a row for probes it had no way to know were refused.
- Process containment through Windows job objects drained 138 descendants
  in one run and then classified the run as unrecoverable because eight
  MSBuild nodes had outlived the worker (D7). The same containment refused
  to run on macOS at all, and its implementation was a PowerShell and C#
  asset the skeleton proposal has since ruled out of the toolchain.
- The "runtime-neutral" contract carried Claude's tool names, and the Codex
  adapter validated those names, so the Codex path was Claude-shaped and
  every runtime-specific branch lived in the worker rather than in an
  adapter. Codex had no budget cap and no denial evidence, and nothing
  said so.

This is the third element of the plan: the last piece of infrastructure
before role prompts and the first end-to-end review. What it records is
what every later phase will read to know what a worker was given, what it
returned and what it cost.

## Goals

- The engine runs a worker through one function, on any registered
  runtime, and gets back one receipt whose shape does not depend on the
  runtime.
- What a worker may do is stated in runtime-neutral terms; a capability
  the runtime lacks is refused by name before anything runs, never
  approximated.
- A worker that never answers still names a transcript: it is on the
  ledger before its process exists, with its session id when the runtime
  lets the engine choose one.
- Every byte the engine sent and received is evidence, verified on read
  and referenced from the ledger.
- A worker cannot write into the reviewed tree by accident: it has a
  scratch directory outside it that the runtime allows writes to and that
  the shell's temporary-directory variables point at.
- Budget stop, timeout, denial and undecodable output are distinct
  outcomes, so a later element can decide what each means.
- The element runs and is tested the same way on Windows, macOS and Linux.
- A third runtime is added by writing one adapter and registering it.

## Non-Goals

- No role prompts, no tool sets per role, no model tiers and no default
  budgets or timeouts. Those are role policy, the next element; here every
  value is an explicit input.
- No decision about what a denial, a budget stop or a stray file means for
  a run. The receipt reports; the phase controller decides. The adapter
  provides the means to continue a session so a controller can hand a
  denial back as a correction, and does not decide when to.
- No supervisor process, no polling and no concurrency limit. How a skill
  invocation keeps workers alive across its own exit is a control-surface
  question for the first end-to-end element (PD4).
- No proof that every descendant of a worker has exited (PD2).
- No suspend detection. A machine that sleeps during a worker will time it
  out on resume; the receipt records wall-clock start and end so the case
  can be recognised later.
- No transcript viewer. The session id is recorded; reading the runtime's
  own transcript files is left to tooling outside the engine.

## Requirements

- R1: One function runs a worker on any registered runtime, given an
  invocation that names the runtime, the executable, the model, the effort,
  the access level (read-only or edit), whether a shell is available, the
  prompt, the output schema, the timeout and optionally a budget, a scratch
  directory, a label and a session to continue. It returns one receipt
  whose shape is the same for every runtime.
- R2: An invocation that needs something the runtime cannot do (assign a
  session id before launch, cap the budget, withhold the shell, use an
  effort level, resume a session) is refused before preflight and before
  any write, with an error that names the capability.
- R3: The worker is recorded on the ledger before its process is spawned,
  with the executable, the observed runtime version, the model, the effort,
  the access level, the session id when the runtime accepts one, and the
  prompt and schema as evidence. A spawn failure is still recorded as a
  finished worker.
- R4: The runtime is qualified by the presence of the flags the adapter
  uses, checked without invoking a model; the observed version is recorded
  and no version list exists.
- R5: The receipt distinguishes four outcomes: completed (structured output
  validated against the schema), budget (the runtime stopped at the pinned
  budget), timeout (the launcher killed the worker and its process tree,
  or its root alone when the tree could not be reached, which it says)
  and failed (anything else, with the reason). Denied tool calls are listed
  separately, as an array when the runtime reports them and as `unknown`
  when it cannot, and never change the outcome. Session ids, usage and
  wall-clock start and end are on every receipt.
- R6: The prompt, the compiled schema, stdout, stderr and the final output
  are stored as evidence and referenced from the worker's ledger events,
  so a receipt can be re-read from its bytes by a later engine.
- R7: A worker has a scratch directory outside the reviewed tree, named in
  its prompt, set as the shell's temporary directory, and allowed by the
  runtime for writes; where the runtime's read-only mode cannot allow it,
  the worker gets no scratch directory and its prompt says so.
- R8: A worker's environment is the caller's, with the runtime's own
  configuration sources (user settings, project instructions, MCP servers,
  plugins, hooks, auto memory) switched off, build servers told not to
  outlive the worker, and an inherited variable that would override the
  pinned effort refused by name. The one exception is what the engine's
  caller hands an adapter explicitly when it builds it, for credentials
  and providers that would otherwise live only in the switched-off
  configuration: a Codex model provider, and Claude Code's credential
  helpers and the variables of its settings `env` block. Each is an
  allowlisted option, never read from the user's own configuration, and
  none may set the pinned effort, auto memory or anything else the
  engine pins.
- R9: A session can be continued: a follow-up message to a recorded
  session is a new worker on the ledger that names the session it resumes,
  with the same runtime, model, effort, permissions, schema and scratch
  directory, and a budget and timeout of its own.
- R10: A third runtime is one adapter module and one registration;
  nothing outside its module branches on its name.
- R11: A ledger written before this element folds under the engine after
  it, with no workers; older golden fixtures still open.
- R12: The suite runs every adapter path on Windows, macOS and Linux
  without a real runtime, and a separate smoke script runs one prompt and
  one continuation through each installed CLI. The element is accepted
  when the smoke run completes for both runtimes on this machine and the
  Technical Design's Verification records the versions and outcomes
  observed.

## Product Decisions

- **PD1: A correction continues the session it corrects.** (D5 of the
  reviewed draft.) Both runtimes resume a session by id, so a worker that
  was refused a tool can be told so and asked to complete the same task
  without it, keeping everything it has read. Re-running from scratch with
  the earlier response pasted into the prompt, as the proof of concept did,
  was rejected as the default: it pays for the same reading twice and
  hands the model its own output as untrusted text. A continuation is a
  new worker on the ledger so its cost and receipt are recorded separately.
  Whether the resumed session's structured output stays within the schema
  is unverified until the smoke run (Open Questions in the design); if it
  does not, the fresh-worker path is the fallback and this decision is
  amended. Whether and how often a controller corrects is that
  controller's decision.

- **PD2: No job objects. A worker is a child process, its tree is killed
  on timeout, and build servers are pinned off.** (D8.) The proof of
  concept's Windows job object drained every descendant and proved it, and
  that proof produced an unrecoverable failure class when MSBuild nodes
  outlived a worker by design. It also needed a PowerShell and C# asset,
  which the skeleton proposal ruled out, and it refused to run on macOS.
  The environment pins remove the known survivors, a timeout kill removes
  the tree, and a descendant that survives a natural exit is not this
  element's problem until a real run shows it is (plan principle 8). What
  is given up is the proof that nothing survived.

- **PD3: Read-only roles keep the shell.** (D11.) Removing it after pilot
  D3 was proposed and is rejected: a finder without a shell cannot run the
  tests, read git history or grep beyond its file tools, and Claude Code
  has no read-only sandbox that would make the shell safe by construction.
  The tree is protected by the scratch directory of R7 and by the per-file
  drift comparison the scope element provides, which lets a later element
  treat a stray file as noise instead of the end of a run.

- **PD4: This element ends at an awaited function.** (D16.) A detached
  supervisor process, as the proof of concept had, exists to let the
  invoking skill return while workers run; whether that is needed depends
  on how the skill drives the engine, which is decided in the first
  end-to-end element. Deciding it here would be deciding without the case.

- **PD5: Fakes in the suite, real runtimes in a separate smoke script.**
  (D17.) Real-runtime tests that skip when the CLI is absent were
  rejected: they would always skip in CI, where there is no
  authentication, and a test that always skips looks like coverage. The
  fakes exercise every decode path on three platforms; the smoke script is
  the real-run gate the plan requires and its result is written into the
  design's Verification.

## Risks

- A worker's descendants can survive a natural exit unnoticed (PD2).
  Accepted; the pins cover the case every pilot hit, and the receipt still
  records the worker's own exit.
- A resumed session may not honour the output schema (PD1). Accepted as an
  open question with a named fallback; the smoke run settles it before the
  element is complete.
- A machine that sleeps during a worker produces a timeout on resume.
  Accepted for now; start and end times are on the receipt so the gap is
  visible when suspend handling is designed.
