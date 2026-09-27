/**
 * The role policy (R3 of the read-only review): one file, `roles/policy.json`,
 * names for every role the review runs its tier, effort, per-worker budget
 * and timeout, and for every runtime the model behind each tier and the
 * default run budget. `resolvePolicy` turns it, the assembled roles, one
 * runtime and the command's flags into the values a run pins on its ledger.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { effortSchema, type PinnedRole } from '../checkpoint/events.ts';
import type { RuntimeAdapter } from '../runtime/adapter.ts';
import { maxBudgetUsd, maxTimeoutMs } from '../runtime/contract.ts';
import type { AssembledRole } from '../roles/assemble.ts';
import { roleKeySchema } from '../roles/manifest.ts';
import { InvalidPolicyError } from './errors.ts';
import { angles, roleOfAngle } from './vocabulary.ts';

/** The policy's file name under the roles root. */
export const policyFileName = 'policy.json';

/** The two tiers a role may run in; which model each is comes from the runtime's entry or the command's flags. */
export const tiers = ['strong', 'fast'] as const;
export const tierSchema = z.enum(tiers);
export type Tier = z.infer<typeof tierSchema>;

/** The roles the read-only review runs, in phase order: the policy must name exactly these. */
export const reviewRoles: readonly string[] = [...angles.map(roleOfAngle), 'deduplication', 'verifier', 'sweep', 'merge-rank'];

export const rolePolicySchema = z.strictObject({
  tier: tierSchema,
  effort: effortSchema,
  /** The per-worker cap in US dollars; ignored, as null, on a runtime that cannot stop a worker at a budget. */
  budgetUsd: z.number().positive().max(maxBudgetUsd),
  timeoutMs: z.number().int().min(1000).max(maxTimeoutMs),
});
export type RolePolicy = z.infer<typeof rolePolicySchema>;

export const runtimePolicySchema = z.strictObject({
  strong: z.string().min(1).refine((model) => !model.startsWith('-'), 'a model name must not start with a dash'),
  fast: z.string().min(1).refine((model) => !model.startsWith('-'), 'a model name must not start with a dash'),
  /** The default run budget in US dollars, or null for none; a runtime that reports no cost has null. */
  runBudgetUsd: z.number().positive().nullable(),
});
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;

export const policyFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roles: z.record(roleKeySchema, rolePolicySchema),
  runtimes: z.record(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), runtimePolicySchema),
  concurrency: z.number().int().min(1).max(16),
});
export type PolicyFile = z.infer<typeof policyFileSchema>;

/** What the command line may change about a run's policy. */
export interface PolicyFlags {
  readonly strongModel?: string;
  readonly fastModel?: string;
  readonly concurrency?: number;
  readonly budgetUsd?: number;
}

/** The policy as resolved for one runtime: what `review.configured` records, less the executable and version the command adds. */
export interface ResolvedPolicy {
  readonly runtime: string;
  readonly models: { readonly strong: string; readonly fast: string };
  readonly roles: readonly PinnedRole[];
  readonly rolesDigest: string;
  readonly concurrency: number;
  readonly runBudgetUsd: number | null;
}

/** Parse a policy file's JSON value, naming every problem in one error. */
export function parsePolicy(value: unknown): PolicyFile {
  const parsed = policyFileSchema.safeParse(value);
  if (!parsed.success) throw new InvalidPolicyError(`Invalid role policy: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Read and validate `<rolesRoot>/policy.json`. */
export function readPolicy(rolesRoot: string): PolicyFile {
  const path = join(rolesRoot, policyFileName);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new InvalidPolicyError(`Cannot read the role policy at ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InvalidPolicyError(`The role policy at ${path} is not JSON: ${(error as Error).message}`);
  }
  return parsePolicy(value);
}

