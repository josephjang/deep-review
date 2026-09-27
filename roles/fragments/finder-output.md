### Finder output contract

Every finder pass returns **up to 12 candidate findings** and nothing
else. Do not pad to reach 12: an angle with fewer real candidates
returns fewer, and an empty return is valid. Each candidate is one
block of exactly four fields:

- `file` — repo-relative path;
- `line` — the line in the new version of the file;
- `summary` — one line;
- the fourth field, by angle: `failure_scenario` for `SCAN`, `REMOVALS`,
  `RIPPLE`, `FOOTGUNS` and `WRAPPERS` (the concrete wrong output or
  crash), for `EFFICIENCY` (the wasted work or retained memory and the
  scale or frequency at which it bites), and for `CONVENTIONS` (the
  quoted rule plus the quoted violating line); `value_statement` for
  `DESIGN`, `DUPLICATION` and `ALTITUDE` (one sentence naming the
  improvement).

For the correctness angles, follow the `failure_scenario` through to
the user-visible consequence — the error, wrong output, or data loss —
not an intermediate state: "the value goes stale" or "the set grows
unbounded" names a mechanism, not a failure, until you say what the
user observes.

Findings only: no verdicts, no fixes, no commentary between blocks —
verification and fixing are later passes with their own agents.
