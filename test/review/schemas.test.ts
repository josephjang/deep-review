import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuralCheckError } from '../../src/review/errors.ts';
import {
  checkDecisions,
  checkDeduplication,
  checkFixerAnswer,
  checkMergeRank,
  checkTriageLeads,
  checkVerdicts,
  deciderOutputSchema,
  deduplicationOutputSchema,
  finderOutputSchema,
  fixerOutputSchema,
  maxCandidates,
  mergeRankOutputSchema,
  outputSchemaOf,
  sweepOutputSchema,
  triageOutputSchema,
  verifierOutputSchema,
  type DeciderOutput,
} from '../../src/review/schemas.ts';
import { finderAngles, reviewRoles } from '../../src/review/vocabulary.ts';
import { compileOutputSchema } from '../../src/runtime/contract.ts';
import { deciderAnswer, type DecidedFinding } from '../helpers/fake-runtime.ts';

const candidate = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ file: 'src/a.ts', line: 3, summary: 's', detail: 'd', ...change });
const leads = finderAngles.map((angle) => ({ angle, lead: null }));

describe('the output schemas', () => {
  it('compile for both runtimes: closed objects, every field required, an object at the root', () => {
    for (const role of reviewRoles) {
      const compiled = compileOutputSchema(outputSchemaOf(role));
      assert.equal(compiled.json.type, 'object', role);
      assert.equal(compiled.json.additionalProperties, false, role);
    }
  });

  it('does not compile a role the review does not run, and gives the fixer its own schema', () => {
    // The typecheck is the assertion: the directive fails `npm run typecheck` if `outputSchemaOf` ever accepts a role outside `reviewRoles`.
    // @ts-expect-error: the auditor is not run, so it has no output schema here
    void (() => outputSchemaOf('auditor'));
    assert.equal(outputSchemaOf('fixer'), fixerOutputSchema);
  });

  it('gives every finder one schema, the triage its own, and the sweep one with an angle per candidate', () => {
    for (const angle of finderAngles) assert.equal(outputSchemaOf(`finder-${angle}`), finderOutputSchema);
    assert.equal(outputSchemaOf('triage'), triageOutputSchema);
    assert.equal(outputSchemaOf('sweep'), sweepOutputSchema);
    assert.equal(outputSchemaOf('deduplication'), deduplicationOutputSchema);
    assert.equal(outputSchemaOf('verifier'), verifierOutputSchema);
    assert.equal(outputSchemaOf('merge-rank'), mergeRankOutputSchema);
    assert.ok(sweepOutputSchema.safeParse({ candidates: [candidate({ angle: 'DESIGN' })] }).success);
    assert.ok(!sweepOutputSchema.safeParse({ candidates: [candidate()] }).success, 'a sweep candidate names its angle');
    assert.ok(!finderOutputSchema.safeParse({ candidates: [candidate({ angle: 'DESIGN' })] }).success, 'a finder candidate has no angle field');
  });

  it('caps candidates at twelve and accepts an empty return', () => {
    assert.ok(finderOutputSchema.safeParse({ candidates: [] }).success);
    assert.ok(finderOutputSchema.safeParse({ candidates: Array.from({ length: maxCandidates }, () => candidate()) }).success);
    assert.ok(!finderOutputSchema.safeParse({ candidates: Array.from({ length: maxCandidates + 1 }, () => candidate()) }).success);
  });

  it('refuses a candidate with a missing field, an extra field, a zero line or an over-long summary', () => {
    for (const bad of [candidate({ detail: undefined }), candidate({ anchor: 'x' }), candidate({ line: 0 }), candidate({ line: 2.5 }), candidate({ summary: 'x'.repeat(401) }), candidate({ file: '' })]) {
      assert.ok(!finderOutputSchema.safeParse({ candidates: [bad] }).success, JSON.stringify(bad));
    }
  });

  it('requires the triage to return exactly nine leads, each a string or null', () => {
    assert.ok(triageOutputSchema.safeParse({ candidates: [], leads }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: leads.slice(1) }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: [...leads, { angle: 'SCAN', lead: null }] }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: leads.map((lead) => ({ ...lead, lead: '' })) }).success);
  });
});

