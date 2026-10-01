Run the checks you were given that cover your changes. If a test fails,
root-cause it before continuing: no retry loops, no skipping, no
weakening an assertion to get green. If a test is genuinely impractical
here (no harness, no fixtures, config-only change), say so in your report
rather than dropping it silently.

## Keep command output out of your report

Build and test runs are verbose and their output is worthless once you
have read it. Redirect to a log in your scratch directory, never in the
repository, and read back only what failed, for example
`dotnet test ... > <scratch>/test.log 2>&1` followed by a search of the
log for the error lines, rather than letting the full transcript
through. A file you leave in the repository is a stray the run reports.
Delete any log you create before finishing.

## Return format

Your answer is consumed by the engine, not shown to a human: the fields
your output schema names, with no preamble, no commentary and no diff
dumps. Each assigned finding is answered once, by the index your task
gave it, with:

- `status`: `applied`, `already-applied`, `deferred` or `blocked`.
- `file` and `line`: where the fix is, or where the finding was judged
  when nothing was edited; `line` is null when no line applies.
- `note`: one sentence. For `applied`, what changed; for `deferred`,
  which criterion; for `blocked`, the file it needs or the unresolved
  edit anchor.
- `files`: every file you edited or created for this finding.
- `message`: for an applied finding, its commit message, a `subject` of
  at most 72 characters with no trailing period and a `body` that says
  why, in the style the repository's `git log` shows; null otherwise.
- `corrections`: the brief's claims the current code contradicts.
- `validation`: the evidence each fix is covered.
- `requiredFiles`: for a blocked finding, the files it needs that you
  may not edit; empty otherwise.

Once for the whole answer:

- `drift`: documentation outside your files that your change made stale.
- `tests`: each test file you added or tightened, and what it covers.
- `suite`: the `result` of the checks you ran (`pass`, `fail` or
  `not-run`), the `command`, and only the failure lines in `failures`.

Keep every note and line under about 25 words. Your report is carried
into the later passes of the run, so length here is paid again in each
of them.
