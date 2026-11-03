import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to an installed Pi 1.4+ host');
const require = createRequire(path.join(host, 'package.json'));
const tuiPath = require.resolve('@earendil-works/pi-tui');
const { TuiAltScreen, Container, Text, ScrollView } = await import(pathToFileURL(tuiPath));
const { AssistantMessageComponent } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/components/assistant-message.js')));
const { initTheme } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const nativeControl = process.env.UNREAD_NATIVE_CONTROL === '1';
const install = nativeControl ? undefined : (await jiti.import('../extensions/navigation.ts')).installNavigation;
const BOTTOM = '\x1b[1;5F';
let timestamp = 1000;
const message = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }],
  api: 'test', provider: 'fixture', model: 'fixture', timestamp: timestamp++, stopReason: 'stop', ...extra });
const longText = (n = 60) => Array.from({ length: n }, (_, i) => `Answer line ${i}: 中文 👩🏽‍💻 wide characters`).join('\n\n');

function fixture(t, { rows = 14, columns = 60, dwellMs = 5, limit } = {}) {
  const terminal = { rows, columns, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false);
  // Real renderer/layout/input paths, but no actual terminal start, session, or model.
  tui.stopped = false;
  tui.altScreenActive = true;
  tui.requestRender = () => {};
  const chat = new Container();
  tui.addChild(chat);
  tui.setLayoutRoot(new ScrollView(chat, { follow: 'end', primary: true, scrollbar: 'hidden' }));
  chat.addChild(new Text(Array.from({ length: 40 }, (_, i) => `history ${i}`).join('\n'), 0, 0));
  const counts = [];
  const errors = [];
  const nav = install?.(tui, { dwellMs, limit, onChange: (n) => counts.push(n), onUnsupported: (e) => errors.push(e) });
  t.after(() => { nav?.dispose(); tui.stopped = true; tui.altScreenActive = false; });
  const render = () => tui.doRender();
  const add = (msg = message(longText()), { streaming = false, thinking = false } = {}) => {
    const component = new AssistantMessageComponent(msg, !thinking);
    component.updateContent(msg, streaming);
    chat.addChild(component);
    render();
    return { msg, component };
  };
  const settle = (item, id = `entry-${item.msg.timestamp}`) => {
    nav?.add(id, item.msg);
    render();
  };
  const bodyRow = (component) => {
    const target = component.contentContainer.children.find((c) => c.constructor.name === 'Markdown');
    const find = (component, row = 0) => {
      if (component === target) return row;
      for (const child of component.mouseLayout?.children ?? []) {
        const found = find(child.component, row);
        if (found !== undefined) return found;
        row += child.height;
      }
    };
    return find(chat);
  };
  render();
  tui.scrollToTop(); render();
  return { tui, nav, chat, terminal, render, add, settle, bodyRow, errors, counts,
    bottom: () => { tui.handleViewportInput(BOTTOM); render(); },
    wait: () => new Promise((resolve) => setTimeout(resolve, dwellMs + 12)) };
}

test('human bottom goes to final body start, not the long answer tail; second jump acknowledges latest', (t) => {
  const f = fixture(t);
  const item = f.add();
  f.settle(item);
  const row = f.bodyRow(item.component);
  f.bottom();
  assert.equal(f.tui.viewportTop, row, 'first human bottom must show the beginning of the unread answer');
  assert.equal(f.tui.isFollowingOutput, false);
  if (nativeControl) return;
  assert.equal(f.nav.count, 1);
  f.bottom();
  assert.equal(f.tui.isFollowingOutput, true);
  assert.equal(f.nav.count, 0);
  assert.deepEqual(f.errors, []);
});

