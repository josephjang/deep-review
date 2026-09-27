### Angle CONVENTIONS — rules files (CLAUDE.md, CLAUDE.local.md, AGENTS.md)
Find the rules files that govern the changed code (the scope block
lists them — verify the list yourself): the user-level
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, the repo-root
`CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, and any `CLAUDE.md`,
`CLAUDE.local.md` or `AGENTS.md` in a directory that is an ancestor of a
changed file (a directory's rules file applies only to files at or below
it). Read each that exists, following any file one of them imports, then
check the diff for clear violations of the rules they state. This angle
is **precision-first, not recall-biased**: flag a violation ONLY when you
can quote the exact rule and the exact line that breaks it — no style
preferences, no "spirit of the doc" inferences. If no rules file applies,
return nothing for this angle.

**Required `failure_scenario`**: name the rules file's path, quote the
rule, then quote the line that breaks it ("`~/.claude/CLAUDE.md`: 'Quote
every glob the program should receive as-is' — line 88 passes
`--include=*.ts` unquoted").
