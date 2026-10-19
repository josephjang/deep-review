import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { bundleEngine, engineBundleName, engineDirectoryName, engineRolesDirectoryName, repositoryEngine } from '../../src/build/bundle.ts';
import { engineIdentity, engineRolesRoot, engineSidecarName, engineVersion, readEngineSidecar } from '../../src/engine.ts';
import { assembleRoles, repositoryRolesRoot } from '../../src/roles/assemble.ts';
import { readPolicy } from '../../src/review/policy.ts';
import { guardResultFile } from '../../src/runtime/process.ts';
import { repositoryWith } from '../helpers/repository.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('bundleEngine', { timeout: 300_000 }, () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-bundle-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('writes the bundle, a sidecar with its hash and version, and a copy of roles/, the same bytes twice', async () => {
    const options = repositoryEngine(repositoryRoot);
    assert.equal(options.version, engineVersion());
    const first = join(sandbox, 'first');
    const sidecar = await bundleEngine(first, options);
    const engine = join(first, engineDirectoryName);
    assert.deepEqual(readdirSync(engine).sort(), [engineSidecarName, engineBundleName, engineRolesDirectoryName].sort());
    const bytes = readFileSync(join(engine, engineBundleName));
    assert.equal(sidecar.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(JSON.parse(readFileSync(join(engine, engineSidecarName), 'utf8')), sidecar);
    assert.deepEqual(readEngineSidecar(engine), sidecar);
    assert.equal(engineIdentity(engine), `${engineVersion()}+${sidecar.sha256.slice(0, 12)}`);
    assert.equal(engineRolesRoot(engine), join(engine, engineRolesDirectoryName));
    // The roles beside the bundle are the repository's, assembled to the same prompts, with the policy.
    assert.deepEqual(assembleRoles(join(engine, engineRolesDirectoryName)), assembleRoles(repositoryRolesRoot()));
    assert.deepEqual(readPolicy(join(engine, engineRolesDirectoryName)), readPolicy(repositoryRolesRoot()));
    // Zod is bundled and Node's builtins are not; nothing points back at the sources.
    const text = bytes.toString('utf8');
    assert.ok(!/from\s+["']zod["']/.test(text), 'zod is bundled, not imported');
    assert.ok(/from\s+["']node:sqlite["']/.test(text), 'builtins stay external');
    assert.ok(!text.includes(repositoryRoot.replaceAll('\\', '/')), 'no absolute path of this checkout is in the bundle');
    assert.ok(text.includes('import.meta.dirname'), 'the sidecar is found beside the running module');
    const second = join(sandbox, 'second');
    await bundleEngine(second, options);
    assert.deepEqual(readFileSync(join(second, engineDirectoryName, engineBundleName)), bytes, 'building twice gives identical bytes');
  });

  it('runs as the command: status in a fresh repository reports no run, and the usage prints', async () => {
    await bundleEngine(sandbox, repositoryEngine(repositoryRoot));
    const main = join(sandbox, engineDirectoryName, engineBundleName);
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': 'a\n' });
    const status = spawnSync(process.execPath, [main, 'status'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'No run: this repository has no checkpoint yet.\n');
    const help = spawnSync(process.execPath, [main, '--help'], { cwd: repo, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage:/);
    const usage = spawnSync(process.execPath, [main, 'review'], { cwd: repo, encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /--runtime claude\|codex is required/);
    assert.equal(existsSync(join(repo, '.git', 'deep-review-checkpoint')), false);
  });

  // R8 of resumable runs: the bundle's runProcess starts the bundle itself as the guard, so the bundle must run one.
  it('runs as the guard of a child: the child runs, and the result file says how it ended', async () => {
    await bundleEngine(sandbox, repositoryEngine(repositoryRoot));
    const main = join(sandbox, engineDirectoryName, engineBundleName);
    writeFileSync(join(sandbox, 'stdin'), 'input');
    const request = join(sandbox, 'stdout.guard.json');
    writeFileSync(request, JSON.stringify({ executable: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync(0, "utf8")); process.exit(5)'], cwd: sandbox, stdinFile: join(sandbox, 'stdin'), verbatimArguments: false }));
    const stdout = openSync(join(sandbox, 'stdout'), 'wx');
    const guard = spawn(process.execPath, [main, 'guard', request], { stdio: ['pipe', stdout, 'ignore'], windowsHide: true, detached: true });
    closeSync(stdout);
    const end = await new Promise((done) => guard.once('close', (code, signal) => done({ code, signal })));
    // On POSIX the guard ends with its process group once the result is written (R8 of resumable runs).
    assert.deepEqual(end, process.platform === 'win32' ? { code: 5, signal: null } : { code: null, signal: 'SIGKILL' });
    assert.equal(readFileSync(join(sandbox, 'stdout'), 'utf8'), 'input');
    assert.deepEqual(JSON.parse(readFileSync(guardResultFile(request), 'utf8')), { termination: 'exited', exitCode: 5, signal: null });
  });

  it('refuses a missing entry or roles root before writing anything', async () => {
    const options = repositoryEngine(repositoryRoot);
    await assert.rejects(bundleEngine(sandbox, { ...options, entry: join(sandbox, 'absent.ts') }), /Engine entry does not exist/);
    await assert.rejects(bundleEngine(sandbox, { ...options, rolesRoot: join(sandbox, 'absent') }), /Roles root does not exist/);
    assert.deepEqual(readdirSync(sandbox), []);
  });
});
