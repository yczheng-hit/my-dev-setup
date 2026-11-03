const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');
const { harness, until } = require('./helpers/runtime-harness.cjs');
const root = __dirname + '/..';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function ui(h, draft = '') {
  const notices = [], statuses = [];
  Object.assign(h.context, { hasUI: true, hasPendingMessages: () => false, ui: { getEditorText: () => draft, onTerminalInput: () => () => {}, setStatus: (_key, text) => statuses.push(text), setWidget() {}, notify: text => notices.push(text), select: async () => undefined } });
  return { notices, statuses, setDraft: value => { draft = value; } };
}
test('ambiguous IDs/names never cancel the first match; exact identity wins', () => {
  const tasks = [{ id: 'task_aa', name: 'CI' }, { id: 'task_ab', name: 'CI' }];
  assert.throws(() => core.cancelScheduledTask(tasks, 'task_a'), /ambiguous|歧义/i);
  assert.throws(() => core.cancelScheduledTask(tasks, ''), /required|不能为空/i);
  assert.throws(() => core.cancelScheduledTask(tasks, 'CI'), /ambiguous|歧义/i);
  assert.equal(core.cancelScheduledTask(tasks, 'task_ab').id, 'task_ab');
  tasks[0].name = 'deploy'; assert.equal(core.cancelScheduledTask(tasks, 'deploy').id, 'task_aa');
});
test('unsubmitted draft defers workspace shell and prompt, cancellation needs no remembered ID', async () => {
  let executions = 0;
  const h = await harness(root, async () => { executions++; return { code: 0 }; });
  const state = ui(h, 'half a steer');
  try {
    await h.start();
    const shell = (await h.call('schedule_task', { action: 'shell', command: 'build', schedule: '0.01s', name: 'build' })).details.task;
    await h.call('schedule_task', { action: 'prompt', prompt: 'check', schedule: '0.01s', name: 'check' });
    await delay(400); assert.equal(executions, 0); assert.equal(h.wakes.length, 0);
    h.context.ui.select = async (_title, options) => options.find(text => text.includes(shell.id));
    await h.commands['schedule-cancel'].handler('', h.context);
    assert.equal((await h.tasks()).find(t => t.id === shell.id).status, 'cancelled');
    state.setDraft(''); await h.commands['scheduler'].handler('resume', h.context);
    await until(() => h.wakes.length === 1, 'deferred prompt delivered'); assert.equal(executions, 0);
  } finally { await h.close(); }
});
test('background shell finishes while typing; pending wake persists and can be cancelled by name', async () => {
  const h = await harness(root, async () => ({ code: 1, stdout: 'failure' }));
  const state = ui(h, 'draft');
  try {
    await h.start();
    const task = (await h.call('schedule_task', { action: 'shell', command: 'ci', name: 'CI watch', schedule: '0.01s', backgroundExecution: true, wakeOn: 'always' })).details.task;
    await until(async () => (await h.tasks())[0]?.pendingWake, 'persistent pending wake');
    assert.equal(h.wakes.length, 0);
    await h.call('cancel_scheduled_task', { id: 'CI watch' });
    state.setDraft(''); await h.commands.scheduler.handler('resume', h.context); await delay(800);
    assert.equal(h.wakes.length, 0); assert.equal((await h.tasks())[0].pendingWake, undefined);
    assert.equal((await h.tasks())[0].id, task.id);
  } finally { await h.close(); }
});
test('queued human messages and prompts defer wakes; delivery never uses Pi followUp', async () => {
  const h = await harness(root, async () => ({ code: 0 }));
  ui(h); let pending = true;
  h.context.hasPendingMessages = () => pending;
  try {
    await h.start(); await h.call('schedule_task', { action: 'prompt', prompt: 'timer', schedule: '0.01s' });
    await delay(400); assert.equal(h.wakes.length, 0);
    pending = false; await h.events.ui_prompt_start({ kind: 'editor' }, h.context);
    await delay(700); assert.equal(h.wakes.length, 0);
    await h.events.ui_prompt_end({}, h.context); await h.commands.scheduler.handler('resume', h.context);
    await until(() => h.wakes.length === 1, 'safe delivery'); assert.equal(h.wakes[0].options, undefined);
  } finally { await h.close(); }
});


test('stale picker selection cannot cancel an edited task', async () => {
  const h = await harness(root, async () => ({ code: 0 })); ui(h);
  try {
    await h.start(); const task = (await h.call('schedule_task', { action: 'notify', message: 'x', schedule: '1h', name: 'original' })).details.task;
    h.context.ui.select = async (_title, options) => { await h.call('manage_scheduled_task', { action: 'update', id: task.id, name: 'edited' }); return options[0]; };
    await h.commands['schedule-cancel'].handler('', h.context);
    assert.notEqual((await h.tasks())[0].status, 'cancelled');
  } finally { await h.close(); }
});
test('reload retains queued wake for same session, never redirects to a different session', async () => {
  const h = await harness(root, async () => ({ code: 0 })); const state = ui(h, 'draft');
  try {
    await h.start(); await h.call('schedule_task', { action: 'shell', command: 'ci', schedule: '0.01s', backgroundExecution: true, wakeOn: 'always' });
    await until(async () => (await h.tasks())[0]?.pendingWake, 'queued');
    await h.events.session_shutdown({}, h.context);
    const file = h.context.sessionManager.getSessionFile();
    h.context.sessionManager.getSessionFile = () => file + '-other';
    state.setDraft(''); await h.start(); await delay(700); assert.equal(h.wakes.length, 0);
    await h.events.session_shutdown({}, h.context); h.context.sessionManager.getSessionFile = () => file;
    await h.start(); await until(() => h.wakes.length === 1, 'same-session resume');
    await delay(700); assert.equal(h.wakes.length, 1);
  } finally { await h.close(); }
});

