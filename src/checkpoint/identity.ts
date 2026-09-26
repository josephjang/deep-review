import { createHash } from 'node:crypto';
import { eventRegistry } from './events.ts';
import { currentSchema } from './ledger.ts';
import { registryIdentity, registryKeys } from './registry.ts';

/**
 * What a golden fixture is keyed by: the ledger schema and the set of event
 * kinds. A change to either without a new fixture is a red build (D12).
 */
export interface CheckpointIdentity {
  readonly schema: number;
  /** SHA-256 of the DDL that creates a fresh ledger at this schema. */
  readonly ddl: string;
  /** SHA-256 of the sorted kind@version list. */
  readonly registry: string;
  readonly kinds: readonly string[];
}

export function checkpointIdentity(): CheckpointIdentity {
  return {
    schema: currentSchema.version,
    ddl: createHash('sha256').update(currentSchema.ddl).digest('hex'),
    registry: registryIdentity(eventRegistry),
    kinds: registryKeys(eventRegistry),
  };
}
