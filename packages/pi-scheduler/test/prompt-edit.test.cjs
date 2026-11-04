const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');
const { harness, until } = require('./helpers/runtime-harness.cjs');
const root = __dirname + '/..';
const BODY = '  检查任务 A。\n\n- 保留正常空格。\n  - 证据：logs/a.log\n';
function ui(h, editor, select = async (_title, options) => options[0]) {
  const notices = [];
  Object.assign(h.context, { hasUI: true, mode: 'rpc', hasPendingMessages: () => false,
    ui: { editor, select, notify: (text, level) => notices.push({ text, level }), getEditorText: () => '', setStatus() {}, setWidget() {} } });
  return notices;
}

test('create/update/restore retain body whitespace while previews remain single-line', () => {
  for (const [action, field] of [['prompt', 'prompt'], ['notify', 'message'], ['message', 'message'], ['shell', 'followUpPrompt']]) {
    const task = core.createScheduledTask({ action, schedule: '1h', command: 'true', [field]: BODY });
    assert.equal(task[field], BODY);
    assert.equal(core.normalizeTask(JSON.parse(JSON.stringify(task)))[field], BODY);
    assert.doesNotMatch(core.describeTask(task), /[\r\n\t]/);
    const updated = BODY + '\nnext check';
    core.updateScheduledTask([task], task.id, { [field]: updated });
    assert.equal(task[field], updated);
  }
  const shell = core.createScheduledTask({ action: 'shell', schedule: '1h', command: 'true', successPrompt: BODY, failurePrompt: BODY });
  assert.equal(shell.successPrompt, BODY); assert.equal(shell.failurePrompt, BODY);
  assert.throws(() => core.createScheduledTask({ action: 'prompt', schedule: '1h', prompt: ' \n ' }), /required/);
  assert.throws(() => core.updateScheduledTask([shell], shell.id, { action: 'prompt', prompt: ' \n ' }), /required/);
  const p = core.createScheduledTask({ action: 'prompt', schedule: '1h', prompt: BODY });
  assert.throws(() => core.updateScheduledTask([p], p.id, { prompt: null }), /required/);
  assert.equal(p.prompt, BODY);
});

test('separator command preserves multiline payload', () => {
  assert.equal(core.splitScheduleCommand('prompt 1h :: ' + BODY).payload, BODY);
});

test('formatted prompt survives restart and real dispatch with automatic-source guidance', async () => {
  const h = await harness(root, async () => { throw new Error('No commands'); }); ui(h);
  try {
    await h.start(); await h.commands.scheduler.handler('pause', h.context);
    await h.call('schedule_task', { action: 'prompt', schedule: '0.01s', prompt: BODY });
    await h.events.session_shutdown({}, h.context); await h.start();
    await h.commands.scheduler.handler('resume', h.context);
    await until(() => h.wakes.length === 1, 'restored wake');
    assert.ok(h.wakes[0].text.endsWith('\n' + BODY));
    assert.match(h.wakes[0].text, /自动唤醒，非新增用户授权/);
    assert.match(h.wakes[0].text, /用户最新指令/);
  } finally { await h.close(); }
});

test('manual prompt edit preserves scheduling and is cancellation/no-op safe', async () => {
  const h = await harness(root, async () => ({ code: 0 })); let replacement = BODY;
  const notices = ui(h, async (_title, initial) => { assert.equal(initial, 'old prompt'); return replacement; });
  try {
    await h.start(); const created = await h.call('schedule_task', { action: 'prompt', schedule: '1h', prompt: 'old prompt', name: 'check A' });
    const id = created.details.task.id, before = (await h.tasks())[0];
    assert.ok(h.commands['schedule-edit']);
    await h.commands['schedule-edit'].handler('check A', h.context);
    const after = (await h.tasks())[0]; assert.equal(after.prompt, BODY);
    for (const field of ['id', 'nextRun', 'runCount', 'scope', 'enabled', 'status']) assert.equal(after[field], before[field]);
    assert.equal(h.wakes.length, 0); assert.equal(h.messages.length, 0);
    h.context.ui.editor = async () => undefined;
    await h.commands['schedule-edit'].handler(id, h.context); assert.deepEqual((await h.tasks())[0], after);
    h.context.ui.editor = async () => BODY;
    await h.commands['schedule-edit'].handler(id, h.context); assert.deepEqual((await h.tasks())[0], after);
    assert.ok(!notices.some(n => n.level === 'error'));
  } finally { await h.close(); }
});

