#!/usr/bin/env node
// Direct maintenance: validate in a temporary directory, then update the original installation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, legacyLauncher, hostUpdateCommand, inventory, resolveLatest, resolvedSettings, readJson, executable, PI_PACKAGE } from './maintenance-policy.mjs';
import { planAgentsOnly } from './agents-only.mjs';
import { planExtensionTree } from './managed-deploy.mjs';
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
  if (!['check', 'update', 'bootstrap', 'status'].includes(command)) throw new Error('usage: maintain.mjs check|update|bootstrap|status [--repo DIR] [--agent-dir DIR] [--apply]');
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
export function classifyDrift(repo, target) {
  const data = inventory(repo);
  return data.entries.map(entry => ({ source: entry.source, kind: entry.kind, target: entry.kind.startsWith('remote-')
    ? target.remotes.find(item => item.source === entry.source)?.resolved : `${entry.policy} (no upstream merge)` }));
}
function checkPrerequisites() {
  for (const name of ['git', 'npm']) if (!executable(name)) throw new Error(`Install ${name} before bootstrap`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error('Node >=22.19 is required; Node itself is not automatically replaced');
}
function candidateSettings(repo, target, stage, liveAgent) {
  const settings = resolvedSettings(repo, target);
  const live = path.join(liveAgent, 'settings.json');
  // Only resource paths are inherited; never copy live auth/models/session configuration.
  if (settings.extensions === undefined && fs.existsSync(live)) settings.extensions = readJson(live).extensions;
  if (settings.extensions) settings.extensions = settings.extensions.map(item => {
    const prefix = /^[!+-]/.test(item) ? item[0] : '', source = item.slice(prefix.length);
    return prefix + (source.startsWith('repo:') ? path.resolve(repo, source.slice(5)) : path.resolve(liveAgent, source));
  });
  atomic(path.join(stage, 'settings.json'), json(settings));
  for (const [relative, bytes] of planExtensionTree(repo, liveAgent)) {
    const file = path.join(stage, 'extensions', relative);
    if (relative.endsWith('.json') && path.basename(relative) !== 'package.json') continue;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
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
async function prepare(repo, agentDir, target, installation) {
  checkPrerequisites(); ensureRepositoryTools(repo);
  const runtimeNode = installation.node ?? process.execPath;
  ensureLocalDependencies(repo, runtimeNode);
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-maintain-')));
  try {
    const stageAgent = path.join(stage, 'agent'), hostRoot = path.join(stage, 'host');
    fs.mkdirSync(stageAgent); fs.mkdirSync(hostRoot);
    const home = path.join(stage, 'home'); fs.mkdirSync(home);
    const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: home, npm_config_userconfig: path.join(home, '.npmrc'), npm_config_cache: path.join(stage, 'npm-cache'),
      npm_config_engine_strict: 'true', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
    for (const key of Object.keys(env)) if (/^(?:PI_|PICC_|HERDR_|ANTHROPIC_|OPENAI_|CLAUDE_|BTW_)/.test(key)) delete env[key];
    env.JITI_FS_CACHE = 'false';
    const npm = executable('npm', env);
    run(npm, ['install', '--prefix', hostRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', `${PI_PACKAGE}@${target.host.version}`], { env });
    const host = path.join(hostRoot, 'node_modules', PI_PACKAGE);
    if (readJson(path.join(host, 'package.json')).version !== target.host.version) throw new Error('Candidate Pi version mismatch');
    const hostResolution = readJson(path.join(hostRoot, 'package-lock.json')).packages[`node_modules/${PI_PACKAGE}`];
    if (hostResolution.integrity !== target.host.integrity) throw new Error('Candidate Pi integrity mismatch');
    for (const item of planAgentsOnly(host, stageAgent)) if (item.after !== null) {
      fs.writeFileSync(item.file, item.after); run(runtimeNode, ['--check', item.file]);
    }
    const npmDir = path.join(stageAgent, 'npm'); fs.mkdirSync(npmDir);
    const specs = target.remotes.filter(item => item.kind === 'remote-npm').map(item => `${item.name}@${item.version}`);
    if (specs.length) run(npm, ['install', '--prefix', npmDir, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', ...specs], { env });
    for (const item of target.remotes.filter(item => item.kind === 'remote-npm')) {
      const installed = readJson(path.join(npmDir, 'node_modules', item.name, 'package.json'));
      const resolved = readJson(path.join(npmDir, 'package-lock.json')).packages[`node_modules/${item.name}`];
      if (installed.version !== item.version || resolved.integrity !== item.integrity) throw new Error(`Candidate integrity/version mismatch: ${item.name}`);
    }
    for (const item of target.remotes.filter(item => item.kind === 'remote-git')) {
      const dir = path.join(stageAgent, 'git', item.identity);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      run('git', ['clone', '--quiet', '--no-checkout', item.url, dir], { env });
      run('git', ['-C', dir, 'checkout', '--quiet', '--detach', item.commit], { env });
      if (fs.existsSync(path.join(dir, 'package.json'))) run(npm, ['install', '--prefix', dir, '--omit=dev', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { env });
    }
    candidateSettings(repo, target, stageAgent, agentDir);
    run(runtimeNode, [path.join(repo, 'scripts/check-pi-extensions.mjs'), repo, '--host', host, '--agent-dir', stageAgent, '--settings', path.join(stageAgent, 'settings.json')], { env });
    const tests = ['scripts/test/herdr-prompts.test.mjs', 'scripts/test/scheduler-delivery.test.mjs',
      'scripts/test/ux-composition.test.mjs', 'packages/pi-agents-context/test/context.test.mjs',
      'packages/pi-unread-navigation/test/extension.test.mjs'].map(file => path.join(repo, file));
    for (const file of tests) if (!fs.existsSync(file)) throw new Error(`Required candidate regression is missing: ${file}`);
    run(runtimeNode, ['--test', ...tests], { env: { ...env, PI_HOST_DIR: host } });
    return { stage, stageAgent, host };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function assertPlainPath(target) {
  for (let dir = path.resolve(target);; dir = path.dirname(dir)) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink installation destination/ancestor: ${dir}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(dir) === dir) break;
  }
}
// One-time removal of the retired deferred updater; never installs a new launcher.
export function removeLegacyMaintenance(repo, agentDir, bin = executable('pi')) {
  const root = stateRoot(agentDir), hook = legacyLauncher(bin);
  if (hook && (hook.repo !== repo || hook.agentDir !== agentDir)) throw new Error('Legacy Pi launcher belongs to another checkout; preserve it.');
  if (hook) bin = hook.bin;
  const metadata = bin && `${bin}.my-dev-setup.json`;
  if (hook && !hook.link && createHash('sha256').update(fs.readFileSync(hook.savedFile)).digest('hex') !== hook.originalHash) throw new Error('Original Pi launcher backup changed.');
  const status = path.join(root, 'status.json');
  const retired = ['pending.json', 'candidates', 'startup.lock', 'queue.lock', 'maintenance.lock'].filter(name => fs.existsSync(path.join(root, name)));
  if (fs.existsSync(status) && readJson(status).status === 'queued') retired.push('status.json');
  if (!hook && !retired.length) return;
  assertPlainPath(root);
  for (const name of retired) assertPlainPath(path.join(root, name));
  const archive = path.join(root, `retired-deferred-${randomUUID()}`);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  if (hook) {
    const temp = `${bin}.${randomUUID()}.tmp`;
    try {
      if (hook.link) fs.symlinkSync(hook.link, temp);
      else { fs.copyFileSync(hook.savedFile, temp, fs.constants.COPYFILE_EXCL); fs.chmodSync(temp, fs.statSync(hook.savedFile).mode & 0o777); }
      fs.renameSync(temp, bin);
      fs.renameSync(metadata, path.join(archive, 'launcher-metadata.json'));
    } finally { fs.rmSync(temp, { force: true }); }
  }
  for (const name of retired) fs.renameSync(path.join(root, name), path.join(archive, name));
  console.log(`cleanup\tRetired deferred updater archived: ${archive}`);
  return archive;
}
export function applyPrepared(options, target, prepared, { command = run, detect = inspectInstallation, hasHerdr = () => Boolean(executable('herdr')) } = {}) {
  const { repo, agentDir } = options;
  const installation = detect();
  if (installation.kind === 'blocked') throw new Error(installation.reason);
  if (installation.kind === 'brew' && !installation.host) throw new Error('Homebrew Pi has no discoverable SDK; cannot validate/apply host patch. Original install left unchanged.');
  if (!hasHerdr()) throw new Error('Install Herdr before configuring this machine; Pi has not been changed.');
  assertPlainPath(agentDir);
  for (const dir of [path.join(agentDir, 'npm'), stateRoot(agentDir), ...target.remotes.filter(item => item.kind === 'remote-git').map(item => path.join(agentDir, 'git', item.identity))]) assertPlainPath(dir);
  for (const item of target.remotes.filter(item => item.kind === 'remote-git')) {
    const dir = path.join(agentDir, 'git', item.identity);
    if (!fs.existsSync(dir)) continue;
    if (command('git', ['-C', dir, 'status', '--porcelain'])) throw new Error(`Dirty git package preserved before any install: ${dir}`);
    command('git', ['-C', dir, 'fetch', 'origin']);
    command('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', item.commit]);
  }
  fs.mkdirSync(stateRoot(agentDir), { recursive: true, mode: 0o700 });
  const backup = path.join(stateRoot(agentDir), `backup-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  try {
    const npmDir = path.join(agentDir, 'npm');
    if (fs.existsSync(npmDir)) fs.cpSync(npmDir, path.join(backup, 'npm'), { recursive: true, dereference: false });
    const hashlineDir = process.env.PI_HASHLINE_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pi-hashline-edit-pro');
    assertPlainPath(hashlineDir);
    if (fs.existsSync(hashlineDir)) fs.cpSync(hashlineDir, path.join(backup, 'hashline'), { recursive: true, dereference: false });
    if (installation.host) fs.cpSync(installation.host, path.join(backup, 'pi-before-update'), { recursive: true, dereference: false });
    atomic(path.join(backup, 'receipt.json'), json({ installation, target, status: 'prepared' }));
    console.log('updating\tWriting installed files directly. Current Pi is not restarted; avoid /reload until your next normal start.');
    if (installation.version !== target.host.version) {
      const [binary, args] = hostUpdateCommand(installation, target.host.version);
      const env = { ...process.env, PATH: `${path.dirname(installation.node ?? installation.manager ?? installation.bin)}${path.delimiter}${process.env.PATH ?? ''}`,
        ...(installation.kind === 'managed' ? { PI_MANAGED_INSTALL_ROOT: installation.root } : {}) };
      command(binary, args, { env });
    }
    const actual = detect();
    if (actual.kind !== installation.kind || ['prefix', 'root', 'manager', 'node'].some(key => installation[key] && actual[key] !== installation[key])) throw new Error('Pi installation channel/prefix changed during upgrade; refusing configuration.');
    if (actual.kind === 'blocked' || !actual.host || actual.version !== target.host.version) throw new Error('Installed Pi does not match validated target (or no SDK available). See backup receipt.');
    const version = command(actual.bin, ['--version']);
    if (version !== target.host.version) throw new Error(`pi --version returned ${version}, expected ${target.host.version}`);
    const runtimeNode = actual.node ?? process.execPath;
    const env = { ...process.env, PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir, PI_HOST_DIR: actual.host };
    const specs = target.remotes.filter(item => item.kind === 'remote-npm').map(item => `${item.name}@${item.version}`);
    if (specs.length) command(executable('npm', env), ['install', '--prefix', npmDir, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', ...specs], { env });
    for (const item of target.remotes.filter(item => item.kind === 'remote-npm')) {
      const installed = readJson(path.join(npmDir, 'node_modules', item.name, 'package.json'));
      const resolution = readJson(path.join(npmDir, 'package-lock.json')).packages[`node_modules/${item.name}`];
      if (installed.version !== item.version || resolution?.integrity !== item.integrity) throw new Error(`Installed package integrity/version differs: ${item.name}`);
    }
    for (const item of target.remotes.filter(item => item.kind === 'remote-git')) {
      const dir = path.join(agentDir, 'git', item.identity);
      if (fs.existsSync(dir)) {
        if (command('git', ['-C', dir, 'status', '--porcelain'])) throw new Error(`Git package changed during update: ${dir}`);
        command('git', ['-C', dir, 'merge', '--ff-only', item.commit]);
        if (fs.existsSync(path.join(dir, 'package.json'))) command(executable('npm', env), ['install', '--prefix', dir, '--omit=dev', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { env });
      } else {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.cpSync(path.join(prepared.stageAgent, 'git', item.identity), dir, { recursive: true });
      }
    }
    const settingsFile = path.join(prepared.stage, 'resolved-settings.json');
    atomic(settingsFile, json(resolvedSettings(repo, target)));
    command('/bin/bash', [path.join(repo, 'setup.sh'), '--skip-tool-updates'], { env: { ...env, MY_DEV_SETUP_SETTINGS: settingsFile } });
    command(runtimeNode, [path.join(repo, 'scripts/check-pi-extensions.mjs'), repo, '--host', actual.host, '--agent-dir', agentDir, '--settings', settingsFile], { env });
    atomic(path.join(backup, 'receipt.json'), json({ installation, target, status: 'applied' }));
    atomic(path.join(stateRoot(agentDir), 'status.json'), json({ status: 'applied', host: target.host.version, backup, restartRequired: true }));
    console.log(`applied\tPi ${target.host.version} installed; use the new runtime on your next normal Pi start. Backup: ${backup}`);
  } catch (error) {
    atomic(path.join(backup, 'failure.json'), json({ status: 'failed', error: error.message }));
    atomic(path.join(stateRoot(agentDir), 'status.json'), json({ status: 'failed', targetHost: target.host.version, backup, error: error.message, restartRequired: true }));
    throw new Error(`${error.message}\nPartial installation may exist; configuration has its own transaction backup. Package/host backup: ${backup}`);
  }
}
export async function main(options, { detect = inspectInstallation, resolve = resolveLatest, validate = prepare, apply = applyPrepared, retire = removeLegacyMaintenance } = {}) {
  if (options.command === 'status') {
    const file = path.join(stateRoot(options.agentDir), 'status.json');
    console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'No maintenance receipt on this machine.'); return;
  }
  if (options.command === 'bootstrap' && options.apply) retire(options.repo, options.agentDir);
  const installation = detect();
  console.log(`host\t${installation.kind}\t${installation.version ?? 'not installed'}${installation.reason ? ` · ${installation.reason}` : ''}`);
  const target = await resolve(options.repo);
  for (const item of classifyDrift(options.repo, target)) console.log(`${item.kind}\t${item.source}\t${item.target}`);
  console.log(`target\tPi ${target.host.version}`);
  if (options.command === 'check') return;
  if (installation.kind === 'blocked') throw new Error(installation.reason);
  const prepared = await validate(options.repo, options.agentDir, target, installation);
  try {
    console.log('validated\tTemporary validation passed; repository-only packages were not merged or replaced.');
    if (options.command === 'bootstrap' && options.apply) apply(options, target, prepared);
    else console.log('prepared\tValidation only; no installation or configuration applied.');
  } finally { fs.rmSync(prepared.stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`blocked\t${error.message}`); process.exitCode = 1; }
}
