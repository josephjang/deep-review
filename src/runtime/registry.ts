import type { RuntimeAdapter } from './adapter.ts';
import { UnknownRuntimeError } from './errors.ts';

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Runtime adapters by name (TD2). The launcher looks a runtime up here and
 * calls its interface, so a third runtime is one module and one
 * registration. Outside an adapter's module the engine does not branch on
 * a runtime's name, with one exception: a review's Codex-only settings are
 * keyed by `codexRuntimeName`. Those are the `--codex-windows-sandbox`
 * flag, the role policy entry's `windowsSandbox`, and the ledger's `codex`
 * field of `review.configured@4` with the options pinned from it; the
 * frozen ledger schema and its fold spell the name as a literal, since they
 * cannot consult an adapter. TD5 of the Codex sandbox design records why.
 */
export class RuntimeRegistry {
  readonly #adapters = new Map<string, RuntimeAdapter>();

  constructor(adapters: readonly RuntimeAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  /** Add an adapter, refusing a malformed or already registered name and a runtime with no effort level. */
  register(adapter: RuntimeAdapter): this {
    if (!namePattern.test(adapter.name)) throw new Error(`Runtime name must be lowercase words joined by dashes: ${JSON.stringify(adapter.name)}`);
    if (this.#adapters.has(adapter.name)) throw new Error(`Runtime ${adapter.name} is already registered`);
    if (adapter.capabilities.effortLevels.length === 0) throw new Error(`Runtime ${adapter.name} declares no effort level`);
    this.#adapters.set(adapter.name, adapter);
    return this;
  }

  get(name: string): RuntimeAdapter {
    const adapter = this.#adapters.get(name);
    if (adapter === undefined) throw new UnknownRuntimeError(name, this.names());
    return adapter;
  }

  /** Registered names, sorted. */
  names(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}
