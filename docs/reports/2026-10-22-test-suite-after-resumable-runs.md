# Report: Test suite time after resumable runs

This report was written on 2026-10-22. The test suite became much slower after the merge of resumable runs (pull requests #62 and #64), and the question was why. The report records where the time went, the three changes that were made in answer, and what each one measured. It follows the report of 2026-10-14 (`2026-10-14-test-and-ci-time.md`), which measured the suite before resumable runs.

## Summary

The suite did not slow down with pull request #61, the change first suspected. It slowed down with resumable runs. On the Ubuntu runner, the `npm run check` step took 319 s on `main` before resumable runs (`97ecac0`) and 535 to 587 s after (`0bfa8e6`, `24ef1f1`). On the Windows runner it went from 850 s to about 1,430 s, and on macOS from 472 s to about 830 s.

Two things in resumable runs cost the time. The first is two new test files: the contract test of resumable runs, which stops a fix run as a real process at fixed points and runs it again, and the tests of a reopened fix pass. Together they were about 60% of the CPU added. The second is the guard: since resumable runs, every worker and every check starts under a guard process of its own (`node src/cli.ts guard`, see `src/runtime/guard.ts`), so the suite started 5,680 more Node processes per run. Files whose tests did not change also became 40 to 50% slower in CI, because they ran beside heavier files on the same few cores. Run alone, such a file took the same time before and after.

Three changes answer this. They were made on 2026-10-22, in this order:

1. A review sandbox copies its repository from a template that each test process makes once, instead of making it with eleven git calls.
2. The contract test of resumable runs moves out of `npm test` and `npm run check` to `npm run test:contract`, which CI runs as a job of its own.
3. The engine takes what runs a process, and what runs a preflight probe, as an option. The review sandbox gives runners that run the fake runtimes and the stand-in check inside the test's own process.

Measured on one Windows machine, alternating with `main`, the suite went from 331 and 420 s to 183 and 206 s, its Node CPU from about 2,130 s to about 507 s, and the Node processes it started from 23,015 to about 2,166. The contract test, now outside the suite, took 156 s and 321 s of Node CPU on its own. Its CI job runs in parallel with the check job.

## Data and method

The CI figures come from the logs of the `check` workflow, read with `gh run view --log`. The step time is the `npm run check` step of each job. Within a job, the per-suite times are the durations the `node:test` spec reporter prints for each top-level suite, summed with `top.mjs` and compared with `diff.mjs` (appendix). Files run three at a time on the hosted runners, so a suite's duration includes the time it waited for a core.

The local figures come from one Windows 11 machine with an AMD Ryzen 7 9800X3D (8 cores, 16 threads) and Node 26.10.0, with each command started from Git Bash. Each commit was checked out in a worktree of its own with its locked dependencies. A preload (`preload.mjs`, appendix) records, for every Node process the suite starts, its CPU time and the commands it spawned, and `sum.mjs` adds them up. The CPU figures count Node processes only. git and `cmd.exe` are counted as starts, not as CPU.

The runs of each comparison alternated. During the investigation another program on the machine ran a review of its own, and the machine was at about 80% CPU when the first runs started. During the final comparison, five to seven other Node processes were present and the machine was otherwise idle. Wall times moved by up to 27% between two runs of the same commit (331 and 420 s for `main`). The Node CPU and the process counts moved by 1% or less, so the report leans on them.

## Where the time went

### 1. Not pull request #61

| Commit | What it is | Ubuntu | macOS | Windows |
|---|---|---|---|---|
| `ec7e9e4` | `main` before #61 | 321 s | 479 s | 776 s |
| `97ecac0` | `main` after #60 and #61 | 319 s | 472 s | 850 s |
| `b1e5ec6` | the head of #62, resumable runs | 380 s | 723 s | 1,302 s |
| `17e9906` | the head of #64, the gate of resumable runs | 577 s | 927 s | 1,420 s |
| `0bfa8e6` | `main` after #62 | 587 s | 848 s | 1,430 s |

*Table 1: the `npm run check` step of each CI job, one run per commit.*

The Ubuntu job of `b1e5ec6` is likely a low draw. The earlier run of the same branch, at `4a4f127`, took 559 s on Ubuntu. That run failed, so it is not in the table. Locally, the gate added 4 to 10% to the wall time of the suite and 4 to 7% to its Node CPU (Table 2), not the 50% that Table 1 shows for Ubuntu between `b1e5ec6` and `17e9906`.

Locally, alternating:

| Commit | Wall | Node CPU | Node processes | git starts |
|---|---|---|---|---|
| `97ecac0`, before resumable runs | 221, 227 s | 1,109, 1,124 s | 11,250 | 21,744 |
| `b1e5ec6`, #62 | 374, 393 s | 2,013, 2,054 s | 22,289 | 29,120 |
| `17e9906`, #64 | 407, 413 s | 2,161, 2,141 s | 23,009 | 30,167 |

*Table 2: `npm test` at three commits, two runs each. Another program on the machine was running a review during these runs.*

### 2. Two new test files

`test/review/resume-contract.test.ts` took 380 s of Node CPU and `test/review/fix-reopen.test.ts` 176 s at `b1e5ec6`. That is about 556 s of the roughly 900 s added.

### 3. A guard for every child

Resumable runs start each worker and each check through a guard (R8 of resumable runs): `runProcess` in `src/runtime/process.ts` starts `node <engine> guard <request>`, and the guard starts the child, so the end of the child is recorded even when the engine dies. At `b1e5ec6` the suite started 5,680 guards, each about 50 ms of CPU, 285 s in all. Every review test pays this cost, not only the new ones. `test/review/fix-pass-claims.test.ts`, for instance, went from 80 to 101 s of CPU, and `test/review/commit.test.ts` from 68 to 85 s.

The guard is not the largest process count. Before every worker the engine runs the preflight (`src/runtime/preflight.ts`), which starts the runtime's CLI two times for Claude and four times for Codex to check its version and its flags. In the tests, those are the fake runtimes too. At `24ef1f1` the fake Claude CLI started 13,680 times for 991 s of CPU, most of them as probes.

### 4. Why unchanged files slowed down in CI

In CI, `test/scope/capture.test.ts` and `test/review/fix-pass-claims.test.ts` took 40 to 50% longer at `17e9906` than at `b1e5ec6`, though neither file changed. Run alone on the same machine, alternating, they took the same time at both commits: 27 and 28 s against 26 and 27 s for the first, 45 and 44 s against 42 and 44 s for the second. The files themselves did not slow down. In CI they ran beside heavier files on three cores (two on macOS), and they waited for a core.

## What changed

### 1. The sandbox repository from a template

A review sandbox (`ReviewSandbox` in `test/helpers/review-sandbox.ts`) is the temporary repository, roles and checkpoint that a review test runs in. Its repository took eleven git calls to make: `git init`, six `git config` calls, and two adds and commits. Now `createRepository` in `test/helpers/repository.ts` appends the settings to the config file `git init` wrote, in one write. `sandboxRepository` makes the sandbox repository once per test process and copies it to each sandbox, then refreshes the copy's index with one git call. On POSIX, a copy's files have other inodes and times than its index records, and the engine's first git command would otherwise rewrite the index during a test.

Measured: 4,194 fewer git starts per run (30,167 to 25,973). The wall time did not move beyond the noise locally (Table 3). The 2026-10-14 report measured a git start on the Windows runner at 19 times its cost on Ubuntu, so the change may show there. That is not measured yet.

### 2. The contract test as its own tier

The contract test is now `test/review/resumable-runs.contract.ts`, outside the `test/**/*.test.ts` glob of `npm test`. `npm run test:contract` runs it, and the `contract` job of `.github/workflows/check.yml` runs it on Ubuntu, Windows and macOS, beside the `check` job. Its marks of known failures differ by system (`test/helpers/resume-marks.ts`), so it runs on all three. `AGENTS.md` says when to run it locally: before a commit that changes how the engine stops, resumes, launches a child or appends to the ledger. `npm run resume-test`, which runs every point of the contract rather than the fixed set, is unchanged.

### 3. The fakes in the test's own process

The engine takes what runs a process as an option: `runProcess` on `ReviewOptions` (`src/review/controller.ts`), `RunWorkerOptions` (`src/runtime/launcher.ts`) and `CheckRequest` (`src/review/checks/run.ts`), and `runProbe` on `PreflightOptions` (`src/runtime/preflight.ts`). Each defaults to the real runner. The command line never sets them, so no behavior of the engine changes.

The fakes (`test/helpers/fake-claude.ts`, `fake-codex.ts`, `fake-check.ts`) no longer read `process`. Each takes a host (`test/helpers/fake-host.ts`) that gives its arguments, environment, working directory, stdin, a way to write stdout and stderr, and its waits. Started as a script, a fake gets a host over its own process, as before. The runners in `test/helpers/in-process-runner.ts` give it a host over the request the engine would have spawned, inside the test's own process. That costs no Node start, no guard, and on Windows no console host.

The runners take only what they recognize: `node` with a fake runtime's script, or the platform shell running exactly the stand-in check's command. They leave every other request to the real runner. They also leave a fake that may start a grandchild (`FAKE_HANG`, `FAKE_START_DIR`, or a check whose rules hang), since a test of a tree kill needs a real process tree. The fake's synchronous waits and spawns (`Atomics.wait`, `spawnSync` of a fixer's claim command) became asynchronous. In the test's process they would have stopped every other fake, and the engine, until they returned.