describe('the structural checks', () => {
  it('accept leads that cover the nine angles once and refuse a repeat or a gap', () => {
    assert.doesNotThrow(() => checkTriageLeads({ candidates: [], leads }));
    assert.throws(() => checkTriageLeads({ candidates: [], leads: [...leads.slice(1), leads[1]!] }), (error: unknown) => error instanceof StructuralCheckError && /two leads for angle RIPPLE/.test(error.message) && /no lead for REMOVALS/.test(error.message) === false);
    const twice = [...leads.slice(0, 8), leads[0]!];
    assert.throws(() => checkTriageLeads({ candidates: [], leads: twice }), /two leads for angle REMOVALS/);
  });

  it('accept dedup groups over the numbered input and refuse an index outside it, in two groups, or a kept non-member', () => {
    assert.doesNotThrow(() => checkDeduplication({ groups: [{ members: [0, 2], keep: 2, reason: 'r' }, { members: [1, 3], keep: 1, reason: 'r' }] }, 4));
    assert.doesNotThrow(() => checkDeduplication({ groups: [] }, 0));
    assert.throws(() => checkDeduplication({ groups: [{ members: [0, 4], keep: 0, reason: 'r' }] }, 4), /Deduplication group 0 names index 4, but the candidates are numbered \[0\] to \[3\]/);
    assert.throws(() => checkDeduplication({ groups: [{ members: [0, 1], keep: 0, reason: 'r' }, { members: [1, 2], keep: 2, reason: 'r' }] }, 3), /group 1 names index 1, which another group already names/);
    assert.throws(() => checkDeduplication({ groups: [{ members: [0, 1], keep: 2, reason: 'r' }] }, 3), /keeps index 2, which is not one of its members/);
  });

  it('accept one verdict per index and refuse a repeat, a gap, or an index outside the group', () => {
    const verdict = (index: number) => ({ index, verdict: 'PLAUSIBLE' as const, evidence: 'e' });
    assert.doesNotThrow(() => checkVerdicts({ verdicts: [verdict(1), verdict(0)] }, 2));
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0), verdict(0)] }, 2), /Two verdicts name index 0/);
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0)] }, 3), /No verdict for index 1, 2 of the 3 candidates/);
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0), verdict(3)] }, 2), /A verdict names index 3, but the candidates are numbered \[0\] to \[1\]/);
    assert.throws(() => checkVerdicts({ verdicts: [] }, 1), /No verdict for index 0/);
    assert.throws(() => checkVerdicts({ verdicts: [verdict(2), verdict(0)] }, 4), /No verdict for index 1, 3 of the 4 candidates/, 'every gap, in order, wherever it falls');
  });

  it('accept a ranking that names every index once and refuse a repeat, a gap, or an index outside the list', () => {
    const finding = (primary: number, members: number[] = []) => ({ primary, members, severity: 'major' as const, summary: 's', reason: 'r' });
    assert.doesNotThrow(() => checkMergeRank({ findings: [finding(2, [0]), finding(1)] }, 3));
    assert.doesNotThrow(() => checkMergeRank({ findings: [] }, 0));
    assert.throws(() => checkMergeRank({ findings: [finding(0, [0])] }, 1), /Finding 0 names index 0, which another finding, or the same one, already names/);
    assert.throws(() => checkMergeRank({ findings: [finding(0), finding(1, [0])] }, 2), /Finding 1 names index 0/);
    assert.throws(() => checkMergeRank({ findings: [finding(0)] }, 2), /leaves out index 1 of the 2 candidates/);
    assert.throws(() => checkMergeRank({ findings: [finding(3, [1])] }, 5), /leaves out index 0, 2, 4 of the 5 candidates/, 'every gap, in order, wherever it falls');
    assert.throws(() => checkMergeRank({ findings: [finding(0), finding(5)] }, 2), /Finding 1 names index 5, but the candidates are numbered \[0\] to \[1\]/);
  });
});