// Other tests are disabled only for the intentionally failing native negative control.
if (!nativeControl) {
  test('native indicator mouse click and keyboard use the same unread anchor', (t) => {
    const f = fixture(t);
    f.tui.scrollToEndIndicator = () => ' Jump to latest ';
    const item = f.add(); f.settle(item); f.render();
    const rect = f.tui.scrollToEndIndicatorRect;
    assert.ok(rect);
    assert.equal(f.tui.handleScrollToEndIndicatorMouseEvent({ x: rect.column, y: rect.row, button: 0, release: true }), false);
    f.tui.handleViewportInput(`\x1b[<0;${rect.column + 1};${rect.row + 1}M`); f.render();
    assert.equal(f.tui.viewportTop, f.bodyRow(item.component));
    f.bottom();
    assert.equal(f.tui.isFollowingOutput, true);
    assert.equal(f.nav.count, 0);
  });

  test('internal scrollToBottom remains native and cannot acknowledge unseen prefix', async (t) => {
    const f = fixture(t); const item = f.add(); f.settle(item);
    f.tui.scrollToBottom(); f.render(); await f.wait();
    assert.equal(f.tui.isFollowingOutput, true);
    assert.equal(f.nav.count, 1);
    f.bottom();
    assert.equal(f.tui.viewportTop, f.bodyRow(item.component));
  });

  test('only settled successful text is eligible, never streaming, tools, errors or summaries', (t) => {
    const f = fixture(t);
    for (const msg of [message('partial', { stopReason: 'aborted' }), message('failed', { stopReason: 'error' }),
      message('truncated', { stopReason: 'length' }), message('', { content: [{ type: 'thinking', thinking: 'private' }] }),
      message('tool', { content: [{ type: 'text', text: 'commentary' }, { type: 'toolCall', id: '1', name: 'bash', arguments: {} }] }),
      { role: 'compactionSummary', summary: 'not a reply' }]) f.nav.add(String(timestamp++), msg);
    assert.equal(f.nav.count, 0);
    const item = f.add(message(longText()), { streaming: true });
    f.settle(item);
    f.bottom();
    assert.equal(f.tui.isFollowingOutput, true);
    assert.equal(f.nav.count, 1, 'streaming component cannot become a readable final anchor');
    item.component.updateContent(item.msg, false); f.render();
    f.bottom();
    assert.equal(f.tui.viewportTop, f.bodyRow(item.component));
  });

  test('thinking expansion, preceding tool collapse, CJK resize recompute body location', (t) => {
    const f = fixture(t);
    const prior = new Text('tool output\n'.repeat(30), 0, 0); f.chat.addChild(prior);
    const item = f.add(message('', { content: [{ type: 'thinking', thinking: 'reasoning\n\n'.repeat(20) }, { type: 'text', text: longText() }] }), { thinking: true });
    f.settle(item);
    const before = f.bodyRow(item.component);
    prior.setText('collapsed'); item.component.setHideThinkingBlock(true);
    f.terminal.columns = 22; f.terminal.rows = 10; f.render();
    const after = f.bodyRow(item.component);
    assert.ok(after < before);
    f.bottom();
    assert.equal(f.tui.viewportTop, after);
    assert.equal(f.nav.count, 1);
    assert.equal(f.tui.isFollowingOutput, false);
  });

  test('earliest among multiple unread replies; explicit repeat acknowledges all', (t) => {
    const f = fixture(t);
    const first = f.add(); f.settle(first);
    const second = f.add(); f.settle(second);
    assert.equal(f.tui.viewportTop, 0, 'new completions must not steal history position');
    assert.equal(f.nav.count, 2);
    f.bottom(); assert.equal(f.tui.viewportTop, f.bodyRow(first.component));
    f.bottom(); assert.equal(f.nav.count, 0); assert.equal(f.tui.isFollowingOutput, true);
  });

  test('short answer is read only after an unobscured stable visible interval', async (t) => {
    const f = fixture(t); const item = f.add(message('short answer')); f.settle(item);
    f.tui.scrollToBottom(); f.render();
    assert.equal(f.nav.count, 1);
    await f.wait(); assert.equal(f.nav.count, 0);
  });

  test('all long-answer visible ranges are required; transient fly-by does not count', async (t) => {
    const f = fixture(t); const item = f.add(message(longText(30))); f.settle(item);
    f.bottom();
    f.tui.scrollToBottom(); f.render(); await f.wait();
    assert.equal(f.nav.count, 1, 'rendered start without dwell is not read');
    f.bottom(); await f.wait();
    assert.equal(f.nav.count, 1, 'start alone is not the whole answer');
    const sv = f.tui.getPrimaryScrollView();
    for (let row = f.bodyRow(item.component); row <= f.bodyRow(item.component) + item.component.render(f.terminal.columns).length; row += 8) {
      sv.scrollTo(row, { disableFollow: true }); f.render(); await f.wait();
    }
    assert.equal(f.nav.count, 0);
  });

  test('overlay, nested prompt gate and focus-out cannot mark an answer read', async (t) => {
    const f = fixture(t); const item = f.add(message('short answer')); f.settle(item);
    const overlay = f.tui.showOverlay(new Text('modal', 0, 0));
    f.tui.scrollToBottom(); f.render(); await f.wait(); assert.equal(f.nav.count, 1);
    overlay.hide(); f.nav.setBlocked(true); f.render(); await f.wait(); assert.equal(f.nav.count, 1);
    f.nav.setBlocked(false); f.tui.handleViewportInput('\x1b[O'); f.render(); await f.wait(); assert.equal(f.nav.count, 1);
    f.tui.handleViewportInput('\x1b[I'); f.render(); await f.wait(); assert.equal(f.nav.count, 0);
  });

  test('manual navigation away clears repeat-jump intent', (t) => {
    const f = fixture(t); const item = f.add(); f.settle(item);
    f.bottom();
    f.tui.handleViewportInput('\x1b[5~'); f.render(); // native page-up
    f.bottom();
    assert.equal(f.nav.count, 1); assert.equal(f.tui.viewportTop, f.bodyRow(item.component));
  });

  test('reset does not treat restored history as unread, bounded overflow stays visible', (t) => {
    const f = fixture(t, { limit: 2 });
    for (let i = 0; i < 5; i++) { const item = f.add(); f.settle(item); }
    assert.equal(f.nav.count, 5);
    f.bottom(); f.bottom(); assert.equal(f.nav.count, 0);
    const item = f.add(); f.settle(item); f.nav.reset(); f.render();
    assert.equal(f.nav.count, 0); f.bottom(); assert.equal(f.tui.isFollowingOutput, true);
  });

  test('dispose restores only owned methods and makes a later wrapper inert', (t) => {
    const f = fixture(t); const item = f.add(); f.settle(item);
    const installed = f.tui.scrollToBottom;
    const later = function () { return installed.call(this); };
    f.tui.scrollToBottom = later;
    f.nav.dispose(); f.nav.dispose();
    assert.equal(f.tui.scrollToBottom, later);
    f.bottom(); assert.equal(f.tui.isFollowingOutput, true);
    assert.equal(Object.hasOwn(f.tui, 'handleViewportInput'), false);
  });
  test('once an earlier short reply is fully read, the next jump targets the next unread, not bottom', async (t) => {
    const f = fixture(t);
    const first = f.add(message('short answer')); f.settle(first);
    const second = f.add(); f.settle(second);
    f.bottom(); await f.wait();
    assert.equal(f.nav.count, 1);
    f.bottom();
    assert.equal(f.tui.viewportTop, f.bodyRow(second.component));
    assert.equal(f.tui.isFollowingOutput, false);
  });

  test('range coverage is invalidated on reflow, rather than transferred to different lines', async (t) => {
    const f = fixture(t); const item = f.add(message(longText(20))); f.settle(item);
    f.bottom(); await f.wait();
    f.terminal.columns = 18; f.render();
    f.tui.scrollToBottom(); f.render(); await f.wait();
    assert.equal(f.nav.count, 1);
    f.bottom(); assert.equal(f.tui.viewportTop, f.bodyRow(item.component));
  });

  test('a pending reading timer cannot consume a marker after reset/dispose', async (t) => {
    const f = fixture(t); const item = f.add(message('short')); f.settle(item);
    f.tui.scrollToBottom(); f.render(); f.nav.reset(); f.nav.dispose();
    await f.wait();
    assert.equal(f.nav.count, 0);
    assert.equal(Object.hasOwn(f.tui, 'scrollToBottom'), false);
  });
}
