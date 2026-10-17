# Implementation plan: configuration

This is the plan of the work for the [requirements](2026-10-16-configuration.requirements.md) and the [design](2026-10-16-configuration.design.md). It stays in the pull request while the work continues, and the last commit of the series deletes it. It is not a part of the proposal, and it records no decision. The proposal records the decisions.

Each step names each file that it changes and the command that proves it. The steps run in order, and the checks of a step pass before the next step starts. `npm run check` passes at each commit, and `npm run verify` passes at each head that is pushed, as `AGENTS.md` says.

The proposal can change during the work. If the code needs a different design, a commit of its own amends the proposal before the code commit. Thus the pull request shows each change of the proposal beside the code that needed it.

## 0. The branch

The pull request holds the proposal, this plan and the implementation. The branch is `feat/configuration`, and its name is set before the first push, because a rename of a pushed branch closes its pull request.

```sh
git branch -m docs/configuration-proposal feat/configuration
```

## 1. The settings and their files (R2, R3, R5, R12)

The first commit adds the registry and the loader. No command uses them yet, so the engine does not change.

- `package.json` and `package-lock.json`: add `smol-toml` at exactly 1.9.0 (TD3). That release is older than two weeks, and it has no dependency of its own.
- `src/config/settings.ts`, new: the registry of R12, with the fields of the table in the design. It gives each setting its owner, its schema and its default. It reads a default from the role policy where the role policy holds it (TD5). It gives the schema of each layer from the owners.
- `src/config/files.ts`, new: the path of each layer, and the read of each file. It reads the repository's file at a commit with `git ls-tree` and `git cat-file` through `runGitSync`. It refuses a file larger than 64 KiB, parses the TOML, and flattens the tables to dotted names. It does the four checks of the design in order, and it collects all failures into one `ReviewRefusedError`.
- `test/config/settings.test.ts`, new: each setting of R12 is in the registry with its owner. The schema of the repository's layer refuses each operator-only setting. The defaults are equal to the values of the role policy.
- `test/config/files.test.ts`, new: the operator's path under `APPDATA`, under an absolute and a relative `XDG_CONFIG_HOME`, and under `~/.config`. The clone's file is in the git common directory, and two worktrees of one clone share it. The repository's file is read at a commit, and it is absent at the empty tree. The test also covers invalid TOML, no `schema`, `schema = 2` and a wrong type. It covers an unknown name in each layer, all problems in one refusal, and a file larger than 64 KiB.

```sh
node --import ./test/setup.ts --test "test/config/*.test.ts"
npm run check
git commit -m "feat(config): Declare the settings and read their files"
```

## 2. The resolution in two passes (R3, R8, R9, R13)

- `src/config/resolve.ts`, new: the order of the layers for each owner (R3). It makes the flag layer from the dedicated flags and from `--set`, as the flag table of the design shows (TD9). Pass 1 resolves `scope.default` and `review.base`, with the branch that `origin/HEAD` names as the default base. Pass 2 resolves all other settings. The result is the `ResolvedSettings` value of the design, and `settingOf` reads one setting from it.
- `src/scope/capture.ts`: take `scopeBase` out of `chooseMode`. It gives the base commit of a request, and it lists no paths.
- `test/config/resolve.test.ts`, new: a table-driven test over each owner and each pair of layers. It also covers a list that replaces a lower list, and the operator's file under a repository-first setting. It gives `--set` a number, `false`, a list, a bare string and a value with an `=` in it. It refuses two flags for one setting. It covers `--branch` with `origin/HEAD` set, without it, and with `--base`. It covers each value of `scope.default`.
- `test/scope/capture.test.ts`: `scopeBase` gives the same base as `chooseMode` for each mode.

```sh
node --import ./test/setup.ts --test test/config/resolve.test.ts test/scope/capture.test.ts
npm run check
git commit -m "feat(config): Resolve the settings in two passes"
```

## 3. The record (R6, R17)

- `src/checkpoint/events.ts`: `review.configured@6`, `scope.captured@2`, `checks.planned@3` and `fix.pinned@2`, as the event table of the design gives them. Add each version to the registry.
- `src/checkpoint/review-fold.ts`, `src/checkpoint/fold.ts` and `src/checkpoint/fix-fold.ts`: a reducer for each new version. A configuration of version 5 or older reads as defaults and flags.
- `scripts/golden-checkpoint.ts`: one more run that writes the four new versions.
- `test/fixtures/checkpoints/schema-1-12`, new: the golden fixture that the script writes.
- `test/checkpoint/review-fold.test.ts`, `test/checkpoint/fold.test.ts` and `test/checkpoint/fix-fold.test.ts`: each new version folds. The block refuses a setting name that its version does not record. A configuration of version 5 reads through `settingOf` as defaults and flags.
- `test/checkpoint/golden.test.ts` does not change. It opens and folds each fixture, and `schema-1-12` is one of them.

```sh
npm run golden -- --output test/fixtures/checkpoints/schema-1-12
npm run check
git commit -m "feat(checkpoint): Record the resolved settings with their origins"
```

