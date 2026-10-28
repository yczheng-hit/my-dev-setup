// Opt-in offline test: switching GPT <-> Claude inside one pi session must leave each model with
// its own effective tools and prompt. Runs the real pi CLI in RPC mode against local mock
// Codex and Anthropic endpoints. Never contacts a real model.
//
//   PI_GPT_CODEX_LIVE_TEST=1 PI_HOST_DIR=<pi-coding-agent dir> PI_COMPAT_DIR=<pi-openai-codex-compat dir> \
//     [CLAUDE_MODEL=claude-opus-5-5|claude-sonnet-5] [START=gpt|claude] node test/live-switch.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

if (process.env.PI_GPT_CODEX_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_GPT_CODEX_LIVE_TEST=1');
const host = process.env.PI_HOST_DIR;
const compat = process.env.PI_COMPAT_DIR;
if (!host || !compat) throw new Error('Set PI_HOST_DIR and PI_COMPAT_DIR');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const startWithClaude = process.env.START === 'claude';

const reqs = [];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'zstd') body = zlib.zstdDecompressSync(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (req.url.endsWith('/codex/responses')) {
    reqs.push({ kind: 'codex', headers: req.headers, body: JSON.parse(body.toString()) });
    const item = { type: 'message', id: 'm', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'CODEX_OK', annotations: [] }] };
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    res.end(sse([{ type: 'response.created', response: { id: 'r', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r', status: 'completed', end_turn: true, output: [item], usage } }]));
  } else if (req.url.includes('/v1/messages')) {
    reqs.push({ kind: 'claude', headers: req.headers, body: JSON.parse(body.toString()) });
    res.end(sse([{ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: CLAUDE, content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CLAUDE_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }]));
  } else res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const D = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gpt-codex-switch-')));
const agentDir = path.join(D, 'agent');
const work = path.join(D, 'work');
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(work);
const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' } })).toString('base64url');
await fs.writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: `e30.${claims}.sig`, refresh: 'r', expires: Date.now() + 3600e3, accountId: 'acct_test' } }));
await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { baseUrl: `${baseUrl}/backend-api` }, anthropic: { baseUrl } } }));
await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ transport: 'sse', modelThinkingLevels: { 'openai-codex/gpt-6.1-sol': 'xhigh' } }));
await fs.writeFile(path.join(agentDir, 'openai-codex-compat.json'), JSON.stringify({ responsesLite: true, reasoningSummary: 'off', imageGeneration: false }));

const first = startWithClaude ? ['anthropic', CLAUDE] : ['openai-codex', 'gpt-6.1-sol'];
const second = startWithClaude ? ['openai-codex', 'gpt-6.1-sol'] : ['anthropic', CLAUDE];
const child = spawn(process.execPath, [path.join(host, 'dist/bundle/cli.js'), '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--mode', 'rpc',
  '-e', path.join(compat, 'extensions/index.ts'), '-e', path.join(root, 'extensions/index.ts'),
  '--provider', first[0], '--model', first[1]],
{ cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: D, ANTHROPIC_API_KEY: 'sk-ant-test', PI_SKIP_VERSION_CHECK: '1' } });
let buf = '';
let stderr = '';
const waiters = [];
child.stderr.on('data', (d) => (stderr += d));
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); for (const w of waiters.slice()) w(m); } catch {}
  }
});
const send = (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`);
const until = (pred, ms = 60000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout; stderr=${stderr.slice(-800)}`)), ms);
  const w = (m) => { if (pred(m)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); resolve(m); } };
  waiters.push(w);
});
async function turn(message) {
  const done = until((m) => m.type === 'agent_settled');
  send({ type: 'prompt', message });
  await done;
}
async function setModel([provider, modelId]) {
  const r = until((m) => m.type === 'response' && m.command === 'set_model');
  send({ type: 'set_model', provider, modelId });
  const m = await r;
  assert.ok(m.success, JSON.stringify(m));
}

