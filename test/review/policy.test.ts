import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assembleRoles, repositoryRolesRoot, type AssembledRole } from '../../src/roles/assemble.ts';
import { InvalidPolicyError } from '../../src/review/errors.ts';
import { parsePolicy, pinnedRole, policyFileName, readPolicy, resolvePolicy, rolesDigest, type PolicyFile } from '../../src/review/policy.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { codexAdapter } from '../../src/runtime/codex.ts';
import { finderAngles, reviewRoles } from '../../src/review/vocabulary.ts';
import { limitsChangedV1, reviewConfiguredV1, reviewConfiguredV2, reviewConfiguredV3 } from '../../src/checkpoint/events.ts';
import { maxTimeoutMs } from '../../src/runtime/contract.ts';
import { invocationFlagProblem, maxBatchSize, maxConcurrency, refuseInvocationFlags } from '../../src/review/policy.ts';
import { configurationV1 } from '../helpers/review-history.ts';

const roles = assembleRoles(repositoryRolesRoot());
const committed = readPolicy(repositoryRolesRoot());

/** A copy of the committed policy with one part changed. */
const changed = (change: (policy: { roles: Record<string, Record<string, unknown>>; runtimes: Record<string, Record<string, unknown>>; concurrency: number; schemaVersion: number }) => void): PolicyFile => {
  const copy = structuredClone(committed) as unknown as { roles: Record<string, Record<string, unknown>>; runtimes: Record<string, Record<string, unknown>>; concurrency: number; schemaVersion: number };
  change(copy);
  return copy as unknown as PolicyFile;
};

