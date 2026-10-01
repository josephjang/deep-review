import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuralCheckError } from '../../src/review/errors.ts';
import {
  checkDeduplication,
  checkFixerAnswer,
  checkMergeRank,
  checkTriageLeads,
  checkVerdicts,
  deduplicationOutputSchema,
  finderOutputSchema,
  fixerOutputSchema,
  maxCandidates,
  mergeRankOutputSchema,
  outputSchemaOf,
  sweepOutputSchema,
  triageOutputSchema,
  verifierOutputSchema,
} from '../../src/review/schemas.ts';
import { finderAngles, reviewRoles } from '../../src/review/vocabulary.ts';
import { compileOutputSchema } from '../../src/runtime/contract.ts';

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

  it('does not compile a role the review does not run', () => {
    // The typecheck is the assertion: the directive fails `npm run typecheck` if `outputSchemaOf` ever accepts a role outside `reviewRoles`.
    // @ts-expect-error: the fix pass's roles have no review output schema
    void (() => outputSchemaOf('fixer'));
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

  it('refuses an applied finding without a message, and a message on any other', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: null })]), 1), /Finding \[0\] is applied and has no commit message/);
    for (const status of ['already-applied', 'deferred', 'blocked']) {
      assert.throws(() => checkFixerAnswer(parsed([finding(0, { status })]), 1), new RegExp(`Finding \\[0\\] is ${status} and has a commit message`), status);
    }
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