/** SHA-256 over the sorted `roleKey:sha256` lines of the assembled roles, so a run says which prompts it ran. */
export function rolesDigest(roles: readonly Pick<AssembledRole, 'key' | 'sha256'>[]): string {
  const lines = roles.map((role) => `${role.key}:${role.sha256}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Hold the policy to the manifest and the runtime, and resolve it for one
 * run: the policy must name exactly the roles the review runs, each of
 * which the manifest must declare; every effort must be one the runtime
 * has; the runtime must have an entry. Models come from the flags, else
 * the runtime's entry; the run budget from the flag, else the entry; the
 * per-role budget is null on a runtime that cannot stop a worker at a
 * budget, since the launcher would refuse it. A `--budget-usd` on a
 * runtime that reports no cost is refused rather than ignored: the check
 * it would set could never run.
 */
export function resolvePolicy(policy: PolicyFile, roles: readonly AssembledRole[], adapter: RuntimeAdapter, flags: PolicyFlags = {}): ResolvedPolicy {
  const named = Object.keys(policy.roles).sort();
  const expected = [...reviewRoles].sort();
  const missing = expected.filter((role) => !named.includes(role));
  const extra = named.filter((role) => !expected.includes(role));
  if (missing.length > 0 || extra.length > 0) {
    const problems = [
      ...(missing.length > 0 ? [`does not name ${missing.join(', ')}`] : []),
      ...(extra.length > 0 ? [`names ${extra.join(', ')}, which the review does not run`] : []),
    ];
    throw new InvalidPolicyError(`The role policy must name exactly the roles the review runs: it ${problems.join(' and ')}`);
  }
  const declared = new Set(roles.map((role) => role.key));
  const undeclared = named.filter((role) => !declared.has(role));
  if (undeclared.length > 0) throw new InvalidPolicyError(`The role policy names ${undeclared.join(', ')}, which the role manifest does not declare`);

  const runtime = policy.runtimes[adapter.name];
  if (runtime === undefined) throw new InvalidPolicyError(`The role policy has no entry for runtime ${adapter.name}; it has ${Object.keys(policy.runtimes).sort().join(', ')}`);
  const { capabilities } = adapter;
  for (const [role, entry] of Object.entries(policy.roles)) {
    if (!capabilities.effortLevels.includes(entry.effort)) {
      throw new InvalidPolicyError(`The role policy runs ${role} at effort ${entry.effort}, which runtime ${adapter.name} lacks; it has ${capabilities.effortLevels.join(', ')}`);
    }
  }
  if (flags.budgetUsd !== undefined && !capabilities.costInUsd) {
    throw new InvalidPolicyError(`--budget-usd does not apply to runtime ${adapter.name}, which reports no cost in USD; the run has no budget there`);
  }
  if (flags.concurrency !== undefined && (!Number.isInteger(flags.concurrency) || flags.concurrency < 1 || flags.concurrency > 16)) {
    throw new InvalidPolicyError(`--concurrency must be a whole number from 1 to 16, not ${String(flags.concurrency)}`);
  }
  if (flags.budgetUsd !== undefined && !(Number.isFinite(flags.budgetUsd) && flags.budgetUsd > 0)) {
    throw new InvalidPolicyError(`--budget-usd must be a positive number, not ${String(flags.budgetUsd)}`);
  }
  for (const [flag, model] of [['--strong-model', flags.strongModel], ['--fast-model', flags.fastModel]] as const) {
    if (model !== undefined && (model.length === 0 || model.startsWith('-') || model.includes('\0'))) throw new InvalidPolicyError(`${flag} must be a model name, not ${JSON.stringify(model)}`);
  }

  const models = { strong: flags.strongModel ?? runtime.strong, fast: flags.fastModel ?? runtime.fast };
  const pinned: PinnedRole[] = reviewRoles.map((role) => {
    const entry = policy.roles[role]!;
    return { role, model: models[entry.tier], effort: entry.effort, budgetUsd: capabilities.budgetCap ? entry.budgetUsd : null, timeoutMs: entry.timeoutMs };
  });
  return {
    runtime: adapter.name,
    models,
    roles: pinned,
    rolesDigest: rolesDigest(roles),
    concurrency: flags.concurrency ?? policy.concurrency,
    runBudgetUsd: capabilities.costInUsd ? (flags.budgetUsd ?? runtime.runBudgetUsd) : null,
  };
}

/** The pinned values of one role, from a resolved or recorded policy; the role must be one the policy pinned. */
export function pinnedRole(roles: readonly PinnedRole[], role: string): PinnedRole {
  const found = roles.find((candidate) => candidate.role === role);
  if (found === undefined) throw new InvalidPolicyError(`The run's policy pins no role ${role}; it pins ${roles.map((candidate) => candidate.role).join(', ')}`);
  return found;
}