describe('the committed roles/policy.json', () => {
  it('names exactly the sixteen roles the review runs, the checks block, and only the two runtimes', () => {
    assert.deepEqual(Object.keys(committed.roles).sort(), [...reviewRoles].sort());
    assert.equal(reviewRoles.length, 16);
    assert.deepEqual(reviewRoles, ['surveyor', 'triage', 'finder-REMOVALS', 'finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY', 'finder-DESIGN', 'finder-DUPLICATION', 'finder-ALTITUDE', 'finder-CONVENTIONS', 'deduplication', 'verifier', 'sweep', 'merge-rank', 'fixer'], 'the survey\'s role, the role of every angle in launch order, then the roles of the later phases and the fix pass');
    assert.deepEqual(committed.checks, { timeoutMs: 1_200_000 });
    assert.deepEqual(Object.keys(committed.runtimes).sort(), ['claude', 'codex']);
    assert.equal(committed.concurrency, 4);
  });

  it('carries the proof of concept\'s values, with the gate\'s for the fixer and Claude\'s budget: strong analyst and lead roles, fast scouts, medium CONVENTIONS and surveyor, 8 USD each, 600 s for a reader and 1800 s for the fixer, 60 USD a Claude run', () => {
    for (const [role, entry] of Object.entries(committed.roles)) {
      assert.equal(entry.budgetUsd, 8, role);
      // A fixer runs the suite against the unfixed code, the fixed code and a mutation; on the gate a Codex batch needed 1125 s and one ran past 1200 s (R12, R25 of the fix pass).
      assert.equal(entry.timeoutMs, role === 'fixer' ? 1_800_000 : 600_000, role);
      const scout = ['finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY', 'finder-DUPLICATION', 'finder-CONVENTIONS'].includes(role);
      assert.equal(entry.tier, scout ? 'fast' : 'strong', role);
      // The surveyor reads and picks commands that steer the whole fix pass: the strong model, at medium effort (Policy of the repository survey).
      assert.equal(entry.effort, role === 'finder-CONVENTIONS' || role === 'surveyor' ? 'medium' : 'high', role);
    }
    // A Claude fix run on the gate spent 29.07 USD (R26 of the fix pass).
    assert.deepEqual(committed.runtimes.claude, { strong: 'opus', fast: 'sonnet', runBudgetUsd: 60 });
    assert.equal(committed.runtimes.codex?.runBudgetUsd, null);
  });

  it('refuses a policy without the fixer or without the checks block, and a checks timeout outside a worker\'s bounds', () => {
    assert.throws(() => resolvePolicy(changed((copy) => { delete copy.roles.fixer; }), roles, claudeAdapter), /must name exactly the roles the review runs: it does not name fixer$/);
    assert.throws(() => parsePolicy(changed((copy) => { delete (copy as { checks?: unknown }).checks; })), (error: unknown) => error instanceof InvalidPolicyError && /checks/.test(error.message));
    for (const timeoutMs of [999, maxTimeoutMs + 1, 1.5]) {
      assert.throws(() => parsePolicy(changed((copy) => { (copy as { checks?: unknown }).checks = { timeoutMs }; })), InvalidPolicyError, String(timeoutMs));
    }
    assert.deepEqual(resolvePolicy(committed, roles, claudeAdapter).checks, { timeoutMs: 1_200_000 }, 'the resolved policy carries the checks block a fixing run pins');
  });

  it('gives a fixer batch four findings, and refuses a policy without the fixes block or with a batch size outside 1 to 20', () => {
    assert.deepEqual(committed.fixes, { batchSize: 4 });
    assert.deepEqual(resolvePolicy(committed, roles, claudeAdapter).fixes, { batchSize: 4 }, 'the resolved policy carries the batch size a fixing run pins');
    assert.throws(() => parsePolicy(changed((copy) => { delete (copy as { fixes?: unknown }).fixes; })), (error: unknown) => error instanceof InvalidPolicyError && /fixes/.test(error.message));
    for (const batchSize of [0, maxBatchSize + 1, 1.5, -4]) {
      assert.throws(() => parsePolicy(changed((copy) => { (copy as { fixes?: unknown }).fixes = { batchSize }; })), InvalidPolicyError, String(batchSize));
    }
    for (const batchSize of [1, maxBatchSize]) assert.equal(parsePolicy(changed((copy) => { (copy as { fixes?: unknown }).fixes = { batchSize }; })).fixes.batchSize, batchSize);
    assert.throws(() => parsePolicy(changed((copy) => { (copy as { fixes?: unknown }).fixes = { batchSize: 4, extra: 1 }; })), InvalidPolicyError, 'the block is closed');
  });

  it('judges the reviewer\'s own rules by default, carries the setting to the resolved policy, and refuses a policy without it or with another value (R3, PD7 of the repository survey)', () => {
    assert.deepEqual(committed.survey, { userRules: 'judge' });
    assert.deepEqual(resolvePolicy(committed, roles, claudeAdapter).survey, { userRules: 'judge' });
    for (const userRules of ['ignore', 'apply', 'judge'] as const) {
      assert.deepEqual(resolvePolicy(parsePolicy(changed((copy) => { (copy as { survey?: unknown }).survey = { userRules }; })), roles, codexAdapter).survey, { userRules }, userRules);
    }
    assert.throws(() => parsePolicy(changed((copy) => { delete (copy as { survey?: unknown }).survey; })), (error: unknown) => error instanceof InvalidPolicyError && /survey/.test(error.message));
    assert.throws(() => parsePolicy(changed((copy) => { (copy as { survey?: unknown }).survey = { userRules: 'always' }; })), InvalidPolicyError);
    assert.throws(() => parsePolicy(changed((copy) => { (copy as { survey?: unknown }).survey = { userRules: 'judge', extra: 1 }; })), InvalidPolicyError, 'the block is closed');
    assert.throws(() => resolvePolicy(changed((copy) => { delete copy.roles.surveyor; }), roles, claudeAdapter), /it does not name surveyor$/);
  });

  it('resolves for Claude with per-worker budgets and the run budget', () => {
    const resolved = resolvePolicy(committed, roles, claudeAdapter);
    assert.equal(resolved.runtime, 'claude');
    assert.deepEqual(resolved.models, { strong: 'opus', fast: 'sonnet' });
    assert.equal(resolved.concurrency, 4);
    assert.equal(resolved.runBudgetUsd, 60);
    assert.deepEqual(resolved.roles.map((role) => role.role), reviewRoles);
    assert.deepEqual(pinnedRole(resolved.roles, 'finder-RIPPLE'), { role: 'finder-RIPPLE', model: 'sonnet', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 });
    assert.deepEqual(pinnedRole(resolved.roles, 'finder-CONVENTIONS'), { role: 'finder-CONVENTIONS', model: 'sonnet', effort: 'medium', budgetUsd: 8, timeoutMs: 600_000 });
    assert.deepEqual(pinnedRole(resolved.roles, 'verifier'), { role: 'verifier', model: 'opus', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 });
    assert.equal(resolved.rolesDigest, rolesDigest(roles));
  });

  it('resolves for Codex with no per-worker budget and no run budget, since Codex caps nothing and reports no cost', () => {
    const resolved = resolvePolicy(committed, roles, codexAdapter);
    assert.equal(resolved.runtime, 'codex');
    // The fast tier is the workhorse codex-cli 0.160.0's catalog lists first, near Astra on agentic coding (the survey's gate, 2026-10-04).
    assert.deepEqual(resolved.models, { strong: 'gpt-6-astra', fast: 'gpt-6.1-sol' });
    assert.equal(resolved.runBudgetUsd, null);
    assert.ok(resolved.roles.every((role) => role.budgetUsd === null));
    assert.equal(pinnedRole(resolved.roles, 'triage').model, 'gpt-6-astra');
  });

  it('lets the flags override the models, the concurrency and the run budget', () => {
    const resolved = resolvePolicy(committed, roles, claudeAdapter, { strongModel: 'claude-opus-5-5', fastModel: 'claude-sonnet-5', concurrency: 2, budgetUsd: 45.5 });
    assert.deepEqual(resolved.models, { strong: 'claude-opus-5-5', fast: 'claude-sonnet-5' });
    assert.equal(pinnedRole(resolved.roles, 'triage').model, 'claude-opus-5-5');
    assert.equal(pinnedRole(resolved.roles, 'finder-RIPPLE').model, 'claude-sonnet-5');
    assert.equal(resolved.concurrency, 2);
    assert.equal(resolved.runBudgetUsd, 45.5);
  });

  it('refuses --budget-usd on a runtime that reports no cost, rather than ignoring it', () => {
    assert.throws(() => resolvePolicy(committed, roles, codexAdapter, { budgetUsd: 10 }), (error: unknown) => error instanceof InvalidPolicyError && /--budget-usd does not apply to runtime codex/.test(error.message));
    assert.equal(resolvePolicy(committed, roles, codexAdapter, { concurrency: 1 }).concurrency, 1);
  });

  it('refuses malformed flags by name', () => {
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: 0 }), new RegExp(`--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not 0`));
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: maxConcurrency + 1 }), /--concurrency/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: 2.5 }), /--concurrency/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { budgetUsd: 0 }), /--budget-usd must be a positive number, not 0/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { budgetUsd: NaN }), /--budget-usd must be a positive number/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { strongModel: '' }), /--strong-model must be a model name/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { fastModel: '--verbose' }), /--fast-model must be a model name/);
  });
});

