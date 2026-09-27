## Phase 2 — Verify (1-vote)

**Canonicalize paths first.** Finders return the same file as absolute,
repo-relative, or backslash-separated paths. Normalize every candidate's
`file` to the repo-relative spelling by suffix-matching against the
changed-file list in the scope block (longest match wins), so that
dedup, grouping, and the report all agree on one spelling.

Then dedup near-duplicates (same defect, same location, same reason →
keep one). Tiebreak by picking the candidate with the most concrete
`failure_scenario` (correctness, cost & conventions angles) or the
strongest `value_statement` (design & cleanup angles).

**Group the survivors by file** — every candidate in one file → one
group — and run **one verifier per group** as an `Agent` call
(`subagent_type: "deep-review-lead"`), all groups in a single message
block. A verifier's cost is dominated by reading the file and its
context, not by the number of verdicts it returns, so one group per
flagged line would pay that reading once per candidate for no gain in
independence. Split any group holding more than 8 candidates into as
many groups of neighbouring candidates as that takes, so no single
context carries a whole file's backlog. Give each verifier the scope
block, the relevant file(s), and every candidate in its group numbered
`[0]`, `[1]`, ….

**Do not paste the rubrics below into a verifier prompt.** They are in the
`deep-review-lead` definition, so the runtime delivers them to every
verifier whether or not you remember to. They appear here because you need
them too: which verdict a finding carries decides whether Step 1 fixes it
without asking or Step 3 puts the question to the author.
It judges EACH candidate independently on its own claim (candidates in
one group may describe distinct issues, the same issue seen from
different angles, or a mix) and
returns, per candidate, exactly one of CONFIRMED / PLAUSIBLE / REFUTED —
using the rubric that matches that candidate's angle — plus one line of
`evidence` quoting or citing the line(s) that justify the verdict.
Grouping is not dedup: every candidate keeps its own verdict.

**Verifier-failure policy.** If a verifier agent dies, or returns no
verdict for some candidate in its group, re-run that group once. If it
fails again, keep the affected candidates as PLAUSIBLE — tagged
"unverified" — and let them flow onward like any PLAUSIBLE finding, with
the tag carried into the report. At this effort level a silently dropped
candidate is a silently missed bug: never fabricate a verdict, and never
drop a candidate because its verifier failed.

As each verifier returns, append its group's section to `verdicts.md` —
every verdict and its evidence line verbatim, REFUTED included —
saved under the checkpoint discipline above without waiting for another
group. A group that died before returning has
no section, which is what lets a resumed run re-dispatch exactly the
groups that never landed.

Keep CONFIRMED and PLAUSIBLE (including PLAUSIBLE-unverified). For each
REFUTED candidate, record its ID, location, summary, and the verifier's
one-line evidence for the report's "Refuted at verification" appendix,
then drop it from the working list. A single non-REFUTED vote carries
the finding into Phase 4.
