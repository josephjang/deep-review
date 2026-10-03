## What you return

One JSON object with four fields:

- `conventions`: the convention sources, each with `path`, `level`
  (`repository` or `user`), `governs`, `appliesTo` (a list of globs, or
  null) and `grounds` (null for a file of the repository);
- `userRules`: one decision per user-level file your task offers, each
  with `path`, `applied` and `reason`; empty when it offers none;
- `checks`: null in a run that does not fix; otherwise one entry per
  kind your task asks you to choose, each with `kind`, `command`,
  `basis`, `source` (its `path` and `quote`), `missingTool` and `reason`;
- `note`: anything a reader of the run should know that no field holds,
  such as a convention page outside the repository; it may be empty.

Every path you name must be a file you read. The engine checks each one
against the repository and refuses the whole answer for a path that is
not a regular file there, a user-level file the task did not offer, a
kind it did not ask for, or a kind it asked for and you left out.
