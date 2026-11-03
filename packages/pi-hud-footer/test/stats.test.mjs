import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = require('jiti');
const { collectStats } = await createJiti(import.meta.url, { fsCache: false }).import('../extensions/hud-footer/stats.ts');
const usage = { input: 2, output: 3, cacheRead: 5, cacheWrite: 0, cost: { total: 0.1 } };
const entry = (id) => ({ id: String(id), timestamp: '2026-01-01T00:00:00Z', type: 'message', message: { role: 'assistant', usage } });
function fixture(n, { count = true } = {}) {
  let entries = Array.from({ length: n }, (_, i) => entry(i));
  let branch = entries;
  let branchReads = 0; let entryReads = 0;
  const manager = {
    getLeafId: () => branch.at(-1)?.id ?? null,
    getSessionId: () => 'fixture-session',
    getBranch: () => { branchReads++; return branch.slice(); },
    getEntries: () => { entryReads++; return entries.slice(); },
    ...(count ? { getEntryCount: () => entries.length } : {}),
  };
  return { ctx: { sessionManager: manager }, calls: () => ({ branchReads, entryReads }),
    append: () => { entries = [...entries, entry(entries.length)]; branch = entries; },
    branch: (n) => { branch = entries.slice(0, n); } };
}

test('measured unchanged 50k-entry HUD frames avoid branch traversal and session copies', () => {
  for (const scope of ['session', 'branch']) {
    const f = fixture(50_000);
    const expected = collectStats(f.ctx, scope);
    const started = performance.now();
    for (let i = 0; i < 250; i++) assert.equal(collectStats(f.ctx, scope), expected);
    console.log(JSON.stringify({ fixture: '50k synthetic entries / 250 stable frames', scope, elapsedMs: +(performance.now() - started).toFixed(3), ...f.calls() }));
    assert.equal(f.calls().branchReads, 1);
    assert.equal(f.calls().entryReads, scope === 'session' ? 1 : 0);
  }
});

test('append, branch changes and usage-scope changes invalidate stats without stale totals', () => {
  const f = fixture(3);
  assert.equal(collectStats(f.ctx, 'branch').output, 9);
  f.append(); assert.equal(collectStats(f.ctx, 'branch').output, 12);
  f.branch(2); assert.equal(collectStats(f.ctx, 'branch').output, 6);
  assert.equal(collectStats(f.ctx, 'session').output, 12);
  f.append(); f.branch(2);
  assert.equal(collectStats(f.ctx, 'session').output, 15, 'entry count must catch off-branch append');
});

test('legacy manager without entry count stays conservative for session totals', () => {
  const f = fixture(3, { count: false });
  assert.equal(collectStats(f.ctx, 'session').output, 9);
  f.append(); f.branch(3);
  assert.equal(collectStats(f.ctx, 'session').output, 12);
});
