import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, hostUpdateCommand, inventory, resolveLatest, resolvedSettings, PI_PACKAGE } from '../maintenance-policy.mjs';
import { parseArgs, assertNoRunningPi, assertPlainPath, applyPrepared, ensureRepositoryTools, ensureNativeDependencies } from '../maintain.mjs';
const repo = fileURLToPath(new URL('../..', import.meta.url));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-')));
  const put = (file, data = '') => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { mode: 0o700 }); return target; };
  return { root, put, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('npm provenance uses owning fnm prefix and Node, not shell npm', () => {
  const f = fixture(); try {
    const prefix = path.join(f.root, 'fnm/node-versions/v24/installation');
    const host = path.join(prefix, 'lib/node_modules', PI_PACKAGE);
    f.put(path.relative(f.root, path.join(host, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.4.0' }));
    const cli = f.put(path.relative(f.root, path.join(host, 'dist/cli.js')));
    f.put(path.relative(f.root, path.join(prefix, 'bin/node'))); f.put(path.relative(f.root, path.join(prefix, 'bin/npm')));
    const bin = path.join(prefix, 'bin/pi'); fs.symlinkSync(cli, bin);
    const result = inspectInstallation({ bin, env: { PATH: '' } });
    assert.equal(result.kind, 'npm'); assert.equal(result.prefix, prefix);
    const [command, args] = hostUpdateCommand(result, '1.5.0');
    assert.equal(command, path.join(prefix, 'bin/npm')); assert.ok(args.includes(prefix)); assert.ok(args.includes('--ignore-scripts'));
  } finally { f.close(); }
});
test('custom standalone is blocked rather than installing a second npm Pi', () => {
  const f = fixture(); try {
    const bin = f.put('custom/pi', 'standalone');
    assert.equal(inspectInstallation({ bin, env: { PATH: '' } }).kind, 'blocked');
    assert.throws(() => hostUpdateCommand({ kind: 'blocked', reason: 'original channel' }, '1.5.0'), /original channel/);
  } finally { f.close(); }
});
test('brew provenance keeps formula and original brew', () => {
  const f = fixture(); try {
    const bin = f.put('brew/Cellar/pi/1.4.0/bin/pi'); const brew = f.put('brew/bin/brew');
    const result = inspectInstallation({ bin, env: { PATH: '' } });
    assert.deepEqual(hostUpdateCommand(result, '1.5.0'), [brew, ['upgrade', 'pi']]);
  } finally { f.close(); }
});
test('pnpm ownership is checked by global root before npm fallback', () => {
  const f = fixture(); try {
    const host = path.join(f.root, 'pnpm/global/node_modules', PI_PACKAGE);
    f.put(path.relative(f.root, path.join(host, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.4.0' }));
    const bin = f.put(path.relative(f.root, path.join(host, 'dist/cli.js'))), manager = f.put('bin/pnpm');
    const result = inspectInstallation({ bin, env: { PATH: path.dirname(manager) }, probe: () => path.join(f.root, 'pnpm/global/node_modules') });
    assert.equal(result.kind, 'pnpm'); assert.equal(result.manager, manager);
  } finally { f.close(); }
});
test('repository inventory classifies every local source and never updates hack upstreams', async () => {
  const calls = [];
  const lock = await resolveLatest(repo, { metadata: async name => { calls.push(name); return { version: '9.9.9', dist: { integrity: 'sha512-fixture' } }; }, gitHead: () => 'a'.repeat(40) });
  for (const name of ['@ladbabynpm/picc-permission-modes', 'pi-openai-codex-compat', 'pi-hud-footer', '@jl1990/pi-scheduler']) assert.ok(!calls.includes(name), name);
  assert.ok(calls.includes('pi-hashline-edit-pro')); assert.ok(calls.includes(PI_PACKAGE));
  const settings = resolvedSettings(repo, lock);
  assert.deepEqual(settings.packages.find(entry => typeof entry === 'object'), { source: 'npm:pi-subagents@9.9.9', extensions: [] });
  assert.ok(settings.packages.includes('repo:packages/pi-scheduler'));
  assert.equal(inventory(repo).entries.filter(entry => entry.kind === 'patched').length, 4);
});
test('unknown local packages and patched upstream npm substitution fail closed', () => {
  const f = fixture(); try {
    fs.cpSync(path.join(repo, 'maintenance.json'), path.join(f.root, 'maintenance.json'));
    f.put('pi/settings.json', JSON.stringify({ packages: ['repo:packages/unknown'] }));
    assert.throws(() => inventory(f.root), /Unclassified/);
    f.put('pi/settings.json', JSON.stringify({ packages: ['npm:@jl1990/pi-scheduler'] }));
    assert.throws(() => inventory(f.root), /Patched package/);
  } finally { f.close(); }
});
test('read-only defaults; explicit bootstrap apply is required', () => {
  assert.equal(parseArgs([]).command, 'check'); assert.equal(parseArgs(['bootstrap']).apply, undefined);
  assert.throws(() => parseArgs(['update', '--apply']), /requires bootstrap/);
  assert.throws(() => parseArgs(['bootstrap', '--force']), /Unknown/);
});
test('official installer keeps its managed channel, including outside launcher environment', () => {
  const f = fixture(); try {
    const bin = f.put('managed/bin/pi', '#!/bin/sh\nPI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install\nexec "$pi_release_bin" "$@"\n');
    f.put('managed/install/managed-install.json', JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' }));
    f.put('managed/install/current-version', '1.4.0\n');
    f.put(`managed/install/releases/1.4.0/node_modules/${PI_PACKAGE}/package.json`, JSON.stringify({ name: PI_PACKAGE, version: '1.4.0' }));
    const install = inspectInstallation({ bin, env: { PATH: '' } });
    assert.equal(install.kind, 'managed'); assert.equal(install.version, '1.4.0');
    assert.deepEqual(hostUpdateCommand(install, '1.5.0'), [bin, ['update', '--self']]);
  } finally { f.close(); }
});
test('Nix is blocked and a missing Pi uses only current Node npm', () => {
  assert.equal(inspectInstallation({ bin: '/fake/pi', realpath: () => '/nix/store/fixture/bin/pi', env: { PATH: '' } }).kind, 'blocked');
  const f = fixture(); try {
    const node = f.put('node/bin/node'); const npm = f.put('node/bin/npm');
    const install = inspectInstallation({ bin: null, node, env: { PATH: '' } });
    assert.equal(install.missing, true); assert.equal(install.manager, npm);
  } finally { f.close(); }
});
test('running Pi including argv[0] without options blocks activation', () => {
  for (const line of ['123 pi pi', '123 node node /x/pi-coding-agent/dist/bundle/cli.js', '123 node /x/bin/pi']) {
    assert.throws(() => assertNoRunningPi({ output: line, currentPid: 456 }), /Pi processes are running/);
  }
  assert.doesNotThrow(() => assertNoRunningPi({ output: '456 node node scripts/maintain.mjs\n123 cat cat /tmp/log', currentPid: 456 }));
});
test('symlink destination is refused', () => {
  const f = fixture(); try {
    const dir = path.join(f.root, 'target'); fs.mkdirSync(dir); fs.symlinkSync(dir, path.join(f.root, 'agent'));
    assert.throws(() => assertPlainPath(path.join(f.root, 'agent/state')), /symlink/);
  } finally { f.close(); }
});
test('dirty remote git blocks before host/npm writes', () => {
  const f = fixture(); try {
    const agentDir = path.join(f.root, 'agent'); fs.mkdirSync(path.join(agentDir, 'git/github.com/example/plugin'), { recursive: true });
    const calls = [];
    assert.throws(() => applyPrepared({ repo, agentDir }, { host: { version: '1.5.0' }, remotes: [{ kind: 'remote-git', identity: 'github.com/example/plugin', commit: 'a'.repeat(40) }] }, {}, {
      detect: () => ({ kind: 'npm', version: '1.4.0' }), stopped() {}, hasHerdr: () => true,
      command: (cmd, args) => { calls.push([cmd, args]); return '?? local-file'; },
    }), /Dirty git package preserved before any install/);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'git');
    assert.equal(fs.existsSync(path.join(agentDir, 'state')), false);
  } finally { f.close(); }
});
test('repository-owned tool checkout mismatch never invokes pull/merge/reset', () => {
  const f = fixture(); try {
    fs.cpSync(path.join(repo, 'maintenance.json'), path.join(f.root, 'maintenance.json'));
    fs.cpSync(path.join(repo, 'pi/settings.json'), f.put('pi/settings.json'));
    f.put('tools.tsv', 'pi-btw-split\thttps://github.com/yczheng-hit/pi-btw-split.git\tmain\n');
    f.put('tools/pi-btw-split/.git', 'fixture');
    const calls = [];
    assert.throws(() => ensureRepositoryTools(f.root, (cmd, args) => { calls.push([cmd, args]); return 'b'.repeat(40); }), /differs from repository pin/);
    assert.equal(calls.length, 1); assert.equal(calls[0][1].at(-1), 'HEAD');
  } finally { f.close(); }
});
test('a managed-root environment inherited by another Pi cannot change that Pi owner', () => {
  const f = fixture(); try {
    f.put('managed/managed-install.json', JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' }));
    f.put('managed/current-version', '1.4.0');
    const bin = f.put('other/pi');
    const result = inspectInstallation({ bin, env: { PATH: '', PI_MANAGED_INSTALL_ROOT: path.join(f.root, 'managed') } });
    assert.equal(result.kind, 'blocked'); assert.notEqual(result.kind, 'managed');
  } finally { f.close(); }
});

test('pnpm shell shim and Bun symlink retain their own global installer', () => {
  const f = fixture(); try {
    const host = path.join(f.root, 'pnpm/global/node_modules', PI_PACKAGE);
    f.put(path.relative(f.root, path.join(host, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.4.0' }));
    const manager = f.put('pnpm/bin/pnpm'), bin = f.put('pnpm/bin/pi', '#!/bin/sh\nnode package/cli.js');
    const install = inspectInstallation({ bin, env: { PATH: path.dirname(manager) }, probe: (cmd, args) => args[0] === 'bin' ? path.dirname(bin) : path.dirname(path.dirname(host)) });
    assert.equal(install.kind, 'pnpm'); assert.equal(install.manager, manager);
    const bunHost = path.join(f.root, '.bun/install/global/node_modules', PI_PACKAGE);
    f.put(path.relative(f.root, path.join(bunHost, 'package.json')), JSON.stringify({ name: PI_PACKAGE, version: '1.4.0' }));
    const cli = f.put(path.relative(f.root, path.join(bunHost, 'dist/cli.js'))), bun = f.put('.bun/bin/bun');
    const bunBin = path.join(f.root, '.bun/bin/pi'); fs.symlinkSync(cli, bunBin);
    const result = inspectInstallation({ bin: bunBin, env: { PATH: '' } });
    assert.equal(result.kind, 'bun'); assert.deepEqual(hostUpdateCommand(result, '1.5.0'), [bun, ['add', '--global', '--ignore-scripts', `${PI_PACKAGE}@1.5.0`]]);
    assert.equal(result.node, process.execPath);
  } finally { f.close(); }
});

test('native recovery rebuilds only a declared repairable addon using the owner Node', () => {
  const f = fixture(); try {
    f.put('package/package.json', JSON.stringify({ dependencies: { addon: '1.0.0', ordinary: '1.0.0' } }));
    f.put('package/node_modules/addon/binding.gyp', '{}');
    const calls = [], dir = path.join(f.root, 'package'), node = '/fixture/owner/bin/node';
    ensureNativeDependencies(repo, dir, node, { probe: () => ({ status: 1, stdout: 'fail\taddon\tnode-abi\tfixture\n' }), command: (...args) => calls.push(args) });
    assert.equal(calls.length, 2); assert.equal(calls[0][0], node);
    assert.deepEqual(calls[0][1], [path.join(repo, 'scripts/rebuild-native.mjs'), dir, 'addon']);
    assert.ok(calls[0][2].env.PATH.startsWith('/fixture/owner/bin:'));
    calls.length = 0;
    assert.throws(() => ensureNativeDependencies(repo, dir, node, { probe: () => ({ status: 1, stdout: 'fail\tordinary\tother\tnot repairable\n' }), command: (...args) => calls.push(args) }), /no unsafe broad rebuild/);
    assert.equal(calls.length, 0);
  } finally { f.close(); }
});
