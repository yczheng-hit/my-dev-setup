// Opt-in offline integration test: real pi CLI + pi-openai-codex-compat + pi-gpt-codex against a
// local mock of the ChatGPT Codex Responses endpoint. Never contacts a real model.
//
//   PI_GPT_CODEX_LIVE_TEST=1 PI_HOST_DIR=<pi-coding-agent dir> PI_COMPAT_DIR=<pi-openai-codex-compat dir> \
//     node test/live-codex.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

const LITE = process.env.LIVE_LITE !== '0';
const requests = [];
let upgrades = 0;
let scenario = [];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const message = (id, text, phase) => ({ type: 'message', id, role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] });
function respond(items, endTurn) {
  const id = `resp_${requests.length}`;
  const events = [{ type: 'response.created', response: { id, status: 'in_progress' } }];
  items.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } });
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  events.push({ type: 'response.completed', response: { id, status: 'completed', end_turn: endTurn, output: items, usage } });
  return sse(events);
}

const server = http.createServer(async (req, res) => {
  if (process.env.LIVE_DEBUG) console.error("HEAD", req.method, req.url, req.headers['content-encoding'], req.headers['content-length']);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'zstd') body = zlib.zstdDecompressSync(body);
  if (process.env.LIVE_DEBUG) console.error("HIT", req.method, req.url);
  if (!req.url.endsWith('/codex/responses')) {
    res.writeHead(404).end();
    return;
  }
  const json = JSON.parse(body.toString('utf8'));
  requests.push({ headers: req.headers, body: json });
  if (process.env.LIVE_DUMP) await fs.writeFile(`${process.env.LIVE_DUMP}/req${requests.length}.json`, JSON.stringify(json, null, 1));
  if (process.env.LIVE_DEBUG) console.error("REQ", requests.length, req.url, JSON.stringify(json).slice(0, 300));
  const step = scenario[requests.length - 1] ?? scenario.at(-1);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(step(json));
});
server.on('upgrade', (req, socket) => {
  if (process.env.LIVE_DEBUG) console.error('UPGRADE', req.url);
  upgrades += 1;
  socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/backend-api`;

const D = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gpt-codex-live-')));
const agentDir = path.join(D, 'agent');
const work = path.join(D, 'work');
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(work);
const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' } })).toString('base64url');
const token = `e30.${claims}.sig`;
await fs.writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'r', expires: Date.now() + 3600e3, accountId: 'acct_test' } }));
await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { baseUrl } } }));
await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ transport: 'sse', modelThinkingLevels: { 'openai-codex/gpt-6.1-sol': 'xhigh' } }));
await fs.writeFile(path.join(agentDir, 'openai-codex-compat.json'), JSON.stringify({ responsesLite: LITE, fastMode: process.env.LIVE_COMPAT_FAST === '1', reasoningSummary: 'off', imageGeneration: false }));
if (process.env.LIVE_FAST === '1') {
  await fs.mkdir(path.join(agentDir, 'extensions'));
  await fs.writeFile(path.join(agentDir, 'extensions', 'pi-fast-mode.json'), JSON.stringify({ active: true }));
}
await fs.writeFile(path.join(work, 'notes.txt'), 'hello\n');

function runPi(prompt) {
  const args = [path.join(host, 'dist/bundle/cli.js'), '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    ...(process.env.LIVE_EXTRA_FIRST ?? '').split(',').filter(Boolean).flatMap((ext) => ['-e', ext]),
    '-e', path.join(compat, 'extensions/index.ts'), '-e', path.join(root, 'extensions/index.ts'),
    ...(process.env.LIVE_EXTRA_EXT ?? '').split(',').filter(Boolean).flatMap((ext) => ['-e', ext]),
    '--provider', 'openai-codex', '--model', 'gpt-6.1-sol', '-p', prompt];
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, {
      cwd: work, timeout: Number(process.env.LIVE_TIMEOUT ?? 60000),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: D, PI_SKIP_VERSION_CHECK: '1' },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(); // pi -p waits for EOF on a piped stdin
  });
}
const toolNames = (body) => {
  const tools = body.tools ?? body.input.find((i) => i.type === 'additional_tools')?.tools ?? [];
  return tools.flatMap((t) => (t.type === 'namespace' ? t.tools : [t])).map((t) => t.name);
};
const prompt = (body) => {
  const dev = body.input.filter((i) => i.type === 'message' && i.role === 'developer');
  return [body.instructions ?? '', ...dev.map((i) => i.content.map((c) => c.text ?? '').join(''))].join('\n');
};

try {
  // 1) end_turn=false without tool calls must be continued; then an apply_patch edit, then a final answer.
  const patch = '*** Begin Patch\n*** Update File: notes.txt\n@@\n-hello\n+hello codex\n*** End Patch\n';
  scenario = [
    () => respond([message('m1', 'Checking the file first.', 'commentary')], false),
    () => respond([{ type: 'custom_tool_call', id: 'ct1', call_id: 'call_patch', name: 'apply_patch', input: patch, status: 'completed' }], false),
    () => respond([message('m2', 'DONE_FINAL', 'final_answer')], true),
  ];
  const run = await runPi('Change hello to hello codex in notes.txt');
  if (process.env.LIVE_DEBUG) console.error("STDOUT", run.stdout.slice(-2000), "STDERR", run.stderr.slice(-3000));
  assert.equal(run.error, null, run.stderr);
  assert.match(run.stdout, /DONE_FINAL/);
  assert.equal(requests.length, 3, 'end_turn=false must trigger a follow-up request');
  assert.equal(await fs.readFile(path.join(work, 'notes.txt'), 'utf8'), 'hello codex\n', 'apply_patch must edit the file');

  const first = requests[0];
  assert.equal(first.body.reasoning.effort, 'xhigh');
  if (LITE) assert.equal(first.body.reasoning.context, 'all_turns');
  assert.equal(first.body.reasoning.summary, undefined);
  if (LITE) assert.equal(first.body.parallel_tool_calls, false);
  if (LITE) assert.equal(first.headers['x-openai-internal-codex-responses-lite'], 'true');
  assert.ok(first.body.include.includes('reasoning.encrypted_content'));
  const tools = toolNames(first.body);
  for (const name of ['apply_patch', 'exec_command', 'write_stdin']) assert.ok(tools.includes(name), `${name} missing: ${tools}`);
  for (const name of ['edit', 'write', 'bash']) assert.ok(!tools.includes(name), `${name} should be replaced: ${tools}`);
  const system = prompt(first.body);
  assert.match(system, /Compaction does not end the task/);
  assert.match(system, /`apply_patch` is the only way/);
  assert.ok(!system.includes('Be concise in your responses'));
  assert.ok(!system.includes('You are an expert coding assistant operating inside pi'));
  const continued = requests[1].body.input;
  assert.ok(continued.some((i) => i.type === 'message' && i.role === 'assistant'), 'commentary must be replayed');
  assert.ok(!continued.slice(-1).some((i) => i.role === 'user' && JSON.stringify(i).includes('continue')), 'no synthetic user continue');
  if (process.env.LIVE_FAST === '1') console.log('service_tier=' + first.body.service_tier + ' lite-header=' + first.headers['x-openai-internal-codex-responses-lite']);
  console.log(`ok request shape, tools=[${tools.join(',')}], follow-ups=${requests.length - 1}`);
} finally {
  server.close();
  await fs.rm(D, { recursive: true, force: true });
}
