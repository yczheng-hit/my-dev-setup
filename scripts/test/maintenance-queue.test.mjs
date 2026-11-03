import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLaunchHook, restoreLaunchHook, readLaunchHook, queuePrepared, readQueued, queueRoot } from '../maintenance-queue.mjs';
import { inspectInstallation, PI_PACKAGE } from '../maintenance-policy.mjs';
import { activateQueued, runningPi } from '../maintain.mjs';
import { isSessionLaunch } from '../maintenance-launch.mjs';
const sourceRepo = fileURLToPath(new URL('../..', import.meta.url));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-queue-'))), repo = path.join(root, 'repo'), agentDir = path.join(root, 'agent');
  const put = (relative, bytes = '') => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  fs.mkdirSync(repo); fs.mkdirSync(agentDir);
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  put('repo/pi/settings.json', JSON.stringify({ packages: [] }));
  const host = path.join(root, 'prefix/lib/node_modules', PI_PACKAGE);
  put(path.relative(root, path.join(host, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.5.0' }));
  const real = put(path.relative(root, path.join(host, 'dist/cli.mjs')), 'console.log(JSON.stringify({args:process.argv.slice(2),pid:process.pid,version:"1.5.0"}));');
  fs.mkdirSync(path.join(root, 'prefix/bin'), { recursive: true });
  const bin = path.join(root, 'prefix/bin/pi'); fs.symlinkSync(real, bin);
  const manager = put('prefix/bin/npm', '#!/bin/sh\nexit 0'); fs.chmodSync(manager, 0o755);
  fs.symlinkSync(process.execPath, path.join(root, 'prefix/bin/node'));
  const installation = { kind: 'npm', bin, real, host, version: '1.5.0', node: path.join(root, 'prefix/bin/node'), manager, prefix: path.join(root, 'prefix') };
  const stage = path.join(root, 'stage'); put('stage/host/package.json', '{}'); put('stage/agent/settings.json', '{}');
  put('stage/agent/npm/tool.js', 'old candidate');
  fs.symlinkSync('tool.js', path.join(stage, 'agent/npm/link.js'));
  const lock = { host: { version: '1.6.0' }, remotes: [] };
  return { root, repo, agentDir, put, installation, lock, prepared: { stage, stageAgent: path.join(stage, 'agent') },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('queue preserves running host, config and original installer; candidate survives temp cleanup', () => {
  const f = fixture(); try {
    const before = fs.readFileSync(f.installation.real);
    f.put('agent/settings.json', '{"sentinel":true}');
    const artifact = queuePrepared(f, f.lock, f.prepared, f.installation);
    fs.rmSync(f.prepared.stage, { recursive: true });
    assert.deepEqual(fs.readFileSync(f.installation.real), before);
    assert.equal(fs.readFileSync(path.join(f.agentDir, 'settings.json'), 'utf8'), '{"sentinel":true}');
    assert.equal(readQueued(f.agentDir).lock.host.version, '1.6.0');
    assert.equal(fs.readlinkSync(path.join(artifact.stage, 'agent/npm/link.js')), 'tool.js');
    assert.equal(fs.statSync(artifact.stage).mode & 0o777, 0o700);
    const detected = inspectInstallation({ bin: f.installation.bin, env: { PATH: '' } });
    assert.equal(detected.kind, 'npm'); assert.equal(detected.prefix, f.installation.prefix); assert.equal(detected.version, '1.5.0');
    const status = JSON.parse(fs.readFileSync(path.join(queueRoot(f.agentDir), 'status.json')));
    assert.equal(status.status, 'queued'); assert.equal(status.currentProcessUnchanged, true);
    const hook = readLaunchHook(f.installation.bin); assert.ok(hook);
    installLaunchHook(f.repo, f.agentDir, detected); assert.deepEqual(readLaunchHook(f.installation.bin), hook);
    restoreLaunchHook(f.installation.bin);
    assert.equal(fs.realpathSync(f.installation.bin), f.installation.real);
  } finally { f.close(); }
});
test('candidate/repository mutation refuses activation and preserves pending state', () => {
  for (const kind of ['candidate', 'source']) {
    const f = fixture(); try {
      const artifact = queuePrepared(f, f.lock, f.prepared, f.installation);
      if (kind === 'candidate') fs.writeFileSync(path.join(artifact.stage, 'agent/npm/tool.js'), 'modified');
      else f.put('repo/pi/settings.json', '{"changed":true}');
      assert.throws(() => readQueued(f.agentDir), /changed/);
      let applied = false;
      activateQueued(f, { stopped() {}, detect: () => f.installation, command() {}, apply() { applied = true; } });
      assert.equal(applied, false); assert.ok(fs.existsSync(path.join(queueRoot(f.agentDir), 'pending.json')));
    } finally { f.close(); }
  }
});
test('other running Pi postpones activation without touching candidate or invoking installers', () => {
  const f = fixture(); try {
    queuePrepared(f, f.lock, f.prepared, f.installation);
    let calls = 0;
    activateQueued(f, { stopped() { throw Object.assign(new Error('running'), { code: 'PI_RUNNING' }); }, command() { calls++; }, apply() { calls++; } });
    assert.equal(calls, 0); assert.ok(readQueued(f.agentDir));
    assert.equal(runningPi({ output: '123 pi pi', currentPid: 456 }), true);
    assert.equal(runningPi({ output: '456 node node script.mjs', currentPid: 456 }), false);
  } finally { f.close(); }
});
test('safe startup consumes exact validated candidate and marks startup mode', () => {
  const f = fixture(); try {
    const artifact = queuePrepared(f, f.lock, f.prepared, f.installation); const calls = [];
    activateQueued(f, { stopped() {}, detect: () => f.installation, command(...args) { calls.push(args); },
      apply(options, lock, prepared) { calls.push([options, lock, prepared]); } });
    assert.equal(calls.length, 2); assert.equal(calls[1][0].startup, true);
    assert.deepEqual(calls[1][1], f.lock); assert.equal(calls[1][2].stage, artifact.stage);
    assert.equal(fs.existsSync(path.join(queueRoot(f.agentDir), 'pending.json')), false);
  } finally { f.close(); }
});
test('activation failure keeps pending candidate and is not misreported as success', () => {
  const f = fixture(); try {
    queuePrepared(f, f.lock, f.prepared, f.installation);
    assert.throws(() => activateQueued(f, { stopped() {}, detect: () => f.installation, command() {}, apply() {
      fs.writeFileSync(path.join(queueRoot(f.agentDir), 'status.json'), JSON.stringify({ status: 'failed' })); throw new Error('install failed');
    } }), /install failed/);
    assert.ok(fs.existsSync(path.join(queueRoot(f.agentDir), 'pending.json')));
  } finally { f.close(); }
});
test('launcher preserves arguments/PID and version/help do not activate', () => {
  const f = fixture(); try {
    fs.mkdirSync(path.join(f.repo, 'scripts')); fs.copyFileSync(path.join(sourceRepo, 'scripts/maintenance-launch.mjs'), path.join(f.repo, 'scripts/maintenance-launch.mjs'));
    fs.copyFileSync(path.join(sourceRepo, 'scripts/maintenance-queue.mjs'), path.join(f.repo, 'scripts/maintenance-queue.mjs'));
    installLaunchHook(f.repo, f.agentDir, f.installation);
    const result = spawnSync(f.installation.bin, ['--version', 'quote" and spaces', '中文'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout); assert.deepEqual(output.args, ['--version', 'quote" and spaces', '中文']);
    assert.equal(output.pid, result.pid);
    for (const args of [['--version'], ['--help'], ['update', '--self'], ['auth', 'check'], ['--export', 'fixture']]) assert.equal(isSessionLaunch(args), false);
    assert.equal(isSessionLaunch(['--continue']), true);
  } finally { f.close(); }
});
test('modified/unowned launcher and symlink state roots are preserved and refused', () => {
  const f = fixture(); try {
    installLaunchHook(f.repo, f.agentDir, f.installation);
    fs.appendFileSync(f.installation.bin, '\n# local modification\n');
    assert.throws(() => restoreLaunchHook(f.installation.bin), /Invalid maintenance startup hook/);
  } finally { f.close(); }
});

test('real startup wrapper activates before exec and postpones unchanged when another runtime exists', () => {
  for (const activates of [false, true]) {
    const f = fixture(); try {
      fs.mkdirSync(path.join(f.repo, 'scripts'));
      for (const file of ['maintenance-launch.mjs', 'maintenance-queue.mjs']) fs.copyFileSync(path.join(sourceRepo, 'scripts', file), path.join(f.repo, 'scripts', file));
      // A synthetic pre-start activator; never executes or modifies the real Pi installation.
      f.put('repo/scripts/maintain.mjs', `import fs from 'node:fs'; import {restoreLaunchHook} from './maintenance-queue.mjs';\n${activates ? `restoreLaunchHook(${JSON.stringify(f.installation.bin)});fs.writeFileSync(${JSON.stringify(f.installation.real)},'console.log(JSON.stringify({args:process.argv.slice(2),pid:process.pid,version:"1.6.0"}));');fs.unlinkSync(${JSON.stringify(path.join(queueRoot(f.agentDir), 'pending.json'))});` : ''}`);
      queuePrepared(f, f.lock, f.prepared, f.installation);
      const result = spawnSync(f.installation.bin, ['--continue', 'keep space'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout); assert.equal(output.version, activates ? '1.6.0' : '1.5.0');
      assert.equal(output.pid, result.pid); assert.deepEqual(output.args, ['--continue', 'keep space']);
      assert.equal(fs.existsSync(path.join(queueRoot(f.agentDir), 'pending.json')), !activates);
    } finally { f.close(); }
  }
});
test('startup install failure does not launch a possibly mixed host', () => {
  const f = fixture(); try {
    fs.mkdirSync(path.join(f.repo, 'scripts'));
    for (const file of ['maintenance-launch.mjs', 'maintenance-queue.mjs']) fs.copyFileSync(path.join(sourceRepo, 'scripts', file), path.join(f.repo, 'scripts', file));
    f.put('repo/scripts/maintain.mjs', 'process.exit(1);');
    queuePrepared(f, f.lock, f.prepared, f.installation);
    const result = spawnSync(f.installation.bin, ['--continue'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /no session was started/);
    assert.ok(readQueued(f.agentDir));
  } finally { f.close(); }
});
test('regular original launchers round-trip and symlink state roots fail closed', () => {
  const f = fixture(); try {
    fs.unlinkSync(f.installation.bin); fs.writeFileSync(f.installation.bin, '#!/bin/sh\nprintf original\n', { mode: 0o755 });
    f.installation.real = f.installation.bin;
    installLaunchHook(f.repo, f.agentDir, f.installation);
    const saved = readLaunchHook(f.installation.bin).savedFile;
    assert.equal(fs.readFileSync(saved, 'utf8'), '#!/bin/sh\nprintf original\n');
    restoreLaunchHook(f.installation.bin);
    assert.equal(fs.readFileSync(f.installation.bin, 'utf8'), '#!/bin/sh\nprintf original\n');
    const target = path.join(f.root, 'external-state'); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(f.agentDir, 'state'));
    assert.throws(() => queuePrepared(f, f.lock, f.prepared, f.installation), /symlink/);
  } finally { f.close(); }
});

test('installation drift after preparation does not run installers and keeps candidate queued', () => {
  const f = fixture(); try {
    queuePrepared(f, f.lock, f.prepared, f.installation); let calls = 0;
    activateQueued(f, { stopped() {}, detect: () => ({ ...f.installation, prefix: '/another-node' }), command() { calls++; }, apply() { calls++; } });
    assert.equal(calls, 0); assert.ok(readQueued(f.agentDir));
  } finally { f.close(); }
});
test('startup lock serializes new launches and a prior partial install is not auto-retried', () => {
  for (const kind of ['lock', 'failed']) {
    const f = fixture(); try {
      fs.mkdirSync(path.join(f.repo, 'scripts'));
      for (const file of ['maintenance-launch.mjs', 'maintenance-queue.mjs']) fs.copyFileSync(path.join(sourceRepo, 'scripts', file), path.join(f.repo, 'scripts', file));
      f.put('repo/scripts/maintain.mjs', 'throw new Error("must not retry");');
      queuePrepared(f, f.lock, f.prepared, f.installation);
      fs.writeFileSync(path.join(queueRoot(f.agentDir), kind === 'lock' ? 'startup.lock' : 'status.json'), kind === 'lock' ? 'fixture' : '{"status":"failed"}');
      const result = spawnSync(f.installation.bin, ['--continue'], { encoding: 'utf8' });
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.match(result.stderr, kind === 'lock' ? /Another Pi startup/ : /Previous activation failed/);
      assert.doesNotMatch(result.stderr, /must not retry/);
      assert.ok(readQueued(f.agentDir));
    } finally { f.close(); }
  }
});
