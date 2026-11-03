// Exercise real activation orchestration with fake installers/setup and disposable targets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPrepared } from '../maintain.mjs';
const sourceRepo = fileURLToPath(new URL('../..', import.meta.url));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-apply-test-')));
  const repo = path.join(root, 'repo'), agentDir = path.join(root, 'agent'), stage = path.join(root, 'stage'), host = path.join(root, 'host');
  for (const dir of [repo, agentDir, stage, host]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(repo, 'pi')); fs.copyFileSync(path.join(sourceRepo, 'pi/settings.json'), path.join(repo, 'pi/settings.json'));
  fs.copyFileSync(path.join(sourceRepo, 'maintenance.json'), path.join(repo, 'maintenance.json'));
  const settings = JSON.parse(fs.readFileSync(path.join(repo, 'pi/settings.json')));
  const remotes = settings.packages.filter(entry => !(typeof entry === 'string' ? entry : entry.source).startsWith('repo:')).map(entry => {
    const source = typeof entry === 'string' ? entry : entry.source;
    if (source.startsWith('git:')) return { source, kind: 'remote-git', identity: 'github.com/panbergco/pi-cc-steer', resolved: `${source}@${'a'.repeat(40)}`, commit: 'a'.repeat(40) };
    const name = source.slice(4); return { source, kind: 'remote-npm', name, version: '9.9.9', integrity: 'sha512-fixture', resolved: `${source}@9.9.9` };
  });
  const lock = { host: { version: '1.5.0' }, remotes };
  const stageAgent = path.join(stage, 'agent');
  fs.mkdirSync(path.join(stageAgent, 'git/github.com/panbergco/pi-cc-steer'), { recursive: true });
  fs.writeFileSync(path.join(host, 'sentinel'), 'old host');
  fs.mkdirSync(path.join(agentDir, 'npm'), { recursive: true }); fs.writeFileSync(path.join(agentDir, 'npm/old'), 'old npm');
  const hashline = path.join(root, 'hashline'); fs.mkdirSync(hashline); fs.writeFileSync(path.join(hashline, 'hash-store.sqlite'), 'synthetic undo');
  const saved = process.env.PI_HASHLINE_DIR; process.env.PI_HASHLINE_DIR = hashline;
  let installed = false; const calls = [];
  const detect = () => ({ kind: 'npm', host, bin: path.join(root, 'bin/pi'), node: process.execPath, manager: path.join(root, 'bin/npm'), prefix: root, version: installed ? '1.5.0' : '1.4.0' });
  const command = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args.includes('--global')) { installed = true; return ''; }
    if (args[0] === '--version') return '1.5.0';
    if (args.includes('install') && args.includes('--prefix')) {
      const npm = args[args.indexOf('--prefix') + 1], packages = {};
      for (const item of remotes.filter(item => item.kind === 'remote-npm')) {
        const dir = path.join(npm, 'node_modules', item.name); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: item.name, version: item.version }));
        packages[`node_modules/${item.name}`] = { integrity: item.integrity };
      }
      fs.writeFileSync(path.join(npm, 'package-lock.json'), JSON.stringify({ packages }));
    }
    return '';
  };
  return { root, repo, agentDir, host, lock, prepared: { stage, stageAgent }, detect, command, calls,
    close() { if (saved === undefined) delete process.env.PI_HASHLINE_DIR; else process.env.PI_HASHLINE_DIR = saved; fs.rmSync(root, { recursive: true, force: true }); } };
}
test('activation uses original installer, backs up data, deploys exact settings and marks applied only at the end', () => {
  const f = fixture(); try {
    applyPrepared(f, f.lock, f.prepared, { detect: f.detect, command: f.command, stopped() {}, hasHerdr: () => true });
    const global = f.calls.find(call => call.args.includes('--global'));
    assert.equal(global.binary, f.detect().manager); assert.ok(global.args.includes('@earendil-works/pi-coding-agent@1.5.0'));
    const setup = f.calls.find(call => call.binary === '/bin/bash');
    assert.ok(setup.args.includes('--skip-tool-updates'));
    const settings = JSON.parse(fs.readFileSync(setup.options.env.MY_DEV_SETUP_SETTINGS));
    assert.deepEqual(settings.packages.find(entry => typeof entry === 'object'), { source: 'npm:pi-subagents@9.9.9', extensions: [] });
    assert.ok(settings.packages.includes('repo:packages/pi-scheduler'));
    const status = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'state/my-dev-setup/status.json')));
    assert.equal(status.status, 'applied'); assert.equal(fs.statSync(status.backup).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(status.backup, 'hashline/hash-store.sqlite'), 'utf8'), 'synthetic undo');
    assert.equal(fs.readFileSync(path.join(status.backup, 'npm/old'), 'utf8'), 'old npm');
    assert.equal(fs.readFileSync(path.join(status.backup, 'pi-before-update/sentinel'), 'utf8'), 'old host');
    assert.ok(!f.calls.some(call => call.args.includes('--extensions') || call.args.includes('--hard')));
  } finally { f.close(); }
});
test('installer failure leaves a failure receipt and never invokes setup or claims applied', () => {
  const f = fixture(); try {
    assert.throws(() => applyPrepared(f, f.lock, f.prepared, { detect: f.detect, stopped() {}, hasHerdr: () => true,
      command(binary, args, options) { if (args.includes('--global')) throw new Error('synthetic install failure'); return f.command(binary, args, options); },
    }), /Partial installation may exist/);
    const state = path.join(f.agentDir, 'state/my-dev-setup');
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'status.json'))).status, 'failed');
    const backup = fs.readdirSync(state).find(name => name.startsWith('backup-'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, backup, 'failure.json'))).status, 'failed');
    assert.ok(!f.calls.some(call => call.binary === '/bin/bash'));
    assert.equal(fs.existsSync(path.join(state, 'maintenance.lock')), false);
  } finally { f.close(); }
});

