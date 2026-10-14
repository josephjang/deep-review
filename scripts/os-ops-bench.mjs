// A micro-benchmark of the operations the test suite does most, one at a
// time, to see what each costs on the machine it runs on: a process start
// (node and git), a git repository with one commit, a small file write with
// fsync, a SQLite transaction, and a loop of pure computation to calibrate
// the core. Prints one line per operation with the mean time of N runs,
// after a short warm-up. No dependencies beyond Node and git.
//   node scripts/os-ops-bench.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const results = [];
const candidates = [['os.tmpdir()', tmpdir()], ['RUNNER_TEMP', process.env.RUNNER_TEMP], ['cwd (workspace)', process.cwd()]].filter(([, dir]) => dir);
let root = mkdtempSync(join(tmpdir(), 'os-ops-bench-'));
function measure(name, runs, body, warmup = 2) {
  for (let i = 0; i < warmup; i++) body(i);
  const times = [];
  for (let i = 0; i < runs; i++) { const start = now(); body(i); times.push(now() - start); }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  results.push({ name, runs, mean, median: times[Math.floor(times.length / 2)], max: times.at(-1) });
}

measure('node -e 0 (process start)', 30, () => spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }));
measure('git --version (process start)', 30, () => spawnSync('git', ['--version'], { stdio: 'ignore' }));
for (const [label, base] of candidates) {
root = mkdtempSync(join(base, 'os-ops-bench-'));
const at = (name) => `${name} [${label}: ${base}]`;
measure(at('git init + add + commit of one file'), 15, (i) => {
  const repo = join(root, `repo-${i}-${Date.now()}`);
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@b' };
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { stdio: 'ignore', env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { stdio: 'ignore', env });
});
const bytes = Buffer.alloc(4096, 97);
measure(at('4 KB write + fsync + read + delete'), 100, (i) => {
  const path = join(root, `f-${i}.txt`);
  const fd = openSync(path, 'w'); writeSync(fd, bytes); fsyncSync(fd); closeSync(fd); readFileSync(path); unlinkSync(path);
});
const db = new DatabaseSync(join(root, 'bench.sqlite'));
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
measure(at('SQLite insert in its own transaction (synchronous)'), 100, (i) => { db.exec('BEGIN'); insert.run(`v${i}`); db.exec('COMMIT'); });
db.close();
rmSync(root, { recursive: true, force: true });
}
measure('sqrt loop, 2e6 iterations (computation)', 20, () => { let t = 0; for (let i = 0; i < 2e6; i++) t += Math.sqrt(i); return t; });

console.log(`os-ops-bench on ${platform()} ${release()}, ${cpus().length} logical cores (${cpus()[0]?.model.trim()}), node ${process.version}`);
console.log('operation | runs | mean ms | median ms | max ms');
for (const r of results) console.log(`${r.name} | ${r.runs} | ${r.mean.toFixed(2)} | ${r.median.toFixed(2)} | ${r.max.toFixed(2)}`);