describe('the per-invocation flags', () => {
  it('finds no problem with no flag, nor with either at its bounds', () => {
    assert.equal(invocationFlagProblem({}), null);
    assert.equal(invocationFlagProblem({ concurrency: 1, budgetUsd: 0.01 }), null);
    assert.equal(invocationFlagProblem({ concurrency: maxConcurrency }), null);
  });

  it('names a concurrency outside 1 to the bound, or not whole, with its value', () => {
    for (const value of [0, maxConcurrency + 1, 2.5]) {
      assert.equal(invocationFlagProblem({ concurrency: value }), `--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not ${String(value)}`);
    }
  });

  it('names a run budget that is not a positive number, with its value', () => {
    for (const value of [0, -1, Infinity, NaN]) {
      assert.equal(invocationFlagProblem({ budgetUsd: value }), `--budget-usd must be a positive number, not ${String(value)}`);
    }
  });

  it('refuses a budget on a runtime that reports no cost before it looks at the value of the budget, and a malformed flag as InvalidPolicyError', () => {
    assert.throws(() => refuseInvocationFlags(codexAdapter, { budgetUsd: 0 }), (error: unknown) => error instanceof InvalidPolicyError && error.message === '--budget-usd does not apply to runtime codex, which reports no cost in USD; the run has no budget there');
    assert.throws(() => refuseInvocationFlags(claudeAdapter, { budgetUsd: 0 }), (error: unknown) => error instanceof InvalidPolicyError && error.message === '--budget-usd must be a positive number, not 0');
    assert.throws(() => refuseInvocationFlags(codexAdapter, { concurrency: 0 }), (error: unknown) => error instanceof InvalidPolicyError && error.message === `--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not 0`);
    assert.doesNotThrow(() => refuseInvocationFlags(codexAdapter, { concurrency: maxConcurrency }));
    assert.doesNotThrow(() => refuseInvocationFlags(claudeAdapter, { concurrency: 1, budgetUsd: 5 }));
  });

  it('holds the policy file and resolvePolicy to the same bound', () => {
    assert.equal(parsePolicy(changed((copy) => { copy.concurrency = maxConcurrency; })).concurrency, maxConcurrency);
    assert.throws(() => parsePolicy(changed((copy) => { copy.concurrency = maxConcurrency + 1; })), (error: unknown) => error instanceof InvalidPolicyError && /concurrency/.test(error.message));
    assert.equal(resolvePolicy(committed, roles, claudeAdapter, { concurrency: maxConcurrency }).concurrency, maxConcurrency);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: maxConcurrency + 1 }), (error: unknown) => error instanceof InvalidPolicyError && error.message === `--concurrency must be a whole number from 1 to ${String(maxConcurrency)}, not ${String(maxConcurrency + 1)}`);
  });

  /** The configuration as version 2 records it, before the survey: version 1's, without the fix pass. */
  const configurationV2 = { ...configurationV1, fix: false, checks: null, fixes: null };
  /** The configuration as version 3 records it, with the survey's setting. */
  const configurationV3 = { ...configurationV2, survey: { userRules: 'judge' } };

  it('is the bound the frozen v1 events accept, so every concurrency a run may be given can be recorded', () => {
    for (let concurrency = 1; concurrency <= maxConcurrency; concurrency += 1) {
      assert.ok(reviewConfiguredV1.safeParse({ ...configurationV1, concurrency }).success, `review.configured@1 with concurrency ${String(concurrency)}`);
      assert.ok(reviewConfiguredV2.safeParse({ ...configurationV2, concurrency }).success, `review.configured@2 with concurrency ${String(concurrency)}`);
      assert.ok(reviewConfiguredV3.safeParse({ ...configurationV3, concurrency }).success, `review.configured@3 with concurrency ${String(concurrency)}`);
      assert.ok(limitsChangedV1.safeParse({ concurrency, runBudgetUsd: null }).success, `limits.changed@1 with concurrency ${String(concurrency)}`);
    }
    for (const concurrency of [0, maxConcurrency + 1]) {
      assert.ok(!reviewConfiguredV1.safeParse({ ...configurationV1, concurrency }).success, String(concurrency));
      assert.ok(!reviewConfiguredV2.safeParse({ ...configurationV2, concurrency }).success, String(concurrency));
      assert.ok(!reviewConfiguredV3.safeParse({ ...configurationV3, concurrency }).success, String(concurrency));
      assert.ok(!limitsChangedV1.safeParse({ concurrency, runBudgetUsd: null }).success, String(concurrency));
    }
  });

  it('records every batch size the policy accepts, and pins one exactly when the run fixes', () => {
    for (const [version, schema, base] of [[2, reviewConfiguredV2, configurationV2], [3, reviewConfiguredV3, configurationV3]] as const) {
      const fixing = { ...base, fix: true, checks: { timeoutMs: 1_200_000 } };
      for (let batchSize = 1; batchSize <= maxBatchSize; batchSize += 1) {
        assert.ok(schema.safeParse({ ...fixing, fixes: { batchSize } }).success, `review.configured@${String(version)} with batch size ${String(batchSize)}`);
      }
      for (const batchSize of [0, maxBatchSize + 1, 2.5]) assert.ok(!schema.safeParse({ ...fixing, fixes: { batchSize } }).success, String(batchSize));
      assert.ok(!schema.safeParse({ ...fixing, fixes: null }).success, 'a fixing run without a batch size');
      assert.ok(!schema.safeParse({ ...base, fixes: { batchSize: 4 } }).success, 'a read-only run with a batch size');
      assert.ok(schema.safeParse(base).success, 'a read-only run pins none');
    }
  });

  it('pins the survey\'s setting from version 3 on, and only one of its three values', () => {
    assert.ok(!reviewConfiguredV2.safeParse(configurationV3).success, 'version 2 has no survey setting');
    assert.ok(!reviewConfiguredV3.safeParse(configurationV2).success, 'version 3 requires it');
    for (const userRules of ['ignore', 'apply', 'judge']) assert.ok(reviewConfiguredV3.safeParse({ ...configurationV2, survey: { userRules } }).success, userRules);
    assert.ok(!reviewConfiguredV3.safeParse({ ...configurationV2, survey: { userRules: 'never' } }).success);
  });
});

