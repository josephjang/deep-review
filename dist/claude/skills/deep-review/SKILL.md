---
name: deep-review
description: Deep review of a change by the deep-review engine, a Node program installed with this plugin. It runs the SCAN triage, nine more finder angles, deduplication, verification, a gap sweep and a merge-and-rank pass, and writes a Markdown report; when the user asks, its own workers also apply the fixes and it runs the project's checks, committing nothing. Use only when the user asks for deep-review by name.
disable-model-invocation: true
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
   user limited the review to. Pass `--budget-usd <usd>` only when the
   user names a run budget; the default is 60 USD.
2. Decide whether to fix. When the user asks for the findings to be
   fixed or applied, add `--fix`, and `--check <kind>=<command>` for each
   check command the user names (kind `build`, `typecheck`, `lint` or
   `test`). Before you run it, tell the user that the engine's workers
   will edit the working tree and that the run commits nothing. Without
   such a request, do not pass `--fix`: the review then edits nothing.
3. Run this from the repository as a background shell command with the
   longest timeout you can, and wait for it to exit:

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" review --runtime claude <scope flags> [--fix]

   A review takes many minutes, a fix run longer. Do not poll the
   ledger, read the checkpoint or inspect the workers while it runs; the
   engine prints its progress on stderr. If the command is interrupted,
   run the same command again: it continues from the last step its ledger
   holds and pays for no completed worker twice.
4. Exit code 0: the last line of stdout is the report's path. Show the
   user that path and say the report is theirs to read. Do not
   summarize, quote or interpret the findings. After a run with `--fix`,
   also say that the fixes are in the working tree, uncommitted, one
   patch per finding as the report's Changed files lists them, and offer
   to commit them.
5. When the user accepts, run

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" commit

   adding `--change-message <message>` when the scope was `--worktree`:
   the command commits the user's own change first, so ask the user for
   that commit's message before you run it. Show the lines it prints, one
   per commit. On exit code 2, show stderr verbatim and stop.
6. Exit code 2: the run is blocked or was refused, and stderr ends with
   the blocker and the operator's action. Show both verbatim and stop.
7. Any other exit code: show stderr verbatim and stop.

Never review, fix, revert or commit the change another way under this
skill's name, and never edit the code yourself: no `git commit`, no
amend, no push. The same `main.mjs` with `status` in place of `review`
prints the state of the active run, and with `abandon --reason <text>`
closes it.
