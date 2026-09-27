---
name: deep-review
description: Deep review of a change by the deep-review engine, a Node program installed with this skill. It runs the SCAN triage, nine more finder angles, deduplication, verification, a gap sweep and a merge-and-rank pass, and writes a Markdown report, editing nothing. Use only when the user asks for $deep-review by name.
---

The deep-review engine reviews the change; you run one command, wait for
it to exit, and relay its result. Node 26 or newer must be installed.

1. Decide the scope from what the user asked for:
   - the uncommitted changes in the worktree: `--worktree`
   - the last commit of a clean tree: `--last-commit`
   - everything since a ref: `--ref <ref>`
   - a range ending at HEAD: `--from <rev> --to HEAD`, adding
     `--merge-base` to measure from the merge base
   With no instruction, use `--worktree` when `git status` shows changes
   and `--last-commit` otherwise. Add `--path <path>` for each path the
   user limited the review to. `--budget-usd` does not apply to Codex,
   which reports no cost; do not pass it.
2. Run this from the repository, with the longest timeout you can, and
   wait for it to exit. `engine/main.mjs` is in this skill's directory,
   the one that holds this SKILL.md:

   node "<this skill's directory>/engine/main.mjs" review --runtime codex <scope flags>

   A review takes many minutes. Do not poll the ledger, read the
   checkpoint or inspect the workers while it runs; the engine prints
   its progress on stderr. If the command is interrupted, run the same
   command again: it continues from the last step its ledger holds and
   pays for no completed worker twice.
3. Exit code 0: the last line of stdout is the report's path. Show the
   user that path and say the report is theirs to read. Do not
   summarize, quote or interpret the findings.
4. Exit code 2: the run is blocked or was refused, and stderr ends with
   the blocker and the operator's action. Show both verbatim and stop.
5. Any other exit code: show stderr verbatim and stop.

Never review the change another way under this skill's name, and never
edit the code. The same `main.mjs` with `status` in place of `review`
prints the state of the active run, and with
`abandon --reason <text>` closes it.
