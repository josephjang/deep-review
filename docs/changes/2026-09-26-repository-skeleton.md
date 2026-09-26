# Change Proposal: Repository skeleton

## Summary

Create the `deep-review` repository: a single Node package with lint,
typecheck and test gates, a build that assembles the Claude Code plugin and
the Codex skill into committed `dist/` output, a byte-identity check that
proves `dist/` is what the sources produce, and continuous integration on
Windows, macOS and Linux. The skill artifacts it ships are placeholders that
say so. No engine code, no runtime adapter and no review behavior arrive with
this change.

## Problem

The Node-driven deep review exists only as `deep-review-node`, one of five
skills in `~/projects/agent-skills`. Its engine is 7.5 thousand lines of
TypeScript at version 0.3.5 with 92 test files, and it has never produced a
review report without manual intervention: five pilot runs on the Tarkov
repository each ended in a blocker, and the last was finished by hand from
its checkpoint. The defects were concentrated at boundaries (runtime CLI,
operating system, repository layout), and the offline test suite passed while
every real run failed.

The repository around it adds cost that has nothing to do with review
quality. Its build, gate and measurement tools are PowerShell scripts, which
is why macOS qualification has been "deferred" since August. It carries five
skills, three evidence layers, and a portfolio table that no longer says
anything useful about the one skill that matters. Starting a new skill there
means inheriting all of that.

The decision is to build a new repository and adopt elements from the proof
of concept one at a time, each on its own change proposal, rather than move
the proof of concept over. This change is the first element: the ground the
rest stands on. It has to exist before any engine code can be tested, and its
shape decides what every later element pays for a build, a test run and an
install.

## Goals

- A contributor can clone the repository, run one install command and one
  check command, and get the same result on Windows and macOS.
- The installed artifacts, a Claude Code plugin and a Codex skill, are
  produced by the build from sources in this repository, and a commit that
  claims to change only where text lives can be checked mechanically.
- The repository can be added as a plugin marketplace and the plugin
  installed from it, so every later element is exercised through the real
  install path from its first commit.
- Every convention a later change must follow (commit style, documentation
  location, what never gets edited by hand) is written down where Claude
  Code and Codex read it.

## Non-Goals

- No engine code: no scope capture, checkpoint store, worker supervision or
  runtime adapter. Each is its own element with its own proposal.
- No role prompts and no mechanism for sharing skill text between the two
  runtimes. The placeholder `SKILL.md` files are written twice by hand; the
  include mechanism is decided when there is text worth sharing.
- No release process or version numbers on the plugin. Users track commits
  (D5).
- No `LICENSE`. The repository is private and single-author.
- No macOS runtime qualification. CI proves the toolchain runs there, which
  is a different claim from the engine running a review there.
- No publication to Anthropic's plugin directory.

## Requirements

- R1: `npm ci` followed by `npm run check` (lint, typecheck, test) passes on
  Windows, macOS and Linux runners under Node 26, and the test suite runs the
  TypeScript sources directly with no transpile step.
- R2: `npm run build` writes `dist/claude` (the plugin root) and `dist/codex`
  (the Codex skill directory), and `npm run verify` fails when the committed
  `dist/` differs by one byte from what the build produces. CI runs it.
- R3: `claude plugin validate .` passes for the marketplace and
  `claude plugin validate dist/claude` passes for the plugin. After
  `claude plugin marketplace add <path>` and `claude plugin install
  deep-review@deep-review`, the skill appears as `/deep-review:deep-review`
  and its text says the engine is not installed yet.
- R4: Copying `dist/codex` to `~/.agents/skills/deep-review` gives Codex a
  skill named `deep-review` whose text says the same.
- R5: `CLAUDE.md` states: conventional commits in English with no attribution
  footer; reader-facing text avoids characters people do not type by hand;
  `dist/` is build output and never edited; a behavior change carries a
  proposal under `docs/changes/`; `provisional-plan.md` is never committed.
- R6: `README.md` describes the layout, the install steps for both runtimes
  and what each check proves.
- R7: The repository exists at `github.com/josephjang/deep-review`, private,
  with the skeleton as its first commit and CI green on that commit.
- R8: `provisional-plan.md` is excluded from git locally and absent from the
  first commit.

## Decisions

- **D1: The Node floor is 26.** Node 24 was rejected. Both run TypeScript
  without a flag and both ship `node:sqlite` at the same release-candidate
  stability, so the difference is the support window (April 2029 against
  April 2028) and the fact that type stripping is stable rather than
  experimental in 26. Node 26 is still a Current release until late October
  2026; by the time this skill has users it is LTS. Revisit if a development
  dependency turns out not to support 26.

