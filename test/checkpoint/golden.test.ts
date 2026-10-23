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
import { answerPhases, fixPhases } from '../../src/review/vocabulary.ts';

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

/** The fixture directory to write after `newest` for a ledger at `schema`: the next serial, at the width `newest` spells it. */
function nextFixtureName(newest: string, schema: number): string {
  const match = fixturePattern.exec(newest);
  assert.ok(match !== null, `${newest} is a fixture directory`);
  const serial = match[2]!;
  return `schema-${String(schema)}-${String(Number(serial) + 1).padStart(serial.length, '0')}`;
}

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

interface LegacyFailure {
  readonly workerId: string;
  readonly reason: string;
  readonly lost?: boolean;
}

/**
 * The run as recorded, each unit failure an engine recorded before
 * failures had a cause, with only `lost`, in the shape the fold now
 * gives: a lost worker's as `lost`, any other as the unit's, since no
 * fault was recorded before `attempt.failed@5` (R12 of commit series
 * integrity).
 */
function withFailureCauses(recorded: RunState): RunState {
  const review = recorded.review as { readonly units?: Record<string, Record<string, { readonly failures: readonly LegacyFailure[] }>> } | null;
  if (review?.units === undefined) return recorded;
  const cause = ({ lost, ...failure }: LegacyFailure): object => (lost === undefined ? failure : { ...failure, cause: lost ? 'lost' : 'unit' });
  const units = Object.fromEntries(Object.entries(review.units).map(([phase, ofPhase]) => [phase, Object.fromEntries(Object.entries(ofPhase).map(([key, unit]) => [key, { ...unit, failures: unit.failures.map(cause) }]))]));
  return { ...recorded, review: { ...review, units } } as unknown as RunState;
}

/**
 * The run as recorded, its fix state's commits, which an engine recorded
 * before answers as one series or null, in the shape the fold now gives: a
 * list of every series, of that one or none (R8 of answers).
 */
function withCommitSeries(recorded: RunState): RunState {
  const review = recorded.review as { readonly fix?: { readonly commits?: unknown } | null } | null;
  const commits = review?.fix?.commits;
  if (commits === undefined || Array.isArray(commits)) return recorded;
  return { ...recorded, review: { ...review, fix: { ...review!.fix, commits: commits === null ? [] : [commits] } } } as unknown as RunState;
}

/**
 * The run as recorded, each planned check a flag settled, which an engine
 * recorded before the settings with the origin `flag`, in the shape the
 * fold now gives: a setting of the flag layer (R11 of the configuration).
 */
