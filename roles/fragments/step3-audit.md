### Step 3: Re-verify every skipped finding (adversarial defer audit)

**Do not dispatch Step 3 auditors until the Step 1 verification gate is satisfied.**
Check the latest paired Verify and Step 2 records in `fixes.md`, including
explicit no-ops or limitations. A file-level end marker or completed
fixer returns alone are insufficient; Phase R describes recovery.

Step 1's defer bar is deliberately conservative, so it over-defers: "no
automated test," "ambiguous," and "diff size" get stretched into excuses for
skips that are actually fixable. This step re-opens **every** finding Step 1
deferred or blocked — plus every PLAUSIBLE design & cleanup finding Phase 2
routed here directly, for which this audit is the first and only re-check —
and forces each back through a stricter, fix-biased gate. Treat each item's
rationale — a fixer's defer reason, or the verifier's PLAUSIBLE reasoning for
a rubric-routed refactor — as a CLAIM to disprove, not a settled fact. Bias
hard toward clean design, robustness, and code quality — when in doubt, fix.

**Run the audit as a fan-out, sized by the workload.** Group these
findings by subsystem, so an agent reads a file once for every finding it
covers, then split any group holding more than 5 findings into as many clusters
as that takes. Spawn one `Agent` per cluster (`subagent_type:
"deep-review-auditor"`, all in a single message block).

The cap is the point. Without one this step produced exactly two agents on three
consecutive runs whatever had been deferred, because "a few" is not tied to how
much there is to do. A cluster costs its turn count times its context and both
grow with the findings it carries, so a fixed number of clusters costs roughly
the SQUARE of the deferred count, while a cap keeps it linear. Measured: two
auditors carrying about 9.5 findings each ran 49 requests at 119K tokens per
request, and four carrying half that ran 30 requests at 83K.

Do not go below the cap chasing more of the same. Every extra cluster re-reads
whatever files it shares with its neighbours, and those four auditors together
read 48% more than the two did, which eats most of what the split saves. Never
merge unrelated subsystems to fill a cluster either: one agent carrying two
unrelated file sets pays for both on every turn. A finding merged across sites
in Phase 4 stays whole even where that pushes its cluster past 5.

Give each agent the Phase 0 scope block, its cluster's findings, and the
relevant files. **Do not paste the operating principle, the fork, or the verdict
definitions below**: they are in the `deep-review-auditor` definition, so the
runtime delivers them to every auditor whether or not you remember. Restating
them buys nothing and is charged to your context and to each prompt. Instruct
each to RE-VERIFY against the actual code (read it — do not trust the Step 1
rationale) and return, for EACH finding, exactly one verdict from the three
defined below.

Write the auditor cluster plan to `audit.md` in the same block as the
dispatch, and append each auditor's verdicts verbatim as they return.
