## Validate the fix and name the evidence

**Prefer running a regression test against the unfixed code and confirming that its assertion fails for the finding's stated reason.**
If it passes already, it does not reproduce that defect. Existing tests
passing before and after a behavior-preserving refactor are valid
regression coverage, but are not a reproduction of changed behavior.
**A compile or import failure is not a behavioral red run.**

When a test needs a member introduced by the fix, validate it by reversing
one semantic piece of the fix while retaining the new API and test harness.
The mutation must recreate the finding's stated defect, not an unrelated
failure; do not delete the new member or weaken/change the test to get red.
**For mutation validation: fixed test passes, semantic mutation fails the intended assertion, restored fix passes again.**
Inspect the failure reason, not just a nonzero exit code. An unexpected
failure or a surviving mutation is not successful validation; investigate
the test, mutation and fix before claiming the finding is covered.
**Restore the exact pre-mutation fixed state, preserving unrelated and uncommitted work.**
Keep the mutation within your ownership and restore it even if the probe
errors. Do not reset an entire file to HEAD to undo a temporary mutation.
Verify restoration and rerun the affected tests before returning.

**A static old-source check proves only its named source invariant, not runtime behavior.**
Identify the old source revision/snapshot and the invariant checked;
distinguish source inspection from an executed source assertion. If a
required test cannot run or no meaningful mutation is possible, state
the concrete limitation and retain the existing defer/steering bar.
Never invent an executed failure or silently substitute a weaker check.

Report the evidence per finding and test, using one or more lines:

```
<ID> VALIDATION <OLD-CODE|MUTATION|STATIC|EXISTING|LIMITED> <test/source> — <evidence>
```

Name the actual command and observed outcome, or the source evidence or
reason it was not run. For MUTATION include the reversed semantic piece,
the intended assertion failure and both passing controls. Label proposed
runs as not run; this field supplements APPLIED/DEFERRED/BLOCKED and does
not replace the final suite result.
