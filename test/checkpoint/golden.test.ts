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
import { fixPhases } from '../../src/review/vocabulary.ts';

const fixturesRoot = resolve(import.meta.dirname, '../fixtures/checkpoints');
/** Fixture directories are schema-<schema>-<serial>; the serial advances when the registry changes. */
const fixturePattern = /^schema-(\d+)-(\d+)$/;
const fixtures = readdirSync(fixturesRoot)
  .filter((name) => fixturePattern.test(name))
  .sort((a, b) => {
    const [, schemaA, serialA] = fixturePattern.exec(a)!;
    const [, schemaB, serialB] = fixturePattern.exec(b)!;
    return Number(schemaA) - Number(schemaB) || Number(serialA) - Number(serialB);
  });

interface Expected {
  readonly runs: RunState[];
  readonly evidence: ArtifactReference[];
}

/**
 * Hold `actual` to every fact `recorded` holds: each key of a recorded
 * object, at any depth, with the value recorded there, and each array
 * element by element and of the recorded length; a key `actual` has and
 * `recorded` lacks is a field a newer engine added, and is allowed.
 */
function assertHolds(actual: unknown, recorded: unknown, path: string): void {
  if (Array.isArray(recorded)) {
    assert.ok(Array.isArray(actual), `${path} is a list`);
    assert.equal(actual.length, recorded.length, `${path} length`);
    recorded.forEach((value: unknown, index) => assertHolds((actual as unknown[])[index], value, `${path}[${String(index)}]`));
    return;
  }
  if (recorded !== null && typeof recorded === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path} is an object`);
    for (const [key, value] of Object.entries(recorded)) assertHolds((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    return;
  }
  assert.deepEqual(actual, recorded, path);
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
      const runs = checkpoint.listRuns();
      if (name === fixtures.at(-1)) assert.deepEqual(runs, expected.runs);
      else {
        // An older fixture was recorded by an engine whose state had fewer
        // fields. Every fact it recorded must still hold, at any depth; new
        // fields may exist beside them.
        assert.equal(runs.length, expected.runs.length);
        for (const [index, recorded] of expected.runs.entries()) {
          const actual: Record<string, unknown> = { ...runs[index] };
          assertHolds(actual, recorded, `${name} run ${String(index)}`);
          // A run recorded before workers existed has none (R11 of the runtime adapter).
          if (!('workers' in recorded)) assert.deepEqual(actual.workers, {}, `${name} run ${String(index)} workers`);
          // A run recorded before reviews existed has no review (R10 of the read-only review).
          if (!('review' in recorded)) assert.equal(actual.review, null, `${name} run ${String(index)} review`);
          // A review recorded before the fix pass existed reads as one without it: no fix state, and its five phases skipped (TD9 of the fix pass).
          const review = runs[index]!.review;
          if (review !== null && !('fix' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.equal(review.fix, null, `${name} run ${String(index)} fix`);
            assert.equal(review.configuration.fix, false, `${name} run ${String(index)} configuration.fix`);
            for (const phase of fixPhases) assert.equal(review.phases[phase].status, 'skipped', `${name} run ${String(index)} ${phase}`);
          }
        }
      }
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
