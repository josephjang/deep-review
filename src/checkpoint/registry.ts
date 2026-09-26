import { createHash } from 'node:crypto';
import type { z } from 'zod';

/** What the registry declares about one version of one event kind. */
export interface EventDefinition {
  /** The payload schema. Strict objects only, so a stray field is a contract error, not silent data. */
  readonly schema: z.ZodType;
}

/** Event kinds by name, each with a schema per version. */
export type Registry = Readonly<Record<string, Readonly<Record<number, EventDefinition>>>>;

/** `kind@version` for every declared pair; the keys a reducer table must cover. */
export type RegistryKey<R extends Registry> = {
  [K in keyof R & string]: `${K}@${keyof R[K] & number}`;
}[keyof R & string];

const kindPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Validate the shape of a registry once, at module load, and hand it back typed. */
export function defineRegistry<const R extends Registry>(registry: R): R {
  for (const [kind, versions] of Object.entries(registry)) {
    if (!kindPattern.test(kind)) throw new Error(`Event kind must be dotted lowercase words: ${kind}`);
    const declared = Object.keys(versions);
    if (declared.length === 0) throw new Error(`Event kind ${kind} declares no version`);
    for (const version of declared) {
      if (!/^[1-9][0-9]*$/.test(version)) throw new Error(`Event kind ${kind} has a non-positive version: ${version}`);
    }
  }
  return registry;
}

export function lookupEvent(registry: Registry, kind: string, version: number): EventDefinition | undefined {
  return registry[kind]?.[version];
}

/** Every `kind@version` the registry declares, sorted. */
export function registryKeys(registry: Registry): string[] {
  return Object.entries(registry)
    .flatMap(([kind, versions]) => Object.keys(versions).map((version) => `${kind}@${version}`))
    .sort();
}

/** A hash that changes when a kind or version is added or removed. Schema bodies are not hashed; a changed schema is a new version. */
export function registryIdentity(registry: Registry): string {
  return createHash('sha256').update(registryKeys(registry).join('\n')).digest('hex');
}
