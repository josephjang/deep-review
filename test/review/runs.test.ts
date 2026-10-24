import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { UnknownRunError, UnreadableRunError } from '../../src/checkpoint/errors.ts';
import { runModel } from '../../src/checkpoint/fold.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { runIdOf, shortRunId, shortRunIdLength } from '../../src/review/runs.ts';
import { testModel } from '../helpers/model.ts';

describe('runIdOf (R11 of the questions in the chat)', () => {
  let root: string;
  const opened: Checkpoint[] = [];
  // Two runs share their first 8 characters and differ at the ninth; the third starts apart.
  const ids = ['1a2b3c4d-0000-4000-8000-000000000001', '1a2b3c4d-1111-4000-8000-000000000002', '9f8e7d6c-0000-4000-8000-000000000003'];
  const open = (model = testModel, engine = '0.0.0-test'): Checkpoint => {
    let next = 0;
    const checkpoint = Checkpoint.open(root, { engine, model, ids: () => ids[next++]! });
    opened.push(checkpoint);
    return checkpoint;
  };
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'deep-review-runs-')), 'checkpoint');
  });
  afterEach(() => {
    for (const checkpoint of opened.splice(0)) checkpoint.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });
  const threeRuns = (): Checkpoint => {
    const checkpoint = open();
    for (let index = 0; index < ids.length; index++) checkpoint.createRun({ worktree: '/repo' });
    return checkpoint;
  };

  it('shows and takes 8 characters', () => {
    assert.equal(shortRunIdLength, 8);
    assert.equal(shortRunId(ids[2]!), '9f8e7d6c');
  });

  it('gives a whole id the ledger holds as it is, also one whose first 8 characters another run shares', () => {
    const checkpoint = threeRuns();
    for (const id of ids) assert.equal(runIdOf(checkpoint, id), id);
  });

  it('gives the one run whose id starts with a start of 8 or more characters', () => {
    const checkpoint = threeRuns();
    assert.equal(runIdOf(checkpoint, '9f8e7d6c'), ids[2]);
    assert.equal(runIdOf(checkpoint, '9f8e7d6c-0000'), ids[2]);
    assert.equal(runIdOf(checkpoint, '1a2b3c4d-1'), ids[1], 'a longer start tells two runs apart');
    assert.equal(checkpoint.fold(runIdOf(checkpoint, '9f8e7d6c')).id, ids[2]);
  });

  it('gives back a start of 7 characters as it is, which the fold refuses as an unknown id', () => {
    const checkpoint = threeRuns();
    assert.equal(runIdOf(checkpoint, '9f8e7d6'), '9f8e7d6');
    assert.throws(() => checkpoint.fold(runIdOf(checkpoint, '9f8e7d6')), (error) => error instanceof UnknownRunError && error.runId === '9f8e7d6');
  });

  it('gives back a start that names no run as it is, which the fold refuses as an unknown id', () => {
    const checkpoint = threeRuns();
    assert.equal(runIdOf(checkpoint, '00000000'), '00000000');
    assert.throws(() => checkpoint.fold(runIdOf(checkpoint, '00000000')), UnknownRunError);
    assert.equal(runIdOf(open(), 'ffffffff'), 'ffffffff', 'and in a ledger with no run');
  });

  it('refuses a start that two runs share, naming both', () => {
    const checkpoint = threeRuns();
    assert.throws(() => runIdOf(checkpoint, '1a2b3c4d'), (error) => error instanceof ReviewRefusedError
      && error.code === null
      && error.message === `--run 1a2b3c4d names 2 runs (${ids[0]!}, ${ids[1]!}); give more of the id`);
    assert.throws(() => runIdOf(checkpoint, '1a2b3c4d-'), ReviewRefusedError, 'a longer start the two still share');
  });

  it('names an unreadable run by its start, which the fold then refuses by name', () => {
    const writer = open(testModel, '9.9.9-writer');
    const unreadable = writer.createRun({ worktree: '/repo' });
    writer.append(unreadable.id, unreadable.lastSequence, [{ kind: 'test.note', version: 1, payload: { text: 'only the writer knows this' } }]);
    writer.close();
    opened.splice(0);
    const reader = open(runModel, '1.0.0-reader');
    assert.equal(runIdOf(reader, shortRunId(unreadable.id)), unreadable.id);
    assert.throws(() => reader.fold(runIdOf(reader, shortRunId(unreadable.id))), (error) => error instanceof UnreadableRunError && error.runId === unreadable.id);
  });
});