describe('the fixer\'s output schema', () => {
  const finding = (index: number, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    index, status: 'applied', file: 'src/a.ts', line: 3, note: 'n', message: { subject: 'fix(a): Guard the null', body: 'Why.' },
    files: ['src/a.ts'], corrections: [], validation: [{ method: 'mutation', source: 'test/a.test.ts', evidence: 'red then green' }], requiredFiles: [], ...change,
  });
  const answer = (findings: Record<string, unknown>[]): Record<string, unknown> => ({ findings, drift: [], tests: [], suite: { result: 'pass', command: 'npm test', failures: '' } });

  it('compiles for both runtimes and accepts a whole answer', () => {
    const compiled = compileOutputSchema(fixerOutputSchema);
    assert.equal(compiled.json.additionalProperties, false);
    assert.equal(fixerOutputSchema.safeParse(answer([finding(0), finding(1, { status: 'deferred', message: null, line: null, files: [] })])).success, true);
  });

  it('refuses an unknown status or validation method, an empty note, an over-long subject and a missing field', () => {
    for (const [name, value] of [
      ['status', answer([finding(0, { status: 'skipped' })])],
      ['method', answer([finding(0, { validation: [{ method: 'vibes', source: 's', evidence: 'e' }] })])],
      ['note', answer([finding(0, { note: '' })])],
      ['subject', answer([finding(0, { message: { subject: 'x'.repeat(73), body: '' } })])],
      ['requiredFiles', answer([{ ...finding(0), requiredFiles: undefined }])],
      ['suite', { findings: [finding(0)], drift: [], tests: [], suite: { result: 'green', command: '', failures: '' } }],
    ] as const) assert.equal(fixerOutputSchema.safeParse(value).success, false, name);
  });

  const parsed = (findings: Record<string, unknown>[]) => fixerOutputSchema.parse(answer(findings));

  it('accepts every index once, a message with an applied finding alone, and required files on a blocked one', () => {
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(1), finding(0, { status: 'blocked', message: null, requiredFiles: ['src/b.ts'] })]), 2));
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied', message: null })]), 1));
    assert.doesNotThrow(() => checkFixerAnswer(parsed([]), 0));
  });

  it('refuses a missing, repeated or outside index', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0)]), 3), (error: unknown) => error instanceof StructuralCheckError && /leaves out finding \[1\], \[2\] of the 3/.test(error.message));
    assert.throws(() => checkFixerAnswer(parsed([finding(0), finding(0)]), 1), /Finding \[0\] is answered twice/);
    assert.throws(() => checkFixerAnswer(parsed([finding(2)]), 2), /Finding \[2\] is outside the task, whose findings are numbered \[0\] to \[1\]/);
  });

  it('refuses an applied finding without a message, and a message on a deferred or blocked one', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: null })]), 1), /Finding \[0\] is applied and has no commit message/);
    for (const status of ['deferred', 'blocked']) {
      assert.throws(() => checkFixerAnswer(parsed([finding(0, { status })]), 1), new RegExp(`Finding \\[0\\] is ${status} and has a commit message, which only an applied or already-applied finding carries`), status);
    }
  });

  it('lets an already-applied finding carry a message or not, as a retry verifying an earlier attempt\'s edits gives one (R20 of the fix pass)', () => {
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied' })]), 1));
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied', message: null })]), 1));
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied', message: { subject: 'fix: Ends here.', body: '' } })]), 1), /one line with no trailing period/, 'its subject is held to the same rule');
  });

  it('refuses a subject with a line break or a trailing period', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Two\nlines', body: '' } })]), 1), /one line with no trailing period/);
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Ends here.', body: '' } })]), 1), /one line with no trailing period/);
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Handle v1.2', body: '' } })]), 1));
  });

  it('refuses required files on a finding that is not blocked', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { status: 'deferred', message: null, requiredFiles: ['src/b.ts'] })]), 1), /Finding \[0\] is deferred and names required files/);
  });
});

