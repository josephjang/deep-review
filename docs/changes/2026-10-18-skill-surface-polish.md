# Change Proposal: Skill surface corrections

## Summary

The report [`2026-10-18-skill-surface.md`](../reports/2026-10-18-skill-surface.md) reads deep-review as a user meets it and names sixteen findings. This proposal is for the two packages that the report puts first. Package A is the words of the two skills. Package B is a few lines of the output of the engine. Neither changes what a run decides, edits or records on its ledger, except the words of one blocker action.

The report calls the other packages the turned report, the entry points and recovery. This proposal does not include them.

After the change, the description of the skill says what the user gets. Before a run, the skill shows the scope, the budget and the fix choice as `config show` prints them. Then the skill starts the run and does not wait. The Claude Code skill approves the command of the engine for its own turn. Its autocomplete shows what the user can type after the command, and the skill names `config init`.

On stderr, each phase line says how long the run is in progress and what it spent against its budget. Each fixer line says the number of its batch and the number of batches. The action of the `check-unavailable` blocker names the clone's file, which prevents the flags on each resume. The report says one time how a person at a terminal runs `deep-review answer`. The line after `--record-only` says that the next answer applies all the recorded answers.

## Problem

The report gives the evidence for each finding. The skill description lists the phases of the engine (F2). A user who reads it in a plugin list does not learn what a run gives. The skill chooses the scope and `--fix` from the words of the user and starts the run at once (F4). A scope that the model reads incorrectly costs the time and the money of a run. The read-only part of the gate run of the configuration change took 36 minutes and 27.99 USD.

The host asks the user to approve the command of the engine at each call (F5). The skill does not name `config init` (F14), so a model can write a policy file manually.

On stderr, the user sees one line for each worker start or end, 256 lines on that gate run. No line says the progress of the run or what it spent (F6). The run took 2 hours and 48 minutes. When the survey blocks on a check that the machine cannot run, the action names three options (F8). Each of them makes the user type a flag again on each resume before the run plans the checks. The configuration gives a fourth option, `checks.<kind>` in the clone's file, and the action does not name it.

The report prints `deep-review answer ...` as the command for an answer, and the executable `deep-review` is not installed (F13). The skill translates the line, and a user at a terminal cannot paste it. After `--record-only`, the engine says that the next answer applies "it" (F16). In fact the next answer applies all the recorded answers that need an edit.

## Goals

The user learns from the description what a run gives. The user sees the scope, the budget and the fix choice before the run starts, and nothing waits for the user. The Claude Code host does not ask the user to approve the command of the engine in the turn that starts the run. The user can ask for a policy file and get the file that `config init` writes. During a run, the user can see how long it is in progress and what it spent.

A user whose machine does not have a tool of a check learns the option that prevents the flags on each resume. A user at a terminal can run the answer command that the report names. The two skills remain one text, except for the lines that are different for each runtime.

## Non-Goals

The turned report of principle 5 is a different change, in the Split form. It contains F9 to F12 of the report: a readable copy, a top layer, the labels of a question, and the top layer on stdout. The split of the skill into review, answer and status (F3) is in the report's package D and comes later. The review that the author agent starts (G2 of the catalog) and an install for CI also come later.

The recovery issues #25, #34, #40 and #48 are package E. A budget or a time limit for Codex runs (F15) remains in row B3 of the catalog. The Codex install (F1) is not in this change. No event kind, no event version and no setting changes.

## Requirements

### R1: The description names the result

The `description` of both skills says what a run gives. The `description` in `plugin.json` and in `marketplace.json`, and the `short_description` in `openai.yaml`, say the same. A run gives a review of one change with evidence, and a decision on each finding by the engine. It asks questions only where a person must answer, and it says what it did not examine.

On request, it applies the fixes through the engine's own workers, runs the checks of the project, and commits nothing. The sentence that limits the skill to a request by name does not change. The description still says that the engine is a Node program installed with the plugin or the skill. The skills test checks this.

