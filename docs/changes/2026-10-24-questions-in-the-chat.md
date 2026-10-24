# Change Proposal: The questions in the chat, the way back and the scope

## Summary

The report [`2026-10-23-skill-ux.md`](../reports/2026-10-23-skill-ux.md) reads deep-review from the place of a person who uses it through Claude Code or Codex. It puts three changes first. The first is a start of the result that the person can use at once (U1). The second is a way back to a report (U5). The third is a scope that the person can check before the run (U6).

The documentation step settled one part of the first change, the count of the documents that the fixes left out of date (U2). This proposal is for the three changes.

After the change, the short form of the brief says what each open question asks, what the tree holds now and what deep-review chose. It names the rule of each fix that goes against a written rule. Its line of the change gives a whole sentence, and it says when the account describes the change before the fixes. `report --brief` prints the brief as the report starts with it. `report --finding <id>` prints the block of one question, or of one fix that goes against a written rule. `report --fixes` prints one line for each fix, with the subject of its commit.

`report` takes the newest run that has a report, by its last event, and it names each later run that it passed over. A run with no report says why. `status --all` lists the runs, and `--run` takes the eight characters of a run id that the brief shows. The `Scope:` line counts the commits and the files of the change and names its base. The Claude Code skill starts the review before it shows the scope, so that the scope comes as a message.

No event, no setting and no role prompt changes. The task of the triage gets one sentence, and the JSON form of the brief takes version 3. What a run decides, edits and records stays the same.

## Problem

### What the chat gets after a run

At the end of a run, the engine prints the short form of the brief, and the skill shows it in the chat as printed. The short form gives counts and ids. The line `Questions: 1, with its default in place: REMOVALS-3` does not say what the question is. The line `Changed: 5 fixes, not committed` does not say what the fixes do, and the brief also names the fixes only by id.

The questions, the options and the fixes are in a report of 400 to 506 lines, in a copy under `.git`. To learn what a question asks, the person opened the copy or asked the host model. The host model then read the report and explained it. But step 4 of each skill tells the host not to summarize, quote or interpret the findings. Also, the quality of the explanation depends on the host.

Two smaller faults are in the same lines. The line `The change:` cuts the first sentence of the account at 200 characters, and in one run the line ended as `... as ^D or...`. The lines `Against a written rule:` and `Look at:` give two names to one thing: a fix that goes against a written rule, and a departure. "Departure" is a term of the engine.

R13 of the brief of a run gives the short form a fixed maximum of lines for any number of findings, eight lines today. That proposal kept the questions in the report, and each line of the short form must keep its sense when a model rewords it (PD12). This proposal keeps that rule for each new line.

### What the core of the change says after the fixes

The brief starts with the core of the change: the account of the triage, written before any fix. The fixes of a run change the behavior, and an answer can reverse it. After the fixes and the answers, the account can say the opposite of the tree (U3 of the report). The brief does not say that the account describes the change before the fixes.

### The way back to a report

`report` with no `--run` takes the newest run of the worktree, also a run with no report. In the runs of the report, the person abandoned a run with a wrong scope. The next day, `report` took the abandoned run and refused it with this text:

```text
refused: run 171fd810-... has no current report: its review is not done, or an answer pass, a continuation or a reopened fix pass runs; deep-review status --run 171fd810-... shows where it is
```

The text does not say that the run was abandoned. No command lists the runs, because `status` shows only the active run. The brief shows eight characters of a run id, and `--run` takes only the whole id of 36 characters. The host searched the folder of the checkpoint for 1 minute 6 seconds, with 2 permission prompts, before it found the run (U5).

### The scope before the run

The skills show the scope before the run, so that a person who sees a wrong scope stops the run early. R2 of the skill surface corrections asks for this.

Step 3 tells the model to write a message before its next tool call, in the same reply. On Claude Code, Opus 5.5 put this message in its `thinking` each of the four times that a run started (U6). The terminal showed the `thinking`, so the person saw the words. A host that hides the `thinking` shows nothing. The same model wrote the last message of each turn as text.

