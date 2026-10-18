# Implementation plan: skill surface corrections

This is the plan of the work for the [proposal](2026-10-18-skill-surface-polish.md). It stays in the pull request while the work continues, and the last commit of the series deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the command that proves it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit, and `npm run verify` passes at each head that is pushed, as `AGENTS.md` says. A commit that changes what a skill says and a commit that changes the engine are different commits. The build output under `dist/` is stale from step 1 to step 8, and step 9 rebuilds it in the last commit before the push.

The proposal can change during the work. If the code needs a different design, a commit of its own amends the proposal before the code commit.

## 0. The branch

The branch is `feat/skill-surface-polish`, from `main` at `ec7e9e4`. It holds the report, the proposal and this plan. Its name is set before the first push, because a rename of a pushed branch closes its pull request.

```sh
git log --oneline main..feat/skill-surface-polish
```

## 1. The description (R1)

- `skill/claude/skills/deep-review/SKILL.md` and `skill/codex/SKILL.md`: the `description` line. The two lines differ only in "plugin" and "skill" and in the name of the trigger, as today.
- `skill/claude/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: the `description` field, one text for both.
- `skill/codex/agents/openai.yaml`: the `short_description` field.
- `test/skills.test.ts`: the two `description` entries of `ownWords` take the new text. The test of the plugin description gets two more checks. Each of the five files names the questions, the departures and what the run did not examine. No file lists a phase of the engine.

```sh
node --import ./test/setup.ts --test test/skills.test.ts
npm run check
git commit -m "docs(skill): Say what a run gives in the description"
```

## 2. The scope before the run (R2)

- Both `SKILL.md`: step 3 gets the `config show` command before the review command, with the same flags, and the three items to show as printed. It says that the skill does not wait and that a user who sees a wrong scope stops the command. It says what to do on exit code 2.
- `test/skills.test.ts`: the test of `config show` gets more checks. Step 3 runs `config show` before `review` with the same flags. It shows the `Scope:` line, the `budget.usd` line and the fix choice, and it does not wait. The `ownWords` entry of step 3 takes the new text of each runtime.

```sh
node --import ./test/setup.ts --test test/skills.test.ts
npm run check
git commit -m "docs(skill): Show the scope and the budget before the run"
```

## 3. The `config init` sentence (R3)

- Both `SKILL.md`: the paragraph on configuration names `config init --repository`, `--operator` and `--clone` in place of `review`, and what the command writes.
- `test/skills.test.ts`: the same test checks the sentence in both files.

```sh
node --import ./test/setup.ts --test test/skills.test.ts
npm run check
git commit -m "docs(skill): Name config init for a new configuration file"
```

## 4. The frontmatter of the Claude Code skill (R4, R5, R6)

- `skill/claude/skills/deep-review/SKILL.md`: the lines `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/main.mjs *)` and `argument-hint: [worktree | last commit | branch | from <rev>] [fix] [path ...]` in the frontmatter. Step 11 shows if the rule matches the quoted path. If it does not, a commit of its own changes the form of the command in step 3.
- `test/skills.test.ts`: the two lines go into the `ownWords` of the Claude Code skill (R6). The test of the invocation setting gets more checks. The `allowed-tools` line has one rule, and the rule names `${CLAUDE_PLUGIN_ROOT}/engine/main.mjs`. The Codex skill has neither line.

```sh
node --import ./test/setup.ts --test test/skills.test.ts
npm run check
git commit -m "docs(skill): Approve the engine's command and hint the arguments"
```

## 5. The phase line and the fixer line (R7)

- `src/review/spend.ts`: a function `progressWords(state, spend, adapter, now)` gives the two parts. The first is the time from `state.createdAt` to `now` in minutes and seconds. The second is the spend against the run budget from `BudgetSpend`, or the words for a runtime that reports no cost.
- `src/review/controller.ts`: the `start-phase` case and `reenterPhase` append the two parts to their line. The worker launch appends `batch <k> of <n>` for a unit of the `fixes` phase. The position comes from the batches of the fix plan or of the second round.
- `test/review/controller.test.ts`: the regex of the phase line at the triage takes the two parts. One test runs the fake runtime with a reported cost and reads `spent 0.00 of 60.00 USD` on the first line and a larger spend on a later line. One test runs it without a cost and reads the words for no cost. One test of a fix run reads `batch 1 of N` on the first fixer line, with `N` the number of batches of the plan. The second round starts its count again. The test at line 801 that matches a phase line still matches.
- `test/helpers/fake-runtime.ts`: no change, if the fake runtime already reports a cost and can report none. If not, a flag for no cost.

```sh
node --import ./test/setup.ts --test test/review/controller.test.ts test/review/spend.test.ts
npm run check
git commit -m "feat(review): Say the time and the spend on each phase line"
```

## 6. The `check-unavailable` action (R8)

- `src/review/vocabulary.ts`: the `check-unavailable` entry of `blockerActions` gets the fourth option.
- `test/checkpoint/events-vocabulary.test.ts`: the action names the clone's file and `config init --clone`, and the three options of today.
- `test/review/survey.test.ts` or `test/checkpoint/survey-fold.test.ts`: the block records the new action.

```sh
node --import ./test/setup.ts --test test/checkpoint/events-vocabulary.test.ts test/checkpoint/survey-fold.test.ts
npm run check
git commit -m "fix(review): Name the clone's file in the check-unavailable action"
```

## 7. The answer command in the report (R9)

- `src/review/report.ts`: `ReportInput` gets `enginePath`, the path of the `main.mjs` of the engine that writes the report.
- `src/review/decision-report.ts`: the paragraph that says what an answer does gets the sentence with `node <enginePath> answer ...` and the sentence for a user of the skill.
- `src/review/controller.ts`: the report call passes `enginePath` from a new option of `runReview`. The report of an answer pass passes the same value.
- `src/cli.ts`: `runReview` and the answer command get `enginePath: process.argv[1]`, resolved to an absolute path.
- `test/review/report.test.ts`, which also covers the Decisions section: the sentence names the path given, and a report with no question and no departure has no such sentence.

```sh
node --import ./test/setup.ts --test test/review/report.test.ts
npm run check
git commit -m "feat(review): Say in the report how a terminal runs the answer command"
```

## 8. The `--record-only` line (R10)

- `src/cli.ts`: the line after a recorded-only answer.
- `test/review/answer.test.ts`: the expected stdout at the record-only case.
- `README.md`: the paragraphs under `Installing` that describe what the skill does take the new step of R2, the hint of R5 and the sentence of R3. The Answers section takes the line of R10.

```sh
node --import ./test/setup.ts --test test/review/answer.test.ts
npm run check
git commit -m "fix(review): Say that the next answer applies every recorded answer"
```

## 9. Self-review and the build

The self-review reads each hunk of `git diff main...HEAD` against the checklist of the global rules, and each skill line against the proposal. Then the build refreshes `dist/`, and the last commit before the push holds it.

```sh
npm run build
git add -A dist
git commit -m "chore(dist): Rebuild the plugin and the skill"
npm run check
npm run verify
```

## 10. The draft pull request

The push sets the upstream, and the pull request opens as a draft. Its body has the sections Motivation, Modifications and Result for a reader who is new to the repository, with unwrapped lines and nothing local. CI must pass on Linux, macOS and Windows.

```sh
git push -u origin feat/skill-surface-polish
gh pr create --draft --title "docs(skill): Correct the skill surface" --body-file <body>
gh pr checks --watch
```

## 11. The skill smoke on each host (R2, R4, R5)

This step runs the skills as a user does, which the engine gate of step 12 does not.

- Claude Code: the plugin marketplace points at this branch's checkout, and the plugin updates from it. In a scratch repository with one small change, the user types `/deep-review:deep-review` with no words. The record says three things. The `config show` lines appeared as printed, or not. The review command of step 3 ran without a permission prompt (R4), or not. The autocomplete showed the hint (R5), or not.
- The run of the smoke is read-only, and `deep-review abandon` can close it after the survey.
- Codex: the skill directory is replaced from `dist/codex` of this branch. `codex exec` with `$deep-review` on the same scratch repository shows the `config show` lines and starts the run.
- If the `allowed-tools` rule did not match, a commit changes the form of the command in step 3 of the skill and the `ownWords` entry. Then the smoke runs again.

```sh
claude plugin marketplace update deep-review
claude plugin update deep-review@deep-review
```

## 12. The gate (principle 12)

The engine of this branch reviews this pull request with `--branch --fix`, as the gate of the configuration did. The engine is a copy of `dist/claude` outside the worktree, because the build check rewrites `dist/` in the tree. The repository's file gives the checks and the budget.

- A worktree of this branch, with `npm ci`.
- `node <engine copy>/engine/main.mjs review --runtime claude --branch --fix`, with the stderr kept as the record of R7: each phase line shows the time and the spend, and each fixer line its batch.
- `deep-review commit`, then `npm run check` and `npm run verify` at the head, and typecheck and lint at each commit alone.
- The audit of the ledger: no commit holds a path that its cluster did not own or claim.
- The commits of the gate go into a stacked pull request onto this branch, and merge into it by fast-forward after CI.
- The author answers each question of the report with `deep-review answer`, and the answers are recorded.

## 13. The verification commit

- `docs/changes/2026-10-18-skill-surface-polish.md`: the Verification section records the tests of steps 1 to 8. It records the result of the smoke of step 11, with the form of the `allowed-tools` rule that matched. It records the gate of step 12 with its run, its findings, its cost and its commits.
- `docs/changes/2026-10-18-skill-surface-polish.plan.md`: deleted.
- The pull request leaves the draft state.

```sh
git rm docs/changes/2026-10-18-skill-surface-polish.plan.md
git commit -m "docs(changes): Record the verification of the skill surface corrections"
npm run check
npm run verify
git push
gh pr ready
```

## 14. The merge

On the author's word, `main` moves to the head of the branch by fast-forward, never by the rebase button. Thus the hashes that the Verification cites stay. Then the installed plugin and the Codex skill update from `main`.

```sh
git checkout main
git merge --ff-only feat/skill-surface-polish
git push origin main
claude plugin marketplace update deep-review
claude plugin update deep-review@deep-review
```