describe('resolvePolicy against the manifest and the runtime', () => {
  it('refuses a policy that lacks a role the review runs, naming it', () => {
    const policy = changed((copy) => { delete copy.roles.sweep; });
    assert.throws(() => resolvePolicy(policy, roles, claudeAdapter), /must name exactly the roles the review runs: it does not name sweep$/);
  });

  it('refuses a policy that names a role the review does not run, even one the manifest declares', () => {
    const policy = changed((copy) => { copy.roles.documentation = { tier: 'strong', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 }; });
    assert.throws(() => resolvePolicy(policy, roles, claudeAdapter), /names documentation, which the review does not run/);
    const both = changed((copy) => {
      delete copy.roles.sweep;
      copy.roles.auditor = { tier: 'strong', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 };
    });
    assert.throws(() => resolvePolicy(both, roles, claudeAdapter), /does not name sweep and names auditor/);
  });

  it('refuses a policy role the manifest does not declare', () => {
    const withoutSweep = roles.filter((role) => role.key !== 'sweep');
    assert.throws(() => resolvePolicy(committed, withoutSweep, claudeAdapter), /names sweep, which the role manifest does not declare/);
  });

  it('refuses an effort the runtime lacks, before any run exists', () => {
    const policy = changed((copy) => { copy.roles.verifier!.effort = 'max'; });
    assert.equal(resolvePolicy(policy, roles, claudeAdapter).roles.find((role) => role.role === 'verifier')?.effort, 'max');
    assert.throws(() => resolvePolicy(policy, roles, codexAdapter), /runs verifier at effort max, which runtime codex lacks; it has low, medium, high, xhigh/);
  });

  it('refuses a runtime the policy has no entry for', () => {
    const policy = changed((copy) => { delete copy.runtimes.codex; });
    assert.throws(() => resolvePolicy(policy, roles, codexAdapter), /no entry for runtime codex; it has claude/);
  });
});

