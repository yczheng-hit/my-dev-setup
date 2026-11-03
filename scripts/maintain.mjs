#!/usr/bin/env node
// AI/bootstrap entry: remote latest, repository-owned hacks unchanged, original Pi installer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, hostUpdateCommand, inventory, resolveLatest, resolvedSettings, readJson, executable, PI_PACKAGE } from './maintenance-policy.mjs';
import { planAgentsOnly } from './agents-only.mjs';
import { buildPlan, planExtensionTree } from './managed-deploy.mjs';
import { queuePrepared, readQueued, queueRoot, repositoryDigest, restoreLaunchHook, installLaunchHook } from './maintenance-queue.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
function run(command, args, options = {}) {
  console.log(`run\t${command}\t${args.join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Command failed (${result.status ?? result.error?.code}): ${command}`);
  return result.stdout?.trim();
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function stateRoot(agentDir) { return path.join(agentDir, 'state/my-dev-setup'); }
export function parseArgs(args) {
  const command = args.shift() ?? 'check';
  if (!['check', 'update', 'bootstrap', 'status', 'activate'].includes(command)) throw new Error('usage: maintain.mjs check|update|bootstrap|status|activate [--repo DIR] [--agent-dir DIR] [--apply]');
  const options = { command, repo: ROOT, agentDir: path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent')) };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--apply') options.apply = true;
    else if (['--repo', '--agent-dir'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag === '--repo' ? 'repo' : 'agentDir'] = path.resolve(args.shift());
    else throw new Error(`Unknown/missing option: ${flag}`);
  }
  if (options.apply && command !== 'bootstrap') throw new Error('--apply requires bootstrap');
  options.repo = fs.realpathSync(options.repo);
  return options;
}
export function classifyDrift(repo, lock) {
  const data = inventory(repo);
  return data.entries.map(entry => ({ source: entry.source, kind: entry.kind, target: entry.kind.startsWith('remote-')
    ? lock.remotes.find(item => item.source === entry.source)?.resolved : `${entry.policy} (no upstream merge)` }));
}
function checkPrerequisites() {
  for (const name of ['git', 'npm']) if (!executable(name)) throw new Error(`Install ${name} before bootstrap`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error('Node >=22.19 is required; Node itself is not automatically replaced');
}
function candidateSettings(repo, lock, stage, liveAgent) {
  const settings = resolvedSettings(repo, lock);
  const live = path.join(liveAgent, 'settings.json');
  // Only the extension resource list is read; never copy live auth/models/session configuration.
  if (settings.extensions === undefined && fs.existsSync(live)) settings.extensions = readJson(live).extensions;
  if (settings.extensions) settings.extensions = settings.extensions.map(item => {
    const prefix = /^[!+-]/.test(item) ? item[0] : '', source = item.slice(prefix.length);
    return prefix + (source.startsWith('repo:') ? path.resolve(repo, source.slice(5)) : path.resolve(liveAgent, source));
  });
  atomic(path.join(stage, 'settings.json'), json(settings));
  for (const [relative, bytes] of planExtensionTree(repo, liveAgent)) {
    const target = path.join(stage, 'extensions', relative);
    if (relative.endsWith('.json') && path.basename(relative) !== 'package.json') continue;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  return settings;
}
export function ensureRepositoryTools(repo, command = run) {
  const policy = inventory(repo).policy;
  for (const line of fs.readFileSync(path.join(repo, 'tools.tsv'), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [name, url, branch] = line.split('\t'), rule = policy.toolCheckouts?.[name];
    if (!/^[a-z0-9-]+$/.test(name) || !/^https:\/\/github\.com\/yczheng-hit\//.test(url) || !branch
      || rule?.policy !== 'repository-only' || !/^[a-f0-9]{40}$/.test(rule.commit)) throw new Error('Invalid owner tool declaration/pin');
    const target = path.join(repo, 'tools', name);
    if (fs.existsSync(path.join(target, '.git'))) {
      const head = command('git', ['-C', target, 'rev-parse', 'HEAD']);
      if (head !== rule.commit) throw new Error(`${name}: checkout differs from repository pin; preserve local work and reconcile explicitly (no automatic merge/reset).`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    command('git', ['clone', '--quiet', '--no-checkout', url, target]);
    command('git', ['-C', target, 'checkout', '--quiet', '--detach', rule.commit]);
  }
}
// Match setup's targeted native recovery before testing the candidate loader.
export function ensureNativeDependencies(repo, dir, runtimeNode, { command = run, probe = spawnSync } = {}) {
  const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}` };
  const script = path.join(repo, 'scripts/native-deps.mjs');
  const result = probe(runtimeNode, [script, dir], { env, encoding: 'utf8', timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0 && !result.error) return;
  const failures = (result.stdout ?? '').trim().split('\n').filter(line => line.startsWith('fail\t')).map(line => line.split('\t'));
  const deps = Object.keys(readJson(path.join(dir, 'package.json')).dependencies ?? {});
  if (result.error || !failures.length || failures.some(([, dep, kind]) => !deps.includes(dep) || !['libstdcxx', 'node-abi', 'no-binary'].includes(kind)
    || !fs.existsSync(path.join(dir, 'node_modules', dep, 'binding.gyp')))) throw new Error(`Native dependency check failed: ${dir}; no unsafe broad rebuild was attempted.`);
  for (const [, dep] of failures) command(runtimeNode, [path.join(repo, 'scripts/rebuild-native.mjs'), dir, dep], { env, timeout: 960000 });
  command(runtimeNode, [script, dir], { env });
}
function ensureLocalDependencies(repo, runtimeNode) {
  const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}` };
  for (const parent of ['packages', 'tools']) for (const entry of fs.readdirSync(path.join(repo, parent), { withFileTypes: true })) {
    const dir = path.join(repo, parent, entry.name), manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const deps = Object.keys(readJson(manifest).dependencies ?? {});
    if (deps.some(dep => !fs.existsSync(path.join(dir, 'node_modules', dep)))) {
      run(executable('npm', env), ['install', '--prefix', dir, '--omit=dev', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { env });
    }
    ensureNativeDependencies(repo, dir, runtimeNode);
  }
}
async function prepare(repo, agentDir, lock, installation) {
  checkPrerequisites();
  ensureRepositoryTools(repo);
  const runtimeNode = installation.node ?? process.execPath;
  ensureLocalDependencies(repo, runtimeNode);
  const sourceHash = repositoryDigest(repo);
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-maintain-')));
  try {
    const stageAgent = path.join(stage, 'agent'), hostRoot = path.join(stage, 'host');
    fs.mkdirSync(stageAgent); fs.mkdirSync(hostRoot);
    // Candidate host and remotes are resolved independently of the active Pi process.
    const home = path.join(stage, 'home'); fs.mkdirSync(home);
    const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: home, npm_config_userconfig: path.join(home, '.npmrc'), npm_config_cache: path.join(stage, 'npm-cache'),
      npm_config_engine_strict: 'true', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
    for (const key of Object.keys(env)) if (/^(?:PI_|PICC_|HERDR_|ANTHROPIC_|OPENAI_|CLAUDE_|BTW_)/.test(key)) delete env[key];
    env.JITI_FS_CACHE = 'false';
    const npm = executable('npm', env);
    run(npm, ['install', '--prefix', hostRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', `${PI_PACKAGE}@${lock.host.version}`], { env });
    const host = path.join(hostRoot, 'node_modules', PI_PACKAGE);
    if (readJson(path.join(host, 'package.json')).version !== lock.host.version) throw new Error('Candidate Pi version mismatch');
    const hostResolution = readJson(path.join(hostRoot, 'package-lock.json')).packages[`node_modules/${PI_PACKAGE}`];
    if (hostResolution.integrity !== lock.host.integrity) throw new Error('Candidate Pi integrity mismatch');
    for (const item of planAgentsOnly(host, stageAgent)) if (item.after !== null) {
      fs.writeFileSync(item.file, item.after); run(runtimeNode, ['--check', item.file]);
    }
    // Install exact remote versions. Local/hacked packages never enter an installer input.
    const npmDir = path.join(stageAgent, 'npm'); fs.mkdirSync(npmDir);
    const specs = lock.remotes.filter(item => item.kind === 'remote-npm').map(item => `${item.name}@${item.version}`);
    if (specs.length) run(npm, ['install', '--prefix', npmDir, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', ...specs], { env });
    for (const item of lock.remotes.filter(item => item.kind === 'remote-npm')) {
      const installed = readJson(path.join(npmDir, 'node_modules', item.name, 'package.json'));
      const resolved = readJson(path.join(npmDir, 'package-lock.json')).packages[`node_modules/${item.name}`];
      if (installed.version !== item.version || resolved.integrity !== item.integrity) throw new Error(`Candidate integrity/version mismatch: ${item.name}`);
    }
    for (const item of lock.remotes.filter(item => item.kind === 'remote-git')) {
      const target = path.join(stageAgent, 'git', item.identity);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      run('git', ['clone', '--quiet', '--no-checkout', item.url, target], { env });
      run('git', ['-C', target, 'checkout', '--quiet', '--detach', item.commit], { env });
      if (fs.existsSync(path.join(target, 'package.json'))) run(npm, ['install', '--prefix', target, '--omit=dev', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { env });
    }
    candidateSettings(repo, lock, stageAgent, agentDir);
    run(runtimeNode, [path.join(repo, 'scripts/check-pi-extensions.mjs'), repo, '--host', host, '--agent-dir', stageAgent, '--settings', path.join(stageAgent, 'settings.json')], { env });
    // Reuse bounded synthetic SDK regression tests against the candidate host. No provider calls.
    const tests = ['scripts/test/herdr-prompts.test.mjs', 'scripts/test/scheduler-delivery.test.mjs',
      'scripts/test/ux-composition.test.mjs', 'packages/pi-agents-context/test/context.test.mjs',
      'packages/pi-unread-navigation/test/extension.test.mjs'].map(file => path.join(repo, file));
    for (const file of tests) if (!fs.existsSync(file)) throw new Error(`Required candidate regression is missing: ${file}`);
    run(runtimeNode, ['--test', ...tests], { env: { ...env, PI_HOST_DIR: host } });
    return { stage, stageAgent, host, installation, sourceHash };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function assertNoRunningPi({ output, currentPid = process.pid } = {}) {
  if (output === undefined) {
    const ps = spawnSync('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 10000 });
    if (ps.status !== 0) throw new Error('Cannot establish whether Pi is running; activation postponed without changing the current runtime.');
    output = ps.stdout;
  }
  const running = output.split('\n').filter(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[1]) === currentPid || Number(match[1]) === process.ppid && Number(process.env.PI_MAINTENANCE_LAUNCH_PID) === process.ppid) return false;
    return /maintenance-launch\.mjs(?:\s|$)/.test(match[3]) || path.basename(match[2]) === 'pi' || /(?:pi-coding-agent\/(?:dist|bin)\/|(?:^|\s|\/)pi(?:\s|$))/.test(match[3]);
  });
  if (running.length) throw Object.assign(new Error('Pi processes are running; candidate remains queued until the next safe start. No process was stopped.'), { code: 'PI_RUNNING', pids: running.map(line => Number(line.trim().split(/\s+/)[0])) });
}
export function assertPlainPath(target) {
  for (let dir = path.resolve(target);; dir = path.dirname(dir)) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink activation destination/ancestor: ${dir}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(dir) === dir) break;
  }
}
function backupNpm(agentDir, backup) {
  const source = path.join(agentDir, 'npm');
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(backup, 'npm'), { recursive: true, dereference: false });
}
export function runningPi(options) {
  try { assertNoRunningPi(options); return false; }
  catch (error) { if (error.code !== 'PI_RUNNING') throw error; return true; }
}
export function applyPrepared(options, lock, prepared, { command = run, detect = inspectInstallation, stopped = assertNoRunningPi, hasHerdr = () => Boolean(executable('herdr')) } = {}) {
  const { repo, agentDir } = options;
  stopped();
  const installation = detect();
  if (installation.kind === 'blocked') throw new Error(installation.reason);
  if (installation.kind === 'brew' && !installation.host) throw new Error('Homebrew Pi has no discoverable SDK; cannot validate/apply host patch. Original install left unchanged.');
  if (!hasHerdr()) throw new Error('Install Herdr before configuring this machine; Pi has not been changed.');
  assertPlainPath(agentDir);
  for (const target of [path.join(agentDir, 'npm'), path.join(agentDir, 'state/my-dev-setup'), ...lock.remotes.filter(item => item.kind === 'remote-git').map(item => path.join(agentDir, 'git', item.identity))]) assertPlainPath(target);
  // An early read-only dirty check avoids even acquiring a transaction for custom work.
  for (const item of lock.remotes.filter(item => item.kind === 'remote-git')) {
    const target = path.join(agentDir, 'git', item.identity);
    if (fs.existsSync(target) && command('git', ['-C', target, 'status', '--porcelain'])) throw new Error(`Dirty git package preserved before any install: ${target}`);
  }
  fs.mkdirSync(stateRoot(agentDir), { recursive: true, mode: 0o700 });
  const guard = path.join(stateRoot(agentDir), 'maintenance.lock');
  const descriptor = fs.openSync(guard, 'wx', 0o600);
  const backup = path.join(stateRoot(agentDir), `backup-${Date.now()}-${randomUUID()}`);
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`); fs.mkdirSync(backup, { mode: 0o700 });
    stopped();
    for (const item of lock.remotes.filter(item => item.kind === 'remote-git')) {
      const target = path.join(agentDir, 'git', item.identity);
      if (!fs.existsSync(target)) continue;
      if (command('git', ['-C', target, 'status', '--porcelain'])) throw new Error(`Git package changed before installation: ${target}`);
      command('git', ['-C', target, 'fetch', 'origin']);
      command('git', ['-C', target, 'merge-base', '--is-ancestor', 'HEAD', item.commit]);
    }
    backupNpm(agentDir, backup);
    const hashlineDir = process.env.PI_HASHLINE_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pi-hashline-edit-pro');
    assertPlainPath(hashlineDir);
    if (fs.existsSync(hashlineDir)) fs.cpSync(hashlineDir, path.join(backup, 'hashline'), { recursive: true, dereference: false });
    if (installation.host) fs.cpSync(installation.host, path.join(backup, 'pi-before-update'), { recursive: true, dereference: false });
    atomic(path.join(backup, 'receipt.json'), json({ installation, target: lock, status: 'prepared' }));
    const hook = installation.hook;
    if (hook) restoreLaunchHook(installation.bin);
    if (installation.version !== lock.host.version) {
      const [binary, args] = hostUpdateCommand(installation, lock.host.version);
      const env = { ...process.env, PATH: `${path.dirname(installation.node ?? installation.manager ?? installation.bin)}${path.delimiter}${process.env.PATH ?? ''}`,
        ...(installation.kind === 'managed' ? { PI_MANAGED_INSTALL_ROOT: installation.root } : {}) };
      command(binary, args, { env });
    }
    const actual = detect();
    if (actual.kind !== installation.kind || ['prefix', 'root', 'manager', 'node'].some(key => installation[key] && actual[key] !== installation[key])) throw new Error('Pi installation channel/prefix changed during upgrade; refusing configuration.');
    if (actual.kind === 'blocked' || !actual.host || actual.version !== lock.host.version) throw new Error('Installed Pi does not match validated target (or no SDK available). See backup receipt.');
    const version = command(actual.bin, ['--version']);
    if (version !== lock.host.version) throw new Error(`pi --version returned ${version}, expected ${lock.host.version}`);
    const runtimeNode = actual.node ?? process.execPath;
    const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir, PI_HOST_DIR: actual.host };
    const npmTarget = path.join(agentDir, 'npm');
    const specs = lock.remotes.filter(item => item.kind === 'remote-npm').map(item => `${item.name}@${item.version}`);
    if (specs.length) command(executable('npm', env), ['install', '--prefix', npmTarget, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', ...specs], { env });
    if (specs.length) for (const item of lock.remotes.filter(item => item.kind === 'remote-npm')) {
      const installed = readJson(path.join(npmTarget, 'node_modules', item.name, 'package.json'));
      const resolution = readJson(path.join(npmTarget, 'package-lock.json')).packages[`node_modules/${item.name}`];
      if (installed.version !== item.version || resolution?.integrity !== item.integrity) throw new Error(`Installed package integrity/version differs: ${item.name}`);
    }
    for (const item of lock.remotes.filter(item => item.kind === 'remote-git')) {
      const target = path.join(agentDir, 'git', item.identity);
      if (fs.existsSync(target)) {
        if (command('git', ['-C', target, 'status', '--porcelain'])) throw new Error(`Git package changed during update: ${target}`);
        command('git', ['-C', target, 'merge', '--ff-only', item.commit]);
        if (fs.existsSync(path.join(target, 'package.json'))) command(executable('npm', env), ['install', '--prefix', target, '--omit=dev', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { env });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(prepared.stageAgent, 'git', item.identity), target, { recursive: true });
      }
    }
    const settingsFile = path.join(prepared.stage, 'resolved-settings.json');
    atomic(settingsFile, json(resolvedSettings(repo, lock)));
    command('/bin/bash', [path.join(repo, 'setup.sh'), '--skip-tool-updates'], { env: { ...env, MY_DEV_SETUP_SETTINGS: settingsFile } });
    command(runtimeNode, [path.join(repo, 'scripts/check-pi-extensions.mjs'), repo, '--host', actual.host, '--agent-dir', agentDir, '--settings', settingsFile], { env });
    if (hook) installLaunchHook(repo, agentDir, actual);
    atomic(path.join(backup, 'receipt.json'), json({ installation, target: lock, status: 'applied' }));
    atomic(path.join(stateRoot(agentDir), 'status.json'), json({ status: 'applied', host: lock.host.version, backup, restartRequired: !options.startup }));
    console.log(`applied\tPi ${lock.host.version}; ${options.startup ? 'starting the new runtime' : 'new runtime on next Pi start'}. Backup: ${backup}`);
  } catch (error) {
    atomic(path.join(backup, 'failure.json'), json({ status: 'failed', error: error.message }));
    // A manager can replace the wrapper before failing. Restore the safety gate for future starts.
    if (installation.hook) {
      try { const remaining = detect(); if (remaining.kind !== 'blocked' && remaining.host) installLaunchHook(repo, agentDir, remaining); }
      catch (hookError) { console.error(`Startup safety hook needs repair: ${hookError.message}`); }
    }
    atomic(path.join(stateRoot(agentDir), 'status.json'), json({ status: 'failed', targetHost: lock.host.version, backup, error: error.message, restartRequired: true }));
    throw new Error(`${error.message}\nPartial installation may exist; configuration has its own transaction backup. Package/host backup: ${backup}`);
  } finally { fs.closeSync(descriptor); fs.unlinkSync(guard); }
}
export function activateQueued(options, { stopped = assertNoRunningPi, detect = inspectInstallation, command = run, apply = applyPrepared } = {}) {
  const pendingFile = path.join(queueRoot(options.agentDir), 'pending.json');
  if (!fs.existsSync(pendingFile)) return;
  try { stopped(); } catch (error) {
    if (error.code !== 'PI_RUNNING') throw error;
    console.log('queued\tOther Pi processes are still running; keep using the installed version.'); return;
  }
  let artifact, current, prepared;
  try {
    artifact = readQueued(options.agentDir);
    if (artifact.repo !== options.repo) throw new Error('Pending candidate belongs to another repository.');
    current = detect(); const previous = artifact.installation;
    if (['kind', 'prefix', 'root', 'manager', 'node', 'version'].some(key => previous[key] && previous[key] !== current[key])) throw new Error('Pi owner/version changed after preparation; ask the agent to prepare again.');
    prepared = { stage: artifact.stage, stageAgent: path.join(artifact.stage, 'agent'), host: path.join(artifact.stage, 'host/node_modules', PI_PACKAGE) };
    command(current.node ?? process.execPath, [path.join(options.repo, 'scripts/check-pi-extensions.mjs'), options.repo, '--host', prepared.host,
      '--agent-dir', prepared.stageAgent, '--settings', path.join(prepared.stageAgent, 'settings.json')]);
  } catch (error) {
    console.error(`queued\tActivation postponed before installation: ${error.message}`); return;
  }
  // Activation must use the exact recorded direct versions, not a fresh latest lookup.
  try { apply({ ...options, startup: true }, artifact.lock, prepared); }
  catch (error) {
    const statusFile = path.join(queueRoot(options.agentDir), 'status.json');
    if (fs.existsSync(statusFile) && readJson(statusFile).status === 'failed') throw error;
    console.error(`queued\tInstallation did not start: ${error.message}`); return;
  }
  // Do not consume a newer candidate published by a concurrent agent.
  if (readJson(pendingFile).stage === artifact.stage) fs.unlinkSync(pendingFile);
}
export function installationNeedsUpdate(repo, agentDir, lock, installation) {
  if (installation.version !== lock.host.version) return true;
  for (const item of lock.remotes) {
    if (item.kind === 'remote-npm') {
      try { if (readJson(path.join(agentDir, 'npm/node_modules', item.name, 'package.json')).version !== item.version) return true; } catch { return true; }
    } else {
      const result = spawnSync('git', ['-C', path.join(agentDir, 'git', item.identity), 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0 || result.stdout.trim() !== item.commit) return true;
    }
  }
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-maintenance-drift-')));
  try {
    const settingsFile = path.join(stage, 'settings.json'); atomic(settingsFile, json(resolvedSettings(repo, lock)));
    return buildPlan({ repo, agentDir, host: installation.host, settingsFile,
      hashlineDir: process.env.PI_HASHLINE_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pi-hashline-edit-pro') }).changes.length > 0;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
export async function main(options) {
  if (options.command === 'status') {
    const file = path.join(stateRoot(options.agentDir), 'status.json');
    console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'No maintenance has been applied on this machine.'); return;
  }
  if (options.command === 'activate') return activateQueued(options);
  const installation = inspectInstallation();
  console.log(`host\t${installation.kind}\t${installation.version ?? 'not installed'}${installation.reason ? ` · ${installation.reason}` : ''}`);
  const lock = await resolveLatest(options.repo);
  for (const item of classifyDrift(options.repo, lock)) console.log(`${item.kind}\t${item.source}\t${item.target}`);
  console.log(`target\tPi ${lock.host.version}`);
  if (options.command === 'check') return;
  if (installation.kind === 'blocked') throw new Error(installation.reason);
  const needsUpdate = options.apply ? installationNeedsUpdate(options.repo, options.agentDir, lock, installation) : true;
  const prepared = await prepare(options.repo, options.agentDir, lock, installation);
  try {
    if (repositoryDigest(options.repo) !== prepared.sourceHash) throw new Error('Repository changed during validation; prepare again before queuing/installing.');
    const artifact = { ...lock, validation: { level: 'factory-host-patch-and-synthetic-sdk', nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch } };
    atomic(path.join(options.repo, 'maintenance.lock.json'), json(artifact));
    console.log('validated\tmaintenance.lock.json updated; repository-only packages were not merged or replaced.');
    if (options.command === 'bootstrap' && options.apply) {
      if (!needsUpdate) {
        installLaunchHook(options.repo, options.agentDir, inspectInstallation());
        console.log('current\tLatest installed composition validated; automatic startup hook ready. Current Pi continues unchanged.'); return;
      }
      if (runningPi()) {
        queuePrepared(options, lock, prepared, inspectInstallation());
        console.log(`queued\tPi ${lock.host.version} and plugins validated. Current Pi continues unchanged; automatic activation on the next safe start.`);
      } else applyPrepared(options, lock, prepared);
    } else console.log('prepared\tNo active installation/configuration changed. Ask the Pi agent to update to queue automatic activation.');
  } finally { fs.rmSync(prepared.stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`blocked\t${error.message}`); process.exitCode = 1; }
}
