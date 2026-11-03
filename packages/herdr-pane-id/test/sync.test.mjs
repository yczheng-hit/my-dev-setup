import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-id-perf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-herdr'); const log = path.join(dir, 'calls.jsonl');
  writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const result = args[0] === 'api' ? {snapshot:{workspaces:[]}} : args[0] === 'agent' ? {agents:[]} : args[1] === 'list' ? {panes:[]} : {};
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
  const env = { ...process.env, HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: path.join(dir, 'fake.sock'), HERDR_PANE_SYNC_DIR: path.join(dir, 'coordination'), FIXTURE_LOG: log };
  const run = (extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'sync.mjs')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => output += chunk);
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
  return { run, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('measure and coalesce a 10-event process burst without adding periodic work', async (t) => {
  const f = fixture(t); const start = performance.now();
  await Promise.all(Array.from({ length: 10 }, () => f.run()));
  const calls = f.calls();
  const snapshots = calls.filter((args) => args[0] === 'api').length;
  console.log(JSON.stringify({ fixture: '10 synthetic concurrent lifecycle events', calls: calls.length, snapshots, elapsedMs: +(performance.now() - start).toFixed(2) }));
  assert.ok(snapshots <= 2, `expected bounded coalescing, got ${snapshots} full scans`);
  assert.equal(calls.length, snapshots * 3);
});

test('different Herdr sockets never coalesce each other', async (t) => {
  const f = fixture(t);
  await Promise.all([f.run({ HERDR_SOCKET_PATH: '/fixture/socket-a' }), f.run({ HERDR_SOCKET_PATH: '/fixture/socket-b' })]);
  assert.equal(f.calls().filter((args) => args[0] === 'api').length, 2);
});

test('late event during scan is drained by the current writer; failure releases the lease', async (t) => {
  const { coalesceSync } = await import('../coalesce.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-id-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { socket: '/fixture/socket', root: dir, debounceMs: 0 };
  let scans = 0; let entered; let finish;
  const running = new Promise((resolve) => entered = resolve);
  const hold = new Promise((resolve) => finish = resolve);
  const owner = coalesceSync(async () => { scans++; if (scans === 1) { entered(); await hold; } }, options);
  await running;
  const contender = await coalesceSync(async () => { throw new Error('contender must not own'); }, options);
  assert.equal(contender.coalesced, true);
  finish(); await owner; assert.equal(scans, 2);
  await assert.rejects(coalesceSync(async () => { throw new Error('scan failed'); }, options), /scan failed/);
  await coalesceSync(async () => scans++, options); assert.equal(scans, 3);
});

test('unknown socket identity performs every requested scan, without shared coordination state', async () => {
  const { coalesceSync } = await import('../coalesce.mjs');
  let scans = 0;
  await Promise.all(Array.from({ length: 3 }, () => coalesceSync(async () => scans++, { socket: '' })));
  assert.equal(scans, 3);
});

test('coordination root symlink is rejected without touching the linked directory', async (t) => {
  const { coalesceSync } = await import('../coalesce.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-id-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target'); mkdirSync(target);
  const link = path.join(dir, 'link'); symlinkSync(target, link);
  let scans = 0;
  await assert.rejects(coalesceSync(async () => scans++, { socket: '/fixture/socket', root: link }), /Unsafe pane sync/);
  assert.equal(scans, 0);
  assert.deepEqual((await import('node:fs')).readdirSync(target), []);
});