Step 2 has the same fault. Before a fix run, it tells the model to give the person three facts. The workers edit the working tree, the engine runs the check commands that it chose, and the run commits nothing. One session asked for the review, the fixes and a commit in one message. In it, these words were only in the `thinking`, beside the scope.

The line itself is hard to judge. In one run, it was `Scope: range, the change from 2247b35ea1c4... to the working tree`. The person asked for the branch, and the line says `range`. It does not say that the base is the merge base with `origin/main`, or that the change has 1 commit and 4 files.

## Goals

After a run, the person learns from the lines in the chat what each open question asks and what the tree holds now. The person also learns what deep-review chose, and which rule each fix goes against. The person does not read the report for this. A person who wants more gets the whole brief, or a line for each fix, from a command of the engine.

The person does not take the core of the change for the code after the fixes. The person finds the report of a finished run again after any later run, with the id that the brief shows. The person also learns why a run has no report. Before a run, the person sees the scope as a message, with facts that the person can check.

## Non-Goals

### The block "Before you merge"

The report proposes a block that gives the behavior after the fixes and compares each failed check with the base (U3). This proposal only marks the core of the change as the change before the fixes (R5). A new account after the fixes needs a worker that reads each fix and each answer. A check on the base costs one more run of the check. Both need a decision of their own.

### The rule for the interpretation by the host

Step 4 still tells the host not to summarize, quote or interpret the findings (U4). `report --brief`, `report --finding <id>` and `report --fixes` give the host text of the engine to show, in place of an account of its own. A rule that lets the host quote the report is a decision of its own.

### The shape of the report and the language of the reader

The report keeps its parts, and the short form, the brief and the list of runs stay in English (U7). Times stay in UTC.

### The consistency of the decider

One run of a change can ask a question that another run of the same change decides (U8). That is a measure of the decider, not of the surface.

### A line for each fix in the short form

The report asks for it. PD3 says why `report --fixes` prints the line instead.

### The pull request as the surface

Principle 7 makes the pull request the surface on which a person answers. The lines of a question in this proposal are text that a later change can post there.

### Other parts of the surface

This proposal does not change which commands a host asks permission for, or what a failure prints. Each is a change of its own. A person stops a run as before, and only the Claude Code skill gets a sentence for it (R13).

### A JSON form of the list of runs

`status --all` is for a person. A program reads a run with `report --run <id> --json`.

## Requirements

### R1: The short form names each open question with its words

The line `Questions:` keeps its count and its words about the default, and it no longer lists the ids. After it, each open question gets its own lines, for at most three questions, in the order of the brief. The first line is the id of the finding and the question as the decider wrote it. The next line is the id and the option in place now, with its number and its words. The last line is the id and the choice of deep-review, with its number and its words. When the two are one option, one line gives both.

When the default edits the code and no fixer applied it, the line of the option in place names the default. It then says that the tree does not hold it. When more than three questions are open, one more line counts the others and names their ids, at most eight.

These lines give the words of the decider whole (PD12). The decider writes the question and each option in at most 400 characters, so no such line is cut. The other lines of the short form keep their limit of 200 characters, cut at a word as today. This is an invented example:

```text
Questions: 1, with its default in place
  REMOVALS-3: Must a command read the input bytes unchanged when the runner echoes them?
  REMOVALS-3 in place now: option 1, Keep the removal of the two bytes.
  REMOVALS-3 deep-review's choice: option 2, Pass each byte on and change only the echo.
```

### R2: The short form names the rule of each fix that goes against one

The line `Against a written rule:` keeps its count, and it no longer lists the ids. After it, each fix that no person reviewed yet gets one line, for at most three fixes. The line gives the id, then where the rule is written, then the rule as the decision states it. It gives the words of the decider whole, as R1 does (PD12).

In a run that only reviewed, and for a fix that no fixer applied, the line says `would go against` in place of `goes against`. When more fixes are open, one more line counts the others and names their ids. The reason and the commands stay in the brief (R7). This is an invented example:

```text
Against a written rule: 1 fix
  SCAN-1 goes against a rule in docs/options.md: "Each option is documented in the help of its command"
```

### R3: One name for one thing in the short form

