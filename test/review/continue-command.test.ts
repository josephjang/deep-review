import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScopeState } from '../../src/checkpoint/events.ts';
import { engineRolesRoot } from '../../src/engine.ts';
import { budgetAbove, continueCommand, namedRoles } from '../../src/review/continue-command.ts';
import { fixRun } from '../helpers/review-history.ts';

describe('continueCommand (R11, R15 of resumable runs)', () => {
  const run = fixRun().fold();
  const withScope = (mode: ScopeState['mode'], request: Partial<ScopeState['request']> = {}) => ({ ...run, scope: { ...run.scope!, mode, request: { paths: [], exclude: [], ...request } } });
  const engine = '/opt/deep review/engine/main.mjs';

  it('names the engine, the runtime, the scope flags of the run\'s request, --fix and a budget above the spend', () => {
    assert.equal(continueCommand(withScope('last-commit'), engine, null, 61.16), `node "${engine}" review --runtime claude --last-commit --fix --budget-usd 62`);
    assert.equal(continueCommand(withScope('worktree', { paths: ['src', 'docs/a b.md'] }), engine, null, 3), `node "${engine}" review --runtime claude --worktree --path src --path "docs/a b.md" --fix --budget-usd 4`);
    assert.equal(continueCommand(withScope('ref', { ref: 'HEAD~2' }), engine, null, 0.5), `node "${engine}" review --runtime claude --ref HEAD~2 --fix --budget-usd 1`);
    // --branch is a range from the base to HEAD from their merge base, which these flags name as namesScope matches them.
    assert.equal(continueCommand(withScope('range', { range: { from: 'origin/main', to: 'HEAD', mergeBase: true } }), engine, null, 9.99), `node "${engine}" review --runtime claude --from origin/main --to HEAD --merge-base --fix --budget-usd 10`);
    assert.equal(continueCommand(withScope('range', { range: { from: 'v1', to: 'v2', mergeBase: false } }), engine, null, 1), `node "${engine}" review --runtime claude --from v1 --to v2 --fix --budget-usd 2`);
  });

  it('names --roles for roles other than the engine\'s own, quoted as a terminal takes them', () => {
    assert.equal(continueCommand(withScope('last-commit'), engine, '/home/me/$roles', 1), `node "${engine}" review --runtime claude --last-commit --fix --budget-usd 2 --roles '/home/me/$roles'`);
    assert.equal(namedRoles(engineRolesRoot()), null);
    assert.equal(namedRoles('/somewhere/else/roles'), '/somewhere/else/roles');
  });

  it('asks a whole dollar above the spend, so the budget is above it even at a whole spend', () => {
    assert.deepEqual([0, 0.01, 1, 61.16, 61.99].map(budgetAbove), [1, 1, 2, 62, 62]);
  });

  it('refuses a run with no scope or no configuration', () => {
    assert.throws(() => continueCommand({ ...run, scope: null }, engine, null, 1), /A run continues only with its scope and its configuration/);
  });
});
