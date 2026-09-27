import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CheckpointError,
  EvidenceError,
  InvalidHistoryError,
  InvalidPayloadError,
  NotInRepositoryError,
  RunClosedError,
  StaleRevisionError,
  UnknownEventError,
  UnknownRunError,
  UnsupportedSchemaError,
} from '../src/checkpoint/errors.ts';
import { EngineError } from '../src/errors.ts';
import { InvalidPolicyError, ReviewRefusedError, StructuralCheckError } from '../src/review/errors.ts';
import { InvalidRoleFragmentError, InvalidRoleManifestError } from '../src/roles/errors.ts';
import { InheritedOverrideError, InvalidInvocationError, PreflightError, UnknownRuntimeError, UnsupportedCapabilityError } from '../src/runtime/errors.ts';
import { CaptureRacedError, InvalidScopeRequestError, ScopeAlreadyCapturedError, UnsupportedRepositoryStateError } from '../src/scope/errors.ts';

/** The errors of the roles and the review, none of which concerns the ledger. */
const rolesAndReviewErrors = (): Error[] => [
  new InvalidRoleManifestError('m'),
  new InvalidRoleFragmentError('a.md', 'is empty'),
  new InvalidPolicyError('p'),
  new StructuralCheckError('s'),
  new ReviewRefusedError('r', 'lock-held'),
];

/** The remaining checkpoint errors, so every class the checkpoint declares is checked. */
const otherCheckpointErrors = (): Error[] => [
  new UnsupportedSchemaError(2, 1),
  new UnknownEventError('kind', 1),
  new InvalidPayloadError('p'),
  new UnknownRunError('r'),
  new InvalidHistoryError('h'),
];

describe('the engine error hierarchy', () => {
  it('makes every deliberate error an EngineError, told from a bug by type', () => {
    for (const error of [
      new NotInRepositoryError('n'),
      new StaleRevisionError('run', 1, 2),
      new RunClosedError('r'),
      new EvidenceError('e'),
      ...otherCheckpointErrors(),
      new InvalidInvocationError('i'),
      new UnknownRuntimeError('x', []),
      new UnsupportedCapabilityError('codex', 'resume', 'resume'),
      new InheritedOverrideError('MAX_THINKING_TOKENS', 'overrides the effort'),
      new PreflightError('p'),
      new InvalidScopeRequestError('s'),
      new UnsupportedRepositoryStateError('u'),
      new CaptureRacedError('c'),
      new ScopeAlreadyCapturedError('a'),
      ...rolesAndReviewErrors(),
    ]) {
      assert.ok(error instanceof EngineError, error.name);
    }
    assert.ok(!(new Error('bug') instanceof EngineError));
  });

  it('keeps CheckpointError to the checkpoint, so a runtime or scope refusal is not reported as a ledger problem', () => {
    for (const error of [new NotInRepositoryError('n'), new StaleRevisionError('run', 1, 2), new RunClosedError('r'), new EvidenceError('e'), ...otherCheckpointErrors()]) {
      assert.ok(error instanceof CheckpointError, error.name);
    }
    for (const error of [
      new InvalidInvocationError('i'),
      new UnknownRuntimeError('x', []),
      new UnsupportedCapabilityError('codex', 'resume', 'resume'),
      new InheritedOverrideError('MAX_THINKING_TOKENS', 'overrides the effort'),
      new PreflightError('p'),
      new InvalidScopeRequestError('s'),
      new UnsupportedRepositoryStateError('u'),
      new CaptureRacedError('c'),
      new ScopeAlreadyCapturedError('a'),
      ...rolesAndReviewErrors(),
    ]) {
      assert.ok(!(error instanceof CheckpointError), error.name);
    }
  });

  it('names each error by its own class', () => {
    assert.equal(new EngineError('x').name, 'EngineError');
    assert.equal(new CheckpointError('x').name, 'CheckpointError');
    assert.equal(new PreflightError('x').name, 'PreflightError');
    assert.equal(new CaptureRacedError('x').name, 'CaptureRacedError');
    assert.equal(new InvalidPolicyError('x').name, 'InvalidPolicyError');
    assert.equal(new StructuralCheckError('x').name, 'StructuralCheckError');
    assert.equal(new ReviewRefusedError('x').name, 'ReviewRefusedError');
  });

  it('carries a blocker code on a review refusal only when one applies', () => {
    assert.equal(new ReviewRefusedError('two active runs').code, null);
    assert.equal(new ReviewRefusedError('held', 'lock-held').code, 'lock-held');
  });
});
