import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeReadingSchema, changeTextLengthV1, citedRunLimitsV1, verdictsRecordedV2 } from '../../src/checkpoint/events.ts';
import { StructuralCheckError } from '../../src/review/errors.ts';
import {
  changeSourceLimits,
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
  normalizeTriageChange,
  outputSchemaOf,
  repairOutputSchema,
  sweepOutputSchema,
  triageOutputSchema,
  verifierOutputSchema,
  verifierOutputSchemaV2,
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

  it('does not compile a role the review does not run, gives the fixer its own schema, and the documentation step the fixer\'s (TD3 of the documentation step)', () => {
    // The typecheck is the assertion: the directive fails `npm run typecheck` if `outputSchemaOf` ever accepts a role outside `reviewRoles`.
    // @ts-expect-error: the test-assessment role is not run, so it has no output schema here
    void (() => outputSchemaOf('test-assessment'));
    assert.equal(outputSchemaOf('fixer'), fixerOutputSchema);
    assert.equal(outputSchemaOf('documentation'), fixerOutputSchema);
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
    assert.ok(triageOutputSchema.safeParse({ candidates: [], leads, change: null }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: leads.slice(1), change: null }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: [...leads, { angle: 'SCAN', lead: null }], change: null }).success);
    assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads: leads.map((lead) => ({ ...lead, lead: '' })), change: null }).success);
  });

  describe('the triage\'s account of the change (R3, R4 of the brief of a run)', () => {
    const condition = { holds: false, what: null, files: [] };
    const account = { title: 'Parse an empty input', what: 'The parser accepts an empty input.', why: null, whyFrom: [], restsOn: ['src/a.ts'], publicInterface: condition, wideEffect: condition };

    it('requires the account, which may be null', () => {
      assert.ok(triageOutputSchema.safeParse({ candidates: [], leads, change: account }).success);
      assert.ok(triageOutputSchema.safeParse({ candidates: [], leads, change: null }).success);
      assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads }).success, 'every field is required, as the runtime contract demands');
    });

    it('refuses no account for breaking a rule the normalization settles: empty texts, a condition that does not hold with a sentence, a reason with no source, an empty list', () => {
      for (const change of [
        { ...account, title: '', what: '' },
        { ...account, title: 'x'.repeat(200) },
        { ...account, why: '', whyFrom: ['', 'a'] },
        { ...account, restsOn: [] },
        { ...account, publicInterface: { holds: false, what: 'something', files: ['src/a.ts'] } },
        { ...account, wideEffect: { holds: true, what: null, files: [] } },
      ]) assert.ok(triageOutputSchema.safeParse({ candidates: [], leads, change }).success, JSON.stringify(change));
    });

    it('holds each text to the wide limit the ledger records, and each list to 50', () => {
      const over = 'x'.repeat(changeTextLengthV1 + 1);
      for (const field of ['title', 'what', 'why'] as const) {
        assert.ok(triageOutputSchema.safeParse({ candidates: [], leads, change: { ...account, [field]: 'x'.repeat(changeTextLengthV1) } }).success, `${field} at the limit`);
        assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads, change: { ...account, [field]: over } }).success, `${field} past it`);
      }
      assert.ok(!triageOutputSchema.safeParse({ candidates: [], leads, change: { ...account, restsOn: Array.from({ length: 51 }, (_, index) => `f${String(index)}`) } }).success);
    });
  });
});

