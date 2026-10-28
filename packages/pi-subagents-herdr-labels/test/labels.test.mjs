import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterHerdrLabels, registerWithHerdrLabels } from '../extensions/labels.mjs';

const report = ['pane', 'report-metadata', 'w1:p3', '--source', 'pi-subagents:herdr', '--agent', 'pi', '--applies-to-source', 'herdr:pi', '--state-label', 'idle=⏳ 1 subagent (reviewer)', '--state-label', 'done=⏳ 1 subagent (reviewer)', '--state-label', 'working=⏳ 1 subagent (reviewer)', '--token', 'summary=⏳ 1 subagent (reviewer)', '--token', 'title-suffix=⏳reviewer', '--ttl-ms', '120000', '--seq', '42'];
test('drops only upstream state-label pairs; keeps summary, title, TTL, scope and sequence', () => {
  const filtered = filterHerdrLabels('herdr', report);
  assert.ok(!filtered.includes('--state-label'));
  assert.deepEqual(filtered, [...report.filter((_, i) => ![9, 10, 11, 12, 13, 14].includes(i)), '--clear-state-labels']);
  assert.ok(report.includes('--state-label'), 'input is immutable');
});
test('leaves completion cleanup and unrelated command arguments untouched', () => {
  const clear = ['pane', 'report-metadata', 'w1:p3', '--source', 'pi-subagents:herdr', '--clear-state-labels', '--clear-token', 'summary'];
  assert.equal(filterHerdrLabels('herdr', clear), clear);
  const get = ['pane', 'get', 'w1:p3'];
  assert.equal(filterHerdrLabels('herdr', get), get);
});
test('never filters another metadata source, blocked reasons, or ordinary processes', () => {
  for (const args of [report.map(x => x === 'pi-subagents:herdr' ? 'user:pi-blocked-reason' : x), ['pane', 'report-metadata', 'w1:p3', '--source', 'other', '--state-label', 'blocked=3 approval']]) {
    assert.equal(filterHerdrLabels('herdr', args), args);
  }
  assert.equal(filterHerdrLabels('echo', report), report);
  assert.ok(!filterHerdrLabels('/opt/homebrew/bin/herdr', report).includes('--state-label'));
  assert.ok(!filterHerdrLabels('/custom/herdr-dev', report, { HERDR_BIN: '/custom/herdr-dev' }).includes('--state-label'));
});
test('upstream factory gets a private exec adapter, not a globally changed Pi API', async () => {
  const calls = [];
  const original = async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const api = { exec: original, on() {}, events: {} };
  let captured;
  registerWithHerdrLabels(api, p => { captured = p; });
  assert.notEqual(captured, api);
  assert.equal(api.exec, original);
  assert.equal(captured.events, api.events);
  const options = { timeout: 5000 };
  await captured.exec('herdr', report, options);
  assert.ok(!calls[0][1].includes('--state-label'));
  assert.equal(calls[0][2], options);
  await api.exec('herdr', report, options);
  assert.equal(calls[1][1], report);
});
