### Angle CONVENTIONS — CLAUDE.md rules
Find the CLAUDE.md files that govern the changed code (the scope block
lists them — verify the list yourself): the user-level
`~/.claude/CLAUDE.md`, the repo-root `CLAUDE.md`, and any `CLAUDE.md` or
`CLAUDE.local.md` in a directory that is an ancestor of a changed file (a
directory's CLAUDE.md applies only to files at or below it). Read each that
exists, then check the diff for clear violations of the rules they state.
This angle is **precision-first, not recall-biased**: flag a violation ONLY
when you can quote the exact rule and the exact line that breaks it — no
style preferences, no "spirit of the doc" inferences. If no CLAUDE.md
applies, return nothing for this angle.

**Required `failure_scenario`**: name the CLAUDE.md path, quote the rule,
then quote the line that breaks it ("`~/.claude/CLAUDE.md`: 'Quote every
glob the program should receive as-is' — line 88 passes `--include=*.ts`
unquoted").
