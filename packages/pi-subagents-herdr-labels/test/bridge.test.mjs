import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { filterHerdrLabels } from '../extensions/labels.mjs';

const entry = createRequire(join(process.env.PI_AGENT_HOME ?? join(homedir(), '.pi/agent'), 'npm/package.json')).resolve('pi-subagents');
const { registerHerdrStatusBridge } = await import(pathToFileURL(join(dirname(entry), 'src/integrations/herdr-status.js')));

test('real upstream bridge retains lifecycle and summary across overlap, refresh, completion, reload', async () => {
  const listeners = new Map(), reports = [], busy = [];
  let refresh;
  const options = {
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3' },
    events: { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); }, emit(name, data) { busy.push([name, data]); } },
    timers: { setInterval(fn) { refresh = fn; return 1; }, clearInterval() { refresh = undefined; } },
    runHerdr(args) { reports.push(filterHerdrLabels('herdr', args)); },
  };
  let bridge = registerHerdrStatusBridge(options);
  const last = () => reports.at(-1);
  const summary = () => last().find(x => x.startsWith('summary='));
  const assertLabels = () => { assert.ok(!last().includes('--state-label')); assert.ok(last().includes('--clear-state-labels')); };
  bridge.sessionStarted({ hasUI: true, runs: [{ id: 'one', agent: 'reviewer' }] });
  await bridge.flush(); assertLabels(); assert.match(summary(), /1 subagent \(reviewer\)/);
  assert.ok(busy.some(([event, data]) => event === 'herdr:busy' && data.active));
  listeners.get('subagent:async-started')({ id: 'two', agent: 'tester' });
  await bridge.flush(); assertLabels(); assert.match(summary(), /2 subagents/);
  refresh(); await bridge.flush(); assertLabels(); assert.match(summary(), /2 subagents/);
  listeners.get('subagent:async-complete')({ id: 'one' });
  await bridge.flush(); assertLabels(); assert.match(summary(), /1 subagent \(tester\)/);
  listeners.get('subagent:async-complete')({ id: 'two' });
  await bridge.flush();
  assert.ok(last().includes('--clear-token')); assert.equal(summary(), undefined); assert.equal(refresh, undefined);
  bridge.dispose(); await bridge.flush(); assert.equal(listeners.size, 0);
  bridge = registerHerdrStatusBridge(options);
  bridge.sessionStarted({ hasUI: true, runs: [{ id: 'restored', agent: 'reviewer' }] });
  await bridge.flush(); assertLabels(); assert.match(summary(), /1 subagent/);
  bridge.syncRuns(); await bridge.flush(); assertLabels();
  bridge.dispose(); await bridge.flush(); assert.equal(summary(), undefined);
});
