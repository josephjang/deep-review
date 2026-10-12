import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Answer } from '../../src/checkpoint/events.ts';
import { answerRun, type AnswerOptions } from '../../src/review/answer.ts';
import { gitContent } from '../../src/review/content.ts';
import { ReviewRefusedError } from '../../src/review/errors.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { deciderAnswer, fixerAnswer, type Script } from '../helpers/fake-runtime.ts';
import { reportText, ReviewSandbox, sandboxConcurrency } from '../helpers/review-sandbox.ts';

const noLeads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: null }));

/** A review whose triage finds one defect in src/a.ts, which the decider decides to fix, departing from a rule, and the fixes phase's fixer fixes. */
const departing: Script = {
  triage: { output: { candidates: [{ file: 'src/a.ts', line: 2, summary: 'text is dereferenced when null', detail: 'text is dereferenced when null: the failure' }], leads: noLeads } },
  decider: { output: deciderAnswer([{ departs: true }]) },
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n' } }], output: fixerAnswer([{ files: ['src/a.ts'], subject: 'fix(a): Return 0 for a null text' }]) },
};

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
    ...change,
  };
}

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ReviewRefusedError && pattern.test(error.message);

describe('deep-review answer, retried (R3 of answers)', { timeout: 900_000, concurrency: sandboxConcurrency }, () => {
  it('refuses a retry that carries another note than the standing one, before the pass opens, and applies the answer with the standing note', async (t) => {
    const box = ReviewSandbox.forTest(t, departing);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const id = finished.review!.decisions!.find((decision) => decision.decision === 'fix')!.id;
    const reject: Answer = { kind: 'reject' };

    assert.equal(answerRun(optionsOf(box, id, reject, { note: 'keep the old signature', recordOnly: true })).next, 'record-only');
    const recorded = box.run();
    assert.throws(() => answerRun(optionsOf(box, id, reject, { note: 'rename it' })), refused(new RegExp(`^${id} is already answered rejected on run ${finished.id}, with the note "keep the old signature", and applying it again keeps the note it was recorded with; run deep-review answer again without --note to apply it$`)));
    const after = box.run();
    assert.equal(after.lastSequence, recorded.lastSequence, 'nothing is appended');
    assert.equal(after.review!.answerPasses.length, 0, 'no pass opened');
    assert.notEqual(after.review!.report, null, 'the run stays complete');

    const retried = answerRun(optionsOf(box, id, reject, { note: 'keep the old signature' }));
    assert.equal(retried.recorded, false, 'the same note is the standing one, so the retry goes on');
    assert.equal(retried.next, 'pass');
    assert.equal(retried.standing.note, 'keep the old signature');
  });

  it('refuses a retry with a note when the standing answer has none, and takes one without a note', async (t) => {
    const box = ReviewSandbox.forTest(t, departing);
    reportText(await box.fix('claude'));
    const finished = box.run();
    const id = finished.review!.decisions!.find((decision) => decision.decision === 'fix')!.id;
    const reject: Answer = { kind: 'reject' };

    answerRun(optionsOf(box, id, reject, { recordOnly: true }));
    assert.throws(() => answerRun(optionsOf(box, id, reject, { note: 'rename it' })), refused(/, with no note, and applying it again keeps the note it was recorded with; run deep-review answer again without --note to apply it$/));
    assert.equal(box.run().review!.answerPasses.length, 0, 'no pass opened');
    assert.equal(answerRun(optionsOf(box, id, reject)).next, 'pass');
  });
});
