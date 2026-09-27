## Post-review — Fix, test, then report

Once Phase 4's list is set, do these in order. None of them is optional.

### Step 1: Fix every non-refuted finding, as a fan-out

Every legitimate finding gets fixed or put to the author. "Legitimate"
means CONFIRMED or PLAUSIBLE after Phase 2, and the verdict decides the
route. A PLAUSIBLE **design & cleanup** finding is, by its rubric,
already adjudicated: a real improvement whose application is a judgment
the author owns. Do not dispatch it to a fixer — the fixer could only
defer it back (a paid round-trip) or apply a should-ask restructuring
unilaterally (worse). Hold every such finding for Step 3, whose audit
takes them directly, alongside whatever the fixers defer. Everything
else — CONFIRMED from any angle, PLAUSIBLE from the correctness, cost &
conventions angles, and any PLAUSIBLE tagged "unverified" from those
angles — is fixed now. You do not apply the fixes yourself: you cluster
them, dispatch one fixer per cluster, and verify the
result. If nothing routes to a fixer, code dispatch and Step 2 are no-ops;
still check the documentation queue below. With no documentation work
either, verification is also a no-op; save the explicit Verify and Step 2
no-op records below before Step 3 runs.

The fixer's standard for applying a fix, its defer criteria, and its test
requirements live in its role prompt, so they reach it whether or not
you restate them. Do not re-derive or paste them.

**Preserve CORRECTION lines verbatim with their finding and execution.**
Pass relevant corrections into later audit and fixer briefs alongside
the original evidence; do not rewrite the original checkpoint to erase
what changed. Corrections are evidence, not additional findings or a
documentation queue. Only actual DRIFT enters documentation reconciliation.

**Why this is delegated.** Applying fixes inline is what makes a review
expensive. Each edit, each file re-read, and each build transcript lands
in your context and is then re-read on every remaining turn of the run,
so the same tokens are paid dozens of times over. In a fixer's context
they are paid once and discarded. The review is unchanged; only where the
work is done changes.

**Discover the test command first, once.** Check `package.json`'s
`scripts.test`, `Taskfile.yml`, `Makefile`, `justfile`, `build.gradle` /
`pom.xml`, `pyproject.toml` / `uv` config, or similar. If no project-level
test target exists, fall back to the language's test runner invoked
directly on the relevant test files (`pytest path/to/test_file.py`,
`go test ./path/...`, `cargo test --test foo`). If a free-form review
instruction named a test command or excluded a category of tests, that
wins. If neither path works, note "no test runner available" in the final
report, pass that fact to the fixers, and stop trying — don't fabricate a
command.

**Cluster the fixer-routed findings.** One cluster per file, with two
rules that override that default:

- A finding merged across sites in Phase 4 is ONE fix. Keep all its sites
  in one cluster, and that cluster owns every file they touch.
- **No file may appear in two concurrent clusters, and no follow-on may
  own a file an in-flight cluster owns.** Two workers editing one file
  will clobber each other. If the rule above pulls a file into a cluster,
  every finding in that file joins it.

**Before every fixer dispatch, check ownership across all active waves.**
This includes initial fixes, later additions, verification/test repairs,
FIX-NOW, chosen steering, documentation, and resumed replacements. Compare
each candidate's entire file set against other reserved or running
executions, not only the new batch. Resolve path aliases when comparing
ownership, including case on case-insensitive filesystems. Within the
eligible batch, merge overlapping assignments before reserving files.
**Queue the entire overlapping assignment; do not split a merged finding.**
Persist its finding IDs, all required files, test command, and blocking
owner IDs as a terminated queue section in the phase checkpoint. Queued
work owns no files and is waiting for scheduling, not DEFERRED or skipped.
Once the owners finish, re-check the queue against all active work and
dispatch eligible assignments under the existing phase gates. Independent
code assignments can proceed; documentation still waits for all code.

Use the phase's saved plans and returns as the ownership record. Keep a
stable logical cluster ID and assign a unique execution ID to every
dispatch, including repairs and replacements; record it on the plan and
return section, plus the runtime worker/task handle when available. Reserve
the whole eligible batch in a successfully saved plan before any call.
**Only a final return or confirmed termination releases the current execution's files.**
Checkpoint that evidence before transferring ownership. Record a failed
execution's terminal evidence separately from fixer returns, with an
end marker such as `<!-- END <execution-id>-stopped -->`: it releases
ownership but does not complete the assigned findings. A confirmed
dispatch failure that started no worker is also terminal evidence.
**An older return never releases a newer execution of the same cluster.**
Elapsed time, silence, a missing checkpoint, or a new plan releases nothing.

