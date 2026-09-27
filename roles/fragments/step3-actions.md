**Then act on the verdicts (none optional):**

1. **FIX-NOW** — apply every one, with its validation plan, to the same standard as Step 1
   and by the same means: cluster them by file under the Step 1 rules and
   save their plan as described below before dispatching fixer workers
   in parallel, rather than editing here. The audit already
   produced the anchored edit and validation plan for each,
   so pass those through with relevant recorded CORRECTION lines;
   the fixer validates by the specified method and reports observed evidence,
   then re-reads each fix for adjacent regressions.
2. **REFUTE** — drop it from the skip list; keep the one-line proof for the
   report.
3. **NEEDS-STEERING** — put it to the author (offer the concrete options;
   recommend one with a reason), then dispatch the chosen path with its test to
   a fixer the same way. If you can ask the author directly, do. If you
   cannot — you are a worker, and no question reaches the author from one — finish
   independent code work first, then RETURN the open questions to the engine
   with their options and your recommendation; it will ask and continue you with the
   answers. Only a genuinely non-interactive run leaves these as residual skips,
   and then the question and options are stated in the report.

**Hold `DOCS-STEP3` while interactive steering questions are unanswered.**
Checkpoint its queue before returning questions; this is an exception to
finishing other work before the handoff. After the last FIX-NOW and
chosen steering code cluster returns, reconcile documentation under the
Step 1 phase rules, including queued doc-only FIX-NOW findings and every
DRIFT line from both kinds of fixer. In a non-interactive run, reconcile
the changes actually applied and leave unchosen proposals as questions.
Never treat an unresolved documentation item as silently complete.
FIX-NOW wave plans below cover code clusters; queue doc-only FIX-NOW
items for `DOCS-STEP3` with their saved auditor edit and test references.
Route chosen doc-only steering work there too, with the saved answers.

**Save the FIX-NOW plan before dispatching any fixer in that wave.**
Apply the Step 1 ownership check even when an earlier plan is already
saved: FIX-NOW and chosen steering work must not overlap another wave's
active owner. Keep conflicting assignments queued under their saved IDs.
Append the plan to `audit.md`, preserving the auditor plan, verdicts, and all
earlier fixer plans and returns. Give each new wave a unique ID such as
`FIX-NOW-1` and each cluster a distinct unit ID such as
`FIX-NOW-1-cluster-1`; never reuse an auditor's ID. The plan records each
cluster's execution ID, finding IDs, exact files owned, test command (or
the recorded no-runner limitation), and references to the saved auditor sections
containing its exact edits and validation plans. End the plan section with
`<!-- END FIX-NOW-1-plan -->`, using its actual wave ID.

Confirm the plan write succeeded before dispatching any fixer for
that wave. Do not batch the write with its dispatch: parallel calls can
start a fixer before its plan is durable. If the plan cannot be saved,
do not dispatch that wave. With no FIX-NOW code clusters, record a terminated
empty plan and dispatch nothing. On resume, follow Phase R's existing
plan instead of assigning new clusters to the same work.

Use the same plan-before-dispatch and verbatim-return protocol for
chosen steering code clusters, with distinct `STEERING-1` wave IDs and
references to the saved answers as well as their exact edits and validation plans.

Append each FIX-NOW fixer's final report verbatim as it returns under
its planned unit ID and matching execution ID, including every `APPLIED (already applied)`,
DEFERRED, BLOCKED, CORRECTION, VALIDATION, and DRIFT line. Terminate each complete return with its own
`<!-- END FIX-NOW-1-cluster-1 -->` marker. A saved plan without a
terminated return means that cluster may have partially edited its
owned files; it is not evidence that the cluster never started.

Write the NEEDS-STEERING questions to `steering.md` before returning
them, and append the answers when they arrive — an interrupted handoff
resumes from that file.

A finding may remain skipped after this pass ONLY if it is NEEDS-STEERING and
unanswered. Everything else is now fixed or refuted-with-proof. Run the relevant
test suites + lint/typecheck once more, redirecting output to a log and reading
back only the failing lines, so the report's "all green" claim covers the
re-verified fixes too.

Review the returned validation evidence under Step 2's method checks;
missing or unsupported evidence needs repair, not an invented red run.

If verification needs code repairs, reopen `DOCS-STEP3` before dispatch,
then reconcile after those returns and run the affected checks again.
Once those checks pass, all planned FIX-NOW and chosen steering returns
are checkpointed, and the latest documentation revision is complete,
append the verification outcome and terminate `audit.md` with
`<!-- END -->`. Until then, its completed sections remain recoverable
without marking the whole Step 3 artifact complete.
