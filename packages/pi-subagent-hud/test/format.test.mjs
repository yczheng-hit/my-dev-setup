import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  updateRows, renderStatus, shortModel, formatTokens, formatElapsed, taskLabel, statusBudget,
  mapCompletionStatus, mapSnapshotState, hudStatusText, STATUS_KEY, LEAD,
} from '../extensions/format.ts';

const T0 = 1_800_000_000_000;
const none = new Map();
const step = (prev, input) => updateRows(prev, { launches: none, completions: none, lingerMs: 10_000, ...input });
const run = (id, extra = {}) => ({ id, kind: 'subagent', label: 'delegate', state: 'running', startedAt: T0, ...extra });
const fleet = (extra = {}) => ({ key: 'fleet-1', agent: 'delegate', model: 'openai-codex/gpt-6-luna', effort: 'low', startedAt: T0, tokens: { total: 2700 }, ...extra });
const launches = new Map([['r1', { agent: 'delegate', model: 'openai-codex/gpt-6-luna:low', task: 'Display test. Do exactly this\n1. sleep', launchedAt: T0 - 500 }]]);

test('formatting helpers', () => {
  assert.equal(shortModel('anthropic/claude-sonnet-5-5'), 'sonnet-5-5');
  assert.equal(shortModel('openai-codex/gpt-6-luna:low'), 'gpt-6-luna');
  assert.equal(shortModel('fixture'), 'fixture');
  assert.equal(shortModel(undefined), undefined);
  assert.equal(formatTokens(0), undefined);
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(2700), '2.7k');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(1_250_000), '1.3M');
  assert.equal(formatElapsed(45_000), '0m 45s');
  assert.equal(formatElapsed(72_000), '1m 12s');
  assert.equal(formatElapsed(3_780_000), '1h 03m');
  assert.equal(taskLabel('\n  Display test. Do exactly this and nothing else\nmore'), 'Display test. Do exactly th…');
  assert.equal([...taskLabel('x'.repeat(40))].length, 28);
  assert.equal(taskLabel('短任务'), '短任务');
  assert.equal(statusBudget(216), 166);
  assert.equal(statusBudget(60), 40);
  assert.equal(mapCompletionStatus('completed'), 'complete');
  assert.equal(mapCompletionStatus(undefined, false), 'failed');
  assert.equal(mapCompletionStatus('paused'), 'stopped');
  assert.equal(mapSnapshotState('partial'), 'failed');
});

test('one running subagent: claude-hud segment with task, model and tokens', () => {
  const rows = step(new Map(), { runs: [run('r1')], fleet: [fleet()], launches, now: T0 + 72_000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 72_000, budget: 166 }),
    '◐ delegate [gpt-6-luna]: Display test. Do exactly th… (1m 12s) · 2.7k');
});

test('/run launch (no task captured) shows agent, model and time only', () => {
  const rows = step(new Map(), { runs: [run('r9')], fleet: [fleet()], now: T0 + 5_000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 5_000, budget: 166 }), '◓ delegate [gpt-6-luna] (0m 05s) · 2.7k');
});

test('two running subagents are separated by " | "', () => {
  const runs = [run('r1'), run('r2', { startedAt: T0 + 1000 })];
  const entries = [fleet(), fleet({ key: 'fleet-2', model: 'anthropic/claude-sonnet-5-5', startedAt: T0 + 1000, tokens: { total: 5100 } })];
  const rows = step(new Map(), { runs, fleet: entries, launches, now: T0 + 46_000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 46_000, budget: 166 }),
    '◑ delegate [gpt-6-luna]: Display test. Do exactly th… (0m 46s) · 2.7k | ◑ delegate [sonnet-5-5] (0m 45s) · 5.1k');
});

test('degrades: drop tasks, then one summary segment', () => {
  const runs = [run('r1'), run('r2', { startedAt: T0 + 1000 }), run('r3', { label: 'scout', startedAt: T0 + 2000 })];
  const entries = [fleet(), fleet({ key: 'f2', startedAt: T0 + 1000, tokens: { total: 1000 } }), fleet({ key: 'f3', agent: 'scout', startedAt: T0 + 2000, tokens: { total: 3700 } })];
  const rows = step(new Map(), { runs, fleet: entries, launches, now: T0 + 10_000 });
  const noTask = renderStatus(rows.values(), { now: T0 + 10_000, budget: 125 });
  assert.ok(!noTask.includes('Display test'), noTask);
  assert.equal(noTask.split(' | ').length, 3, noTask);
  assert.equal(renderStatus(rows.values(), { now: T0 + 10_000, budget: 60 }), '◑ 3 running: delegate×2, scout · 7.4k');
  assert.equal(renderStatus(rows.values(), { now: T0 + 10_000, budget: 20 }), '◑ 3 running · 7.4k');
});

