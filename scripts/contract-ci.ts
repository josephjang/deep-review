// CI policy lives outside the engine bundle. Unknown inputs always require the contract.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitSync } from '../src/runtime/git-sync.ts';

const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const reasons = ['docs-only', 'relevant-change', 'non-pr', 'inventory-unavailable'] as const;
type Reason = typeof reasons[number];
export interface ContractPlan {
  required: boolean;
  reason: Reason;
  files: number;
  base?: string;
  head?: string;
  mergeBase?: string;
}

interface Change { beforeMode: string; afterMode: string; path: string }

export function parseChanges(raw: Buffer): Change[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (text === '') return [];
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Incomplete raw diff');
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = /^:(\d{6}) (\d{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([AMDT])$/.exec(fields[index] ?? '');
    const path = fields[index + 1];
    if (!header || !path) throw new Error('Unsupported raw diff');
    const missingBefore = header[1] === '000000';
    const missingAfter = header[2] === '000000';
    if ((header[3] === 'A' && (!missingBefore || missingAfter)) || (header[3] === 'D' && (missingBefore || !missingAfter)) ||
      ((header[3] === 'M' || header[3] === 'T') && (missingBefore || missingAfter))) throw new Error('Inconsistent raw diff');
    changes.push({ beforeMode: header[1]!, afterMode: header[2]!, path });
  }
  return changes;
}

export function documentationOnly(changes: readonly Change[]): boolean {
  return changes.length > 0 && changes.every(change => {
    if (![change.beforeMode, change.afterMode].every(mode => mode === '000000' || mode === '100644')) return false;
    if (change.beforeMode === '000000' && change.afterMode === '000000') return false;
    if (/[\\\x00-\x1f\x7f]/.test(change.path) || change.path.split('/').some(part => part === '' || part === '.' || part === '..')) return false;
    return change.path === 'README.md' || change.path === 'AGENTS.md' || (change.path.startsWith('docs/') && change.path.endsWith('.md'));
  });
}

function git(cwd: string, ...args: string[]): Buffer {
  return runGitSync(args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid event');
  return value as Record<string, unknown>;
}

export function contractPlan(cwd: string, eventName: string, event: unknown, testedSha: string): ContractPlan {
  if (eventName !== 'pull_request') return { required: true, reason: 'non-pr', files: 0 };
  try {
    const pull = object(object(event).pull_request);
    const base = object(pull.base).sha;
    const head = object(pull.head).sha;
    if (typeof base !== 'string' || typeof head !== 'string' || !sha.test(base) || !sha.test(head) || !sha.test(testedSha)) throw new Error('Invalid revision');
    const text = (...args: string[]) => git(cwd, ...args).toString('utf8').trim();
    if (text('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Incomplete history');
    if (text('rev-parse', 'HEAD') !== testedSha) throw new Error('Unexpected checkout');
    const parents = text('show', '-s', '--format=%P', testedSha).split(' ');
    if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) throw new Error('Unexpected tested merge');
    const mergeBase = text('merge-base', '--all', base, head);
    if (!sha.test(mergeBase)) throw new Error('Ambiguous merge base');
    const diff = (from: string, to: string) => parseChanges(git(cwd, 'diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--'));
    const changes = [...diff(mergeBase, head), ...diff(base, testedSha)];
    const files = new Set(changes.map(change => change.path)).size;
    const exempt = documentationOnly(changes);
    return { required: !exempt, reason: exempt ? 'docs-only' : 'relevant-change', files, base, head, mergeBase };
  } catch {
    return { required: true, reason: 'inventory-unavailable', files: 0 };
  }
}

export function planStatus(environment: NodeJS.ProcessEnv): { valid: boolean; exempt: boolean; message: string } {
  const required = environment.CONTRACT_REQUIRED;
  const reason = environment.CONTRACT_REASON;
  const files = environment.CONTRACT_FILES;
  const knownReason = reasons.some(candidate => candidate === reason);
  const valid = environment.CONTRACT_PLAN_RESULT === 'success' && knownReason && /^(0|[1-9]\d*)$/.test(files ?? '') && Number.isSafeInteger(Number(files)) &&
    ((required === 'false' && reason === 'docs-only' && Number(files) > 0 && environment.GITHUB_EVENT_NAME === 'pull_request') || (required === 'true' && reason !== 'docs-only'));
  const exempt = valid && required === 'false';
  if (!valid) return { valid: false, exempt: false, message: 'Invalid or unsuccessful contract plan; full contract required and status rejected.' };
  return { valid: true, exempt, message: exempt ? `Contract exempted: ${files} documentation-only paths; no contract result claimed.` : `Full three-OS contract required (${reason}).` };
}

export function aggregateStatus(environment: NodeJS.ProcessEnv, matrixResult: string): ReturnType<typeof planStatus> {
  const status = planStatus(environment);
  if (!status.valid) return status;
  if (matrixResult !== 'success') return { valid: false, exempt: false, message: `Contract matrix did not succeed (${matrixResult}).` };
  return status;
}

function emit(values: Record<string, string>): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function report(value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Contract CI decision\n\n\`\`\`json\n${text}\n\`\`\`\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'plan') {
    let plan: ContractPlan;
    try {
      const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
      plan = contractPlan(process.cwd(), process.env.GITHUB_EVENT_NAME ?? '', event, process.env.GITHUB_SHA ?? '');
    } catch {
      plan = { required: true, reason: 'inventory-unavailable', files: 0 };
    }
    emit({ required: String(plan.required), reason: plan.reason, files: String(plan.files) });
    report(plan);
  } else if (command === 'gate' || command === 'status') {
    const status = command === 'status' ? aggregateStatus(process.env, process.env.CONTRACT_MATRIX_RESULT ?? 'missing') : planStatus(process.env);
    emit({ exempt: String(status.exempt) });
    report(status);
    if (!status.valid) process.exitCode = 1;
  } else {
    throw new Error('Expected plan, gate or status');
  }
}