test('shell editor targets follow-up/outcome text without touching command or wake policy', async () => {
  const h = await harness(root, async () => ({ code: 0 }));
  ui(h, async () => BODY, async (_title, options) => options.find(option => option.includes('失败')));
  try {
    await h.start(); const created = await h.call('schedule_task', { action: 'shell', schedule: '1h', command: 'printf ok', followUpPrompt: 'follow', wakeOn: 'failure' });
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    const task = (await h.tasks())[0]; assert.equal(task.failurePrompt, BODY); assert.equal(task.followUpPrompt, 'follow');
    assert.equal(task.command, 'printf ok'); assert.equal(task.wakeOn, 'failure');
  } finally { await h.close(); }
});

test('stale edit, blank required text and uncertain delivery are rejected without overwrites', async () => {
  const h = await harness(root, async () => ({ code: 0 }), { acknowledgeWakes: false });
  const notices = ui(h, async () => BODY);
  try {
    await h.start(); const created = await h.call('schedule_task', { action: 'prompt', schedule: '1h', prompt: 'original' });
    const id = created.details.task.id;
    h.context.ui.editor = async () => { await h.call('manage_scheduled_task', { action: 'update', id, prompt: 'concurrent' }); return BODY; };
    await h.commands['schedule-edit'].handler(id, h.context); assert.equal((await h.tasks())[0].prompt, 'concurrent');
    assert.match(notices.at(-1).text, /变化/);
    h.context.ui.editor = async () => ' \n ';
    await h.commands['schedule-edit'].handler(id, h.context); assert.equal((await h.tasks())[0].prompt, 'concurrent');
    await h.call('manage_scheduled_task', { action: 'update', id, schedule: '0.01s' });
    await until(() => h.wakes.length === 1, 'uncertain wake');
    h.context.ui.editor = async () => BODY;
    await h.commands['schedule-edit'].handler(id, h.context); assert.equal((await h.tasks())[0].prompt, 'concurrent');
    assert.match(notices.at(-1).text, /交付/); assert.equal(h.wakes.length, 1);
  } finally { await h.close(); }
});

test('queued one-shot wake is edited in place without dropping its delivery or re-running', async () => {
  const h = await harness(root, async () => ({ code: 0 })); ui(h, async () => BODY);
  try {
    await h.start(); await h.commands.scheduler.handler('pause', h.context);
    const created = await h.call('schedule_task', { action: 'prompt', schedule: '0.01s', prompt: 'old' });
    // Hold the result after execution, before user-message acceptance, not merely before it fires.
    const { createTaskStore } = require('../extensions/scheduler/task-store.cjs');
    const store = createTaskStore({ stateFile: h.stateFile, sanitize: core.sanitizeTasks });
    await store.transact(tasks => {
      const task = tasks[0]; core.markScheduledTaskRunning(tasks, task.id);
      core.markScheduledTaskCompleted(tasks, task.id, new Date(), { ok: true, wakeDisposition: 'pending', attemptId: 'queued-fixture' });
      task.pendingWake = { id: 'queued-fixture', content: 'old queued body', sessionFile: h.context.sessionManager.getSessionFile(), ownerPid: process.pid, state: 'queued', createdAt: new Date().toISOString() };
    });
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    assert.ok((await h.tasks())[0].pendingWake.content.endsWith(BODY));
    await h.commands.scheduler.handler('resume', h.context);
    await until(() => h.wakes.length === 1, 'edited wake');
    assert.ok(h.wakes[0].text.endsWith(BODY)); assert.equal((await h.tasks())[0].runCount, 1);
  } finally { await h.close(); }
});