describe('parsePolicy', () => {
  const invalid: [string, (copy: Parameters<typeof changed>[0] extends (policy: infer P) => void ? P : never) => void, RegExp][] = [
    ['another schema version', (copy) => { copy.schemaVersion = 2; }, /schemaVersion/],
    ['a role key that is not one', (copy) => { copy.roles['two words'] = copy.roles.triage!; }, /Invalid key in record/],
    ['an unknown tier', (copy) => { copy.roles.triage!.tier = 'medium'; }, /tier/],
    ['an unknown effort', (copy) => { copy.roles.triage!.effort = 'extreme'; }, /effort/],
    ['a zero budget', (copy) => { copy.roles.triage!.budgetUsd = 0; }, /budgetUsd/],
    ['a budget above the launcher\'s cap', (copy) => { copy.roles.triage!.budgetUsd = 101; }, /budgetUsd/],
    ['a timeout above one hour', (copy) => { copy.roles.triage!.timeoutMs = 3_600_001; }, /timeoutMs/],
    ['a timeout under a second', (copy) => { copy.roles.triage!.timeoutMs = 999; }, /timeoutMs/],
    ['an unknown role field', (copy) => { copy.roles.triage!.shell = true; }, /shell/],
    ['a model that reads as an option', (copy) => { copy.runtimes.claude!.strong = '--model'; }, /dash/],
    ['a runtime name in the wrong shape', (copy) => { copy.runtimes.Claude = copy.runtimes.claude!; }, /runtimes/],
    ['a negative run budget', (copy) => { copy.runtimes.claude!.runBudgetUsd = -1; }, /runBudgetUsd/],
    ['a concurrency of zero', (copy) => { copy.concurrency = 0; }, /concurrency/],
    ['a concurrency above the bound', (copy) => { copy.concurrency = maxConcurrency + 1; }, /concurrency/],
  ];
  for (const [name, change, message] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parsePolicy(changed(change)), (error: unknown) => error instanceof InvalidPolicyError && message.test(error.message));
    });
  }

  it('refuses a value that is not an object', () => {
    assert.throws(() => parsePolicy(null), InvalidPolicyError);
    assert.throws(() => parsePolicy([]), InvalidPolicyError);
  });
});

