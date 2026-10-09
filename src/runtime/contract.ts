import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { accessSchema, effortSchema, sessionIdSchema } from '../checkpoint/events.ts';
import { InvalidInvocationError } from './errors.ts';
import { isObject } from './json.ts';

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
  /**
   * A directory an editor may write beside its scratch, which other
   * editors of the run share: the round's claims directory for a fixer
   * (R2 of commit series integrity). Outside the reviewed tree and the
   * checkpoint, and never given to a read-only worker. Not recorded on the
   * ledger: the directory is the round's, and the engine prepares it at
   * every launch.
   */
  shared: absolutePath.optional(),
  /** Free text recorded on the ledger. A worker that runs a role is labelled with its role key, so the ledger says which role ran (D10 of the role prompts proposal). */
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
 * default. The root must be an object, which both runtimes require. No
 * pattern, a `patternProperties` key included, may use a lookaround or a
 * backreference, which one runtime's validator accepts and the other's
 * refuses. Every object must list each of its properties as required and
 * allow no other, which Codex's strict structured output demands: a field
 * that may be absent is written `.nullable()`, and a record or a loose
 * object is refused.
 */
export function compileOutputSchema(schema: z.ZodType): CompiledSchema {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidInvocationError(`The output schema cannot be expressed as JSON Schema: ${(error as Error).message}`);
  }
  if (json.type !== 'object') throw new InvalidInvocationError('The output schema must describe an object at its root');
  forEachSubschema(json, '#', refuseNonPortablePatterns);
  forEachSubschema(json, '#', refuseOpenObject);
  return { json, text: JSON.stringify(json) };
}

/** Every keyword whose value is a map of subschemas. Draft-07's `dependencies` also maps to property lists, which hold no schema. */
const schemaMaps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies'];
/** Every keyword whose value is one subschema. */
const schemaSingles = ['items', 'additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];
/** Every keyword whose value is a list of subschemas. */
const schemaLists = ['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items'];

/** One JSON Pointer reference token (RFC 6901). */
const pointerToken = (name: string): string => name.replaceAll('~', '~0').replaceAll('/', '~1');

/** Call `visit` on the schema at `path` and on every subschema beneath it, each with its JSON Pointer. */
function forEachSubschema(node: unknown, path: string, visit: (schema: Record<string, unknown>, path: string) => void): void {
  if (!isObject(node)) return;
  visit(node, path);
  for (const key of schemaMaps) {
    const children = node[key];
    if (isObject(children)) for (const [name, child] of Object.entries(children)) forEachSubschema(child, `${path}/${key}/${pointerToken(name)}`, visit);
  }
  for (const key of schemaSingles) forEachSubschema(node[key], `${path}/${key}`, visit);
  for (const key of schemaLists) {
    const list = node[key];
    if (Array.isArray(list)) list.forEach((child: unknown, index) => { forEachSubschema(child, `${path}/${key}/${String(index)}`, visit); });
  }
}

/** Refuse a non-portable `pattern`, or `patternProperties` key, of one schema. */
function refuseNonPortablePatterns(schema: Record<string, unknown>): void {
  if (typeof schema.pattern === 'string') refuseNonPortablePattern(schema.pattern);
  if (isObject(schema.patternProperties)) for (const key of Object.keys(schema.patternProperties)) refuseNonPortablePattern(key);
}

/**
 * Refuse an object Codex's strict structured output rejects: one that
 * allows a property it does not list, or lists a property as optional.
 */
function refuseOpenObject(schema: Record<string, unknown>, path: string): void {
  const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes('object')) return;
  if (schema.additionalProperties !== false) {
    throw new InvalidInvocationError(`Output schema object at ${path} allows properties it does not list, which Codex's strict structured output refuses; use a strict object, not a record or a loose object`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const optional = Object.keys(isObject(schema.properties) ? schema.properties : {}).filter((name) => !required.has(name));
  if (optional.length > 0) {
    throw new InvalidInvocationError(`Output schema object at ${path} leaves ${optional.join(', ')} optional, which Codex's strict structured output refuses; make each required and .nullable() instead`);
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
