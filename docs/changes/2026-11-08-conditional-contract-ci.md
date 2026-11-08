# Change Proposal: Run the contract on relevant pull requests

## Summary

The resumable-run contract is the most expensive CI tier. Exempt a pull request only when its complete change contains documentation Markdown under docs/ or the root README.md and AGENTS.md. Keep every main push, scheduled run and manual run on the full three-OS contract. Preserve the existing contract job names and make each one validate the decision, so adoption does not depend on changing unknown branch protection settings.

## Requirements

### R1: Exempt only a complete documentation-only change

For a pull request, compare its entire branch with the target branch's merge base, not just its last commit. Also inspect the tested merge against its base. Exempt only regular, non-executable Markdown files under docs/ and the exact root README.md and AGENTS.md paths. Both sides of renames and deletions count. An empty diff, shallow history, invalid event, unexpected merge, ambiguous ancestry, unsupported file mode, unknown path or failed inventory requires the full contract.

### R2: Retain the full contract elsewhere

Source, tests, helpers, roles, skills, generated output, dependencies, toolchain, configuration and CI changes require all three OS executions. Main pushes retain the full contract. A weekly schedule at 03:23 UTC on Monday and workflow_dispatch run the full matrix on their selected revision. Manual dispatch is the force-run option; no label or previous result can exempt a new revision.

### R3: Preserve required status behavior

Keep the existing contract matrix names. Each matrix job validates the classifier result, runs the full contract on an invalid or failed classification, and fails its status if that classification is invalid or failed even if the fallback contract passed. A successful explicit fallback from an unavailable diff is a valid decision to run the full contract. Add an always-run aggregate status that distinguishes contract execution from a documented exemption and rejects failed, canceled, skipped or invalid prerequisites. Adding that status does not make it required in branch protection.

## Decisions

### D1: Use local Git with a complete checkout

A small Node script reads the pull_request event, validates the base, head and tested merge identities, requires complete history and one merge base, then reads NUL-delimited raw Git diffs with rename detection disabled. This covers all changed paths and modes without the pull-request API's pagination limit or an extra token permission. Any uncertainty returns an explicit full-run decision. Checkout and execution stay in the ordinary pull_request context with read-only contents permissions, as the existing check jobs do; do not use pull_request_target or execute PR code with an elevated token.

### D2: Retain cheap matrix jobs for exempted changes

Even an exempted PR allocates the three existing OS jobs for checkout, Node setup, plan validation and an explicit exemption message. Only npm ci and npm run test:contract are skipped. A separate plan job and aggregate job add setup overhead. This sacrifices some possible runner savings to preserve existing required status names and fail closed without an administrative branch-protection change. Ordinary check and verify jobs remain unconditional.

### D3: Make the exemption visible

Record the revision identities, complete path count and decision reason in the plan's log and workflow summary. A docs-only result says the contract was exempted, not passed. The aggregate accepts only a successful matrix with a valid plan. No test case is deleted and no required operating system is dropped from a relevant change.

### D4: Keep the current distribution gate

All main revisions still receive contract validation. The weekly schedule is a backstop, not evidence for an intermediate commit. On a scheduled failure, inspect the named revision and failed OS, reproduce or dispatch the full workflow, and fix the failure before treating that revision as validated. [GitHub documents that scheduled jobs can be delayed or dropped](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), so no fixed detection interval is promised. The real review required by principle 12 remains the release gate.

## Non-goals

### N1: Broader exemptions or faster individual tests

Do not exempt prompts, skill text, JSON, images, other documentation extensions or policy directories. Do not change test cases, engine behavior, caching, parallelism or the frequency of main-push validation. Documentation files that the engine later starts executing or loading as runtime input must be removed from the exemption before that use is introduced.

### N2: Change branch protection from this session

The read-only attempt to inspect main's protection returned HTTP 401, so the required checks could not be confirmed. Keep all existing job identities and leave repository settings untouched. A maintainer can later require the aggregate status after observing both full and exempted runs; that is not required for the existing matrix gates to reject an invalid plan.

