---
name: deep-review
description: Deep review of one change by the deep-review engine, a Node program installed with this plugin. It writes a Markdown report with the evidence for each finding and the engine's own decision on it, asks only the questions a person must answer, names the fixes that depart from a rule, and says what the run did not examine; when the user asks, its own workers also apply the fixes and it runs the project's checks, committing nothing. Use only when the user asks for deep-review by name.
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)
  - PowerShell(node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" *)
argument-hint: "[worktree | last commit | branch | from <rev>] [fix] [path ...]"
---

The deep-review engine reviews the change; you run its commands, wait
for each to exit, and relay its result. Node 26 or newer must be
installed. Run each command below as it is written, alone, with nothing
chained before or after it.
If the PowerShell tool cannot check a command of this skill ("malformed
syntax that cannot be parsed"), run the commands of this skill with the
Bash tool from then on.

1. Decide the scope from what the user asked for:
   - the uncommitted changes in the worktree: `--worktree`
   - the last commit of a clean tree: `--last-commit`
   - the user's branch: `--branch`, adding `--base <rev>` when the user
     names what the branch starts from
   - everything since a ref: `--ref <ref>`
   - a range ending at HEAD: `--from <rev> --to HEAD`, adding
     `--merge-base` to measure from the merge base
   With no instruction, pass no scope flag: the engine chooses the scope
   its configuration names. Add `--path <path>` for each path the
   user limited the review to. Pass `--budget-usd <usd>` only when the
   user names a run budget; the default is 60 USD.
2. Decide whether to fix. When the user asks for the findings to be
   fixed or applied, add `--fix`. When a read-only run of the same
   change has finished and the change is unchanged since, the same
   command with `--fix` continues that run and reviews nothing again,
   so the fixes are of the findings the user read. The engine surveys
   the repository for its checks itself; add
   `--check <kind>=<command>` only for a check command the user names,
   and `--no-check <kind>` only for a check the user says to skip (kind
   `build`, `typecheck`, `lint` or `test`): each settles its kind over
   the survey. The message of step 3 tells the user what a fix run
   does. Without such a request, do not pass `--fix`: the review then
   edits nothing and runs no check.
3. First find out what the run will review. Run this from the
   repository and wait for it to exit:

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" status

   When it prints no line that starts with `Run `, no run is active. Run
   this from the repository, with the flags the review below takes, and
   wait for it to exit:

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" config show --runtime claude <scope flags> [--fix]

   When `config show` exits with code 2, show stderr verbatim and stop,
   as step 7 says for a refusal. When it exits 0, keep its `Scope:` line
   and the `budget.usd` line under its `Settings:` for the message below.
   When `status` prints a `Run ` line instead, that run is active and the
   review below resumes it: run no `config show`, and keep the `Run `,
   `Scope:` and `Settings:` lines of `status` for the message below.

   Then start the review at once, from the repository, as a background
   shell command with the longest timeout you can: do not ask the user
   to confirm, and do not wait for an answer.

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" review --runtime claude <scope flags> [--fix]

   Once it runs, write the user a message as the last text of this turn.
   The user does not see the commands' output, so this message is where
   they see the scope: copy the lines you kept into a code block,
   character for character, and below it say whether the run fixes. For
   a fix run, also say that the engine's workers will edit the working
   tree, that it runs the check commands it chose from the repository,
   and that the run commits nothing. For an active run, say that the
   review continues that run with the scope and the settings it recorded
   and ignores the scope flags. Then end the turn: the review goes on,
   and when it exits you go on with step 4.
   A user who sees a wrong scope stops the review before it has spent
   much; a run that reviews edits nothing until its fixes phase. When
   the user stops it because its scope is wrong, stop the background
   command first, since `abandon` refuses a run whose engine still runs;
   then close the run with `abandon --reason <text>` before you run the
   corrected request, so that the next review starts a new run rather
   than resume this one.

   A review takes many minutes, a fix run longer. Do not poll the
   ledger, read the checkpoint or inspect the workers while it runs; the
   engine prints its progress on stderr. If the command is interrupted,
   run the same command again: it continues from the last step its ledger
   holds and pays for no completed worker twice.
   A fix run that the run budget stopped continues the same way: run the
   same command with `--budget-usd` above the spend that the engine names,
   and it reviews nothing again. A run that a usage limit blocked resumes
   with the same command after the reset that its blocker names.
4. Exit code 0: stdout ends with the top of the run's brief: its title
   and the line of the change, the status line, What needs you and
   Before you merge as the report has them, and a line that names
   `report --fixes`; its last line is the report's path. Show the lines
   before the path to the user in a code block, as printed, then show
   the path and say the report is theirs to read: it starts with the
   brief, and a block for each finding and the evidence follow. Put them
   in the last message of the turn, after any other command you run. Do
   not summarize, quote or interpret the findings beyond those lines.
   Answer the user in the language that the user writes, and quote ids,
   paths and commands as printed. After a run with `--fix`, also say
   that the fixes are in the working tree, uncommitted, one patch per
   finding as the report's Patches lists them, and offer to commit them.
   When the user asks for more on one finding, run the `main.mjs` of
   step 3 with only `report --finding <number>`, with the number that
   the brief shows. When the user asks for the whole result, run it with
   only `report --brief`; when the user asks what the run changed, with
   only `report --fixes`; when the user asks for the statistics of the
   run, with only `report --stats`. Show the lines before the path as
   printed, the Markdown of `--brief`, `--finding` and `--stats` as
   Markdown, and then the path.
   When stderr has a line that says the run budget stopped the fix pass,
   show that line to the user as printed and offer to run the command it
   names.
5. When the user accepts, run

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" commit

   adding `--change-message <message>` when the scope was `--worktree`:
   the command commits the user's own change first, so ask the user for
   that commit's message before you run it. On exit code 2, show stderr
   verbatim and stop. On exit code 0, run the `main.mjs` of step 3 with
   only `report`, and in the last message of the turn show the lines that
   `commit` printed, one per commit, and then what `report` printed, as
   step 4 says: the brief that the review printed still says that the
   fixes are not committed.
6. The brief at the top of the report lists, under What needs you, the
   questions the run asked and the fixes that go against a written rule,
   each with the `deep-review answer` command that answers it. When the
   user answers
   one, run this from the repository as a background shell command with
   the longest timeout you can, and wait for it to exit:

   node "${CLAUDE_PLUGIN_ROOT}/engine/main.mjs" answer --finding <number> --option <n>

   with the finding's number and the option's number as the report
   prints them, or `--accept` or `--reject` in place of `--option <n>` for a
   departure, and `--note <text>` with what the user said beyond the
   choice. Exit code 0: the first line of stdout says the answer is
   recorded. On a run that fixed, the engine then applies every answer
   that owes an edit, and stdout ends with the top of the brief
   and the new report's path: show them as in step 4 and offer to commit
   the new edits as in step 5. On a run that only reviewed, it says that `review --fix`
   applies the answer: offer to run step 3 again with `--fix`.
   When it says the tree already holds the answer, tell the user nothing
   was applied. Exit code 2: show stderr verbatim and stop; when it says
   the answer is recorded, the same command applies it once the cause
   it names is gone.
7. Exit code 2: the run is blocked or was refused, and stderr ends with
   the blocker and the operator's action. Show both verbatim in a code
   block and stop, with no account of your own of what the run did,
   spent or left undone.
   A `check-unavailable` blocker names a check the project defines whose
   tool this machine lacks; when the user answers it, run the same
   command again, adding `--no-check <kind>` if they choose to go
   without that check or `--check <kind>=<command>` if they name one
   that runs, and nothing if they installed the tool. When the action
   names the clone's file and they choose to settle it there instead,
   write that file with `config init --clone` when it does not exist,
   as the configuration paragraph below says, set its `checks.<kind>`
   line as they ask, then close the blocked run with
   `abandon --reason <text>` and run the same command again, which
   starts a new run: the blocked run keeps the settings it recorded. The
   action of a run that `--fix` continued from a read-only review does
   not name that file, since an abandoned run cannot be continued and its
   review would be lost; do not offer it then.
8. Any other exit code: show stderr verbatim and stop.

When the user asks what a finished run found, run the `main.mjs` of
step 3 with only `report`, adding `--run <id>` when they name a run,
and show what it prints as step 4 says. `--run` takes the eight
characters of a run id that the brief shows. When the user asks for a
run and does not know which, run it with only `status --all`, show what
it prints, and then run `report --run <id>` with the run the user
chooses. On exit code 2, show stderr verbatim.

When the user asks how deep-review is configured, or what a run would
take now, run the `config show` command of step 3 with the same scope
flags and no `--fix`, and show all that it prints. When the user asks
why a run reviewed what it did, answer from that run's own record, not
from `config show`, which reads today's files and flags: for the active
run, run the `status` command of step 3 and show all that it prints;
for a finished run, show the `Settings:` line of the facts of the run,
the part `## About this run` at the end of its report, and the paragraph
under Before you merge in its brief that says what the run did not
examine, exactly as the report prints them.
When the user asks to change a preference, name the file that
`config show` lists for it. When the user asks for a configuration file
that does not exist yet, run the `main.mjs` of step 3 with only
`config init --repository`, `config init --operator` or
`config init --clone`, for the repository's file, the operator's or
this clone's. It writes a new file with each setting as a comment at
its default and a sentence that says what the setting does, prints the
file's path, and refuses to write over a file that exists; then edit
that file as the user asks. Write the repository's
`.deep-review/config.toml` only as a change the user asks for, as any
other edit, never as a step of a review.

Never review, fix, revert or commit the change another way under this
skill's name, and never edit the code yourself: no `git commit`, no
amend, no push. The same `main.mjs` with `status` in place of `review`
prints the state of the active run, and with `abandon --reason <text>`
closes it.
