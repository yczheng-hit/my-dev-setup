import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const host = process.env.PI_HOST_DIR;
const script = fileURLToPath(new URL('../check-pi-extensions.mjs', import.meta.url));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-preflight-test-')));
  const repo = path.join(root, 'repo'); const agent = path.join(root, 'installed');
  fs.mkdirSync(path.join(repo, 'pi/extensions'), { recursive: true });
  fs.mkdirSync(agent);
  const put = (relative, data) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return target; };
  const pkg = (relative, code, extensions = ['./index.ts']) => {
    put(`${relative}/package.json`, JSON.stringify({ name: path.basename(relative), version: '1.0.0', type: 'module', main: './index.ts', pi: { extensions } }));
    put(`${relative}/index.ts`, code);
  };
  const run = (packages) => {
    put('repo/pi/settings.json', JSON.stringify({ packages }));
    return spawnSync(process.execPath, [script, repo, '--host', host, '--agent-dir', agent], { encoding: 'utf8', timeout: 40_000 });
  };
  return { root, repo, agent, put, pkg, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const opts = { skip: !host };
test('composes repo, installed npm+git, filtered factory and standalone with shutdown', opts, () => {
  const f = fixture(); try {
    f.pkg('repo/packages/local', 'export default p => p.registerCommand("local", {handler: async () => {}});');
    f.pkg('installed/npm/node_modules/filtered', 'throw new Error("filtered factory ran");');
    f.pkg('installed/git/github.com/example/plugin', 'export default p => p.registerCommand("git", {handler: async () => {}});');
    f.put('repo/pi/extensions/standalone.ts', 'export default p => { p.registerCommand("standalone", {handler:async()=>{}}); p.on("session_shutdown", () => {}); };');
    f.put('repo/pi/extensions/claude-rules.ts', 'throw new Error("retired factory ran");');
    const before = fs.statSync(f.agent).mtimeMs;
    const result = f.run(['repo:packages/local', { source: 'npm:filtered', extensions: [] }, 'git:github.com/example/plugin']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /loaded=3 missing=0 failed=0/);
    assert.equal(fs.statSync(f.agent).mtimeMs, before);
  } finally { f.cleanup(); }
});
test('missing packages report incomplete, never install', opts, () => {
  const f = fixture(); try {
    const result = f.run(['npm:not-installed', 'repo:packages/not-here']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /missing=2 failed=0/);
    assert.deepEqual(fs.readdirSync(f.agent), []);
  } finally { f.cleanup(); }
});
test('duplicate commands are namespaced while missing declared entries fail', opts, () => {
  const f = fixture(); try {
    for (const name of ['a', 'b']) f.pkg(`repo/packages/${name}`, 'export default p => p.registerCommand("same", {handler: async () => {}});');
    f.pkg('repo/packages/missing', 'export default () => {};', ['./absent.ts']);
    const result = f.run(['repo:packages/a', 'repo:packages/b', 'repo:packages/missing']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /command \/same namespaced by Pi/);
    assert.match(result.stdout, /missing declared entry/);
  } finally { f.cleanup(); }
});
test('factory side effects cannot write outside sandbox or spawn or fetch; identity scrubbed', opts, () => {
  const f = fixture(); try {
    const marker = f.put('installed/sentinel', 'unchanged');
    f.pkg('repo/packages/hostile', `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
      export default () => {
        if (process.env.HERDR_PANE_ID || process.env.OPENAI_API_KEY) throw new Error('identity leaked');
        for (const fn of [() => fs.writeFileSync(${JSON.stringify(marker)}, 'changed'), () => spawnSync('true'), () => fetch('https://example.invalid')]) {
          let blocked=false; try { fn(); } catch { blocked=true; } if (!blocked) throw new Error('side effect allowed');
        }
      };`);
    const result = f.run(['repo:packages/hostile']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
  } finally { f.cleanup(); }
});

test('pinned npm mismatch is incomplete rather than silently testing another version', opts, () => {
  const f = fixture(); try {
    f.pkg('installed/npm/node_modules/pinned', 'export default () => {};');
    const result = f.run(['npm:pinned@2.0.0']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /does not satisfy configured source/);
    assert.match(result.stdout, /loaded=0 missing=1 failed=0/);
  } finally { f.cleanup(); }
});

test('preflight loads preserved custom standalone code rather than the repository replacement', opts, () => {
  const f = fixture(); try {
    f.put('repo/pi/extensions/question.ts', 'export default () => {};');
    f.put('installed/extensions/question.ts', 'throw new Error("PRESERVED_CUSTOM_FAILS");');
    const result = f.run([]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /PRESERVED_CUSTOM_FAILS/);
  } finally { f.cleanup(); }
});
test('preflight also includes unknown retained standalone extensions', opts, () => {
  const f = fixture(); try {
    f.put('installed/extensions/custom.ts', 'throw new Error("UNKNOWN_CUSTOM_FAILS");');
    const result = f.run([]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /UNKNOWN_CUSTOM_FAILS/);
  } finally { f.cleanup(); }
});
test('preflight retains explicit local extension paths inherited by settings merge', opts, () => {
  const f = fixture(); try {
    f.put('installed/settings.json', JSON.stringify({ extensions: ['./external.ts'] }));
    f.put('installed/external.ts', 'throw new Error("RETAINED_EXPLICIT_FAILS");');
    const result = f.run([]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /RETAINED_EXPLICIT_FAILS/);
  } finally { f.cleanup(); }
});
test('preflight excludes known retired Claude rules and rejects unknown legacy ownership', opts, () => {
  const f = fixture(); try {
    f.put('installed/extensions/claude-rules.ts', '// Retired: .agents/rules is provided by repo:packages/pi-agents-context.\nthrow new Error("RETIRED_RAN");');
    const known = f.run([]);
    assert.equal(known.status, 0, known.stdout + known.stderr);
    assert.match(known.stdout, /loaded=0 missing=0 failed=0/);
    f.put('installed/extensions/claude-rules.ts', 'throw new Error("CUSTOM_LEGACY");');
    const unknown = f.run([]);
    assert.equal(unknown.status, 1); assert.match(unknown.stdout + unknown.stderr, /Custom legacy extension preserved/);
  } finally { f.cleanup(); }
});
