import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed @earendil-works/pi-coding-agent directory');
const { createJiti } = await import(pathToFileURL(path.join(host, 'node_modules/jiti/lib/jiti.mjs')));
const piEntry = path.join(host, 'dist/index.js');
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': piEntry } });
const { SessionManager } = await import(pathToFileURL(piEntry));
const { forkPoints, saveFork, defaultForkName, normalizeName } = await jiti.import('../extensions/fork-save.ts');
const { default: extension, registerForkSave } = await jiti.import('../extensions/index.ts');

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = text => ({ role: 'user', content: text, timestamp: Date.now() });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-responses', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: Date.now() });

async function withSession(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fork-save-'));
  try {
    const session = SessionManager.create(dir, dir);
    session.appendMessage(user('first question'));
    session.appendMessage(assistant('first answer'));
    session.appendMessage(user('second\nquestion'));
    session.appendMessage(assistant('second answer'));
    return await fn(session, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function texts(manager) {
  return manager.getBranch().filter(e => e.type === 'message').map(e => typeof e.message.content === 'string' ? e.message.content : e.message.content[0].text);
}

test('fork points: current position first, then earlier rounds newest first', () => withSession(session => {
  const points = forkPoints(session.getBranch());
  assert.equal(points.length, 2);
  assert.equal(points[0].leafId, session.getLeafId());
  assert.match(points[1].label, /第 1 轮.*first question/);
  assert.equal(session.getEntry(points[1].leafId).message.content[0].text, 'first answer');
  assert.deepEqual(forkPoints([]), []);
}));

test('saves the whole branch to a new file without touching the running session', () => withSession((session, dir) => {
  const source = session.getSessionFile();
  const before = readFileSync(source, 'utf8');
  const saved = saveFork(source, dir, session.getLeafId(), 'side quest');
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.equal(session.getSessionFile(), source);
  assert.notEqual(saved.id, session.getSessionId());
  assert.equal(path.dirname(saved.file), dir);
  const fork = SessionManager.open(saved.file);
  assert.equal(fork.getSessionId(), saved.id);
  assert.equal(fork.getSessionName(), 'side quest');
  assert.equal(fork.getHeader().parentSession, source);
  assert.deepEqual(texts(fork), ['first question', 'first answer', 'second\nquestion', 'second answer']);
  assert.ok(SessionManager.findById(dir, saved.id, dir));
}));

test('saves only up to an earlier round when chosen', () => withSession((session, dir) => {
  const saved = saveFork(session.getSessionFile(), dir, forkPoints(session.getBranch())[1].leafId, '');
  const fork = SessionManager.open(saved.file);
  assert.deepEqual(texts(fork), ['first question', 'first answer']);
  assert.equal(fork.getSessionName(), undefined);
}));

test('unknown or unsaved fork points fail without creating files', () => withSession((session, dir) => {
  assert.throws(() => saveFork(session.getSessionFile(), dir, 'missing', 'x'), /还没有写入/);
  assert.throws(() => saveFork(path.join(dir, 'none.jsonl'), dir, 'x', 'x'), /还没有写入文件/);
}));

test('names: normalized like Pi, default uses session name or cwd basename', () => {
  assert.equal(normalizeName('  a\r\nb  '), 'a b');
  const now = new Date(2026, 0, 2, 3, 4);
  assert.equal(defaultForkName('Main', '/x/proj', now), 'Main · fork 01-02 03:04');
  assert.equal(defaultForkName(undefined, '/x/proj', now), 'proj · fork 01-02 03:04');
});

test('/fork-save command: picker choice, notification, foreground unchanged', async () => withSession(async (session, dir) => {
  const commands = new Map();
  const copied = [];
  registerForkSave({ registerCommand: (name, command) => commands.set(name, command) }, async text => { copied.push(text); });
  const defaults = new Map();
  extension({ registerCommand: (name, command) => defaults.set(name, command) });
  assert.ok(defaults.has('fork-save'));
  const notes = [];
  let selectArgs;
  const ctx = {
    cwd: dir, hasUI: true, sessionManager: session, isIdle: () => true,
    ui: {
      notify: (text, level) => notes.push({ text, level }),
      select: async (title, options) => { selectArgs = { title, options }; return options[1]; },
    },
  };
  const leaf = session.getLeafId();
  await commands.get('fork-save').handler('  named fork ', ctx);
  assert.equal(selectArgs.options.length, 2);
  assert.equal(session.getLeafId(), leaf);
  assert.equal(notes.at(-1).level, 'info');
  const id = notes.at(-1).text.match(/会话 ID：([\w.-]+)/)[1];
  assert.match(notes.at(-1).text, /仅会话 ID 已复制到剪贴板/);
  const fork = SessionManager.open(SessionManager.findById(dir, id, dir));
  assert.deepEqual(copied, [id]);
  assert.match(notes.at(-1).text, new RegExp(`pi --session ${id}`));
  assert.equal(fork.getSessionName(), 'named fork');
  assert.deepEqual(texts(fork), ['first question', 'first answer']);

  ctx.ui.select = async () => undefined;
  const count = notes.length;
  await commands.get('fork-save').handler('', ctx);
  assert.equal(notes.length, count, 'cancel does nothing');

  await commands.get('fork-save').handler('', { ...ctx, sessionManager: { getSessionFile: () => undefined } });
  assert.equal(notes.at(-1).level, 'error');
}));

test('fork preserves context, labels, compaction and settings on the active branch only', () => withSession((session, dir) => {
  const first = session.getBranch()[0].id;
  session.appendModelChange('fixture', 'fixture');
  session.appendThinkingLevelChange('high');
  const kept = session.appendMessage(user('kept'));
  session.appendMessage(assistant('kept answer'));
  session.appendLabelChange(kept, 'kept label');
  session.appendCompaction('summary of the earlier rounds', kept, 1000);
  session.appendCustomEntry('fixture-state', { count: 7 });
  session.appendCustomMessageEntry('fixture-message', 'context addition', true);
  session.appendSessionInfo('Main');
  const target = session.getLeafId();
  const context = session.buildSessionContext();
  // An abandoned branch is on disk but must not go into the fork.
  session.branch(first);
  session.appendMessage(user('abandoned branch'));
  session.branch(target);
  const before = readFileSync(session.getSessionFile(), 'utf8');
  const saved = saveFork(session.getSessionFile(), dir, target, 'Fork');
  const fork = SessionManager.open(saved.file);
  assert.deepEqual(fork.buildSessionContext(), context);
  assert.equal(fork.getLabel(kept), 'kept label');
  assert.equal(fork.getSessionName(), 'Fork');
  assert.ok(!texts(fork).includes('abandoned branch'));
  assert.equal(readFileSync(session.getSessionFile(), 'utf8'), before);
  fork.appendMessage(user('fork-only continuation'));
  session.appendMessage(user('main-only continuation'));
  assert.ok(!texts(fork).includes('main-only continuation'));
  assert.ok(!texts(session).includes('fork-only continuation'));
}));

test('command rejects streaming, handles cancel and clipboard failure, saves current branch in non-UI mode', async () => withSession(async (session, dir) => {
  const commands = new Map();
  registerForkSave({ registerCommand: (name, command) => commands.set(name, command) }, async () => { throw new Error('no clipboard'); });
  const notes = [];
  const ctx = {
    cwd: dir, hasUI: false, sessionManager: session, isIdle: () => false,
    ui: { notify: (text, level) => notes.push({ text, level }) },
  };
  await commands.get('fork-save').handler('', ctx);
  assert.match(notes.at(-1).text, /请等当前回复结束/);
  ctx.isIdle = () => true;
  await commands.get('fork-save').handler('', ctx);
  assert.equal(notes.at(-1).level, 'info');
  assert.doesNotMatch(notes.at(-1).text, /已复制/);
  const id = notes.at(-1).text.match(/会话 ID：([\w.-]+)/)[1];
  const fork = SessionManager.open(SessionManager.findById(dir, id, dir));
  assert.deepEqual(texts(fork), texts(session));
  assert.match(fork.getSessionName(), /fork \d{2}-\d{2} \d{2}:\d{2}/);
}));


test('saved fork resets all inherited token and cost accounting, but retains conversation context', () => withSession((session, dir) => {
  const billed = (n) => ({
    input: n, output: n + 1, cacheRead: n + 2, cacheWrite: n + 3,
    cacheWrite1h: n + 4, reasoning: n + 5, totalTokens: n * 4 + 6,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
  session.appendMessage({ ...assistant('priced answer'), usage: billed(9) });
  session.appendMessage({ role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [{ type: 'text', text: 'tool output' }], isError: false, usage: billed(8), timestamp: Date.now() });
  session.appendUsage('cache_warm', 'fixture', 'fixture', billed(7));
  session.appendCompaction('prior context', session.getBranch()[0].id, 1000, undefined, false, billed(6));
  session.branchWithSummary(session.getLeafId(), 'other branch summary', undefined, false, billed(5));
  session.appendMessage(user('unbilled continuation'));
  const before = readFileSync(session.getSessionFile(), 'utf8');
  const sourceContext = session.buildSessionContext();
  const saved = saveFork(session.getSessionFile(), dir, session.getLeafId(), 'Unbilled');
  assert.equal(readFileSync(session.getSessionFile(), 'utf8'), before);
  const fork = SessionManager.open(saved.file);
  assert.deepEqual(texts(fork), texts(session));
  assert.equal(fork.getBranch().length, session.getBranch().length + 1); // new name
  const billedEntries = fork.getEntries().filter(e => e.type === 'usage' || (e.type === 'message' && ['assistant', 'toolResult'].includes(e.message.role)) || ['compaction', 'branch_summary'].includes(e.type));
  assert.ok(billedEntries.length >= 5);
  for (const entry of billedEntries) {
    const usage = entry.type === 'message' ? entry.message.usage : entry.usage;
    if (!usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens']) {
      if (key in usage) assert.equal(usage[key], 0, `${entry.type}.${key}`);
    }
    assert.ok(Object.values(usage.cost).every(v => v === 0));
  }
  // The copied content, compaction summary and model settings remain available.
  assert.deepEqual(fork.buildSessionContext().messages.map(m => [m.role, m.content]), sourceContext.messages.map(m => [m.role, m.content]));
  fork.appendMessage({ ...assistant('new bill'), usage: billed(3) });
  const newUsage = fork.getEntries().at(-1).message.usage;
  assert.equal(newUsage.input, 3);
  assert.equal(newUsage.cost.total, 10);
}));

test('image-only user messages still mark round boundaries', () => {
  const branch = [
    { id: 'u1', type: 'message', message: user('before image') },
    { id: 'a1', type: 'message', message: assistant('answer') },
    { id: 'u2', type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } },
    { id: 'a2', type: 'message', message: assistant('image answer') },
    { id: 'u3', type: 'message', message: user('after image') },
  ];
  const points = forkPoints(branch);
  assert.deepEqual(points.map(p => p.leafId), ['u3', 'a2', 'a1']);
  assert.match(points[1].label, /图片或空消息/);
});
