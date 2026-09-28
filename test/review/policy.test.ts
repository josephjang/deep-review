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

const roles = assembleRoles(repositoryRolesRoot());
const committed = readPolicy(repositoryRolesRoot());

/** A copy of the committed policy with one part changed. */
const changed = (change: (policy: { roles: Record<string, Record<string, unknown>>; runtimes: Record<string, Record<string, unknown>>; concurrency: number; schemaVersion: number }) => void): PolicyFile => {
  const copy = structuredClone(committed) as unknown as { roles: Record<string, Record<string, unknown>>; runtimes: Record<string, Record<string, unknown>>; concurrency: number; schemaVersion: number };
  change(copy);
  return copy as unknown as PolicyFile;
};

describe('the committed roles/policy.json', () => {
  it('names exactly the fourteen roles the review runs, and only the two runtimes', () => {
    assert.deepEqual(Object.keys(committed.roles).sort(), [...reviewRoles].sort());
    assert.equal(reviewRoles.length, 14);
    assert.deepEqual(reviewRoles, ['triage', 'finder-REMOVALS', 'finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY', 'finder-DESIGN', 'finder-DUPLICATION', 'finder-ALTITUDE', 'finder-CONVENTIONS', 'deduplication', 'verifier', 'sweep', 'merge-rank'], 'the role of every angle in launch order, then the roles of the later phases');
    assert.deepEqual(Object.keys(committed.runtimes).sort(), ['claude', 'codex']);
    assert.equal(committed.concurrency, 4);
  });

  it('carries the proof of concept\'s values: strong analyst and lead roles, fast scouts, medium CONVENTIONS, 8 USD and 600 s each', () => {
    for (const [role, entry] of Object.entries(committed.roles)) {
      assert.equal(entry.budgetUsd, 8, role);
      assert.equal(entry.timeoutMs, 600_000, role);
      const scout = ['finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY', 'finder-DUPLICATION', 'finder-CONVENTIONS'].includes(role);
      assert.equal(entry.tier, scout ? 'fast' : 'strong', role);
      assert.equal(entry.effort, role === 'finder-CONVENTIONS' ? 'medium' : 'high', role);
    }
    assert.deepEqual(committed.runtimes.claude, { strong: 'opus', fast: 'sonnet', runBudgetUsd: 30 });
    assert.equal(committed.runtimes.codex?.runBudgetUsd, null);
  });

  it('resolves for Claude with per-worker budgets and the run budget', () => {
    const resolved = resolvePolicy(committed, roles, claudeAdapter);
    assert.equal(resolved.runtime, 'claude');
    assert.deepEqual(resolved.models, { strong: 'opus', fast: 'sonnet' });
    assert.equal(resolved.concurrency, 4);
    assert.equal(resolved.runBudgetUsd, 30);
    assert.deepEqual(resolved.roles.map((role) => role.role), reviewRoles);
    assert.deepEqual(pinnedRole(resolved.roles, 'finder-RIPPLE'), { role: 'finder-RIPPLE', model: 'sonnet', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 });
    assert.deepEqual(pinnedRole(resolved.roles, 'finder-CONVENTIONS'), { role: 'finder-CONVENTIONS', model: 'sonnet', effort: 'medium', budgetUsd: 8, timeoutMs: 600_000 });
    assert.deepEqual(pinnedRole(resolved.roles, 'verifier'), { role: 'verifier', model: 'opus', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 });
    assert.equal(resolved.rolesDigest, rolesDigest(roles));
  });

  it('resolves for Codex with no per-worker budget and no run budget, since Codex caps nothing and reports no cost', () => {
    const resolved = resolvePolicy(committed, roles, codexAdapter);
    assert.equal(resolved.runtime, 'codex');
    assert.deepEqual(resolved.models, { strong: 'gpt-6-astra', fast: 'gpt-5.6-terra' });
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
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: 0 }), /--concurrency must be a whole number from 1 to 16, not 0/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: 17 }), /--concurrency/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { concurrency: 2.5 }), /--concurrency/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { budgetUsd: 0 }), /--budget-usd must be a positive number, not 0/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { budgetUsd: NaN }), /--budget-usd must be a positive number/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { strongModel: '' }), /--strong-model must be a model name/);
    assert.throws(() => resolvePolicy(committed, roles, claudeAdapter, { fastModel: '--verbose' }), /--fast-model must be a model name/);
  });
});

describe('resolvePolicy against the manifest and the runtime', () => {
  it('refuses a policy that lacks a role the review runs, naming it', () => {
    const policy = changed((copy) => { delete copy.roles.sweep; });
    assert.throws(() => resolvePolicy(policy, roles, claudeAdapter), /must name exactly the roles the review runs: it does not name sweep$/);
  });

  it('refuses a policy that names a role the review does not run, even one the manifest declares', () => {
    const policy = changed((copy) => { copy.roles.fixer = { tier: 'strong', effort: 'high', budgetUsd: 8, timeoutMs: 600_000 }; });
    assert.throws(() => resolvePolicy(policy, roles, claudeAdapter), /names fixer, which the review does not run/);
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
    ['a concurrency above sixteen', (copy) => { copy.concurrency = 17; }, /concurrency/],
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
  });

  it('is one digest over every role, not only the fourteen the review runs', () => {
    assert.notEqual(rolesDigest(roles), rolesDigest(roles.filter((role) => (reviewRoles as readonly string[]).includes(role.key))));
    assert.equal(finderAngles.length + 5, reviewRoles.length);
  });
});

describe('pinnedRole', () => {
  it('names the role it cannot find and the roles it has', () => {
    const resolved = resolvePolicy(committed, roles, claudeAdapter);
    assert.throws(() => pinnedRole(resolved.roles, 'fixer'), /pins no role fixer; it pins triage, finder-REMOVALS/);
  });
});