**Do not spawn a new fixer to stop or redirect an existing fixer.**
That starts a separate worker; it does not change the earlier assignment.
If overlapping writers were already dispatched, checkpoint the collision,
wait for all of them to stop, and inspect their combined diff and returns.
Assign any required repair to one exclusive owner and verify it under
the phase's repair rules; documentation uses its existing phase owner.
Drain queued code assignments before documentation reconciliation;
queued documentation joins its existing phase owner. Account for every
authorized waiting assignment before verification or phase completion;
a queued assignment cannot silently become an empty phase.

Findings in files the diff never modified are clustered and fixed like any
other. `RIPPLE` and `DUPLICATION` legitimately produce them, and the bar
is "this finding survived verification", not "this line was in the diff".

**Use one documentation reconciliation cluster per fix phase: `DOCS-STEP1` and `DOCS-STEP3`.**
Queue doc-only fixer-routed findings before forming code clusters,
preserving their IDs and evidence; held design findings still wait for
Step 3's verdict. Save the queue as a terminated unit in the phase
checkpoint before code dispatch, using a unique unit ID for each update.
Keep mixed code-and-document findings together under the ownership rules
above, and leave inline source comments with their code owner. Collect
every returned DRIFT line in the phase checkpoint (`fixes.md` for Step 1,
`audit.md` for Step 3), including drift from test repairs and chosen
steering work. Give new drift items stable IDs such as `DOC-STEP1-1` so
each gets an explicit disposition; these are maintenance work items, not
additional ranked findings. Do not spawn a fixer for each drift note.

**Never dispatch documentation reconciliation while code clusters are in flight, including verification repairs and chosen steering work.**
After the last Step 1 code cluster returns, and again after the last
FIX-NOW and chosen steering cluster returns, dispatch the phase's single
documentation cluster before its aggregate verification. It owns every
document the change touches: assemble exact paths from the review diff,
fixer FILES and DRIFT lines, queued findings, and a repository search for
renamed members. Transfer any document ownership from finished code
clusters only after they return. An empty phase, or a search finding no
affected documents or queued work, needs only a terminated no-op revision
with its reason and no dispatch. Earlier reconciliation stays valid
when this phase applied no changes and has no queued work.

Save the documentation plan before dispatch and confirm the write succeeded.
Use revision IDs such as `DOCS-STEP1-r1` within the same logical cluster,
and record the current execution ID in its plan and return section.
The plan carries the scope, exact document ownership, queued IDs/evidence,
every DRIFT line verbatim, references to all code fixer returns in that phase,
renamed members, and the test command or no-runner limitation. This brief
must cover all applied changes, including those whose fixers omitted DRIFT.
End the plan with `<!-- END DOCS-STEP1-r1-plan -->` using its actual ID;
dispatch one fixer in documentation reconciliation mode.
Append its complete return verbatim with `<!-- END DOCS-STEP1-r1 -->`.
Check that every queued item has a disposition. If its search finds
another required document outside ownership, extend this same cluster's
plan in a new revision and retry the unresolved work after all owners
return; never create a competing doc fixer. Unresolved Step 1 items flow
to the Step 3 audit with their IDs and evidence; Step 3 items must be
resolved or put to the author under its existing rules. A Step 1 item
explicitly handed to the audit is accounted for in this revision; it
remains open work in Step 3. Include reconciliation in the final report
alongside the changes that caused it; do not inflate ranked-finding
counts with DOC maintenance IDs, and retain any unanswered doc decision.

**A later code repair or new DRIFT reopens the same logical documentation cluster**
with the next revision, even after a no-op. Record the pending revision
and reason in the phase checkpoint, ending with a marker such as
`<!-- END DOCS-STEP1-r2-pending -->`, before
dispatching a repair, or as soon as new drift arrives. After code settles,
save its updated plan and reconcile again; earlier doc returns cannot
close the reopened phase. Preserve earlier plans and returns, verify
already-correct documents without rewriting them, and rerun affected
checks. Neither `fixes.md` nor `audit.md` is complete with pending
documentation; Step 1 also requires its verification and Step 2 work.

**Dispatch every eligible code cluster in parallel**, each as a fixer
worker. Each prompt carries the
Phase 0 scope block, the cluster's findings — ID, `file:line`, summary,
angle, and the verifier's evidence line — the exact list of files that
cluster owns, and the test command. Order the findings within a cluster
most-severe first, so the Phase 4 ranking still governs the order fixes
land in a file. **Save the Step 1 plan before dispatch and confirm the write succeeded.**
Append the code cluster plan — each cluster and execution ID, its finding
IDs, files owned, and test command — to `fixes.md`, preserving its queues
and earlier returns. Give the plan its own end marker. Do not batch its
write with dispatch or dispatch after a failed write. Apply the ownership
check to the eligible batch, then dispatch it in parallel and
append each fixer's report verbatim under the matching execution as it
returns.

After all code returns, finish `DOCS-STEP1` (or its no-op) before verification.

**Then verify the settled wave.** Do not re-read every file a fixer touched; that
rebuilds the context this step exists to avoid. Instead:

