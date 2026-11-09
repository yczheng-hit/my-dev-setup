// Real Pi session/runner + real fullscreen layout, synthetic messages/providers only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const host = process.env.PI_HOST_DIR;
const repo = fileURLToPath(new URL('../..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(`Timed out: ${label}`);
}

test('AGENTS + independent reviewer + BTW + scheduler + unread + HUD share one synthetic session', { skip: !host, timeout: 20_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-composition-')));
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work'), home = path.join(root, 'home');
  for (const dir of [agentDir, cwd, home, path.join(cwd, '.agents/rules')]) fs.mkdirSync(dir, { recursive: true });
  const savedEnv = { ...process.env }; const oldCwd = process.cwd();
  for (const name of Object.keys(process.env)) if (/^(HERDR_|ANTHROPIC_|OPENAI_|PICC_|PI_|CLAUDE_|BTW_)/i.test(name)) delete process.env[name];
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false' });
  process.chdir(cwd);
  const configDir = path.join(agentDir, 'extensions/picc-permission-modes'); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: [], deny: [], ask: [] },
    planMode: { agentCanEnter: false }, autoMode: { classifyAllShell: true, denialLimits: { maxConsecutive: 3, maxTotal: 20 }, transcriptMaxChars: 80000, classifier: { mode: 'fixed', provider: 'fixture-reviewer', model: 'review', onUnavailable: 'deny', timeoutMs: 2000 } } }));
  fs.writeFileSync(path.join(agentDir, 'hud-footer.json'), JSON.stringify({ style: 'border', enabled: true }));
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'AGENTS_COMPOSITION_MARKER');
  fs.writeFileSync(path.join(cwd, '.agents/rules/local.md'), 'RULES_COMPOSITION_MARKER');
  let session; let tui; let shutdown = false;
  try {
    const require = createRequire(path.join(host, 'package.json'));
    const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
    const { AuthStorage } = await import(pathToFileURL(path.join(host, 'dist/core/auth-storage.js')));
    const ai = require.resolve.paths('@earendil-works/pi-ai').map((base) => path.join(base, '@earendil-works/pi-ai/dist/index.js')).find((file) => fs.existsSync(file));
    const { createAssistantMessageEventStream } = await import(pathToFileURL(ai));
    const { TuiAltScreen, Container, Text } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')));
    const { AssistantMessageComponent } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/components/assistant-message.js')));
    const { createChatViewport } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/chat-viewport.js')));
    const { initTheme, theme } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js'))); initTheme('dark', false);
    const runtime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), refreshOnCreate: false });
    const calls = []; const reviews = [];
    for (const [provider, id, apiKey, log] of [['fixture-main', 'main', 'MAIN_ONLY', calls], ['fixture-reviewer', 'review', 'REVIEW_ONLY', reviews]]) {
      runtime.registerProvider(provider, { baseUrl: `https://${provider}.invalid`, apiKey, headers: { 'X-Fixture-Owner': provider }, api: `api-${provider}`,
        models: [{ id, name: provider, reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, context, options) {
          log.push({ model, context: structuredClone(context), options });
          const text = provider === 'fixture-reviewer' ? '{"decision":"allow","reason":"synthetic allowed"}' : 'FINAL_ANSWER_START\n\n' + '中文最终回复 body\n\n'.repeat(50);
          const output = { role: 'assistant', api: model.api, provider, model: id, timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text }],
            usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: 'start', partial: output }); stream.push({ type: 'done', reason: 'stop', message: output }); stream.end(); });
          return stream;
        },
      });
    }
    const packages = ['pi-agents-context', 'picc-permission-modes', 'pi-gpt-codex', 'pi-scheduler', 'pi-unread-navigation', 'pi-hud-footer', 'pi-subagent-hud'].map((name) => path.join(repo, 'packages', name));
    packages.push(path.join(repo, 'packages/pi-compaction-guidance'));
    packages.push(path.join(repo, 'tools/pi-btw-split'));
    const settings = sdk.SettingsManager.inMemory({ packages, compaction: { enabled: false } }, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [{ path: path.join(cwd, 'AGENTS.md'), content: 'AGENTS_COMPOSITION_MARKER' }] }) });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const sm = sdk.SessionManager.create(cwd, path.join(root, 'synthetic-sessions'));
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel('fixture-main', 'main'),
      resourceLoader: loader, sessionManager: sm, noTools: 'all' }));
    tui = new TuiAltScreen({ columns: 70, rows: 18, write() {}, hideCursor() {} }, false);
    tui.stopped = false; tui.altScreenActive = true; tui.requestRender = () => {};
    const chat = new Container(); chat.addChild(new Text('history\n'.repeat(35), 0, 0));
    const viewport = createChatViewport({ document: chat, pendingMessages: new Container(), status: new Container(), editor: new Text('editor'), footer: new Text('footer'), scrollbar: 'hidden' });
    tui.setLayoutRoot(viewport.root); tui.doRender(); tui.scrollToTop(); tui.doRender();
    let draft = ''; let footer; let editor; const widgets = new Map(); const statuses = new Map(); const notices = []; const errors = [];
    const noop = () => {};
    const ui = { theme, notify: (text) => notices.push(text), setStatus: (key, value) => statuses.set(key, value), setWorkingMessage: noop,
      setWidget(key, value) { widgets.get(key)?.dispose?.(); widgets.set(key, typeof value === 'function' ? value(tui, theme) : value); },
      setFooter: (value) => { footer = value; }, getEditorComponent: () => editor, setEditorComponent: (value) => { editor = value; },
      getEditorText: () => draft, setEditorText: (text) => { draft = text; }, onTerminalInput: () => noop,
      custom: async (factory) => new Promise((resolve) => { const component = factory(tui, theme, {}, resolve); component.handleInput('\x1b'); }),
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
    };
    session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') { chat.addChild(new AssistantMessageComponent(event.message)); tui.doRender(); }
    });
    await session.bindExtensions({ mode: 'tui', uiContext: ui, onError: (error) => errors.push(error) });
    assert.deepEqual(errors, [], 'session_start handlers');
    assert.ok(editor); assert.ok(footer, 'HUD still owns editor/footer while navigation uses only a widget');
    assert.ok(session.extensionRunner.getCommand('btw'));
    await session.prompt('synthetic human request'); tui.doRender();
    assert.equal(calls.length, 1);
    assert.ok(JSON.stringify(calls[0].context).includes('AGENTS_COMPOSITION_MARKER'), Object.keys(calls[0].context).join(','));
    assert.ok(JSON.stringify(calls[0].context).includes('RULES_COMPOSITION_MARKER'));
    const unread = widgets.get('unread-final-replies'); assert.match(unread.render(70)[0], /1 unread/);
    tui.handleViewportInput('\x1b[1;5F'); tui.doRender();
    assert.equal(tui.isFollowingOutput, false);
    assert.ok(tui.currentLayout.lines.some((line) => line.includes('FINAL_ANSWER_START')), 'jump displays the final answer beginning');
    await session.prompt('/auto');
    const allowed = await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'synthetic-review', toolName: 'bash', input: { command: 'npm test' } });
    assert.ok(!allowed?.block); assert.equal(reviews.length, 1);
    assert.equal(reviews[0].options.apiKey, 'REVIEW_ONLY'); assert.equal(reviews[0].options.headers['X-Fixture-Owner'], 'fixture-reviewer');
    assert.equal(reviews[0].context.tools, undefined); assert.equal(session.model.provider, 'fixture-main');
    assert.ok(!JSON.stringify(reviews).includes('MAIN_ONLY'));
    const tools = sdk.wrapRegisteredTools(session.extensionRunner.getAllRegisteredTools(), session.extensionRunner);
    const schedule = tools.find((tool) => tool.name === 'schedule_task');
    const stateFile = path.join(agentDir, 'state/scheduler/tasks.json');
    await assert.rejects(() => schedule.execute('synthetic-shell-blocked', { action: 'shell', command: 'printf fixture-output', schedule: '0.01s', scope: 'session' }), /shell 定时模式已关闭/);
    draft = 'unsubmitted steer';
    const queued = await schedule.execute('synthetic-schedule', { action: 'prompt', prompt: 'cancel me prompt', type: 'once', schedule: '0.01s', name: 'cancel me', scope: 'session' });
    const readTask = () => JSON.parse(fs.readFileSync(stateFile)).tasks.find((task) => task.id === queued.details.task.id);
    await delay(100);
    assert.equal(calls.length, 1, 'scheduler never jumps ahead of the human draft');
    await session.prompt('/schedule-cancel cancel me'); draft = '';
    await delay(650); assert.equal(calls.length, 1); assert.equal(readTask().status, 'cancelled');
    draft = 'second draft';
    await schedule.execute('synthetic-prompt', { action: 'prompt', prompt: 'scheduled check', type: 'once', schedule: '0.01s', name: 'safe wake', scope: 'session' });
    await delay(500); assert.equal(calls.length, 1);
    draft = ''; await session.prompt('/scheduler resume');
    await until(() => calls.length === 2 && !session.isStreaming, 'single foreground-safe model wake');
    await delay(550); assert.equal(calls.length, 2);
    assert.deepEqual(errors, []);
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    shutdown = true;
    assert.equal(Object.hasOwn(tui, 'scrollToBottom'), false);
    assert.equal(widgets.get('unread-final-replies'), undefined);
    assert.equal(editor, undefined, 'HUD restores the editor; host owns footer replacement on reload');
  } finally {
    if (session) {
      if (!shutdown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }).catch(() => {});
      session.dispose();
    }
    if (tui) { tui.stopped = true; tui.altScreenActive = false; }
    process.chdir(oldCwd);
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
