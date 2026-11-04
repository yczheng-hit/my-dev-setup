const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');
const { harness, until } = require('./helpers/runtime-harness.cjs');
const { createTaskStore } = require('../extensions/scheduler/task-store.cjs');
const root = __dirname + '/..';
const reply = (state, summary = 'synthetic status') => ({ code: 0, stdout: JSON.stringify({ state, summary }), stderr: '' });
const taskArgs = extra => ({ action: 'shell', resultMode: 'readiness', type: 'interval', schedule: '0.03s', command: 'synthetic-check', wakeOn: 'success', stopOn: 'success', maxRuns: 10, ...extra });

for (const [name, result] of [
  ['nonzero despite ready', { ...reply('ready'), code: 1 }],
  ['timeout', { ...reply('ready'), killed: true }],
  ['missing output', { code: 0, stdout: '', stderr: '' }],
  ['bad JSON', { code: 0, stdout: 'not JSON', stderr: '' }],
  ['multiple JSON results', { code: 0, stdout: '{"state":"pending","summary":"a"}\n{"state":"ready","summary":"b"}' }],
  ['unknown state', reply('maybe')], ['empty summary', reply('ready', '')],
  ['declared error', reply('error', 'missing work directory')],
  ['truncated', { ...reply('pending'), truncated: true }],
  ['oversized protocol', { code: 0, stdout: ' '.repeat(8193) }],
  ['oversized summary', reply('ready', 'a'.repeat(1001))],
  ['non-object', { code: 0, stdout: '[1,2]' }],
  ['extra fields', { code: 0, stdout: JSON.stringify({ state: 'ready', summary: 'ok', extra: true }) }],
  ['execution exception', new Error('synthetic spawn failure')],
]) test(`readiness ${name}: pauses and wakes once even when only success was requested`, async () => {
  let calls = 0;
  const h = await harness(root, async () => { calls++; if (result instanceof Error) throw result; return result; });
  try {
    await h.start(); await h.call('schedule_task', taskArgs());
    await until(async () => h.wakes.length === 1 && (await h.tasks())[0]?.result?.wakeDisposition === 'delivered', 'failure wake');
    const task = (await h.tasks())[0];
    assert.equal(task.enabled, false); assert.equal(task.status, 'failed'); assert.equal(task.result.readiness.state, 'error');
    assert.match(h.wakes[0].text, /检查器失败/); assert.match(h.wakes[0].text, /暂停/);
    assert.match(h.wakes[0].text, /不代表.*失败/); assert.equal(task.nextRun, undefined);
    await h.events.session_shutdown({}, h.context); await h.start(); await h.settle();
    assert.equal(calls, 1); assert.equal(h.wakes.length, 1);
  } finally { await h.close(); }
});

test('pending does not stopOn success; ready wakes and stops; unchanged pending does not spam', async () => {
  let calls = 0; const h = await harness(root, async () => reply(++calls < 4 ? 'pending' : 'ready'));
  try {
    await h.start(); await h.call('schedule_task', taskArgs());
    await until(() => h.wakes.length === 1, 'ready'); await h.settle();
    const task = (await h.tasks())[0]; assert.equal(calls, 4); assert.equal(task.runCount, 4);
    assert.equal(task.enabled, false); assert.equal(task.status, 'fired'); assert.match(h.wakes[0].text, /条件满足/);
    assert.equal(h.entries.filter(e => /尚未就绪/.test(e.data.text)).length, 1);
    assert.equal(task.history.filter(run => run.outcome.readinessState === 'pending').length, 3);
    assert.equal(task.lastReadiness.state, 'ready');
  } finally { await h.close(); }
});

test('always wakes for every pending; maxRuns exhaustion is delivered as one terminal report', async () => {
  const h = await harness(root, async () => reply('pending'));
  try {
    await h.start(); await h.call('schedule_task', taskArgs({ wakeOn: 'always', maxRuns: 3 }));
    await until(() => h.wakes.length === 3, 'pending and exhaustion'); await h.settle();
    assert.equal(h.wakes.filter(w => /尚未就绪/.test(w.text)).length, 2);
    assert.match(h.wakes.at(-1).text, /等待结束/); assert.match(h.wakes.at(-1).text, /次数/);
    assert.equal((await h.tasks())[0].enabled, false);
    const last = (await h.tasks())[0];
    assert.equal(last.result.wakeDisposition, 'delivered');
    assert.equal(last.history.at(-1).wakeDisposition, 'delivered');
    assert.equal(last.history.at(-1).wakeReason, 'maxRuns');
  } finally { await h.close(); }
});

