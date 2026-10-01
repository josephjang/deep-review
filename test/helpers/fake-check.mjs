// A stand-in for a repository's check command: `node fake-check.mjs <kind>`,
// steered by the JSON file FAKE_CHECKS names, which maps a kind to a rule,
// or to a list of rules consumed one per run of that kind, the last one
// repeating. A kind the file does not name passes. A rule is:
//   "pass"                          exit 0
//   "fail"                          print a failure and exit 1
//   "hang"                          start a grandchild, write its pid beside the file, and never exit
//   { "write": { "<path>": "<text>" } }   write the files (relative to the worktree), then pass
//   { "failIfContains": { "<path>": "<text>" } }   fail while a file holds the text, pass otherwise
// Every run appends `<kind>` to `<FAKE_CHECKS>.runs`, so a test sees what ran and in what order.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const kind = process.argv[2] ?? 'unknown';
const control = process.env.FAKE_CHECKS;
const config = control !== undefined && existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : {};
if (control !== undefined) appendFileSync(`${control}.runs`, `${kind}\n`);

let rule = config[kind] ?? 'pass';
if (Array.isArray(rule)) {
  const counter = `${control}.${kind}.count`;
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(count + 1));
  rule = rule[Math.min(count, rule.length - 1)];
}

if (rule === 'pass') process.exit(0);
if (rule === 'fail') {
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
  process.exit(0);
} else if (typeof rule === 'object' && rule !== null && 'failIfContains' in rule) {
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
