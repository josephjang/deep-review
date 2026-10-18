// A stand-in for a repository's check command: `node fake-check.mjs <kind>`,
// steered by the JSON file FAKE_CHECKS names, which maps a kind to a rule,
// or to a list of rules consumed one per run of that kind, the last one
// repeating. A kind the file does not name passes. A rule is:
//   "pass"                          exit 0
//   "fail"                          print a failure and exit 1
//   "hang"                          start a grandchild, write its pid beside the file, and never exit
//   { "write": { "<path>": "<text>" } }   write the files (relative to the worktree), then pass
//   { "replace": { "<path>": { "from": "<text>", "to": "<text>" } } }   rewrite each file that holds `from` with `to` in its place, as a formatter does, then pass
//   { "failIfContains": { "<path>": "<text>" } }   fail while a file holds the text, pass otherwise
// Every run appends `<kind>` to `<FAKE_CHECKS>.runs`, so a test sees what ran and in what order.
// With FAKE_START_DIR set, every run also appends `check <kind>` to its
// `starts` file, and the run FAKE_HOLD names holds after the writes of its
// rule, before it exits (see holdIfNamed).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const kind = process.argv[2] ?? 'unknown';
const control = process.env.FAKE_CHECKS;
const config = control !== undefined && existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : {};
if (control !== undefined) appendFileSync(`${control}.runs`, `${kind}\n`);

/**
 * When FAKE_START_DIR is set, record this start as `check <kind>` and, when
 * FAKE_HOLD names this start as `<name>#<n>`, the n-th start of the name,
 * hold: start a grandchild, write both pids to `started.json` in the
 * directory, and wait for its `release` file, with the grandchild waiting
 * for it too. The contract test of resumable runs (test/helpers/
 * resume-contract.ts) stops the engine while such a child holds. The same
 * protocol is in fake-runtime.ts for a worker; this file imports nothing
 * of the TypeScript helpers, so a check starts as fast as a real one.
 */
function holdIfNamed(name) {
  const directory = process.env.FAKE_START_DIR;
  if (directory === undefined) return;
  appendFileSync(join(directory, 'starts'), `${name}\n`);
  const hold = process.env.FAKE_HOLD;
  const at = hold === undefined ? -1 : hold.lastIndexOf('#');
  if (at === -1 || hold.slice(0, at) !== name) return;
  const counter = join(directory, 'held.count');
  const count = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeFileSync(counter, String(count));
  if (count !== Number(hold.slice(at + 1))) return;
  const release = join(directory, 'release');
  const wait = `const { existsSync } = require('node:fs'); setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`;
  const grandchild = spawn(process.execPath, ['-e', wait], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  const temporary = join(directory, `started.${String(process.pid)}.tmp`);
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  renameSync(temporary, join(directory, 'started.json'));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(pause, 0, 0, 50);
}

let rule = config[kind] ?? 'pass';
if (Array.isArray(rule)) {
  const counter = `${control}.${kind}.count`;
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(count + 1));
  rule = rule[Math.min(count, rule.length - 1)];
}

if (rule === 'pass') {
  holdIfNamed(`check ${kind}`);
  process.exit(0);
}
if (rule === 'fail') {
  holdIfNamed(`check ${kind}`);
  process.stdout.write(`${kind}: 1 failing\n`);
  process.stderr.write(`${kind} failed\n`);
  process.exit(1);
}
if (rule === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  writeFileSync(`${control}.${kind}.pid`, String(child.pid));
  setInterval(() => {}, 1000);
} else if (typeof rule === 'object' && rule !== null && 'write' in rule) {
  for (const [path, text] of Object.entries(rule.write)) {
    const file = join(process.cwd(), ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  holdIfNamed(`check ${kind}`);
  process.exit(0);
} else if (typeof rule === 'object' && rule !== null && 'replace' in rule) {
  for (const [path, { from, to }] of Object.entries(rule.replace)) {
    const file = join(process.cwd(), ...path.split('/'));
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(from)) writeFileSync(file, text.replaceAll(from, to));
  }
  holdIfNamed(`check ${kind}`);
  process.exit(0);
} else if (typeof rule === 'object' && rule !== null && 'failIfContains' in rule) {
  holdIfNamed(`check ${kind}`);
  const broken = Object.entries(rule.failIfContains).filter(([path, text]) => {
    const file = join(process.cwd(), ...path.split('/'));
    return existsSync(file) && readFileSync(file, 'utf8').includes(text);
  });
  if (broken.length > 0) {
    process.stdout.write(`${kind}: ${broken.map(([path]) => path).join(', ')} is broken\n`);
    process.exit(1);
  }
  process.exit(0);
} else {
  process.stderr.write(`fake-check: unknown rule ${JSON.stringify(rule)}\n`);
  process.exit(2);
}
