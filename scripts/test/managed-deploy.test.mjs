import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planExtensionTree, buildPlan, applyPlan, restoreBackup } from '../managed-deploy.mjs';

const original = fileURLToPath(new URL('../..', import.meta.url));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-deploy-test-')));
  const repo = path.join(root, 'repo'); const home = path.join(root, 'home'); const agentDir = path.join(home, 'custom-agent');
  fs.mkdirSync(repo); fs.cpSync(path.join(original, 'pi'), path.join(repo, 'pi'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'herdr')); fs.copyFileSync(path.join(original, 'herdr/config.toml'), path.join(repo, 'herdr/config.toml'));
  fs.mkdirSync(home);
  const options = { repo, agentDir, home, agentsOnly: false };
  const put = (target, data) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); };
  return { root, repo, home, agentDir, options, put, plan: (extra = {}) => buildPlan({ ...options, ...extra }),
    apply: (plan) => applyPlan(plan, path.join(root, 'backups')), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('plan is read-only; apply is idempotent, inventory-backed and exact restore works', () => {
  const f = fixture(); try {
    f.put(path.join(f.agentDir, 'settings.json'), JSON.stringify({ deviceId: 'local-only', packages: [] }));
    const before = fs.readFileSync(path.join(f.agentDir, 'settings.json'));
    const plan = f.plan();
    assert.deepEqual(fs.readFileSync(path.join(f.agentDir, 'settings.json')), before);
    assert.equal(fs.existsSync(path.join(f.agentDir, '.my-dev-setup-manifest.json')), false);
    const backup = f.apply(plan);
    const settings = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'settings.json')));
    assert.equal(settings.deviceId, 'local-only');
    assert.equal(settings.packages[0], path.join(f.repo, 'packages/pi-agents-context'));
    assert.deepEqual(settings.packages.find((entry) => typeof entry === 'object'), { source: 'npm:pi-subagents', extensions: [] });
    assert.equal(f.plan().changes.length, 0);
    assert.ok(restoreBackup(backup).length > 10);
    restoreBackup(backup, true);
    assert.deepEqual(fs.readFileSync(path.join(f.agentDir, 'settings.json')), before);
    assert.equal(fs.existsSync(path.join(f.agentDir, '.my-dev-setup-manifest.json')), false);
    assert.throws(() => restoreBackup(backup, true), /not an applied/);
  } finally { f.cleanup(); }
});
test('prospective extension tree matches managed apply, prune and retained edits without live config', () => {
  const f = fixture(); try {
    f.apply(f.plan());
    const dir = path.join(f.agentDir, 'extensions');
    f.put(path.join(dir, 'question.ts'), 'custom same path');
    f.put(path.join(dir, 'custom.ts'), 'unknown extension');
    f.put(path.join(dir, 'local-secret.json'), '{"doNotCopy":"SYNTHETIC_SECRET"}');
    fs.unlinkSync(path.join(f.repo, 'pi/extensions/todo.ts'));
    const tree = planExtensionTree(f.repo, f.agentDir);
    assert.equal(tree.get('question.ts').toString(), 'custom same path');
    assert.equal(tree.get('custom.ts').toString(), 'unknown extension');
    assert.equal(tree.has('todo.ts'), false); assert.equal(tree.has('local-secret.json'), false);
    f.apply(f.plan());
    assert.equal(fs.existsSync(path.join(dir, 'todo.ts')), false);
    for (const [relative, bytes] of tree) assert.deepEqual(fs.readFileSync(path.join(dir, relative)), bytes);
  } finally { f.cleanup(); }
});
test('prune only unchanged owned stale resources; preserve modified and unknown extensions', () => {
  const f = fixture(); try {
    const first = f.apply(f.plan()); assert.ok(first);
    const managed = path.join(f.agentDir, 'extensions/question.ts');
    const modified = path.join(f.agentDir, 'extensions/todo.ts');
    const unknown = path.join(f.agentDir, 'extensions/official-herdr.ts');
    f.put(modified, 'custom edited content'); f.put(unknown, 'not ours');
    fs.unlinkSync(path.join(f.repo, 'pi/extensions/question.ts'));
    fs.unlinkSync(path.join(f.repo, 'pi/extensions/todo.ts'));
    const plan = f.plan();
    assert.ok(plan.changes.some((item) => item.target === managed && item.data === null));
    assert.ok(!plan.changes.some((item) => item.target === modified || item.target === unknown));
    const backup = f.apply(plan);
    assert.equal(fs.existsSync(managed), false);
    assert.equal(fs.readFileSync(modified, 'utf8'), 'custom edited content');
    restoreBackup(backup, true); assert.equal(fs.existsSync(managed), true);
  } finally { f.cleanup(); }
});
test('existing custom desired extension and later custom edits are preserved', () => {
  const f = fixture(); try {
    const target = path.join(f.agentDir, 'extensions/question.ts');
    f.put(target, 'custom');
    const plan = f.plan(); assert.match(plan.warnings.join('\n'), /preserved custom/);
    f.apply(plan); assert.equal(fs.readFileSync(target, 'utf8'), 'custom');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(f.agentDir, '.my-dev-setup-manifest.json'))).files.some((item) => item.target === target));
    assert.equal(f.plan().changes.length, 0);
  } finally { f.cleanup(); }
});
test('corrupt JSON, unsupported host and custom legacy fail before any destination write', () => {
  const f = fixture(); try {
    const target = path.join(f.agentDir, 'settings.json'); f.put(target, '{broken');
    assert.throws(() => f.plan()); assert.equal(fs.existsSync(path.join(f.agentDir, 'AGENTS.md')), false);
    f.put(target, '{}');
    assert.throws(() => f.plan({ agentsOnly: true, host: path.join(f.root, 'unsupported') }), /Unsupported Pi/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  } finally { f.cleanup(); }
});
test('stale plan and modified deployed file refuse all writes or restores', () => {
  const f = fixture(); try {
    const plan = f.plan();
    f.put(path.join(f.agentDir, 'settings.json'), '{"concurrent":true}');
    assert.throws(() => f.apply(plan), /Changed since/);
    assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
    const backup = f.apply(f.plan());
    f.put(path.join(f.agentDir, 'AGENTS.md'), 'user edit after deployment');
    const settings = fs.readFileSync(path.join(f.agentDir, 'settings.json'));
    assert.throws(() => restoreBackup(backup, true), /Changed since/);
    assert.deepEqual(fs.readFileSync(path.join(f.agentDir, 'settings.json')), settings);
  } finally { f.cleanup(); }
});
test('corrupt backup and symlink destinations refuse before mutation', () => {
  const f = fixture(); try {
    fs.mkdirSync(f.agentDir, { recursive: true });
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(f.agentDir, 'extensions'));
    assert.throws(() => f.plan(), /symlink/);
    assert.deepEqual(fs.readdirSync(other), []);
    fs.unlinkSync(path.join(f.agentDir, 'extensions'));
    f.put(path.join(f.agentDir, 'settings.json'), '{}');
    const backup = f.apply(f.plan());
    const record = JSON.parse(fs.readFileSync(path.join(backup, 'transaction.json')));
    const blob = record.files.find((item) => item.blob).blob;
    fs.writeFileSync(path.join(backup, blob), 'corrupt');
    assert.throws(() => restoreBackup(backup, true), /Corrupt backup/);
  } finally { f.cleanup(); }
});
test('object repo package filters survive expansion', () => {
  const f = fixture(); try {
    f.put(path.join(f.repo, 'pi/settings.json'), JSON.stringify({ packages: [{ source: 'repo:packages/sample', extensions: ['!bad.ts'], skills: [] }] }));
    const plan = f.plan();
    const value = JSON.parse(plan.changes.find((item) => item.target === path.join(f.agentDir, 'settings.json')).data);
    assert.deepEqual(value.packages[0], { source: path.join(f.repo, 'packages/sample'), extensions: ['!bad.ts'], skills: [] });
  } finally { f.cleanup(); }
});

