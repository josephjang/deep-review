import { createClaudeAdapter, type ClaudeOptions } from './claude.ts';
import { createCodexAdapter, type CodexOptions, type WindowsSandbox } from './codex.ts';
import { RuntimeRegistry } from './registry.ts';

/** Per-runtime settings for the runtimes the engine ships. */
export interface RuntimeOptions {
  readonly claude?: ClaudeOptions;
  readonly codex?: CodexOptions;
}

/**
 * What a run pinned for a runtime, by the runtime's name: today the Codex
 * Windows sandbox (R2, R3 of the Codex sandbox). The launcher hands each
 * worker's adapter its own entry as `LaunchPlan.runtimeOptions`, applied
 * over the options the adapter was built with, so the workers are confined
 * as the ledger says whatever registry the caller passed.
 */
export interface PinnedRuntimeOptions {
  readonly codex?: { readonly windowsSandbox: WindowsSandbox };
}

/**
 * The runtimes this engine ships. A third runtime is its adapter module
 * and one more entry here (R10). A new registry per call, so no caller can
 * register into another's.
 */
export function defaultRuntimes(options: RuntimeOptions = {}): RuntimeRegistry {
  return new RuntimeRegistry([createClaudeAdapter(options.claude), createCodexAdapter(options.codex)]);
}
