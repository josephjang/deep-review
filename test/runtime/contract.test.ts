import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { compileOutputSchema, parseInvocation, refuseNonPortablePattern, type InvocationInput } from '../../src/runtime/contract.ts';
import { InvalidInvocationError } from '../../src/runtime/errors.ts';

const valid = (): InvocationInput => ({
  runtime: 'claude',
  executable: resolve('/bin/claude'),
  model: 'sonnet',
  effort: 'high',
  access: 'read-only',
  shell: true,
  prompt: 'Review the change.',
  outputSchema: z.strictObject({ answer: z.string() }),
  timeoutMs: 60_000,
});

describe('parseInvocation', () => {
  it('accepts a minimal invocation and defaults the executable arguments to none', () => {
    const invocation = parseInvocation(valid());
    assert.deepEqual(invocation.executableArgs, []);
    assert.equal(invocation.budgetUsd, undefined);
    assert.equal(invocation.resume, undefined);
  });

  it('accepts every optional field', () => {
    const invocation = parseInvocation({
      ...valid(),
      executableArgs: ['cli.js'],
      budgetUsd: 2.5,
      scratch: resolve('/scratch'),
      label: 'finder: correctness',
      resume: '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b',
    });
    assert.deepEqual(invocation.executableArgs, ['cli.js']);
    assert.equal(invocation.budgetUsd, 2.5);
    assert.equal(invocation.label, 'finder: correctness');
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ['an empty runtime', { runtime: '' }, /runtime/],
    ['a relative executable', { executable: 'bin/claude' }, /absolute path/],
    ['a NUL in the executable arguments', { executableArgs: ['a\0b'] }, /NUL/],
    ['a model that reads as an option', { model: '--dangerous' }, /dash/],
    ['an effort no runtime has', { effort: 'extreme' }, /effort/],
    ['an access level that is not read-only or edit', { access: 'owned-edit' }, /access/],
    ['an empty prompt', { prompt: '' }, /prompt/],
    ['a NUL in the prompt', { prompt: 'a\0b' }, /NUL/],
    ['an output schema that is not a zod schema', { outputSchema: { type: 'object' } }, /zod schema/],
    ['a timeout under one second', { timeoutMs: 999 }, /timeoutMs/],
    ['a timeout over one hour', { timeoutMs: 3_600_001 }, /timeoutMs/],
    ['a fractional timeout', { timeoutMs: 1500.5 }, /timeoutMs/],
    ['a zero budget', { budgetUsd: 0 }, /budgetUsd/],
    ['a budget over 100 dollars', { budgetUsd: 100.01 }, /budgetUsd/],
    ['a relative scratch directory', { scratch: 'scratch' }, /absolute path/],
    ['a session id that reads as an option', { resume: '-x' }, /session id/],
    ['a session id with a space', { resume: 'a b' }, /session id/],
    ['an unknown field', { tools: ['Read'] }, /tools/],
  ];
  for (const [name, change, pattern] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseInvocation({ ...valid(), ...change } as unknown as InvocationInput), (error: unknown) => error instanceof InvalidInvocationError && pattern.test(error.message));
    });
  }
});

