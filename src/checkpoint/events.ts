import { z } from 'zod';
import { artifactReferenceSchema } from '../evidence/store.ts';
import { defineRegistry } from './registry.ts';

/** A run exists. Its first and only creation event; the run id is the ledger's, not the payload's. */
export const runCreatedV1 = z.strictObject({
  /** Absolute worktree the run was started from. Informational: the checkpoint is shared by every worktree. */
  worktree: z.string().min(1),
});

/** The run was closed by an operator and accepts no further events. */
export const runAbandonedV1 = z.strictObject({
  reason: z.string().min(1),
});

const commitId = z.string().regex(/^[0-9a-f]{40,64}$/);

/**
 * One state of one file. A blob is stored evidence; an oversized file is
 * recorded by hash and size only, and its key is `size`, not `bytes`, so it
 * is never mistaken for an artifact reference.
 */
export const frozenFileSchema = z.union([
  z.strictObject({ blob: artifactReferenceSchema }),
  z.strictObject({ oversized: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }) }),
]);
export type FrozenFile = z.infer<typeof frozenFileSchema>;

export const scopeFileSchema = z.strictObject({
  /** Repository-relative, forward slashes, as git reports it. */
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted']),
  symlink: z.boolean(),
  /** The file at base, or null when it did not exist there. */
  before: frozenFileSchema.nullable(),
  /** The file in the worktree at capture, or null when it does not exist. */
  after: frozenFileSchema.nullable(),
});
export type ScopeFile = z.infer<typeof scopeFileSchema>;

export const scopeRequestSchema = z.strictObject({
  ref: z.string().min(1).optional(),
  range: z.strictObject({ from: z.string().min(1), to: z.string().min(1), mergeBase: z.boolean() }).optional(),
  paths: z.array(z.string().min(1)),
});
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;

export const scopeModeSchema = z.enum(['last-commit', 'worktree', 'ref', 'range']);
export type ScopeMode = z.infer<typeof scopeModeSchema>;

/** The change a run reviews: how it was named, what it spans, and every file's frozen before and after. */
export const scopeCapturedV1 = z.strictObject({
  mode: scopeModeSchema,
  request: scopeRequestSchema,
  /** Commit or empty tree the change is measured from. */
  base: commitId,
  /** HEAD at capture; the after bytes are the worktree's at that moment. */
  head: commitId,
  files: z.array(scopeFileSchema).max(2000),
  /** The unified patch, base to worktree, plus one diff per untracked file. */
  patch: artifactReferenceSchema,
});
export type ScopeState = z.infer<typeof scopeCapturedV1>;

/** How hard a worker's model thinks. Every level a runtime can take; an adapter declares which of them it has. */
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

/** What a worker may do to the reviewed tree: read it, or also edit it. */
export const accessSchema = z.enum(['read-only', 'edit']);
export type Access = z.infer<typeof accessSchema>;

/** One tool call the runtime refused: the tool, and its command or path when the runtime reports one. */
export const deniedToolSchema = z.strictObject({
  tool: z.string().min(1),
  detail: z.string().nullable(),
});
export type DeniedTool = z.infer<typeof deniedToolSchema>;

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
  'scope.captured': { 1: { schema: scopeCapturedV1 } },
});

export type EventRegistry = typeof eventRegistry;
