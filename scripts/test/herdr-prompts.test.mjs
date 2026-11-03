import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = stripTypeScriptTypes(readFileSync(new URL('../../pi/extensions/herdr-ui-prompt-blocked.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\s*$/gm, '').replace('export default function', 'function extension');
function fixture() {
  const handlers = new Map(); const bus = new EventEmitter(); const events = []; const calls = []; const pendingGets = [];
  bus.on('herdr:blocked', (event) => events.push(event));
  const pi = { on: (name, fn) => handlers.set(name, fn), events: {
    on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (...args) => bus.emit(...args),
  } };
  const execFile = (_bin, args, _options, done) => {
    calls.push(args);
    if (args[1] === 'get') pendingGets.push(done);
    else done?.();
  };
  vm.runInNewContext(source + '\nextension(pi);', { pi, execFile, process: { env: { HERDR_ENV: '1', HERDR_PANE_ID: 'fixture-pane' } } });
  return { events, calls, bus, pendingGets,
    emit: (name, event = {}) => handlers.get(name)?.(event),
    bootstrap: (active) => bus.emit('btw:ui-bootstrap', { active }),
    finishGets: () => { for (const done of pendingGets.splice(0)) done(null, JSON.stringify({ result: { pane: { state_labels: { idle: '7' } } } })); },
  };
}

test('nested prompt close keeps outer prompt blocked and restores its label', () => {
  const f = fixture();
  f.emit('ui_prompt_start', { kind: 'custom', title: 'outer' });
  f.emit('ui_prompt_start', { kind: 'confirm', title: 'inner' });
  f.emit('ui_prompt_end', { kind: 'confirm', title: 'inner' });
  assert.equal(f.events.at(-1).active, true);
  assert.equal(f.events.at(-1).label, 'outer');
  f.emit('ui_prompt_end', { kind: 'custom', title: 'outer' });
  assert.equal(f.events.at(-1).active, false);
});

test('BTW ignored bootstrap cannot consume a real nested prompt end', () => {
  const f = fixture(); f.bootstrap(true);
  f.emit('ui_prompt_start', { kind: 'custom' }); f.bootstrap(false);
  f.emit('ui_prompt_start', { kind: 'confirm', title: 'real approval' });
  f.emit('ui_prompt_end', { kind: 'confirm', title: 'real approval' });
  assert.equal(f.events.at(-1).active, false);
  const count = f.events.length;
  f.emit('ui_prompt_end', { kind: 'custom' });
  assert.equal(f.events.length, count);
});

test('tool label classification and numbered metadata remain display-only', () => {
  const f = fixture();
  f.emit('tool_execution_start', { toolCallId: 'tool-1', toolName: 'ExitPlanMode' });
  f.emit('ui_prompt_start', { kind: 'custom' }); f.finishGets();
  assert.equal(f.events.at(-1).label, 'plan ready');
  assert.ok(f.calls.some((args) => args.includes('blocked=7 plan ready')));
  assert.ok(f.calls.filter((args) => args[1] === 'report-metadata').every((args) => args.includes('user:pi-blocked-reason')));
});

test('shutdown clears owned metadata, releases bootstrap listener and fences late callbacks', () => {
  const f = fixture(); f.emit('ui_prompt_start', { kind: 'custom' });
  f.emit('session_shutdown');
  const count = f.calls.length;
  f.finishGets();
  assert.equal(f.calls.length, count);
  assert.equal(f.events.at(-1).active, false);
  assert.equal(f.bus.listenerCount('btw:ui-bootstrap'), 0);
  assert.ok(f.calls.at(-1).includes('--clear-state-labels'));
});
