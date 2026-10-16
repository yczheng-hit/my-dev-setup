// Opt-in live test: real Pi + pi-subagents + pi-hud-footer + this extension in a temporary,
// unfocused Herdr tab; parent and children use the local fake model (no paid calls).
// Asserts on the pane's visible text only. PI_HUD_LIVE_TEST=1 node test/live-hud.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { herdrApi } = await import(new URL('../../../tools/pi-btw-split/native/herdr.mjs', import.meta.url));

if (process.env.PI_HUD_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_HUD_LIVE_TEST=1');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const host = process.env.PI_HOST_DIR; // pi-coding-agent install dir
if (!host) throw new Error('Set PI_HOST_DIR to the @earendil-works/pi-coding-agent directory');
const agentHome = process.env.PI_AGENT_HOME ?? path.join(os.homedir(), '.pi/agent');
const npm = path.join(agentHome, 'npm/node_modules');
const fake = path.join(root, 'test/fixtures/fake-provider.ts');
const api = herdrApi();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const panes = async () => (await api('pane.list')).panes;
const read = async id => (await api('pane.read', { pane_id: id, source: 'visible', format: 'text' })).read.text;
const SPIN = '[◐◓◑◒]';

const D = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-hud-live-')); await fs.chmod(D, 0o700);
const agentDir = path.join(D, 'agent');
await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true, mode: 0o700 });
await fs.mkdir(path.join(agentDir, 'extensions', 'subagent'), { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), JSON.stringify({
  toolActivation: 'eager', inlineToolDisplay: 'summary', asyncWidget: false, fleetView: false,
}));
await fs.writeFile(path.join(agentDir, 'agents', 'fake-delegate.md'), `---
name: fake-delegate
description: HUD live-test agent on the local fake model
model: btw-live-fake/fixture
tools: read
subagentOnlyExtensions: ${fake}
---
Test agent.
`);
const sessionFile = path.join(D, 's.jsonl');
const label = `HUD live ${randomUUID()}`;
const before = await panes();
const result = { scenarios: {} };
let term;
const id = async () => (await panes()).find(x => x.terminal_id === term)?.pane_id;

async function until(check, what, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('Timed out: ' + what); await sleep(200); }
}
async function submit(text) {
  await api('pane.send_text', { pane_id: await id(), text });
  await sleep(400);
  for (let i = 0; i < 4; i++) {
    await api('pane.send_keys', { pane_id: await id(), keys: ['enter'] });
    await sleep(1000);
    if (!(await read(await id())).split('\n').slice(-10).some(l => l.startsWith(text))) return;
  }
  throw new Error('prompt stayed in the editor: ' + text);
}
/** Follow one scenario: first running frame, first ✓ frame, and when the segment disappears. */
async function watch(name, runningRe, doneRe, extra = () => ({})) {
  const t0 = Date.now();
  const s = { name };
  await until(async () => { const t = await read(await id()); if (runningRe.test(t)) { s.runningAt = Date.now() - t0; s.runningLine = t.split('\n').find(l => runningRe.test(l))?.trim(); Object.assign(s, extra(t)); return true; } }, `${name}: running segment`, 30000);
  await until(async () => { const t = await read(await id()); if (doneRe.test(t)) { s.doneAt = Date.now() - t0; s.doneLine = t.split('\n').find(l => doneRe.test(l))?.trim(); return true; } }, `${name}: ✓ segment`, 60000);
  await until(async () => { const t = await read(await id()); if (!doneRe.test(t) && !runningRe.test(t)) { s.goneAt = Date.now() - t0; return true; } }, `${name}: segment gone`, 30000);
  s.lingerMs = s.goneAt - s.doneAt;
  return s;
}