`test/in-process-runner.test.ts` runs each kind of fake behavior through both runners and requires the same termination, exit code, signal, stdout and stderr: an answer, an exit code, a huge stream, a thrown error, a timeout, each check rule, and each probe. On Windows it also checks a variable read by another spelling, which a child's environment finds without case.

What the in-process runner does not reproduce is listed at the top of the module. There is no guard and no child process, so the tests of either still use the real runner (`test/runtime/*`, the command-line tests, and the contract test). A command the fake itself runs, a fixer's claim or snapshot, runs to its end after a timeout, where the real runner's tree kill would end it too.

## Results

| Commit | Wall | Node CPU | Node processes | git starts | Tests |
|---|---|---|---|---|---|
| `24ef1f1`, `main` | 331, 420 s | 2,119, 2,141 s | 23,015 | 30,167 | 2,549 |
| `a9a69b5`, the template | 390, 388 s | 2,140, 2,125 s | 23,013 | 25,973 | 2,555 |
| `db2e651`, all three | 183, 206 s | 505, 510 s | 2,165, 2,167 | 22,582 | 2,533 |
| `db2e651`, `npm run test:contract` | 156 s | 321 s | 4,764 | 3,395 | 44 |

*Table 3: `npm test` at three commits, run in the order of the table two times, then the contract tier once. Each test passed in each run. The contract test is in `npm test` in the first two rows only.*

