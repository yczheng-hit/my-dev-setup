// Execute only a copied setup against disposable HOME/host/config, never the real installation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const host = process.env.PI_HOST_DIR;
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-order-test-')));
  const copy = path.join(root, 'repo'), home = path.join(root, 'home'), fakeHost = path.join(root, 'host'), bin = path.join(root, 'bin');
  for (const dir of [copy, home, bin, path.join(copy, 'packages'), path.join(copy, 'tools'), path.join(copy, 'scripts')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'setup.sh'), path.join(copy, 'setup.sh'));
  fs.cpSync(path.join(repo, 'pi'), path.join(copy, 'pi'), { recursive: true });
  fs.cpSync(path.join(repo, 'herdr'), path.join(copy, 'herdr'), { recursive: true });
  for (const name of ['managed-deploy.mjs', 'agents-only.mjs', 'maintenance-queue.mjs']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(copy, 'scripts', name));
  fs.writeFileSync(path.join(copy, 'scripts/check-pi-extensions.mjs'), 'console.log("fail\\tfixture\\tintentional loader failure"); process.exit(1);');
  fs.writeFileSync(path.join(copy, 'tools.tsv'), '');
  fs.mkdirSync(path.join(fakeHost, 'dist/core'), { recursive: true });
  fs.copyFileSync(path.join(host, 'dist/core/resource-loader.js'), path.join(fakeHost, 'dist/core/resource-loader.js'));
  fs.cpSync(path.join(host, 'dist/bundle/chunks'), path.join(fakeHost, 'dist/bundle/chunks'), { recursive: true });
  for (const name of ['pi', 'herdr']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const agent = path.join(home, 'custom-agent');
  const run = (...args) => spawnSync('/bin/bash', [path.join(copy, 'setup.sh'), ...args], { encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_HOST_DIR: fakeHost,
      PI_HASHLINE_DIR: path.join(home, 'hashline'), PATH: `${bin}:${process.env.PATH}` } });
  return { root, copy, home, fakeHost, agent, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('setup dry-run writes no host/config, and loader failure precedes config application', { skip: !host }, () => {
  const f = fixture(); try {
    const target = path.join(f.fakeHost, 'dist/core/resource-loader.js'); const before = fs.readFileSync(target);
    const dry = f.run('--dry-run'); assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.deepEqual(fs.readdirSync(f.home), []); assert.deepEqual(fs.readFileSync(target), before);
    const failure = f.run(); assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /extension preflight failed/);
    assert.deepEqual(fs.readdirSync(f.home), []); assert.deepEqual(fs.readFileSync(target), before);
    fs.mkdirSync(f.agent, { recursive: true }); fs.writeFileSync(path.join(f.agent, 'settings.json'), '{broken');
    const invalid = f.run(); assert.notEqual(invalid.status, 0);
    assert.ok(!invalid.stdout.includes('Tool repositories'));
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(fs.existsSync(path.join(f.agent, 'AGENTS.md')), false);
  } finally { f.cleanup(); }
});