for (const scenario of ['running', 'missing-herdr', 'unknown-owner', 'nested-symlink', 'channel-drift', 'integrity', 'setup-failure']) {
  test(`activation fails closed: ${scenario}`, () => {
    const f = fixture(); try {
      const hooks = { detect: f.detect, command: f.command, stopped() {}, hasHerdr: () => true };
      let expected;
      if (scenario === 'running') { hooks.stopped = () => { throw new Error('Pi processes are running'); }; expected = /Pi processes/; }
      if (scenario === 'missing-herdr') { hooks.hasHerdr = () => false; expected = /Install Herdr/; }
      if (scenario === 'unknown-owner') { hooks.detect = () => ({ kind: 'blocked', reason: 'unknown owner' }); expected = /unknown owner/; }
      if (scenario === 'nested-symlink') {
        fs.renameSync(path.join(f.agentDir, 'npm'), path.join(f.root, 'external-npm'));
        fs.symlinkSync(path.join(f.root, 'external-npm'), path.join(f.agentDir, 'npm')); expected = /symlink/;
      }
      if (scenario === 'channel-drift') {
        let count = 0; hooks.detect = () => ({ ...f.detect(), prefix: ++count === 1 ? f.root : path.join(f.root, 'other-node') }); expected = /channel\/prefix changed/;
      }
      if (scenario === 'integrity' || scenario === 'setup-failure') {
        hooks.command = (binary, args, options) => {
          if (scenario === 'setup-failure' && binary === '/bin/bash') throw new Error('synthetic setup failure');
          const result = f.command(binary, args, options);
          if (scenario === 'integrity' && args.includes('--prefix') && !args.includes('--global')) {
            fs.writeFileSync(path.join(f.agentDir, 'npm/package-lock.json'), JSON.stringify({ packages: {} }));
          }
          return result;
        };
        expected = scenario === 'integrity' ? /integrity\/version differs/ : /synthetic setup failure/;
      }
      assert.throws(() => applyPrepared(f, f.lock, f.prepared, hooks), expected);
      if (['running', 'missing-herdr', 'unknown-owner', 'nested-symlink'].includes(scenario)) assert.equal(f.calls.length, 0);
      else {
        const status = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'state/my-dev-setup/status.json')));
        assert.equal(status.status, 'failed'); assert.equal(fs.existsSync(path.join(f.agentDir, 'state/my-dev-setup/maintenance.lock')), false);
      }
      if (scenario !== 'setup-failure') assert.ok(!f.calls.some(call => call.binary === '/bin/bash'));
    } finally { f.close(); }
  });
}