describe('normalizeTriageChange (R3 of the brief of a run)', () => {
  const condition = { holds: false, what: null, files: [] };
  const account = { title: 'Parse an empty input', what: 'The parser accepts an empty input.', why: 'An empty file is valid.', whyFrom: ['abc123'], restsOn: ['src/a.ts'], publicInterface: condition, wideEffect: condition };

  it('keeps an account that already holds to its rules, as it is', () => {
    assert.deepEqual(normalizeTriageChange(account), account);
    assert.equal(normalizeTriageChange(null), null);
  });

  it('trims each text, and reads an account with no title or no what left as no account', () => {
    assert.deepEqual(normalizeTriageChange({ ...account, title: '  Parse  ', what: '\nIt parses.\n' }), { ...account, title: 'Parse', what: 'It parses.' });
    assert.equal(normalizeTriageChange({ ...account, title: '   ' }), null);
    assert.equal(normalizeTriageChange({ ...account, what: '' }), null);
  });

  it('reads an empty reason as none, which loses its sources, and keeps a reason with no source', () => {
    assert.deepEqual(normalizeTriageChange({ ...account, why: ' ', whyFrom: ['abc123'] }), { ...account, why: null, whyFrom: [] });
    assert.deepEqual(normalizeTriageChange({ ...account, why: null, whyFrom: ['abc123'] }), { ...account, why: null, whyFrom: [] });
    assert.deepEqual(normalizeTriageChange({ ...account, whyFrom: [] }), { ...account, whyFrom: [] }, 'the brief says the reason has no source');
  });

  it('takes the sentence and the files from a condition that does not hold, and keeps a condition that holds with no sentence', () => {
    assert.deepEqual(normalizeTriageChange({ ...account, publicInterface: { holds: false, what: 'the flag', files: ['src/cli.ts'] } })?.publicInterface, { holds: false, what: null, files: [] });
    assert.deepEqual(normalizeTriageChange({ ...account, wideEffect: { holds: true, what: '  ', files: [' src/a.ts ', 'src/a.ts', ''] } })?.wideEffect, { holds: true, what: null, files: ['src/a.ts'] });
  });

  it('drops empty entries and repeats from each list, and keeps the first entries up to its limit', () => {
    const many = (count: number): string[] => Array.from({ length: count }, (_, index) => `src/f${String(index)}.ts`);
    const normalized = normalizeTriageChange({ ...account, whyFrom: ['', ...many(25)], restsOn: [...many(40), 'src/f0.ts'], publicInterface: { holds: true, what: 'w', files: many(40) } })!;
    assert.deepEqual(normalized.whyFrom, many(changeSourceLimits.whyFrom));
    assert.deepEqual(normalized.restsOn, many(changeSourceLimits.restsOn));
    assert.deepEqual(normalized.publicInterface.files, many(changeSourceLimits.files));
    assert.deepEqual(normalizeTriageChange({ ...account, restsOn: [] })?.restsOn, [], 'an account that names nothing it rests on stays');
  });

  it('writes what the ledger records, whatever the triage returned within its schema', () => {
    const answers = [
      account,
      { ...account, title: ' t ', why: '', whyFrom: ['x', 'x'], restsOn: [] },
      { ...account, publicInterface: { holds: false, what: 'w', files: ['f'] }, wideEffect: { holds: true, what: '', files: Array.from({ length: 50 }, (_, index) => `f${String(index)}`) } },
      { ...account, whyFrom: Array.from({ length: 50 }, (_, index) => `c${String(index)}`), restsOn: Array.from({ length: 50 }, () => '  ') },
    ];
    for (const answer of answers) {
      assert.ok(triageOutputSchema.shape.change.safeParse(answer).success, 'the answer is one the triage can return');
      const normalized = normalizeTriageChange(answer);
      assert.ok(normalized !== null);
      assert.ok(changeReadingSchema.safeParse(normalized).success, JSON.stringify(normalized));
    }
  });
});