## 4. Paths left out (R10)

- `src/scope/git.ts`: `diffNameStatus`, `untrackedEntries` and the diff that `buildPatch` reads take the patterns as `:(exclude,glob)<pattern>`. A second list of the changed paths uses `--no-renames`.
- `src/scope/capture.ts`: the request gets `exclude`. The capture makes the two lists, and it records the `excluded` difference. `requirePathsMatched` checks against both lists, and `maxScopeFiles` counts after the exclusion. The capture refuses a change with no path left, and an empty change. It writes `scope.captured@2`.
- `test/scope/capture.test.ts`: tracked, untracked, deleted and renamed paths left out. The rename from `dist/a.js` to `src/a.js` shows as an addition, and `dist/a.js` is in `excluded`. No excluded file is in the patch. The test refuses a `--path` with changes only under a pattern, and a pattern with a `:` at the start or a `..`. It counts `maxScopeFiles` after the exclusion. It refuses the empty change, and the change that the exclusion empties.

```sh
node --import ./test/setup.ts --test test/scope/capture.test.ts
npm run check
git commit -m "feat(scope): Leave out the paths that scope.exclude names"
```

## 5. The run (R1, R4, R6, R11)

- `src/cli.ts`: the flags `--branch`, `--base`, `--set`, `--config` and `--no-repository-config` in `options`, and in the flags that `review` permits. Pass 1 runs inside the `request` callback of `ScopeSource`. The settings go to `runReview`.
- `src/review/controller.ts`: in `openRun`, pass 2 runs where `resolvePolicy` runs today. The controller lists the paths of the change with the exclusions, and it refuses a change with no path left before `createRun`. It appends `review.configured@6`. `captureScope` refuses if the base moved after the read of the repository's file. `resumePinned` compares the files with the record, and it names each difference on stderr. `continuationOf` appends `fix.pinned@2`.
- `src/review/policy.ts`: the defaults layer comes from the role policy. `resolvePolicy` takes the resolved values for the models, the concurrency, the run budget, the check timeout, the user rules and the Codex sandbox.
- `src/review/checks/discover.ts`: `CheckFlags` gets the layer of each settled kind.
- `src/review/survey.ts`: `resolveChecks` gives the origin `setting` with its layer, for `checks.planned@3`.
- `src/runtime/environment.ts`, `src/runtime/launcher.ts` and `src/review/checks/run.ts`: the directories of `tools.path` go first on `PATH` of each worker and each check. The helpers of `environment.ts` treat `Path` and `PATH` as one variable.
- `test/review/controller.test.ts`: a run with no file pins the values of the base (R1). A run under each layer records its values and their origins. A file that the change edits does not apply, and the run says so. A resume with changed files, and with a file that the engine cannot read. The budget and the concurrency change only by flag.
- `test/review/continuation.test.ts`: `fix.pinned@2` with the flags of the continuation.
- `test/review/survey.test.ts`: a kind that a setting settles gets no question, and a run that resumes before the plan of its checks needs no flag.
- `test/review/policy.test.ts`: the defaults layer is equal to the role policy.
- `test/runtime/environment.test.ts` and `test/runtime/launcher.test.ts`: `tools.path` comes first on `PATH` for a check and a worker. On Windows, `Path` and `PATH` stay one variable.
- `test/cli.test.ts`: the new flags, and their usage errors.

```sh
npm run check
git commit -m "feat(review): Configure a run from the settings"
```

## 6. The report and status (R7)

- `src/review/report.ts`: the `Settings:` line of the header, and the new lines of `limitations()`.
- `src/review/status.ts`: the same lines, from the same functions.
- `test/review/report.test.ts` and `test/review/status.test.ts`: the cases of R7 in the test strategy of the design.

```sh
npm run check
git commit -m "feat(review): Report where a setting acted"
```

## 7. The config command (R14)

- `src/cli.ts`: the command `config` with the subcommands `show`, `explain`, `validate` and `init`, and the usage text. Today the command line refuses a second positional argument, so `config` accepts one subcommand.
- `src/config/command.ts`, new: the text and the JSON of each subcommand.
- `test/config/command.test.ts`, new: the test runs `show` as text and as JSON on a fixture repository. It checks that `explain` lists each entry of the registry. It runs `validate` on a good file and a bad file for each layer. It runs `init` for each layer, and it checks the refusal for a file that exists. The file that `init` writes passes `validate`.

```sh
npm run check
git commit -m "feat(cli): Show, explain, check and start the configuration"
```

## 8. The skills (R15)

- `skill/claude/skills/deep-review/SKILL.md` and `skill/codex/SKILL.md`: step 1, the new paragraph about the configuration, and the wait in Codex, as the design says. The bytes of a skill are the product. Write each new sentence one time, and do not reflow the other text.
- `test/skills.test.ts`: the test that keeps the two texts equal, except for the lines of each runtime. A test of step 1 against the scope flags that it names.

