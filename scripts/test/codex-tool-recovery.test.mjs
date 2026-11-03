// Pure request-copy checks; no credentials, sessions or model/network calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const host = process.env.PI_HOST_DIR;
let register, recover, names;
if (host) {
  const fromHost = createRequire(path.join(host, 'package.json'));
  const { createJiti } = await import(pathToFileURL(path.join(path.dirname(fromHost.resolve('jiti/package.json')), 'lib/jiti.mjs')));
  const alias = { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'), 'typebox/value': fromHost.resolve('typebox/value'), typebox: fromHost.resolve('typebox') };
  for (const name of ['pi-ai', 'pi-tui', 'pi-agent-core']) {
    alias[`@earendil-works/${name}`] = fromHost.resolve.paths(`@earendil-works/${name}`).map(base => path.join(base, `@earendil-works/${name}/dist/index.js`)).find(file => fs.existsSync(file));
  }
  const jiti = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false });
  const dir = fileURLToPath(new URL('../../packages/pi-openai-codex-compat/extensions/openai-codex-compat/', import.meta.url));
  ({ default: register, recoverUnavailableCodexCalls: recover } = await jiti.import(path.join(dir, 'tool-recovery.ts')));
  ({ CODEX_TOOL_NAMES: names } = await jiti.import(path.join(dir, 'tools.ts')));
  const recoverOwned = recover;
  recover = (messages, active) => recoverOwned(messages, active, new Set(names));
}
const assistant = (name, id = 'call') => ({ role: 'assistant', content: [{ type: 'toolCall', name, id, arguments: {} }] });
const result = (name, id = 'call', extra = {}) => ({ role: 'toolResult', toolName: name, toolCallId: id, isError: true, content: [{ type: 'text', text: `Tool ${name} not found` }], timestamp: 1, ...extra });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
function harness() {
  const handlers = new Map(); let active = [];
  register({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => active }, names);
  const options = { sections: { other_extension: 'keep' }, selectedTools: [], hiddenTools: [] };
  let branch = [];
  return { handlers, options, setActive: names => { active = names; options.selectedTools = names; }, setBranch: value => { branch = value; },
    before: () => handlers.get('before_agent_start')({ systemPromptOptions: options }, { sessionManager: { getBranch: () => branch } }) };
}

test('every actual owned tool gets an actionable exact-error hint, but only current alternatives are named', { skip: !host }, () => {
  assert.deepEqual([...names].sort(), ['apply_patch', 'exec_command', 'image_gen.imagegen', 'shell_command', 'web.run', 'write_stdin'].sort());
  for (const name of names) {
    const original = freeze([assistant(name), result(name)]), before = JSON.stringify(original);
    const changed = recover(original, ['read', 'replace', 'insert', 'bash']);
    assert.equal(changed[0], original[0]); assert.notEqual(changed[1], original[1]);
    assert.equal(changed[1].toolCallId, 'call'); assert.equal(changed[1].toolName, name); assert.equal(changed[1].isError, true);
    const text = changed[1].content[0].text;
    assert.match(text, /not executed/); assert.match(text, /Do not retry/);
    assert.ok(!text.includes('Current editing tools: edit')); assert.ok(!text.includes('powershell'));
    assert.equal(JSON.stringify(original), before);
    assert.equal(recover(changed, ['read', 'replace', 'insert', 'bash']), undefined, 'idempotent');
  }
});
test('active, foreign, successful, unmatched and non-dispatch errors are not rewritten', { skip: !host }, () => {
  const baseline = [assistant('apply_patch'), result('apply_patch')];
  assert.equal(recover(baseline, ['apply_patch']), undefined);
  for (const messages of [
    [assistant('foreign'), result('foreign')],
    [assistant('apply_patch'), result('apply_patch', 'call', { isError: false })],
    [assistant('apply_patch'), result('apply_patch', 'unmatched')],
    [assistant('exec_command'), result('apply_patch')],
    [result('apply_patch')],
    [assistant('apply_patch'), result('apply_patch', 'call', { content: [{ type: 'text', text: 'Patch failed: Tool apply_patch not found' }] })],
    [assistant('apply_patch'), result('apply_patch', 'call', { content: [{ type: 'text', text: 'Permission denied' }] })],
    [{ role: 'user', content: 'Tool apply_patch not found' }],
  ]) assert.equal(recover(freeze(messages), ['write']), undefined);
});
test('restricted loadouts never recommend a hidden/inactive tool or shell workaround for editing', { skip: !host }, () => {
  const text = recover([assistant('apply_patch'), result('apply_patch')], ['read', 'bash'])[1].content[0].text;
  assert.match(text, /No editing replacement/); assert.ok(!text.includes('Current command tools'));
  const command = recover([assistant('write_stdin'), result('write_stdin')], ['read'])[1].content[0].text;
  assert.match(command, /No command replacement/);
  const shell = recover([assistant('write_stdin'), result('write_stdin')], ['bash'])[1].content[0].text;
  assert.match(shell, /old Codex exec session IDs cannot be resumed/);
});
test('guidance is branch-derived, bounded to owned tools, cleaned on return/new branch and has no side effects', { skip: !host }, () => {
  const h = harness(); h.setActive(['read', 'bash', 'replace']); h.before();
  assert.deepEqual(h.options.sections, { other_extension: 'keep' }, 'fresh non-Codex sessions unchanged');
  h.setBranch([{ type: 'message', message: assistant('apply_patch') }, { type: 'message', message: assistant('foreign') }]);
  h.before();
  const text = h.options.sections.codex_tool_surface_recovery;
  assert.match(text, /apply_patch.*unavailable/); assert.ok(!text.includes('foreign')); assert.match(text, /replace/);
  assert.ok(!text.includes('Current editing tools: edit'));
  h.setActive(['read', 'apply_patch']); h.before();
  assert.deepEqual(h.options.sections, { other_extension: 'keep' }, 'switch-back removes stale guidance');
  h.setActive(['read', 'bash', 'replace']); h.setBranch([]); h.before();
  assert.deepEqual(h.options.sections, { other_extension: 'keep' }, 'new/tree branch has no other branch state');
  assert.deepEqual([...h.handlers.keys()].sort(), ['before_agent_start', 'context_with_system']);
});

test('hidden declarations are not advertised as replacements by either hook', { skip: !host }, () => {
  const h = harness(); h.setActive(['read', 'write', 'bash']); h.options.hiddenTools = ['write'];
  h.setBranch([{ type: 'message', message: assistant('apply_patch') }]); h.before();
  assert.match(h.options.sections.codex_tool_surface_recovery, /No editing replacement/);
  const changed = h.handlers.get('context_with_system')({ messages: [{ role: 'system', content: '', toolsAdded: [{ name: 'read' }, { name: 'write' }, { name: 'bash' }] }, assistant('apply_patch'), result('apply_patch')] });
  assert.match(changed.messages[2].content[0].text, /No editing replacement/);
});