describe('the decider\'s output schema and its structural check (R3 of the decision step)', () => {
  const parsed = (decided: readonly DecidedFinding[]): DeciderOutput => deciderOutputSchema.parse(deciderAnswer(decided));
  const changed = (output: DeciderOutput, index: number, change: Record<string, unknown>): DeciderOutput => ({ decisions: output.decisions.map((entry) => (entry.index === index ? { ...entry, ...change } : entry)) as DeciderOutput['decisions'] });

  it('compiles for both runtimes, is the decider\'s, and accepts a fix, a leave, an ask and a departing fix', () => {
    assert.equal(outputSchemaOf('decider'), deciderOutputSchema);
    assert.equal(compileOutputSchema(deciderOutputSchema).json.additionalProperties, false);
    const output = parsed([{}, { decision: 'leave', reason: 'superseded', supersededBy: 0 }, { decision: 'ask' }, { departs: true }, { decision: 'leave', reason: 'intended' }]);
    assert.doesNotThrow(() => checkDecisions(output, 5));
  });

  it('refuses an unknown decision or leave reason, an ask with one option or none looked for, and an over-long grounds', () => {
    const output = deciderAnswer([{ decision: 'ask' }]) as { decisions: Record<string, unknown>[] };
    const withChange = (change: Record<string, unknown>): unknown => ({ decisions: [{ ...output.decisions[0], ...change }] });
    assert.equal(deciderOutputSchema.safeParse(withChange({ decision: 'defer' })).success, false);
    assert.equal(deciderOutputSchema.safeParse(withChange({ grounds: 'x'.repeat(1001) })).success, false);
    const ask = output.decisions[0]!.ask as Record<string, unknown> & { options: unknown[] };
    assert.equal(deciderOutputSchema.safeParse(withChange({ ask: { ...ask, options: ask.options.slice(0, 1) } })).success, false);
    assert.equal(deciderOutputSchema.safeParse(withChange({ ask: { ...ask, searched: [] } })).success, false);
    const left = deciderAnswer([{ decision: 'leave' }]) as { decisions: Record<string, unknown>[] };
    assert.equal(deciderOutputSchema.safeParse({ decisions: [{ ...left.decisions[0], leave: { reason: 'too-hard', supersededBy: null } }] }).success, false);
  });

  it('refuses an answer that misses, repeats or exceeds an index', () => {
    assert.throws(() => checkDecisions(parsed([{}]), 2), /leaves out finding \[1\] of the 2/);
    assert.throws(() => checkDecisions(parsed([{}, {}, {}]), 2), /Decision \[2\] is outside the task, whose findings are numbered \[0\] to \[1\]/);
    const twice = parsed([{}, {}]);
    assert.throws(() => checkDecisions({ decisions: [twice.decisions[0]!, { ...twice.decisions[1]!, index: 0 }] }, 2), /Decision \[0\] is given twice/);
  });

  it('refuses a decision without its own part, or with another\'s', () => {
    const output = parsed([{}, { decision: 'leave' }, { decision: 'ask' }]);
    assert.throws(() => checkDecisions(changed(output, 0, { fix: null }), 3), /Decision \[0\] is fix and has no `fix`/);
    assert.throws(() => checkDecisions(changed(output, 0, { leave: { reason: 'intended', supersededBy: null } }), 3), /Decision \[0\] is fix and carries `leave`, which only a leave decision does/);
    assert.throws(() => checkDecisions(changed(output, 1, { ask: output.decisions[2]!.ask }), 3), /Decision \[1\] is leave and carries `ask`/);
    assert.throws(() => checkDecisions(changed(output, 2, { decision: 'fix' }), 3), /Decision \[2\] is fix and has no `fix`/);
  });

  it('refuses a departure on anything but a fix', () => {
    const output = parsed([{}, { decision: 'ask' }]);
    const departure = { rule: 'r', source: 's', reason: 'r' };
    assert.throws(() => checkDecisions(changed(output, 1, { departure }), 2), /Decision \[1\] is ask and departs from a rule, which only a fix does/);
  });

  it('refuses an ask that recommends or applies an option it does not offer', () => {
    const output = parsed([{ decision: 'ask' }]);
    const ask = output.decisions[0]!.ask!;
    assert.throws(() => checkDecisions(changed(output, 0, { ask: { ...ask, applied: 2 } }), 1), /Decision \[0\] applies option 2, but its question offers options 0 to 1/);
    assert.throws(() => checkDecisions(changed(output, 0, { ask: { ...ask, recommended: 5 } }), 1), /Decision \[0\] recommends option 5/);
  });

  it('holds a superseded finding to another finding of the task decided fix, and only a superseded one to naming one', () => {
    const superseded = (by: number | null, kinds: readonly DecidedFinding[] = [{}]): DeciderOutput => parsed([...kinds, { decision: 'leave', reason: 'superseded', ...(by === null ? {} : { supersededBy: by }) }]);
    assert.throws(() => checkDecisions(superseded(null), 2), /Decision \[1\] is superseded and names no finding that supersedes it/);
    assert.throws(() => checkDecisions(superseded(1), 2), /Decision \[1\] is superseded by \[1\], which is not another finding of the task decided fix/);
    assert.throws(() => checkDecisions(superseded(7), 2), /superseded by \[7\]/);
    assert.throws(() => checkDecisions(superseded(0, [{ decision: 'ask' }]), 2), /superseded by \[0\], which is not another finding of the task decided fix/);
    const intended = parsed([{}, { decision: 'leave', reason: 'intended', supersededBy: 0 }]);
    assert.throws(() => checkDecisions(intended, 2), /Decision \[1\] is left as intended and names a superseding finding, which only a superseded one does/);
  });
});
