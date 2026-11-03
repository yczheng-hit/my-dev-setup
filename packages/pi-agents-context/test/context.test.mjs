import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyAgentsOnly, patchResourceLoader, retireLegacyExtension } from '../../../scripts/agents-only.mjs';
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = await import(pathToFileURL(path.join(path.dirname(require.resolve('jiti/package.json')), 'lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js') } });
const { loadAgentsRules, loadAgentsInstructions, loadAgentsContextFiles } = await jiti.import('../context.ts');
const { default: extension } = await jiti.import('../extensions/index.ts');
const { applyGptPrompt } = await jiti.import('../../pi-gpt-codex/extensions/prompt.ts');
const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await import(pathToFileURL(path.join(host, 'dist/core/system-prompt.js')));
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-only-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function put(dir, rel, content = rel) {
  const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
test('rules are ordered, trusted, deduplicated and never follow Claude symlinks', () => fixture(dir => {
  const home = path.join(dir, 'home'), project = path.join(home, 'project');
  put(home, '.agents/rules/user.md', 'USER_RULE');
  put(project, '.agents/rules/z.md', 'PROJECT_RULE'); put(project, '.agents/rules/a/a.md', 'NESTED_RULE');
  const legacy = put(project, '.claude/rules/x.md', 'CLAUDE_SECRET');
  put(project, 'CLAUDE.md', 'CLAUDE_CONTEXT'); put(project, 'AGENTS.md', 'AGENTS_CONTEXT');
  fs.symlinkSync(legacy, path.join(project, '.agents/rules/link.md'));
  fs.symlinkSync(legacy, path.join(project, 'AGENTS.override.md'));
  assert.deepEqual(loadAgentsRules(project, false, home).map(f => f.content), ['USER_RULE']);
  assert.deepEqual(loadAgentsRules(project, true, home).map(f => f.content), ['USER_RULE', 'NESTED_RULE', 'PROJECT_RULE']);
  const text = JSON.stringify(loadAgentsInstructions(project, true, path.join(dir, 'agent'), home));
  assert.match(text, /AGENTS_CONTEXT/); assert.doesNotMatch(text, /CLAUDE_SECRET|CLAUDE_CONTEXT/);
}));
test('nested linked worktree AGENTS shadows the main checkout in main/reviewer policy', () => fixture(dir => {
  const main = path.join(dir, 'main'), worktree = path.join(main, 'nested/branch');
  put(main, '.git/HEAD', 'ref: refs/heads/main');
  const metadata = path.join(main, '.git/worktrees/branch');
  put(metadata, 'HEAD', 'ref: refs/heads/branch'); put(metadata, 'commondir', '../..');
  put(worktree, '.git', `gitdir: ${metadata}`);
  put(main, 'AGENTS.md', 'MAIN_SHADOWED'); put(worktree, 'AGENTS.md', 'WORKTREE_CONTEXT');
  const files = loadAgentsContextFiles(worktree, true, path.join(dir, 'agent'));
  assert.ok(files.some(f => f.content === 'WORKTREE_CONTEXT'));
  assert.ok(!files.some(f => f.content === 'MAIN_SHADOWED'));
}));
test('structured rules coexist with GPT prompt in either order and no opaque override', () => fixture(dir => {
  put(dir, '.agents/rules/a.md', 'RULE_FOR_GPT');
  for (const reverse of [false, true]) {
    const handlers = new Map(); extension({ on: (name, fn) => handlers.set(name, fn), registerCommand() {} });
    const options = normalizeBuildSystemPromptOptions({ cwd: dir, selectedTools: ['read', 'exec_command', 'apply_patch'], contextFiles: [{ path: path.join(dir, 'AGENTS.md'), content: 'AGENT_CONTEXT' }, { path: path.join(dir, 'CLAUDE.md'), content: 'LEGACY_CONTEXT' }] });
    const run = () => assert.equal(handlers.get('before_agent_start')({ systemPromptOptions: options }, { cwd: dir, isProjectTrusted: () => true }), undefined);
    if (reverse) { applyGptPrompt(options); run(); } else { run(); applyGptPrompt(options); }
    const prompt = buildSystemPrompt(options);
    assert.match(prompt, /RULE_FOR_GPT/); assert.match(prompt, /AGENT_CONTEXT/); assert.doesNotMatch(prompt, /LEGACY_CONTEXT/);
    assert.ok(options.sections.gpt_tools); assert.equal(options.forceSystemPrompt, undefined);
  }
}));
test('actual SDK and CLI loader patch is idempotent and excludes CLAUDE before read', () => fixture(dir => {
  const sources = [path.join(host, 'dist/core/resource-loader.js')];
  for (const file of fs.readdirSync(path.join(host, 'dist/bundle/chunks'))) {
    const full = path.join(host, 'dist/bundle/chunks', file);
    if (file.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('function loadContextFileFromDir(')) sources.push(full);
  }
  assert.ok(sources.length >= 2);
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8'), patched = patchResourceLoader(source);
    assert.equal(patchResourceLoader(patched), patched);
    const checked = put(dir, 'patched.mjs', patched);
    const syntax = spawnSync(process.execPath, ['--check', checked], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    // Evaluate only context discovery, independent of the rest of the host.
    const helper = patched.slice(0, patched.indexOf('\n', patched.indexOf('function __agentsOnlyForbidden')));
    const loader = /function loadContextFileFromDir\(dir\)\{.*?return null\}/.exec(patched)?.[0]
      ?? patched.slice(patched.indexOf('function loadContextFileFromDir(dir) {'), patched.indexOf('\n/**', patched.indexOf('function loadContextFileFromDir(dir) {'))).trim();
    let reads = [];
    const executable = helper.replace(/import\{[^\n]+\n/, '').replace('__agentsOnlyRealpath(p)', 'fs.realpathSync(p)') + '\n' + loader.replace(/join\d*\(/g, 'path.join(').replace(/existsSync\d*\(/g, 'fs.existsSync(').replace(/statSync\d*\(/g, 'fs.statSync(').replace(/readFileSync\d*\(/g, 'read(') + '\nreturn loadContextFileFromDir(dir);';
    const context = path.join(dir, 'project');
    put(context, 'CLAUDE.md', 'FORBIDDEN'); put(context, 'CLAUDE.MD', 'FORBIDDEN');
    const run = () => new Function('dir', 'fs', 'path', 'stripBom', 'read', 'chalk', executable)(context, fs, path, s => s, (file, encoding) => { reads.push(file); return fs.readFileSync(file, encoding); }, { yellow: s => s });
    assert.equal(run(), null); assert.deepEqual(reads, []);
    put(context, 'AGENTS.md', 'AGENT_OK'); assert.equal(run().content, 'AGENT_OK');
    fs.unlinkSync(path.join(context, 'AGENTS.md'));
    fs.symlinkSync(path.join(context, 'CLAUDE.md'), path.join(context, 'AGENTS.md'));
    reads = []; assert.equal(run(), null); assert.deepEqual(reads, []);
    fs.rmSync(context, { recursive: true, force: true });
  }
}));
for (const alreadyPatched of [false, true]) test(`deployment fixture (${alreadyPatched ? 'prepatched' : 'as-installed'}): dry-run, backups, idempotence and unsupported version refusal`, () => fixture(dir => {
  const copy = path.join(dir, 'host'), agent = path.join(dir, 'agent'), backup = path.join(dir, 'backups');
  const actualSource = fs.readFileSync(path.join(host, 'dist/core/resource-loader.js'), 'utf8');
  const source = alreadyPatched ? patchResourceLoader(actualSource) : actualSource;
  put(copy, 'dist/core/resource-loader.js', source);
  const cliSource = 'import{statSync as statSync7}from"node:fs";function loadContextFileFromDir(dir){let candidates=["AGENTS.override.md","AGENTS.md","AGENTS.MD","CLAUDE.md","CLAUDE.MD"];for(let filename of candidates){let filePath=join15(dir,filename);if(existsSync13(filePath))try{if(!statSync7(filePath).isFile())continue;return {path:filePath}}catch{}}return null}';
  put(copy, 'dist/bundle/chunks/context.js', alreadyPatched ? patchResourceLoader(cliSource) : cliSource);
  put(agent, 'extensions/claude-rules.ts', '// Retired: .agents/rules is provided by repo:packages/pi-agents-context.');
  applyAgentsOnly(copy, agent, backup, true);
  assert.equal(fs.readFileSync(path.join(copy, 'dist/core/resource-loader.js'), 'utf8'), source);
  assert.equal(fs.existsSync(backup), false);

  applyAgentsOnly(copy, agent, backup);
  const sdkBackup = path.join(backup, 'pi-host/dist/core/resource-loader.js');
  const sdkChanged = patchResourceLoader(source) !== source;
  assert.equal(fs.existsSync(sdkBackup), sdkChanged);
  if (sdkChanged) assert.equal(fs.readFileSync(sdkBackup, 'utf8'), source);
  const cliBackup = path.join(backup, 'pi-host/dist/bundle/chunks/context.js');
  assert.equal(fs.existsSync(cliBackup), !alreadyPatched);
  if (!alreadyPatched) assert.equal(fs.readFileSync(cliBackup, 'utf8'), cliSource);
  assert.ok(fs.existsSync(path.join(backup, 'retired/claude-rules.ts')));
  assert.equal(fs.existsSync(path.join(agent, 'extensions/claude-rules.ts')), false);
  applyAgentsOnly(copy, agent, backup);
  assert.equal(fs.existsSync(sdkBackup), sdkChanged);
  if (sdkChanged) assert.equal(fs.readFileSync(sdkBackup, 'utf8'), source);
  assert.equal(fs.existsSync(cliBackup), !alreadyPatched);
  assert.throws(() => patchResourceLoader('new unsupported loader'), /Unsupported/);
  put(copy, 'dist/core/resource-loader.js', source);
  put(copy, 'dist/bundle/chunks/context.js', 'function loadContextFileFromDir(dir){throw new Error("UNSUPPORTED_VERSION")}');
  assert.throws(() => applyAgentsOnly(copy, agent, path.join(dir, 'bad-backup')), /Unsupported/);
  assert.equal(fs.readFileSync(path.join(copy, 'dist/core/resource-loader.js'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(dir, 'bad-backup')), false);
  put(agent, 'extensions/claude-rules.ts', 'CUSTOM_EXTENSION');
  assert.throws(() => retireLegacyExtension(agent, backup), /preserved/);
  assert.equal(fs.readFileSync(path.join(agent, 'extensions/claude-rules.ts'), 'utf8'), 'CUSTOM_EXTENSION');
}));
