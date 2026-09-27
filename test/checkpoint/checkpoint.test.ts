import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint, evidenceDirectoryName } from '../../src/checkpoint/checkpoint.ts';
import {
  EvidenceError,
  InvalidHistoryError,
  InvalidPayloadError,
  RunClosedError,
  StaleRevisionError,
  UnknownEventError,
  UnknownRunError,
} from '../../src/checkpoint/errors.ts';
import { ledgerFileName } from '../../src/checkpoint/ledger.ts';
import { collectArtifactReferences } from '../../src/evidence/references.ts';
import { sha256Hex } from '../../src/evidence/store.ts';
import { testModel } from '../helpers/model.ts';

const fixedClock = (): (() => string) => {
  let tick = 0;
  return () => `2026-09-26T00:00:${String(tick++).padStart(2, '0')}.000Z`;
};
const fixedIds = (): (() => string) => {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
};

describe('Checkpoint', () => {
  let root: string;
  const opened: Checkpoint[] = [];
  const open = (options: Partial<Parameters<typeof Checkpoint.open>[1]> = {}): Checkpoint => {
    const checkpoint = Checkpoint.open(root, { engine: '0.0.0-test', model: testModel, clock: fixedClock(), ids: fixedIds(), ...options });
    opened.push(checkpoint);
    return checkpoint;
  };
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'deep-review-checkpoint-')), 'checkpoint');
  });
  afterEach(() => {
    for (const checkpoint of opened.splice(0)) checkpoint.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('opens with a ledger and an evidence directory beside it', () => {
    const checkpoint = open();
    assert.equal(checkpoint.root, resolve(root));
    assert.equal(existsSync(join(root, ledgerFileName)), true);
    assert.equal(checkpoint.evidence.root, join(resolve(root), evidenceDirectoryName));
    assert.deepEqual(checkpoint.listRuns(), []);
  });

  it('creates a run with its creation event, stamped by the injected clock, id and engine', () => {
    const checkpoint = open();
    const state = checkpoint.createRun({ worktree: '/repo' });
    assert.deepEqual(state, {
      id: '00000000-0000-4000-8000-000000000000',
      worktree: '/repo',
      createdAt: '2026-09-26T00:00:00.000Z',
      engine: '0.0.0-test',
      status: 'active',
      abandonReason: null,
      scope: null,
      workers: {},
      review: null,
      lastSequence: 1,
    });
    assert.deepEqual(checkpoint.fold(state.id), state);
    assert.deepEqual(checkpoint.listRuns(), [state]);
    assert.deepEqual(checkpoint.ledger.events(state.id).map((event) => [event.kind, event.payload, event.engine]), [['run.created', '{"worktree":"/repo"}', '0.0.0-test']]);
  });

  it('uses real ids and clock by default', () => {
    const checkpoint = Checkpoint.open(root, { engine: '0.0.0' });
    opened.push(checkpoint);
    const state = checkpoint.createRun({ worktree: '/repo' });
    assert.match(state.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Date.now() - Date.parse(state.createdAt) < 60_000);
  });

  it('refuses a creation payload the schema rejects, writing nothing', () => {
    const checkpoint = open();
    assert.throws(() => checkpoint.createRun({ worktree: '' }), InvalidPayloadError);
    assert.deepEqual(checkpoint.listRuns(), []);
  });

  it('appends events in order and returns the new state', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    const after = checkpoint.append(created.id, created.lastSequence, [
      { kind: 'test.note', version: 1, payload: { text: 'one' } },
      { kind: 'test.note', version: 1, payload: { text: 'two' } },
    ]);
    assert.equal(after.lastSequence, 3);
    assert.equal(after.status, 'active');
    assert.deepEqual(checkpoint.ledger.events(created.id).map((event) => [event.sequence, event.payload]), [[1, '{"worktree":"/repo"}'], [2, '{"text":"one"}'], [3, '{"text":"two"}']]);
    const abandoned = checkpoint.append(created.id, after.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'done' } }]);
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(abandoned.lastSequence, 4);
  });

  it('survives a reopen: the state is the fold of what was written', () => {
    const first = open();
    const created = first.createRun({ worktree: '/repo' });
    first.append(created.id, 1, [{ kind: 'test.note', version: 1, payload: { text: 'persisted' } }]);
    first.close();
    opened.splice(0);
    const second = open();
    assert.equal(second.fold(created.id).lastSequence, 2);
  });

  it('refuses a stale expectation and writes nothing', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    checkpoint.append(created.id, 1, [{ kind: 'test.note', version: 1, payload: { text: 'moved' } }]);
    assert.throws(
      () => checkpoint.append(created.id, 1, [{ kind: 'test.note', version: 1, payload: { text: 'late' } }]),
      (error: unknown) => error instanceof StaleRevisionError && error.expected === 1 && error.actual === 2,
    );
    assert.equal(checkpoint.fold(created.id).lastSequence, 2);
  });

  it('refuses an unknown run, an unknown kind, an invalid payload and an empty append', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    assert.throws(() => checkpoint.append('ghost', 0, [{ kind: 'test.note', version: 1, payload: { text: 'x' } }]), UnknownRunError);
    assert.throws(() => checkpoint.fold('ghost'), UnknownRunError);
    assert.throws(() => checkpoint.append(created.id, 1, [{ kind: 'test.mystery', version: 1, payload: {} }]), UnknownEventError);
    assert.throws(() => checkpoint.append(created.id, 1, [{ kind: 'test.note', version: 2, payload: { text: 'x' } }]), UnknownEventError);
    assert.throws(() => checkpoint.append(created.id, 1, [{ kind: 'test.note', version: 1, payload: { text: 1 } }]), InvalidPayloadError);
    assert.throws(() => checkpoint.append(created.id, 1, [{ kind: 'test.note', version: 1, payload: { text: 'x', extra: true } }]), InvalidPayloadError);
    assert.throws(() => checkpoint.append(created.id, 1, []), InvalidPayloadError);
    assert.equal(checkpoint.fold(created.id).lastSequence, 1);
  });

  it('refuses events on an abandoned run inside the transaction', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    const abandoned = checkpoint.append(created.id, 1, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stop' } }]);
    assert.throws(() => checkpoint.append(created.id, abandoned.lastSequence, [{ kind: 'test.note', version: 1, payload: { text: 'x' } }]), RunClosedError);
    assert.equal(checkpoint.fold(created.id).lastSequence, 2);
  });

  it('writes nothing when a batch closes the run before its last event', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    assert.throws(
      () =>
        checkpoint.append(created.id, 1, [
          { kind: 'run.abandoned', version: 1, payload: { reason: 'stop' } },
          { kind: 'test.note', version: 1, payload: { text: 'after' } },
        ]),
      RunClosedError,
    );
    assert.equal(checkpoint.fold(created.id).status, 'active');
    assert.equal(checkpoint.fold(created.id).lastSequence, 1);
  });

  it('writes nothing when a batch would make the history invalid', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    assert.throws(() => checkpoint.append(created.id, 1, [{ kind: 'run.created', version: 1, payload: { worktree: '/again' } }]), InvalidHistoryError);
    assert.equal(checkpoint.fold(created.id).lastSequence, 1);
  });

  it('verifies every artifact reference in a payload before the write, wherever it is nested', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    const blob = checkpoint.evidence.put('evidence bytes');
    const inner = checkpoint.evidence.put('inner bytes');
    const missing = { sha256: sha256Hex(Buffer.from('never stored')), bytes: 12 };
    assert.throws(
      () => checkpoint.append(created.id, 1, [{ kind: 'test.evidence', version: 1, payload: { label: 'x', blob: missing } }]),
      EvidenceError,
    );
    assert.throws(
      () => checkpoint.append(created.id, 1, [{ kind: 'test.evidence', version: 1, payload: { label: 'x', blob, nested: [{ inner: missing }] } }]),
      EvidenceError,
    );
    assert.equal(checkpoint.fold(created.id).lastSequence, 1);
    const state = checkpoint.append(created.id, 1, [{ kind: 'test.evidence', version: 1, payload: { label: 'x', blob, nested: [{ inner }] } }]);
    assert.equal(state.lastSequence, 2);
    writeFileSync(join(checkpoint.evidence.root, blob.sha256), 'evidence byteZ');
    assert.throws(
      () => checkpoint.append(created.id, 2, [{ kind: 'test.evidence', version: 1, payload: { label: 'y', blob } }]),
      /integrity failure/,
    );
  });

  it('keeps one consistent ledger when two processes append to the same run at once', () => {
    const checkpoint = open();
    const created = checkpoint.createRun({ worktree: '/repo' });
    checkpoint.close();
    opened.splice(0);
    const worker = resolve(import.meta.dirname, '../helpers/append-worker.ts');
    const count = 25;
    const results = ['a', 'b'].map((label) => spawnSync(process.execPath, [worker, root, created.id, String(count), label], { encoding: 'utf8' }));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const reports = results.map((result) => JSON.parse(result.stdout.trim()) as { label: string; appended: number; stale: number; busy: number });
    assert.deepEqual(reports.map((report) => report.appended), [count, count]);
    const reopened = open();
    const state = reopened.fold(created.id);
    assert.equal(state.lastSequence, 1 + 2 * count);
    const events = reopened.ledger.events(created.id);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 1 + 2 * count }, (_, index) => index + 1));
    const texts = events.slice(1).map((event) => (JSON.parse(event.payload) as { text: string }).text).sort();
    const expected = ['a', 'b'].flatMap((label) => Array.from({ length: count }, (_, index) => `${label}-${String(index)}`)).sort();
    assert.deepEqual(texts, expected, 'every append landed exactly once');
  });
});

describe('collectArtifactReferences', () => {
  const reference = { sha256: sha256Hex(Buffer.from('x')), bytes: 1 };

  it('finds references at any depth and in arrays', () => {
    assert.deepEqual(collectArtifactReferences({ a: reference, b: { c: [reference, { d: reference }] } }), [reference, reference, reference]);
  });

  it('finds nothing in scalars, null, empty containers and near-misses', () => {
    assert.deepEqual(collectArtifactReferences('text'), []);
    assert.deepEqual(collectArtifactReferences(null), []);
    assert.deepEqual(collectArtifactReferences({ a: [], b: {} }), []);
    assert.deepEqual(collectArtifactReferences({ sha256: reference.sha256 }), []);
    assert.deepEqual(collectArtifactReferences({ ...reference, extra: 1 }), []);
    assert.deepEqual(collectArtifactReferences({ sha256: 'short', bytes: 1 }), []);
  });
});