| Kind of process | Starts at `24ef1f1` | CPU | Starts at `db2e651` | CPU |
|---|---|---|---|---|
| Fake Claude CLI | 13,680 | 991 s | 1,007 | 68 s |
| Test file | 125 | 437 s | 126 | 293 s |
| Guard | 5,884 | 322 s | 411 | 21 s |
| Engine command line | 444 | 218 s | 286 | 99 s |
| Fake Codex CLI | 1,478 | 90 s | 204 | 11 s |
| Stand-in check | 1,309 | 49 s | 36 | 1 s |

*Table 4: the Node processes of one run of `npm test`, by what they run. At `db2e651` the remaining fakes, checks and guards are those of the runtime tests, the command-line tests and the fakes left to the real runner.*

The suite now spends most of its remaining time in git: 22,582 starts per run, which the levers here do not reach. Most come from the engine's own calls during the reviews the tests run.

The CI figures for these changes are not measured yet. The pull request that carries them is the measurement. Its jobs should be read with the spread of Table 1 in mind: one run per side is not enough.

## Decisions

Settled by the author on 2026-10-22.

1. **The contract test leaves `npm run check`.** `AGENTS.md` said that `npm run check` is what CI runs and must pass at every commit. It now says that the contract test is left out, when to run it, and that CI runs it as its own job. Carried out in `3eea8e0`.
2. **The engine takes a runner of a process and of a probe that only the tests replace.** The 2026-10-14 report listed under "Not a lever here" a lighter manifest of roles, because it is an engine option that exists for the tests alone. The runner is also an option that only the tests use, but it changes how a child starts, not what a review does: the same workers run with the same prompts, and their answers go through the same decoding and ledger. A note under that item of the 2026-10-14 report points here. Carried out in `db2e651`.
3. **The suite stays on `node:test`.** Jest and Vitest were considered. The cost is in the processes the tests start, which no runner removes. Both would also run the test code through their own transform, while the engine and the fakes run with Node's own type stripping. They would add dependencies too.
4. **No split of the tests into unit, integration and end-to-end directories.** The only tier that needs to run apart today is the contract test, which change 2 separates by its file name. The directories keep mirroring `src/`.

