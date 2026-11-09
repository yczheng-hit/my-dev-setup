// Offline request-contract tests: actual Pi compact(), synthetic providers/checkpoints only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const host = process.env.PI_HOST_DIR;
const repo = fileURLToPath(new URL('../..', import.meta.url));
let sdk, jiti, register, guidance, withGuidance, ai, registerRemote, Runtime, config, metadata;
if (host) {
  const require = createRequire(path.join(host, 'package.json'));
  sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
  const { createJiti } = require('jiti');
  const alias = { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'), typebox: require.resolve('typebox'), 'typebox/value': require.resolve('typebox/value') };
  for (const name of ['pi-ai', 'pi-tui', 'pi-agent-core']) alias[`@earendil-works/${name}`] = require.resolve.paths(`@earendil-works/${name}`).map(base => path.join(base, `@earendil-works/${name}/dist/index.js`)).find(file => fs.existsSync(file));
  ai = await import(pathToFileURL(alias['@earendil-works/pi-ai']));
  jiti = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false });
  ({ default: register } = await jiti.import(path.join(repo, 'packages/pi-compaction-guidance/extensions/index.ts')));
  ({ COMPACTION_GUIDANCE: guidance, withCompactionGuidance: withGuidance } = await jiti.import(path.join(repo, 'packages/pi-compaction-guidance/guidance.ts')));
  const base = path.join(repo, 'packages/pi-openai-codex-compat/extensions/openai-codex-compat');
  ({ default: registerRemote } = await jiti.import(path.join(base, 'remote-compaction.ts')));
  ({ CodexProviderRuntime: Runtime } = await jiti.import(path.join(base, 'codex-provider/codex-provider-runtime.ts')));
  ({ DEFAULT_CONFIG: config } = await jiti.import(path.join(base, 'config.ts')));
  ({ responsesCompactionV2Metadata: metadata } = await jiti.import(path.join(base, 'codex-metadata.ts')));
}
const plain = { id: 'synthetic', name: 'synthetic', provider: 'fixture', api: 'fixture-api', baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = text => ({ role: 'user', content: text, timestamp: 1 });
const assistant = (content = 'checked', overrides = {}) => ({ role: 'assistant', content: [{ type: 'text', text: content }], provider: 'fixture', api: 'fixture-api', model: 'synthetic', stopReason: 'stop', timestamp: 2, usage, ...overrides });
function output(model, text, stopReason = 'stop') {
  const message = { ...assistant(text), provider: model.provider, api: model.api, model: model.id, stopReason, ...(stopReason === 'error' ? { errorMessage: 'synthetic deterministic failure' } : {}) };
  const stream = ai.createAssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: stopReason === 'error' ? 'error' : 'done', reason: stopReason, message, error: message }); stream.end(); });
  return stream;
}
function prep(overrides = {}) {
  return { firstKeptEntryId: 'keep-exact-boundary', tokensBefore: 80000, messagesToSummarize: [user('USER GOAL: verify, never upload. Acceptance: report verified result.'), ...Array.from({ length: 12 }, (_, i) => [user(`自动唤醒，非新增用户授权；check ${i}`), assistant('dependency still pending')]).flat(), user('User revision: stop after failure.'), assistant('Observed failure; no upload executed.')], turnPrefixMessages: [], isSplitTurn: false, previousSummary: 'Goal: verify. Constraint: never upload. Outstanding: dependency.', fileOps: { read: new Set(['evidence.log']), written: new Set(['status.json']), edited: new Set(), ls: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, ...overrides };
}
function harness(stop = 'stop') {
  const requests = [], notices = []; let hook;
  register({ on: (name, handler) => { assert.equal(name, 'session_before_compact'); hook = handler; }, getSettings: () => ({ retry: { enabled: false }, transport: 'sse', thinkingBudgets: { high: 2048 } }) });
  const ctx = { model: plain, thinkingLevel: 'high', hasUI: true, ui: { notify: (...args) => notices.push(args) }, modelRegistry: { streamSimple: (model, context, options) => { requests.push({ model, context, options }); return output(model, '## Goal\nSynthetic summary\n## Constraints & Preferences\nnever upload', stop); } } };
  return { requests, notices, ctx, run: (event, context = ctx) => hook({ type: 'session_before_compact', preparation: prep(), customInstructions: 'Keep the verification evidence.', reason: 'manual', signal: new AbortController().signal, ...event }, context) };
}

test('one concise guidance source preserves custom focus and is idempotent', { skip: !host }, () => {
  assert.ok(guidance.length < 1200);
  assert.equal(withGuidance(withGuidance('manual focus')), withGuidance('manual focus'));
  assert.match(guidance, /user goals.*authorization boundaries/); assert.match(guidance, /Merge repetitive/); assert.match(guidance, /uncertain origins uncertain/);
});
for (const reason of ['manual', 'threshold', 'overflow']) test(`ordinary ${reason} compaction reuses native format/merge/boundary/file tracking`, { skip: !host }, async () => {
  const h = harness(), preparation = prep(), before = JSON.stringify(preparation);
  const result = await h.run({ reason, preparation, willRetry: reason === 'overflow' });
  assert.equal(h.requests.length, 1); const request = h.requests[0], text = JSON.stringify(request.context);
  assert.ok(text.includes(guidance.replaceAll('\n', '\\n'))); assert.match(text, /Keep the verification evidence/);
  assert.match(text, /previous-summary/); assert.match(text, /USER GOAL/); assert.match(text, /User revision/);
  assert.match(text, /UPDATE|Update/); assert.match(text, /## Goal/); assert.match(text, /## Constraints & Preferences/);
  assert.equal(request.options.reasoning, 'high'); assert.equal(request.options.cacheRetention, 'none'); assert.equal(request.options.transport, 'sse'); assert.equal(request.options.apiKey, undefined);
  assert.equal(result.compaction.firstKeptEntryId, preparation.firstKeptEntryId); assert.equal(result.compaction.tokensBefore, preparation.tokensBefore);
  assert.deepEqual(result.compaction.details, { readFiles: ['evidence.log'], modifiedFiles: ['status.json'] });
  assert.match(result.compaction.summary, /<modified-files>\nstatus.json/); assert.equal(JSON.stringify(preparation), before);
});
test('initial and split-turn summaries both receive guidance with native split handling', { skip: !host }, async () => {
  for (const split of [false, true]) {
    const h = harness(); const result = await h.run({ preparation: prep({ previousSummary: undefined, isSplitTurn: split, turnPrefixMessages: split ? [user('ongoing request'), assistant('partial work')] : [] }) });
    assert.equal(h.requests.length, split ? 2 : 1);
    for (const request of h.requests) assert.ok(JSON.stringify(request.context).includes(guidance.replaceAll('\n', '\\n')));
    assert.equal(result.compaction.firstKeptEntryId, 'keep-exact-boundary');
    if (split) assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  }
});
test('ordinary adapter handles Codex by default, skips virtual, and cancels abort/error without text fallback', { skip: !host }, async () => {
  const h = harness();
  assert.equal(await h.run({}, { ...h.ctx, model: { ...plain, api: 'pi-virtual' } }), undefined);
  const codexRes = await h.run({}, { ...h.ctx, model: { ...plain, provider: 'openai-codex' } });
  assert.match(codexRes.compaction.summary, /## Goal/);
  const controller = new AbortController(); controller.abort(); assert.deepEqual(await h.run({ signal: controller.signal }), { cancel: true });
  for (const stop of ['error', 'length']) {
    const failed = harness(stop); assert.deepEqual(await failed.run({}), { cancel: true }); assert.equal(failed.requests.length, 1); assert.equal(failed.notices.length, 1);
  }
});

// Actual SDK session persistence/projection and provider-neutral registered runtime, not hook stubs.
test('real SDK compaction appends once, retains recent entries and updates prior summaries without rewriting raw history', { skip: !host, timeout: 15000 }, async () => {
  const os = await import('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guided-compaction-session-')));
  const saved = { ...process.env }, fetch = globalThis.fetch; let session;
  try {
    for (const key of Object.keys(process.env)) if (/^(?:PI_|HERDR_|ANTHROPIC_|OPENAI_|PICC_|CLAUDE_)/.test(key)) delete process.env[key];
    const home = path.join(root, 'home'), agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work');
    for (const dir of [home, agentDir, cwd]) fs.mkdirSync(dir);
    Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false' });
    globalThis.fetch = async () => { throw new Error('Offline test forbids network'); };
    const { AuthStorage } = await import(pathToFileURL(path.join(host, 'dist/core/auth-storage.js')));
    const runtime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), refreshOnCreate: false });
    const requests = [];
    runtime.registerProvider('fixture', { baseUrl: 'https://fixture.invalid', apiKey: 'SYNTHETIC_ONLY', api: 'fixture-api', models: [{ ...plain }],
      streamSimple: (model, context, options) => { requests.push({ context: structuredClone(context), options }); return output(model, '## Goal\nverify\n## Constraints & Preferences\nnever upload\n## Progress\nDependency still pending.'); } });
    const settings = sdk.SettingsManager.inMemory({ packages: [path.join(repo, 'packages/pi-compaction-guidance')], compaction: { keepRecentTokens: 160 }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const sm = sdk.SessionManager.create(cwd, path.join(root, 'synthetic-sessions'));
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel('fixture', 'synthetic'), settingsManager: settings, resourceLoader: loader, sessionManager: sm, noTools: 'all' }));
    const errors = []; await session.bindExtensions({ onError: e => errors.push(e) });
    await session.prompt('USER GOAL verify; never upload; stop on failure.');
    for (let i = 0; i < 12; i++) { sm.appendMessage(user(`自动唤醒，非新增用户授权；check ${i}`)); sm.appendMessage(assistant('Dependency still pending.')); }
    const recentId = sm.getLeafId(), raw = fs.readFileSync(sm.getSessionFile(), 'utf8'); requests.length = 0;
    await session.compact('Keep the original user constraints.');
    assert.ok(requests.length >= 1 && requests.length <= 2); assert.ok(requests.every(r => JSON.stringify(r.context).includes('Compaction priorities:')));
    assert.ok(requests.every(r => r.options.cacheRetention === 'none'));
    const compacted = sm.getBranch().filter(e => e.type === 'compaction'); assert.equal(compacted.length, 1);
    const projection = sm.buildSessionProjection(); assert.ok(projection.entries.some(e => e.sourceEntry.id === recentId));
    assert.ok(fs.readFileSync(sm.getSessionFile(), 'utf8').startsWith(raw));
    for (let i = 0; i < 6; i++) { sm.appendMessage(user(`自动唤醒，非新增用户授权；next check ${i}`)); sm.appendMessage(assistant('No change.')); }
    requests.length = 0; await session.compact();
    assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 2);
    assert.ok(requests.some(r => JSON.stringify(r.context).includes('previous-summary')));
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    globalThis.fetch = fetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex defaults to unified text compaction and only creates opaque checkpoints when opted in', { skip: !host }, async () => {
  const codex = { ...plain, provider: 'openai-codex', api: 'openai-codex-responses', apis: ['openai-codex-responses'], id: 'gpt-6.1-sol' };
  const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'SYNTHETIC_ONLY' } })).toString('base64url')}.sig`;
  const runtime = new Runtime({ appendEntry() {}, getAllTools: () => [] }, () => ({ ...config, responsesLite: false, autoCompactAtPercent: 80 }), 'synthetic-installation');
  const payloads = [], history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original user goal: no uploads.' }] }];
  runtime.transport.request = async function* (_model, payload) {
    payloads.push(structuredClone(payload));
    yield { type: 'response.completed', response: { output: [{ type: 'compaction', encrypted_content: 'SYNTHETIC_OPAQUE_CHECKPOINT' }], usage: { input_tokens: 10, output_tokens: 2 } } };
  };
  let hook;
  registerRemote({ onSessionStart() {}, onSessionShutdown() {}, onContext() {}, onBeforeProviderHeaders() {}, onSessionBeforeCompact: handler => { hook = handler; }, getActiveTools: () => [], publishCancellation() {} }, runtime, () => ({ ...config, responsesLite: false }));
  const ctx = { model: codex, getSystemPrompt: () => 'original stable prompt', getContextUsage: () => ({ tokens: 90, percent: 90 }), hasUI: true,
    ui: { notify(text) { if (text.includes('failed:')) throw new Error(text); } }, sessionManager: { getSessionId: () => 'synthetic-session', getBranch: () => [], getLeafId: () => 'leaf', appendCompaction() {} },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) } };

  // Default: native opaque checkpoint compaction is disabled so Codex uses unified text summaries
  delete process.env.PI_OPENAI_CODEX_NATIVE_COMPACTION;
  assert.equal(await hook({ reason: 'manual', willRetry: false, branchEntries: [], customInstructions: 'manual focus', preparation: { firstKeptEntryId: 'boundary', tokensBefore: 90 }, signal: new AbortController().signal }, ctx), undefined);

  const prev = process.env.PI_OPENAI_CODEX_NATIVE_COMPACTION;
  process.env.PI_OPENAI_CODEX_NATIVE_COMPACTION = '1';
  try {
    for (const reason of ['manual', 'threshold', 'overflow']) {
      const result = await hook({ reason, willRetry: reason === 'overflow', branchEntries: [], customInstructions: 'manual focus', preparation: { firstKeptEntryId: 'boundary', tokensBefore: 90 }, signal: new AbortController().signal }, ctx);
      assert.equal(result.compaction.details.kind, 'openai-codex-compat-remote-compaction');
      assert.ok(result.compaction.details.history.some(item => item.type === 'compaction' && item.encrypted_content === 'SYNTHETIC_OPAQUE_CHECKPOINT'));
      assert.equal(result.compaction.firstKeptEntryId, 'boundary'); assert.ok(!result.compaction.summary.includes('## Goal'));
      assert.match(payloads.at(-1).instructions, /manual focus/);
    }
    // Lite keeps the guidance in its native developer envelope, with the trigger intact.
    runtime.captureScope({ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => 'synthetic-lite' } });
    runtime.updateSessionConfig('synthetic-lite', { ...config, responsesLite: true });
    const lite = await runtime.compact({ model: codex, requestOptions: { apiKey: token, sessionId: 'synthetic-lite' }, history,
      instructions: withGuidance('original stable prompt'), grammarToolInputProperties: new Map(), template: {}, priority: false,
      compactionMetadata: metadata('manual', 'user_requested', 'standalone_turn'), compactionDecision: { reason: 'manual', willRetry: false } });
    assert.ok(lite.checkpoint.history.some(item => item.type === 'compaction'));
    assert.equal(payloads.at(-1).instructions, undefined, 'Lite moves instructions into a developer message');
    assert.ok(payloads.at(-1).input.some(item => item.type === 'additional_tools'));
    // Exercise the actual provider-internal percentage entry, not just the public compact method.
    const appended = []; ctx.sessionManager.appendCompaction = (...args) => appended.push(args);
    runtime.captureScope(ctx);
    const body = { instructions: 'original stable prompt', input: history, tools: [], stream: true };
    const options = { apiKey: token, sessionId: 'synthetic-session', transport: 'sse' };
    // Percentage split uses an empty synthetic branch: no unsampled user entries to isolate.
    await runtime.maybeCompactPercentage(codex, { messages: [{ role: 'system', content: 'original stable prompt' }] }, options, body, new Map(), runtime.agentTurn('synthetic-session'), false);
    assert.equal(appended.length, 1); assert.equal(appended[0][3].kind, 'openai-codex-compat-remote-compaction');
    assert.equal(payloads.length, 5);
    for (const payload of payloads) {
      const instructions = [payload.instructions ?? '', ...payload.input.filter(item => item.type === 'message' && item.role === 'developer').flatMap(item => item.content.map(part => part.text ?? ''))].filter(Boolean).join('\n');
      assert.equal(instructions.split(guidance).length - 1, 1); assert.equal(payload.input.at(-1).type, 'compaction_trigger');
      assert.ok(instructions.startsWith('original stable prompt')); assert.ok(!instructions.includes('Use this EXACT format'));
    }
    const before = payloads.length;
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await hook({ signal: controller.signal }, ctx), { cancel: true }); assert.equal(payloads.length, before);
    ctx.hasUI = false;
    runtime.transport.request = async function* () { throw new Error('synthetic endpoint failure'); };
    const failure = await hook({ reason: 'manual', branchEntries: [], preparation: { firstKeptEntryId: 'boundary', tokensBefore: 90 }, signal: new AbortController().signal }, ctx);
    assert.deepEqual(failure, { cancel: true }, 'native error never creates a local text summary');
  } finally {
    if (prev === undefined) delete process.env.PI_OPENAI_CODEX_NATIVE_COMPACTION;
    else process.env.PI_OPENAI_CODEX_NATIVE_COMPACTION = prev;
  }
});
