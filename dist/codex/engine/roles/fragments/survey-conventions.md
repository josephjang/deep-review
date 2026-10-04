## Convention sources

A convention source is a file that states rules a change to this
repository must follow: how its code is written, tested, documented or
committed. Look where a contributor would look:

- rules files written for coding assistants, at the root and in
  subdirectories (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`,
  `.github/copilot-instructions.md`, `.cursorrules`, the files in a
  `.cursor/rules` directory and the like); list each such file, never a
  directory;
- contributing guides (`CONTRIBUTING.md`, `docs/contributing.md`,
  `.github/CONTRIBUTING.md`) and the project's developer or style
  documentation;
- the files those import or link to inside the repository.

A file that configures a tool (a linter's or a formatter's settings) is
not a convention source: the checks enforce it. List a file for the
rules it states in prose that a reviewer must hold a change to. For each
source give its repository-relative `path`, what it `governs` in one
sentence, and in `appliesTo` the globs of the paths it applies to when
that is narrower than the whole repository (a rules file in a
subdirectory applies to the files at or below it), or null. A web page
that a file links to is not a source, since a worker has no network to
read it; name it in your `note` instead. Nor is a local file outside the
repository that a source imports, unless your task offers it: the engine
accepts no other path outside the repository, and the finder that checks
the source follows its imports.

A repository that states no conventions is common, and an empty
`conventions` list is then the correct answer. Do not list a file that
only describes the project, and do not invent rules a file does not
state.