## Open questions

1. **The effect in CI**, the Windows job in particular, where a process start and a git start cost the most. The pull request's runs answer it.
2. **The index refresh of a copied sandbox on POSIX.** `test/repository.test.ts` checks that no file of a copy is stat-dirty. On Windows the copy keeps each file's write time and git compares no inode, so the test passes there with or without the refresh. It guards the refresh only on the Ubuntu and macOS runners, and no run there has yet shown it failing without the refresh.

## Appendix: measurement scripts

### preload.mjs

Load it into every Node process of a run with `NODE_OPTIONS=--import=<file URL of preload.mjs>` and `DR_PROF_LOG=<file>`. On Windows, write the path as a `file:///` URL.

```js
// Records, for every Node process the suite starts, its CPU time and the
// commands it spawned, as one JSON line appended to $DR_PROF_LOG at exit.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const log = process.env.DR_PROF_LOG;
if (log) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');
  if (!process.env.DR_TESTFILE) {
    const file = process.argv.slice(1).find((a) => /\.test\.ts$/.test(a));
    if (file) process.env.DR_TESTFILE = path.relative(process.cwd(), file).split(path.sep).join('/');
  }
  const spawns = {};
  const count = (cmd) => { const k = path.basename(String(cmd)).toLowerCase().replace(/\.exe$/, ''); spawns[k] = (spawns[k] ?? 0) + 1; };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    cp[name] = function (cmd, ...rest) { count(name === 'fork' ? 'node' : (name.startsWith('exec') && !name.startsWith('execFile') ? String(cmd).split(' ')[0] : cmd)); return original.call(this, cmd, ...rest); };
  }
  syncBuiltinESMExports();
  const start = Date.now();
  process.on('exit', () => {
    const u = process.cpuUsage();
    const role = process.argv.includes('--test') ? 'runner' : process.argv.slice(1).find((a) => /\.test\.ts$/.test(a)) ? 'testfile' : path.basename(process.argv[1] ?? '?') + (process.argv[2] === 'guard' ? ':guard' : '');
    try { fs.appendFileSync(log, JSON.stringify({ file: process.env.DR_TESTFILE ?? null, role, cpu: (u.user + u.system) / 1000, wall: Date.now() - start, spawns }) + '\n'); } catch {}
  });
}
```

### sum.mjs

`node sum.mjs <log> [<by-file.json>]` prints the number of processes, their CPU, the starts by command and the CPU by kind of process, and with a second argument writes the CPU by test file.