test('expiry before first check notifies without running; queued terminal notification survives expiry/restart', async () => {
  let calls = 0; const h = await harness(root, async () => { calls++; return reply('pending'); });
  try {
    Object.assign(h.context, { hasUI: true, hasPendingMessages: () => false, ui: { getEditorText: () => 'human draft', setStatus() {}, setWidget() {}, notify() {} } });
    await h.start(); await h.call('schedule_task', taskArgs({ schedule: '1h', expiresIn: '0.03s' }));
    await until(async () => (await h.tasks())[0]?.pendingWake?.readinessTerminal === true, 'expiry notice queued');
    assert.equal(calls, 0); assert.equal(h.wakes.length, 0);
    await h.events.session_shutdown({}, h.context); await h.start();
    h.context.ui.getEditorText = () => '';
    await h.commands.scheduler.handler('resume', h.context);
    await until(() => h.wakes.length === 1, 'expiry report delivered');
    assert.match(h.wakes[0].text, /期限/); assert.match(h.wakes[0].text, /尚未满足/); assert.equal(calls, 0);
  } finally { await h.close(); }
});

test('error during active foreground is durable; uncertain dispatch is not replayed', async () => {
  let busy = false, finish;
  const h = await harness(root, async () => await new Promise(resolve => { finish = resolve; }), { acknowledgeWakes: false });
  try {
    h.context.isIdle = () => !busy;
    await h.start(); await h.call('schedule_task', taskArgs()); await until(() => finish, 'start');
    busy = true; finish({ code: 1, stdout: '', stderr: 'bad command' });
    await until(async () => (await h.tasks())[0]?.pendingWake?.state === 'queued', 'durable error');
    assert.equal(h.wakes.length, 0); busy = false; await h.commands.scheduler.handler('resume', { ...h.context, ui: { notify() {} } });
    await until(() => h.wakes.length === 1, 'dispatch'); await h.settle();
    assert.equal((await h.tasks())[0].pendingWake.state, 'uncertain');
    await h.events.session_shutdown({}, h.context); await h.start(); await h.settle();
    assert.equal(h.wakes.length, 1);
  } finally { await h.close(); }
});

test('readiness options validate atomically and normal shell defaults remain unchanged', () => {
  const make = extra => core.createScheduledTask(taskArgs({ schedule: '1m', ...extra }));
  assert.equal(make({ wakeOn: undefined, stopOn: undefined }).wakeOn, 'success');
  for (const extra of [{ action: 'prompt', prompt: 'x' }, { resultMode: 'typo' }, { wakeOn: 'never' }, { wakeOn: 'failure' }, { wakeOn: 'change' }, { stopOn: 'failure' }]) assert.throws(() => make(extra), /readiness|resultMode/i);
  const task = make({}); const before = JSON.stringify(task);
  assert.throws(() => core.updateScheduledTask([task], task.id, { name: 'must not change', wakeOn: 'never' }), /readiness/i);
  assert.equal(JSON.stringify(task), before);
  const regular = core.createScheduledTask({ action: 'shell', schedule: '1m', command: 'check' });
  assert.equal(regular.wakeOn, 'never'); assert.equal(regular.stopOn, 'never'); assert.equal(regular.resultMode, undefined);
});

test('explicit cancellation/disable suppresses future failure feedback and stale changed commands do not trigger it', async () => {
  for (const action of ['cancel', 'disable', 'update', 'reschedule']) {
    let finish; const h = await harness(root, async () => await new Promise(resolve => { finish = resolve; }));
    try {
      await h.start(); const created = await h.call('schedule_task', taskArgs()); await until(() => finish, 'running');
      const id = created.details.task.id;
      if (action === 'cancel') await h.call('cancel_scheduled_task', { id });
      else await h.call('manage_scheduled_task', { action: action === 'reschedule' ? 'update' : action, id, ...(['update', 'reschedule'].includes(action) ? { ...(action === 'update' ? { command: 'new-check' } : {}), schedule: '1h' } : {}) });
      finish({ code: 1, stderr: 'old failure' }); await h.settle();
      assert.equal(h.wakes.length, 0); assert.equal((await h.tasks())[0].pendingWake, undefined);
    } finally { finish?.(reply('pending')); await h.close(); }
  }
});