const CODEX_PROMPT = /Compaction does not end the task/;
const PI_TOOLS = ['bash', 'edit', 'read', 'write'];

// Claude models that accept mid-conversation tool changes keep the first request's tools and
// system at the top level and express later changes as inline blocks; the others replay the
// current state as a fresh head. Either way the effective state is what the model acts on.
const claudeBlocks = (r) => (r.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
function claudeTools(r) {
  const set = new Set((r.body.tools ?? []).map((t) => t.name).filter((n) => !n.startsWith('__')));
  for (const b of claudeBlocks(r)) {
    if (b.type === 'tool_removal') set.delete(b.tool.name);
    if (b.type === 'tool_addition') set.add(b.tool.definition.name);
  }
  return [...set];
}
const claudeUpdates = (r) => (r.body.messages ?? [])
  .filter((m) => m.role === 'system')
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []).map((c) => c.text ?? ''));
function claudeSections(r) {
  const sections = new Map();
  for (const text of claudeUpdates(r)) {
    for (const m of text.matchAll(/(Updated|Removed) system prompt section "(\w+)"/g)) sections.set(m[2], m[1]);
  }
  return sections;
}
const codexTools = (r) => (r.body.tools ?? r.body.input.find((i) => i.type === 'additional_tools')?.tools ?? [])
  .flatMap((t) => (t.type === 'namespace' ? t.tools : [t])).map((t) => t.name);
const developerTexts = (r) => r.body.input
  .filter((i) => i.role === 'developer' && i.content !== undefined)
  .map((i) => (typeof i.content === 'string' ? i.content : i.content.map((c) => c.text ?? '').join('')));
// The Codex prompt lives in `instructions` or in a developer message, either as the head or as an update.
const codexPromptText = (r) => [r.body.instructions ?? '', ...developerTexts(r)].join('\n');

try {
  await turn('hi 1');
  await setModel(second);
  await turn('hi 2');
  await setModel(first);
  await turn('hi 3');
  assert.equal(reqs.length, 3, reqs.map((r) => r.kind).join(','));

  for (const r of reqs) {
    if (r.kind === 'claude') {
      assert.deepEqual(claudeTools(r).sort(), PI_TOOLS, `Claude effective tools: ${claudeTools(r)}`);
      assert.deepEqual(Object.keys(r.headers).filter((h) => /openai|codex/.test(h)), [], 'Claude request must carry no Codex headers');
      // A Claude request may still hold the Codex prompt in its head, but only if a later update replaced it.
      const head = JSON.stringify(r.body.system ?? '');
      if (CODEX_PROMPT.test(head)) {
        const sections = claudeSections(r);
        assert.equal(sections.get('preamble'), 'Updated', 'stale Codex preamble must be replaced inline');
        assert.equal(sections.get('gpt_tools'), 'Removed', 'Codex tools section must be removed inline');
      }
    } else {
      const tools = codexTools(r);
      for (const name of ['apply_patch', 'exec_command', 'write_stdin']) assert.ok(tools.includes(name), `${name} missing: ${tools}`);
      for (const name of ['edit', 'write', 'bash']) assert.ok(!tools.includes(name), `${name} leaked into Codex: ${tools}`);
      assert.match(codexPromptText(r), CODEX_PROMPT, 'GPT must end up with the Codex prompt');
      assert.equal(r.headers['x-openai-internal-codex-responses-lite'], 'true');
    }
  }

  const label = startWithClaude ? 'claude -> gpt -> claude' : 'gpt -> claude -> gpt';
  console.log(`ok ${label} (${CLAUDE}); effective tools: ${reqs.map((r) => (r.kind === 'claude' ? claudeTools(r) : codexTools(r)).join('+')).join(' | ')}`);
} catch (e) {
  console.error(stderr.split('\n').filter((l) => /rror/.test(l)).join('\n'));
  throw e;
} finally {
  child.kill();
  server.close();
  await fs.rm(D, { recursive: true, force: true });
}
