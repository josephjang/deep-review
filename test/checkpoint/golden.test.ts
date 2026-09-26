import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { RunClosedError } from '../../src/checkpoint/errors.ts';
import { checkpointIdentity, type CheckpointIdentity } from '../../src/checkpoint/identity.ts';
import { ledgerFileName } from '../../src/checkpoint/ledger.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import type { ArtifactReference } from '../../src/evidence/store.ts';

const fixturesRoot = resolve(import.meta.dirname, '../fixtures/checkpoints');
const fixtures = readdirSync(fixturesRoot).filter((name) => name.startsWith('schema-')).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));

interface Expected {
  readonly runs: RunState[];
  readonly evidence: ArtifactReference[];
}

describe('golden checkpoints', () => {
  let sandbox: string;
  const opened: Checkpoint[] = [];
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-golden-'));
  });
  afterEach(() => {
    for (const checkpoint of opened.splice(0)) checkpoint.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('has at least one committed fixture', () => {
    assert.ok(fixtures.length >= 1, 'run `npm run golden` to create the first fixture');
  });

  for (const name of fixtures) {
    it(`opens ${name}, folds every run as recorded, and verifies its evidence`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const expected = JSON.parse(readFileSync(join(copy, 'expected.json'), 'utf8')) as Expected;
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      assert.deepEqual(checkpoint.listRuns(), expected.runs);
      for (const reference of expected.evidence) {
        assert.doesNotThrow(() => checkpoint.evidence.verify(reference));
        assert.equal(checkpoint.evidence.read(reference).length, reference.bytes);
      }
      // The fixture is still writable by this engine: an active run accepts events, a closed one does not.
      const active = expected.runs.find((run) => run.status === 'active');
      const abandoned = expected.runs.find((run) => run.status === 'abandoned');
      assert.ok(active !== undefined && abandoned !== undefined, 'the fixture holds one active and one abandoned run');
      assert.equal(checkpoint.append(active.id, active.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'test' } }]).status, 'abandoned');
      assert.throws(() => checkpoint.append(abandoned.id, abandoned.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'again' } }]), RunClosedError);
    });
  }

  it('matches the newest fixture\'s identity, so a schema or registry change needs a new fixture', () => {
    const newest = fixtures.at(-1)!;
    const recorded = JSON.parse(readFileSync(join(fixturesRoot, newest, 'identity.json'), 'utf8')) as CheckpointIdentity;
    assert.deepEqual(
      checkpointIdentity(),
      recorded,
      `The ledger DDL or the event registry changed since ${newest} was written. Run \`npm run golden -- --output test/fixtures/checkpoints/schema-<n>\` and commit the result.`,
    );
  });

  it('is what the golden script writes', () => {
    const output = join(sandbox, 'generated');
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/golden-checkpoint.ts'), '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(output).sort(), ['artifacts', 'expected.json', 'identity.json', ledgerFileName]);
    assert.equal(existsSync(join(output, `${ledgerFileName}-wal`)), false);
    const generated = JSON.parse(readFileSync(join(output, 'expected.json'), 'utf8')) as Expected;
    const committed = JSON.parse(readFileSync(join(fixturesRoot, fixtures.at(-1)!, 'expected.json'), 'utf8')) as Expected;
    assert.deepEqual(generated, committed, 'the script is deterministic, so regenerating gives the committed expectation');
    assert.notEqual(spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/golden-checkpoint.ts'), '--output', output], { encoding: 'utf8' }).status, 0, 'an existing output is refused');
  });
});
