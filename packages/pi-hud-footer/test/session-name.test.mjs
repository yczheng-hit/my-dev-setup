import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed @earendil-works/pi-coding-agent directory');
const { createJiti } = await import(pathToFileURL(path.join(host, 'node_modules/jiti/lib/jiti.mjs')));
const tuiEntry = path.join(host, 'node_modules/@earendil-works/pi-tui/dist/index.js');
const piEntry = path.join(host, 'dist/index.js');
const jiti = createJiti(import.meta.url, {
  alias: { '@earendil-works/pi-tui': tuiEntry, '@earendil-works/pi-coding-agent': piEntry },
});
const { SessionManager } = await import(pathToFileURL(piEntry));
const { visibleWidth } = await import(pathToFileURL(tuiEntry));
const stripAnsi = text => text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');
const { initTheme, getThemeByName, getEditorTheme } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
const theme = getThemeByName('dark');
const { normalizeSessionName, sessionNameText, registerRenameCommand } = await jiti.import('../extensions/hud-footer/session-name.ts');
const { createHudFooter, renderHudTopBorderSegments } = await jiti.import('../extensions/hud-footer/render.ts');
const { createHudEditorFactory } = await jiti.import('../extensions/hud-footer/editor.ts');
const { DEFAULT_CONFIG } = await jiti.import('../extensions/hud-footer/config.ts');
const { default: extension } = await jiti.import('../extensions/custom-footer.ts');

function fixture({ session = SessionManager.inMemory('/tmp/project'), language = 'en', hasUI = true, input } = {}) {
  const commands = new Map();
  const notifications = [];
  const prompts = [];
  let writes = 0;
  const pi = {
    getThinkingLevel: () => 'high',
    getSessionName: () => session.getSessionName(),
    setSessionName: name => { writes++; session.appendSessionInfo(name); },
    registerCommand: (name, command) => commands.set(name, command),
  };
  const ctx = {
    cwd: '/tmp/project', mode: 'tui', hasUI, sessionManager: session,
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000 }),
    ui: {
      theme,
      notify: (text, level) => notifications.push({ text, level }),
      input: async (...args) => { prompts.push(args); return input; },
    },
  };
  registerRenameCommand(pi, () => language, language);
  const config = { ...DEFAULT_CONFIG, language };
  const state = {};
  let renders = 0;
  const tui = { requestRender: () => renders++, terminal: { columns: 120 } };
  const footerData = { getGitBranch: () => 'main', getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
  const footer = createHudFooter(pi, ctx, config, () => false, () => undefined, () => undefined, state)(tui, theme, footerData);
  const keybindings = { matches: () => false, getKeys: () => [], getDisplayString: () => '' };
  const editor = createHudEditorFactory(pi, ctx, { ...config, style: 'border' }, () => false, () => undefined, () => undefined, state)(tui, getEditorTheme(), keybindings);
  return { pi, ctx, config, state, footer, editor, notifications, prompts, rename: commands.get('rename').handler, writes: () => writes, renders: () => renders };
}

test('normalizes only like Pi: folds newlines, trims ends, preserves internal spaces', () => {
  assert.equal(normalizeSessionName('  中文\r\nHUD  test  '), '中文 HUD  test');
  assert.equal(normalizeSessionName(undefined), '');
});

test('unnamed sessions omit the HUD name; names have localized labels', () => {
  assert.equal(sessionNameText(undefined, theme, 'en'), undefined);
  assert.equal(sessionNameText(' \n ', theme, 'zh'), undefined);
  assert.equal(stripAnsi(sessionNameText('中文会话', theme, 'zh')), '会话:中文会话');
});

test('long names truncate by terminal columns, not characters, without changing storage', async () => {
  const f = fixture();
  const name = '讨论中文🙂'.repeat(20);
  await f.rename(name, f.ctx);
  const shown = stripAnsi(sessionNameText(f.pi.getSessionName(), theme, 'en'));
  assert.ok(shown.endsWith('…'));
  assert.ok(visibleWidth(shown) <= 40);
  assert.equal(f.pi.getSessionName(), name);
});

