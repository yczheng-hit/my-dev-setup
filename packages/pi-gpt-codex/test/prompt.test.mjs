import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed @earendil-works/pi-coding-agent directory');
const { createJiti } = await import(pathToFileURL(path.join(host, 'node_modules/jiti/lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js') } });
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(pathToFileURL(path.join(host, 'dist/core/system-prompt.js')));
const { applyGptPrompt, isGptModel, withTruncationHint, GPT_PROMPT, TOOLS_CODEX, TOOLS_PI } = await jiti.import('../extensions/prompt.ts');
const { default: extension } = await jiti.import('../extensions/index.ts');

const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6.1-sol' };
const claude = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5' };

function baseOptions(selectedTools = ['read', 'bash', 'edit', 'write']) {
  return normalizeBuildSystemPromptOptions({
    cwd: '/repo',
    selectedTools,
    toolSnippets: { read: 'Read files', bash: 'Run commands', edit: 'Edit files', write: 'Write files' },
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'PROJECT RULE: use rg' }],
    sections: { other_ext: 'kept from another extension' },
  });
}

function loadExtension() {
  const handlers = new Map();
  extension({ on: (name, fn) => handlers.set(name, fn) });
  return handlers;
}

test('only GPT models on Codex or OpenAI Responses routes are matched', () => {
  assert.equal(isGptModel(codex), true);
  assert.equal(isGptModel({ provider: 'openai', api: 'openai-responses', id: 'gpt-6.1-sol' }), true);
  assert.equal(isGptModel(claude), false);
  assert.equal(isGptModel({ provider: 'local', api: 'openai-completions', id: 'gpt-5.6-sol' }), false);
  assert.equal(isGptModel(undefined), false);
});

test('GPT prompt replaces the pi preamble and conflicting rules but keeps project context', () => {
  const options = baseOptions();
  applyGptPrompt(options);
  const prompt = buildSystemPrompt(options);
  assert.ok(prompt.startsWith(GPT_PROMPT.split('\n')[0]));
  assert.ok(!prompt.includes('You are an expert coding assistant operating inside pi'));
  assert.ok(!prompt.includes('Be concise in your responses'));
  assert.ok(prompt.includes('Compaction does not end the task'));
  assert.ok(prompt.includes('PROJECT RULE: use rg'));
  assert.ok(prompt.includes('kept from another extension'));
  assert.ok(prompt.includes(TOOLS_PI));
  assert.ok(!prompt.includes('functions.exec'), 'Codex-only tool names must not leak into pi');
});

test('tools section follows the active tool set', () => {
  const options = baseOptions(['read', 'exec_command', 'write_stdin', 'apply_patch']);
  applyGptPrompt(options);
  const prompt = buildSystemPrompt(options);
  assert.ok(prompt.includes(TOOLS_CODEX));
  assert.ok(!prompt.includes(TOOLS_PI));
});

test('before_agent_start leaves Claude untouched and rewrites GPT', async () => {
  const handlers = loadExtension();
  const claudeOptions = baseOptions();
  const before = buildSystemPrompt(claudeOptions);
  assert.equal(await handlers.get('before_agent_start')({ systemPromptOptions: claudeOptions }, { model: claude }), undefined);
  assert.equal(buildSystemPrompt(claudeOptions), before);

  const gptOptions = baseOptions();
  assert.equal(await handlers.get('before_agent_start')({ systemPromptOptions: gptOptions }, { model: codex }), undefined);
  assert.notEqual(buildSystemPrompt(gptOptions), before);
  assert.equal(gptOptions.forceSystemPrompt, undefined, 'must not force-replace the whole prompt');
});

test('truncated shell output gets a pointer to the head of the full log', async () => {
  const text = 'tail line\n\n[Showing lines 1801-3800 of 3800. Full output: /tmp/pi-bash-abc.log]';
  const hinted = withTruncationHint(text);
  assert.match(hinted, /head -n 80 \/tmp\/pi-bash-abc\.log/);
  assert.equal(withTruncationHint(hinted), undefined, 'idempotent');
  assert.equal(withTruncationHint('short output'), undefined);
  const partial = withTruncationHint('x\n\n[Showing last 50.0KB of line 9 (line is 2.0MB). Full output: /tmp/o.log]');
  assert.match(partial, /\/tmp\/o\.log/);

  const handlers = loadExtension();
  const event = { toolName: 'bash', content: [{ type: 'text', text }] };
  const result = await handlers.get('tool_result')(event, { model: codex });
  assert.match(result.content[0].text, /head -n 80/);
  assert.equal(await handlers.get('tool_result')(event, { model: claude }), undefined);
  assert.equal(await handlers.get('tool_result')({ toolName: 'read', content: event.content }, { model: codex }), undefined);
});
