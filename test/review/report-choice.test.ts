import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { chooseReportRun, notShownLines, shownPassedOver } from '../../src/review/report-choice.ts';
import { shortRunId } from '../../src/review/runs.ts';
import { fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, node } from '../helpers/launcher.ts';
import { git } from '../helpers/repository.ts';
import { ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure` });
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));
const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n';
const fixedB = 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n';

/** Two findings, one in src/a.ts and one in src/b.ts, each fixed by its cluster's fixer. */
const twoFixes: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: null } },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA, 'test/a.test.ts': 'test a\n' } }], output: fixerAnswer([{ files: ['src/a.ts', 'test/a.test.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB } }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) },
};

describe('notShownLines (R8 of the questions in the chat)', () => {
  const later = (n: number, state = 'is in progress'): { run: string; state: string } => ({ run: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, state });

  it('gives no line when report passed over no run', () => {
    assert.deepEqual(notShownLines([]), []);
  });

  it('names each later run by the first 8 characters of its id and its state, at most three, then counts the others', () => {
    assert.equal(shownPassedOver, 3);
    assert.deepEqual(notShownLines([later(1, 'was abandoned: wrong scope')]), ['Not shown: run 00000001, a later run, was abandoned: wrong scope.']);
    assert.deepEqual(notShownLines([later(4), later(3), later(2)]).map((line) => line.slice(0, 20)), ['Not shown: run 00000', 'Not shown: run 00000', 'Not shown: run 00000']);
    assert.deepEqual(notShownLines([later(5), later(4), later(3), later(2), later(1)]).slice(3), ['Not shown: 2 more later runs; deep-review status --all lists them']);
    assert.deepEqual(notShownLines([later(4), later(3), later(2), later(1)]).slice(3), ['Not shown: 1 more later run; deep-review status --all lists them']);
  });

  it('cuts a line at a word at 200 characters, since the reason of an abandon has no limit', () => {
    const [line] = notShownLines([later(1, `was abandoned: ${'very '.repeat(60)}long`)]);
    assert.ok(line!.length <= 200, String(line!.length));
    assert.ok(line!.endsWith('very...'), line!);
  });
});

describe('chooseReportRun (R8 of the questions in the chat)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('shows a read-only run continued into the fix pass after a later run finished, the run that ended last, and passes no run over', async (t) => {
    const box = ReviewSandbox.forTest(t, twoFixes);
    assert.equal((await box.review('claude')).kind, 'report');
    const continued = box.checkpoint.foldRuns().at(-1)!.id;
    // A fix run that started after the read-only one, and its edits put back so the read-only run's change is as it reviewed it.
    assert.equal((await box.fix('claude', { fresh: true, flags: { concurrency: 1 } })).kind, 'report');
    const created = box.checkpoint.foldRuns().at(-1)!;
    assert.notEqual(created.id, continued);
    git(box.repo, 'checkout', '--', 'src');
    rmSync(join(box.repo, 'test'), { recursive: true });
    box.script(twoFixes);
    assert.equal((await box.fix('claude', { flags: { concurrency: 1 } })).kind, 'report');
    assert.notEqual(box.checkpoint.fold(continued).review!.continuedFrom, null, 'the read-only run was continued, not a third run created');
    assert.ok(box.checkpoint.fold(continued).createdAt < created.createdAt, 'the continued run started first');

    const choice = chooseReportRun(box.checkpoint, box.repo, () => {});
    assert.equal(choice.run?.id, continued, 'the run that ended last, not the one that started last');
    assert.deepEqual(choice.passedOver, []);
    const shown = await node([cli, 'report'], { cwd: box.repo, env: { ...baseEnvironment, HOME: box.home, USERPROFILE: box.home } });
    assert.equal(shown.status, 0, shown.stderr);
    const lines = shown.stdout.trimEnd().split('\n');
    assert.match(lines[0]!, new RegExp(`\\(run ${shortRunId(continued)}\\)$`), 'no Not shown line comes first');
    assert.ok(!lines.some((line) => line.startsWith('Not shown:')), shown.stdout);
  });
});
