# Product Requirements: Resumable runs

Technical part: [2026-10-18-resumable-runs.design.md](2026-10-18-resumable-runs.design.md).

## Summary

A stop ends the work of a run before its report. Something ends the engine at a point of its work, or a limit of the environment ends the work of its workers. The person then runs the same command again, and the run must continue. It must do again only the work that the stop cut short, pay for no settled worker again, and say nothing false. Today this is true for most stops, but not for each one.

Runs showed three stops that a person had to correct. In the first, the run recorded a killed check as failed (#25). In the second, the run budget stopped a fix pass (#48). In the third, a usage limit of the provider degraded the fixes (#40). A search of the code found nine more ways in which a stop can leave work undone or a record false.

This proposal makes resumability a contract with a test, not a list of fixes. A test stops the engine at each point of its work, in each way that a process can end. Then it checks the contract after the same command. The proposal then changes the engine at each point that fails the test, and it fixes the three stops that runs showed.

This departs from principle 11 of the vision note, which builds recovery only for a failure that a run showed. The proposal names the departure and proposes new words for the principle (PD1). It keeps principle 11 for the limits of the environment (PD2).

## Problem

### The promise

The skills tell the user what to do when a review command stops: "run the same command again: it continues from the last step its ledger holds and pays for no completed worker twice". The vision note expects runs with no person present: in the loop of an author agent, as the check that a pull request must pass, and as a triage of pull requests. Hosts stop long commands. Claude Code stops an unattended background command after 30 minutes, and Codex stops a command when its turn ends. Thus a stop is a normal event for this engine, not an exception.

### Where the promise holds

The ledger keeps each decision and each answer, and the engine resumes a run from the last step that the ledger holds. A worker that was in flight at the stop is recorded as lost and launched again, and its loss does not count against it. On run `509e520e`, a tool stopped the engine at two hours, and the same command resumed the run to its report with no hand. On run `32c720a0`, the usage limit of the provider failed the decider twice. The decider blocks and does not degrade, so the same command resumed the run after the limit reset.

### Where it breaks: three stops that runs showed

On 2026-10-08, a person stopped run `8dbe23ad` while its baseline typecheck ran. The stop killed the check before it stopped the engine, so the engine recorded the check as failed. The resumed run did not run typecheck again, because the planner runs only the kinds with no run in the phase. Thus the report says that typecheck failed before the fixes, but it passes on that tree. Each fixer got the same false fact, and one fixer did not run typecheck at all, with the reason `pre-existing failure` (#25).

On 2026-10-12, run `0d63437e` reached its run budget of 60 USD in its fixes. The budget does not block a fix pass (PD16 of the fix pass). The run recorded the second round and the repair as not attempted and completed with a tree that failed its build check. No command continues a complete run, so the operator moved the 17 patches off the branch manually and started run `0586b85f`. That run paid again 30.10 USD of reported cost for the phases before the fixes (#48).

On 2026-10-10, run `e21b026d` met the session limit of Claude Code in its fixes. Each fixer then failed in 3 seconds, twice. The engine took each failure as the fault of the unit, recorded the batches as not attempted, and completed the run with 9 patches. The run was void and cost 34 USD, and the same command did not continue it (#40).

### Where it breaks: ways that no run showed yet

The engine stops at a point of its own code, so the points are a finite set. A search of the code found nine more ways, and the design lists them.

For example, a stop that kills a worker before the engine counts as a failure of the worker. A kill between the end of a worker and the record of its answer drops the answer. A `commit` that a stop cuts after it moved the branch leaves commits that the ledger does not hold. A child of a killed engine can continue to edit the tree. No run showed these yet, but each unattended run can meet them.

### Why fixes one at a time do not converge

Each of the three stops above got, or needs, its own fix. Each fix waits until a paid run meets the stop, and the next stop is at another point. The proof of concept showed the opposite failure. It built recovery features for stops that it imagined, and it missed the stops that occurred. A contract with a test at each point avoids both failures. The test finds the points, and the proposal builds nothing for a stop that the test does not show.

## Goals

After a stop at any point of the work of the engine, the same command resumes the run. The run reaches the result that the same run with no stop reaches. The person does nothing else, except to raise a budget that they set. The run does again only the work that the stop cut short, and it pays for no settled worker again. The ledger and the report say nothing false about the stop. A test shows each of these at each point, and a change that breaks one fails the test.

A limit of the environment that runs showed, the run budget and the usage limit of a provider, leaves the work open. The same command does it later.

## Non-Goals

### A person who changes the state of a run

A person can edit a file of the run, move `HEAD` or remove the worktree while the run is active. Then the run blocks with an action, as today. A person's change needs that person. The proposal only makes sure that the engine never records the edit of a person as its own work (R10).

### A loss of the state of the engine

When the ledger, the evidence store or the git data is lost or damaged, the engine cannot resume the run. It refuses, as today.

### Limits of the environment that no run showed

A sleep of the machine, a failure of the network, and the limits of Codex get no recovery here. Principle 11 still applies to the environment (PD2). For the sleep, the design says what to measure first.

### A killed check, told apart when it ends

The engine reads no output of a check and no exit code other than zero (PD8 of the fix pass). An exit code of 128 plus a signal number is a convention of the shell, not a fact. A test runner that aborts can exit with code 134 alone, and that is a real failure.

### A block of the fix pass at the budget, or a part of the budget kept for the repair

Issue #48 named these two options, and PD10 rejects them.

### Units that failed twice by their own fault

A unit that failed twice for a reason of its own keeps its outcome. The proposal changes only what a stop or a limit of the environment did to a unit.

### The answer pass at the budget

An answer pass blocks at the budget (TD8 of answers), and the same command with a higher `--budget-usd` resumes it. That is resumable as R1 says, so this proposal does not change it.

## Requirements

Some requirements are for ways that no run showed: R4 for units, R5, R6, the write back of R7, R8, R9 and R10. Each of them holds only when the test of R2 shows its way as a failure (PD1).

### R1: Resumable means five things

After a stop at any point of the work of the engine, the same command does five things. It needs no other action of a person, except a higher budget after the run budget stopped the work. It does again only the work that the stop cut short. It pays for no worker that settled before the stop. It leaves no false statement on the ledger or in the report. And it reaches a report, as the same run with no stop does.

With the fake runtimes and the fake checks of the test suite, it reaches the same report as the run with no stop. Only the lines that say what the stop did are different. A point of the work is a point between two appends to the ledger, or a point while a worker or a check runs.

### R2: A test checks the contract at each point

A test runs a fix run on the fakes and stops the engine at a point. Then it runs the same command again and checks R1 against a run with no stop. Its run holds each case that a way needs: a check that writes a file of the run, and a unit whose first attempt fails.

It stops the engine in four ways. Three of them are a handled signal, a hard kill of the engine alone and a hard kill of its process tree. In these three ways, the engine records nothing after the stop. The fourth way kills a child before the engine, with a kill mark (R4). That is the order of run `8dbe23ad`, where the stop killed the check and the engine stopped less than 0.4 seconds later. Thus only the fourth way can show #25, or a worker that a stop kills before the engine.

The test suite runs a fixed set of points. They are where a phase starts or ends and where a worker or a check runs. They are also where the engine edits the tree or git, and where it writes the report. A script runs each point between two appends, and the gate of R18 runs it. CI runs the suite on Linux, macOS and Windows.

### R3: A check that a stop cut short runs again

When the engine starts a checks phase again after a stop, it runs again each kind whose last run in the phase did not pass. It runs these kinds and the kinds with no run in the order of the kinds: build, typecheck, lint, test. A kind whose last run passed does not run again. This applies to `baseline-checks`, `checks`, `repair-checks` and `answer-checks`. The first attempt of a phase runs each kind one time, as today.

### R4: A child that something outside ended is cut, not failed

The engine records a check or a worker as cut when its process ended with a kill mark. A kill mark is a signal, or one of the exit codes 129, 130, 131, 137 and 143, or the exit code 3221225786. A shell gives a process that a signal ended the code 128 plus the number of the signal. Windows gives the last code to a process that Ctrl-C ended. Any other exit code that is not 0 is a failure, as today. A timeout that the engine enforced stays a timeout.

A cut check has no result, so its phase does not finish while it is cut. A cut run records no revision, because its writes are not the work of a complete check. Before the check runs again, the engine writes back each file that the run expects and that differs (R7). The engine runs the check again at once, or the next command runs it (R3). The second cut of a kind in one attempt is a failure, and its error names both marks.

A cut worker is an interruption of its unit, as a lost worker is. Its unit does not degrade because of it. A unit out of attempts with a cut among its failures blocks, and the next command gives it its attempts again.

### R5: A unit keeps its attempts after a stop

When the engine starts a phase again after a stop, each unit of the phase that did not settle gets two attempts again. Today a unit gets them again only after a block.

### R6: The end of a worker and its answer are one record

The ledger records the end of each worker and what the worker contributed, or why the attempt failed, in one append. A stop cannot record one without the other.

### R7: A check that a kill cut short leaves no writes that the run did not record

The ledger records the start of each check. A check can then have a start and no end on the ledger. Such a check, and a check that ended cut (R4), is a cut check. A check that the engine killed at its timeout is cut short too. No check that a kill cut short records a revision, because its writes are not the work of a complete check.

Before the next step after such a check, at once or at the next command, the engine handles the files that the run expects. For each such file that differs from what the run recorded, it keeps the bytes in the tree as evidence. Then it writes back the bytes that the run recorded. The log and the report name each such file. Then a cut check runs again (R3, R4), and a check that timed out keeps its result.

### R8: No child of an ended engine continues

When the engine ends in any way, each of its workers and checks ends too, with each process that the child started.

### R9: A `commit` that a stop cut short completes at the next command

The ledger records each series of commits before the branch moves. When a stop cuts `commit` after that record, the next command that reads the head of the run completes the record if the branch moved. It drops the series if the branch did not move.

### R10: A lost attempt records only its own work

When the engine records the edits of a worker that a stop cut short, it records only its own files. These are the files that the snapshots of the worker name, and the files that its unit owned or claimed. Each other change is a stray file or a drift, as the next check of the tree finds it.

### R11: The same command with a higher budget continues a fix pass that the budget stopped

A fix pass that the budget stopped is a complete fix run with a unit that is not attempted because of the budget. The unit is a batch of the fixes or the repair. This applies to a runtime that reports cost, because only such a runtime has a run budget. `review --fix` continues the newest such run of the worktree when no run of the checkpoint is active and three conditions are true.

First, the command names the scope of the run. A run of the last commit or of the uncommitted changes matches `--last-commit`, `--worktree` or no scope flag, after the mode of the run. A run of a ref or a range matches the same `--ref`, the same range, or `--branch` with the same base. The paths must be the same. The engine compares these before it looks at the state of the tree. Thus the flags still match after the fixes or `commit` changed the tree.

Second, the tree is where the run left it: `HEAD` is at the head of the run, and each file that the run expects is as the run recorded it. Third, the run budget in force is above the spend of the run. With `--fresh`, the engine continues no run.

The continuation launches no unit that settled before. It launches the units that the budget did not launch, the batches of the first round first. Then it does the rest of the fix pass. The engine plans the second round only after each batch of the first round settled. The checks after the fixes run again when the tree changed after their last runs.

When a check then fails after the fixes and the repair did not run before, the repair runs. The checks after the repair run when the repair changed the tree, in each fix run, not only in a continuation. Last, the continuation writes a new report. It reviews nothing again.

### R12: A budget that is not above the spend refuses

Sometimes the command names the scope of such a run, and the tree is where the run left it. If the run budget in force is not above the spend, the command refuses. It exits with code 2 and creates no run. The refusal names the spend and the budget. It names `--budget-usd` above the spend to continue the run, and `--fresh` to review the change again in a new run.

Sometimes the command names the scope of such a run, but the tree is not where the run left it. Then the command starts a new run, as today. Its log names the run that it did not continue, and each file or `HEAD` that moved. The person can then restore them and continue the run.

### R13: A continuation keeps the answers of a person

An answer pass can apply the answer of a person to a finding after the budget stopped the fix pass. A continued batch that holds that finding then gives the answer to its fixer. The fixer keeps the answer, and it does not apply the default of the decision again.

### R14: A usage limit of the provider blocks the run, and the same command resumes it

A worker can fail because the provider says that a usage limit or a session limit is reached. The engine then records the failure as a fault of the environment. The phase blocks at once with `worker-failed`. The detail names the limit, and the time of its reset when the provider gives one.

No unit degrades because of the limit, and each unit keeps its attempts. The same command, run after the reset, resumes the run. This applies to the words that Claude Code uses for its limits.

### R15: The record says what a stop did

The report and `status` name each thing that a stop caused, and what the resumed run did about it. For a check that ran again, they name each run and its outcome. For a file that the engine wrote back, they name where the earlier bytes are. They also name a series of commits that the next command completed or dropped, and a block for a usage limit. And they name a fix pass that the budget stopped or that continued.

A run that the budget stopped names the command that continues it: `deep-review review --fix` with the scope flags of the run and `--budget-usd` above the spend. It names it on the last line of stderr, in the report and in `status --run <id>`. The header of the report of a continued run names when the fix pass continued and where the earlier report is. The Checks table marks a column whose runs checked a tree that a later edit changed.

### R16: An older engine passes over the new records

The records of this proposal have event kinds and versions that an older engine does not declare. Each fix run of the new engine has some of them, because the ledger records the start of each check. Thus an older engine passes over each new fix run, with one line, as it passes over each run that it cannot read. It does not stop the commands of the repository.

### R17: The skills and the README say what resumes

The Claude Code skill says that the same command with a higher `--budget-usd` continues a fix run that the budget stopped, with no new review. It also says that the same command resumes a run that a usage limit blocked, after the reset. After such a run, it shows the stderr line that names the command and offers to run it. These are lines of the Claude Code skill only, because Codex reports no cost and its limits are not handled here. The two skills stay one text, except the lines that are different for each runtime. The README states the contract of R1 and these two cases, the budget for runtimes that report cost.

### R18: The gate

Real runs on the pull request of this change show the contract (principle 12). In the first run, a person stops the engine while a baseline check runs, and the stop kills the check first. In the second run, a hard kill of the engine alone stops it while fixers run. In the third run, the budget stops a fix pass, and the same command with a higher budget continues it. After each stop, the same command resumes the run, and the report says what the stop did. The script of R2 runs each point on the same commit, and CI runs the suite on the three systems.

## Metrics

### Points that break the contract

Baseline: the first run of the test of R2 on the engine before this change counts the points that break R1. Target: 0 points. Measure: the script of R2.

### What a continuation saves

Baseline: on the change of run `0d63437e`, the new run `0586b85f` paid 30.10 USD of reported cost for the phases before the fixes. Target: a continuation pays 0 USD for those phases. Measure: the sum of the reported cost of each worker of those phases after the continuation, from the ledger.

### A false baseline

Baseline: the report of run `8dbe23ad` names one check that failed before the fixes, and that check passes on that tree. Target: no report names a check as failed because a stop killed it. Measure: the first run of R18 compares the outcome of the killed check with the outcome of its rerun.

## Product Decisions

### PD1: A contract that a test checks at each point, not a fix for each stop that a run showed

Principle 11 builds recovery when a run shows the need, not before. It does not permit a recovery path for a failure that no run showed. This proposal departs from it for the stops of the engine.

The reason is the kind of failure. The proof of concept built recovery for failures of the environment that it imagined, and those failures did not occur. A stop of the engine is not imagined: each unattended run is exposed to it, and runs `8dbe23ad`, `509e520e` and `3db05952` were stopped. What no run showed is the exact point of a stop. The points are a finite set in the code of the engine, and a test can stop the engine at each one. A point that fails the test is a failure that the test showed, so the proposal builds recovery only for a shown failure.

The proposal suggests new words for principle 11 in the next vision note, in three sentences. The first is "A stop of the engine at any point of its work is resumable". The second is "A test that stops the engine at that point shows the need". The third is "A failure of the environment gets its recovery when a run shows it". The proposal rejects the other choice, a separate fix for each point when a paid run meets it. The search already found nine such ways, and each fix waits for a run that costs tens of dollars.

On 2026-10-18, the author accepted this departure, with one condition. A requirement for a way that no run showed holds only when the test of R2 shows that way as a failure. These are R4 for units, R5, R6, the write back of R7, R8, R9 and R10. When the test does not show a way, an amendment removes its requirement before the work builds its mechanism. Thus the analysis of the code finds the candidates, and the test shows the need, as the second of the three sentences says. R7 keeps the record of the start of each check in each case, because PD4 uses it for the killed check of #25.

### PD2: "Any reason" covers each stop of the engine and the two limits that runs showed

A stop of the engine is the same event to the engine, whatever stopped it. Many things can stop it: Ctrl-C, a closed console, a signal, a hard kill, a host that stops a command, a crash and a loss of power. Each one ends the process at a point of its work. Thus one contract covers them all.

A limit of the environment is different, because each limit has its own signs and its own recovery. Runs showed two of them: the run budget (#48) and the usage limit of Claude Code (#40). The proposal handles these two. The sleep of a machine, a failure of the network and the limits of Codex wait for a run (principle 11). The proposal rejects a general rule that retries each failure of a worker, because a real failure then costs money again and again.

### PD3: Run again what did not pass, not each kind and not only the last record

The proposal rejects a rerun of each kind of a phase that starts again. A kill cannot make a check pass, so a check that passed stays valid, and the test suite of this repository takes five minutes.

The proposal also rejects a rerun of only the last recorded run of the cut attempt. That rule reads the order of the records as a fact about the stop. But the order is not a fact when the engine stopped between two checks. The cost of the chosen rule is a real failure that runs again one time after each stop of its phase. A stop is rare compared to a check. Revisit this if a host stops runs often, for example at a time limit.

### PD4: An outcome from how a child ended, and a record of each start

An outcome `interrupted` needs the engine to know that a stop is in progress. The engine did not know it on run `8dbe23ad`, so the proposal rejects that outcome. The outcome `cut` of R4 needs less: it reads how the child ended (PD5). When a signal reaches the engine first, the engine records nothing for the check. When the stop reaches the check first, the check ends with an exit code. That code carries a kill mark when the stop left one.

The record of the start of each check (R7) closes the gap of the first order. A check that started and has no end on the ledger is a check that a stop cut. For the second order, R4 records a marked kill as cut, not as a verdict, and R3 runs the check again. A kill with no mark stays a failure, and R3 runs it again while its phase is open. The killed run stays on the ledger, and the later run names it as the run that it replaces (R15). This is the rule of the ledger for a wrong event: a later event corrects it and says so.

### PD5: The exit status tells a cut child from a failed one

On 2026-10-18, the author chose this rule over a wait of 10 seconds. The question is if a child failed by itself or something outside ended it. The engine sees two values of each end: the exit code and the signal. A signal, or a code that a shell or Windows gives a killed or interrupted process, is a kill mark. A program that fails by itself gives a small code of its own, and a test runner gives 1.

A test on Windows on 2026-10-18 started a check as `runCheck` does and ended it in five ways:

| How the check ended | Exit code | Signal |
|---|---|---|
| It failed by itself (`process.exit(1)`) | 1 | none |
| `taskkill /F` on its process | 1 | none |
| `taskkill /T /F` on its shell | 1 | none |
| The `kill` of Git Bash on its process | 143 | none |
| The `kill` of Git Bash on its shell | 143 | none |

The 143 of run `8dbe23ad` is the mark of the `kill` of Git Bash: 128 plus 15, the number of SIGTERM. A kill with `taskkill` leaves no mark, because its code is the code of a real failure. Thus the list of R4 does not hold 1, and that gap is an accepted risk.

The rule costs nothing for an ordinary failure. On run `f57bcc23`, the last kind, test, failed before the fixes, after the fixes and after the repair, each time with exit code 1. A rule that runs each last failure again before its phase ends costs 11.6 minutes there, or 17.7 minutes with the check after the repair. A wait of 10 seconds costs 30 seconds. This rule costs nothing, because 1 is not a mark.

The proposal rejects four other rules. A wait of 10 seconds before a failure is final uses the clock as its evidence, from one stop on record. A rerun of the last failed check costs the time above on each red phase. A reopen of a finished checks phase at the next command misses the last checks phase. The report follows that phase in milliseconds, and the run ends with no command to reopen it. A parse of the output goes against the fix pass, where the engine does not parse check output (PD8 of the fix pass).

### PD6: After a stop, each unit gets its attempts again

A stop can kill a worker before the engine, and the engine then records a failure of the unit. The engine cannot tell that failure from a real one. Today a unit gets its attempts again only after a block. A phase that starts again after a stop now does the same. The cost is one more attempt for a unit that really failed once, after each stop of its phase. The proposal rejects a rule that forgets only the failures near the stop, because the engine has no clock of its own death.

### PD7: Write back what a cut check wrote, and keep what was there

A check can write files: a formatter in lint, a generator in build. When a stop cuts it, its writes are on no record, and today the next start of the phase blocks on drift. A person must then write back the bytes that the run expected. The engine knows these bytes, so it does this itself (R7). It first keeps the bytes in the tree as evidence, so nothing is lost if a person also changed one of these files. On 2026-10-18, the author kept this write back, under the condition of PD1.

The same holds for a check that ended cut while the engine lived (R4). Today the engine records the writes of each check that ends as its revision, and `commit` makes that revision a commit. A half rewrite of `dist/` then becomes a commit of its own. Thus a cut run records no revision, and the write back comes before the check runs again. On 2026-10-18, the author chose the same for a check that the engine killed at its timeout, which today records its half rewrite too. Its result stays a timeout and it does not run again, because the engine knows the cause.

This choice for a timeout does not wait for the test of R2 (PD1), because a timeout is not a stop.

The proposal rejects a record of these writes as a revision of the cut check. That record can take the edit of a person as the work of the check. The proposal also rejects the block of today for this case, because the engine caused the drift. And it rejects a rerun with no write back. The rerun then starts from half a rewrite. A formatter that a stop cut can leave half a file, and the lint that runs again can fail on it.

### PD8: Each child ends with the engine

After a hard kill of the engine alone, its children can continue. On POSIX, they run in their own process groups. On Windows, the direct children end with the engine, but their descendants continue (tested). A check or a fixer that continues can write files while the resumed run reads them. Thus each child ends with the engine (R8). The design gives the means.

### PD9: `commit` records its series before the branch moves

`commit` moves the branch and then records the commits. A stop between the two leaves commits on the branch that the ledger does not hold, and each later command refuses. Principle 2 asks for the record before the action. Thus the ledger records the series first, and the next command completes or drops it (R9).

### PD10: Continue the complete run, not block at the budget, not keep a part of the budget

Issue #48 named three options. This proposal takes the first: a complete run continues later.

The second option blocks the fixes at the budget, as the read-only phases block. The proposal rejects it for two reasons. A blocked fix pass has edits with no report (PD16 of the fix pass). And the run then waits for a person (principle 7).

The third option keeps a part of the budget for the repair. The proposal rejects it, because nobody knows before the checks run if the repair is necessary. PD16 of the fix pass also rejected a reservation for each batch as too cautious, and PD20 rejected a second budget beside the run budget.

### PD11: The same command continues, and a budget that is too low refuses

The skills and the README already tell the user to run the same command again after a stop. A read-only phase that the budget blocked already continues that way with a higher `--budget-usd`. Thus the same command with a higher budget continues a fix pass too, and the proposal adds no flag and no command.

When the budget is not higher, a new run reviews the change again and meets the same budget. Thus the command refuses and names both choices (R12). The proposal rejects a quiet new run for this case.

When the tree changed after the run, the proposal keeps a new run, with a log line that names what moved. A refusal was rejected for this case. Flags such as `--branch` stay the same from day to day, while `HEAD` and the files move. Thus a refusal can block each later review behind an old run. The log line gives the person the way to continue the old run, and nothing waits.

### PD12: Only the units that the budget did not launch continue

A unit that failed twice did not stop because of the budget. A higher budget does not repair it. A repair that ran before does not run again in a continuation, because the fix pass has one repair.

### PD13: A cut first round plans no second round

The second round takes the findings that the first round blocked on the files of another cluster. When the budget stops the first round, a second round planned at that point misses each finding that the cut batches block later. Its batches also stop at once, because the budget stopped the first round. Thus the engine plans the second round only after each batch of the first round settled, in the run or in its continuation. The report of a run that the budget stopped in the first round says that the second round was not planned.

### PD14: A usage limit blocks at once and keeps the attempts

On run `e21b026d`, each fixer met the limit, failed twice in seconds, and degraded. A retry before the reset cannot pass, so the second attempt only costs a launch. Thus the first failure that names a limit blocks the phase. The proposal rejects a wait in the engine until the reset, because the run must not hold a terminal for hours (principle 7). The block names the time of the reset, so a person or a scheduler knows when to run the command again.

### PD15: One contract, delivered in steps, the test first

The contract is one change of the product: "a stop never needs a hand". The proposal keeps it in one proposal so that its requirements and its exceptions are in one place. The work goes in steps, each its own commits: the test, then the mechanisms for the stops of the engine, then the limits of the environment, then the record and the texts. The test comes first, because it finds the points and gives the baseline of the metric. It also decides which requirements for ways that no run showed stay (PD1).

## Against the vision note

### Principle 1, evidence, not trust

A report that says a check failed before the fixes, when the check passes, is a false verdict about the tree. R3, R4 and R15 correct it with a later run on the ledger, and the report names both runs. R10 keeps the edit of a person out of the record of a worker.

### Principle 2, record before action

R6, R7 and R9 record each action of the engine before or with its effect: the end of a worker with its answer, the start of a check, and a series of commits before the branch moves. The ledger records a continuation before any fixer of the continuation starts.

### Principle 7, nothing waits for a person

A stop no longer leaves a run that only a person can correct. A fix run that the budget stopped still completes with a report, and the continuation is a later choice of the operator. A usage limit blocks the run, and the block names when the same command can resume it.

### Principle 8, say what was not examined

A run that the budget stopped names the work that it did not do and the command that does it (R15).

### Principle 11, recovery without a person

The proposal departs from this principle for the stops of the engine (PD1). It builds recovery for the points that a test shows, before a run meets them. It keeps the principle for the limits of the environment (PD2), and it builds recovery for the two limits that runs showed. The proposal suggests new words for the principle in the next vision note.

### Principle 12, a real run is the gate

R18 is real runs on the pull request of this change. They have a stop during a check, a hard kill during the fixes and a budget that stops the fix pass. The test of R2 does not replace these runs.

## Risks

### The test makes the suite longer

A run on the fakes takes seconds, and the test stops it at many points in four ways. The suite runs a fixed set of points, and a script runs each point. The proposal accepts a longer suite, because the contract has no other proof.

### The fakes are not the real runtimes

A point can pass on the fakes and fail with Claude Code or Codex, for example in how a real runtime ends. The proposal accepts this, because the gate of R18 stops real runs too.

### A real failure runs again after a stop

A check or a unit that fails for a real reason runs again after each stop of its phase. The proposal accepts this, because a stop is rare and the cost is the time of a check or one attempt (PD3, PD6).

### A kill with no mark

A stop that ends a child with an ordinary exit code, before it ends the engine, leaves a failure, as today. `taskkill` gives such a code (PD5). The proposal accepts this, because no run showed it. A tree kill with `taskkill` from outside ended the engine first in each try, so the engine recorded nothing (Context of the design). R3 still runs such a failure again while its phase is open.

### A real failure with a kill mark runs once more

A check or a worker that a signal ends for a real reason is cut. An example is a process that the system ends for lack of memory. Such a check runs once more, and its second cut in the attempt is a failure. Such a worker uses an attempt, and its unit then blocks and does not degrade. The proposal accepts this, because such ends are rare, and the cost is one run or one block.

### A write back can replace the edit of a person

R7 writes back the bytes that the run expects. If a person changed such a file while the run was stopped, the engine replaces that change. The proposal accepts this for two reasons. The engine keeps the replaced bytes as evidence and names the file. And a person must not edit the files of an active run.

### The words of a usage limit can change

R14 knows a usage limit by the words that Claude Code uses today. If the words change, the failure counts against the unit again, as today. The proposal accepts this, because the test of the adapter pins the words, and the change is easy to see in a run.

### A continued run that a person abandons cannot be committed

`commit` refuses an abandoned run. Before the continuation, the patches of the run were committable. After a person abandons the continued run, they are not, and the person must apply the patch files manually. The proposal accepts this, because the same command resumes a continued run that a stop cut, so an abandon is the choice of the person.

### An older engine cannot read a new fix run

An engine older than this change passes over each fix run of the new engine (R16). Operators on two versions then cannot share such a run until both update. The proposal accepts this, as each earlier new version did, because the alternative stops each command of the older engine.
