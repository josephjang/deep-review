import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { unelevatedEditorsWarning, type ReviewOptions } from '../../src/review/controller.ts';
import { InvalidPolicyError, ReviewRefusedError } from '../../src/review/errors.ts';
import { unelevatedSandboxRule } from '../../src/review/tasks.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';
import type { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { defaultRuntimes, type RuntimeOptions } from '../../src/runtime/runtimes.ts';
import { captureScope } from '../../src/scope/capture.ts';
import { fixerAnswer } from '../helpers/fake-runtime.ts';
import { ReviewSandbox } from '../helpers/review-sandbox.ts';

describe('the Codex Windows sandbox in a run (R1 to R3 of the Codex sandbox)', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  /** Every set of options the controller built the runtimes with, in order. */
  let built: RuntimeOptions[];
  beforeEach(() => {
    box = new ReviewSandbox();
    built = [];
    // The triage fails twice, so each invocation stops after the survey with the run still active.
    box.script({ triage: { exit: 2 } });
  });
  afterEach(() => {
    box.close();
  });

  const runtimes = (options: RuntimeOptions): RuntimeRegistry => {
    built.push(options);
    return defaultRuntimes(options);
  };
  /** A Codex review through the spying runtimes, on the platform given, Windows by default. */
  const codex = (change: Partial<ReviewOptions> = {}): ReturnType<ReviewSandbox['review']> => box.review('codex', { runtimes, platform: 'win32', ...change });
  const configured = (): Record<string, unknown> => box.events(box.run().id).find(([kind]) => kind === 'review.configured')![1];
  const versionOfConfiguration = (): number => box.checkpoint.ledger.events(box.run().id).find((event) => event.kind === 'review.configured')!.version;

  it('pins the flag\'s sandbox on a Codex run on Windows, and launches its workers on runtimes built with it', async () => {
    const outcome = await codex({ flags: { codexWindowsSandbox: 'elevated' } });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' });
    assert.deepEqual(configured().codex, { windowsSandbox: 'elevated' }, 'recorded on the ledger');
    assert.equal(versionOfConfiguration(), 4);
    assert.deepEqual(built, [{}, { codex: { windowsSandbox: 'elevated' } }], 'the policy and the preflight read an adapter no option changes, the workers launch on the pinned one');
    assert.ok(box.logs.some((line) => /^run [0-9a-f-]+: configured for codex .*, Codex Windows sandbox elevated; the reviewer's own rules: judge$/.test(line)), box.logs.join('\n'));
  });

  it('pins the policy\'s value when the flag says nothing', async () => {
    await codex();
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'none' }, 'the committed policy ships none');
    assert.deepEqual(built.at(-1), { codex: { windowsSandbox: 'none' } });
  });

  it('pins none on another platform and says the flag is ignored, so every worker runs as without it', async () => {
    await codex({ platform: 'linux', flags: { codexWindowsSandbox: 'none' } });
    assert.equal(box.run().review!.configuration.codex, null);
    assert.deepEqual(built, [{}, {}]);
    assert.ok(box.logs.includes('--codex-windows-sandbox applies on Windows only; it is ignored on linux, where every Codex worker runs as without it'), box.logs.join('\n'));
  });

  it('pins none for a Claude Code run, and refuses the flag there', async () => {
    await box.review('claude', { runtimes, platform: 'win32' });
    assert.equal(box.run().review!.configuration.codex, null);
    assert.deepEqual(built, [{}, {}]);
    await assert.rejects(box.review('claude', { runtimes, platform: 'win32', flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof InvalidPolicyError && error.message === '--codex-windows-sandbox applies only to runtime codex, not claude');
  });

  it('refuses a resume that asks for another sandbox, by name, and resumes one that asks for the same or says nothing', async () => {
    await codex({ flags: { codexWindowsSandbox: 'elevated' } });
    const runId = box.run().id;
    const sequence = box.run().lastSequence;
    await assert.rejects(codex({ flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${runId} is pinned to the Codex Windows sandbox elevated, not none; run it with --codex-windows-sandbox elevated or without the flag, or abandon it with \`deep-review abandon --run ${runId} --reason <text>\``);
    assert.equal(box.run().lastSequence, sequence, 'the refusal recorded nothing');
    built = [];
    assert.equal((await codex({ flags: { codexWindowsSandbox: 'elevated' } })).kind, 'blocked');
    assert.equal((await codex()).kind, 'blocked');
    assert.equal(box.run().id, runId, 'the same run resumed');
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' });
    assert.deepEqual(built, [{}, { codex: { windowsSandbox: 'elevated' } }, {}, { codex: { windowsSandbox: 'elevated' } }], 'each resume launches on the pinned sandbox');
  });

  it('names the flag as ignored on the resume of a run configured off Windows', async () => {
    await codex({ platform: 'linux' });
    const runId = box.run().id;
    await codex({ platform: 'linux', flags: { codexWindowsSandbox: 'elevated' } });
    assert.equal(box.run().review!.configuration.codex, null);
    assert.ok(box.logs.includes(`run ${runId} pins no Codex Windows sandbox, since it was not configured on Windows; --codex-windows-sandbox is ignored`), box.logs.join('\n'));
  });

  it('resumes a Codex run configured before the setting existed under the unelevated sandbox', async () => {
    await codex({ flags: { codexWindowsSandbox: 'none' } });
    // Stand in for an older engine: the same configuration at version 3, without the setting, on a run of its own.
    const pinned = { ...configured() };
    delete pinned.codex;
    const first = box.run();
    box.checkpoint.append(first.id, first.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    const older = box.checkpoint.createRun({ worktree: box.repo });
    const captured = captureScope(box.checkpoint, older.id, { paths: [] });
    box.checkpoint.append(older.id, captured.lastSequence, [{ kind: 'review.configured', version: 3, payload: pinned }]);
    built = [];
    await assert.rejects(codex({ flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof ReviewRefusedError && /is pinned to the Codex Windows sandbox unelevated, not none/.test(error.message));
    await codex();
    assert.deepEqual(box.checkpoint.fold(older.id).review!.configuration.codex, { windowsSandbox: 'unelevated' });
    assert.deepEqual(built.at(-1), { codex: { windowsSandbox: 'unelevated' } });
  });
});

describe('the editors of a fix run in the unelevated sandbox (R5, R6 of the Codex sandbox)', { timeout: 900_000 }, () => {
  let box: ReviewSandbox;
  beforeEach(() => {
    box = new ReviewSandbox();
    // One finding for one fixer, and a lint check failing before and after the fixes, so a repair worker runs too.
    box.checks({ lint: 'fail' });
    box.script({
      triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'parse(null) throws' }], leads: finderAngles.map((angle) => ({ angle, lead: null })) } },
      'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n\nexport function other() {\n  return parse(null);\n}\n' } }], output: fixerAnswer([{ files: ['src/a.ts'] }]) },
      'fixer:repair:repair': { output: fixerAnswer([{ status: 'deferred', files: [], note: 'every failure was there before the fixes' }]) },
    });
  });
  afterEach(() => {
    box.close();
  });

  const warnings = (): string[] => box.logs.filter((line) => line.includes(': warning: its fixers and repair worker run in Codex\'s unelevated Windows sandbox'));
  const editorPrompts = (): string[] => ['fixer fixes:c1-1', 'fixer repair:repair'].map((label) => box.promptOf(box.run(), label));

  it('warns before the first worker and tells the fixer and the repair worker what cannot run, while no reader is told', async () => {
    const outcome = await box.fix('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'unelevated' } });
    assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
    const runId = box.run().id;
    assert.deepEqual(warnings(), [unelevatedEditorsWarning(runId)], 'printed once');
    assert.match(warnings()[0]!, /cannot run tools that start processes through Node, which includes most build and test commands; a run started with --codex-windows-sandbox elevated, which needs Codex's elevated setup, or none, which runs them in no sandbox, can run them$/);
    const firstWorker = box.logs.findIndex((line) => /^worker \S+ \S+: started$/.test(line));
    assert.ok(firstWorker > box.logs.indexOf(warnings()[0]!), 'the warning comes before the first worker starts');
    for (const prompt of editorPrompts()) assert.ok(prompt.includes(unelevatedSandboxRule), prompt);
    for (const label of ['surveyor survey:survey', 'triage triage:SCAN', 'finder-RIPPLE finders:RIPPLE']) assert.ok(!box.promptOf(box.run(), label).includes(unelevatedSandboxRule), label);
    // The report names the sandbox in its run section (R7).
    if (outcome.kind === 'report') assert.match(readFileSync(outcome.reportPath, 'utf8'), /^Runtime: codex .*\nCodex Windows sandbox: unelevated$/m);
  });

  it('warns again on each resume of such a run', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'unelevated' } })).kind, 'blocked');
    assert.equal((await box.fix('codex', { platform: 'win32' })).kind, 'blocked', 'a resume without the flag keeps the pinned unelevated');
    assert.equal(warnings().length, 2);
  });

  // The editors can run the build under each of these, so the run neither warns nor tells them anything, and their tasks are what they were before the setting existed.
  for (const [name, runtime, change] of [
    ['elevated', 'codex', { platform: 'win32', flags: { codexWindowsSandbox: 'elevated' } }],
    ['none', 'codex', { platform: 'win32', flags: { codexWindowsSandbox: 'none' } }],
    ['the shipped default, which is none', 'codex', { platform: 'win32' }],
    ['Codex on another platform', 'codex', { platform: 'linux' }],
    ['Claude Code', 'claude', { platform: 'win32' }],
  ] as const) {
    it(`neither warns nor tells the editors anything under ${name}`, async () => {
      const outcome = await box.fix(runtime, change);
      assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
      assert.deepEqual(warnings(), []);
      for (const prompt of editorPrompts()) assert.ok(!prompt.includes(unelevatedSandboxRule) && !prompt.includes('EPERM'), prompt);
    });
  }

  it('does not warn a read-only run under unelevated, which has no editor', async () => {
    assert.equal((await box.review('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'unelevated' } })).kind, 'report');
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'unelevated' });
    assert.deepEqual(warnings(), []);
  });
});
