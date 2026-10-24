/**
 * The lines `report --fixes` prints (R6 of the questions in the chat):
 * one for each fix of the run, for a person who asks what the run
 * changed. The fixes stay in the evidence, after what the person must
 * know and decide (PD3), so neither the brief nor its short form lists
 * them.
 */
import type { RunState } from '../checkpoint/fold.ts';
import { briefOf, cutAtWord, firstSentence, fixFateWords, idWords, readOnlyChangedSentence, shortLineLimit, type BriefChanged, type BriefFate } from './brief.ts';
import { lastFixAnswer } from './fix-report.ts';
import { counted, inlineText } from './markdown.ts';
import { rankedFindings } from './state.ts';

/** The fixes the part "What deep-review changed" counts, each with what became of it. */
const countedFates = (changed: BriefChanged): ReadonlyMap<string, Exclude<BriefFate, 'not-fixed'>> => new Map([
  ...changed.applied.map((id) => [id, 'applied'] as const),
  ...changed.alreadyInTree.map((id) => [id, 'already-in-tree'] as const),
  ...changed.deferred.map((id) => [id, 'deferred'] as const),
  ...changed.blocked.map((id) => [id, 'blocked'] as const),
  ...changed.notAttempted.map((id) => [id, 'not-attempted'] as const),
]);

/** What a fix run that gave no finding to a fixer changed, as one sentence: no fix, and what it left. */
const noFixSentence = (changed: BriefChanged): string => {
  const left = changed.left.length === 0 ? '' : ` It left ${counted(changed.left.length, 'finding', 'findings')}: ${idWords(changed.left)}.`;
  return `This run gave no finding to a fixer, so it applied no fix.${left}`;
};

/**
 * One line for each fix that the part "What deep-review changed" counts,
 * in rank order: its id, what became of it, and the subject of the commit
 * message of the answer that gave its last outcome; for an answer with no
 * message, the first sentence of its note; with no answer, why no fixer
 * attempted it. Each line is cut at a word at `shortLineLimit`. A run that
 * only reviewed gets the sentence of the brief that says so, and a fix run
 * that gave no finding to a fixer a sentence that says it applied none.
 */
export function fixLines(state: RunState): string[] {
  const { changed } = briefOf(state);
  const review = state.review!;
  const fix = review.fix;
  if (fix === null) return [readOnlyChangedSentence(changed, (id) => id)];
  const fates = countedFates(changed);
  if (fates.size === 0) return [noFixSentence(changed)];
  return rankedFindings(review).flatMap(({ finding }) => {
    const fate = fates.get(finding.id);
    if (fate === undefined) return [];
    const { answer, reason } = lastFixAnswer(review, fix, finding.id);
    const words = answer === null ? reason ?? 'no fixer answered for it' : answer.message === null ? firstSentence(answer.note) : answer.message.subject;
    return [cutAtWord(`${finding.id}, ${fixFateWords[fate]}: ${inlineText(words)}`, shortLineLimit)];
  });
}
