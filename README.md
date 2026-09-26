# deep-review

Deep review of a change, driven by a Node engine, delivered as a Claude Code
plugin and as a Codex skill.

This repository is being built one element at a time from what the
`deep-review-node` proof of concept in `agent-skills` showed. Each element
arrives with a change proposal under `docs/changes/` that records why it is
here, what it leaves out and what was rejected. The current state is the
repository skeleton: the toolchain, the build, the install path and
continuous integration. The engine has not shipped yet, and the installed
skill says so.

## Layout

```
skill/claude/            sources of the Claude Code plugin
skill/codex/             sources of the Codex skill
dist/claude/             the plugin, built from skill/claude, committed
dist/codex/              the Codex skill, built from skill/codex, committed
.claude-plugin/          marketplace.json: this repository as a marketplace
src/                     TypeScript sources, run directly by Node
scripts/                 build entry points
test/                    node:test suites, mirroring src/
docs/changes/            change proposals, one per behavior change
AGENTS.md, CLAUDE.md     conventions every agent follows here
```

## Developing

Node 26 or newer, npm and git. `.tool-versions` pins the Node major for
mise and asdf.

```sh
npm ci
npm run check     # lint, typecheck, test
npm run build     # refresh dist/ from skill/
npm run verify    # prove dist/ matches skill/ byte for byte
```

`npm run check` runs ESLint with type-aware rules, `tsc --noEmit`, and the
`node:test` suites against the TypeScript sources directly; nothing is
transpiled. `npm run verify` assembles both artifacts into a temporary tree
and compares them with the committed `dist/`, so a commit that claims to
change only where text lives can be checked rather than trusted.
Continuous integration runs both on Windows, macOS and Linux.

Never edit `dist/` by hand. See `AGENTS.md`.

## Installing

### Claude Code

The repository is its own plugin marketplace. In a Claude Code session:

```
/plugin marketplace add josephjang/deep-review
/plugin install deep-review@deep-review
```

The skill is then `/deep-review:deep-review`. The plugin carries no version
field on purpose, so `/plugin marketplace update deep-review` follows the
latest commit. The repository is private; adding it uses the git
credentials already on the machine.

From a local checkout, the same two steps take the checkout path instead of
the GitHub name, and the plugin then loads in place: edits under `dist/`
show up at the next session start or `/reload-plugins`.

### Codex

There is no installer. Copy the built skill directory:

```
dist/codex/**   ->   ~/.agents/skills/deep-review/
```

The skill is then `$deep-review`.
