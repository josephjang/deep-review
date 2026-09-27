/**
 * How text from outside the engine (a path, a model's summary, a reason)
 * goes into the Markdown the engine renders, so it can never change the
 * structure around it. The report and the worker prompts share these.
 */

/** Text as one Markdown table cell: a pipe would end the cell and a line break the row. */
export const tableCell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
