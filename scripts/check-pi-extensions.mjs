#!/usr/bin/env node
// Complete configured extension composition, using Pi's own loader. Never installs packages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { readLaunchHook } from './maintenance-queue.mjs';

const HOST_PACKAGE = '@earendil-works/pi-coding-agent';
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
const isHost = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === HOST_PACKAGE; } catch { return false; }
};
function findHost(explicit) {
  if (explicit || process.env.PI_HOST_DIR) return explicit || process.env.PI_HOST_DIR;
  const bin = spawnSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).stdout?.trim();
  if (bin) { const hook = readLaunchHook(bin); if (hook) return hook.original.host; }
  if (bin) for (let dir = path.dirname(fs.realpathSync(bin)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (isHost(dir)) return dir;
  }
}
function flag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value: ${name}`);
  return args.splice(index, 2)[1];
}

async function worker(options) {
  // Not a security sandbox for hostile native code. Deny accidental factory networking/processes;
  // Node's permission model additionally restricts writes to the disposable directory.
  const blocked = () => { throw new Error('Extension preflight prohibits network and child processes'); };
  for (const [module, methods] of [
    ['node:net', ['connect', 'createConnection', 'createServer']],
    ['node:tls', ['connect', 'createServer']], ['node:dgram', ['createSocket']],
    ['node:http', ['request', 'get', 'createServer']], ['node:https', ['request', 'get', 'createServer']],
    ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ]) {
    const target = (await import(module)).default;
    for (const method of methods) target[method] = blocked;
  }
  globalThis.fetch = blocked;
  globalThis.WebSocket = class { constructor() { blocked(); } };
  syncBuiltinESMExports();
  const { repo, host, sourceAgent, sandbox, settingsFile, originalHome } = options;
  const agentDir = path.join(sandbox, 'agent'); const cwd = path.join(sandbox, 'work');
  const { SettingsManager } = await import(pathToFileURL(path.join(host, 'dist/core/settings-manager.js')));
  const { DefaultPackageManager } = await import(pathToFileURL(path.join(host, 'dist/core/package-manager.js')));
  const { DefaultResourceLoader } = await import(pathToFileURL(path.join(host, 'dist/core/resource-loader.js')));
  const desired = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const manager = new DefaultPackageManager({ cwd, agentDir: sourceAgent, settingsManager: SettingsManager.inMemory() });
  const packages = []; let missing = 0; let failed = 0;
  for (const entry of desired.packages ?? []) {
    const source = typeof entry === 'string' ? entry : entry.source;
    let installed;
    if (source.startsWith('repo:')) installed = path.resolve(repo, source.slice(5));
    else if (source.startsWith('npm:') || source.startsWith('git:') || /^https?:/.test(source)) {
      installed = manager.getInstalledPath(source, 'user');
    } else installed = path.resolve(sourceAgent, source.replace(/^~(?=\/)/, originalHome));
    if (!installed || !fs.existsSync(installed)) {
      console.log(`skip\t${source}\tnot installed; not fetched (composition incomplete)`); missing++; continue;
    }
    if (source.startsWith('npm:')) {
      if (typeof manager.parseSource !== 'function' || typeof manager.installedNpmMatchesConfiguredVersion !== 'function') {
        throw new Error('Unsupported Pi package-version validation API');
      }
      if (!await manager.installedNpmMatchesConfiguredVersion(manager.parseSource(source), installed)) {
        console.log(`skip\t${source}\tinstalled version does not satisfy configured source; not updated`); missing++; continue;
      }
    }
    const manifest = path.join(installed, 'package.json');
    if (fs.existsSync(manifest) && (typeof entry === 'string' || entry.extensions === undefined)) {
      const declared = JSON.parse(fs.readFileSync(manifest, 'utf8')).pi?.extensions ?? [];
      for (const resource of declared) {
        if (!/[*!?{}]/.test(resource) && !fs.existsSync(path.resolve(installed, resource))) {
          console.log(`fail\t${source}\tmissing declared entry: ${resource}`); failed++;
        }
      }
    }
    packages.push(typeof entry === 'string' ? installed : { ...entry, source: installed });
    console.log(`ok\t${source}\tresolved read-only${typeof entry === 'object' ? ' (filters preserved)' : ''}`);
  }
  const { planExtensionTree } = await import('./managed-deploy.mjs');
  for (const [relative, bytes] of planExtensionTree(repo, sourceAgent)) {
    const target = path.join(agentDir, 'extensions', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  // Only desired repository config; never copy live user config, auth, sessions, or project data.
  for (const name of ['pi-cc-extensions.json', 'openai-codex-compat.json']) {
    const source = path.join(repo, 'pi', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(agentDir, name));
  }
  // setup shallow-merges settings: a local extensions list survives when absent from desired.
  const liveSettings = path.join(sourceAgent, 'settings.json');
  const retainedExtensions = desired.extensions === undefined && fs.existsSync(liveSettings)
    ? JSON.parse(fs.readFileSync(liveSettings, 'utf8')).extensions ?? [] : [];
  const extensions = (desired.extensions ?? retainedExtensions).map((entry) => {
    const prefix = /^[!+-]/.test(entry) ? entry[0] : '';
    const source = entry.slice(prefix.length);
    return prefix + (source.startsWith('repo:') ? path.resolve(repo, source.slice(5)) : path.resolve(sourceAgent, source));
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir,
    settingsManager: SettingsManager.inMemory({ packages, extensions }),
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  let result;
  try {
    await loader.reload(); result = loader.getExtensions();
    for (const error of result.errors) { console.log(`fail\t${error.path}\t${oneLine(error.error)}`); failed++; }
    for (const extension of result.extensions) {
      console.log(`ok\t${extension.path}\tloaded tools=${extension.tools.size} commands=${extension.commands.size} handlers=${extension.handlers.size}`);
    }
    // Native Pi namespaces duplicate commands (e.g. /context:1 and /context:2).
    // Report ambiguity but don't mistake that supported behavior for a failed load.
    const owners = new Map();
    for (const extension of result.extensions) for (const name of extension.commands.keys()) {
      if (owners.has(name)) console.log(`warn\t${extension.path}\tcommand /${name} namespaced by Pi; also registered by ${owners.get(name)}`);
      else owners.set(name, extension.path);
    }
  } catch (error) { console.log(`fail\tcomposition\t${oneLine(error.stack ?? error)}`); failed++; }
  finally {
    // Use the real runner's non-UI context and native in-memory SessionManager for cleanup.
    // No session_start/model/tool is run, and there are no real session entries.
    if (result) {
      const { ExtensionRunner } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/runner.js')));
      const { SessionManager } = await import(pathToFileURL(path.join(host, 'dist/core/session-manager.js')));
      const sm = SessionManager.inMemory(cwd);
      const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, sm, {});
      const noop = () => {};
      runner.onError((error) => { console.log(`fail\t${error.extensionPath}\tshutdown: ${oneLine(error.error)}`); failed++; });
      runner.bindCore({ sendMessage: blocked, sendUserMessage: blocked, appendEntry: (type, data) => sm.appendCustomEntry(type, data),
        setSessionName: noop, getSessionName: () => undefined, setLabel: noop,
        getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop,
        refreshTools: noop, getCommands: () => runner.getRegisteredCommands(), setModel: blocked,
        getThinkingLevel: () => 'off', setThinkingLevel: noop,
      }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
        isProjectTrusted: () => false, getSignal: () => new AbortController().signal, abort: noop,
        hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined,
        compact: blocked, getSystemPrompt: () => '', executeTool: blocked,
      });
      await runner.emit({ type: 'session_shutdown', reason: 'exit' });
      runner.invalidate('preflight complete');
    }
  }
  console.log(`summary\tconfigured=${desired.packages?.length ?? 0} loaded=${result?.extensions.length ?? 0} missing=${missing} failed=${failed}`);
  return failed ? 1 : missing ? 2 : 0;
}

if (process.argv[2] === '--worker') {
  try { process.exit(await worker(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')))); }
  catch (error) { console.error(`fail\tpreflight\t${oneLine(error.stack ?? error)}`); process.exit(1); }
} else {
  const args = process.argv.slice(2);
  const hostArg = flag(args, '--host');
  const sourceAgent = path.resolve(flag(args, '--agent-dir', process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent')));
  const settingsArg = flag(args, '--settings'); const repo = args[0] && path.resolve(args[0]);
  if (!repo || args.length !== 1) throw new Error('usage: check-pi-extensions.mjs <repo-root> [--host <dir>] [--agent-dir <dir>] [--settings <file>]');
  const host = findHost(hostArg);
  if (!host || !isHost(host)) { console.error('skip\textension check\tPi npm host not found'); process.exit(3); }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ext-check-'));
  try {
    for (const name of ['agent', 'work', 'home', 'tmp', 'config', 'cache', 'bin']) fs.mkdirSync(path.join(sandbox, name));
    // Create resolution links before enabling permissions: fs.symlink requires unrestricted
    // writes even when the link itself is inside the sandbox. The worker cannot create more.
    const npmModules = path.join(sourceAgent, 'npm/node_modules');
    if (fs.existsSync(npmModules)) {
      fs.mkdirSync(path.join(sandbox, 'agent/npm'));
      fs.symlinkSync(npmModules, path.join(sandbox, 'agent/npm/node_modules'));
    }
    const optionsFile = path.join(sandbox, 'options.json');
    fs.writeFileSync(optionsFile, JSON.stringify({ repo, host, sourceAgent, sandbox, originalHome: os.homedir(), settingsFile: path.resolve(settingsArg ?? path.join(repo, 'pi/settings.json')) }));
    // Credentials and Herdr identity are intentionally not inherited.
    const env = { PATH: path.join(sandbox, 'bin'), HOME: path.join(sandbox, 'home'),
      TMPDIR: path.join(sandbox, 'tmp'), XDG_CONFIG_HOME: path.join(sandbox, 'config'), XDG_CACHE_HOME: path.join(sandbox, 'cache'),
      PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'), PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1',
      JITI_FS_CACHE: 'false', NO_COLOR: '1', LANG: process.env.LANG ?? 'en_US.UTF-8' };
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', `--allow-fs-write=${sandbox}`,
      '--allow-addons', fileURLToPath(import.meta.url), '--worker', optionsFile], { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
    if (child.error) console.error(`fail\tpreflight\t${oneLine(child.error)}`);
    process.exitCode = child.status ?? 1;
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
