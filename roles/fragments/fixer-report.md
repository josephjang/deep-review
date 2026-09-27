Run the test command you were given after your changes. If a test fails,
root-cause it before continuing: no retry loops, no skipping, no
weakening an assertion to get green. If a test is genuinely impractical
here (no harness, no fixtures, config-only change), say so in your report
rather than dropping it silently.

## Keep command output out of your report

Build and test runs are verbose and their output is worthless once you
have read it. Redirect to a log and read back only what failed, for
example `dotnet test ... > test.log 2>&1` followed by a search of the log
for the error lines, rather than letting the full transcript through.
Delete any log you create before finishing.

## Return format

Your final message is consumed by the engine, not shown to a human.
No preamble, no commentary, no diff dumps. One block per assigned
finding, then a summary:

```
<ID> APPLIED   <file>:<line> — <what changed, one sentence>
<ID> DEFERRED  <file>:<line> — <which criterion, one sentence>
<ID> BLOCKED   <file>:<line> — <required unowned file or unresolved edit anchor>
<ID> CORRECTION <file>:<member/anchor> — <brief claim> -> <current fact>; <evidence>
<ID> VALIDATION <OLD-CODE|MUTATION|STATIC|EXISTING|LIMITED> <test/source> — <evidence>
DRIFT   <file>:<what> — a fact outside your files that your change made stale
FILES   <every file you edited or created>
TESTS   <test file>: <n> assertions, <what they cover, one line each>
SUITE   <pass|fail> <command> — <failure lines only, or "green">
```

Keep every line under about 25 words. Your report is carried into the
later passes of the run, so length here is paid again in each of them.
