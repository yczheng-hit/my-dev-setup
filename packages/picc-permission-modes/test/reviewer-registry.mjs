// Real Pi ModelRuntime/ModelRegistry, offline in-memory providers; no network or user auth.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = await import(pathToFileURL(path.join(path.dirname(require.resolve('jiti/package.json')), 'lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js') } });
const { AutoMode, collectReviewMessages, buildUserMessage } = await jiti.import('../auto-mode.ts');
const { defaultClassifierConfig } = await jiti.import('../auto-mode-config.ts');
const { ModelRuntime, ModelRegistry, SessionManager } = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const { AuthStorage } = await import(pathToFileURL(path.join(host, 'dist/core/auth-storage.js')));
const aiEntry = require.resolve.paths('@earendil-works/pi-ai').map(dir => path.join(dir, '@earendil-works/pi-ai/dist/index.js')).find(file => existsSync(file));
if (!aiEntry) throw new Error('Cannot locate Pi AI peer');
const { createAssistantMessageEventStream } = await import(pathToFileURL(aiEntry));
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
const registry = new ModelRegistry(runtime);
const calls = [];
for (const [provider, key] of [['offline-main', 'MAIN_ONLY'], ['offline-reviewer', 'REVIEW_ONLY']]) {
  registry.registerProvider(provider, {
    baseUrl: `https://${provider}.invalid`, apiKey: key, headers: { 'X-Owner': provider }, api: 'offline-review-api',
    models: [{ id: 'fixture', name: provider, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      const stream = createAssistantMessageEventStream();
      const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: '{"decision":"allow","reason":"offline review"}' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: output }); stream.end(); });
      return stream;
    },
  });
}
const config = { classifier: { ...defaultClassifierConfig(), mode: 'fixed', provider: 'offline-reviewer', model: 'fixture' }, allow: [], softDeny: [], hardDeny: [], environment: [], safeToolAllowlist: [], classifyAllShell: false, denialLimits: { maxConsecutive: 3, maxTotal: 20 }, transcriptMaxChars: 80000 };
const main = registry.find('offline-main', 'fixture');
const ctx = { cwd: '/nonexistent-offline-fixture', isProjectTrusted: () => false, model: main, modelRegistry: registry };
const request = { toolName: 'bash', input: { command: 'npm test' }, sessionMessages: [], ctx };
assert.equal((await new AutoMode({ config }).classify(request)).allow, true);
assert.equal(calls.length, 1);
assert.equal(calls[0].model.provider, 'offline-reviewer');
assert.equal(calls[0].options.apiKey, 'REVIEW_ONLY');
assert.equal(calls[0].options.headers['X-Owner'], 'offline-reviewer');
assert.equal(calls[0].context.tools, undefined);
assert.equal(ctx.model, main);
assert.ok(!JSON.stringify(calls).includes('MAIN_ONLY'));
console.log('PASS real Pi registry: independent provider/auth/headers, no tools or main-model mutation');
const sm = SessionManager.inMemory('/nonexistent-offline-fixture');
sm.appendMessage({ role: 'user', content: 'OLD_REQUEST', timestamp: Date.now() });
sm.appendMessage({ role: 'user', content: 'KEPT_USER_REQUEST', timestamp: Date.now() });
const kept = sm.getLeafId();
sm.appendCompaction('SUMMARY_EVIDENCE', kept, 1000);
sm.appendMessage({ role: 'user', content: 'LATEST_USER_REQUEST', timestamp: Date.now() });
const message = JSON.parse(buildUserMessage({ ...request, ctx: undefined, sessionMessages: collectReviewMessages(sm) }, config));
assert.ok(message.transcript.some(item => item.untrustedSummary === 'SUMMARY_EVIDENCE'));
assert.ok(message.transcript.some(item => item.user === 'KEPT_USER_REQUEST'));
assert.ok(message.transcript.some(item => item.user === 'LATEST_USER_REQUEST'));
assert.ok(!JSON.stringify(message).includes('OLD_REQUEST'));
console.log('PASS real Pi read-only session projection: compacted intent omitted, summary provenance preserved');