describe('compileOutputSchema', () => {
  it('compiles to draft-07 and keeps the exact text it hands over', () => {
    const compiled = compileOutputSchema(z.strictObject({ answer: z.string(), count: z.number().int().nullable() }));
    assert.equal(compiled.json.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(compiled.json.type, 'object');
    assert.equal(compiled.json.additionalProperties, false);
    assert.deepEqual(JSON.parse(compiled.text), compiled.json);
  });

  it('is deterministic, so equal schemas give equal text', () => {
    const schema = (): z.ZodType => z.strictObject({ findings: z.array(z.strictObject({ file: z.string(), line: z.number() })) });
    assert.equal(compileOutputSchema(schema()).text, compileOutputSchema(schema()).text);
  });

  it('refuses a root that is not an object', () => {
    assert.throws(() => compileOutputSchema(z.array(z.string())), /object at its root/);
    assert.throws(() => compileOutputSchema(z.string()), /object at its root/);
  });

  it('refuses a schema JSON Schema cannot express', () => {
    assert.throws(() => compileOutputSchema(z.strictObject({ when: z.date() })), (error: unknown) => error instanceof InvalidInvocationError && /cannot be expressed/.test(error.message));
  });

  it('refuses a lookaround or backreference anywhere in the schema', () => {
    assert.throws(() => compileOutputSchema(z.strictObject({ a: z.string().regex(/^(?=x)x$/) })), /lookaround/);
    assert.throws(() => compileOutputSchema(z.strictObject({ nested: z.array(z.strictObject({ b: z.string().regex(/(a)\1/) })) })), /backreference/);
    assert.throws(() => compileOutputSchema(z.strictObject({ c: z.union([z.string().regex(/(?<!y)z/), z.number()]) })), /lookaround/);
    assert.throws(() => compileOutputSchema(z.strictObject({ d: z.record(z.string(), z.string().regex(/(?<n>a)\k<n>/)) })), /backreference/);
  });

  it('refuses a lookaround in a patternProperties key and in a draft-07 dependencies subschema', () => {
    const keyed = z.strictObject({ m: z.looseRecord(z.string().regex(/^(?=a)x$/), z.number()) });
    assert.throws(() => compileOutputSchema(keyed), (error: unknown) => error instanceof InvalidInvocationError && /lookaround/.test(error.message));
    const dependent = z.strictObject({ a: z.string() }).meta({ dependencies: { a: { properties: { a: { pattern: '(?=x)' } } } } });
    assert.throws(() => compileOutputSchema(z.strictObject({ s: dependent })), /lookaround/);
  });

  it('refuses an optional property or an open object anywhere, which Codex strict structured output rejects', () => {
    const recursive: z.ZodType = z.lazy(() => z.object({ value: z.string(), next: recursive.optional() }));
    const cases: [z.ZodType, RegExp][] = [
      [z.strictObject({ answer: z.string(), note: z.string().optional() }), /object at # leaves note optional/],
      [z.strictObject({ findings: z.array(z.strictObject({ file: z.string(), line: z.number().optional() })) }), /object at #\/properties\/findings\/items leaves line optional/],
      [z.strictObject({ either: z.union([z.string(), z.object({ b: z.string().optional() })]) }), /object at #\/properties\/either\/anyOf\/1 leaves b optional/],
      [z.strictObject({ list: recursive }), /object at #\/definitions\/__schema0 leaves next optional/],
      [z.strictObject({ 'a/b': z.strictObject({ c: z.string().optional() }) }), /object at #\/properties\/a~1b leaves c optional/],
      [z.strictObject({ counts: z.record(z.string(), z.number()) }), /object at #\/properties\/counts allows properties it does not list/],
      [z.strictObject({ counts: z.looseRecord(z.string().regex(/^x/), z.number()) }), /object at #\/properties\/counts allows properties it does not list/],
      [z.strictObject({ extra: z.looseObject({ a: z.string() }) }), /object at #\/properties\/extra allows properties it does not list/],
      [z.looseObject({ a: z.string() }), /object at # allows properties it does not list/],
    ];
    for (const [schema, pattern] of cases) {
      assert.throws(() => compileOutputSchema(schema), (error: unknown) => error instanceof InvalidInvocationError && pattern.test(error.message), String(pattern));
    }
  });

  it('accepts a nullable, a defaulted, a nested closed and an empty object field', () => {
    const compiled = compileOutputSchema(
      z.strictObject({
        answer: z.string(),
        note: z.string().nullable(),
        tries: z.number().default(1),
        nested: z.array(z.object({ a: z.string() })),
        maybe: z.strictObject({ b: z.string() }).nullable(),
        empty: z.strictObject({}),
      }),
    );
    assert.deepEqual(compiled.json.required, ['answer', 'note', 'tries', 'nested', 'maybe', 'empty']);
  });
});

describe('refuseNonPortablePattern', () => {
  it('accepts escapes and look-alike text inside a character class', () => {
    for (const pattern of ['^[a-f0-9]{64}$', '[(?=]', '\\(\\?=', '[\\1]', 'a\\.b', '^\\d+$']) {
      assert.doesNotThrow(() => refuseNonPortablePattern(pattern), pattern);
    }
  });

  it('refuses each kind of lookaround and backreference', () => {
    for (const pattern of ['(?=a)', '(?!a)', '(?<=a)', '(?<!a)']) assert.throws(() => refuseNonPortablePattern(pattern), /lookaround/, pattern);
    for (const pattern of ['(a)\\1', '(a)(b)\\2', '(?<x>a)\\k<x>']) assert.throws(() => refuseNonPortablePattern(pattern), /backreference/, pattern);
  });
});