The line `Look at:` names the fixes that go against a written rule with these words, as the line `Against a written rule:` does. It no longer calls them departures. An example is `Look at: 1 fix that goes against a written rule, a change to a public interface`.

### R4: The line of the change keeps its first sentence whole

The line `The change:` gives the first sentence of the account whole, up to 400 characters. Only a longer sentence is cut at a word, with three periods. With the lines of R1 and R2, this line can be longer than 200 characters. The task of the triage asks it to start `what` with one sentence of at most 160 characters that says alone what the change does.

### R5: The core of the change says when it describes the change before the fixes

In a run where a fixer applied a fix, or an answer pass applied an answer, the line of the change starts with `The change before the fixes:`. The part "The change" of the brief ends with one more sentence. It says that the title and the account describe the change before the fixes and the answers of the run. It also says that the part "What deep-review changed" names the fixes. The title line of the short form stays as it is, and the line below it carries the mark.

A run that applied no fix and no answer keeps the words of today. A rewrite by a check, or an edit of the documentation step, changes no behavior that the account describes, so it gives no mark. A run whose triage gave no account, or recorded none, keeps the words of today too: it has no account to mark.

### R6: `report --fixes` prints a line for each fix

`deep-review report --fixes` prints one line for each fix of the run, in rank order, as the part Fixes of the evidence gives them. The fixes are the ones that the part "What deep-review changed" counts: applied, found already in the tree, put off, not applied and not attempted.

A line gives the id and what became of the fix, in the words of the brief. Then it gives the subject of the commit message that the fixer gave. A fix with no message gets the first sentence of the note of its fixer. A line has at most 200 characters, cut at a word. The last line is the path of the copy, as for `report`.

It takes the run as `report` takes it (R8, R11), and it gives the lines of R8 first. In a run that only reviewed, it prints the sentence of the brief that says so. The brief keeps its part "What deep-review changed" as today. `--fixes` does not go with `--json` or with `--brief`. This is an invented example:

```text
RIPPLE-1, applied: Guard the cache against a missing entry
SWEEP-2, put off by its fixer: The fix needs the format of the record, which the next change sets.
```

Both skills get one sentence. When the user asks what the run changed, the skill runs `report --fixes`. It shows the lines before the path as printed, and then the path.

### R7: `report --brief` prints the brief, and `report --finding <id>` one block of it

`deep-review report --brief` prints the brief in Markdown, as the report starts with it, and then the path of the copy as the last line. It takes the run as `report` takes it (R8, R11), and it gives the lines of R8 before the brief. It writes the copy again as `report` does. `--brief` and `--json` do not go together.

`deep-review report --finding <id>` prints one block of the brief in the same way. The block is the one of a question, open or answered, or of a fix that goes against a written rule. The block of a question gives the question and the table of its options, with the cost and the rule of each. It ends with the command that answers it. An id that names no such block is refused, and the refusal names `report --fixes` for a fix. `--finding` does not go with `--json`, `--brief` or `--fixes`.

The brief in the report is text for a file, and `--brief` and `--finding` print it for a chat. So an id is plain text, not a link into the report. The details that the report folds under a `<details>` tag follow as a paragraph. The sentence on how to answer tells the person to ask the agent, because no end of a report follows. The report keeps its form.

Both skills get one sentence. The skill runs `report --finding <id>` when the user asks for more on one question, or on one fix that goes against a written rule. It runs `report --brief` when the user asks about a document left out of date, or for the whole result. It shows the lines before the path as Markdown, as printed, and then the path.

### R8: `report` takes the newest run with a report

`report` with no `--run` takes the run of the worktree that has a current report and whose last event is the latest in the ledger. `answer` and `commit` take their run in the same order, and they also pass over the runs that they cannot act on. R9 of fix pass continuation gives the reason: a read-only run that `review --fix` continues ends after runs that started later. This revises R16 of the brief of a run, whose design took the newest run by the time that it started.

Before the short form, stdout gives one line for each run of the worktree that `report` passed over and whose last event is later. The line gives the state of that run as R9 says it. A later run that this engine cannot read gets a line that says so. At most three such lines come, and one more line counts the others. Each line has at most 200 characters, cut at a word, because the reason of an abandon has no limit. This is an invented example of the line:

```text
Not shown: run 171fd810, a later run, was abandoned: wrong scope.
```

With no run that has a report, `report` refuses with exit code 2. The refusal gives the state of the newest run and names `status --all`. A worktree with no run at all gets the refusal of today.

With `--json`, stdout holds the JSON form alone. Version 3 of the JSON form lists the same runs in `notShown`, each with its id and its state as R9 says it. So a program also learns that a later run exists. With `--run`, the list is empty.

### R9: A run with no report says why

The refusal of `report --run <id>` and the line of R8 give the state of the run in its own terms. An abandoned run gives the reason of the abandon. A blocked run gives the code of its blocker. A run in progress says that it runs.

A run that works again gives the answer pass, the continuation or the reopened fix pass that runs. A run whose review never started says so. The refusal still names `status --run <id>`.

These words name no phase, because a phase is a term of the engine (R12 of the brief of a run). `status --run <id>` gives the phase.

### R10: `status --all` lists the runs

`deep-review status --all` prints one line for each run of the checkpoint that this engine can read, newest first. It shows at most 20 runs, and then the count of the others. With no checkpoint, or with no run, it prints the line that `status` prints today.

A line gives the first 8 characters of the id of the run (R11) and the time that it started. It gives its state, with the reason of an abandon. It also gives the mode of its scope as R12 names it, its number of files and both ends. It names its worktree when that is not this worktree. Last, it gives the path of the copy of its current report, or says that the run has no current report. `--all` does not go with `--run` or with `--json`.

Both skills get one sentence. When the user asks for a run and does not know which, the skill runs `status --all` and shows what it prints. Then it runs `report --run` with the run that the user chooses.

### R11: `--run` takes the start of a run id

Each command that takes `--run` takes the whole id of a run, or its first 8 or more characters. The brief and the list show 8 characters. A start that names no run is refused as an unknown id is today. A start that names more than one run is refused, and the refusal names those runs.

### R12: The `Scope:` line gives facts that a person can check

The `Scope:` line of `config show` gives the scope as the person asked for it: `branch` for `--branch` or for a `scope.default` of `branch`. It gives the number of commits and of changed files that the run reviews. It names where the change starts, with the name that the scope gives the base and its short commit, and where the change ends. For a change that ends at the working tree, it counts the reviewed files that hold uncommitted changes, or it says that none do. It counts apart the paths that `scope.exclude` leaves out.

The count of commits follows the first parent from the end of the change back to its base, so a merge counts as one commit. With `--path`, it counts the commits that change those paths. A change that starts at the empty tree counts each commit up to its end. This is an invented example:

```text
Scope: branch, 1 commit and 4 files, from the merge base with origin/main (2247b35) to the working tree, which has no uncommitted change
```

The `--json` output gives these facts in `scope`. It also gives the path of each file that the run reviews, and of each path that `scope.exclude` leaves out. `status` gives a `Scope:` line from the scope that the run captured, so a resumed run shows its scope too. The line has the same facts, except the count of uncommitted files, which the run does not record. `status --json` gives the same two lists in `scope`. When git cannot count the commits, the line leaves the count out and does not fail.

The run records `--branch` as a range, so `status` names the mode from what the run recorded. A range that starts at the merge base with the recorded `review.base` and ends at `HEAD` reads as `branch`. The same range given as `--from <base> --to HEAD --merge-base` reads as `branch` too, because it is the same change. A run that recorded no settings keeps the mode that it captured.

### R13: The Claude Code skill shows the scope after it starts the review

Step 3 of the Claude Code skill runs `status`, and `config show` when no run is active, as today. Then it starts the review as a background command. Only after that does it write the message. This message is the last text of the turn.

The message holds the `Scope:` line, the `budget.usd` line and the fix choice. For an active run, it holds the `Run`, `Scope:` and `Settings:` lines of `status` (R12). For a fix run, it also holds the words of step 2: the workers edit the working tree, the engine runs the check commands that it chose from the repository, and the run commits nothing. Step 2 of this skill no longer says them before the review.