describe('the structural checks', () => {
  it('accept leads that cover the nine angles once and refuse a repeat or a gap', () => {
    assert.doesNotThrow(() => checkTriageLeads({ candidates: [], leads, change: null }));
    assert.throws(() => checkTriageLeads({ candidates: [], leads: [...leads.slice(1), leads[1]!], change: null }), (error: unknown) => error instanceof StructuralCheckError && /two leads for angle RIPPLE/.test(error.message) && /no lead for REMOVALS/.test(error.message) === false);
    const twice = [...leads.slice(0, 8), leads[0]!];
    assert.throws(() => checkTriageLeads({ candidates: [], leads: twice, change: null }), /two leads for angle REMOVALS/);
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

  it('hold the basis of a verdict to its runs in an answer that gives one: a verdict that ran cites a run, one of another basis none, and no cited line is blank (R2, R3 of runs on the record)', () => {
    const run = (printed: string[] = ['TypeError']) => ({ command: 'node probe.mjs', printed, probe: null });
    const verdict = (index: number, basis: 'ran' | 'traced' | 'read', runs: ReturnType<typeof run>[]) => ({ index, verdict: 'CONFIRMED' as const, evidence: 'e', basis, runs });
    assert.doesNotThrow(() => checkVerdicts({ verdicts: [verdict(0, 'ran', [run()]), verdict(1, 'traced', []), verdict(2, 'read', [])] }, 3));
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0, 'ran', [])] }, 1), (error: unknown) => error instanceof StructuralCheckError && /index 0 rests on a run and cites none/.test(error.message));
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0, 'read', [run()])] }, 1), /index 0 is read and cites a run, which only a verdict that rests on a run does/);
    assert.throws(() => checkVerdicts({ verdicts: [verdict(0, 'ran', [run(['ok', ' \t '])])] }, 1), /index 0 cites a blank line of what a run printed/);
  });

  it('give the cited runs of a verifier\'s answer the caps the ledger records, and refuse a verdict without its basis', () => {
    const answer = (runs: unknown[], basis = 'ran') => ({ verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'e', basis, runs }] });
    const run = (change: Record<string, unknown> = {}) => ({ command: 'node probe.mjs', printed: ['x'], probe: 'probe.mjs', ...change });
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run(), run(), run()])).success, true);
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run(), run(), run(), run()])).success, false, 'at most three runs');
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run({ printed: Array.from({ length: citedRunLimitsV1.lines + 1 }, () => 'x') })])).success, false, 'at most five lines');
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run({ printed: ['x'.repeat(citedRunLimitsV1.line + 1)] })])).success, false);
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run({ command: 'x'.repeat(citedRunLimitsV1.command + 1) })])).success, false);
    assert.equal(verifierOutputSchemaV2.safeParse(answer([run({ probe: 'x'.repeat(citedRunLimitsV1.probe + 1) })])).success, false);
    assert.equal(verifierOutputSchemaV2.safeParse({ verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'e' }] }).success, false, 'each verdict gives its basis and its runs');
    assert.equal(verifierOutputSchema.safeParse(answer([])).success, false, 'the answer of a run before runs on the record has neither');
    const longest = run({ command: 'x'.repeat(citedRunLimitsV1.command), printed: Array.from({ length: citedRunLimitsV1.lines }, () => 'y'.repeat(citedRunLimitsV1.line)), probe: null });
    assert.equal(verifierOutputSchemaV2.safeParse(answer([longest])).success, true);
    const recorded = { phase: 'verification', groupId: 'g1', workerId: '00000000-0000-4000-8000-000000000001', verdicts: [{ id: 'SCAN-1', verdict: 'CONFIRMED', evidence: 'e', basis: 'ran', runs: [{ ...longest, at: 1, exitCode: 0 }] }] };
    assert.equal(verdictsRecordedV2.safeParse(recorded).success, true, 'the longest run an answer may cite is one the ledger records');
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
  /**
   * A finding of the answer; `files` and `message` are given as before and
   * built into `edits`, null only when both say none, so a test can write
   * the shapes R11 of commit series integrity forbids and see the schema
   * refuse them.
   */
  const finding = (index: number, change: Record<string, unknown> = {}): Record<string, unknown> => {
    const { files = ['src/a.ts'], message = { subject: 'fix(a): Guard the null', body: 'Why.' }, ...rest } = change;
    return {
      index, status: 'applied', file: 'src/a.ts', line: 3, note: 'n', edits: (files as unknown[]).length === 0 && message === null ? null : { files, message },
      corrections: [], validation: [{ method: 'mutation', source: 'test/a.test.ts', evidence: 'red then green' }], requiredFiles: [], ...rest,
    };
  };
  const answer = (findings: Record<string, unknown>[]): Record<string, unknown> => ({ findings, drift: [], tests: [], suite: { result: 'pass', command: 'npm test', failures: '' } });

  it('compiles for both runtimes and accepts a whole answer', () => {
    const compiled = compileOutputSchema(fixerOutputSchema);
    assert.equal(compiled.json.additionalProperties, false);
    assert.equal(fixerOutputSchema.safeParse(answer([finding(0), finding(1, { status: 'deferred', message: null, line: null, files: [] })])).success, true);
  });

  it('compiles edits as a closed object of at least one file and a message, or null (R1, D7 of fixer edits)', () => {
    const { json } = compileOutputSchema(fixerOutputSchema);
    const item = (json.properties as Record<string, { items: { properties: Record<string, unknown>; required: string[] } }>).findings!.items;
    assert.equal(item.required.includes('edits'), true);
    assert.equal(['files', 'message'].some((field) => field in item.properties), false, 'no top-level files or message beside edits');
    const { anyOf } = item.properties.edits as { anyOf: Record<string, unknown>[] };
    assert.deepEqual(anyOf.map((branch) => branch.type), ['object', 'null']);
    const edits = anyOf[0] as { additionalProperties: unknown; required: string[]; properties: { files: { minItems?: number }; message: { type: unknown } } };
    assert.equal(edits.additionalProperties, false);
    assert.deepEqual([...edits.required].sort(), ['files', 'message']);
    assert.equal(edits.properties.files.minItems, 1);
    assert.equal(edits.properties.message.type, 'object', 'the message inside edits is not nullable');
  });

  it('refuses every shape of edits that breaks the pairing, whatever the status (R1 of fixer edits; R11 of commit series integrity)', () => {
    for (const status of ['applied', 'already-applied', 'deferred', 'blocked']) {
      const requiredFiles = status === 'blocked' ? ['src/b.ts'] : [];
      for (const [name, edits] of [
        ['a message and no files', { files: [], message: { subject: 'fix: x', body: '' } }],
        ['files and a null message', { files: ['src/a.ts'], message: null }],
        ['files and no message', { files: ['src/a.ts'] }],
        ['a message and no files field', { message: { subject: 'fix: x', body: '' } }],
        ['an unknown field', { files: ['src/a.ts'], message: { subject: 'fix: x', body: '' }, why: 'w' }],
      ] as const) assert.equal(fixerOutputSchema.safeParse(answer([{ ...finding(0, { status, requiredFiles }), edits }])).success, false, `${status}: ${name}`);
      assert.equal(fixerOutputSchema.safeParse(answer([{ ...finding(0, { status, requiredFiles }), edits: undefined }])).success, false, `${status}: edits left out`);
    }
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

  it('gives the repair that compares with the base the fixer\'s answer with its comparisons, which compiles for both runtimes (R2, TD6 of the facts before a merge)', () => {
    const { json } = compileOutputSchema(repairOutputSchema);
    assert.equal(json.additionalProperties, false);
    assert.deepEqual((json.required as string[]).filter((field) => !(compileOutputSchema(fixerOutputSchema).json.required as string[]).includes(field)), ['comparisons']);
    const same = { kind: 'lint', reading: 'same', words: 'the same two errors as on the base' };
    const compared = (comparisons: unknown): boolean => repairOutputSchema.safeParse({ ...answer([finding(0)]), comparisons }).success;
    assert.equal(compared([same, { ...same, kind: 'test', reading: 'adds' }, { ...same, reading: 'unknown' }]), true, 'a second entry for a kind is the engine\'s to drop, not the schema\'s');
    assert.equal(compared([]), true);
    for (const [name, comparisons] of [
      ['none given', undefined],
      ['a kind that is no check', [{ ...same, kind: 'format' }]],
      ['a reading that is none of the three', [{ ...same, reading: 'worse' }]],
      ['no words', [{ ...same, words: '' }]],
      ['words over 400 characters', [{ ...same, words: 'w'.repeat(401) }]],
      ['an unknown field', [{ ...same, path: 'src/a.ts' }]],
    ] as const) assert.equal(compared(comparisons), false, name);
    assert.equal(fixerOutputSchema.safeParse({ ...answer([finding(0)]), comparisons: [same] }).success, false, 'no other worker answers with comparisons');
  });

  it('refuses the answer of #54: a blocked finding with no files and a message', () => {
    const blocked = finding(0, {
      status: 'blocked', files: [], requiredFiles: ['test/runtime/git-sync.test.ts'],
      message: { subject: 'fix(runtime): Bound only a detached git with the default timeout', body: 'Partial: no edit made. The claim on test/runtime/git-sync.test.ts was refused.' },
    });
    assert.equal(fixerOutputSchema.safeParse(answer([blocked])).success, false);
  });

  const parsed = (findings: Record<string, unknown>[]) => fixerOutputSchema.parse(answer(findings));

  it('accepts every index once, a message with every finding that names files, and required files on a blocked one', () => {
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(1), finding(0, { status: 'blocked', message: null, files: [], requiredFiles: ['src/b.ts'] })]), 2));
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied', message: null, files: [] })]), 1));
    assert.doesNotThrow(() => checkFixerAnswer(parsed([]), 0));
  });

  it('refuses a missing, repeated or outside index', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0)]), 3), (error: unknown) => error instanceof StructuralCheckError && /leaves out finding \[1\], \[2\] of the 3/.test(error.message));
    assert.throws(() => checkFixerAnswer(parsed([finding(0), finding(0)]), 1), /Finding \[0\] is answered twice/);
    assert.throws(() => checkFixerAnswer(parsed([finding(2)]), 2), /Finding \[2\] is outside the task, whose findings are numbered \[0\] to \[1\]/);
  });

  it('accepts a blocked or deferred finding with files and a message, which commits its partial change under that message (R11 of commit series integrity)', () => {
    for (const status of ['blocked', 'deferred', 'already-applied', 'applied']) {
      const requiredFiles = status === 'blocked' ? ['src/b.ts'] : [];
      assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status, requiredFiles, message: { subject: 'fix(a): Guard the null in part, until c2 lands', body: 'Partial: waits for src/b.ts.' } })]), 1), status);
    }
  });

  it('holds an already-applied finding\'s message to the subject rule, as a retry verifying an earlier attempt\'s edits gives one (R20 of the fix pass)', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { status: 'already-applied', message: { subject: 'fix: Ends here.', body: '' } })]), 1), /one line with no trailing period/);
  });

  it('refuses a subject with a line break or a trailing period', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Two\nlines', body: '' } })]), 1), /one line with no trailing period/);
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Ends here.', body: '' } })]), 1), /one line with no trailing period/);
    assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { message: { subject: 'fix: Handle v1.2', body: '' } })]), 1));
  });

  it('refuses required files on a finding that is not blocked', () => {
    assert.throws(() => checkFixerAnswer(parsed([finding(0, { status: 'deferred', message: null, files: [], requiredFiles: ['src/b.ts'] })]), 1), /Finding \[0\] is deferred and names required files/);
  });

  it('refuses a blocked finding, with or without required files, from a worker whose task offers no `blocked`, and accepts the other statuses there', () => {
    for (const requiredFiles of [[], ['src/b.ts']]) {
      assert.throws(() => checkFixerAnswer(parsed([finding(0, { status: 'blocked', message: null, files: [], requiredFiles })]), 1, false), /Finding \[0\] is blocked, a status its task does not offer/, String(requiredFiles));
    }
    for (const status of ['applied', 'already-applied', 'deferred']) assert.doesNotThrow(() => checkFixerAnswer(parsed([finding(0, { status })]), 1, false), status);
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
