import { z } from 'zod';
import { eventRegistry } from '../../src/checkpoint/events.ts';
import { defineModel, reducers, requireState, type RunModel } from '../../src/checkpoint/fold.ts';
import { defineRegistry } from '../../src/checkpoint/registry.ts';
import { artifactReferenceSchema } from '../../src/evidence/store.ts';

/** The engine's registry plus two kinds only tests need: a repeatable note and an event that carries evidence. */
export const testRegistry = defineRegistry({
  ...eventRegistry,
  'test.note': { 1: { schema: z.strictObject({ text: z.string() }) } },
  'test.evidence': { 1: { schema: z.strictObject({ label: z.string(), blob: artifactReferenceSchema, nested: z.array(z.strictObject({ inner: artifactReferenceSchema })).default([]) }) } },
});

export const testModel: RunModel = defineModel(testRegistry, {
  ...reducers,
  'test.note@1': (state, _payload, event) => ({ ...requireState(state, event), lastSequence: event.sequence }),
  'test.evidence@1': (state, _payload, event) => ({ ...requireState(state, event), lastSequence: event.sequence }),
});

/** The event kinds and versions resumable runs added (R16 of resumable runs), which an engine before them does not declare. */
export const resumableRunsEntries = ['check.started@1', 'check.ran@3', 'tree.restored@1', 'worktree.checked@6', 'attempt.failed@7', 'fix.reopened@1', 'commits.prepared@1', 'commits.dropped@1'] as const;

/** The engine's model less `entries`, each `<kind>@<version>`: the model of an older engine, which declares none of them. */
export function modelWithout(entries: readonly string[]): RunModel {
  const registry = Object.fromEntries(Object.entries(eventRegistry).flatMap(([kind, versions]) => {
    const kept = Object.fromEntries(Object.entries(versions).filter(([version]) => !entries.includes(`${kind}@${version}`)));
    return Object.keys(kept).length === 0 ? [] : [[kind, kept]];
  }));
  const kept = Object.fromEntries(Object.entries(reducers).filter(([key]) => !entries.includes(key)));
  return defineModel(defineRegistry(registry as typeof eventRegistry), kept as typeof reducers);
}
