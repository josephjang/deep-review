import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { RuntimeRegistry } from './registry.ts';

/**
 * The runtimes this engine ships with. A third runtime is its adapter
 * module and one more entry here (R10). A new registry per call, so no
 * caller can register into another's.
 */
export function defaultRuntimes(): RuntimeRegistry {
  return new RuntimeRegistry([claudeAdapter, codexAdapter]);
}
