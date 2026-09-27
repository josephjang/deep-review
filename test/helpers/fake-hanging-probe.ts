// A stand-in for a runtime CLI that is a wrapper around another process and
// hangs on every invocation, including the preflight's version probe. It
// starts a grandchild that never exits, writes the grandchild's pid to the
// file named by FAKE_HANG, and never exits either.
//
// The grandchild is as hard to end as a real one can be: it ignores
// SIGTERM, the default signal of a plain timeout kill, and it inherits the
// wrapper's stdout and stderr, so while it lives the probe's output pipes
// never close. On Windows it is detached, for the reason given at
// hangWithGrandchild in fake-runtime.ts: otherwise libuv's job object would
// end it with the wrapper, and the test could not tell a tree kill from a
// root kill.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.env.FAKE_HANG;
if (pidFile === undefined) throw new Error('fake-hanging-probe needs FAKE_HANG');
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
  detached: process.platform === 'win32',
});
writeFileSync(pidFile, String(grandchild.pid));
setInterval(() => {}, 1000);
