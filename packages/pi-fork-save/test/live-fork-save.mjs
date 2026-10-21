// Opt-in integration test: two real Pi TUIs in an isolated tmux server.
// Uses only the local fake provider; never contacts a model or touches user sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.env.PI_FORK_SAVE_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_FORK_SAVE_LIVE_TEST=1');
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed pi-coding-agent directory');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { SessionManager } = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const D = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-save-live-'));
const socket = path.join(D, 'tmux.sock');
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const capture = target => tmux('capture-pane', '-p', '-t', target, '-S', '-200');
async function until(check, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function submit(target, text) {
  tmux('send-keys', '-t', target, '-l', text);
  tmux('send-keys', '-t', target, 'Enter');
}

try {
  const dir = path.join(D, 'sessions');
  await fs.mkdir(dir);
  const source = SessionManager.create(D, dir);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const n of [1, 2]) {
    source.appendMessage({ role: 'user', content: `seed question ${n}`, timestamp: Date.now() });
    source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `seed answer ${n}` }], api: 'openai-responses', provider: 'btw-live-fake', model: 'fixture', usage: zero, stopReason: 'stop', timestamp: Date.now() });
  }
  source.appendSessionInfo('Live main');
  const adapter = path.join(D, 'clipboard-free.ts');
  await fs.writeFile(adapter, `import { registerForkSave } from ${JSON.stringify(path.join(root, 'extensions/index.ts'))};\nexport default pi => registerForkSave(pi, async () => {});\n`);
  const fake = path.join(root, '../pi-subagent-hud/test/fixtures/fake-provider.ts');
  const args = [process.execPath, path.join(host, 'dist/bundle/cli.js'), '--offline', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', adapter, '-e', fake, '--model', 'btw-live-fake/fixture', '--session-dir', dir];
  const command = file => `env PI_SKIP_VERSION_CHECK=1 PI_CODING_AGENT_DIR=${quote(path.join(D, 'agent'))} HOME=${quote(D)} ${[...args, '--session', file].map(quote).join(' ')}`;
  tmux('new-session', '-d', '-s', 'main', '-x', '150', '-y', '45', '-c', D, command(source.getSessionFile()));
  await until(() => capture('main').includes('seed answer 2'), 'main restored');
  await sleep(1000);
  const before = await fs.readFile(source.getSessionFile(), 'utf8');
  await submit('main', '/fork-save Live saved fork');
  await until(() => capture('main').includes('分叉保存到哪里为止'), 'fork picker');
  // Default entry = current position. No session switch should occur.
  tmux('send-keys', '-t', 'main', 'Enter');
  await until(() => capture('main').includes('已保存分叉'), 'fork saved notification');
  const screen = capture('main');
  const id = screen.match(/会话 ID：([\w.-]+)/)?.[1];
  assert.ok(id, screen);
  const savedFile = SessionManager.findById(D, id, dir);
  assert.ok(savedFile);
  assert.equal(await fs.readFile(source.getSessionFile(), 'utf8'), before);
  assert.equal(SessionManager.open(savedFile).getSessionName(), 'Live saved fork');
  const savedBefore = await fs.readFile(savedFile, 'utf8');
  await submit('main', 'main continuation');
  await until(async () => (await fs.readFile(source.getSessionFile(), 'utf8')).includes('FAKE_REPLY_'), 'main continuation stayed in original file');
  assert.equal(await fs.readFile(savedFile, 'utf8'), savedBefore);

  // Open the fork later with exactly --session <file>, then continue it.
  tmux('new-session', '-d', '-s', 'fork', '-x', '150', '-y', '45', '-c', D, command(savedFile));
  await until(() => capture('fork').includes('seed answer 2'), '--session restores saved context');
  assert.ok(!capture('fork').includes('main continuation'));
  await submit('fork', 'fork continuation');
  await until(async () => (await fs.readFile(savedFile, 'utf8')).includes('FAKE_REPLY_'), 'fork continues independently');
  assert.ok(!(await fs.readFile(source.getSessionFile(), 'utf8')).includes('fork continuation'));
  console.log('LIVE_FORK_SAVE_OK: foreground unchanged, snapshot saved, --session restore and independent continuation');
} catch (error) {
  try { console.error(capture('main')); } catch {}
  throw error;
} finally {
  try { tmux('kill-server'); } catch {}
  await fs.rm(D, { recursive: true, force: true });
}
