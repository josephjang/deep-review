## Choosing the checks

In a run that fixes, the engine runs four kinds of check, in this order:
`build`, `typecheck`, `lint` and `test`. Your task names the kinds you
choose; a kind the operator settled with a flag is left out. For each
kind to choose, return one command, or say the repository has none.

- Prefer what the repository itself runs: its CI workflows
  (`.github/workflows/`, `.gitlab-ci.yml` and the like), its contributor
  documentation, and its task configuration (a `tox` or `nox` section, a
  `Makefile`, a `Taskfile`, `package.json` scripts, a `justfile`). What
  CI runs is the strongest evidence of what the project calls its checks.
- One command per kind, run from the repository root. When the project
  runs two tools for one kind (two type checkers, say), join them in one
  command that runs both and fails when either fails.
- Prefer the form that verifies over the form that rewrites: a check
  reports what is wrong and does not fix it in place (`ruff check`
  rather than `ruff check --fix`, a formatter's `--check` mode).
- Run the command the way the project does: through its environment
  manager when it uses one (`uv run`, `poetry run`, `npm run`,
  `pnpm run`, `bundle exec`), so its tools resolve without a prepared
  shell.
- The command must start on this machine's platform and shell, which
  your task names; quote paths and arguments for that shell.
- Give the `source`: the repository file you took the command from and
  the text there, quoted as it stands (a workflow step, a guide's line,
  a script). Its `basis` is `stated` when the repository states the
  command, and `hint` when you took the engine's hint unchanged.
- The engine's hints are mechanical guesses read off the root
  manifests. Use one only for a kind the repository states nothing
  about, after reading that it fits this repository and this platform;
  never prefer a hint over what the repository states.
- A kind the repository has no command for gets a null `command`, a
  null `basis`, `source` and `missingTool`, and a `reason`. Do not invent
  a check the project does not have, and do not put a weaker command
  that happens to run in place of the project's own.

Look up what each command starts, as your task says, and name the first
tool that does not resolve in `missingTool`, or null when all do. A
tool the command runs through something that provides it needs only
that to resolve: `uv run --group dev tox` needs `uv`, not `tox`, and
`npx eslint` in a project that depends on eslint needs `npx`.
Do not run the checks: the engine runs them itself, under a timeout and
with their output recorded. A command whose tool is missing is still the
right answer when it is the project's check; the engine asks the
operator what to do about it.
