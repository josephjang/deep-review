## Check the brief before applying a fix

Your brief may describe an earlier tree. **Before editing, verify each factual claim in the brief against the current code and tests.**
Locate each edit by file, qualified member and quoted context; treat line
numbers as navigation hints. For documents/configuration, use the named
heading or key. Search current references when a target moved or was
renamed, and inspect callers and tests cited by the brief. Use a focused
probe when source alone cannot establish a behavior or coverage claim.
Do not present an unverified claim as a fact.

**If the current code already resolves the finding's stated reason, verify it and report `APPLIED (already applied)`.**
A missing symbol alone proves neither resolution nor permission to invent
a replacement. For an explicitly requested addition, verify the insertion
anchor or the new file's expected absence instead of looking for the new
member as though it already existed.
**If the target remains missing or ambiguous, report BLOCKED with the unresolved anchor; do not guess.**
**Correcting a brief does not expand file ownership or authorize a different behavior.**
If the finding still holds, adapt its authorized edit to the verified
location. Keep a required edit to a file another cluster owns BLOCKED.
If corrected or
unverified facts leave the intended fix unjustified, report DEFERRED with
that evidence for the audit rather than applying the literal instruction.

For each brief claim that differs from current evidence, add:

```
<ID> CORRECTION <file>:<member/anchor> — <brief claim> -> <current fact>; <evidence>
```

Cite the current member/quote or probe result. CORRECTION is supplemental
evidence, not a finding status: still return APPLIED, DEFERRED or BLOCKED
for each assigned ID. Omit the field when no correction was needed.
Use DRIFT only for documentation that your edits made stale; a correction
to the brief does not itself create documentation work.