test('deployment lock refuses concurrent apply without touching targets', () => {
  const f = fixture(); try {
    const plan = f.plan();
    f.put(path.join(f.agentDir, '.my-dev-setup-deploy.lock'), 'another-live-writer');
    assert.throws(() => f.apply(plan), /Deployment lock exists/);
    assert.equal(fs.existsSync(path.join(f.agentDir, 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  } finally { f.cleanup(); }
});

test('real supported host is only patched in a copied fixture and restores with config', { skip: !process.env.PI_HOST_DIR }, () => {
  const f = fixture(); try {
    const host = path.join(f.root, 'host');
    fs.mkdirSync(path.join(host, 'dist/core'), { recursive: true });
    fs.copyFileSync(path.join(process.env.PI_HOST_DIR, 'dist/core/resource-loader.js'), path.join(host, 'dist/core/resource-loader.js'));
    fs.cpSync(path.join(process.env.PI_HOST_DIR, 'dist/bundle/chunks'), path.join(host, 'dist/bundle/chunks'), { recursive: true });
    const target = path.join(host, 'dist/core/resource-loader.js');
    const before = fs.readFileSync(target);
    const plan = f.plan({ agentsOnly: true, host });
    assert.deepEqual(fs.readFileSync(target), before);
    const backup = f.apply(plan);
    assert.match(fs.readFileSync(target, 'utf8'), /my-dev-setup: agents-only v1/);
    assert.equal(f.plan({ agentsOnly: true, host }).changes.length, 0);
    restoreBackup(backup, true);
    assert.deepEqual(fs.readFileSync(target), before);
    f.put(path.join(f.agentDir, 'extensions/claude-rules.ts'), 'custom legacy');
    assert.throws(() => f.plan({ agentsOnly: true, host }), /Custom legacy extension preserved/);
    assert.deepEqual(fs.readFileSync(target), before);
  } finally { f.cleanup(); }
});

test('ordinary I/O failure rolls back already-applied destinations', () => {
  const f = fixture(); const rename = fs.renameSync;
  try {
    const plan = f.plan(); let failed = false;
    fs.renameSync = (from, to) => {
      if (!failed && to === path.join(f.agentDir, 'keybindings.json')) { failed = true; throw new Error('injected rename failure'); }
      return rename(from, to);
    };
    assert.throws(() => f.apply(plan), /injected rename failure/);
    fs.renameSync = rename;
    for (const item of plan.changes) assert.equal(fs.existsSync(item.target), false, item.target);
    assert.equal(fs.existsSync(path.join(f.agentDir, '.my-dev-setup-deploy.lock')), false);
  } finally { fs.renameSync = rename; f.cleanup(); }
});

test('restore I/O failure rolls completed restores forward to deployed state', () => {
  const f = fixture(); const rename = fs.renameSync;
  try {
    f.put(path.join(f.agentDir, 'keybindings.json'), '{"custom":true}');
    const plan = f.plan(); const backup = f.apply(plan); let failed = false;
    fs.renameSync = (from, to) => {
      if (!failed && to === path.join(f.agentDir, 'keybindings.json')) { failed = true; throw new Error('injected restore failure'); }
      return rename(from, to);
    };
    assert.throws(() => restoreBackup(backup, true), /injected restore failure/);
    fs.renameSync = rename;
    for (const item of plan.changes) {
      if (item.data !== null) assert.deepEqual(fs.readFileSync(item.target), item.data, item.target);
    }
    assert.equal(fs.existsSync(path.join(f.agentDir, '.my-dev-setup-deploy.lock')), false);
    restoreBackup(backup, true);
    assert.equal(fs.readFileSync(path.join(f.agentDir, 'keybindings.json'), 'utf8'), '{"custom":true}');
  } finally { fs.renameSync = rename; f.cleanup(); }
});
