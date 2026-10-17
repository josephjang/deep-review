# Product Requirements: Configuration

Technical part: [2026-10-16-configuration.design.md](2026-10-16-configuration.design.md).

## Summary

deep-review gets one configuration surface, the same under Claude Code and Codex. A repository states its own review policy in a committed file, `.deep-review/config.toml`. The file gives the paths that are never part of a reviewed change. It gives the commands that check the code. It also gives how long a check can run, and if the personal rules of a reviewer count. And it gives the budget that the runs of the repository usually need.

An operator states their own preferences one time, in a file in their home directory. A second file holds what is true of one clone, such as the directory of a tool that only this clone uses. This file is beside the git data of the clone, outside all commits. A flag still decides for one run. Each setting has one owner, and the owner decides whose value wins when the repository and the operator disagree.

The engine reads the repository's file as it is at the base of the change, never from the change. Thus a change cannot configure its own review. This is important because agents write most changes, and an agent can edit the file in the change that it writes. The values that a run uses, and the origin of each value, go on the ledger before the first worker. The report names each changed path that a setting left out. It also names each place where the run did not follow the policy of the repository.

The gates of this repository typed some things by hand: a branch range, a list of paths that leaves out `dist/` and the golden fixtures, the check flags, and a budget. With the repository's file in place, all of this becomes `review --branch --fix`. The skill gives these flags when the user asks it to review and fix their branch. On the gates of other repositories, the author prepared `PATH` by hand. That becomes one line of the clone's file. With no file at all, a run does what it does today.

The proposal builds the surface and the settings for the 12 needs that a real run or a current flag shows (R12). The catalog report, [`2026-10-16-preferences-and-policies.md`](../reports/2026-10-16-preferences-and-policies.md), imagines 90 preferences and policies from 14 kinds of user, and it gives each a home. Each other setting in the report fits this surface with no change to its rules. The proposal builds each one only when a run or a user shows its need.

## Problem

### A repository cannot speak to the engine

All that a run can know comes from the command line or from the role policy, `roles/policy.json`. The role policy is a part of the engine. It holds the defaults of the values that an operator can care about: the models, the run budget, the concurrency and the per-check timeout. It also says if the reviewer's own rules count, and which Codex sandbox applies on Windows.

Beside these values, the role policy holds values that only the developers of the engine must change. These are the tier, effort, per-worker budget and timeout of each role, and the fixer batch size. The only way to change the role policy is `--roles <dir>`, which replaces all role prompts with it. Thus each operator must know and type what a repository needs from each review.

### The gates show what that costs

Three gates of this repository record their command in their Verification section. The gate of the decision step, on 2026-10-08, typed `--from origin/main --to HEAD --merge-base` and `--budget-usd 120`. It listed each changed path outside `dist/` and the golden fixture as a `--path`. It named three checks by flag, and it dropped the build.

The gate of fix pass continuation, on 2026-10-11, typed the same kind of range from a named commit, and the same kind of path list. It also typed `--budget-usd 100`, and it named three checks by flag. The gate of the edits field, on 2026-10-16, listed the changed paths outside `dist/`, the proposals and the fixtures. It named all four checks.

