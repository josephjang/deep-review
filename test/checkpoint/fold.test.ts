import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { InvalidHistoryError, UnknownEventError } from '../../src/checkpoint/errors.ts';
import { eventRegistry } from '../../src/checkpoint/events.ts';
import { applyEvent, defineModel, foldRun, reducers, runModel, type DecodedEvent } from '../../src/checkpoint/fold.ts';
import { defineRegistry, registryIdentity, registryKeys } from '../../src/checkpoint/registry.ts';
import { testModel } from '../helpers/model.ts';

const event = (sequence: number, kind: string, payload: unknown, version = 1): DecodedEvent => ({
  sequence,
  runId: 'run-1',
  kind,
  version,
  payload,
  recordedAt: `2026-09-26T00:00:0${String(sequence)}.000Z`,
  engine: '0.0.0',
});
const created = (sequence = 1): DecodedEvent => event(sequence, 'run.created', { worktree: '/w' });

describe('registry', () => {
  it('lists every kind and version, sorted, and hashes that list', () => {
    assert.deepEqual(registryKeys(eventRegistry), ['run.abandoned@1', 'run.created@1', 'scope.captured@1']);
    assert.match(registryIdentity(eventRegistry), /^[a-f0-9]{64}$/);
    const extended = defineRegistry({ ...eventRegistry, 'a.b': { 2: { schema: z.strictObject({}) } } });
    assert.deepEqual(registryKeys(extended), ['a.b@2', 'run.abandoned@1', 'run.created@1', 'scope.captured@1']);
    assert.notEqual(registryIdentity(extended), registryIdentity(eventRegistry));
  });

  it('refuses a malformed kind name, a kind without versions, and a non-positive version', () => {
    const schema = z.strictObject({});
    assert.throws(() => defineRegistry({ 'NoDots': { 1: { schema } } }), /dotted lowercase/);
    assert.throws(() => defineRegistry({ 'run.Created': { 1: { schema } } }), /dotted lowercase/);
    assert.throws(() => defineRegistry({ 'a.b': {} }), /declares no version/);
    assert.throws(() => defineRegistry({ 'a.b': { 0: { schema } } }), /non-positive version/);
  });
});

describe('defineModel', () => {
  it('accepts reducers that cover the registry exactly', () => {
    assert.deepEqual(registryKeys(runModel.registry), Object.keys(runModel.reducers).sort());
  });

  it('refuses a registered kind without a reducer and a reducer without a kind', () => {
    const missing = Object.fromEntries(Object.entries(reducers).filter(([key]) => key !== 'run.abandoned@1'));
    assert.throws(() => defineModel(eventRegistry, missing as typeof reducers), /Reducers and registry disagree/);
    assert.throws(() => defineModel(eventRegistry, { ...reducers, 'ghost.kind@1': reducers['run.abandoned@1'] } as typeof reducers), /Reducers and registry disagree/);
  });
});

describe('foldRun', () => {
  it('folds a creation into an active run', () => {
    assert.deepEqual(foldRun([created()]), {
      id: 'run-1',
      worktree: '/w',
      createdAt: '2026-09-26T00:00:01.000Z',
      engine: '0.0.0',
      status: 'active',
      abandonReason: null,
      scope: null,
      lastSequence: 1,
    });
  });

  it('folds an abandonment and keeps the creation facts', () => {
    const state = foldRun([created(), event(7, 'run.abandoned', { reason: 'operator gave up' })]);
    assert.equal(state.status, 'abandoned');
    assert.equal(state.abandonReason, 'operator gave up');
    assert.equal(state.lastSequence, 7);
    assert.equal(state.createdAt, '2026-09-26T00:00:01.000Z');
  });

  it('is deterministic', () => {
    const events = [created(), event(2, 'run.abandoned', { reason: 'r' })];
    assert.deepEqual(foldRun(events), foldRun(events));
  });

  it('refuses an empty history, a run created twice, and an event before creation', () => {
    assert.throws(() => foldRun([]), InvalidHistoryError);
    assert.throws(() => foldRun([created(1), created(2)]), /created twice/);
    assert.throws(() => foldRun([event(1, 'run.abandoned', { reason: 'r' })]), /before its creation/);
  });

  it('refuses an event after the run was abandoned', () => {
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r' }), event(3, 'run.abandoned', { reason: 'again' })]), /was abandoned at sequence 2/);
  });

  it('refuses an unknown kind or version by name rather than skipping it', () => {
    assert.throws(() => foldRun([created(), event(2, 'run.mystery', {})]), (error: unknown) => error instanceof UnknownEventError && error.kind === 'run.mystery' && error.version === 1);
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r' }, 2)]), (error: unknown) => error instanceof UnknownEventError && error.version === 2);
  });

  it('refuses a payload its schema rejects, naming the sequence', () => {
    assert.throws(() => foldRun([event(1, 'run.created', { worktree: '' })]), /Event 1 \(run.created@1\)/);
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r', extra: 1 })]), /Event 2/);
  });

  it('folds kinds a custom model adds', () => {
    const state = foldRun([created(), event(2, 'test.note', { text: 'hi' })], testModel);
    assert.equal(state.lastSequence, 2);
    assert.throws(() => foldRun([created(), event(2, 'test.note', { text: 'hi' })]), UnknownEventError);
  });
});

describe('applyEvent', () => {
  it('applies one event to a prior state', () => {
    const state = applyEvent(foldRun([created()]), event(2, 'run.abandoned', { reason: 'r' }));
    assert.equal(state.status, 'abandoned');
  });
});
