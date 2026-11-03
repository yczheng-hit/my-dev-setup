const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { harness, until } = require('./helpers/runtime-harness.cjs');
const root = __dirname + '/..';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function ui(h, draft = '') {
  Object.assign(h.context, { hasUI: true, hasPendingMessages: () => false, ui: { getEditorText: () => draft, onTerminalInput: () => () => {}, setStatus() {}, setWidget() {}, notify() {} } });
  return value => { draft = value; };
}
test('foreground-blocked cron retries one overdue occurrence, including after reload', async () => {
  let fire; let executions = 0;
  const local = createRequire(root + '/extensions/scheduler/index.ts');
  const core = local('./scheduler-core.cjs');
  const h = await harness(root, async () => { executions++; return { code: 0 }; }, {
    Cron: class { constructor(_schedule, callback) { fire = callback; } stop() {} },
    require: id => id === './scheduler-core.cjs' ? { ...core, createScheduledTask: (...args) => ({ ...core.createScheduledTask(...args), nextRun: new Date(Date.now() - 1000).toISOString() }) } : local(id),
  });
  const setDraft = ui(h, 'draft');
  try {
    await h.start();
    await h.call('schedule_task', { action: 'shell', command: 'fixture', type: 'cron', schedule: '0 0 * * *', name: 'deferred' });
    fire(); await h.settle(); assert.equal(executions, 0);
    const deferred = (await h.tasks())[0];
    assert.equal(deferred.foregroundDeferredAt, deferred.nextRun, 'due occurrence persisted before reload');
    await h.events.session_shutdown({}, h.context); await h.start();
    setDraft(''); await h.commands.scheduler.handler('resume', h.context);
    await until(() => executions === 1, 'overdue cron retry');
    await delay(650); assert.equal(executions, 1);
  } finally { await h.close(); }
});
test('long prompt wake survives storage and is delivered intact', async () => {
  const h = await harness(root, async () => ({ code: 0 })); ui(h);
  const prompt = 'long-synthetic-prompt-'.repeat(1000);
  try {
    await h.start(); await h.call('schedule_task', { action: 'prompt', schedule: '0.01s', prompt });
    await until(() => h.wakes.length === 1, 'long wake');
    assert.ok(h.wakes[0].text.endsWith(prompt));
  } finally { await h.close(); }
});
test('void dispatch without native user message acceptance is never reported delivered', async () => {
  const h = await harness(root, async () => ({ code: 0 }), { acknowledgeWakes: false }); ui(h);
  try {
    await h.start(); await h.call('schedule_task', { action: 'prompt', schedule: '0.01s', prompt: 'synthetic rejected send' });
    await until(() => h.wakes.length === 1, 'dispatch'); await h.settle();
    const task = (await h.tasks())[0];
    assert.notEqual(task.result.wakeDisposition, 'delivered');
    assert.ok(task.pendingWake, 'retain recoverable content until native acceptance');
    await h.events.message_start({ message: { role: 'user', content: [{ type: 'text', text: 'unrelated human request' }] } }, h.context);
    assert.ok((await h.tasks())[0].pendingWake);
  } finally { await h.close(); }
});
test('native acceptance confirms only the matching wake and persists its receipt', async () => {
  const h = await harness(root, async () => ({ code: 0 }), { acknowledgeWakes: false }); ui(h);
  try {
    await h.start(); await h.call('schedule_task', { action: 'prompt', schedule: '0.01s', prompt: 'matching synthetic send' });
    await until(() => h.wakes.length === 1, 'dispatch'); await h.settle();
    await h.events.message_start({ message: { role: 'user', content: [{ type: 'text', text: h.wakes[0].text }] } }, h.context);
    const task = (await h.tasks())[0];
    assert.equal(task.result.wakeDisposition, 'delivered'); assert.equal(task.pendingWake, undefined);
  } finally { await h.close(); }
});
