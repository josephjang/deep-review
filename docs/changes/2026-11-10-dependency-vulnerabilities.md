# Change Proposal: Patch the vulnerable validation and lint dependencies

## Why

deep-review uses Zod to validate worker answers and checkpoint events, and its development tools use minimatch to match file patterns. [Dependabot alert 1](https://github.com/josephjang/deep-review/security/dependabot/1) names a high-severity memory exhaustion vulnerability in Zod 4.6.5 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)). [Alert 3](https://github.com/josephjang/deep-review/security/dependabot/3) names a denial of service vulnerability in minimatch 10.2.6 ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)). The alert pages require repository security access; the public advisories and the vulnerable versions in the committed lockfile before this change provide the evidence. The installed Claude Code plugin and Codex skill bundle Zod, so changing the dependency alone leaves users with the vulnerable code until both artifacts are rebuilt.

## Requirements

### R1: Install patched versions reproducibly

Pin Zod to 4.6.7, which includes the fix released in 4.6.6, and override minimatch to 11.0.5, which includes the fix released in 11.0.1. Regenerate the lockfile with npm and prove that a clean install has no dependency audit findings. Keep unrelated direct dependencies at their current versions.

### R2: Ship the patched validator

Rebuild both engine artifacts from the sources with the patched Zod dependency. Verify the resulting artifacts byte for byte and preserve the existing checkpoint event schemas, role prompts and CLI interface.

## Decisions

### D1: Override the transitive matcher until its callers support a patched major

At the time of this proposal, even the latest ESLint 10.14.0 and typescript-eslint 8.72.2 require minimatch 10. The advisory names no patched version in that major. Use one exact npm override for minimatch rather than downgrade the lint stack or add a direct dependency that the engine never imports. Version 11 supports the repository's Node 26 requirement. Accept that the override crosses the callers' declared major range, with the repository's full lint run and CI on Linux, macOS and Windows checking compatibility. Remove the override when the lint stack's declared ranges resolve to patched versions.

### D2: Verify compatibility through the existing checks and a real review

Run a clean install, the dependency audit, the full lint, typecheck and test suite, the resumable-run contract, the build and artifact verification. Run deep-review on the change before merging, as principle 12 requires, and require the PR's CI checks to pass. A dependency-only change needs no new engine behavior or event schema.

## Non-goals

### N1: No unrelated dependency refresh or review behavior redesign

Do not update the other direct dependencies, add audit automation, change the ledger schemas, or redesign the engine's validation. The dependency fixes supply the upstream protections while the existing tests check the engine's compatibility.

## Risks

### K1: Upstream validation and glob matching can change

The patched validator can reject oversized collections earlier, and the transitive matcher moves to a new major. Existing schema, checkpoint compatibility and lint checks must pass before merge. CI checks the dependency installation and artifacts on all three supported operating systems; a passing audit alone does not prove behavioral compatibility.

## Against the vision note

### V1: Evidence and the real-run gate stay intact

This proposal follows principles 1 and 12 of the [2026-11-05 vision note](../2026-11-05-vision.md): the upstream advisories identify the vulnerable versions, the audit checks their removal, and a real review exercises the updated engine. It changes no review decision, question, report or approval flow and departs from no principle.

## Verification

`npm ci` passed with the updated lockfile. `npm ls zod minimatch` resolved Zod 4.6.7 and minimatch 11.0.5 for all three lint-stack callers, with no vulnerable version left in the installed tree.

`npm audit` passed with zero findings at every severity: informational, low, moderate, high and critical.

`npm run check` passed lint and typecheck, with 3,774 tests passing, 13 skipped and none failing out of 3,787 tests. The existing checkpoint compatibility tests passed without an event schema or fixture change.

`npm run test:contract` passed all 109 tests, with none skipped or failing, across the four groups of resumable-run scenarios.

`npm run build` rebuilt both shipped engine bundles with Zod 4.6.7. `npm run verify` passed for both artifacts. A Node probe of `z.array(z.string()).max(4).safeParse(Array(100000).fill(0))` returned one `too_big` issue, confirming rejection at the collection bound before element validation.

A real `npm run review -- review --runtime claude --pr 134` completed with all ten finder angles and no unverified groups. It selected three documentation fixes and no code fixes, left the validator's early rejection and the audit automation non-goal as intended, and left the existing uncapped schemas and answer-size limits as pre-existing concerns outside this change. The lint compatibility verifier checked all 331 tracked TypeScript and JavaScript module files: none were missing or extra, the test-specific rules still applied, and build output stayed ignored.

The author keeps the full command logs, review ledger and probes outside the repository. [Pull request 134](https://github.com/josephjang/deep-review/pull/134) carries the CI outcomes; the final head must pass the checks and contract on Linux, macOS and Windows before merge.