When the review exits, the skill goes on with step 4. This needs nothing new of Claude Code. Today too, step 3 runs the review as a background command, and the turn ends while it runs. The host calls the model again when the command exits.

When the user stops the review, the skill stops the background command first, and then it abandons the run. Step 3 today says only to abandon it. But `abandon` refuses with `lock-held` while the engine of the run still holds the lock of the run.

The Codex skill keeps its order. Codex shows a message that the model writes before a command (U6), and its review runs in the foreground of the turn. Its message for an active run copies the `Scope:` line of `status` too.

### R14: A skill ends the turn with the result that it relays

Sometimes a turn of a skill runs another command after the review or an answer, such as `commit`. Then the last message of the turn holds the result. A message in the middle of a turn can go into the `thinking` of the model, as U6 shows for the scope.

After `commit`, the skill runs `report`. The last message holds the lines that `commit` printed, and then the short form that `report` printed, as step 4 shows it. The short form that the review printed is out of date after a commit: its line `Changed:` says that the fixes are not committed.

### R15: The gate

The gate is a real run (principle 12). deep-review reviews and fixes this pull request on Claude Code. Then the engine of this branch runs on pallets/click #3878 in interactive sessions of Claude Code and Codex. The sessions follow the steps of the report: a start, a result with a question, a question that the person asks about, and a commit. Then come a start with a wrong scope that the person stops and abandons, and a request for the last result.

The gate records the measures that no test of the engine can show. On Claude Code, the message with the scope is a text block of the transcript at each start. For a fix run, it holds the words of step 2. Before this change, it was a text block at none of four starts. In each host, the `Scope:` line of each start names `branch`, the counts and the base, and they match what git gives for the clone.

In each host, the person learns what each open question asks from the chat, and the host reads no report for it. The last message of each turn that ends with a result holds the short form as the engine printed it, also after `commit` (R14).

After the person stops the run with a wrong scope, `abandon` closes it with no refusal. After an abandoned run, one command of the engine shows the last report. Before this change, the host searched for 1 minute 6 seconds, with 2 permission prompts.

When the run of a host asks no question, the same request runs once more in that host, on the author's word (PD13). When that run asks none either, the record says that the gate did not measure the questions in that host.

## Product Decisions

### PD1: The words of each question in the short form, and its block in a command

Two ways were open. One prints the questions with a command, and the skill shows them when the person asks. The other puts the questions into the short form. This proposal does both. The short form reaches the person after each run, and principle 5 puts the questions first. A person must not ask to learn what they are asked.

A question block has a table of options, the cost of each option, the rule of each option and the command. That does not fit in a few lines, so `report --finding <id>` gives it. The proposal rejects a short form with whole question blocks, because a run with several questions then fills the chat.

The author chose on 2026-10-24 that a question on one finding gets the block of that finding. The proposal rejects the whole brief for it: a brief has 27 to 69 lines in the runs of the report, and the question was on one finding.

### PD2: At most three questions and three fixes against a rule

R13 of the brief of a run fixes a maximum of lines for any number of findings. Thus the short form stays short in a large run. This proposal keeps a maximum and makes it larger.

The new maximum is 22 lines. These are the eight lines of today, three lines for each of three questions, and one line for each of three fixes. Each of the two lists also gets one line that counts the others. The maximum counts the lines of the short form. The path after them stands apart, as today, and so do the lines of R8 before them, which have a maximum of their own.

The gate run of the documentation step on its own pull request, a change of 71 files, asked three questions. Three shows such a run whole, and the line of the count keeps the others in view. A maximum of one hides the second question of a run with two. No maximum breaks R13. The author can change the number when the questions of more runs are counted.

### PD3: The fixes stay in the evidence, and `report --fixes` prints them

The author chose this on 2026-10-24. The report asks for a line for each fix in the short form, which keeps the count instead. Principle 5 puts the fixes in the evidence, after what the person must know and decide. The gate run of the documentation step decided 23 findings to fix. A line for each fix makes the short form grow with the number of fixes. R13 of the brief of a run does not permit that.