- **D2: One package, with directory boundaries.** npm workspaces from the
  start were rejected: the third runtime that would justify separate
  packages does not exist yet, and a workspace adds cross-references and
  empty packages to every step of the skeleton. Split when a runtime adapter
  actually needs to be versioned or tested apart from the engine.

- **D3: TypeScript is pinned to 6.0.3, not 7.** TypeScript 7 is the current
  release, but typescript-eslint supports only versions below 6.1, and the
  type-aware rules it provides (`no-floating-promises`,
  `no-misused-promises`) are the reason ESLint is in the toolchain. Revisit
  when a typescript-eslint release declares support for 7.

- **D4: The installed artifacts are committed under `dist/` and a
  byte-identity check guards them.** GitHub Releases archives were rejected:
  a private release asset needs an authenticated download that Claude Code
  can only do through a `headersHelper` command, and Codex has no installer
  at all, so a committed directory is the one path that works for both
  runtimes with git credentials alone. The cost is build output in history,
  which grows once the engine bundle lands; the proof of concept carried the
  same cost for months. Revisit if clone size becomes a problem.

- **D5: The plugin manifest carries no `version`; users track commits.**
  An explicit version with a bump gate, as the proof of concept did, was
  rejected: the pilot had a defect where an engine change shipped without a
  bump and every install stayed on the old copy. Claude Code documents the
  no-version form as the way to track commits, and the engine's own identity
  will be a content hash once it exists. Revisit when a release needs to be
  named in a report.

- **D6: The skill artifacts ship in the skeleton as placeholders.** Deferring
  them to the first end-to-end milestone was the recommendation and was not
  taken: shipping them now means the marketplace, the install path and both
  runtimes' skill loaders are exercised from the first commit, and every
  later element is tested through the real install instead of a fixture.
  Each placeholder says plainly that the engine is not installed, and the
  Claude skill sets `disable-model-invocation`, the Codex skill
  `allow_implicit_invocation: false`, so neither runtime starts it on its
  own.

- **D7: The plugin is named `deep-review`, the marketplace is named
  `deep-review`, and the existing installs are left alone.** A distinct
  name to avoid the proof of concept was rejected. In Claude Code the plugin
  skill is namespaced as `/deep-review:deep-review`, so it does not collide
  with the user-level `/deep-review` command that still exists in
  `~/.claude/commands`. In Codex, copying to `~/.agents/skills/deep-review`
  replaces the old skill, which remains available in the `agent-skills`
  build output if it is needed. Revisit if the two must coexist in Codex.

- **D8: npm with exact dependency pins.** pnpm and bun offer nothing this
  repository needs, and `npm ci` from `package-lock.json` is reproducible on
  every runner. Caret ranges were rejected: the installed artifact must be
  reproducible from a commit, and the byte-identity check would fail on a
  dependency drift the lockfile would otherwise hide.

- **D9: No PowerShell anywhere in the toolchain.** Everything the proof of
  concept's `.ps1` tools did (assemble, verify, gate) is a Node script here,
  so the check that runs on Windows is the check that runs on macOS. Windows
  job objects, which the proof of concept implemented with a PowerShell and
  C# asset at run time, are a runtime containment question for the adapter
  element, not a toolchain one.

- **D10: Commits carry no attribution footer.** Claude Code's default footer
  was rejected to match the author's other repositories. Conventional
  commits in English, imperative subject under 72 characters, body for the
  why.

- **D11: CI runs the same check on Windows, macOS and Linux.** Linux was
  added although no user runs the skill there: it is the cheapest runner and
  catches path and line-ending assumptions the other two share. macOS
  minutes cost ten times Linux minutes on a private repository; accepted, the
  suite is small.

- **D12: One `.node-version` file pins the Node major for both mise and CI.**
  A `mise.toml` was rejected because GitHub's `setup-node` reads
  `.node-version` and mise reads it too, so one file serves both.

## Risks

- Risk: Node 26 is a Current release for another month, and a development
  dependency may lag it. Accepted; the floor is one line in `package.json`
  and one in `.node-version`, and D1 names the revisit condition.
- Risk: pinning TypeScript below the current major means new language
  features and compiler fixes wait on typescript-eslint. Accepted; the
  type-aware lint rules are worth more to a subprocess supervisor than the
  features.
- Risk: committed `dist/` will carry a multi-megabyte engine bundle on every
  engine change once that element lands, and the history grows with it.
  Accepted; the proof of concept ran that way, and D4 names the revisit
  condition.
- Risk: the placeholder skills can be installed and invoked before they do
  anything, and a user who does so gets a skill that says it cannot run.
  Accepted; both placeholders say so in their first sentence and neither
  runtime starts them implicitly.
