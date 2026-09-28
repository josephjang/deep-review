## Phase 2 — Verify (1-vote)

**Paths are canonical.** Finders return the same file as absolute,
repo-relative, or backslash-separated paths. The engine normalizes every
candidate's `file` to the repo-relative spelling by suffix-matching
against the changed-file list in the scope block (longest match wins),
so that dedup, grouping, and the report all agree on one spelling. A
path that names an unchanged file of the repository is never matched to
a changed path it merely ends with. A candidate whose file matches no
changed path, or whose line lies outside that file, is kept and marked
`unlocated`: it keeps the finder's own spelling, is grouped with the
other spellings of that path the engine can recognize, is still
deduplicated and verified, and the report shows the mark.

Then a deduplication worker groups near-duplicates (same defect, same
location, same reason → keep one). Tiebreak by picking the candidate
with the most concrete `failure_scenario` (correctness, cost &
conventions angles) or the strongest `value_statement` (design &
cleanup angles). The other members of a group leave the working list; a
candidate in no group stands alone.

**The survivors are grouped by file** — every candidate in one file →
one group — and the engine runs **one verifier per group** as a worker,
all groups in parallel. A verifier's cost is dominated by reading the
file and its context, not by the number of verdicts it returns, so one
group per flagged line would pay that reading once per candidate for no
gain in independence. A group holding more than 8 candidates is split
into as many groups of neighbouring candidates as that takes, so no
single context carries a whole file's backlog. Each verifier receives
the scope block, the relevant file(s), and every candidate in its group
numbered `[0]`, `[1]`, ….

**The rubrics are not pasted into a verifier prompt.** They are in the
verifier's role prompt, so every verifier receives them. They appear
here because you need them too: which verdict a finding carries decides
what the report says about it and what a later pass may do with it. A
verifier judges EACH candidate independently on its own claim
(candidates in one group may describe distinct issues, the same issue
seen from different angles, or a mix) and returns, per candidate,
exactly one of CONFIRMED / PLAUSIBLE / REFUTED — using the rubric that
matches that candidate's angle — plus one line of `evidence` quoting or
citing the line(s) that justify the verdict. Grouping is not dedup:
every candidate keeps its own verdict.

**Verifier-failure policy.** A verifier's answer is recorded only when
it gives exactly one verdict for every candidate in its group; an answer
that misses one is discarded whole, like a verifier worker that dies.
Either way the engine re-runs that group once with a fresh worker. If it
fails again, every candidate in the group is kept as PLAUSIBLE — tagged
"unverified" — and flows onward like any PLAUSIBLE finding, with the tag
carried into the report. At this effort level a silently dropped
candidate is a silently missed bug: never fabricate a verdict, and never
drop a candidate because its verifier failed.

Each complete answer's verdicts and evidence lines are recorded,
REFUTED included. CONFIRMED and PLAUSIBLE (including
PLAUSIBLE-unverified) stay on the working list. Each REFUTED candidate
is recorded with its ID, location, summary, and the verifier's one-line
evidence for the report's "Refuted at verification" appendix, and
leaves the working list. A single non-REFUTED vote carries the finding
into Phase 4.
