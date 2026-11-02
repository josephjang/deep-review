/**
 * The markers of `deep-review publish` (TD5 of the review on the pull
 * request): the marker of a publication, which the body of its review
 * carries on its last line, and the marker of a finding's comment, with
 * the line that writes one and the reader that finds it again. The form
 * writes them, the fold checks a publication's, and a settle matches the
 * two, so all of them read one definition. No imports, so the checkpoint
 * can take them too.
 */

/** The marker of the run's publication with the serial `serial`, which the body of its review carries on its last line (TD5). */
export const publicationMarker = (run: string, serial: number): string => `deep-review publication ${run} ${String(serial)}`;

/** The marker of a finding's comment, which the comment carries on its last line, so a settle matches it to its finding. */
export const findingMarker = (run: string, finding: string): string => `deep-review finding ${run} ${finding}`;

/** The last line of a body or a comment that carries `marker`, `<!-- <marker> -->`, as `lastLineMarker` reads it back. */
export const markerLine = (marker: string): string => `<!-- ${marker} -->`;

/** The marker on the last line of a text GitHub gives, `<!-- <marker> -->`, or null; a marker anywhere else is a worker's text, never the engine's (TD5). */
export function lastLineMarker(body: string): string | null {
  const last = body.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? '';
  return /^<!-- (.+) -->$/.exec(last)?.[1] ?? null;
}