test('stable short suffix resolves only one task and rejects collisions', () => {
  const tasks = [{ id: 'task_timeA_abc123' }, { id: 'task_timeB_xyz789' }];
  assert.equal(core.shortTaskId(tasks[0].id), 'abc123');
  assert.equal(core.findTask(tasks, '#abc123').id, tasks[0].id);
  assert.equal(core.findTask(tasks, 'xyz789').id, tasks[1].id);
  tasks.push({ id: 'task_timeC_abc123' });
  assert.throws(() => core.findTask(tasks, '#abc123'), /ambiguous/);
});

test('ambiguous persisted dispatch is exposed as uncertain and never replayed automatically', async () => {
  const fs = require('node:fs/promises');
  const h = await harness(root, async () => ({ code: 0 })); const state = ui(h, 'draft');
  try {
    await h.start(); await h.call('schedule_task', { action: 'shell', command: 'ci', schedule: '0.01s', backgroundExecution: true, wakeOn: 'always' });
    await until(async () => (await h.tasks())[0]?.pendingWake, 'queued result');
    await h.events.session_shutdown({}, h.context);
    const store = JSON.parse(await fs.readFile(h.stateFile, 'utf8'));
    store.tasks[0].pendingWake.state = 'dispatching';
    await fs.writeFile(h.stateFile, JSON.stringify(store));
    state.setDraft(''); await h.start(); await delay(750);
    assert.equal(h.wakes.length, 0);
    assert.equal((await h.tasks())[0].pendingWake.state, 'uncertain');
    assert.match((await h.call('list_scheduled_tasks', {})).content[0].text, /uncertain/);
    await h.call('cancel_scheduled_task', { id: store.tasks[0].id });
    assert.equal((await h.tasks())[0].pendingWake, undefined);
  } finally { await h.close(); }
});

test('running cancel allows completion, explicit owned terminate aborts only its command', async () => {
  let resolveCommand; let signal;
  const h = await harness(root, async (_command, _args, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveCommand = resolve; signal.addEventListener('abort', () => resolve({ code: 1, killed: true }), { once: true }); });
  }); ui(h);
  try {
    await h.start();
    const task = (await h.call('schedule_task', { action: 'shell', command: 'slow', schedule: '0.01s', backgroundExecution: true, wakeOn: 'always', name: 'running' })).details.task;
    await until(() => signal, 'command start');
    await h.call('cancel_scheduled_task', { id: task.id }); assert.equal(signal.aborted, false);
    resolveCommand({ code: 0 }); await until(async () => !(await h.tasks())[0].runOwner, 'cancelled run completion');
    assert.equal(h.wakes.length, 0);
    signal = undefined;
    const second = (await h.call('schedule_task', { action: 'shell', command: 'slow', schedule: '0.01s', backgroundExecution: true, name: 'owned' })).details.task;
    await until(() => signal, 'second command start');
    h.context.ui.select = async (title, options) => title === '任务操作' ? '终止本机正在运行的命令' : options.find(text => text.includes(second.id));
    await h.commands.schedules.handler('', h.context);
    assert.equal(signal.aborted, true);
    await until(async () => !(await h.tasks()).find(task => task.id === second.id).runOwner, 'owned run termination');
    assert.equal((await h.tasks()).find(task => task.id === second.id).status, 'cancelled');
  } finally { resolveCommand?.({ code: 0 }); await h.close(); }
});

test('task menu can enable disabled pending tasks and reports stale action without throwing', async () => {
  const h = await harness(root, async () => ({ code: 0 })); const state = ui(h);
  try {
    await h.start();
    const task = (await h.call('schedule_task', { action: 'notify', message: 'x', schedule: '1h', name: 'toggle' })).details.task;
    await h.call('manage_scheduled_task', { action: 'disable', id: task.id });
    h.context.ui.select = async (title, options) => title === '任务操作' ? '启用' : options.find(text => text.includes(task.id));
    await h.commands.schedules.handler('', h.context);
    assert.equal((await h.tasks())[0].enabled, true, 'disabled pending tasks remain selectable');
    h.context.ui.select = async (title, options) => {
      if (title !== '任务操作') return options.find(text => text.includes(task.id));
      await h.call('manage_scheduled_task', { action: 'update', id: task.id, name: 'newer' });
      return '取消调度和待交付结果';
    };
    await h.commands.schedules.handler('', h.context);
    assert.notEqual((await h.tasks())[0].status, 'cancelled');
    assert.ok(state.notices.some(text => text.includes('任务已变化')));
  } finally { await h.close(); }
});