test('picker and /schedules expose editing; non-UI and changed-session edits do not write', async () => {
  const h = await harness(root, async () => ({ code: 0 }));
  const notices = ui(h, async () => BODY, async (title, choices) => title === '任务操作' ? '编辑提示词' : choices[0]);
  try {
    await h.start(); await h.call('schedule_task', { action: 'prompt', schedule: '1h', prompt: 'old', name: '任务甲' });
    await h.commands.schedules.handler('', h.context); assert.equal((await h.tasks())[0].prompt, BODY);
    h.context.ui.editor = async () => { await h.events.session_shutdown({}, h.context); await h.start(); return 'stale session text'; };
    await h.commands['schedule-edit'].handler('任务甲', h.context); assert.equal((await h.tasks())[0].prompt, BODY);
    assert.match(notices.at(-1).text, /会话已变化/);
    h.context.hasUI = false; await h.commands['schedule-edit'].handler('任务甲', h.context);
    assert.match(notices.at(-1).text, /requires UI/);
  } finally { await h.close(); }
});

test('running shell prompt edits affect the pending result but do not execute another command', async () => {
  let finish, calls = 0;
  const h = await harness(root, async () => { calls++; return await new Promise(resolve => { finish = resolve; }); });
  ui(h, async () => BODY);
  try {
    await h.start(); const created = await h.call('schedule_task', { action: 'shell', schedule: '0.01s', command: 'synthetic wait', followUpPrompt: 'old' });
    await until(() => Boolean(finish), 'running command');
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    finish({ code: 0, stdout: 'done', stderr: '' });
    await until(() => h.wakes.length === 1, 'updated follow-up');
    assert.ok(h.wakes[0].text.endsWith(BODY)); assert.equal(calls, 1);
  } finally { finish?.({ code: 0 }); await h.close(); }
});


test('queued shell result keeps output/identity, blank optional prompt can clear, and name ambiguity requires selection', async () => {
  const h = await harness(root, async () => ({ code: 0 }));
  const notices = ui(h, async () => BODY);
  try {
    await h.start(); await h.commands.scheduler.handler('pause', h.context);
    const created = await h.call('schedule_task', { action: 'shell', schedule: '1h', command: 'synthetic', followUpPrompt: 'old', name: 'duplicate' });
    const { createTaskStore } = require('../extensions/scheduler/task-store.cjs');
    const store = createTaskStore({ stateFile: h.stateFile, sanitize: core.sanitizeTasks });
    await store.transact(tasks => {
      const task = tasks[0]; core.markScheduledTaskRunning(tasks, task.id);
      core.markScheduledTaskCompleted(tasks, task.id, new Date(), { ok: false, code: 1, stdout: 'IMPORTANT EVIDENCE', cwd: h.context.cwd, wakeDisposition: 'pending', attemptId: 'shell-queued' });
      task.pendingWake = { id: 'shell-queued', content: 'old', sessionFile: h.context.sessionManager.getSessionFile(), ownerPid: process.pid, state: 'queued', createdAt: new Date().toISOString() };
    });
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    const task = (await h.tasks())[0]; assert.equal(task.pendingWake.id, 'shell-queued'); assert.equal(task.pendingWake.state, 'queued');
    assert.match(task.pendingWake.content, /IMPORTANT EVIDENCE/); assert.ok(task.pendingWake.content.endsWith(BODY));
    h.context.ui.editor = async () => ' \n ';
    await h.commands['schedule-edit'].handler(created.details.task.id, h.context);
    assert.equal((await h.tasks())[0].followUpPrompt, undefined);
    const another = await h.call('schedule_task', { action: 'prompt', schedule: '1h', prompt: 'other', name: 'duplicate' });
    h.context.ui.select = async () => undefined; h.context.ui.editor = async () => 'wrong target';
    await h.commands['schedule-edit'].handler('duplicate', h.context);
    assert.equal((await h.tasks()).find(t => t.id === another.details.task.id).prompt, 'other');
    assert.ok(!notices.some(n => n.level === 'error'));
  } finally { await h.close(); }
});