### R2: The skill shows the scope before the run and does not wait

Before the review command of step 3, the skill runs `config show` with the same runtime, scope, setting and `--fix` flags. It shows three items as `config show` prints them: the `Scope:` line, the `budget.usd` line of the settings, and the fix choice. Then it starts the review command. It does not ask the user to confirm, and it does not wait. A user who sees a wrong scope stops the command. The `config show` command creates no run, so a command that the user stops makes no change.

When `config show` exits with code 2, the skill shows its stderr as printed and stops, as step 7 says for a refusal.

### R3: The skill names `config init`

The last paragraphs of both skills name `config init --repository`, `--operator` and `--clone`, in place of `review`. The command writes a new file with each setting, its default value and a comment. A user who asks for a policy file gets that file, edited as the user asks. The skill still writes the repository's file only as an edit that the user asks for.

### R4: The Claude Code skill approves its own command for its turn

The frontmatter of the Claude Code skill gets an `allowed-tools` line with one rule. The rule approves the command of the engine under `${CLAUDE_PLUGIN_ROOT}/engine/main.mjs` and nothing else. Claude Code applies the grant for the turn in which the user invokes the skill, and clears it at the next message. So the review command of step 3 runs without a prompt in that turn. A later turn that runs `commit` or `answer` prompts again, or the user invokes the skill again. Codex does not have this setting, and its skill gets no line.

### R5: The Claude Code skill shows an argument hint

The frontmatter of the Claude Code skill gets an `argument-hint` line. It names what the user can type after the command: a scope in words, `fix`, and paths. Codex does not have this setting.

### R6: The two skills remain one text

The skills test keeps the two skills one text, except for the lines that are different for each runtime. It lists the new frontmatter lines of R4 and R5 among the lines of the Claude Code skill. Each other line of R1 to R3 is the same in both skills.

### R7: A phase line says how long the run is in progress and what it spent

The line `phase <name>: started (attempt <n>)` on stderr gets two more parts. The first is the time from the creation of the run, in minutes and seconds. The second is the spend against the run budget, in USD, as the budget check counts it. On a runtime that reports no cost, the second part says that no cost is reported. The line of a re-entered phase gets the same two parts.

The time comes from the `createdAt` of the run and the clock of the engine. The spend comes from the same `budgetSpendOf` that the budget check uses before each launch.

A fixer's start line, `worker fixer fixes:<key>: started`, gets the position of its batch as `batch <k> of <n>`. The count is of the batches that the fix plan or the second round planned.

### R8: The `check-unavailable` action names the clone's file

The action of the `check-unavailable` blocker gets a fourth option: a `checks.<kind>` line in the clone's file, which `deep-review config init --clone` writes, so that no resume needs the flag again. The three options of today remain. The ledger records the action as a string, and no schema changes.

### R9: The report says one time how a person runs the answer command

The paragraph of the Decisions section that says what an answer does gets one more sentence. It names the command as a person types it at a terminal: `node <path> answer ...`, with the path of the `main.mjs` of the engine that wrote the report. It also says that a person who uses the skill asks the agent to answer the finding with the option. The lines `Answer with:` and `Review with:` of each question and departure keep `deep-review answer`, as a reader cites them. The engine takes the path from its own invocation, as it takes the path of the runtime's executable today.

### R10: The `--record-only` line names all the recorded answers

After `deep-review answer --record-only`, the second line of stdout changes. It says that the next `deep-review answer` on this run without `--record-only` applies this answer and each other recorded answer that needs an edit.

## Product Decisions

### PD1: Show and start, not show and wait

R2 shows the scope and starts the run. The alternative waits for a "yes". It stops a wrong scope before it costs money. But it makes a person necessary at the start of each run, and an author agent (G2) cannot use the step. Principle 7 says that nothing waits for a person.