test('interrupted readiness checks pause and notify instead of resuming broken polling', async () => {
  let calls = 0; const h = await harness(root, async () => { calls++; return reply('pending'); });
  try {
    await h.start(); const created = await h.call('schedule_task', taskArgs({ schedule: '1h' }));
    const store = createTaskStore({ stateFile: h.stateFile, sanitize: core.sanitizeTasks });
    await store.transact(tasks => { core.markScheduledTaskRunning(tasks, created.details.task.id, new Date(), { runOwner: { pid: 99999999, attemptId: 'crashed', sessionFile: h.context.sessionManager.getSessionFile() } }); });
    await h.events.session_shutdown({}, h.context); await h.start();
    await until(() => h.wakes.length === 1, 'interrupted error notice');
    assert.equal((await h.tasks())[0].enabled, false); assert.equal(calls, 0);
  } finally { await h.close(); }
});


test('pending maxRuns with success-only policy reports exhaustion; always errors use fixed failure report', async () => {
  for (const error of [false, true]) {
    const h = await harness(root, async () => error ? reply('error', 'bad checker') : reply('pending'));
    try {
      await h.start(); await h.call('schedule_task', taskArgs({ maxRuns: 1, wakeOn: error ? 'always' : 'success', followUpPrompt: 'CUSTOM-MUST-NOT-HIDE-TERMINAL' }));
      await until(() => h.wakes.length === 1, 'terminal notice'); await h.settle();
      assert.match(h.wakes[0].text, error ? /检查器失败/ : /次数.*尚未满足/);
      assert.doesNotMatch(h.wakes[0].text, /CUSTOM-MUST-NOT-HIDE-TERMINAL/);
    } finally { await h.close(); }
  }
});

test('in-flight completion after deadline reports pending/error/ready truthfully once', async () => {
  for (const state of ['pending', 'error', 'ready']) {
    let finish; const h = await harness(root, async () => await new Promise(resolve => { finish = resolve; }));
    try {
      await h.start(); await h.call('schedule_task', taskArgs({ expiresIn: '0.12s' }));
      await until(() => finish, 'start check');
      await new Promise(resolve => setTimeout(resolve, 140)); finish(reply(state));
      await until(() => h.wakes.length === 1, 'late completion'); await h.settle();
      assert.match(h.wakes[0].text, state === 'pending' ? /等待结束/ : state === 'error' ? /检查器失败/ : /条件满足/);
      if (state === 'ready') assert.doesNotMatch(h.wakes[0].text, /条件尚未满足/);
      assert.equal((await h.tasks())[0].enabled, false);
    } finally { finish?.(reply(state)); await h.close(); }
  }
});

test('queued terminal report is not cleaned up or overwritten by prompt editing; explicit cancel discards it', async () => {
  const h = await harness(root, async () => reply('error'));
  try {
    let busy = false; h.context.isIdle = () => !busy;
    await h.start();
    // Background execution is explicit; delivery still observes the foreground gate.
    busy = true;
    const created = await h.call('schedule_task', taskArgs({ backgroundExecution: true }));
    await until(async () => (await h.tasks())[0]?.pendingWake?.state === 'queued', 'queued');
    assert.equal((await h.call('manage_scheduled_task', { action: 'cleanup' })).details.removed.length, 0);
    const reports = [];
    Object.assign(h.context, { hasUI: true, mode: 'rpc', hasPendingMessages: () => false,
      ui: { getEditorText: () => '', setStatus() {}, setWidget() {}, notify: text => reports.push(text),
        select: async (_title, options) => options[0], editor: async () => 'new future prompt' } });
    const before = (await h.tasks())[0].pendingWake;
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    assert.equal((await h.tasks())[0].followUpPrompt, 'new future prompt');
    assert.deepEqual((await h.tasks())[0].pendingWake, before, 'fixed failure report is not rewritten');
    await h.call('cancel_scheduled_task', { id: created.details.task.id });
    busy = false; await h.commands.scheduler.handler('resume', h.context); await h.settle();
    assert.equal(h.wakes.length, 0); assert.equal((await h.tasks())[0].pendingWake, undefined);
  } finally { await h.close(); }
});