```sh
npm run check
git commit -m "docs(skill): Leave the scope to the engine and explain its configuration"
```

## 9. The README

- `README.md`: a "Configuration" section after "The repository survey", as the design says.

```sh
npm run check
git commit -m "docs(readme): Describe the configuration"
```

## 10. The self-review and the build

- Read each hunk and its function, as the global rules ask. For each deleted line, name where the new code keeps its rule: the prose rule of the skills is now `auto`, the check flags are now one layer, and `PolicyFlags` is now the flag layer.
- Search for each caller of `resolvePolicy`, `scopeRequestOf`, `chooseMode`, `captureScope` and `CheckFlags`, and for each reader of the four changed events.
- Run the STE checker on each changed document.

```sh
npm run build
npm run verify
git commit -m "chore(dist): Rebuild the engine for the configuration"
```

## 11. The pull request

- Push the branch, and open the pull request as a draft until the gate passes.
- The title is `feat(config): Configure a run from repository and operator files`.
- The body has the parts Motivation, Modifications and Result, for a reader who does not know the repository. Its lines are not wrapped, and it names no local path. It uses the figures of the proposal after a render check.
- CI on Windows, macOS and Linux must pass.

```sh
git push -u origin feat/configuration
gh pr create --draft --title "feat(config): Configure a run from repository and operator files" --body-file <body file>
```

## 12. The policy of this repository on main (R16)

The gate reads the repository's file at the base of the change (R4). Thus the file goes to `main` before the gate, in a separate small pull request. The engine on `main` ignores the file until this pull request merges.

- `.deep-review/config.toml` has `schema = 1`, and `scope.exclude` with `dist/**` and `test/fixtures/checkpoints/**`. It names the four checks `npm run build`, `npm run typecheck`, `npm run lint` and `npm test`, and it sets `budget.usd = 120`.
- Before the commit, `config validate` of the engine on `feat/configuration` checks the file.
- The branch is `chore/review-policy`, and the commit is `chore: Add the review policy of this repository`. It merges by fast-forward when the author says so.
- Then `feat/configuration` rebases onto `main`, and the push uses `--force-with-lease`. CI must pass again.

## 13. The gate, first run: this pull request on Claude Code (R16)

- Copy `dist/claude` of the head to an engine directory outside the worktree, because the build check rewrites `dist/` in the worktree.
- Make a separate worktree at the head of the pull request, on a local branch `gate/configuration`, and run `npm ci` in it.
- Run the command of the skill with the engine copy, with no other flag: `node <engine copy>/engine/main.mjs review --runtime claude --branch --fix`.
- Expect these results. The stderr names the repository's file at the base. The checks come from that file. `review.configured@6` records each value with its origin. The report names the paths that `scope.exclude` left out.
- After the run, `deep-review commit` makes the commits. The per-commit check of the earlier gates runs `npm run check` on each new commit alone. The ledger audit of the claims runs on a copy of the ledger.
- The commits of the gate go to the pull request through a stacked pull request into `feat/configuration`, which merges by fast-forward after CI. If only some commits apply, a cherry-pick takes them. The last commit rebuilds `dist/`.
- Known risks: a session limit voids a run (#40), so back up the tree, reset it, and run again. A drift block names the files: restore them from the artifacts that it names, and resume. The budget of 120 USD comes from the policy file, and a fix run that meets its budget cannot continue (#48).

## 14. The gate, second run: Codex on another repository (R16)

- Use a clone of a repository with no `.deep-review/config.toml`. The clone of prek from the answers gate fits, because its tests need a `python3` ahead of the Windows Store alias.
- The operator's file sets `runtimes.codex.windows_sandbox = "none"`. This is the default value, so the run behaves as before, but the record shows the origin `operator`.
- The clone's file sets `tools.path` to the directory of that `python3`. Nobody prepares `PATH` by hand.
- Run the Codex engine copy with `--fix` and the range of the chosen change.
- Expect these results. The pinned values are equal to the values that `resolvePolicy` gives at the base for the same command, except the two settings. A check and a fixer find `python3` through `tools.path`.

## 15. The verification, and this plan out

- The Verification section of the design records the implementation and the gate: the commits, `npm run check`, `npm run verify`, CI, and the two runs with their spend and their findings.
- The Metrics of the requirements record two measurements: the flags of a gate before and after the change, and the size of the reviewed patch with and without `scope.exclude`. Both are measured on the change of this pull request. The tokens of the fixer prompts are an estimate from those bytes, and the record says so.
- The same commit deletes this plan.

```sh
git rm docs/changes/2026-10-16-configuration.plan.md
git commit -m "docs(changes): Record the verification of the configuration"
```

## 16. The merge

- The merge happens only when the author says so. It fast-forwards `main` to the head of the pull request with a push, so that the commits keep their hashes. The merge button of GitHub rewrites them.
- After the merge, update the installed Claude Code plugin, and replace the Codex skill with `dist/codex`.

```sh
git push origin feat/configuration:main
```
