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
 * The fixed anchor of a finding in the report, from its number (R6 of the
 * report for the person): the report puts it before the finding's
 * heading, and each mention of the finding that links links to it.
 */
export const findingAnchor = (number: number): string => `finding-${String(number)}`;

/** The fixed anchor of a check's block under Checks in the report, from its kind; a check named before the merge links to it. */
export const checkAnchor = (kind: string): string => `check-${kind}`;

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

/** A link to a finding's anchor, `finding N` as the text. */
export const findingLink = (number: number): string => `[finding ${String(number)}](#${findingAnchor(number)})`;

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

/**
 * The parts of a text in and out of its code spans, in order, by the
 * CommonMark rule: a run of backticks opens a span that the next run of
 * the same length closes, and a run with no such closer is plain text.
 * A backtick after an odd run of backslashes is escaped, so it is plain
 * text and opens nothing; inside a span a backslash is literal and
 * stops no closer.
 */
function codeParts(text: string): { readonly code: boolean; readonly text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  let plain = '';
  let at = 0;
  while (at < text.length) {
    const open = /`+/.exec(text.slice(at));
    if (open === null) break;
    const start = at + open.index;
    let backslashes = 0;
    while (text.charAt(start - backslashes - 1) === '\\') backslashes += 1;
    if (backslashes % 2 === 1) {
      plain += text.slice(at, start + 1);
      at = start + 1;
      continue;
    }
    const run = open[0];
    const closer = new RegExp(`(?<!\`)${run}(?!\`)`).exec(text.slice(start + run.length));
    if (closer === null) {
      plain += text.slice(at, start + run.length);
      at = start + run.length;
      continue;
    }
    const end = start + run.length + closer.index + run.length;
    plain += text.slice(at, start);
    if (plain !== '') parts.push({ code: false, text: plain });
    plain = '';
    parts.push({ code: true, text: text.slice(start, end) });
    at = end;
  }
  plain += text.slice(at);
  if (plain !== '') parts.push({ code: false, text: plain });
  return parts;
}

/**
 * A worker's text with what a preview of Markdown would hide escaped
 * outside its code spans (R11, TD6 of the report for the person): a
 * backslash before `<`, before `*`, before an `_` that is not between two
 * letters or digits, before a `[` that opens a link such as `[x](y)` and
 * before an `&` that opens an entity such as `&lt;`, which CommonMark
 * reads as the character itself. So `snake_case` and a batch index such as
 * `[0]` stay bare. A character a backslash already escapes stays as it is;
 * a backslash that a backslash escapes, as in `C:\\<b>`, escapes nothing.
 */
export function escapedText(text: string): string {
  const code = codeParts(text).flatMap((part) => Array.from({ length: part.text.length }, () => part.code));
  let escaped = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (code[at] === true) {
      escaped += char;
    } else if (char === '\\') {
      escaped += text.slice(at, at + 2);
      at += 1;
    } else {
      escaped += hides(text, at, code) ? `\\${char}` : char;
    }
  }
  return escaped;
}

/** Whether the character at `at`, outside a code span and escaped by no backslash, would change or hide text in a preview. */
function hides(text: string, at: number, code: readonly boolean[]): boolean {
  switch (text.charAt(at)) {
    case '<':
    case '*':
      return true;
    case '_':
      return !(/[\p{L}\p{N}]$/u.test(text.slice(Math.max(0, at - 2), at)) && /^[\p{L}\p{N}]/u.test(text.slice(at + 1, at + 3)));
    case '[':
      return opensLink(text, at, code);
    case '&':
      return /^&(?:#[0-9]{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.test(text.slice(at));
    default:
      return false;
  }
}

/** Whether the `[` at `at` opens a link or an image: the `]` that balances it, outside code spans, is followed by `(`. */
function opensLink(text: string, at: number, code: readonly boolean[]): boolean {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (code[index] === true) continue;
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.charAt(index + 1) === '(';
    }
  }
  return false;
}

/** What a quote of a worker can name: the number of each finding by its id and its merged ids, the finding the quote is about, and for a fixer's text the findings of its batch, in the order its task numbered them. */
export interface QuoteContext {
  readonly numbers: ReadonlyMap<string, number>;
  readonly own?: number | null;
  readonly batch?: readonly string[] | null;
}

/**
 * A worker's text as the report quotes it (R6, PD13, TD5 of the report for
 * the person): its words, with the number of a finding added after each id
 * of the run that names another finding than its own, and after a batch
 * index such as `[0]` that stands alone and names a finding of the
 * fixer's batch; outside its code spans, and then escaped as a whole
 * (`escapedText`), which a number adds no backtick or backslash to. An id
 * the run does not hold, a name such as `argv[0]`, and an id inside a path
 * or URL such as `notes/RIPPLE-3.md` stay as they are; an id that ends a
 * sentence, as in `RIPPLE-3.`, still gets its number.
 */
export function quoted(text: string, context: QuoteContext): string {
  const alias = (number: number | undefined): string => (number === undefined || number === context.own ? '' : ` (finding ${String(number)})`);
  return escapedText(codeParts(text).map((part) => {
    if (part.code) return part.text;
    const named = part.text.replaceAll(/(?<![/\\.#])\b[A-Z]+-[1-9][0-9]*\b(?!\/|\.\w| \(finding \d)/g, (id) => `${id}${alias(context.numbers.get(id))}`);
    return context.batch === undefined || context.batch === null
      ? named
      : named.replaceAll(/(?<![\w\])>`])\[(0|[1-9][0-9]*)\](?! \(finding \d)/g, (index: string, position: string) => {
        const id = context.batch![Number(position)];
        return `${index}${alias(id === undefined ? undefined : context.numbers.get(id))}`;
      });
  }).join(''));
}

/**
 * Findings by their numbers as a sentence names them: one as `finding 3`,
 * several as `findings 2, 5 and 9`, with a run of three or more as
 * `11 to 19`.
 */
export function findingWords(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let at = 0; at < sorted.length;) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1;
    if (end - at >= 2) runs.push(`${String(sorted[at])} to ${String(sorted[end])}`);
    else for (let index = at; index <= end; index += 1) runs.push(String(sorted[index]));
    at = end + 1;
  }
  return `${sorted.length === 1 ? 'finding' : 'findings'} ${listed(runs)}`;
}

/** Another finding as the report names it: `finding` and its number, or its id when the run numbered none. */
export const findingNamed = (numbers: ReadonlyMap<string, number>, id: string): string => `finding ${String(numbers.get(id) ?? id)}`;