The brief is the part of the report that the person reads first, so the same principle keeps the lines out of the brief too. The brief names each fix by its id, with a link to its evidence. `report --fixes` prints the lines when the person asks what the run changed, and `commit` prints the subject of each commit. The proposal rejects the lines in the brief: they depart from principle 5, and a run with 23 fixes adds 23 lines to what the person reads first. The block "Before you merge" (U3) can later choose which fixes a person must see before a merge.

### PD4: The whole first sentence, and a short first sentence from the triage

The cut at 200 characters changed the sense of the line (`... as ^D or...`). Three ways were open: show the sentence whole, cut it at a comma, or ask the triage for a shorter sentence. A cut at a comma still loses part of the sense. A request to the triage alone is not sufficient, because a model does not count characters with accuracy. So the task asks for a short first sentence, and the line shows the sentence whole up to 400 characters. The cut stays only for a longer sentence.

### PD5: A mark on the core of the change, not a new core

After the fixes and the answers, the account of the triage can say the opposite of the tree (U3). This proposal marks the account as the change before the fixes, and it does not write the behavior after them. That needs a worker that reads the change, each fix and each answer. The block "Before you merge" decides it together with the checks on the base. The mark costs nothing at run time, and it tells the person not to take the account for the code that merges.

### PD6: `report` passes over a run with no report, and says so

`answer` and `commit` with no `--run` pass over the runs that they cannot act on. `report` took the newest run in any state, so an abandoned run blocked the way to the report before it. The proposal rejects two other ways. A refusal, as today, leaves the person with no report.

A silent choice of an older run hides a newer run in progress, and the person can take an old result for the current one. So `report` takes the newest run with a report, and its first lines name each newer run that it passed over. The JSON form names them in a field of its own, because a line before the JSON breaks it. A program can also take an old result for the current one.

### PD7: The list is a flag of `status`

A list of runs can be a new command, a flag of `report` or a flag of `status`. `status` already gives the state of a run, and the skills already name it. A new command adds one more name to learn. A list from `report` puts a list into an output that ends with a short form. So the list is `status --all`.

### PD8: `--run` takes the first eight characters

The brief, the name of the copy and the list show eight characters of a run id. `--run` took only the whole id, and a person repeats what they see. The proposal rejects the whole id in the short form. It makes the first line of each run longer, only for the case of an older run. In one checkpoint, eight characters of a random id name one run in practice. A start that names more than one run is refused, with the runs that it names.

### PD9: Counts and names in the `Scope:` line, not the files

From this line, the person judges if the run reviews what the person asked for. The count of commits and of files, and the name of the base, answer that. A list of the files is too long for the chat in a large change. So the line gives the counts, and the JSON forms give the list: `config show --json` before the run, and `status --run <id> --json` for a run. Today no command gives the list: `config show` finds the paths, but it uses them only to see if the change edits the file of the repository's settings. The count of commits costs one more git command for `config show` and for `status`.

### PD10: The Claude Code skill starts the review first and shows the scope after

Step 3 told the model to write the message before its next tool call, in the same reply. In each of four starts, Opus 5.5 wrote the message in its `thinking`. The same model wrote the last message of each turn as text.

In the work on the skill surface, four runs in print mode had three different words in step 3. In none of them did the model write such a message before the review. In two interactive sessions, it wrote one in its own words. So the place of the message in the middle of a turn does not hold. This proposal moves the message to where the model writes text: the end of the turn, after the review starts.

The words of step 2 for a fix run go into the same message, for the same reason. R14 of the fix pass says that a skill tells the person beforehand that the run edits the working tree and commits nothing. After this change, the person learns it a few seconds after the start, and before the run edits a file or runs a check. This proposal revises R14 of the fix pass in that way.

The cost is that the run starts a few seconds before the person sees its scope. The run edits nothing and runs no check before the decision, and the triage, the finders and the verification come first. A person who stops it in its first minutes loses the survey, when the run has one, and the start of its triage. The proposal rejects a hook that prints the scope, because it works only on Claude Code and gives the same text a second place.

### PD11: One proposal for the three changes

The three changes are lines of the engine and sentences of the skills, and each is small. One gate covers them (principle 12), and the report on what a person gets from a run proposes them as one.

### PD12: The words of the decider whole in the short form