The display takes seconds, and a person who is present can stop the command. So the skill shows the scope and starts the run.

### PD2: One skill, with a hint

The report's first remedy of F3 splits the skill into review, answer and status. This proposal keeps one skill and adds the hint of R5. The answers on the pull request (principle 7) will move most answers from the terminal to the pull request. The value of a separate answer skill depends on how many answers remain at the terminal. The split comes after that work, which gives the facts for the decision.

### PD3: One rule in `allowed-tools`, for the engine only

R4 approves the one command of the engine, not each `node` command and not Bash. The grant is for the turn of the invocation, which Claude Code decides, not the skill. The proposal rejects a broader rule, such as each `node` command, because the skill then approves commands that are not its own. The rule uses `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes in `allowed-tools` as in the text. A real session shows if the rule matches the quoted path of step 3. If it does not, the skill writes the command in the form that the rule matches, and Verification records the form.

### PD4: Progress as time and spend, not as a count of phases

R7 gives the time and the spend, and it counts batches, but it does not say "phase 3 of 16". The run skips phases on conditions: repair and its checks when each check passes, and the answer phases outside an answer pass. A count that changes during the run is not correct. The order of the phases is fixed, and the names are in the report's Statistics. So the name of the phase shows the position of the run. The number of batches is fixed when the run plans the fixes or the second round, so a count of batches is correct.

### PD5: The answer command is named one time

R9 adds one sentence to the paragraph that each report with a question or a departure has, and it keeps `deep-review answer` on each line. The alternative puts the real path on each `Answer with:` line. That makes each line long and repeats a path that depends on the install. One sentence gives the person at a terminal what to type, and a reader can cite the lines as before.

### PD6: One proposal and one pull request for both packages

The skill text and the output lines change together, in one proposal and one pull request. Each is small, and the gate of one run covers both (principle 12). The gate runs on Claude Code. The Codex skill changes in the same lines, and the skills test keeps the two texts equal. A smoke test of the Codex skill with the new step of R2 is sufficient for Codex.

## Against the vision note

The proposal does not depart from a principle. R2 adds three lines before the run and no wait, so principle 7 applies. R1, R2 and R9 change words that the skill shows as printed and that the report prints. The skill still does not summarize or interpret, so principle 1 applies. R7 adds words to stderr, which is not the report, and principle 5 is about the report. R8 changes the words of a recorded action and no event schema, so an older ledger reads as before (principle 2).

## Risks

### The `allowed-tools` rule can fail to match the command as the skill writes it

The documentation gives `Bash(<command> *)` rules and says that Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in them. It does not say if the rule matches a path in double quotes. PD3 and Verification cover this risk: the gate records if the command of step 3 ran without a prompt.

### The grant is for one turn

A user who runs `commit` or `answer` in a later turn gets a prompt again. This is accepted: the run is the long step, and a user who commits wants to see the prompt for `commit`.

### The time on the phase line is the clock of the engine

A resumed run on another machine, or after a change of the clock, prints a time that is not the time of the first engine. This is accepted: the line is progress for the person who watches, and the Statistics of the report contain the measured wall seconds.

### The description changes the words that a host matches

Claude Code keeps the description out of the context of the model for this skill, and Codex does not invoke the skill implicitly. So persons read the description. The trigger sentence does not change. The skills test covers this risk.

## Verification

No check ran yet. This is the plan. The skills test (`test/skills.test.ts`) checks R1 to R6 against both files and the two manifests. The controller test checks the two parts of the phase line and the batch count of the fixer line (R7). It uses the fake runtime, with and without a reported cost. The test of the survey block checks the vocabulary of the blocker action (R8).

The report test checks the sentence of R9 with the path of the engine, and the answer test checks the line of R10. Then `npm run check` and `npm run verify` pass. Last, the gate of principle 12 runs the engine of this branch on this pull request with `--branch --fix`. The gate record says if the command of step 3 ran without a prompt (R4).