1. Read `git diff --stat` for the shape, then the diff itself for the
   files the fixers reported changing.
2. Run the test command and the project's lint/typecheck a single time
   over everything. Redirect output to a log and read back only the
   failing lines — a green build transcript is pure cost.
3. **Save `## Verify (wave N)` in `fixes.md` with every command and its observed exit code.**
   Use an increasing N for each aggregate verification attempt. Identify
   the covered cluster return sections and latest DOCS-STEP1 revision,
   record the diff inspection outcome and overall status defined below,
   name the owning cluster for any failure, and include each test, lint and
   typecheck command with its working directory, exit code, and concise
   failure evidence. Capture the command's own exit code, not a log
   reader's or pipeline's. A fixer's SUITE line is not the aggregate run.
   End the record with `<!-- END STEP1-verify-N -->` using the actual N,
   and confirm the write succeeded before continuing or dispatching repairs.
4. If anything failed, dispatch the recorded owning fixer rather than
   fixing it here. Reopen documentation
   before code repairs, wait for those returns, then reconcile and verify
   again under a new N. Preserve earlier failure records.

**Record no-op and unavailable-check reasons explicitly; never invent a successful exit code.**
For a command not run, record NOT RUN and why: a discovered missing
runner/target, a caller's test exclusion, or an entirely empty fix phase.
Run every available required check. Record overall PASS only when all
required checks ran successfully, LIMITED when an explicit limitation
prevents a check, and NO-OP for an empty fix phase. Carry limitations to
the final report; they do not support an "all green" claim. An actual
failed command is FAIL, not an unavailable check.
**A missing result, a torn record, or an actual command failure cannot satisfy verification.**

**Any later Step 1 repair or documentation revision invalidates the earlier Verify and Step 2 records.**
Record the repair plan or pending documentation revision before dispatch;
after it settles, verify the new state. Completed returns alone do not
prove this gate was passed.

Carry every fixer's per-finding APPLIED / DEFERRED / BLOCKED line forward.
DEFERRED and BLOCKED findings both flow into Step 3, joined by the
PLAUSIBLE design & cleanup findings held out of the dispatch above, and
Step 3 re-opens every one of them against the actual code with a
stricter, fix-biased bar. A defer here is provisional, never a settled
skip.

### Step 2: Confirm the test work

The fixers add happy-path and edge-case tests for what they changed, and
tighten or fix tautological tests they find. Your job is to check that it
happened and that it is real, not to write the tests yourself.

From the fixer reports and the diff, confirm for each cluster that
changed behavior:

- new behavior has a happy-path test;
- the boundaries the change exposes are covered — empty, zero, negative,
  very large, concurrent, missing optional field, error path;
- no added test is tautological: an assertion that always holds, a mock
  returning the value being asserted, or a test that only exercises the
  happy frame of a changed branch.

**Check each reported validation method and result; a compile failure cannot substantiate a behavioral red run.**
For a mutation, require the named semantic reversal, its intended assertion
failure, and passing fixed/restored controls. Assess static evidence only
for its named source invariant. Existing passing tests can cover a
behavior-preserving refactor. Record unsupported claims or incomplete
restoration as GAPs, and carry concrete test limitations into the review
and final report. Preserve VALIDATION lines with the verbatim fixer return.

Where a cluster changed behavior and its report shows no test, save the
specific GAP in the Step 2 record below before re-dispatching that fixer.
Where a test is genuinely impractical (no harness, no fixtures,
config-only change), say
so explicitly in the final report instead of letting it disappear.
**Save `## Step 2 (wave N)` with a per-cluster test review.**
Use the N of the latest Verify attempt, which must be satisfied, and
reference it; never fall back to an older pass after a newer failure. For
each cluster that changed behavior, name the actual test file/member,
the happy-path and boundary coverage, and your verdict from the report
AND diff: PASS, GAP with the required repair, or IMPRACTICAL with the
concrete harness/fixture limitation. A test name without that assessment
is not confirmation. List clusters with no behavior change explicitly;
an empty phase records NO-OP and its reason. Preserve any re-dispatch
results. End the section with `<!-- END STEP1-tests-N -->` and confirm
the write succeeded before continuing.

A repair here also reopens `DOCS-STEP1` and invalidates the current
verification/test review; finish the repair and documentation, then
save a new Verify and Step 2 pair. Never mark a GAP complete simply
because its repair was dispatched.

**The Step 1 verification gate** is satisfied only when all planned code
returns and the latest documentation revision are accounted for, the
latest Verify attempt covers that work and is terminated and PASS,
LIMITED or NO-OP, and its terminated Step 2 record covers every cluster
with no unresolved GAP. Retain justified test limitations in the report.
Only then terminate
`fixes.md` with `<!-- END -->` and proceed to Step 3. If the records are
complete but the file marker is missing, write the marker without
repeating completed work.
