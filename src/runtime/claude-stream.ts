import { readEvents, type ShellRun } from './adapter.ts';
import { isObject } from './json.ts';

/**
 * What one read of the `--output-format stream-json --verbose` stream
 * established, held as the few facts the decode needs rather than as the
 * events themselves, so a stream of any length is read in one pass with one
 * line decoded at a time, as `readStream` reads Codex's (TD1 of runs on the
 * record).
 */
export interface ClaudeStreamFacts {
  /** The last `result` event, which is the envelope `--output-format json` printed alone, or null when there was none. */
  envelope: Record<string, unknown> | null;
  /** Why the first line that is not an event object is not one, or null. */
  malformed: string | null;
  /** Each `Bash` call, in the order of the stream, with its result once one arrived. */
  readonly runs: ShellRun[];
  /** The index in `runs` of each call still waiting for its result, by its `tool_use` id. */
  readonly waiting: Map<string, number>;
}

/** The text a `tool_result` carries: its content when that is a string, else the text of each text block joined with line feeds; null for any other shape. */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.flatMap((block) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}

/**
 * The exit code of a `Bash` result: 0 when it is no error, and the code
 * Claude Code names on the first line of an error's text, as it does for a
 * command that exited nonzero; null for any other error, such as a timeout
 * of the tool.
 */
function exitCodeOf(isError: unknown, output: string | null): number | null {
  if (isError === false) return 0;
  if (isError !== true || output === null) return null;
  const named = /^Exit code (\d+)\r?(?:\n|$)/.exec(output);
  return named === null ? null : Number(named[1]);
}

/** The content blocks of an `assistant` or `user` event's message, or none. */
function blocksOf(event: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = isObject(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/** Fold one event into the facts. */
function observe(facts: ClaudeStreamFacts, event: Record<string, unknown>): void {
  switch (event.type) {
    case 'assistant':
      // `Bash` is the one shell tool `claudeTools` gives a worker.
      for (const block of blocksOf(event)) {
        if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
        const command = isObject(block.input) && typeof block.input.command === 'string' ? block.input.command : '';
        if (typeof block.id === 'string') facts.waiting.set(block.id, facts.runs.length);
        facts.runs.push({ command, output: null, exitCode: null });
      }
      break;
    case 'user':
      for (const block of blocksOf(event)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const id = block.tool_use_id;
        const index = facts.waiting.get(id);
        if (index === undefined) continue;
        facts.waiting.delete(id);
        const output = resultText(block.content);
        facts.runs[index] = { command: facts.runs[index]!.command, output, exitCode: exitCodeOf(block.is_error, output) };
      }
      break;
    case 'result':
      facts.envelope = event;
      break;
    default:
      // Any other event, such as `system` or `rate_limit_event`, says nothing the decode reads.
      break;
  }
}

/**
 * Read the whole stream, one line at a time, before any rule is applied, by
 * the rules `readEvents` holds. A call with no result keeps a null output,
 * which no lookup finds.
 */
export function readClaudeStream(lines: Iterable<string | null>): ClaudeStreamFacts {
  const facts: ClaudeStreamFacts = { envelope: null, malformed: null, runs: [], waiting: new Map() };
  facts.malformed = readEvents(lines, 'Claude Code', (event) => observe(facts, event));
  return facts;
}
