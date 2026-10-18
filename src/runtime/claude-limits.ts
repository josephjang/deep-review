/**
 * The words with which Claude Code says a usage limit or a session limit
 * is reached (R14 of resumable runs), in one list, and the reset it names
 * after them. Claude Code reports such a limit as a result with `is_error`
 * true and the words in `result`; a retry before the reset cannot pass,
 * so the engine blocks the phase at the first one rather than spend the
 * unit's attempts. The list is what the adapter knows: run `e21b026d`
 * gave `You've hit your session limit · resets 12:10pm (Asia/Seoul)`, and
 * older builds `Claude AI usage limit reached|<epoch seconds>`.
 */

/** The phrases that name a limit the provider put on the account, not a fault of the worker. */
const limitPhrases: readonly RegExp[] = [
  /\byou(?:'|’)ve hit your (?:session|usage|weekly|5-hour|opus) limit\b/i,
  /\busage limit reached\b/i,
  /\b(?:session|weekly|5-hour) limit reached\b/i,
];

/** How the reset follows the phrase: `resets <time>` or `will reset at <time>`, a sentence's period left out, or `|<epoch seconds>`. */
const resetPhrase = /\bresets? (?:at )?(?<when>[^\n|]+?)\.?\s*$/i;
const epochReset = /\|(?<seconds>\d{9,11})\s*$/;

/** A limit Claude Code reported: its words as given, and the reset they name, or null when they name none. */
export interface ClaudeLimit {
  readonly text: string;
  readonly reset: string | null;
}

/** The limit `text` names, or null for any other error. */
export function claudeLimit(text: string): ClaudeLimit | null {
  if (!limitPhrases.some((phrase) => phrase.test(text))) return null;
  const epoch = epochReset.exec(text)?.groups?.seconds;
  if (epoch !== undefined) return { text, reset: new Date(Number(epoch) * 1000).toISOString() };
  const when = resetPhrase.exec(text)?.groups?.when;
  return { text, reset: when === undefined || when.length === 0 ? null : when };
}
