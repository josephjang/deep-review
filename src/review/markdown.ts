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
