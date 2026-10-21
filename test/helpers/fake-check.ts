// A stand-in for a repository's check command: `node fake-check.ts <kind>`,
// steered by the JSON file FAKE_CHECKS names, which maps a kind to a rule,
// or to a list of rules consumed one per run of that kind, the last one
// repeating. A kind the file does not name passes. A rule is:
//   "pass"                          exit 0
//   "fail"                          print a failure and exit 1
//   "hang"                          start a grandchild, write its pid beside the file, and never exit
//   { "write": { "<path>": "<text>" } }   write the files (relative to the worktree), then pass, with "hang": true never exit, or with "exit": <code> exit so
//   { "exit": <code> }              exit with the code, as a check a kill ended with a kill mark does
//   { "replace": { "<path>": { "from": "<text>", "to": "<text>" } } }   rewrite each file that holds `from` with `to` in its place, as a formatter does, then pass
//   { "failIfContains": { "<path>": "<text>" } }   fail while a file holds the text, pass otherwise
// Every run appends `<kind>` to `<FAKE_CHECKS>.runs`, so a test sees what ran and in what order.
// With FAKE_START_DIR set, every run also appends `check <kind>` to its
// `starts` file, and the run FAKE_HOLD names holds after the writes of its
// rule, before it exits (see holdIfNamed).
// Started as a script it runs in a process of its own, as a real check
// does; checkFake runs it on any host (fake-host.ts). It imports nothing of
// the other helpers but fake-host.ts, so a check starts as fast as a real one.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processHost, waitForFile, type FakeHost } from './fake-host.ts';

type Rule =
  | 'pass'
  | 'fail'
  | 'hang'
  | { readonly write: Readonly<Record<string, string>>; readonly hang?: boolean; readonly exit?: number }
  | { readonly exit: number }
  | { readonly replace: Readonly<Record<string, { readonly from: string; readonly to: string }>> }
  | { readonly failIfContains: Readonly<Record<string, string>> };

/** The rules of the FAKE_CHECKS file in `environment` by kind, none when it names no file or no file is there. */
function rulesOf(environment: NodeJS.ProcessEnv): Readonly<Record<string, Rule | readonly Rule[]>> {
  const control = environment.FAKE_CHECKS;
  return control !== undefined && existsSync(control) ? (JSON.parse(readFileSync(control, 'utf8')) as Record<string, Rule | readonly Rule[]>) : {};
}

/**
 * Whether a check of `kind` may start a grandchild under `environment`: a
 * `hang` rule anywhere in the kind's rules, or FAKE_START_DIR, under which
 * a run FAKE_HOLD names holds with one. Only a check in a process of its
 * own has a tree for the engine to kill (see FakeHost.startGrandchild).
 */
export function checkStartsGrandchild(environment: NodeJS.ProcessEnv, kind: string): boolean {
  if (environment.FAKE_START_DIR !== undefined) return true;
  const rule = rulesOf(environment)[kind];
  return rule === 'hang' || (Array.isArray(rule) && rule.includes('hang'));
}

/**
 * When FAKE_START_DIR is set, record this start as `check <kind>` and, when
 * FAKE_HOLD names this start as `<name>#<n>`, the n-th start of the name,
 * hold: start a grandchild, write both pids to `started.json` in the
 * directory, and wait for its `release` file, with the grandchild waiting
 * for it too. The contract test of resumable runs (test/helpers/
 * resume-contract.ts) stops the engine while such a child holds. The same
 * protocol is in fake-runtime.ts for a worker.
 */
async function holdIfNamed(host: FakeHost, name: string): Promise<void> {
  const directory = host.environment.FAKE_START_DIR;
  if (directory === undefined) return;
  appendFileSync(join(directory, 'starts'), `${name}\n`);
  const hold = host.environment.FAKE_HOLD;
  const at = hold === undefined ? -1 : hold.lastIndexOf('#');
  if (hold === undefined || at === -1 || hold.slice(0, at) !== name) return;
  const counter = join(directory, 'held.count');
  const count = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeFileSync(counter, String(count));
  if (count !== Number(hold.slice(at + 1))) return;
  const release = join(directory, 'release');
  const grandchild = host.startGrandchild(`const { existsSync } = require('node:fs'); setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`);
  const temporary = join(directory, `started.${host.id}.tmp`);
  writeFileSync(temporary, JSON.stringify({ pid: host.pid, grandchild }));
  renameSync(temporary, join(directory, 'started.json'));
  await waitForFile(host, release);
}

/** Run the check of the kind `host.args` names, as its rule says, and give the exit code. */
export async function checkFake(host: FakeHost): Promise<number> {
  const kind = host.args[0] ?? 'unknown';
  const control = host.environment.FAKE_CHECKS;
  if (control !== undefined) appendFileSync(`${control}.runs`, `${kind}\n`);
  const given = rulesOf(host.environment)[kind] ?? 'pass';
  let rule: Rule;
  if (Array.isArray(given)) {
    const counter = `${control!}.${kind}.count`;
    const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(count + 1));
    rule = given[Math.min(count, given.length - 1)]!;
  } else {
    rule = given as Rule;
  }
  const file = (path: string): string => join(host.cwd, ...path.split('/'));

  if (rule === 'pass') {
    await holdIfNamed(host, `check ${kind}`);
    return 0;
  }
  if (rule === 'fail') {
    await holdIfNamed(host, `check ${kind}`);
    await host.write('stdout', `${kind}: 1 failing\n`);
    await host.write('stderr', `${kind} failed\n`);
    return 1;
  }
  if (rule === 'hang') {
    writeFileSync(`${control!}.${kind}.pid`, String(host.startGrandchild('setInterval(() => {}, 1000)')));
    return host.hang();
  }
  // Another string, or no object at all, is an unknown rule; `in` would throw on it.
  if (typeof rule !== 'object' || rule === null) {
    await host.write('stderr', `fake-check: unknown rule ${JSON.stringify(rule)}\n`);
    return 2;
  }
  if ('write' in rule) {
    for (const [path, text] of Object.entries(rule.write)) {
      mkdirSync(join(file(path), '..'), { recursive: true });
      writeFileSync(file(path), text);
    }
    await holdIfNamed(host, `check ${kind}`);
    if (rule.hang === true) return host.hang();
    return rule.exit ?? 0;
  }
  if ('exit' in rule) {
    await holdIfNamed(host, `check ${kind}`);
    return rule.exit;
  }
  if ('replace' in rule) {
    for (const [path, { from, to }] of Object.entries(rule.replace)) {
      if (!existsSync(file(path))) continue;
      const text = readFileSync(file(path), 'utf8');
      if (text.includes(from)) writeFileSync(file(path), text.replaceAll(from, to));
    }
    await holdIfNamed(host, `check ${kind}`);
    return 0;
  }
  if ('failIfContains' in rule) {
    await holdIfNamed(host, `check ${kind}`);
    const broken = Object.entries(rule.failIfContains).filter(([path, text]) => existsSync(file(path)) && readFileSync(file(path), 'utf8').includes(text));
    if (broken.length === 0) return 0;
    await host.write('stdout', `${kind}: ${broken.map(([path]) => path).join(', ')} is broken\n`);
    return 1;
  }
  await host.write('stderr', `fake-check: unknown rule ${JSON.stringify(rule)}\n`);
  return 2;
}

// Exit at once, as a check does, whatever a grandchild it started still holds open.
if (import.meta.main) process.exit(await checkFake(processHost()));
