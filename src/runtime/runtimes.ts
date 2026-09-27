import { createClaudeAdapter, type ClaudeOptions } from './claude.ts';
import { createCodexAdapter, type CodexOptions } from './codex.ts';
import { RuntimeRegistry } from './registry.ts';

/** Per-runtime settings for the runtimes the engine ships. */
export interface RuntimeOptions {
  readonly claude?: ClaudeOptions;
  readonly codex?: CodexOptions;
}

/**
 * The runtimes this engine ships. A third runtime is its adapter module
 * and one more entry here (R10). A new registry per call, so no caller can
 * register into another's.
 */
export function defaultRuntimes(options: RuntimeOptions = {}): RuntimeRegistry {
  return new RuntimeRegistry([createClaudeAdapter(options.claude), createCodexAdapter(options.codex)]);
}
