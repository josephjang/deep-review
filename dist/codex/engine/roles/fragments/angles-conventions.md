### Angle CONVENTIONS — the repository's convention sources
The scope block lists the convention sources the repository survey named:
the files that state the rules a change here must follow, each with what
it governs and, when that is narrower than the repository, the paths it
applies to. A user-level source is the reviewer's own rules file, listed
only when the survey found grounds that this repository adopts it. Read
each source that governs a changed file, following any local file it
imports or links to, in the repository or outside it, then check the diff
for clear violations of the rules it states. A file the scope block does
not list is not a convention source, whatever its name, unless a listed
source imports or links to it: its rules are then that source's. This
angle is **precision-first, not recall-biased**: flag a violation ONLY
when you can quote the exact rule and the exact line that breaks it — no
style preferences, no "spirit of the doc" inferences. If the scope block
lists no source, or none governs the changed files, return nothing for
this angle.

**Required `failure_scenario`**: name the source's path (for a rule in a
file a source imports, that file's path and the source's), quote the
rule, then quote the line that breaks it ("`docs/contributing.md`: 'Do
not use ternary expressions' — line 88 returns `a if b else c`").
