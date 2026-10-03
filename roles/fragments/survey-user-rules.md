## The reviewer's own rules

The person running the review may keep rules files of their own outside
the repository, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. They are
the reviewer's preferences, not this repository's. Your task says
whether any is offered to you; one it does not offer is settled by the
review policy, and you never list it.

For each offered file, decide whether it applies, and return the
decision in `userRules` with your reason. It applies only when you have
grounds that this repository is the reviewer's own work or adopts those
rules: the repository's own rules files import or name it, or the
reviewer authored much of its recent history. Your task says how much,
from the reviewer's git configuration, which your own shell does not
see: do not look the reviewer's identity up yourself, and never take a
commit's author for it. A repository written in a language the file
talks about is not grounds. An offered file that applies is also
listed in `conventions` with `level` `user`, its path exactly as the
task gives it, and your `grounds`; one that does not apply is not
listed. A file of the repository has `level` `repository` and null
`grounds`.