```js
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let cpu = 0; const spawns = {}; const byFile = {}; const byRole = {};
for (const l of lines) {
  cpu += l.cpu;
  for (const [k, v] of Object.entries(l.spawns)) spawns[k] = (spawns[k] ?? 0) + v;
  const f = l.file ?? '(none)'; byFile[f] ??= { cpu: 0, procs: 0, git: 0, node: 0 }; byFile[f].cpu += l.cpu; byFile[f].procs++; byFile[f].git += l.spawns.git ?? 0; byFile[f].node += (l.spawns.node ?? 0);
  byRole[l.role] ??= { n: 0, cpu: 0 }; byRole[l.role].n++; byRole[l.role].cpu += l.cpu;
}
console.log(JSON.stringify({ processes: lines.length, nodeCpuS: +(cpu / 1000).toFixed(1), spawns, byRole }, null, 0));
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(byFile));
```

### rounds.sh

Runs `npm test` at each commit in turn, `<rounds>` times, from worktrees under `<worktrees>` that each hold one commit with its dependencies installed, then the contract tier once at the last commit. Run it from Git Bash.

```sh
# rounds.sh <tools> <worktrees> <rounds...>
set -u
tools=$1; worktrees=$2; shift 2
for r in "$@"; do for c in 24ef1f1 a9a69b5 db2e651; do
  log="$tools/m-$c-$r.jsonl"; rm -f "$log"
  s=$(date +%s)
  (cd "$worktrees/$c" && DR_PROF_LOG="$log" NODE_OPTIONS="--import=file:///$tools/preload.mjs" npm test > "$tools/m-$c-$r.out" 2>&1); e=$?
  echo "round $r $c exit=$e wall=$(( $(date +%s)-s ))s" >> "$tools/rounds.txt"
done; done
s=$(date +%s)
(cd "$worktrees/db2e651" && DR_PROF_LOG="$tools/m-contract.jsonl" NODE_OPTIONS="--import=file:///$tools/preload.mjs" npm run test:contract > "$tools/m-contract.out" 2>&1); e=$?
echo "contract db2e651 exit=$e wall=$(( $(date +%s)-s ))s" >> "$tools/rounds.txt"
```

### top.mjs and diff.mjs

`node top.mjs <log> <ubuntu|macos|windows>` sums the durations of the top-level suites of one job of a `gh run view --log` dump. `node diff.mjs <a.json> <b.json>` lists the suites whose time changed most between two such sums.

```js
// top.mjs
import fs from 'node:fs';
const [file, job] = process.argv.slice(2);
const out = new Map();
let total = null, count = null;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith(`check (${job}`)) continue;
  const m = line.match(/Z (✔|✖|﹣) (.*) \(([\d.]+)(ms|s)\)\s*$/);
  if (m) { const ms = parseFloat(m[3]) * (m[4] === 's' ? 1000 : 1); out.set(m[2], (out.get(m[2]) ?? 0) + ms); }
  const d = line.match(/ℹ duration_ms ([\d.]+)/); if (d) total = +d[1];
  const t = line.match(/ℹ tests (\d+)/); if (t) count = +t[1];
}
console.log(JSON.stringify({ total, count, top: Object.fromEntries(out) }));
```

```js
// diff.mjs
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')).top);
const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
const rows = [...keys].map(k => [k, (a[k] ?? 0) / 1000, (b[k] ?? 0) / 1000]).map(([k, x, y]) => [k, x, y, y - x]);
rows.sort((p, q) => q[3] - p[3]);
let sa = 0, sb = 0; for (const r of rows) { sa += r[1]; sb += r[2]; }
console.log(`sum ${sa.toFixed(0)}s -> ${sb.toFixed(0)}s`);
for (const r of rows.slice(0, 25)) console.log(r[1].toFixed(1).padStart(7), r[2].toFixed(1).padStart(7), r[3].toFixed(1).padStart(7), r[0].slice(0, 110));
```
