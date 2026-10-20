// The review the fix pass tests share: test/review/fix-pass.test.ts,
// fix-pass-claims.test.ts and fix-continuation.test.ts each script a
// sandbox with reviewScript and its fixers write fixedA and fixedB.
import { finderAngles } from '../../src/review/vocabulary.ts';
import { deciderAnswer, type Script } from './fake-runtime.ts';

/** A candidate as a finder returns it. */
export const found = (file: string, line: number, summary: string): Record<string, unknown> => ({ file, line, summary, detail: `${summary}: the failure a user would see` });

/** A lead for each finder angle, with nothing in it. */
export const noLeads = finderAngles.map((angle) => ({ angle, lead: null }));

/** The triage's account of the change in the review script below (R3 of the brief of a run). */
export const fixtureAccount = {
  title: 'Let parse take null, and add b',
  what: 'parse() now takes a null text, another function passes it one, and a new module calls parse.',
  why: null,
  whyFrom: [],
  restsOn: ['src/a.ts', 'src/b.ts'],
  publicInterface: { holds: true, what: 'parse() takes a null text.', files: ['src/a.ts'] },
  wideEffect: { holds: false, what: null, files: [] },
};

/**
 * A review whose triage finds one defect in src/a.ts and one in src/b.ts,
 * both PLAUSIBLE from SCAN, which the decider decides to fix, and whose
 * sweep adds a PLAUSIBLE DESIGN finding in src/a.ts, which it leaves as
 * outside the change, so no fixer sees it. Ranked SCAN-1, SCAN-2,
 * SWEEP-1, the plan is c1 owning src/a.ts with SCAN-1 and c2 owning
 * src/b.ts with SCAN-2, one batch each, c1-1 and c2-1.
 */
export const reviewScript: Script = {
  triage: { output: { candidates: [found('src/a.ts', 2, 'text is dereferenced when null'), found('src/b.ts', 1, 'b calls parse without importing it')], leads: noLeads, change: fixtureAccount } },
  sweep: { output: { candidates: [{ ...found('src/a.ts', 5, 'other() would read better inlined'), angle: 'DESIGN' }] } },
  decider: { output: deciderAnswer([{}, {}, { decision: 'leave' }]) },
};

/** The fixed bytes each fixer writes. */
export const fixedA = 'export function parse(text: string | null) {\n  return text?.length ?? 0;\n}\n\nexport function other() {\n  return parse(null);\n}\n';
export const fixedB = 'import { parse } from \'./a.ts\';\n\nexport const b = parse("x");\n';
