/**
 * The launch label of a review worker: its role key (D10 of the role
 * prompts) and the unit it serves, `<role> <phase>:<key>`, so the ledger
 * says which unit a lost worker belonged to and which phase a finished
 * worker's spend counts toward.
 */
import { phaseSchema, unitKeySchema, type Phase } from './vocabulary.ts';

export interface UnitLabel {
  readonly role: string;
  readonly phase: Phase;
  readonly key: string;
}

export function unitLabel(role: string, phase: Phase, key: string): string {
  return `${role} ${phase}:${key}`;
}

/** The unit a label names, or null for a label written by something other than the review controller. */
export function parseUnitLabel(label: string | null): UnitLabel | null {
  if (label === null) return null;
  const match = /^(\S+) ([a-z-]+):([A-Za-z0-9-]+)$/.exec(label);
  if (match === null) return null;
  const phase = phaseSchema.safeParse(match[2]);
  const key = unitKeySchema.safeParse(match[3]);
  return phase.success && key.success ? { role: match[1]!, phase: phase.data, key: key.data } : null;
}