test('completion: ✓ from the snapshot, kept 10 s, then gone', () => {
  let rows = step(new Map(), { runs: [run('r1')], fleet: [fleet()], launches, now: T0 + 60_000 });
  rows = step(rows, { runs: [run('r1', { state: 'complete', endedAt: T0 + 67_000 })], fleet: [], launches, now: T0 + 68_000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 68_000, budget: 166 }),
    '✓ delegate [gpt-6-luna]: Display test. Do exactly th… (1m 07s) · 2.7k');
  rows = step(rows, { runs: [run('r1', { state: 'complete', endedAt: T0 + 67_000 })], fleet: [], launches, now: T0 + 76_000 });
  assert.equal(rows.size, 1);
  rows = step(rows, { runs: [], fleet: [], launches, now: T0 + 77_500 });
  assert.equal(rows.size, 0);
  assert.equal(renderStatus(rows.values(), { now: T0 + 77_500, budget: 166 }), undefined);
});

test('failure from the completion event wins; vanished run without a verdict shows •', () => {
  let rows = step(new Map(), { runs: [run('r1'), run('r2')], fleet: [fleet(), fleet({ key: 'f2' })], now: T0 + 1000 });
  rows = step(rows, { runs: [run('r1', { state: 'partial' })], fleet: [], completions: new Map([['r1', 'failed']]), now: T0 + 2000 });
  const text = renderStatus(rows.values(), { now: T0 + 2000, budget: 166 });
  assert.ok(text.startsWith('✗ delegate'), text);
  assert.ok(text.includes('• delegate'), text);
});

test('stopped and paused show ■', () => {
  let rows = step(new Map(), { runs: [run('r1')], fleet: [fleet()], now: T0 + 1000 });
  rows = step(rows, { runs: [run('r1', { state: 'paused' })], fleet: [], now: T0 + 2000 });
  assert.ok(renderStatus(rows.values(), { now: T0 + 2000, budget: 166 }).startsWith('■ delegate'));
});

test('runs already finished before we saw them are not shown (restored history)', () => {
  const rows = step(new Map(), { runs: [run('old', { state: 'complete', endedAt: T0 - 1000 })], fleet: [], now: T0 });
  assert.equal(rows.size, 0);
});

test('foreground child (fleet only) is shown', () => {
  const rows = step(new Map(), { runs: [], fleet: [fleet({ key: 'fleet-7', agent: 'scout', model: 'anthropic/claude-haiku-5-5' })], now: T0 + 3000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 3000, budget: 166 }), '◒ scout [haiku-5-5] (0m 03s) · 2.7k');
});

test('/run (workflow wrapper): one row for the child, no stray "workflow" segment', () => {
  const wf = (state) => ({ id: 'w1', kind: 'workflow', label: 'fake-delegate', state, startedAt: T0, children: [{ id: 'run', label: 'run', state: state === 'complete' ? 'complete' : 'running', startedAt: T0 }] });
  const entries = [
    { key: 'fleet-1', agent: 'workflow', startedAt: T0, tokens: { total: 0 } },
    { key: 'fleet-2', agent: 'fake-delegate', model: 'btw-live-fake/fixture', startedAt: T0 + 300, tokens: { total: 0 } },
  ];
  let rows = step(new Map(), { runs: [wf('running')], fleet: entries, now: T0 + 4000 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 4000, budget: 166 }), '◐ fake-delegate [fixture] (0m 04s)');
  rows = step(rows, { runs: [wf('running')], fleet: [entries[0]], now: T0 + 13_000 });
  rows = step(rows, { runs: [wf('complete')], fleet: [], now: T0 + 13_500 });
  assert.equal(renderStatus(rows.values(), { now: T0 + 13_500, budget: 166 }), '✓ fake-delegate [fixture] (0m 13s)');
});