The author chose this on 2026-10-24. The decider writes a question, an option, a rule and its source in at most 400 characters each. On Claude Code, the questions of the two gate runs on this repository's own pull requests have 244 to 335 characters. The decider puts the sentence that asks last, so a cut at 200 characters drops it. The options of one of those runs have 56 to 158 characters, so a line with both options cuts the choice of deep-review.

So the question and each of the two options get a line of their own, and the short form gives their words whole. A line of a departure gives its source and its rule whole too. R13 of the brief of a run gives each line at most 200 characters. This proposal revises it for these lines, as R4 does for the line of the change.

The proposal rejects two other ways. A cut at 200 characters on lines of their own still drops the question of most runs on Claude Code. Option numbers alone keep the lines short, but the person then opens the report to learn the options, which is the fault of U1.

### PD13: The gate when a run asks no question

The author chose this on 2026-10-24. One run on pallets/click #3878 asked no question (U8), so a run of the gate can give no question to measure. A second run in that host costs one more run, and the author decides it when it comes. The proposal rejects two other ways. A record of "not measured" at once gives up the measure after one run. The question of the run on this pull request is no measure of the chat, because no session of a host shows that run.

## Against the vision note

### Principle 1, evidence, not trust

Each new line is text of the engine from the ledger: the question and the options of the decider, the rule as the decision records it, and the subject that the fixer gave. The skills still show what the engine printed, and they do not interpret it. The mark of R5 says what the account is. It is not a verdict.

### Principle 5, the core, the questions, and the departures go to the person

The short form now gives what each open question asks, and the rule of each fix that goes against one. These are the lines that the person reads first. The mark of R5 keeps the core of the change true to what it is. The fixes stay in the evidence, and `report --fixes` prints them when the person asks (PD3).

### Principle 6, easy to understand, with little context

A question in the chat now names its option in place and the choice of deep-review in words. A fix that goes against a rule names the rule and its source, not a file and a line only. The `Scope:` line names the scope in the words of the person, with counts.

### Principle 7, nothing waits for a person

No step waits. The Claude Code skill starts the run before it shows the scope.

### Principle 8, say what was not examined, and when a person must look

The conditions of `Look at:` do not change. R3 changes only the words of one condition.

### Principle 12, a real run is the gate

The fault of U6 shows only in a real session of a host, and no test of the engine can show it. Thus the gate of R15 runs interactive sessions of both hosts on a real change, beside the run of deep-review on its own pull request.

### How to use this document

The vision note counts a proposal against it if it increases what the person must read. The short form grows from at most 8 lines to at most 22. The lines of the questions and the departures give the words of the decider whole, up to 400 characters each. In exchange, the person does not open a report of 400 to 506 lines to learn what a question asks. The person also does not ask the host to read it.

This is a conflict between principles 5 and 6 and that item of the list. This proposal follows principles 5 and 6, and it names the longer short form here. The lines of the fixes stay in the evidence, so a person who does not ask what the run changed does not read them.

## Risks

### A host can still reword or leave out a line

A model of a host can reword the lines that it shows (PD12 of the brief of a run). Each new line names its finding first, so it keeps its sense when a model rewords it. The gate records what each host showed.

### Long lines in the short form

With its id, a line of a question, of an option or of a departure can have more than 400 characters. A chat wraps such a line. Only the lines of the change, the questions and the departures can pass 200 characters, and the short form keeps its maximum of lines.

### `report` can show an older result while a newer run is in progress

The first line of its output names the newer run and its state, and the JSON form names it in `notShown`. A skill that shows the lines as printed shows that line too.

### A start of eight characters can name two runs

The refusal names both runs, and the whole id still works.

### The count of commits costs a git command

`config show` and `status` count the commits of the change with one more git command. The command counts only the commits between the two ends of the change. When git cannot count them, the line leaves the count out.

### The run starts before the person sees its scope

A wrong scope costs the first seconds of the run: the survey, when the run has one, and the start of the triage. PD10 accepts this.

### A program reads version 2 of the JSON form

A program that reads the JSON form gets version 3 and must take it. No program in this repository reads the JSON form, and its version tells a program that the shape changed.

## Verification

No checks have run yet.