function withSettingOrigins(recorded: RunState): RunState {
  const review = recorded.review as { readonly fix?: { readonly checks?: { readonly planned?: { readonly checks: readonly { readonly origin: string }[] } | null } } | null } | null;
  const planned = review?.fix?.checks?.planned;
  if (planned === undefined || planned === null) return recorded;
  const checks = planned.checks.map((check) => (check.origin === 'flag' ? { ...check, origin: 'setting', layer: 'flag' } : check));
  return { ...recorded, review: { ...review, fix: { ...review!.fix, checks: { ...review!.fix!.checks, planned: { ...planned, checks } } } } } as unknown as RunState;
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
      const runs = checkpoint.foldRuns();
      if (name === fixtures.at(-1)) assert.deepEqual(runs, expected.runs);
      else {
        // An older fixture was recorded by an engine whose state had fewer
        // fields. Every fact it recorded must still hold, at any depth; new
        // fields may exist beside them.
        assert.equal(runs.length, expected.runs.length);
        for (const [index, recorded] of expected.runs.entries()) {
          const actual: Record<string, unknown> = { ...runs[index] };
          assertHolds(actual, withSettingOrigins(withCommitSeries(withFailureCauses(recorded))), `${name} run ${String(index)}`);
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
          // A review recorded before the survey existed reads as one that applied the reviewer's own rules and was not surveyed: no survey state, its survey skipped (R12 of the repository survey).
          if (review !== null && !('survey' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.equal(review.survey, null, `${name} run ${String(index)} survey`);
            assert.deepEqual(review.configuration.survey, { userRules: 'apply' }, `${name} run ${String(index)} configuration.survey`);
            assert.equal(review.phases.survey.status, 'skipped', `${name} run ${String(index)} survey phase`);
          }
          // A review recorded before the decision step existed reads as one that skipped it and decided nothing (R10 of the decision step).
          if (review !== null && !('decisions' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.equal(review.decisions, null, `${name} run ${String(index)} decisions`);
            assert.equal(review.phases.decision.status, 'skipped', `${name} run ${String(index)} decision phase`);
          }
          // A fix state recorded before claims existed reads as one with none made and none lost (R3 of commit series integrity).
          const recordedFix = (recorded as { review?: { fix?: object | null } | null }).review?.fix ?? null;
          if (review?.fix != null && recordedFix !== null && !('claims' in recordedFix)) {
            assert.deepEqual(review.fix.claims, [], `${name} run ${String(index)} fix.claims`);
            assert.deepEqual(review.fix.lostClaims, [], `${name} run ${String(index)} fix.lostClaims`);
          }
          // A review recorded before answers existed reads as one nobody answered, its answer pass's two phases skipped (R9 of answers).
          if (review !== null && !('answers' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.deepEqual(review.answers, [], `${name} run ${String(index)} answers`);
            assert.deepEqual(review.answerPasses, [], `${name} run ${String(index)} answerPasses`);
            for (const phase of answerPhases) assert.equal(review.phases[phase].status, 'skipped', `${name} run ${String(index)} ${phase}`);
          }
          // A review recorded before the documentation step existed reads as one without it: its phase skipped and no plan (R11 of the documentation step).
          if (review !== null && !('documentationStep' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.equal(review.documentationStep, false, `${name} run ${String(index)} documentationStep`);
            assert.equal(review.phases.documentation.status, 'skipped', `${name} run ${String(index)} documentation phase`);
            if (review.fix !== null) assert.equal(review.fix.documentation, null, `${name} run ${String(index)} fix.documentation`);
          }
          // A review recorded before the triage's account of the change reads as one whose account is unrecorded (R18 of the brief of a run).
          if (review !== null && !('change' in ((recorded as { review?: object | null }).review ?? {}))) {
            assert.deepEqual(review.change, { kind: 'unrecorded' }, `${name} run ${String(index)} change`);
          }
          // A configuration recorded before the Codex Windows sandbox was pinned reads as unelevated for a Codex run on Windows, the only sandbox the engine used there then, and as none for a Codex run whose worktree is rooted at / or for another runtime (R3 of the Codex sandbox).
          const recordedConfiguration = (recorded as { review?: { configuration?: object } | null }).review?.configuration;
          if (review !== null && recordedConfiguration !== undefined && !('codex' in recordedConfiguration)) {
            const onWindows = !runs[index]!.worktree.startsWith('/');
            assert.deepEqual(review.configuration.codex, review.configuration.runtime === 'codex' && onWindows ? { windowsSandbox: 'unelevated' } : null, `${name} run ${String(index)} configuration.codex`);
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

  // The run continued into the fix pass, which every fixture from schema-1-10 on holds (R6 of fix pass continuation).
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) >= 10)) {
    it(`folds ${name}'s continued run as a fix run, its read-only report beside its second`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      const run = checkpoint.foldRuns().find((candidate) => candidate.worktree === '/fixture/continued');
      assert.ok(run?.review !== null && run?.review !== undefined, 'the fixture holds the continued run');
      const { review } = run;
      assert.equal(review.configuration.fix, true, 'the configuration folds as a fix run\'s');
      assert.deepEqual(review.configuration.checks, { timeoutMs: 1_200_000 }, 'with the timeout the pin carries');
      assert.deepEqual(review.configuration.fixes, { batchSize: 4 });
      assert.ok(review.continuedFrom !== null, 'the read-only report is kept');
      assert.deepEqual(review.continuedFrom.report.patches, [], 'the read-only report has no patch');
      assert.notDeepEqual(review.continuedFrom.report.report, review.report?.report, 'the second report is another artifact');
      assert.deepEqual(review.phases.survey, { status: 'completed', attempt: 2 }, 'the survey asked again for the checks');
      assert.equal(review.survey?.answers.length, 2);
      assert.deepEqual(review.survey?.answers[1]?.conventions, review.survey?.answers[0]?.conventions, 'the conventions stand');
      assert.deepEqual(review.phases.report, { status: 'completed', attempt: 2 });
      assert.equal(review.report?.patches.length, 1, 'the second report has the fixer\'s patch');
      assert.equal(review.fix?.revisions.length, 1);
      assert.equal(review.limits.runBudgetUsd, 80, 'the budget raised after the pin is in force');
    });
  }

  // The answered run, which every fixture from schema-1-11 on holds (R9 of answers).
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) >= 11)) {
    it(`folds ${name}'s answered run: the answer, the pass, the report before it beside the second, and two series of commits`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      const run = checkpoint.foldRuns().find((candidate) => candidate.worktree === '/fixture/answered');
      assert.ok(run?.review !== null && run?.review !== undefined && run.review.fix !== null, 'the fixture holds the answered fix run');
      const { review } = run;
      const fix = review.fix!;
      assert.deepEqual(review.answers.map((answer) => [answer.id, answer.answer, answer.appliedBy]), [['DESIGN-1', { kind: 'option', option: 1 }, { phase: 'answer', key: 'pass-1' }]]);
      assert.equal(review.answerPasses.length, 1);
      assert.deepEqual(review.answerPasses[0]!.ids, ['DESIGN-1']);
      assert.equal(review.answerPasses[0]!.reportBefore.patches.length, 1, 'the report before the pass had the fix\'s patch alone');
      assert.notDeepEqual(review.answerPasses[0]!.reportBefore.report, review.report?.report, 'the second report is another artifact');
      assert.equal(review.report?.patches.length, 2, 'the second report has the pass\'s patch too');
      for (const phase of ['answer', 'answer-checks', 'report'] as const) assert.equal(review.phases[phase].status, 'completed', phase);
      assert.deepEqual(review.phases.report, { status: 'completed', attempt: 2 });
      assert.deepEqual(fix.revisions.map((revision) => revision.phase), ['fixes', 'answer']);
      assert.equal(fix.checks.runs['answer-checks'].length, 2);
      assert.deepEqual(fix.commits.map((series) => series.commits.map((commit) => commit.revision)), [['change', 0], [1]]);
      assert.equal(fix.commits[1]!.from, fix.commits[0]!.to, 'the later series stands on the first one\'s last commit');
    });
  }

  // Every run of a fixture before schema-1-12 was recorded before the settings: it reads as a run whose values came from the defaults and its flags, whose scope left nothing out (R17 of the configuration).
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) < 12)) {
    it(`reads ${name}'s runs as recorded before the settings`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      for (const run of checkpoint.foldRuns()) {
        if (run.scope !== null) {
          assert.deepEqual(run.scope.request.exclude, [], run.worktree);
          assert.deepEqual(run.scope.excluded, { paths: [], count: 0 }, run.worktree);
        }
        if (run.review !== null) {
          assert.equal(run.review.configuration.settings, null, run.worktree);
          assert.equal(run.review.configuration.fixSettings, null, run.worktree);
        }
      }
    });
  }

  // The runs configured from the settings, which every fixture from schema-1-12 on holds (R6, R10, R11 of the configuration).
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) >= 12)) {
    it(`folds ${name}'s runs configured from the settings: the paths left out, the layers, the settings' checks and the fix side`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      const runs = checkpoint.foldRuns();
      const settled = runs.find((candidate) => candidate.worktree === '/fixture/settled');
      assert.ok(settled?.review?.configuration.settings !== null && settled?.review?.configuration.settings !== undefined, 'the fixture holds the run configured from the settings');
      assert.deepEqual(settled.scope?.request.exclude, ['dist/**']);
      assert.deepEqual(settled.scope?.excluded, { paths: ['dist/changed.js'], count: 1 });
      const { settings } = settled.review.configuration;
      assert.equal(settings.layers['scope.exclude'], 'repository');
      assert.deepEqual(settings.notFollowed.map((entry) => [entry.name, entry.layer]), [['checks.test', 'clone']]);
      assert.deepEqual(settled.review.fix?.checks.planned?.checks.map((check) => [check.kind, check.origin, check.layer]), [['build', 'survey', null], ['typecheck', 'none', null], ['lint', 'setting', 'repository'], ['test', 'setting', 'clone']]);
      const repinned = runs.find((candidate) => candidate.worktree === '/fixture/repinned');
      assert.ok(repinned?.review !== null && repinned?.review !== undefined, 'the fixture holds the run continued by a version 2 pin');
      assert.equal(repinned.review.configuration.fix, true);
      assert.deepEqual(repinned.review.configuration.fixSettings?.values['tools.path'], ['/fixture/repinned/.venv/bin']);
      assert.ok(repinned.review.fix?.checks.planned?.checks.every((check) => check.origin === 'setting'), 'the settings planned every check with the pin');
      assert.deepEqual(repinned.review.phases.survey, { status: 'completed', attempt: 1 }, 'the survey is not asked again');
    });
  }

  // The triage's account of the change, which the resumed run of every fixture from schema-1-14 on records (R3 of the brief of a run); the documented run of every fixture from schema-1-15 on records that its triage gave none; every other run's triage recorded version 1.
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) >= 14)) {
    it(`folds ${name}'s triage account of the change, and every older triage's as unrecorded`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      const runs = checkpoint.foldRuns();
      const resumed = runs.find((candidate) => candidate.worktree === '/fixture/resumed');
      assert.ok(resumed?.review !== null && resumed?.review !== undefined, 'the fixture holds the resumed run');
      const { change } = resumed.review;
      assert.equal(change.kind, 'given');
      assert.equal(change.kind === 'given' ? change.reading.title : null, 'Accept an empty input');
      assert.equal(change.kind === 'given' ? change.reading.publicInterface.holds : null, true);
      const documented = runs.find((candidate) => candidate.worktree === '/fixture/documented');
      if (documented !== undefined) assert.deepEqual(documented.review?.change, { kind: 'none' });
      for (const run of runs.filter((candidate) => candidate !== resumed && candidate !== documented && candidate.review !== null && candidate.review.leads !== null)) {
        assert.deepEqual(run.review!.change, { kind: 'unrecorded' }, run.worktree);
      }
    });
  }

  // The run with the documentation step, which every fixture from schema-1-15 on holds (R1, R2, R5 of the documentation step).
  for (const name of fixtures.filter((fixture) => Number(fixturePattern.exec(fixture)![2]) >= 15)) {
    it(`folds ${name}'s documented run: the step's plan of its document and the search, its answer and its revision, after the fixes and before their checks`, () => {
      const copy = join(sandbox, name);
      cpSync(join(fixturesRoot, name), copy, { recursive: true });
      const checkpoint = Checkpoint.open(copy, { engine: 'golden-test' });
      opened.push(checkpoint);
      const documented = checkpoint.foldRuns().find((candidate) => candidate.worktree === '/fixture/documented')?.review;
      assert.ok(documented !== null && documented !== undefined && documented.fix !== null, 'the fixture holds the documented run');
      assert.equal(documented.documentationStep, true);
      assert.deepEqual(documented.phases.documentation, { status: 'completed', attempt: 1 });
      assert.deepEqual(documented.fix.documentation?.items.map((item) => [item.id, item.path, item.drift.length]), [['doc-1', 'docs/testing.md', 2], ['search', null, 0]]);
      assert.deepEqual(documented.fix.answers.documentation.documentation?.findings.map((finding) => [finding.id, finding.status]), [['doc-1', 'applied'], ['search', 'already-applied']]);
      assert.deepEqual(documented.fix.revisions.map((revision) => [revision.phase, revision.change.findings]), [['fixes', ['SCAN-1']], ['documentation', ['doc-1']]]);
      assert.equal(documented.report?.patches.length, 2);
    });
  }

  it('matches the newest fixture\'s identity, so a schema or registry change needs a new fixture', () => {
    const newest = fixtures.at(-1)!;
    const recorded = JSON.parse(readFileSync(join(fixturesRoot, newest, 'identity.json'), 'utf8')) as CheckpointIdentity;
    const current = checkpointIdentity();
    assert.deepEqual(
      current,
      recorded,
      `The ledger DDL or the event registry changed since ${newest} was written. Run \`npm run golden -- --output test/fixtures/checkpoints/${nextFixtureName(newest, current.schema)}\` and commit the result.`,
    );
  });

  it('names the fixture to write next with the next serial, which the fixture pattern reads', () => {
    for (const [newest, schema, next] of [['schema-1-07', 1, 'schema-1-08'], ['schema-1-09', 1, 'schema-1-10'], ['schema-1-07', 2, 'schema-2-08'], ['schema-2-99', 2, 'schema-2-100']] as const) {
      const name = nextFixtureName(newest, schema);
      assert.equal(name, next);
      assert.match(name, fixturePattern);
    }
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