The gates list the paths one by one, because `--path` can only include, and the build makes `dist/` and the fixtures. The gates name the checks on the invocation that plans them, because the check flags count only there. A run that resumes before that point needs the flags again. A fix run of this repository at the default budget of 60 USD stopped before its repair (#48).

The gates on other repositories added the shell. For click, the author put `.venv\Scripts` on `PATH`, so that `python -m pytest` resolved. For prek, the author put a `python3` before the Windows Store alias, because its tests run hooks that call it. The author set each of these by hand, before the engine started, and the ledger does not record them.

### The skill decides in prose

With no instruction about scope, both skills tell the model of the host to "use `--worktree` when `git status` shows changes and `--last-commit` otherwise". This is a rule that the engine can apply. But it is in two prompts, and no test checks it. On a clean feature branch, the rule reviews only the last commit. But each recorded gate reviewed a branch.

### Other users need more, and they disagree

The catalog report lists what a contributor, a user who watches cost, a CI job, an author agent, an organization and others want to set. A repository and an operator disagree in a pattern. For the rules and facts of the repository, the repository must win. For the money and taste of the operator, the operator must win. For the operator's machine, the repository must have no say. And because agents write most changes, a setting that the engine reads from the change lets the change make its own review smaller.

## Goals

When this proposal is done, a repository states its review policy one time, in the repository, and each run by each operator applies it. An operator states their usual preferences one time. They do not type them again on each run or each resume.

A run with no file and no new flag reviews, records and plans exactly what it does today. Thus a person who ignores the surface does not pay for it. A run that uses the surface records each value and its origin before its first worker. Its report says what a setting left out, and where the run did not follow the policy of the repository. A change cannot change the settings of its own review.

Each preference of the catalog has a named home. Thus a later setting goes into a list, and the rules of the surface do not change. And the skills hold no default that the engine can decide.

## Non-Goals

### Settings that no run showed a need for

This proposal does not build profiles or built-in depths. It does not build constraints, the managed file of an organization, protected paths or settings for the angles. It also does not build the shape of commits, output formats, progress or notifications. And it does not build the reader's language, a package for CI, or the surface for answers.

Each of these has a home in the design, and a row in the catalog that says what can show its need. Principle 11 asks the same of recovery: build when a run shows the need. A profile changes what the review finds. Thus a profile must have a measurement on the replay corpus before it ships (principle 10).

### Rules that need a judgment

Three examples are what counts as a public interface, where the repository states its conventions, and the style of a commit message. These rules stay in the convention sources that the surveyor finds and the decider reads. A setting is a second and weaker place to state such a rule (PD1).

### The configuration of the hosts

The proposal does not use the plugin options of Claude Code or the `config.toml` of Codex. Each serves only one host, neither gets to the ledger, and neither can hold the policy of a repository. PD8 gives the details.

### The internals of the role policy

The tier, effort, per-worker budget and timeout of each role, and the fixer batch size, stay the engine's own values. Only its developers change them, and they measure each change on the replay corpus first. `--roles` stays their tool for this.

### Where the report is written, and what stdout prints

All users want a report that a person can open without knowledge of the evidence store. Thus it is engine behavior, and not a setting. It also changes the line that both skills read from stdout, and that change needs its own review.

It belongs with the change that reorders the report, as principle 5 of the vision note asks. With that change, a person reads the core, the questions, the departures and what was not examined first. That change also decides what a run prints when it ends (the catalog's F6 and F9).

### Who can start a review

This proposal does not change who can start a review. Today, only a person can start one, and the skills keep this rule. A review that the author agent starts is a separate question, and it is not a part of the configuration framework.

### A security boundary against the operator

A setting keeps an honest operator and an honest repository inside the policy, and it makes each value visible. It does not stop an operator who edits their own files or the engine. But it does stop a change that tries to configure its own review (R4).

## Requirements

### R1: No file, no change

With no configuration file and no new flag, a run does what the engine at the base of this change does. It pins the same values: the models, the roles, the concurrency, the run budget, the per-check timeout and the batch size. It also pins the same value for the reviewer's own rules, and the same Codex sandbox. It captures the same scope and plans the same checks. Its report gets only the header line of R7, and its stdout does not change. Thus an operator who never writes a file sees no other difference.

### R2: Four files

The engine reads up to four configuration files. Each file is optional, and each is in TOML with `schema = 1`.

The repository's file is `.deep-review/config.toml` at the root of the repository. The engine reads it as the base of the change holds it (R4). The operator's file is `deep-review/config.toml` in the configuration directory of the operator. On Windows, this directory is `%APPDATA%`. On other systems, it is `$XDG_CONFIG_HOME`, or `~/.config` if that variable has no value.

The clone's file is `deep-review.toml` in the git common directory of the clone. No commit holds it, and all worktrees of the clone share it. The invocation file is the file that `--config` names for one run (R13).

### R3: One owner for each setting, and its order

Each setting has exactly one owner, and the owner sets the order of the layers. A repository-first setting holds a rule or a fact of the repository, such as a check command. In its order, the repository's file comes after the operator's file. Thus the general preference of the operator only fills a gap that the repository leaves.

An operator-first setting holds the means or the taste of the operator, such as the budget or the models. In its order, the operator's file comes after the repository's file. Thus the value of the repository is only a suggestion.

An operator-only setting holds a fact of the operator's machine. Examples are the executable of the runtime, and the directory of a tool that one clone uses. It can also hold a value that chooses the change itself. The repository's file cannot set it at all. In each order, the clone's file, the invocation file and the flags come last, in that sequence. The table gives each order, from the lowest layer to the highest.

| Owner | Order, lowest first |
|---|---|
| repository-first | default, operator's file, repository's file, clone's file, invocation file, flag |
| operator-first | default, repository's file, operator's file, clone's file, invocation file, flag |
| operator-only | default, operator's file, clone's file, invocation file, flag |

The two settings that choose the change, `scope.default` and `review.base`, are operator-only for a special reason. The engine reads the repository's file at the base of the change (R4), and these two settings decide that base. If the file can set them, they choose the revision that the engine reads them at. Then a change can move its own base. When a layer gives a list, that list replaces the list of each lower layer completely.

### R4: The engine reads the repository's file at the base

The engine reads the repository's file from the commit that the change starts from. For `--worktree`, that commit is HEAD. For `--last-commit`, it is the parent of HEAD. For `--ref`, it is the ref. For a range, it is `--from`, or its merge base with HEAD under `--merge-base`. A root commit has no parent, so its review reads no repository file.

An edit to the file inside the reviewed change does not apply to that review. The run says this on stderr and in the report, and it names the file. The edit applies from the first change that starts from a commit with the edit.

### R5: A file that the engine cannot read refuses the run

A file that the engine cannot read refuses the run before the engine creates the run. The engine cannot read a file that is not valid TOML or that has no `schema`. It cannot read a file with a `schema` that this engine does not know. It also cannot read a file that sets a setting that its layer cannot set, or that gives a value of the wrong kind. The command exits with 2, and it names the file, the setting and the action on stderr.

The layer decides what happens to a setting that the engine does not know. The repository's file and the invocation file are for this review. Thus an unknown name in them is a mistake or a setting of a newer engine, and it refuses the run. The operator's file and the clone's file go across machines and engine versions. Thus the engine ignores an unknown name in them, with a line on stderr, and the report lists it.

When the repository's file refuses the run, `--no-repository-config` runs without it. The report then says that the run did not apply the policy of the repository.

### R6: Recorded before the first worker

Before its first worker, a new run records the value of each setting that changes what the run reviews, runs, decides, edits or commits. With each value, it records the layer that the value came from. For each file that it read, it records the layer, the path and the content hash. For the repository's file, it also records the commit that it read the file at.

A resumed run, its continuation into the fix pass, and an answer pass use these recorded values. If a file changed after that, or if the engine cannot read it now, the engine names it on stderr and does not apply it. This does not stop the run. The concurrency and the run budget stay as they are today: limits that an invocation can change by flag, which the run records when it does. A file that the engine read at creation does not change them on a resume.

### R7: The report and `status` say where a setting acted

The header of the report names the files that the run read, each with its layer. The report has a part that lists what the run did not examine. That part also names the patterns of `scope.exclude` and the changed paths that they left out. It names each check kind that did not run, with the setting or the flag that dropped it.

The same part names each repository setting that the run did not follow, with the value that the run used and its layer. It says if the run skipped the repository's file (R5), or if the change edited it (R4). And it lists each ignored setting. `status` prints the same lines. A run whose values are all defaults adds only the header line.

### R8: `--branch`

`--branch` reviews the change from the merge base of the base branch and HEAD to HEAD. This is what `--from <base> --to HEAD --merge-base` does today. The base branch is the setting `review.base`, and `--base <rev>` sets it for one run. If neither gives the base, the base is the branch that `origin/HEAD` names, if the clone has that ref. If the clone does not have it, the engine refuses the run, and it names the setting and the flag.

### R9: The default scope is the engine's

With no scope flag, the setting `scope.default` chooses the scope. Its values are `worktree`, `last-commit`, `branch` and `auto`. `auto` is the default, and it applies the rule that the skills apply today. That rule reviews the uncommitted change if the tree has changes, and the last commit if it has none (PD9).

### R10: Paths left out

The setting `scope.exclude` lists glob patterns. A changed path that matches one of them is not part of the reviewed change. No worker gets such a path as a changed path, and the report gives no finding on it as a part of the change. A pattern that matches nothing is not an error, because the same policy applies to all changes.

If the patterns leave out all the changed paths of a `--path`, the engine refuses the run. The refusal names the setting and its patterns. If a change has no path left to review, the engine refuses it before it creates the run. If the patterns left out all the paths, the refusal names the setting. Today, an empty change starts a run with nothing to review. The engine refuses an empty change in the same way.

### R11: Checks and tools from settings

The setting `checks.<kind>` gives the command of a kind, or `false` for no command. The kinds are `build`, `typecheck`, `lint` and `test`. The setting settles the kind as `--check` and `--no-check` settle it today. Thus the survey gets no question about that kind, and a resumed run needs no flag again. The setting `checks.timeout_minutes` is how long one check can run.

The setting `tools.path` lists directories that the engine puts first on `PATH` for each check and each worker. Thus a fixer that runs the tests finds the same tools that the check will run. The surveyor that looks for a tool finds them too. The directories are facts of the operator's machine, such as a version of node that only one repository uses. Thus `tools.path` is operator-only. An operator usually sets it in the clone's file, and a relative directory is relative to the root of the worktree.

### R12: The settings that this proposal builds

This proposal builds the twelve settings in the table, and no other settings. Each current flag keeps what it does, and it becomes the flag layer of its setting.

| Setting | Owner | Default | Replaces |
|---|---|---|---|
| `review.base` | operator-only | `origin/HEAD` | the range typed by hand |
| `scope.default` | operator-only | `auto` | the skills' prose rule |
| `scope.exclude` | repository-first | none | `--path` lists of everything else |
| `checks.build`, `.typecheck`, `.lint`, `.test` | repository-first | the survey decides | `--check`, `--no-check` on every planning invocation |
| `tools.path` | operator-only | none | `PATH` prepared by hand |
| `checks.timeout_minutes` | repository-first | 20 | the role policy's `checks.timeoutMs` |
| `conventions.user_rules` | repository-first | `judge` | the role policy's `survey.userRules` |
| `budget.usd` | operator-first | 60 on Claude Code, none on Codex | the role policy's `runBudgetUsd`; `--budget-usd` stays |
| `run.concurrency` | operator-only | 4 | the role policy's `concurrency`; `--concurrency` stays |
| `runtimes.<name>.strong`, `.fast` | operator-first | the role policy's models | `--strong-model`, `--fast-model`, which stay |
| `runtimes.<name>.executable`, `.args` | operator-only | found on `PATH`; no arguments | `--executable`, `--executable-arg`, which stay |
| `runtimes.codex.windows_sandbox` | operator-only | `none` | the role policy's `windowsSandbox`; `--codex-windows-sandbox` stays |

### R13: The overrides of one run

`--set <setting>=<value>` sets a setting at the flag layer for one run. The value has the form that it has in a file, or it is bare text for a string. An operator can give the flag more than one time. `--config
<file>` adds the invocation file for one run.

### R14: The configuration, shown without a run

`deep-review config show` prints the configuration that a run will use, but it starts no run. It takes the same scope and runtime flags as `review`. It prints the value of each setting with its origin. It also prints the files that the engine reads, the repository settings that the run will not follow, and the ignored settings. It prints these as text, or as data with `--json`. It creates no run and starts no worker.

`config explain [<setting>]` prints the owner, the default and the purpose of each setting. `config validate [<file>]` checks one file for its layer. With no file, it checks the `.deep-review/config.toml` of the working tree. Thus an author can check a policy before the commit.

`config init` with `--repository`, `--operator` or `--clone` writes the file of that layer. The file has `schema = 1`, and each setting is in it as a comment, at its default. The command refuses to write over a file that exists.

### R15: The skills

Both skills give a scope flag only when the user names a scope. They give `--branch` when the user names their branch. If not, they leave the scope to the engine (R9). The user can ask how deep-review is configured, or why a run reviewed what it did. Then the skills run `config show` and relay what it prints.

The skills write the repository's file only as a change that the user asks for, as for each other edit. They never write it as a step of a review. A test keeps the two skill texts equal, except for the lines that must name their runtime.

### R16: The gate

The gate is real runs, as principle 12 asks. The first run is a fix run of the pull request of this proposal. It starts as the skill starts it, with `--branch --fix` and no other scope or check flag.

Before it runs, a `.deep-review/config.toml` goes into a commit on `main`, so that it is at the base of the change (R4). This is a small change of its own, before the gate. The engine on `main` ignores the file until this proposal merges. That file leaves out `dist/` and the golden fixtures, names the four checks and suggests the budget. The base stays `origin/HEAD` by default.

The ledger of the run must record each value with its origin. The report of the run must name what the setting left out. The second run is a Codex fix run on a repository with no file of its own. An operator file sets the Windows sandbox for this run, and a clone's file sets `tools.path` for the tools that the repository needs. Its pinned values must be equal to the values of the same command at the base of this change, except these two settings.

### R17: Older runs still open

A run that the engine recorded before this change still opens, folds and resumes under the new engine. It reads as a run whose values came from the defaults and the flags. A golden fixture of the new schema goes into a commit.

## Metrics

### What each gate typed

The gates above typed a range, a list of paths, check flags and a budget. They also typed the check flags again on each resume before the run planned the checks. With the repository's file in place, the same gate is `--branch --fix`. No flag is necessary again on a resume.

The gate of this change measured this. Before this change, a gate of this change types `--from origin/main --to HEAD --merge-base` and `--fix`. It also types 18 `--path` flags for the paths outside `dist/` and the fixtures, 4 `--check` flags and `--budget-usd 120`. That is 27 flags, and a resume before the plan of the checks needs the 4 `--check` flags again. The gate typed `--branch --fix`, and a resume needs no flag.

### What `scope.exclude` saves on `dist/`

The fixer cost report found that the reviewed diff is 58% of the prompt of a fixer. The measurement compares the change of the gate with and without `scope.exclude`. It measures the size of the reviewed patch and the tokens of the prompts of the fixers.

The gate of this change measured this. Without `scope.exclude`, the patch of this change is 2,037,532 bytes. With it, the patch is 654,786 bytes, 32% of that size. Both sizes are larger than the 256 KiB that a prompt carries. Thus no prompt holds the patch, and the prompts of the 24 fixers were 40,532 to 60,411 bytes. A worker reads the patch file when it needs the patch.

A worker that reads the full patch reads 1,382,746 bytes less. At approximately 4 bytes for each token, that is approximately 345,000 tokens less. The token figure is an estimate, not a measurement.

### Parity

The pinned configuration of a run with no file is equal to the configuration that the engine at the base of this change pins. The tests show this, and the Codex run of R16 shows it too.

The Codex run of the gate showed this. Each field of `review.configured@5` from the engine of `212404d` is equal to the same field of `review.configured@6` from this engine, for the same command. The design's Verification gives the details.

## Product Decisions

### PD1: Settings hold only what needs no judgment

A setting holds only what the engine can apply without a judgment of the code. Each item that a model must judge stays a rule in a convention source.

One alternative was to read the full policy from `AGENTS.md` through the surveyor. This fails, because the scope, the budget, the models and the sandbox act before the surveyor runs. Also, a limit on the workers cannot come from what a worker reads. The other alternative was settings for conventions too, such as a list of the files that hold the rules. That is a discovery rule, and the repository survey decided against it in its PD5. Also, a second place to state a rule is a weaker place.

### PD2: The twelve shown needs, and no more

The proposal builds the surface and the settings for the twelve needs that runs showed. The proposal builds the other settings only when a run shows their need.

The proposal does not build all 46 settings of the catalog, for three reasons. First, the ledger must keep each setting across versions. Second, a depth that nobody measured can make the gate weaker, and nobody sees it. Third, principle 11 rejects work for failures that no run showed.

The proof of concept built recovery for failures that never occurred, and it missed the failures that did occur. When a run or a user shows a need, the proposal for that setting can start. The catalog already names each setting and its owner.

### PD3: Three owners, each with its own order

Each setting has one of three owners, and each owner has its own order.

The proposal rejects one order for all settings, with the repository above the operator, as in git and most editors. With that order, a repository can spend the money of a contributor above the budget that the contributor set. It can also choose the executable that runs with the credentials of the operator.

The proposal also rejects the operator above the repository for all settings. With that order, a general preference of an operator replaces the check command of a repository. And the proposal rejects an order that each setting chooses freely, because then a reader cannot predict the winner from the owner.

### PD4: The engine reads the repository's file at the base of the change

The proposal rejects a read from the working tree or from the head of the change. With such a read, the change under review configures its own review. An agent writes most changes, and it can edit the file in the same change. Then the change can leave its own files out, drop a check, or replace a check command with one that always passes.

The read at the base stops these edits of the policy. It does not stop an edit of what a check command runs, such as the test script in `package.json`. Such an edit is in the reviewed diff, and the risks below record it.

The proposal also rejects the base for some settings and the head for other settings, which gives two answers to one question.

This decision has two costs. A repository that adopts the file sees it apply only from the next change, and R4 makes the run say so. Also, the branch that a change starts from becomes a setting of the operator, not of the repository (R3). Its default is `origin/HEAD`. Thus a repository whose changes start from another line, as under git-flow, cannot state that line for its contributors.

### PD5: TOML

The files are in TOML. The proposal rejects JSON, because JSON takes no comments. People read and maintain a policy, and its reasons must be beside it. The proposal rejects YAML, because its implicit types and its indentation make it easy to read a file incorrectly without a sign. The cost is a TOML parser in the engine bundle. It is the only dependency beside `zod` (design TD3).

### PD6: A broken repository file refuses the run, with one escape

If the engine cannot read the repository's file, it refuses the run. One explicit flag gets past this refusal. The proposal rejects a run on the defaults with a notice, because a CI gate then runs weaker and does not fail. The escape is `--no-repository-config`. With it, the report says that the run did not apply the policy. Thus a repository whose base holds a broken file can still review the change that repairs it.

### PD7: A difference from the policy is reported, but it is not a departure

When a run does not follow the policy of the repository, the report says so. But it does not call this a departure. In the vision note, a departure is a decision that deep-review makes against a rule, on a stated fact. An operator who gives another check command makes their own choice. The report shows that choice with the value and its origin, where it lists what the run did not examine (principle 8). Thus a reader sees the choice beside the paths that the run left out.

### PD8: No host-native configuration

The proposal rejects the plugin options of Claude Code and the configuration file of Codex. Each serves one host, and neither gets to the ledger. Also, a value that a host and the engine share has two places to look.

Neither can hold the policy of a repository. Claude Code keeps plugin options for each user, with no project scope. Codex lets a user only turn a skill on or off. The files of the engine are the one surface, the same under both hosts.

### PD9: `auto` keeps today's rule

`auto` reviews the uncommitted change when the tree has changes, and the last commit when it has none. An operator who wants the branch sets `branch` as the value of `scope.default`, or gives `--branch`.

The proposal rejects a branch-aware `auto`. On a clean tree whose HEAD has commits after its base, such an `auto` reviews the branch. Each recorded gate reviewed a branch, so the alternative agrees with the evidence. But it changes what a run with no instruction reviews, and R1 forbids that for a run with no file. Revisit this decision when operators other than the author show which value they set.

## Against the vision note

### Principle 2, record before action

Each value that changes what a run reviews, runs or edits goes on the ledger with its origin before the first worker (R6). Thus a reader of the ledger can see later which settings gave the run its shape. And a resumed run cannot change them.

### Principle 3, rules can be wrong, and a departure is reported

This principle is about the departures of deep-review, and this proposal does not change them. A choice of the operator against the policy of the repository is not a departure (PD7). The report shows it beside what the run did not examine.

### Principle 5, the core, the questions and the departures go to the person

No setting can remove the questions, the departures or what the run did not examine from the report. The catalog refuses such a setting in its row F1, and the registry has none.

### Principle 6, easy to understand, with little context

`config show` gives the origin of each value in one line. Thus a person who does not know the layers can still see why a run used a value.

### Principle 7, nothing waits for a person

No setting makes a run wait for a person. A file that the engine cannot read refuses the run before the run exists (R5). This is a refusal with its action, and not a question. A CI job then fails, and the escape flag lets the author review the repair.

### Principle 8, say what was not examined

Each path that a setting left out, and each check that a setting dropped, is in the report (R7). Thus no setting can make a review smaller without a sign.

### Principle 9, the rules grow from the answers

A setting is one form of a rule from a person, for rules that the engine applies without a judgment. This proposal does not write settings from answers. But an answer can name a mechanical rule, such as a path that no fixer can edit. Such an answer has a setting that it can become later.

### Principle 11, recovery without a person

The proposal builds only settings that a run or a current flag shows a need for (PD2), as the principle asks of recovery. The catalog keeps the other settings, each with what can show its need.

### Principle 12, a real run is the gate

R16 is real runs, one on this repository and one on another repository.

### The proposal departs from no principle

The proposal names one tension. Principle 4 has deep-review decide all that the repository answers, but a setting is a decision that a person makes in advance. A setting decides only what the engine cannot judge alone, such as how much to spend or which branch is the base. Thus the two do not compete.

## Risks

### An engine older than this change ignores the repository's file

Operators on different versions then run under different policies until they all update. The proposal accepts this, because no earlier engine reads the file at all. From `schema = 1` on, a file with a newer schema refuses the run on an older engine (R5). Thus the gap does not occur again.

### An operator's file can narrow their own run

An operator can leave out paths or drop a check in their own files. The proposal accepts this. It is their run on their machine, the report names each such value (R7), and a CI job has no operator file.

### The read at the base surprises a first adopter

The repository's file does not apply to the change that adds it. The proposal accepts this, because it is the point of PD4. The run says why on stderr and in the report.

### The repository's check commands run on the operator's machine

This is the same as today, when the survey chooses the commands and nobody sees them first. The repository's file makes them visible, and people review them as they review other code.

### A change can still change what a check runs

The read at the base keeps the check commands of the policy. But a change can edit the script that a command runs, such as the test script in `package.json` or a target of a makefile. The proposal accepts this. The edit is in the reviewed diff, and a finder can report it as it reports each other change.

### A path left out gets no review

A change can put code under a path that `scope.exclude` leaves out, and no worker reviews that code. The proposal accepts this, because the repository chose the patterns, and the report lists each path that they left out (R7). In this repository, `npm run verify` also proves that `dist/` is what the build makes from the sources.

### One more file to keep true

A wrong value in a file, or a value that is out of date, costs a run. `config validate` and `config show` show such a value before a run spends money on it.
