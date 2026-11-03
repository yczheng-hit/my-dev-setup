import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const require = createRequire(path.join(host, 'package.json'));
const tuiPath = require.resolve('@earendil-works/pi-tui');
const { TuiAltScreen, Container, Text, visibleWidth } = await import(pathToFileURL(tuiPath));
const load = (name) => import(pathToFileURL(path.join(host, `dist/modes/interactive/${name}.js`)));
const { createInteractiveTuiReference } = await load('tui-renderer');
const { createChatViewport } = await load('chat-viewport');
const { AssistantMessageComponent } = await load('components/assistant-message');
const { initTheme } = await load('theme/theme');
initTheme('dark', false);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { '@earendil-works/pi-tui': tuiPath } });
const { default: extension } = await jiti.import('../extensions/index.ts');
const { installNavigation, resolveRenderer } = await jiti.import('../extensions/navigation.ts');
const msg = (timestamp = 1) => ({ role: 'assistant', timestamp, provider: 'fixture', model: 'fixture', stopReason: 'stop',
  content: [{ type: 'text', text: 'final text\n\n'.repeat(50) }] });

function renderer(t) {
  const tui = new TuiAltScreen({ columns: 50, rows: 15, write() {}, hideCursor() {} }, false);
  tui.stopped = false; tui.altScreenActive = true; tui.requestRender = () => {};
  const chat = new Container();
  const viewport = createChatViewport({ document: chat, pendingMessages: new Container(), status: new Container(),
    editor: new Text('editor', 0, 0), footer: new Text('footer', 0, 0), scrollbar: 'hidden' });
  tui.setLayoutRoot(viewport.root);
  t.after(() => { tui.stopped = true; tui.altScreenActive = false; });
  return { tui, chat, viewport, render: () => tui.doRender() };
}

test('actual stable TUI reference is unwrapped; renderer replacement and disposal are owned', (t) => {
  let active = renderer(t);
  const old = active.tui;
  const reference = createInteractiveTuiReference(() => active.tui);
  const before = Reflect.ownKeys(old);
  assert.equal(resolveRenderer(reference), old);
  assert.deepEqual(Reflect.ownKeys(old), before, 'temporary receiver probe must be removed');
  const nav = installNavigation(reference); t.after(() => nav.dispose());
  active = renderer(t); nav.refreshAttachment();
  assert.equal(Object.hasOwn(old, 'scrollToBottom'), false);
  assert.equal(Object.hasOwn(active.tui, 'scrollToBottom'), true);
  const m = msg(); active.chat.addChild(new AssistantMessageComponent(m));
  active.render(); active.tui.scrollToTop(); active.render(); nav.add('entry-1', m); active.render();
  active.tui.handleViewportInput('\x1b[1;5F'); active.render();
  assert.equal(active.tui.viewportTop, 1);
  assert.equal(active.tui.isFollowingOutput, false);
  nav.dispose(); assert.equal(Object.hasOwn(active.tui, 'scrollToBottom'), false);
});

test('regular/unknown renderers retain native behavior without prototype changes', () => {
  const warnings = [];
  const regular = { mode: 'regular', scrollToBottom() {} };
  const fn = regular.scrollToBottom;
  const nav = installNavigation(regular, { onUnsupported: (reason) => warnings.push(reason) });
  assert.equal(regular.scrollToBottom, fn); assert.equal(warnings.length, 0); nav.dispose();
  const unknown = { mode: 'fullscreen', scrollToBottom() {} };
  installNavigation(unknown, { onUnsupported: (reason) => warnings.push(reason) }).dispose();
  assert.equal(warnings.length, 1);
});

function runtime(t, mode = 'tui') {
  const f = renderer(t);
  const handlers = new Map(); const commands = new Map(); let widget; let branch = []; const notices = [];
  const pi = { on(name, fn) { handlers.set(name, fn); }, registerCommand(name, value) { commands.set(name, value); } };
  const ui = {
    setWidget(_key, value) { widget?.dispose?.(); widget = typeof value === 'function' ? value(f.tui, { fg: (_color, text) => text }) : undefined; },
    notify(text) { notices.push(text); },
  };
  const ctx = { mode, ui, sessionManager: { getBranch: () => branch } };
  extension(pi);
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(() => emit('session_shutdown'));
  const start = () => emit('session_start');
  const finish = async (m, { aborted = false, entry = true } = {}) => {
    f.chat.addChild(new AssistantMessageComponent(m));
    f.render();
    if (entry) branch.push({ id: `entry-${m.timestamp}`, type: 'message', message: m });
    await emit('message_end', { message: m });
    await emit('agent_settled', { aborted }); f.render();
  };
  return { ...f, emit, start, finish, commands, notices, widget: () => widget };
}

test('extension waits for true settlement, takes final native entry identity and ignores restored history', async (t) => {
  const f = runtime(t); await f.start();
  const m = msg();
  await f.emit('message_end', { message: m }); await f.emit('agent_end');
  assert.deepEqual(f.widget().render(40), []);
  await f.finish(m);
  assert.match(f.widget().render(80)[0], /1 unread final reply/);
  assert.ok(visibleWidth(f.widget().render(10)[0]) <= 10);
  await f.emit('session_tree');
  assert.deepEqual(f.widget().render(40), []);
  await f.emit('agent_settled', { aborted: false }); assert.deepEqual(f.widget().render(40), []);
  await f.finish(msg(2), { aborted: true }); assert.deepEqual(f.widget().render(40), []);
  await f.finish(msg(3), { entry: false }); assert.deepEqual(f.widget().render(40), []);
  await f.finish(msg(4)); assert.match(f.widget().render(80)[0], /1 unread/);
  await f.emit('session_shutdown'); assert.equal(f.widget(), undefined);
  assert.equal(Object.hasOwn(f.tui, 'doRender'), false);
});

test('nested prompt events keep reading blocked until the last prompt closes', async (t) => {
  const f = runtime(t); await f.start();
  const m = { ...msg(), content: [{ type: 'text', text: 'short answer' }] };
  await f.finish(m);
  await f.emit('ui_prompt_start'); await f.emit('ui_prompt_start');
  f.tui.scrollToBottom(); f.render();
  await f.emit('ui_prompt_end'); f.render();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.match(f.widget().render(80)[0], /1 unread/);
  await f.emit('ui_prompt_end'); f.render();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(f.widget().render(80), []);
});

test('headless runtime never installs a widget or renderer adapter', async (t) => {
  const f = runtime(t, 'json'); await f.start(); await f.finish(msg());
  assert.equal(f.widget(), undefined);
  assert.equal(Object.hasOwn(f.tui, 'scrollToBottom'), false);
});
