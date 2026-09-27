import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { InvalidHistoryError, UnknownEventError } from '../../src/checkpoint/errors.ts';
import { accessSchema, effortSchema, eventRegistry, workerLaunchedV1 } from '../../src/checkpoint/events.ts';
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
    assert.deepEqual(registryKeys(eventRegistry), ['run.abandoned@1', 'run.created@1', 'scope.captured@1', 'worker.finished@1', 'worker.launched@1']);
    assert.match(registryIdentity(eventRegistry), /^[a-f0-9]{64}$/);
    const extended = defineRegistry({ ...eventRegistry, 'a.b': { 2: { schema: z.strictObject({}) } } });
    assert.deepEqual(registryKeys(extended), ['a.b@2', 'run.abandoned@1', 'run.created@1', 'scope.captured@1', 'worker.finished@1', 'worker.launched@1']);
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
      workers: {},
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

describe('workers', () => {
  const reference = (fill: string, bytes = 1): { sha256: string; bytes: number } => ({ sha256: fill.repeat(64), bytes });
  const workerA = '00000000-0000-4000-8000-00000000000a';
  const workerB = '00000000-0000-4000-8000-00000000000b';
  const launch = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    workerId,
    label: null,
    runtime: 'claude',
    executable: '/bin/claude',
    executableArgs: [],
    version: '2.1.283',
    model: 'sonnet',
    effort: 'high',
    access: 'read-only',
    shell: true,
    sessionId: '11111111-2222-4333-8444-555555555555',
    resumes: null,
    scratch: '/checkpoint/scratch/x',
    budgetUsd: null,
    timeoutMs: 60_000,
    prompt: reference('a'),
    schema: reference('b'),
    ...change,
  });
  const finish = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    workerId,
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    termination: 'exited',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:00:05.000Z',
    sessionIds: ['11111111-2222-4333-8444-555555555555'],
    usage: '{"input_tokens":1}',
    denials: [],
    error: null,
    stdout: reference('c'),
    stderr: reference('d', 0),
    finalMessage: null,
    output: reference('e'),
    ...change,
  });

  it('folds a launch into a running worker and a finish into a finished one', () => {
    const running = foldRun([created(), event(2, 'worker.launched', launch(workerA))]);
    assert.deepEqual(running.workers, { [workerA]: { status: 'running', launch: launch(workerA), launchedAt: '2026-09-26T00:00:02.000Z' } });
    const finished = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA))]);
    assert.deepEqual(finished.workers, { [workerA]: { status: 'finished', launch: launch(workerA), launchedAt: '2026-09-26T00:00:02.000Z', finish: finish(workerA) } });
    assert.equal(finished.lastSequence, 3);
  });

  it('keeps workers apart, in any interleaving', () => {
    const state = foldRun([
      created(),
      event(2, 'worker.launched', launch(workerA)),
      event(3, 'worker.launched', launch(workerB, { runtime: 'codex', sessionId: null })),
      event(4, 'worker.finished', finish(workerA, { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null })),
    ]);
    assert.equal(state.workers[workerA]?.status, 'finished');
    assert.equal(state.workers[workerB]?.status, 'running');
    assert.equal(state.workers[workerB]?.launch.runtime, 'codex');
  });

  it('keeps workers when the run is abandoned', () => {
    const state = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'run.abandoned', { reason: 'r' })]);
    assert.equal(state.workers[workerA]?.status, 'running');
  });

  it('refuses a second launch of one worker, a finish without a launch and a second finish', () => {
    assert.throws(() => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.launched', launch(workerA))]), /launches worker .* twice, at sequence 3/);
    assert.throws(() => foldRun([created(), event(2, 'worker.finished', finish(workerA))]), /finishes worker .* at sequence 2 without launching it/);
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA)), event(4, 'worker.finished', finish(workerA))]),
      /finishes worker .* twice, at sequence 4/,
    );
    assert.throws(() => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerB))]), /without launching it/);
  });

  it('accepts a continuation under the session it resumes, and every other outcome without an output', () => {
    const session = '11111111-2222-4333-8444-555555555555';
    const state = foldRun([
      created(),
      event(2, 'worker.launched', launch(workerA, { sessionId: session, resumes: session })),
      event(3, 'worker.launched', launch(workerB, { sessionId: null, resumes: null })),
    ]);
    assert.equal(state.workers[workerA]?.launch.resumes, session);
    assert.equal(state.workers[workerB]?.launch.sessionId, null);
    for (const outcome of ['budget', 'timeout', 'failed']) {
      const finished = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA, { outcome, output: null }))]);
      assert.equal(finished.workers[workerA]?.status, 'finished', outcome);
    }
  });

  it('names the broken rule when a finish and its output disagree, or a continuation runs under another session', () => {
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA, { output: null }))]),
      /output is present exactly when the outcome is completed/,
    );
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA, { resumes: '99999999-2222-4333-8444-555555555555' }))]),
      /a continuation runs under the session it resumes/,
    );
  });

  it('pins the effort levels and access modes worker.launched@1 records, apart from the runtime contract', () => {
    assert.deepEqual(workerLaunchedV1.shape.effort.options, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(workerLaunchedV1.shape.access.options, ['read-only', 'edit']);
    assert.notEqual(workerLaunchedV1.shape.effort, effortSchema);
    assert.notEqual(workerLaunchedV1.shape.access, accessSchema);
  });

  it('refuses a worker event before the run exists', () => {
    assert.throws(() => foldRun([event(1, 'worker.launched', launch(workerA))]), /before its creation/);
  });

  it('refuses payloads the worker schemas reject', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['worker.launched', launch('not-a-uuid')],
      ['worker.launched', launch(workerA, { effort: 'extreme' })],
      ['worker.launched', launch(workerA, { access: 'owned-edit' })],
      ['worker.launched', launch(workerA, { sessionId: '-x' })],
      ['worker.launched', launch(workerA, { budgetUsd: 0 })],
      ['worker.launched', launch(workerA, { tools: ['Read'] })],
      ['worker.finished', finish(workerA, { outcome: 'denied' })],
      ['worker.finished', finish(workerA, { termination: 'lost' })],
      ['worker.finished', finish(workerA, { startedAt: 'yesterday' })],
      ['worker.finished', finish(workerA, { usage: { input_tokens: 1 } })],
      ['worker.finished', finish(workerA, { denials: [{ tool: '', detail: null }] })],
      ['worker.finished', finish(workerA, { error: '' })],
      ['worker.launched', launch(workerA, { resumes: '99999999-2222-4333-8444-555555555555' })],
      ['worker.launched', launch(workerA, { resumes: '11111111-2222-4333-8444-555555555555', sessionId: null })],
      ['worker.finished', finish(workerA, { output: null })],
      ['worker.finished', finish(workerA, { outcome: 'failed', error: 'no', output: reference('e') })],
      ['worker.finished', finish(workerA, { outcome: 'budget', output: reference('e') })],
      ['worker.finished', finish(workerA, { outcome: 'timeout', termination: 'killed', output: reference('e') })],
    ];
    for (const [kind, payload] of cases) {
      const events = kind === 'worker.finished' ? [created(), event(2, 'worker.launched', launch(workerA)), event(3, kind, payload)] : [created(), event(2, kind, payload)];
      assert.throws(() => foldRun(events), InvalidHistoryError, JSON.stringify(payload));
    }
  });
});
