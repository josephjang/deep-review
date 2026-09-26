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
