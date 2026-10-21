import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { UnknownRunError } from '../../src/checkpoint/errors.ts';
import type { Answer } from '../../src/checkpoint/events.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { answerRun, whyNotAnswerable, type AnswerOptions } from '../../src/review/answer.ts';
import { commitRun } from '../../src/review/commit.ts';
import { gitContent } from '../../src/review/content.ts';
import { spendBound } from '../../src/review/controller.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { reportCopyPath } from '../../src/review/report-copy.ts';
import { budgetSpendOf } from '../../src/review/spend.ts';
import { claudeAdapter } from '../../src/runtime/claude.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment, type Finished, node } from '../helpers/launcher.ts';
import { commitAll, git, write } from '../helpers/repository.ts';
import { answerableDecisions, configured, decidedFixRun, decidedOf, readOnlyReported, reported } from '../helpers/review-history.ts';
import { loadedRunnerTimeoutMs, reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const cli = resolve(import.meta.dirname, '../../src/cli.ts');
const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure` });
const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** src/a.ts once a fixer applied the departing fix, and once the answer pass followed the rule instead. */
const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n\nexport function other() {\n  return parse(null);\n}\n';
const ruledA = 'export function parse(text: string | null) {\n  if (text === null) throw new Error(\'parse throws on a null input\');\n  return text.length;\n}\n\nexport function other() {\n  return parse(\'\');\n}\n';
/** src/b.ts once the answer pass took the question's other option. */
const otherB = 'import { parse } from \'./a.ts\';\nexport const b = parse("x");\n';

/**
 * A review whose triage finds two defects: one in src/a.ts, which the
 * decider decides to fix, departing from a rule, and one in src/b.ts,
 * which it asks about, its default keeping the code. The fixes phase's
 * fixer applies the first; an answer pass's fixer applies whatever its
 * findings are, rewriting both files.
 */
const answerable: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: null } },
  decider: { output: deciderAnswer([{ departs: true }, { decision: 'ask', edits: false }]) },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': fixedA } }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
};

/** The answer pass's fixer of pass `n`, applying each of its findings with an edit of the file it is located in. */
const passFixer = (n: number, files: readonly (readonly [path: string, content: string])[]): Script => ({
  [`fixer:answer:pass-${String(n)}`]: {
    edits: files.map(([path, content], index) => ({ writes: { [path]: content }, snapshot: index })),
    output: fixerAnswer(files.map(([path]) => ({ files: [path], subject: `fix: Answer the author in ${path}` }))),
  },
});

/** The findings of the run as the decider decided them: the departing fix and the question, by kind. */
function findingsOf(run: RunState): { readonly departing: string; readonly question: string } {
  const decisions = run.review!.decisions!;
  return { departing: decisions.find((decision) => decision.decision === 'fix')!.id, question: decisions.find((decision) => decision.decision === 'ask')!.id };
}

/** The options of `answerRun` for this sandbox's tree. */
function optionsOf(box: ReviewSandbox, finding: string, given: Answer, change: Partial<AnswerOptions> = {}): AnswerOptions {
  return {
    checkpoint: box.checkpoint,
    worktree: box.repo,
    finding,
    answer: given,
    note: null,
    recordOnly: false,
    flags: {},
    adapter: (runtime) => defaultRuntimes().get(runtime),
    match: gitContent(box.repo, (reference) => box.checkpoint.evidence.read(reference)).match,
    log: () => {},
    rolesRoot: box.rolesRoot,
    environment: { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile },
    preflightOptions: { timeoutMs: loadedRunnerTimeoutMs },
    ...change,
  };
}

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && pattern.test(error.message);

describe('whyNotAnswerable (R2 of answers)', () => {
  it('takes a complete decided run of this worktree', () => {
    assert.equal(whyNotAnswerable(readOnlyReported(answerableDecisions()).fold(), '/w'), null);
    assert.equal(whyNotAnswerable(decidedFixRun().fold(), '/w'), null);
  });

  it('refuses an active, a blocked or an abandoned run, another worktree\'s, one configured before the decision step, and one that ranked nothing', () => {
    assert.match(whyNotAnswerable(configured().fold(), '/w')!, /^run run-1 is active, and an answer is given to a run that wrote its report; resume or abandon it first$/);
    const blocked = configured().start('triage').add('phase.finished', { phase: 'triage', attempt: 1, outcome: 'blocked', blocker: { code: 'budget', detail: 'd', action: 'a' } });
    assert.match(whyNotAnswerable(blocked.fold(), '/w')!, /is blocked, [^\n]*resume or abandon it first/);
    assert.match(whyNotAnswerable(readOnlyReported().add('run.abandoned', { reason: 'r' }).fold(), '/w')!, /^run run-1 is abandoned$/);
    assert.match(whyNotAnswerable(readOnlyReported().fold(), '/elsewhere')!, /was reviewed in worktree \/w, not \/elsewhere; run the command there/);
    assert.match(whyNotAnswerable(reported().fold(), '/w')!, /configured before the decision step, so it asked no question and departed from no rule/);
    const nothing = decidedOf(reported()).fold();
    assert.match(whyNotAnswerable({ ...nothing, review: { ...nothing.review!, decisions: [] } }, '/w')!, /ranked no finding, so it has nothing to answer/);
  });
});

describe('deep-review answer', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  const environment = (box: ReviewSandbox): NodeJS.ProcessEnv => {
    mkdirSync(box.scratchRoot, { recursive: true });
    return { ...baseEnvironment, FAKE_SCRIPT: box.scriptFile, FAKE_CHECKS: box.checksFile, HOME: box.home, USERPROFILE: box.home, TEMP: box.scratchRoot, TMP: box.scratchRoot, TMPDIR: box.scratchRoot };
  };
  const run = (box: ReviewSandbox, ...args: string[]): Promise<Finished> => node([cli, 'answer', '--roles', box.rolesRoot, ...args], { cwd: box.repo, env: environment(box) });

  it('records an answer on a read-only run for the continuation, and refuses what a decision does not admit, naming what it does (R1 to R4)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.review('claude'));
    const finished = box.run();
    const { departing, question } = findingsOf(finished);

    const recorded = await answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { note: 'the operator reads it' }));
    assert.equal(recorded.next, 'read-only');
    assert.equal(recorded.recorded, true);
    assert.deepEqual(recorded.standing.answer, { kind: 'option', option: 1 });
    assert.equal(recorded.standing.note, 'the operator reads it');
    assert.equal(recorded.standing.appliedBy, null, 'option 2 edits the code, so it owes an edit');
    assert.equal(box.run().lastSequence, finished.lastSequence + 1, 'one event, the answer');

    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 })), refused(new RegExp(`^${question} is already answered option 2 on run ${finished.id}, on `)));
    assert.equal((await answerRun(optionsOf(box, question, { kind: 'option', option: 0 }))).standing.appliedBy, 'tree', 'the default that keeps the code is what the tree holds');
    await assert.rejects(answerRun(optionsOf(box, departing, { kind: 'option', option: 0 })), refused(new RegExp(`^${departing} was decided fix, departing from a rule, which admits --accept or --reject, not --option 1$`)));
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'accept' })), refused(new RegExp(`^${question} was decided ask, which admits an --option from 1 to 2, not --accept$`)));
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 2 })), refused(/which admits an --option from 1 to 2, not --option 3$/));
    await assert.rejects(answerRun(optionsOf(box, 'SCAN-9', { kind: 'accept' })), refused(new RegExp(`^run ${finished.id} has no finding SCAN-9; the findings it can answer are ${departing}, ${question}$|^run ${finished.id} has no finding SCAN-9; the findings it can answer are ${question}, ${departing}$`)));
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { runId: 'no-such-run' })), UnknownRunError);
    const unknown = await run(box, '--finding', question, '--option', '2', '--run', 'no-such-run');
    assert.equal(unknown.status, 1, 'an unknown run id is a usage mistake, as for commit and status');
    assert.match(unknown.stderr, /no-such-run[\s\S]*usage:/);
    assert.equal((await answerRun(optionsOf(box, departing, { kind: 'reject' }))).next, 'read-only');
    assert.equal(box.run().review!.answers.length, 3);
    assert.deepEqual(box.run().review!.report, finished.review!.report, 'the run stays complete');

    const given = await run(box, '--finding', departing, '--accept', '--note', 'on second thought');
    assert.equal(given.status, 0, given.stderr);
    assert.equal(given.stdout, `answer recorded: run ${finished.id}, ${departing} accepted\nthe run only reviewed; run review --fix to apply the answer with the fixes\n`);
    const again = await run(box, '--finding', departing, '--accept');
    assert.equal(again.status, 2);
    assert.match(again.stderr, new RegExp(`^refused: ${departing} is already answered accepted on run `));
  });

  it('applies an answer on a fix run with one fixer, the checks again and a second report, and a later answer with a second pass (R5, R7, R10)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { departing, question } = findingsOf(finished);
    const checksBefore = box.checkRuns().length;
    box.script({ ...answerable, ...passFixer(1, [['src/b.ts', otherB]]), ...passFixer(2, [['src/a.ts', ruledA]]) });

    const first = await run(box, '--finding', question, '--option', '2', '--note', 'b needs the import');
    assert.equal(first.status, 0, first.stderr);
    const lines = first.stdout.trimEnd().split('\n');
    assert.equal(lines[0], `answer recorded: run ${finished.id}, ${question} option 2`);
    // The pass ends as review does: the short form of the brief, then the path of the copy of the new report (R13 of the brief of a run).
    assert.equal(lines.at(-1), reportCopyPath(box.checkpoint.root, finished), 'the copy\'s path is the last line');
    assert.equal(lines.length, 9, 'the answer line, the seven lines of the short form and the path');
    assert.deepEqual(lines.slice(2, 8).map((line) => line.split(':')[0]), ['The change', 'Questions', 'Against a written rule', 'Not covered', 'Look at', 'Changed']);
    assert.equal(lines[3], 'Questions: none open; each is answered', 'the pass applied the answer the person gave');
    assert.match(first.stderr, new RegExp(`run ${finished.id}: answer pass over ${question}\\n`));
    const passed = box.run();
    const passWorkers = Object.values(passed.workers).filter((worker) => worker.launch.label?.startsWith('fixer answer:'));
    assert.deepEqual(passWorkers.map((worker) => worker.launch.label), ['fixer answer:pass-1'], 'one fixer');
    assert.match(box.promptOf(passed, 'fixer answer:pass-1'), /answered by the author: option 2, "fake other way"[^\n]*\. Note: b needs the import/);
    assert.equal(passed.review!.fix!.revisions.at(-1)!.phase, 'answer');
    assert.deepEqual(passed.review!.answers.at(-1)!.appliedBy, { phase: 'answer', key: 'pass-1' });
    assert.ok(box.checkRuns().length > checksBefore, 'the checks ran again');
    assert.ok(passed.review!.fix!.checks.runs['answer-checks'].length > 0);
    const report = reportText({ kind: 'report', runId: passed.id, reportPath: lines.at(-1)!, copyPath: null, shortForm: [] });
    assert.match(report, new RegExp(`^- \\d\\\\\\. ${question}: answered option `, 'm'));
    assert.match(report, /^Answered: the last pass on /m);

    // One answer recorded only, rejecting the departure; the same answer given again opens a second pass over that finding alone, which follows the rule.
    const recordOnly = await run(box, '--finding', departing, '--reject', '--record-only');
    assert.equal(recordOnly.status, 0, recordOnly.stderr);
    // The line names every recorded answer the next pass applies, not this one alone (R10 of the skill surface corrections).
    assert.equal(recordOnly.stdout, `answer recorded: run ${finished.id}, ${departing} rejected\nrecorded only; the next deep-review answer on this run without --record-only applies it, with every other recorded answer that owes an edit\n`);
    assert.equal(box.run().review!.answerPasses.length, 1, 'no pass opened');
    const retry = await run(box, '--finding', departing, '--reject');
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, new RegExp(`^answer already recorded: run ${finished.id}, ${departing} rejected\\n`));
    const second = box.run();
    assert.deepEqual(second.review!.answerPasses.map((pass) => pass.ids), [[question], [departing]]);
    assert.deepEqual(second.review!.answers.at(-1)!.appliedBy, { phase: 'answer', key: 'pass-2' });
    assert.equal(readFileSync(join(box.repo, 'src', 'a.ts'), 'utf8'), ruledA, 'the second pass followed the rule');
  });

  it('writes the copy of the report again with the answer, on a run that only reviewed and when the pass is refused (R14 of the brief of a run)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.review('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    const copy = reportCopyPath(box.checkpoint.root, finished);
    assert.doesNotMatch(readFileSync(copy, 'utf8'), /^Answered: /m, 'review wrote the copy before any answer');
    const recorded = await run(box, '--finding', question, '--option', '2');
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(readFileSync(copy, 'utf8'), /^Answered: option 2 on [^;]+; not yet applied\. deep-review's choice was option 2\.$/m);
  });

  it('records the answer but refuses the pass when the tree moved, naming what moved and what the answer says; the same answer applies it once restored (R6)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    box.script({ ...answerable, ...passFixer(1, [['src/b.ts', otherB]]) });
    write(box.repo, 'src/a.ts', 'edited by hand\n');
    const copied: RunState[] = [];
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { refreshCopy: (state) => copied.push(state) })), refused(new RegExp(`^the tree is not where run ${finished.id} left it: src/a\\.ts \\(modified\\); the answer is recorded; restore the tree and run deep-review answer again with the same answer to apply it, or apply it by hand: ${question} option 2, "fake other way"; a review of the changed tree is a new run and does not carry this answer$`)));
    // The copy of the report is written again with the answer, though the pass was refused (R14 of the brief of a run).
    assert.equal(copied.length, 1);
    assert.equal(copied[0]!.review!.answers.length, 1);
    assert.notEqual(copied[0]!.review!.report, null);
    const after = box.run();
    assert.equal(after.review!.answers.length, 1, 'the answer is recorded');
    assert.equal(after.review!.answerPasses.length, 0);
    assert.notEqual(after.review!.report, null, 'the run stays complete');
    write(box.repo, 'src/a.ts', fixedA);
    // HEAD moved is refused the same way.
    write(box.repo, 'notes.md', 'a note\n');
    commitAll(box.repo, 'docs: Add a note');
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 })), refused(/^the tree is not where run [^\n]* left it: HEAD \(/));
    git(box.repo, 'reset', '-q', '--hard', 'HEAD~1');
    write(box.repo, 'src/a.ts', fixedA);
    const outcome = await answerRun(optionsOf(box, question, { kind: 'option', option: 1 }));
    assert.equal(outcome.recorded, false, 'not recorded twice');
    assert.equal(outcome.next, 'pass');
    reportText(await box.review('claude'));
    assert.deepEqual(box.run().review!.answers[0]!.appliedBy, { phase: 'answer', key: 'pass-1' });
  });

  it('completes a series of commits a stop cut short after the branch moved, and opens the pass on the head it made (R9 of resumable runs)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    box.script({ ...answerable, ...passFixer(1, [['src/b.ts', otherB]]) });
    // A commit cut after it recorded its series and moved the branch, before it recorded the commits.
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.run().review!.fix!.openSeries!;
    git(box.repo, 'update-ref', 'refs/heads/main', open.to, open.from);
    const logs: string[] = [];
    const outcome = await answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { log: (line) => logs.push(line) }));
    assert.equal(outcome.next, 'pass', 'the head the series made is the run\'s head, so the tree is where the run left it');
    assert.deepEqual(logs, [`run ${finished.id}: a commit a stop cut short had moved HEAD to ${open.to.slice(0, 12)}; the 1 commit it made is recorded now`]);
    assert.deepEqual(box.run().review!.fix!.commits, [open]);
    assert.equal(git(box.repo, 'status', '--porcelain'), '');
  });

  it('leaves a series a stop cut short open, the ledger and the index as they were, when it refuses an answer (R9 of resumable runs)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const { question } = findingsOf(box.run());
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.run().review!.fix!.openSeries!;
    git(box.repo, 'update-ref', 'refs/heads/main', open.to, open.from);
    const before = box.run();
    const staged = git(box.repo, 'status', '--porcelain');
    assert.notEqual(staged, '', 'the index still holds the head the series starts from');
    const logs: string[] = [];
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 2 }, { log: (line) => logs.push(line) })), refused(/which admits an --option from 1 to 2, not --option 3$/));
    assert.equal(box.run().lastSequence, before.lastSequence, 'a refusal appends nothing, the settle of a series too');
    assert.deepEqual(box.run().review!.fix!.openSeries, open);
    assert.equal(git(box.repo, 'status', '--porcelain'), staged, 'the index is not reset');
    assert.deepEqual(logs, []);
  });

  it('records an answer only with HEAD at neither head of a series a stop cut short, and refuses the pass, naming both (R9 of resumable runs)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.run().review!.fix!.openSeries!;
    write(box.repo, 'notes.md', 'a note\n');
    commitAll(box.repo, 'docs: Add a note');
    const recorded = await answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { recordOnly: true }));
    assert.equal(recorded.next, 'record-only', 'recording reads no head');
    assert.deepEqual(box.run().review!.fix!.openSeries, open, 'the series stays open for the command that reads the head');
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 })), refused(new RegExp(`^a commit of run ${finished.id} that a stop cut short was moving HEAD from ${open.from} to ${open.to}, and HEAD is [0-9a-f]+, at neither; [^\\n]*; the answer is recorded; run deep-review answer again with the same answer to apply it$`)));
    assert.equal(box.run().review!.answerPasses.length, 0);
  });

  it('says a first answer is recorded when HEAD at neither head of a series a stop cut short refuses its pass (R9 of resumable runs)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    assert.throws(() => commitRun({ checkpoint: box.checkpoint, worktree: box.repo, beforeMove: () => {
      throw new Error('stopped');
    } }), /stopped/);
    const open = box.run().review!.fix!.openSeries!;
    write(box.repo, 'notes.md', 'a note\n');
    commitAll(box.repo, 'docs: Add a note');
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { note: 'b needs the import' })), refused(new RegExp(`^a commit of run ${finished.id} that a stop cut short was moving HEAD from ${open.from} to ${open.to}, and HEAD is [0-9a-f]+, at neither; [^\\n]*; the answer is recorded; run deep-review answer again with the same answer to apply it$`)));
    const after = box.run();
    assert.equal(after.review!.answers.length, 1, 'the answer is recorded');
    assert.equal(after.review!.answers[0]!.note, 'b needs the import');
    assert.equal(after.review!.answerPasses.length, 0);
    assert.deepEqual(after.review!.fix!.openSeries, open, 'the series stays open');
  });

  it('refuses the pass at the run budget before anything opens, naming --budget-usd, and blocks the pass\'s fixer on two failures until review completes it (R5, R6, TD8)', async (t) => {
    const box = ReviewSandbox.forTest(t, { ...answerable, '*': { costUsd: 0.5 } });
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { question } = findingsOf(finished);
    const bound = spendBound(budgetSpendOf(finished, claudeAdapter).usd!);
    await assert.rejects(answerRun(optionsOf(box, question, { kind: 'option', option: 1 }, { flags: { budgetUsd: 1 } })), refused(new RegExp(`so no fixer could launch; the answer is recorded; run deep-review answer again with the same answer and --budget-usd above ${bound.replace('.', '\\.')} to apply it$`)));
    assert.equal(box.run().review!.answerPasses.length, 0);
    box.script({ ...answerable, '*': { costUsd: 0.5 }, 'fixer:answer:pass-1': [{ exit: 3 }, { exit: 3 }, { edits: [{ writes: { 'src/b.ts': otherB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'], subject: 'fix(b): Import parse' }]) }] });
    const blocked = await run(box, '--finding', question, '--option', '2', '--budget-usd', '500');
    assert.equal(blocked.status, 2, blocked.stdout);
    assert.match(blocked.stderr, /blocked in answer \(worker-failed\): the fixer worker for answer:pass-1 failed twice/);
    assert.deepEqual(box.run().review!.units.answer['pass-1']!.failures.length, 2);
    reportText(await box.review('claude', { flags: { budgetUsd: 500 } }));
    assert.deepEqual(box.run().review!.answers[0]!.appliedBy, { phase: 'answer', key: 'pass-1' });
  });

  it('says the tree already holds an answer that confirms the default, and opens no pass (PD6, PD12)', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { departing, question } = findingsOf(finished);
    const held = await run(box, '--finding', question, '--option', '1');
    assert.equal(held.status, 0, held.stderr);
    assert.equal(held.stdout, `answer recorded: run ${finished.id}, ${question} option 1\nthe tree already holds this answer; nothing to apply\n`);
    const accepted = await run(box, '--finding', departing, '--accept');
    assert.equal(accepted.stdout, `answer recorded: run ${finished.id}, ${departing} accepted\nthe tree already holds this answer; nothing to apply\n`);
    assert.equal(box.run().review!.answerPasses.length, 0);
    assert.equal(box.run().lastSequence, finished.lastSequence + 2);
  });

  it('says the tree already holds an answer recorded only that owes no edit, rather than that a later pass applies it', async (t) => {
    const box = ReviewSandbox.forTest(t, answerable);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const { departing, question } = findingsOf(finished);
    // The departure as the fix made it, and the default the fix applied: neither owes an edit, so no later pass applies them.
    const accepted = await run(box, '--finding', departing, '--accept', '--record-only');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, `answer recorded: run ${finished.id}, ${departing} accepted\nthe tree already holds this answer; nothing to apply\n`);
    const held = await run(box, '--finding', question, '--option', '1', '--record-only');
    assert.equal(held.stdout, `answer recorded: run ${finished.id}, ${question} option 1\nthe tree already holds this answer; nothing to apply\n`);
    assert.equal(box.run().review!.answerPasses.length, 0);
    assert.equal(box.run().lastSequence, finished.lastSequence + 2);
  });
});
