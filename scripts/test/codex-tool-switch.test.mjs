// Offline regression: real Pi session/dispatcher, repo Codex adapter, synthetic models and files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const host = process.env.PI_HOST_DIR;
const repo = fileURLToPath(new URL('../..', import.meta.url));
const compat = path.join(repo, 'packages/pi-openai-codex-compat/extensions/index.ts');

test('Codex -> plain Completions -> Codex corrects stale calls without executing or rewriting history', { skip: !host, timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tool-switch-')));
  const saved = { ...process.env }, oldCwd = process.cwd(), savedFetch = globalThis.fetch; let session;
  try {
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PICC_|HERDR_|ANTHROPIC_|OPENAI_|CLAUDE_|BTW_)/.test(key)) delete process.env[key];
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work'), home = path.join(root, 'home');
    for (const dir of [agentDir, cwd, home]) fs.mkdirSync(dir);
    Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false' });
    process.chdir(cwd);
    globalThis.fetch = async () => { throw new Error('Offline switch test prohibits provider/network requests'); };
    fs.writeFileSync(path.join(agentDir, 'openai-codex-compat.json'), JSON.stringify({ imageGeneration: false, webRun: false, applyPatch: true }));
    const fromHost = createRequire(path.join(host, 'package.json'));
    const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
    const { AuthStorage } = await import(pathToFileURL(path.join(host, 'dist/core/auth-storage.js')));
    const aiPath = fromHost.resolve.paths('@earendil-works/pi-ai').map(base => path.join(base, '@earendil-works/pi-ai/dist/index.js')).find(file => fs.existsSync(file));
    const { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } = await import(pathToFileURL(aiPath));
    const { convertMessages } = await import(pathToFileURL(path.join(path.dirname(aiPath), 'api/openai-completions.js')));
    const runtime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory({ 'openai-codex': { type: 'oauth', access: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'SYNTHETIC_ONLY' } })).toString('base64url')}.sig`, refresh: 'SYNTHETIC_ONLY', expires: Date.now() + 3600000, accountId: 'SYNTHETIC_ONLY' } }), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture-completions', { baseUrl: 'https://fixture.invalid', api: 'openai-completions', apiKey: 'SYNTHETIC_ONLY',
      models: [{ id: 'plain', name: 'Plain Completions', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const codex = runtime.getModel('openai-codex', 'gpt-6.1-sol'); assert.ok(codex);
    const plain = runtime.getModel('fixture-completions', 'plain');
    const settings = sdk.SettingsManager.inMemory({ packages: [path.dirname(path.dirname(compat))], compaction: { enabled: false } }, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, systemPrompt: 'Synthetic coding prompt.', appendSystemPrompt: [], agentsFilesOverride: () => ({ agentsFiles: [] }), noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const sm = sdk.SessionManager.create(cwd, path.join(root, 'synthetic-sessions'));
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, modelRuntime: runtime, model: codex, thinkingLevel: 'off', resourceLoader: loader, sessionManager: sm }));
    const errors = []; await session.bindExtensions({ onError: error => errors.push(error) });
    const requests = [], count = new Map();
    const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
    const addPatch = file => `*** Begin Patch\n*** Add File: ${file}\n+synthetic\n*** End Patch`;
    session.agent.streamFunction = (model, context) => {
      requests.push({ provider: model.provider, context: structuredClone(context) });
      const n = (count.get(model.provider) ?? 0) + 1; count.set(model.provider, n);
      let content = [{ type: 'text', text: 'synthetic done' }];
      if (model.provider === 'openai-codex' && n === 1) content = [call('old-success', 'apply_patch', { patch: addPatch('old.txt') })];
      if (model.provider === 'fixture-completions' && n === 1) content = [call('stale-call', 'apply_patch', { patch: addPatch('must-not-exist.txt') })];
      if (model.provider === 'fixture-completions' && n === 2) content = [call('current-write', 'write', { path: 'current.txt', content: 'current tool succeeded' })];
      const message = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
      return stream;
    };
    await session.prompt('Use the synthetic Codex tool');
    assert.equal(fs.existsSync(path.join(cwd, 'old.txt')), true);
    const rawBefore = fs.readFileSync(sm.getSessionFile(), 'utf8');
    await session.setModel(plain);
    assert.ok(!session.getActiveToolNames().includes('apply_patch')); assert.ok(session.getActiveToolNames().includes('bash'));
    await session.prompt('Continue on the plain model');
    const plainRequests = requests.filter(request => request.provider === 'fixture-completions');
    assert.equal(plainRequests.length, 3);
    const initial = plainRequests[0].context.messages;
    assert.ok(!getCurrentTools(initial).some(tool => tool.name === 'apply_patch'));
    assert.match(getCurrentSystemPrompt(initial), /apply_patch.*(?:unavailable|not available)/i);
    const followUp = plainRequests[1].context.messages;
    const stale = followUp.find(message => message.role === 'toolResult' && message.toolCallId === 'stale-call');
    assert.equal(stale.isError, true); assert.equal(stale.toolName, 'apply_patch');
    const hint = stale.content.map(part => part.text ?? '').join('\n');
    assert.deepEqual(errors, [], 'extension context hooks must not fail');
    assert.match(hint, /not executed/i); assert.match(hint, /write/); assert.match(hint, /do not retry/i);
    const serialized = convertMessages(plain, { messages: followUp }, { supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false, supportsDeveloperRole: false });
    assert.ok(serialized.some(message => message.tool_calls?.some(tool => tool.function.name === 'apply_patch')), 'old calls remain truthful');
    assert.ok(serialized.some(message => message.role === 'tool' && /not executed/i.test(message.content)), 'corrective result reaches plain Completions');
    assert.equal(fs.existsSync(path.join(cwd, 'must-not-exist.txt')), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'current.txt'), 'utf8'), 'current tool succeeded');
    const rawAfter = fs.readFileSync(sm.getSessionFile(), 'utf8'); assert.ok(rawAfter.startsWith(rawBefore));
    const storedStale = sm.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'stale-call').message;
    assert.equal(storedStale.content[0].text, 'Tool apply_patch not found', 'raw history is not rewritten');
    await session.setModel(codex); await session.prompt('Continue on Codex again');
    const last = requests.at(-1).context.messages;
    assert.ok(getCurrentTools(last).some(tool => tool.name === 'apply_patch'));
    assert.ok(!getCurrentSystemPrompt(last).includes('codex_tool_surface_recovery'), 'no stale removal note on return');
    const restoredError = last.find(message => message.role === 'toolResult' && message.toolCallId === 'stale-call');
    assert.equal(restoredError.content[0].text, 'Tool apply_patch not found');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    process.chdir(oldCwd);
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); fs.rmSync(root, { recursive: true, force: true });
  }
});
