// Retire old launch wrappers using disposable prefixes only; no real install/session access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectInstallation, PI_PACKAGE } from '../maintenance-policy.mjs';
import { removeLegacyMaintenance, main } from '../maintain.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(kind = 'npm') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-migration-')));
  const put = (relative, data = '') => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const repo = path.join(root, 'repo'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(repo); fs.mkdirSync(agentDir);
  const host = path.join(root, 'prefix/lib/node_modules', PI_PACKAGE);
  put(path.relative(root, path.join(host, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.5.0' }));
  const real = put(path.relative(root, path.join(host, 'dist/cli.js')), 'original Pi entry');
  const bin = put('prefix/bin/pi', '#!/bin/sh\n# my-dev-setup: deferred maintenance v1\nexit 99\n');
  const original = { kind, bin, real, host, node: process.execPath, manager: put('prefix/bin/npm'), prefix: path.join(root, 'prefix') };
  const hook = { version: 1, repo, agentDir, bin, original, wrapperHash: hash(fs.readFileSync(bin)), link: '../lib/node_modules/' + PI_PACKAGE + '/dist/cli.js' };
  if (kind === 'managed') {
    delete hook.link;
    hook.savedFile = put('prefix/bin/pi.my-dev-setup-original-fixture', '#!/bin/sh\nprintf original\n');
    fs.chmodSync(hook.savedFile, 0o755); hook.originalHash = hash(fs.readFileSync(hook.savedFile));
  }
  put('prefix/bin/pi.my-dev-setup.json', JSON.stringify(hook));
  const state = path.join(agentDir, 'state/my-dev-setup');
  for (const [name, value] of Object.entries({ 'pending.json': '{}', 'candidates/fixture/data': 'candidate', 'status.json': '{"status":"queued"}', 'startup.lock': '99999999' })) put(path.relative(root, path.join(state, name)), value);
  const alias = path.join(root, 'alias/pi'); fs.mkdirSync(path.dirname(alias)); fs.symlinkSync(bin, alias);
  return { root, repo, agentDir, bin, real, hook, alias, state, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
for (const kind of ['npm', 'managed']) {
  test(`${kind} old wrapper reached through a symlink alias restores the actual owned launcher and archives stale queue/lock`, () => {
    const f = fixture(kind); try {
      const detected = inspectInstallation({ bin: f.alias, env: { PATH: '' } });
      assert.equal(detected.kind, kind); assert.equal(detected.bin, f.bin);
      const archive = removeLegacyMaintenance(f.repo, f.agentDir, f.alias);
      assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
      if (kind === 'npm') assert.equal(fs.realpathSync(f.alias), f.real);
      else assert.equal(fs.readFileSync(f.bin, 'utf8'), '#!/bin/sh\nprintf original\n');
      assert.equal(fs.existsSync(`${f.bin}.my-dev-setup.json`), false);
      assert.deepEqual(fs.readdirSync(f.state), [path.basename(archive)]);
      assert.equal(fs.readFileSync(path.join(archive, 'startup.lock'), 'utf8'), '99999999');
      assert.equal(removeLegacyMaintenance(f.repo, f.agentDir, f.alias), undefined);
    } finally { f.close(); }
  });
}
test('modified or foreign old launchers are never overwritten', () => {
  for (const modified of [false, true]) {
    const f = fixture(); try {
      if (modified) fs.appendFileSync(f.bin, '# custom change');
      assert.throws(() => removeLegacyMaintenance(modified ? f.repo : path.join(f.root, 'another-repo'), f.agentDir, f.alias), /Modified legacy|another checkout/);
      assert.equal(fs.existsSync(`${f.bin}.my-dev-setup.json`), true);
      assert.equal(fs.existsSync(path.join(f.state, 'pending.json')), true);
    } finally { f.close(); }
  }
});
test('read-only check recognizes old aliases but leaves wrappers and stale markers untouched', async () => {
  const f = fixture(); try {
    fs.mkdirSync(path.join(f.repo, 'pi'));
    fs.writeFileSync(path.join(f.repo, 'pi/settings.json'), '{"packages":[]}');
    fs.writeFileSync(path.join(f.repo, 'maintenance.json'), '{"version":1,"host":{"installation":"preserve"}}');
    await main({ command: 'check', repo: f.repo, agentDir: f.agentDir }, {
      detect: () => inspectInstallation({ bin: f.alias, env: { PATH: '' } }),
      resolve: async () => ({ host: { version: '1.5.0' }, remotes: [] }), retire() { throw new Error('check must stay read-only'); },
    });
    assert.equal(fs.existsSync(`${f.bin}.my-dev-setup.json`), true);
    assert.equal(fs.existsSync(path.join(f.state, 'startup.lock')), true);
  } finally { f.close(); }
});
test('native managed launcher symlink resolves to its managed bin rather than PATH alias', () => {
  const f = fixture(); try {
    const base = path.join(f.root, 'managed'), root = path.join(base, 'install'), bin = path.join(base, 'bin/pi');
    fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.mkdirSync(root);
    fs.writeFileSync(bin, '#!/bin/sh\nPI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install\nexec "$pi_release_bin" "$@"\n');
    fs.writeFileSync(path.join(root, 'managed-install.json'), JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' }));
    fs.writeFileSync(path.join(root, 'current-version'), '1.5.0');
    const host = path.join(root, 'releases/1.5.0/node_modules', PI_PACKAGE); fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: PI_PACKAGE, version: '1.5.0' }));
    const alias = path.join(f.root, 'managed-alias'); fs.symlinkSync(bin, alias);
    const actual = inspectInstallation({ bin: alias, env: { PATH: '' } });
    assert.equal(actual.kind, 'managed'); assert.equal(actual.bin, bin);
  } finally { f.close(); }
});
