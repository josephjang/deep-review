# Change Proposal: Cancel obsolete pull request CI runs

## Summary

When a pull request receives another update, the previous revision can keep six CI jobs busy: ordinary checks and the resumable contract on Linux, Windows and macOS. Cancel earlier runs of the same workflow for that pull request so the current revision can use the runners. Keep every push to main independent and retain all checks on the current revision.

## Requirements

### R1: Replace work for the same pull request

Group runs of the check workflow by pull request number and cancel an in-progress run when another run enters that group. Apply this at workflow level so both three-OS job matrices belong to the same cancellation decision. Leave job names, commands, triggers and operating systems unchanged.

### R2: Keep unrelated validation independent

Different pull requests must use different groups. Every non-pull-request run must use its unique run id rather than a shared branch group, and cancellation must be enabled only for the pull_request event. In particular, successive main pushes must not cancel or replace one another's pending runs.

## Decisions

### D1: Use workflow, event and pull request or run identity

Set the workflow concurrency group to `${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}` and cancel-in-progress to `${{ github.event_name == 'pull_request' }}`. The workflow name separates this workflow from others, the event distinguishes a pull request number from a run id, and the fallback keeps independent main pushes out of the same group. A shared main group with cancellation disabled was rejected because GitHub can still replace a pending run in that group.

### D2: Keep the current revision's full gate

Do not introduce path exemptions or change contract frequency. The current revision still runs both job matrices. A canceled earlier revision is recorded as canceled, never as passed, and does not establish validation of that revision.

### D3: Measure CI work rather than local test speed

This scheduling change makes no claim about a single suite's elapsed time. Evaluate avoided obsolete runner time and the time from the latest push to its required results over an observed CI window. Until overlapping runs have been observed after adoption, both improvements remain unmeasured.

## Non-goals

### N1: Change the contract policy or runner capacity

Conditional contract execution, scheduled runs, sharding, runner sizing and caching remain separate decisions from this change.

## Risks

### K1: Cancellation is not commit ordering

[GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) describes group admission and does not guarantee dispatch ordering. This configuration replaces another run when GitHub admits it to the same group; it does not compare commit ancestry. A manually rerun older revision also shares its pull request's group and can cancel current work. Re-run the current revision if that happens, and require its successful checks before merge.

### K2: Earlier revisions lose complete diagnostics

An earlier run can stop before producing all of its failures. The accepted tradeoff is that the author gets the current revision's diagnostics instead of spending runners to finish obsolete work. Preserve every main push because main is an installable head and its validation remains useful independently.

## Test strategy

### T1: Check workflow syntax and group boundaries

Use actionlint for workflow syntax and expression validation. Check the documented identity cases: repeated runs of one pull request share a group and enable cancellation; different pull requests, workflows and main run ids do not share one; main cancellation is false. Confirm both job matrices and their commands are unchanged. A local identity calculation validates the expression's intended grouping, not GitHub's live scheduling behavior.

### T2: Preserve repository checks

Run npm run check and npm run verify against an isolated checkout containing this change and the committed repository inputs. No engine stop, resume, child launch or ledger behavior changes, so the contract suite is not required locally for this workflow-only change. Its existing three-OS CI job remains intact.

## Against the vision note

### V1: Retain evidence and state the limit

Principles 1 and 8 of the [2026-11-05 vision note](../2026-11-05-vision.md) require evidence and explicit coverage limits. Canceled revisions are not counted as passing, and the report distinguishes static validation from an observed CI benefit. No evidence or decision in the review engine is changed.

### V2: Preserve the real-run gate

Principle 12 still requires a real review before release. Canceling obsolete CI work changes scheduling without exempting the current revision from either the ordinary checks or the contract matrix. Local checks do not replace the real review of this change.

## Verification

actionlint v1.7.12 passed with no diagnostics using `actionlint -shellcheck='' -pyflakes='' .github/workflows/check.yml`. Six local identity cases confirmed that successive runs of one PR share a cancelable group, while different PRs, another workflow and separate main run ids do not collide. The event namespace also separates a PR number from an equal main run id. Removing the new concurrency block reproduced the original workflow byte for byte, preserving all triggers, jobs and commands. These are static checks, not a live GitHub cancellation test.

`npm run check` passed lint, typecheck and the ordinary suite in an isolated checkout: 3,713 tests, 3,700 passed, 13 skipped, zero failed and zero canceled. The complete check command took 578.582 s; the test runner reported 554.188 s. `npm run verify` passed for both distribution artifacts. The checkout included this workflow/proposal change and the committed repository inputs, excluding unrelated role edits and the separately prepared bounded-path-scan implementation. The author keeps the validation logs outside the repository; the command results, counts and durations are also recorded in the [test-time measurements](../reports/2026-11-08-test-time-measurements.json).

No contract run was required locally because no engine stop, resume, launch or ledger behavior changed. No CI run or real review was triggered, and no runner-time saving or latest-push latency improvement has been measured. Principle 12 still requires the real review before release.
