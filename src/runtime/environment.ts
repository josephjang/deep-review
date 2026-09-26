/**
 * Environment helpers that compare names case-insensitively on every
 * platform. Windows treats `Path` and `PATH` as one variable but a Node
 * environment object can hold both, and which one a child sees is then
 * unspecified; so a pin removes every spelling before it sets its own.
 */

/** Every spelling of `name` present in the environment, with its value. */
export function spellingsOf(environment: NodeJS.ProcessEnv, name: string): [string, string | undefined][] {
  const wanted = name.toUpperCase();
  return Object.entries(environment).filter(([key]) => key.toUpperCase() === wanted);
}

/** A copy of the environment without any spelling of the given names. */
export function withoutVariables(environment: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const removed = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !removed.has(key.toUpperCase())));
}

/** A copy of the environment with each value set under exactly the given spelling, every other spelling removed. */
export function pinVariables(environment: NodeJS.ProcessEnv, values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...withoutVariables(environment, Object.keys(values)), ...values };
}