test('/rename with args saves normalized name and immediately changes both HUD renderers', async () => {
  const f = fixture();
  await f.rename('  HUD\r\n会话  ', f.ctx);
  assert.equal(f.pi.getSessionName(), 'HUD 会话');
  assert.equal(f.prompts.length, 0);
  assert.match(stripAnsi(f.footer.render(180).join('\n')), /session:HUD 会话/);
  assert.match(stripAnsi(f.editor.render(180).join('\n')), /session:HUD 会话/);
  assert.match(f.notifications.at(-1).text, /Session renamed: HUD 会话/);
});

test('/rename without args prompts with current name as placeholder', async () => {
  const f = fixture({ input: '新名称', language: 'zh' });
  f.pi.setSessionName('旧名称');
  await f.rename('', f.ctx);
  assert.deepEqual(f.prompts, [['重命名会话', '旧名称']]);
  assert.equal(f.pi.getSessionName(), '新名称');
});

for (const input of [undefined, '', '  \n ']) {
  test(`cancelled/empty dialog (${JSON.stringify(input)}) never clears existing name`, async () => {
    const f = fixture({ input });
    f.pi.setSessionName('Keep me');
    await f.rename('', f.ctx);
    assert.equal(f.pi.getSessionName(), 'Keep me');
    assert.equal(f.writes(), 1);
  });
}

test('same-name rename does not append redundant session entries', async () => {
  const f = fixture();
  f.pi.setSessionName('Keep me');
  await f.rename(' Keep me ', f.ctx);
  assert.equal(f.writes(), 1);
});

test('non-UI /rename without args shows usage, does not prompt or alter name', async () => {
  const f = fixture({ hasUI: false });
  await f.rename('', f.ctx);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes(), 0);
  assert.match(f.notifications.at(-1).text, /Usage: \/rename/);
  await f.rename('RPC name', f.ctx);
  assert.equal(f.pi.getSessionName(), 'RPC name');
});

test('display.sessionName disables the segment in both styles', async () => {
  const f = fixture();
  await f.rename('Hidden name', f.ctx);
  f.config.display = { all: { sessionName: false } };
  assert.doesNotMatch(stripAnsi(f.footer.render(180).join('\n')), /Hidden name/);
  const border = renderHudTopBorderSegments(f.pi, f.ctx, { ...f.config, style: 'border' }, theme, () => 'main');
  assert.doesNotMatch(stripAnsi(border.right), /Hidden name/);
});

test('both renderers respect terminal width including long Unicode names', async () => {
  const f = fixture();
  await f.rename('中文🙂'.repeat(20), f.ctx);
  for (const width of [20, 40, 80, 120, 180]) {
    for (const line of [...f.footer.render(width), ...f.editor.render(width)]) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
});

test('real persisted SessionManager retains the name after reopening; unrelated sessions do not inherit it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-name-'));
  try {
    const session = SessionManager.create(dir, dir);
    session.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture' }], api: 'openai-responses', provider: 'fixture', model: 'fixture',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now() });
    const f = fixture({ session });
    await f.rename('Persistent 中文 name', f.ctx);
    const reopened = SessionManager.open(session.getSessionFile());
    assert.equal(reopened.getSessionName(), 'Persistent 中文 name');
    const resumed = fixture({ session: reopened });
    assert.match(stripAnsi(resumed.footer.render(180).join('\n')), /Persistent 中文 name/);
    assert.equal(SessionManager.inMemory(dir).getSessionName(), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extension registers /rename and redraws on native session_info_changed', () => {
  const active = Symbol.for('pi-hud-footer.active');
  delete globalThis[active];
  const f = fixture();
  const events = new Map();
  const commands = new Map();
  const pi = { ...f.pi, on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command) };
  let footer;
  let renders = 0;
  const ctx = { ...f.ctx, ui: { ...f.ctx.ui, setFooter: factory => {
    footer = factory({ requestRender: () => renders++ }, theme, {
      getGitBranch: () => 'main', getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
    });
  } } };
  try {
    extension(pi);
    events.get('session_start')({}, ctx);
    assert.ok(commands.has('rename'));
    pi.setSessionName('Native /name also works');
    events.get('session_info_changed')({ type: 'session_info_changed', name: pi.getSessionName() }, ctx);
    assert.equal(renders, 1);
    assert.match(stripAnsi(footer.render(180).join('\n')), /Native \/name also works/);
  } finally { delete globalThis[active]; }
});
