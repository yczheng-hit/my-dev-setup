// Native fire-and-forget ExtensionAPI dispatch: offline model/auth fixtures only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const host = process.env.PI_HOST_DIR;
const extension = fileURLToPath(new URL('../../packages/pi-scheduler/extensions/scheduler/index.ts', import.meta.url));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for native scheduler delivery');
}
for (const authenticated of [false, true]) test(`native scheduler ${authenticated ? 'confirms user-message acceptance' : 'retains async auth rejection without false delivery'}`, { skip: !host }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-native-delivery-')));
  const savedEnv = { ...process.env }; let session;
  try {
    for (const key of Object.keys(process.env)) if (/^(PI_|HERDR_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key];
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work'), stateFile = path.join(root, 'tasks.json');
    fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
    Object.assign(process.env, { HOME: path.join(root, 'home'), PI_CODING_AGENT_DIR: agentDir, PI_SCHEDULER_STATE_FILE: stateFile, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false' });
    const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
    const { AuthStorage } = await import(pathToFileURL(path.join(host, 'dist/core/auth-storage.js')));
    const require = createRequire(path.join(host, 'package.json'));
    const ai = require.resolve.paths('@earendil-works/pi-ai').map(base => path.join(base, '@earendil-works/pi-ai/dist/index.js')).find(file => fs.existsSync(file));
    const { createAssistantMessageEventStream } = await import(pathToFileURL(ai));
    const runtime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), refreshOnCreate: false });
    let providerCalls = 0;
    runtime.registerProvider('fixture-scheduler', { baseUrl: 'https://fixture.invalid', ...(authenticated ? { apiKey: 'SYNTHETIC_ONLY' } : {}), api: 'fixture-scheduler-api',
      models: [{ id: 'offline', name: 'offline', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        providerCalls++;
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'synthetic answer' }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream;
      },
    });
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [extension], noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel('fixture-scheduler', 'offline'), resourceLoader: loader,
      sessionManager: sdk.SessionManager.create(cwd, path.join(root, 'synthetic-sessions')), noTools: 'all' }));
    const errors = []; await session.bindExtensions({ onError: error => errors.push(error) });
    const tools = sdk.wrapRegisteredTools(session.extensionRunner.getAllRegisteredTools(), session.extensionRunner);
    await tools.find(tool => tool.name === 'schedule_task').execute('fixture', { action: 'prompt', prompt: 'synthetic wake', schedule: '0.01s', scope: 'session' });
    const task = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks[0];
    if (authenticated) {
      await until(() => task()?.result?.wakeDisposition === 'delivered' && !session.isStreaming);
      assert.equal(task().pendingWake, undefined); assert.equal(providerCalls, 1); assert.deepEqual(errors, []);
    } else {
      await until(() => errors.some(error => error.event === 'send_user_message'));
      await until(() => task()?.pendingWake?.state === 'uncertain');
      assert.match(errors.find(error => error.event === 'send_user_message').error, /No API key/);
      assert.equal(providerCalls, 0); assert.equal(task().result.wakeDisposition, 'pending');
      assert.match(task().pendingWake.content, /synthetic wake$/);
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
      await session.extensionRunner.emit({ type: 'session_start', reason: 'resume' });
      await new Promise(resolve => setTimeout(resolve, 550));
      assert.equal(errors.filter(error => error.event === 'send_user_message').length, 1, 'uncertain dispatch is not replayed');
    }
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv); fs.rmSync(root, { recursive: true, force: true });
  }
});