test('readiness persistence defaults, atomic migration and explicit repair/enable', async () => {
  const make = () => core.createScheduledTask({ action: 'shell', schedule: '1h', command: 'x' });
  const original = make();
  core.updateScheduledTask([original], original.id, { resultMode: 'readiness' });
  assert.equal(original.wakeOn, 'success'); assert.equal(original.stopOn, 'success');
  const persisted = { ...original, wakeOn: undefined, stopOn: undefined };
  assert.equal(core.normalizeTask(persisted).wakeOn, 'success');
  assert.equal(core.normalizeTask({ ...persisted, wakeOn: 'typo' }).enabled, false);
  const before = JSON.stringify(original);
  assert.throws(() => core.updateScheduledTask([original], original.id, { name: 'invalid', resultMode: 'bad' }), /resultMode/);
  assert.equal(JSON.stringify(original), before);
  const h = await harness(root, async () => reply('error'));
  try {
    await h.start(); const made = await h.call('schedule_task', taskArgs());
    await until(() => h.wakes.length === 1, 'initial failure'); await h.settle();
    await h.call('manage_scheduled_task', { action: 'update', id: made.details.task.id, command: 'fixed-check', schedule: '1h' });
    assert.equal((await h.tasks())[0].enabled, false, 'repair must not implicitly enable');
    await h.call('manage_scheduled_task', { action: 'enable', id: made.details.task.id });
    assert.equal((await h.tasks())[0].status, 'pending'); assert.equal((await h.tasks())[0].enabled, true);
    assert.equal((await h.tasks())[0].lastReadiness, undefined);
  } finally { await h.close(); }
});


test('changed pending evidence remains visible without changing success-only wake policy', async () => {
  let calls = 0; const h = await harness(root, async () => ({ ...reply(++calls < 4 ? 'pending' : 'ready'), stderr: calls < 3 ? 'old diagnostic' : 'new diagnostic' }));
  try {
    await h.start(); await h.call('schedule_task', taskArgs());
    await until(() => h.wakes.length === 1, 'ready'); await h.settle();
    assert.equal(h.entries.filter(e => /尚未就绪/.test(e.data.text)).length, 2);
    assert.equal((await h.tasks())[0].runCount, 4);
  } finally { await h.close(); }
});

test('completion after session shutdown retains error evidence and delivers on next session start', async () => {
  let finish; const h = await harness(root, async () => await new Promise(resolve => { finish = resolve; }));
  try {
    await h.start(); await h.call('schedule_task', taskArgs()); await until(() => finish, 'running');
    await h.events.session_shutdown({}, h.context); finish({ code: 1, stdout: '', stderr: 'checker bug' }); await h.settle();
    assert.equal(h.wakes.length, 0); assert.equal((await h.tasks())[0].readinessNotice.state, 'error');
    await h.start(); await until(() => h.wakes.length === 1, 'retained error'); await h.settle();
    assert.match(h.wakes[0].text, /checker bug/); assert.equal((await h.tasks())[0].enabled, false);
  } finally { finish?.(reply('error')); await h.close(); }
});

test('once pending reports waiting ended; stopOn never may continue after ready', async () => {
  for (const once of [true, false]) {
    let calls = 0; const h = await harness(root, async () => reply(++calls === 1 && !once ? 'ready' : 'pending'));
    try {
      await h.start(); await h.call('schedule_task', taskArgs({ ...(once ? { type: 'once' } : { stopOn: 'never', maxRuns: 2 }) }));
      await until(() => h.wakes.length === (once ? 1 : 2), 'end waiting'); await h.settle();
      assert.match(h.wakes.at(-1).text, /等待结束/); assert.equal((await h.tasks())[0].runCount, once ? 1 : 2);
    } finally { await h.close(); }
  }
});


test('interrupted stale readiness command does not raise a failure for a replaced check', () => {
  const task = core.createScheduledTask(taskArgs({ schedule: '1h' }));
  core.markScheduledTaskRunning([task], task.id, new Date(), { runOwner: { pid: 99999999, attemptId: 'old-check' } });
  core.updateScheduledTask([task], task.id, { command: 'replacement-check' });
  core.recoverInterruptedTasks([task], new Date(), { isOwnerActive: () => false });
  assert.equal(task.readinessNotice, undefined); assert.equal(task.enabled, true); assert.equal(task.status, 'pending');
});


test('ready completion after shutdown is retained for the original session without rerunning the check', async () => {
  let finish, calls = 0; const h = await harness(root, async () => { calls++; return await new Promise(resolve => { finish = resolve; }); });
  try {
    await h.start(); await h.call('schedule_task', taskArgs()); await until(() => finish, 'started');
    await h.events.session_shutdown({}, h.context); finish(reply('ready')); await h.settle();
    assert.equal(h.wakes.length, 0); assert.equal((await h.tasks())[0].pendingWake.state, 'queued');
    await h.start(); await until(() => h.wakes.length === 1, 'ready delivered after restart'); await h.settle();
    assert.match(h.wakes[0].text, /条件满足/); assert.equal(calls, 1);
    assert.equal((await h.tasks())[0].result.wakeDisposition, 'delivered');
  } finally { finish?.(reply('ready')); await h.close(); }
});
