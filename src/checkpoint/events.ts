import { z } from 'zod';
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

/** Every event kind this engine can write or read. Later elements add theirs here. */
export const eventRegistry = defineRegistry({
  'run.created': { 1: { schema: runCreatedV1 } },
  'run.abandoned': { 1: { schema: runAbandonedV1 } },
});

export type EventRegistry = typeof eventRegistry;
