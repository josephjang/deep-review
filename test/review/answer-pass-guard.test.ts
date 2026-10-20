import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Answer } from '../../src/checkpoint/events.ts';
import { answerRun, type AnswerOptions } from '../../src/review/answer.ts';
import { commitRun } from '../../src/review/commit.ts';
import { gitContent } from '../../src/review/content.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { reviewStatus } from '../../src/review/state.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { baseEnvironment } from '../helpers/launcher.ts';
import { loadedRunnerTimeoutMs, reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** A review whose triage finds one defect in src/a.ts, which the decider decides to fix, departing from a rule, and the fixes phase's fixer fixes. */
const departing: Script = {
  triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'text is dereferenced when null: the failure' }], leads: noLeads, change: null } },
  decider: { output: deciderAnswer([{ departs: true }]) },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n' } }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
};

/** The options of `answerRun` for this sandbox's tree. */
function optionsOf(box: ReviewSandbox, finding: string, given: Answer): AnswerOptions {
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
  };
}

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && pattern.test(error.message);

describe('deep-review answer, with another run active (R6 of answers)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('refuses the pass while another run is resumable, leaving the answer recorded and the run complete with its report, and opens it once that run is abandoned', async (t) => {
    const box = ReviewSandbox.forTest(t, departing);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const id = finished.review!.decisions!.find((decision) => decision.decision === 'fix')!.id;
    const reject: Answer = { kind: 'reject' };
    // A run started after this one completed, in any worktree on the shared checkpoint, is resumable until it reports.
    const other = box.checkpoint.createRun({ worktree: box.repo });

    await assert.rejects(answerRun({ ...optionsOf(box, id, reject), runId: finished.id }), refused(new RegExp(`^run ${other.id} is active, and the answer pass would resume run ${finished.id} beside it; the answer is recorded; finish it with deep-review review, or abandon it with \`deep-review abandon --run <id> --reason <text>\`, then run deep-review answer again with the same answer to apply it$`)));
    const after = box.checkpoint.fold(finished.id);
    assert.equal(after.review!.answers.length, 1, 'the answer is recorded');
    assert.equal(after.review!.answerPasses.length, 0, 'no pass opened');
    assert.notEqual(after.review!.report, null, 'the report stays');
    assert.equal(reviewStatus(after), 'complete');

    const another = box.checkpoint.createRun({ worktree: box.repo });
    await assert.rejects(answerRun({ ...optionsOf(box, id, reject), runId: finished.id }), refused(new RegExp(`^runs ${other.id}, ${another.id} are active, and the answer pass would resume run ${finished.id} beside them; the answer is recorded; finish them with deep-review review, or abandon them with`)));
    for (const run of [other, another]) box.checkpoint.append(run.id, box.checkpoint.fold(run.id).lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: 'in the way of the answer pass' } }]);
    const retried = await answerRun({ ...optionsOf(box, id, reject), runId: finished.id });
    assert.equal(retried.recorded, false, 'the same answer is not recorded again');
    assert.equal(retried.next, 'pass');
  });
});

describe('deep-review answer, with the roles changed since the run (R6 of answers)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('refuses the pass when the roles no longer digest as the run pinned, leaving the run complete and committable, and opens it once the roles are restored', async (t) => {
    const box = ReviewSandbox.forTest(t, departing);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const id = finished.review!.decisions!.find((decision) => decision.decision === 'fix')!.id;
    const reject: Answer = { kind: 'reject' };
    // An engine upgrade that edits a role prompt changes the digest of every run configured before it.
    const fragment = join(box.rolesRoot, 'fragments', 'fixer-apply.md');
    const original = readFileSync(fragment, 'utf8');
    writeFileSync(fragment, `${original}\nA sentence an upgrade added.\n`);

    await assert.rejects(answerRun({ ...optionsOf(box, id, reject), runId: finished.id }), refused(new RegExp(`^run ${finished.id} was configured with roles digest ${finished.review!.configuration.rolesDigest}, and the roles at .* now digest [0-9a-f]+; run it with the roles it started with \\(--roles <dir>\\), or apply the answer by hand; the answer is recorded, and run ${finished.id} stays complete with its report$`)));
    const after = box.checkpoint.fold(finished.id);
    assert.equal(after.review!.answers.length, 1, 'the answer is recorded');
    assert.equal(after.review!.answerPasses.length, 0, 'no pass opened');
    assert.deepEqual(after.review!.report, finished.review!.report, 'the report stays');
    assert.equal(reviewStatus(after), 'complete');
    assert.ok(commitRun({ checkpoint: box.checkpoint, worktree: box.repo, runId: finished.id, log: () => {} }).commits.length > 0, 'the run stays committable');

    writeFileSync(fragment, original);
    const retried = await answerRun({ ...optionsOf(box, id, reject), runId: finished.id });
    assert.equal(retried.recorded, false, 'the same answer is not recorded again');
    assert.equal(retried.next, 'pass');
  });
});