test('status text: our block sorts last on the HUD line and starts with a dim "│ "', () => {
  // pi-hud-footer: statuses sorted by key with localeCompare, joined by single spaces.
  const keys = ['todo', STATUS_KEY, 'permission-mode', 'advisor', 'auto-mode-classifying', 'subagent-slash'];
  assert.equal(keys.sort((a, b) => a.localeCompare(b)).at(-1), STATUS_KEY);
  const rows = step(new Map(), { runs: [run('r1')], fleet: [fleet()], launches, now: T0 + 3000 });
  assert.equal(hudStatusText(rows.values(), { now: T0 + 3000, budget: 166 }),
    '│ ◒ delegate [gpt-6-luna]: Display test. Do exactly th… (0m 03s) · 2.7k');
  const painted = hudStatusText(rows.values(), { now: T0 + 3000, budget: 166, painter: { fg: (c, t) => `<${c}>${t}</>` } });
  assert.ok(painted.startsWith(`<dim>${LEAD}</>`), painted);
  // The bar counts against the budget: the body is 69 columns, so 70 no longer fits the task, 71 does.
  assert.ok(!hudStatusText(rows.values(), { now: T0 + 3000, budget: 70 }).includes('Display test'));
  assert.ok(hudStatusText(rows.values(), { now: T0 + 3000, budget: 71 }).includes('Display test'));
  assert.equal(hudStatusText(new Map().values(), { now: T0, budget: 166 }), undefined);
});

test('real 8-subagent frame: same child start time, different models — each run keeps its own model', () => {
  // Captured 20:00:05 with 8 parallel delegates: 8c1f (luna) and 0672 (sonnet) children started in
  // the same millisecond, and so did one luna and one sonnet fleet entry. Time alone cannot tell them apart.
  const B = 1792119515000;
  const r = (id, child) => ({ id, kind: 'subagent', label: 'delegate', state: 'running', startedAt: B + 95, children: [{ id: 'step:0', label: 'delegate', state: 'running', startedAt: B + child }] });
  const runs = [r('8c1f', 173), r('6ccf', 172), r('aaa7', 178), r('1937', 101), r('0672', 173)];
  const sonnet = 'anthropic/claude-sonnet-5-5';
  const f = (key, model, at, total) => ({ key, agent: 'delegate', model, startedAt: B + at, tokens: { total } });
  const entries = [f('fleet-6', sonnet, 101, 84), f('fleet-8', sonnet, 172, 84), f('fleet-10', sonnet, 173, 84), f('fleet-9', 'openai-codex/gpt-6-luna', 173, 2721), f('fleet-4', sonnet, 178, 84)];
  const launch = (model) => ({ agent: 'delegate', model, task: 'x', launchedAt: B });
  const launched = new Map([['8c1f', launch('openai-codex/gpt-6-luna:low')], ...['6ccf', 'aaa7', '1937', '0672'].map((id) => [id, launch(`${sonnet}:low`)])]);
  const rows = step(new Map(), { runs, fleet: entries, launches: launched, now: B + 30_000 });
  assert.equal(rows.get('8c1f').model, 'openai-codex/gpt-6-luna');
  assert.equal(rows.get('8c1f').tokens, 2721);
  for (const id of ['6ccf', 'aaa7', '1937', '0672']) assert.equal(rows.get(id).model, sonnet, id);
  assert.equal(rows.size, 5, 'no leftover fleet-only rows');
});

test('without a launch (/run), the model a run already showed keeps it on ties', () => {
  const B = 1792119515000;
  const runs = [{ id: 'a', kind: 'subagent', label: 'delegate', state: 'running', startedAt: B, children: [{ id: 'step:0', label: 'delegate', state: 'running', startedAt: B + 50 }] },
    { id: 'b', kind: 'subagent', label: 'delegate', state: 'running', startedAt: B, children: [{ id: 'step:0', label: 'delegate', state: 'running', startedAt: B + 50 }] }];
  const e = (key, model) => ({ key, agent: 'delegate', model, startedAt: B + 50, tokens: { total: 1 } });
  const prev = new Map([['a', { key: 'a', agent: 'delegate', model: 'm/two', startedAt: B, state: 'running' }], ['b', { key: 'b', agent: 'delegate', model: 'm/one', startedAt: B, state: 'running' }]]);
  const rows = step(prev, { runs, fleet: [e('f1', 'm/one'), e('f2', 'm/two')], now: B + 1000 });
  assert.equal(rows.get('a').model, 'm/two');
  assert.equal(rows.get('b').model, 'm/one');
});

test('painter colors pieces but layout is measured on plain text', () => {
  const rows = step(new Map(), { runs: [run('r1')], fleet: [fleet()], launches, now: T0 + 1000 });
  const painter = { fg: (color, text) => `<${color}>${text}</>` };
  const text = renderStatus(rows.values(), { now: T0 + 1000, budget: 70, painter });
  assert.ok(text.includes('<accent>◓</>'), text);
  assert.ok(text.includes('<muted> [gpt-6-luna]</>'), text);
  assert.ok(text.includes('Display test'), 'plain width 69 fits budget 70 even though painted text is longer');
});
