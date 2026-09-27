import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { accessSchema, effortSchema, sessionIdSchema } from '../checkpoint/events.ts';
import { InvalidInvocationError } from './errors.ts';

const noNul = (value: string): boolean => !value.includes('\0');

/** Non-empty text without a NUL, which no command line or file name can carry. */
const text = z.string().min(1).refine(noNul, 'must not contain a NUL character');

/** Text that becomes the value of a command-line option, so it must not read as an option itself. */
const optionValue = text.refine((value) => !value.startsWith('-'), 'must not start with a dash');

const absolutePath = text.refine((value) => isAbsolute(value), 'must be an absolute path');

/** Longest a worker may run: one hour. */
export const maxTimeoutMs = 60 * 60 * 1000;

/** Highest budget a worker may be given, in US dollars. */
export const maxBudgetUsd = 100;

/**
 * What the engine asks of one worker, in runtime-neutral terms (R1, TD3).
 * Permissions are two axes, `access` and `shell`, never a runtime's tool
 * names; the adapter translates them.
 */
export const invocationSchema = z.strictObject({
  /** A name registered in the runtime registry. */
  runtime: text,
  /** Absolute path of the runtime CLI (TD10): which binary runs is recorded, not resolved through PATH at launch. */
  executable: absolutePath,
  /**
   * Literal arguments placed before the adapter's own, for a CLI that is a
   * script behind an interpreter, such as `node cli.js`. Empty for a native
   * executable.
   */
  executableArgs: z.array(z.string().refine(noNul, 'must not contain a NUL character')).default([]),
  model: optionValue,
  effort: effortSchema,
  access: accessSchema,
  /** Whether the worker may run shell commands. */
  shell: z.boolean(),
  /** The task, or the follow-up message when `resume` is given. */
  prompt: text,
  /** What the worker must return. Compiled to draft-07 JSON Schema for the runtime and used to validate its answer. */
  outputSchema: z.custom<z.ZodType>((value) => value instanceof z.ZodType, 'must be a zod schema'),
  timeoutMs: z.number().int().min(1000).max(maxTimeoutMs),
  budgetUsd: z.number().positive().max(maxBudgetUsd).optional(),
  /**
   * Where the worker may write temporary files. Outside the reviewed tree
   * and the checkpoint; the launcher creates one under the system's
   * temporary directory when it is not given.
   */
  scratch: absolutePath.optional(),
  /** Free text recorded on the ledger; the role element gives it meaning. */
  label: text.optional(),
  /** A session to continue; the prompt is then the follow-up message (R9). */
  resume: sessionIdSchema.optional(),
});

/** An invocation as a caller writes it; `executableArgs` may be left out. */
export type InvocationInput = z.input<typeof invocationSchema>;
/** An invocation after validation, with every default applied. */
export type Invocation = z.output<typeof invocationSchema>;

/** Validate an invocation, naming every problem in one error. */
export function parseInvocation(value: InvocationInput): Invocation {
  const parsed = invocationSchema.safeParse(value);
  if (!parsed.success) throw new InvalidInvocationError(`Invalid invocation: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The output schema as the runtimes receive it, and the exact text that is frozen and handed over. */
export interface CompiledSchema {
  readonly json: Record<string, unknown>;
  readonly text: string;
}

/**
 * Compile the output schema to draft-07 JSON Schema (TD11). Both runtimes
 * accept draft-07 and Claude Code rejects the 2020-12 URI zod emits by
 * default. The root must be an object, which both runtimes require, and no
 * pattern may use a lookaround or a backreference, which one runtime's
 * validator accepts and the other's refuses.
 */
export function compileOutputSchema(schema: z.ZodType): CompiledSchema {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidInvocationError(`The output schema cannot be expressed as JSON Schema: ${(error as Error).message}`);
  }
  if (json.type !== 'object') throw new InvalidInvocationError('The output schema must describe an object at its root');
  inspectPatterns(json);
  return { json, text: JSON.stringify(json) };
}

/** Every keyword whose value is a map of subschemas. */
const schemaMaps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'];
/** Every keyword whose value is one subschema. */
const schemaSingles = ['items', 'additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];
/** Every keyword whose value is a list of subschemas. */
const schemaLists = ['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items'];

function inspectPatterns(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  if (typeof schema.pattern === 'string') refuseNonPortablePattern(schema.pattern);
  for (const key of schemaMaps) {
    const children = schema[key];
    if (children !== null && typeof children === 'object') for (const child of Object.values(children)) inspectPatterns(child);
  }
  for (const key of schemaSingles) if (!Array.isArray(schema[key])) inspectPatterns(schema[key]);
  for (const key of schemaLists) {
    const list = schema[key];
    if (Array.isArray(list)) for (const child of list) inspectPatterns(child);
  }
}

/** Refuse a lookaround or a backreference outside a character class. */
export function refuseNonPortablePattern(pattern: string): void {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const next = pattern[index + 1];
      index += 1;
      if (!inClass && next !== undefined && (/[1-9]/.test(next) || (next === 'k' && pattern[index + 1] === '<'))) {
        throw new InvalidInvocationError(`Output schema pattern ${JSON.stringify(pattern)} uses a backreference, which not every runtime supports`);
      }
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (!inClass && ['(?=', '(?!', '(?<=', '(?<!'].some((prefix) => pattern.startsWith(prefix, index))) {
      throw new InvalidInvocationError(`Output schema pattern ${JSON.stringify(pattern)} uses a lookaround, which not every runtime supports`);
    }
  }
}