try {
  const cli = [process.execPath, path.join(host, 'dist/bundle/cli.js'), '--offline', '--no-mcp', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files',
    '-e', path.join(agentHome, 'extensions/herdr-agent-state.ts'), '-e', path.join(npm, 'pi-subagents'),
    '-e', path.join(root, '../pi-hud-footer'), '-e', path.join(root, 'extensions/subagent-hud.ts'), '-e', fake,
    '--model', 'btw-live-fake/fixture', '--session', sessionFile];
  const env = { PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, BTW_FAKE_SLOW_MS: '3000' };
  await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label, root: { type: 'pane', label, cwd: D, command: cli, env } });
  term = (await until(async () => (await panes()).find(x => x.label === label && !before.some(b => b.terminal_id === x.terminal_id)), 'pane')).terminal_id;
  await until(async () => (await panes()).find(x => x.terminal_id === term)?.agent === 'pi', 'pi identity');
  await sleep(2500);

  // 1. One subagent launched through the tool: task text, model, time; ✓ then gone after ~10 s.
  await submit('CALL_SUBAGENT go');
  result.scenarios.single = await watch('single',
    new RegExp(`│ ${SPIN} fake-delegate \\[fixture\\]: SLOW_MAIN hud probe 1 \\(\\d+m \\d\\ds\\)\\s*$`, 'm'),
    /✓ fake-delegate \[fixture\]: SLOW_MAIN hud probe 1 \(/,
    t => ({ fleetLine: /active agent/.test(t), asyncWidget: /async subagent/.test(t) }));

  // 2. Two in one turn, finishing ~25 s apart (probe 2 is SLOWx3 on model fixture-b). Record every
  //    distinct HUD block until both are gone. Each segment must keep its own model and task —
  //    in particular while one has finished and the other still runs.
  await submit('CALL_TWO go');
  {
    const frames = [];
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 90000) {
      const line = (await read(await id())).split('\n').find(l => l.includes('│ ') && /fake-delegate/.test(l));
      const block = line ? line.slice(line.indexOf('│ ')).trim() : '';
      if (block) seen = true;
      if (block && frames.at(-1)?.block !== block) frames.push({ at: Date.now() - t0, block });
      if (seen && !block) break;
      await sleep(300);
    }
    const bad = [];
    for (const { at, block } of frames) {
      for (const seg of block.replace(/^│ /, '').split(' | ')) {
        const m = seg.match(/^(\S) fake-delegate \[([^\]]+)\](: (.*?))? \(/);
        if (!m) { bad.push({ at, seg, why: 'unparsed' }); continue; }
        const [, , model, , task] = m;
        if (!task) bad.push({ at, seg, why: 'task lost' });
        else if (/probe 1/.test(task) && model !== 'fixture') bad.push({ at, seg, why: 'probe 1 wrong model' });
        else if (/probe 2/.test(task) && model !== 'fixture-b') bad.push({ at, seg, why: 'probe 2 wrong model' });
      }
    }
    const sawStagger = frames.some(f => /✓ fake-delegate \[fixture\]: SLOW_MAIN hud probe 1/.test(f.block) && /[◐◓◑◒] fake-delegate \[fixture-b\]: SLOW_MAIN hud probe 2/.test(f.block));
    result.scenarios.two = { frames: frames.length, sawStagger, bad: bad.slice(0, 8), sample: frames.filter((_, i) => i % 6 === 0).map(f => `${f.at}ms ${f.block}`) };
  }

  // 3. /run launch: no task text (the RPC does not expose it).
  await submit('/run fake-delegate SLOW_MAIN via slash --bg');
  result.scenarios.slash = await watch('slash',
    new RegExp(`${SPIN} fake-delegate \\[fixture\\] \\(\\d+m \\d\\ds\\)`),
    /✓ fake-delegate \[fixture\] \(/,
    t => ({ hasTaskText: /fake-delegate \[fixture\]: /.test(t), strayWorkflow: /[◐◓◑◒•✓] workflow \(/.test(t) }));
  result.scenarios.slash.strayOnDone = /•|workflow \(/.test(result.scenarios.slash.doneLine ?? '');

  // 4. Idle polling must not write to the session.
  const snap = async () => { const text = await fs.readFile(sessionFile, 'utf8'); return { bytes: text.length, entries: text.split('\n').filter(Boolean).length }; };
  await sleep(4000);
  const idleBefore = await snap();
  await sleep(16000); // ≥3 idle polls
  const idleAfter = await snap();
  result.scenarios.idle = { before: idleBefore, after: idleAfter, unchanged: idleBefore.bytes === idleAfter.bytes && idleBefore.entries === idleAfter.entries };

  const s = result.scenarios;
  result.pass = Boolean(s.single.runningLine && !s.single.fleetLine && !s.single.asyncWidget && s.single.lingerMs >= 7000 && s.single.lingerMs <= 14000
    && s.two.sawStagger && s.two.bad.length === 0 && s.slash.runningLine && !s.slash.hasTaskText && !s.slash.strayWorkflow && !s.slash.strayOnDone
    && s.idle.unchanged);
} catch (error) {
  result.error = String(error);
  if (term) result.screen = (await read(await id()).catch(() => '')).split('\n').filter(l => l.trim()).slice(-14);
} finally {
  if (term) { const p = (await panes()).find(x => x.terminal_id === term); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }).catch(() => {}); }
  await fs.rm(D, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));
if (!result.pass) process.exitCode = 1;