describe('readPolicy', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-policy-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('reads the committed file', () => {
    assert.deepEqual(readPolicy(repositoryRolesRoot()), committed);
  });

  it('refuses a missing file and one that is not JSON, naming the path', () => {
    assert.throws(() => readPolicy(sandbox), (error: unknown) => error instanceof InvalidPolicyError && /Cannot read the role policy at .*policy\.json/.test(error.message));
    mkdirSync(join(sandbox, 'roles'));
    writeFileSync(join(sandbox, 'roles', policyFileName), '{ not json');
    assert.throws(() => readPolicy(join(sandbox, 'roles')), /is not JSON/);
  });
});

describe('rolesDigest', () => {
  const role = (key: string, sha256: string): Pick<AssembledRole, 'key' | 'sha256'> => ({ key, sha256 });

  it('is the same whatever the order of the roles, and changes when one prompt changes', () => {
    const a = rolesDigest([role('triage', 'a'.repeat(64)), role('sweep', 'b'.repeat(64))]);
    assert.equal(a, rolesDigest([role('sweep', 'b'.repeat(64)), role('triage', 'a'.repeat(64))]));
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.notEqual(a, rolesDigest([role('triage', 'a'.repeat(64)), role('sweep', 'c'.repeat(64))]));
    assert.notEqual(a, rolesDigest([role('triage', 'a'.repeat(64))]));
  });

  it('changes when a fragment of the repository changes', () => {
    const before = rolesDigest(roles);
    const edited = roles.map((role) => (role.key === 'finder-RIPPLE' ? { ...role, sha256: '0'.repeat(64) } : role));
    assert.notEqual(rolesDigest(edited), before);
    // The fixer's prompt is one of them, so a changed fixer fragment stops a pinned fix run from resuming under other prompts.
    const fixer = roles.map((role) => (role.key === 'fixer' ? { ...role, sha256: '0'.repeat(64) } : role));
    assert.notEqual(rolesDigest(fixer), before);
  });

  it('is one digest over every role, not only the sixteen the review runs', () => {
    assert.notEqual(rolesDigest(roles), rolesDigest(roles.filter((role) => (reviewRoles as readonly string[]).includes(role.key))));
    assert.equal(finderAngles.length + 7, reviewRoles.length);
  });
});

describe('pinnedRole', () => {
  it('names the role it cannot find and the roles it has', () => {
    const resolved = resolvePolicy(committed, roles, claudeAdapter);
    assert.throws(() => pinnedRole(resolved.roles, 'auditor'), /pins no role auditor; it pins surveyor, triage, finder-REMOVALS/);
  });
});
