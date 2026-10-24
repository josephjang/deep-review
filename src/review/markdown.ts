/**
 * How text from outside the engine (a path, a model's summary, a reason)
 * goes into the Markdown the engine renders, so it can never change the
 * structure around it. The report and the worker prompts share these.
 */

/** Text as one Markdown table cell: a pipe would end the cell and a line break the row. */
export const tableCell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

/**
 * Text inside a line the engine starts, such as a heading, a list item or a
 * `Reason:` line: every line break, with the blanks around it, becomes one
 * space, so the text cannot open a line of its own and with it a heading, a
 * list item, a fence or a new paragraph.
 */
export const inlineText = (text: string): string => text.replaceAll(/[ \t]*[\r\n]+[ \t]*/g, ' ');

/** A count and the noun it counts, singular for one. */
export const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** Words in a list, the last two joined by `and` and any before them by commas. */
export const listed = (words: readonly string[]): string => (words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`);

/** Text with its first character in upper case, to start a sentence. */
export const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * Text as a Markdown code span the text cannot close, the CommonMark way:
 * a delimiter one backtick longer than the longest run the text holds,
 * and a space inside each end when the text starts or ends with a
 * backtick, which would otherwise join the delimiter, or starts and ends
 * with a space, of which a renderer strips one from each end.
 */
export function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const delimiter = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  const pad = padded ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

/**
 * The fixed anchor of a finding in the report, from its id in lower case
 * (R12 of the brief of a run): the report puts it before the finding's
 * heading, and each item of the brief links to it. An id is letters, a
 * dash and digits, so the anchor needs no escape.
 */
export const findingAnchor = (id: string): string => `finding-${id.toLowerCase()}`;

/** Where a report is rendered, for naming a local path the engine writes (R15 of the brief of a run). */
export interface LocalPlaces {
  readonly worktree: string;
  readonly home: string;
}

/**
 * A local path as the report names it outside the facts of the run (R15
 * of the brief of a run): relative to the worktree with forward slashes
 * when it is inside it, under `~` when it is inside the home directory,
 * else as it is. Compared as text, without case on a Windows path, so a
 * render reads no file system.
 */
export function localPathWords(path: string, places: LocalPlaces): string {
  const inside = (root: string): string | null => {
    if (root === '') return null;
    const windows = /^[A-Za-z]:|^\\\\/.test(root);
    const trimmed = root.replace(/[\\/]+$/, '');
    // Only the prefix is lower-cased, never the slice's length: a letter
    // such as 'İ' changes length in lower case.
    const prefix = path.slice(0, trimmed.length);
    if (windows ? prefix.toLowerCase() !== trimmed.toLowerCase() : prefix !== trimmed) return null;
    const separator = path.charAt(trimmed.length);
    if (separator === '') return '';
    return separator === '/' || (windows && separator === '\\') ? path.slice(trimmed.length + 1) : null;
  };
  const inWorktree = inside(places.worktree);
  if (inWorktree !== null) return inWorktree === '' ? '.' : inWorktree.replaceAll('\\', '/');
  const inHome = inside(places.home);
  if (inHome !== null) return inHome === '' ? '~' : `~/${inHome.replaceAll('\\', '/')}`;
  return path;
}

/** A link to a finding's anchor, its id as the text. */
export const findingLink = (id: string): string => `[${id}](#${findingAnchor(id)})`;

/**
 * A model's text as one sentence of a line: inline, ending with a full
 * stop unless it ends with a mark of its own, closing brackets and quotes
 * after it included; a trailing colon, comma or semicolon becomes the stop.
 */
export const sentenceText = (text: string): string => {
  const inline = inlineText(text).trimEnd();
  if (/[.!?][)\]"'”’]*$/.test(inline)) return inline;
  return `${inline.replace(/[:,;]$/, '')}.`;
};

/**
 * Text as a paragraph of its own: inline, without leading blanks (four of
 * them would open a code block), and with a leading character that would
 * open a block escaped: a heading, quote, list item, table row, fence or
 * setext underline. An ordered list marker such as `1.` has its
 * punctuation escaped, since a backslash before a digit is no escape.
 */
export function paragraphText(text: string): string {
  const line = inlineText(text).trimStart();
  if (/^\d{1,9}[.)]/.test(line)) return line.replace(/^(\d{1,9})([.)])/, '$1\\$2');
  return /^[#>*+\-=|`~]/.test(line) ? `\\${line}` : line;
}
