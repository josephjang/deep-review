import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findActiveRun, unelevatedEditorsWarning, type ReviewOptions } from '../../src/review/controller.ts';
import { InvalidPolicyError, ReviewRefusedError } from '../../src/review/errors.ts';
import { unelevatedSandboxRule } from '../../src/review/tasks.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';
import type { RuntimeAdapter } from '../../src/runtime/adapter.ts';
import { RuntimeRegistry } from '../../src/runtime/registry.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { captureScope } from '../../src/scope/capture.ts';
import { fixerAnswer } from '../helpers/fake-runtime.ts';
import { fakeCheckCommand, ReviewSandbox } from '../helpers/review-sandbox.ts';

describe('the Codex Windows sandbox in a run (R1 to R3 of the Codex sandbox)', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  /** Every launch's runtime and the pinned options its plan handed the adapter, in order. */
  let launched: { runtime: string; options: unknown }[];
  beforeEach(() => {
    box = new ReviewSandbox();
    launched = [];
    // The triage fails twice, so each invocation stops after the survey with the run still active.
    box.script({ triage: { exit: 2 } });
  });
  afterEach(() => {
    box.close();
  });

  /** The engine's runtimes, each command recording what the launch's plan pinned before the adapter builds it. */
  const spying = (adapter: RuntimeAdapter): RuntimeAdapter => ({
    ...adapter,
    command: (invocation, plan) => {
      launched.push({ runtime: adapter.name, options: plan.runtimeOptions });
      return adapter.command(invocation, plan);
    },
  });
  const runtimes = new RuntimeRegistry(defaultRuntimes().names().map((name) => spying(defaultRuntimes().get(name))));
  /** The distinct pinned options the launches since the last reset were handed, in the order first seen; at least one worker launched. */
  const launchedWith = (): unknown[] => {
    assert.ok(launched.length > 0, 'a worker launched');
    return [...new Set(launched.map((launch) => JSON.stringify(launch.options)))].map((text): unknown => JSON.parse(text));
  };
  /** A Codex review through the spying runtimes, on the platform given, Windows by default. */
  const codex = (change: Partial<ReviewOptions> = {}): ReturnType<ReviewSandbox['review']> => box.review('codex', { runtimes, platform: 'win32', ...change });
  const configured = (): Record<string, unknown> => box.events(box.run().id).find(([kind]) => kind === 'review.configured')![1];
  const versionOfConfiguration = (): number => box.checkpoint.ledger.events(box.run().id).find((event) => event.kind === 'review.configured')!.version;

  it('pins the flag\'s sandbox on a Codex run on Windows, and launches every worker with it', async () => {
    const outcome = await codex({ flags: { codexWindowsSandbox: 'elevated' } });
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' });
    assert.deepEqual(configured().codex, { windowsSandbox: 'elevated' }, 'recorded on the ledger');
    assert.equal(versionOfConfiguration(), 5);
    assert.deepEqual(launchedWith(), [{ windowsSandbox: 'elevated' }], 'every worker launches with the pinned sandbox');
    assert.ok(launched.every((launch) => launch.runtime === 'codex'));
    assert.ok(box.logs.some((line) => /^run [0-9a-f-]+: configured for codex .*, Codex Windows sandbox elevated; the reviewer's own rules: judge$/.test(line)), box.logs.join('\n'));
  });

  it('pins the policy\'s value when the flag says nothing', async () => {
    await codex();
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'none' }, 'the committed policy ships none');
    assert.deepEqual(launchedWith(), [{ windowsSandbox: 'none' }]);
  });

  it('pins none on another platform and says the flag is ignored, so every worker runs as without it', async () => {
    await codex({ platform: 'linux', flags: { codexWindowsSandbox: 'none' } });
    assert.equal(box.run().review!.configuration.codex, null);
    assert.deepEqual(launchedWith(), [null], 'no worker is handed a sandbox');
    assert.ok(box.logs.includes('--codex-windows-sandbox applies on Windows only; it is ignored on linux, where every Codex worker runs as without it'), box.logs.join('\n'));
  });

  it('pins none for a Claude Code run, and refuses the flag there', async () => {
    await box.review('claude', { runtimes, platform: 'win32' });
    assert.equal(box.run().review!.configuration.codex, null);
    assert.deepEqual(launchedWith(), [null], 'no worker is handed a sandbox');
    assert.ok(launched.every((launch) => launch.runtime === 'claude'));
    await assert.rejects(box.review('claude', { runtimes, platform: 'win32', flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof InvalidPolicyError && error.message === '--codex-windows-sandbox applies only to runtime codex, not claude');
  });

  it('refuses a resume that asks for another sandbox, by name, and resumes one that asks for the same or says nothing', async () => {
    await codex({ flags: { codexWindowsSandbox: 'elevated' } });
    const runId = box.run().id;
    const sequence = box.run().lastSequence;
    await assert.rejects(codex({ flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof ReviewRefusedError
      && error.message === `run ${runId} is pinned to the Codex Windows sandbox elevated, not none; run it with --codex-windows-sandbox elevated or without the flag, or abandon it with \`deep-review abandon --run ${runId} --reason <text>\``);
    assert.equal(box.run().lastSequence, sequence, 'the refusal recorded nothing');
    launched = [];
    assert.equal((await codex({ flags: { codexWindowsSandbox: 'elevated' } })).kind, 'blocked');
    assert.equal((await codex()).kind, 'blocked');
    assert.equal(box.run().id, runId, 'the same run resumed');
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' });
    assert.deepEqual(launchedWith(), [{ windowsSandbox: 'elevated' }], 'each resume launches every worker with the pinned sandbox, flag or none');
  });

  it('names the flag as ignored on the resume of a run configured off Windows, there and on Windows', async () => {
    await codex({ platform: 'linux' });
    const runId = box.run().id;
    assert.equal((await codex({ platform: 'linux', flags: { codexWindowsSandbox: 'elevated' } })).kind, 'blocked');
    assert.ok(box.logs.includes(`--codex-windows-sandbox applies on Windows only; it is ignored on linux, where every Codex worker of run ${runId} runs as without it`), box.logs.join('\n'));
    launched = [];
    assert.equal((await codex({ flags: { codexWindowsSandbox: 'elevated' } })).kind, 'blocked');
    assert.equal(box.run().id, runId, 'the same run resumed');
    assert.equal(box.run().review!.configuration.codex, null);
    assert.ok(box.logs.includes(`run ${runId} pins no Codex Windows sandbox, since it was not configured on Windows; --codex-windows-sandbox is ignored`), box.logs.join('\n'));
    assert.deepEqual(launchedWith(), [null], 'its workers launch with no sandbox pinned on Windows too');
  });

  // Only a Windows worktree reads as a run on Windows, so the older run this stands in for exists only on a Windows host.
  it('resumes a Codex run configured on Windows before the setting existed under the unelevated sandbox', { skip: process.platform !== 'win32' && 'only a Windows worktree folds to the unelevated sandbox' }, async () => {
    await codex({ flags: { codexWindowsSandbox: 'none' } });
    // Stand in for an older engine on Windows: the same configuration at version 3, without the setting, on a run of its own.
    const pinned = { ...configured() };
    delete pinned.codex;
    const first = box.run();
    box.checkpoint.append(first.id, first.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    const older = box.checkpoint.createRun({ worktree: box.repo });
    const captured = captureScope(box.checkpoint, older.id, { paths: [] });
    box.checkpoint.append(older.id, captured.lastSequence, [{ kind: 'review.configured', version: 3, payload: pinned }]);
    launched = [];
    await assert.rejects(codex({ flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof ReviewRefusedError && /is pinned to the Codex Windows sandbox unelevated, not none/.test(error.message));
    await codex();
    assert.deepEqual(box.checkpoint.fold(older.id).review!.configuration.codex, { windowsSandbox: 'unelevated' });
    assert.deepEqual(launchedWith(), [{ windowsSandbox: 'unelevated' }], 'the refused resume launched nothing, and the accepted one launched with the folded sandbox');
  });

  it('names the flag as ignored, not refused, on the resume off Windows of a Codex run configured before the setting existed', async () => {
    await codex({ platform: 'linux' });
    // Stand in for an older engine: the same configuration at version 3, without the setting, which folds to unelevated from a Windows worktree and to none from one rooted at /.
    const pinned = { ...configured() };
    delete pinned.codex;
    const first = box.run();
    box.checkpoint.append(first.id, first.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'stand in for an older engine' } }]);
    const older = box.checkpoint.createRun({ worktree: box.repo });
    const captured = captureScope(box.checkpoint, older.id, { paths: [] });
    box.checkpoint.append(older.id, captured.lastSequence, [{ kind: 'review.configured', version: 3, payload: pinned }]);
    assert.deepEqual(box.checkpoint.fold(older.id).review!.configuration.codex, box.repo.startsWith('/') ? null : { windowsSandbox: 'unelevated' }, 'the fold reads the platform from the recorded worktree');
    for (const sandbox of ['none', 'elevated', 'unelevated'] as const) {
      const before = box.checkpoint.fold(older.id).lastSequence;
      assert.equal((await codex({ platform: 'linux', flags: { codexWindowsSandbox: sandbox } })).kind, 'blocked', sandbox);
      assert.ok(box.checkpoint.fold(older.id).lastSequence > before, `the older run resumed under ${sandbox}`);
    }
    const ignored = `--codex-windows-sandbox applies on Windows only; it is ignored on linux, where every Codex worker of run ${older.id} runs as without it`;
    assert.equal(box.logs.filter((line) => line === ignored).length, 3, box.logs.join('\n'));
    assert.ok(!box.logs.some((line) => line.includes('pins no Codex Windows sandbox')), 'off Windows the flag is ignored for what the run pinned, not refused or named as a missing pin');
  });

  it('names the flag as ignored on the resume off Windows of a run configured on Windows', async () => {
    await codex({ flags: { codexWindowsSandbox: 'elevated' } });
    const runId = box.run().id;
    assert.equal((await codex({ platform: 'darwin', flags: { codexWindowsSandbox: 'none' } })).kind, 'blocked');
    assert.equal(box.run().id, runId, 'the same run resumed');
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' }, 'the pin stands for a later resume on Windows');
    assert.ok(box.logs.includes(`--codex-windows-sandbox applies on Windows only; it is ignored on darwin, where every Codex worker of run ${runId} runs as without it`), box.logs.join('\n'));
  });

  /** The `windows.sandbox` settings on the command line of the last worker the fake recorded. */
  const windowsSandboxArgs = (recordFile: string): string[] => (JSON.parse(readFileSync(recordFile, 'utf8')) as { argv: string[] }).argv.filter((arg) => arg.startsWith('windows.sandbox='));

  it('builds the command of a worker for the platform the run is configured for: none named off Windows, whatever the host', async () => {
    const recordFile = join(box.directory, 'record.json');
    await box.review('codex', { runtimes, platform: 'linux' }, { FAKE_RECORD: recordFile });
    assert.deepEqual(windowsSandboxArgs(recordFile), []);
  });

  it('builds the command of a worker for the platform the run is configured for: the pinned sandbox on Windows, whatever the host', async () => {
    const recordFile = join(box.directory, 'record.json');
    await box.review('codex', { runtimes, platform: 'win32', flags: { codexWindowsSandbox: 'elevated' } }, { FAKE_RECORD: recordFile });
    assert.deepEqual(windowsSandboxArgs(recordFile), ['windows.sandbox="elevated"']);
  });

  it('launches every worker with the pinned sandbox over the one the caller built the runtimes with', async () => {
    const recordFile = join(box.directory, 'record.json');
    const builtUnelevated = defaultRuntimes({ codex: { windowsSandbox: 'unelevated' } });
    await box.review('codex', { runtimes: builtUnelevated, platform: 'win32', flags: { codexWindowsSandbox: 'elevated' } }, { FAKE_RECORD: recordFile });
    assert.deepEqual(box.run().review!.configuration.codex, { windowsSandbox: 'elevated' });
    assert.deepEqual(windowsSandboxArgs(recordFile), ['windows.sandbox="elevated"'], 'the pin wins over the construction default');
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
    assert.equal(warnings()[0], `run ${runId}: warning: its fixers and repair worker run in Codex's unelevated Windows sandbox, where a Node process cannot start a child whose output it captures, so they cannot run tools that start processes through Node, which includes most build and test commands; the sandbox is pinned on the run, so to run them abandon it with \`deep-review abandon --run ${runId} --reason <text>\` and start a new run with --codex-windows-sandbox elevated, which needs Codex's elevated setup, or none, which runs them in no sandbox`);
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

  it('gives a resumed run advice it can follow: the flag alone is refused, and abandoning the run first starts one that can run the build', async () => {
    box.script({ triage: { exit: 2 } });
    assert.equal((await box.fix('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'unelevated' } })).kind, 'blocked');
    const runId = box.run().id;
    assert.equal((await box.fix('codex', { platform: 'win32' })).kind, 'blocked');
    assert.deepEqual(warnings(), [unelevatedEditorsWarning(runId), unelevatedEditorsWarning(runId)], 'the resume says what the first invocation said');
    assert.ok(warnings()[1]!.includes(`abandon it with \`deep-review abandon --run ${runId} --reason <text>\` and start a new run with --codex-windows-sandbox elevated`), warnings().join('\n'));
    // The flag alone, on the run the warning is about, is refused, as the warning says.
    await assert.rejects(box.fix('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'none' } }), (error: unknown) => error instanceof ReviewRefusedError && /is pinned to the Codex Windows sandbox unelevated, not none/.test(error.message));
    // Abandoning it first, as the warning says, lets the flag start a run pinned to the new value, which does not warn.
    const pinned = box.run();
    box.checkpoint.append(pinned.id, pinned.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'start again with a sandbox that runs the build' } }]);
    assert.equal((await box.fix('codex', { platform: 'win32', flags: { codexWindowsSandbox: 'none' } })).kind, 'blocked');
    const active = findActiveRun(box.checkpoint);
    assert.ok(active !== null && active.id !== runId, 'a new run');
    assert.deepEqual(active.review!.configuration.codex, { windowsSandbox: 'none' });
    assert.equal(warnings().length, 2, 'the new run does not warn');
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

describe('the surveyor of an elevated run (R12 of the Codex sandbox)', { timeout: 600_000 }, () => {
  let box: ReviewSandbox;
  beforeEach(() => {
    box = new ReviewSandbox();
    // The flags settle three kinds and leave test to the surveyor, whose task then says how to look a tool up; the triage fails twice, so the run stops after the survey.
    box.script({
      surveyor: { output: { conventions: [], userRules: [], checks: [{ kind: 'test', command: fakeCheckCommand('test'), basis: 'stated', source: { path: 'package.json', quote: '"test": "node ..."' }, missingTool: null, reason: null }], note: '' } },
      triage: { exit: 2 },
    });
  });
  afterEach(() => {
    box.close();
  });

  const threeSettled = { commands: { build: fakeCheckCommand('build'), typecheck: fakeCheckCommand('typecheck'), lint: fakeCheckCommand('lint') }, dropped: [] };
  const surveyorPrompt = (): string => box.promptOf(box.run(), 'surveyor survey:survey');

  it('is told to look tools up with Get-Command, not where.exe', async () => {
    assert.equal((await box.review('codex', { platform: 'win32', fix: threeSettled, flags: { codexWindowsSandbox: 'elevated' } })).kind, 'blocked');
    assert.match(surveyorPrompt(), /, with `powershell\.exe -NoProfile -Command "Get-Command -CommandType Application <tool>"` and, when that fails, the same with `\.\\<tool>`, since `cmd\.exe` also runs a script in the repository root[^\n]* \(not `where\.exe`/);
    assert.doesNotMatch(surveyorPrompt(), /with `where\.exe <tool>`/);
  });

  for (const windowsSandbox of ['none', 'unelevated'] as const) {
    it(`is told to use where.exe under ${windowsSandbox}, where it works`, async () => {
      assert.equal((await box.review('codex', { platform: 'win32', fix: threeSettled, flags: { codexWindowsSandbox: windowsSandbox } })).kind, 'blocked');
      assert.match(surveyorPrompt(), /, with `where\.exe <tool>`, and judge/);
      assert.doesNotMatch(surveyorPrompt(), /Get-Command/);
    });
  }
});