## Metrics

### M1: Count avoided contract executions separately from elapsed time

An eligible PR avoids three npm installations and three contract invocations, while still paying plan, aggregate and matrix setup costs. Relevant PRs gain classification overhead. Measure the eligible PR fraction, actual runner time and latest-push-to-result latency after adoption. The historical Windows contract steps of 472 to 801 seconds do not establish a new CI-wide speedup, and exemption is not a passing contract result.

## Risks

### K1: A false exemption can defer detection

A classification omission could allow a relevant PR to merge without a pre-merge contract. Use a narrow allowlist, inspect both diff views and file modes, and run the full tier on every uncertain inventory. Every main push remains checked, so the accepted delay for a mistaken exemption lasts until that post-merge validation completes; this can expose an installable main revision before detection. The schedule is an additional backstop, not a substitute for main validation.

### K2: Workflow adoption needs live evidence

Local tests can validate policy, Git inventory and status decisions, but cannot prove GitHub's live scheduling or branch protection. Before treating adoption as observed, inspect a documentation-only PR, a relevant PR, an error fallback, a manual run and a scheduled main run. Confirm existing matrix names are still emitted. Do not claim runner or latency savings from local classification timings.

## Test strategy

### T1: Test policy and real Git boundaries

Exercise allowed and unknown paths, executable and symbolic-link modes, malformed raw data, absent or invalid events, shallow or missing history, multi-commit PRs, target-branch advancement, renames in both directions, deletions and unexpected tested merges. Test status decisions for exemptions, full runs, explicit fallbacks, malformed plans and failed, canceled or skipped prerequisites. Use temporary repositories for inventory behavior rather than hard-coding the implementation's command list.

### T2: Keep repository and workflow validation

Run targeted tests, actionlint, npm run check and npm run verify in an isolated checkout with this change and committed source/role inputs. A single full-check verification is enough; no repeated performance comparison is needed for a scheduling policy. No engine stop, resume, launch or ledger behavior changes, so a local contract run is not required by the existing commit rule.

## Against the vision note

### V1: Preserve evidence and explicit coverage

Principles 1 and 8 of the [2026-11-05 vision note](../2026-11-05-vision.md) require evidence and naming unexamined coverage. The plan records the identities and reason, an exemption is visibly different from a passing contract, and errors run the full contract. The exemption changes when CI evidence is collected and does not alter the review engine's recorded evidence.

### V2: Keep the real-run gate

Principle 12 still requires a real review before release. Documentation-only exemptions do not replace that review, and all main revisions retain the complete CI tier. No departure from the principle is proposed.

## Verification

actionlint v1.7.12 passed without diagnostics using `actionlint -shellcheck='' -pyflakes='' .github/workflows/check.yml`. The final full ordinary-suite run passed all 23 policy cases, including real Git history and merge-only changes, malformed inventories, event restrictions and status failures. `npm run check` passed lint, typecheck and 3,736 cases: 3,723 passed, 13 skipped, zero failed and zero canceled. The command took 578.707 s; the runner reported 554.699 s. `npm run verify` matched both distribution artifacts. These are single verification timings, not an elapsed-time improvement measurement.

Validation used an isolated checkout with committed source and role inputs plus this change, excluding the separately prepared bounded-path-scan implementation and unrelated role work. A preliminary verification was stopped before finalizing the event/numeric gates and merge-only regression; its retained logs are excluded from the final result. The final frozen inputs were checked once. The author keeps the full logs outside the repository, with results and counts in the [measurement data](../reports/2026-11-08-test-time-measurements.json).

The branch-protection query returned HTTP 401, so no settings were inspected or changed. No local contract run was required because engine stop, resume, launch and ledger behavior are unchanged. No PR, manual or scheduled CI run and no real review was triggered; live exemptions, fallbacks, cancellation behavior and net runner savings remain unobserved. Principle 12 still requires the real review before release.
