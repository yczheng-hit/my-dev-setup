#!/usr/bin/env node
// Configuration-only transaction. setup's explicit tool installs/links remain separate operations.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planAgentsOnly, legacyTarget } from './agents-only.mjs';

const MANIFEST = '.my-dev-setup-manifest.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const exists = (target) => fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })();
function plainPath(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink destination/ancestor: ${current}`);
      if (current === target ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Unexpected destination type: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
}
function bytesAt(target) {
  plainPath(target);
  return fs.existsSync(target) ? fs.readFileSync(target) : null;
}
const hashAt = (target) => { const bytes = bytesAt(target); return bytes === null ? null : digest(bytes); };
function writable(target) {
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
  if (fs.existsSync(target)) fs.accessSync(target, fs.constants.W_OK);
}
function readObject(target, fallback = {}) {
  const bytes = bytesAt(target); const value = bytes === null ? fallback : JSON.parse(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected JSON object: ${target}`);
  return value;
}
function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Repository config symlink requires manual review: ${target}`);
    return entry.isDirectory() ? walk(target) : entry.isFile() ? [target] : [];
  });
}
function atomic(target, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode }); fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}
function validateManifest(manifest, agentDir, repo) {
  if (manifest.version !== 1 || manifest.agentDir !== agentDir || manifest.repo !== repo || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported/mismatched deployment manifest; review it manually');
  }
  const seen = new Set();
  for (const item of manifest.files) {
    if (typeof item.target !== 'string' || !path.isAbsolute(item.target) || path.resolve(item.target) !== item.target || !/^[a-f0-9]{64}$/.test(item.hash) || seen.has(item.target)) throw new Error('Invalid manifest entry');
    seen.add(item.target);
  }
}
function preserveCustomExtension(target, data, old) {
  const current = bytesAt(target);
  return current !== null && digest(current) !== digest(data) && (!old || digest(current) !== old.hash);
}
// The same ownership/pruning rules as buildPlan, but only standalone resources.
// Return prospective bytes without applying a deployment or reading auth/session data.
export function planExtensionTree(repo, agentDir) {
  repo = path.resolve(repo); agentDir = path.resolve(agentDir);
  const prior = readObject(path.join(agentDir, MANIFEST), { version: 1, repo, agentDir, files: [] });
  validateManifest(prior, agentDir, repo);
  const previous = new Map(prior.files.map(item => [item.target, item]));
  const root = path.join(agentDir, 'extensions'); const desired = new Set();
  // Never copy live extension JSON/config, logs or credential-like ancillary files.
  const files = new Map(walk(root).filter(file => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file) || path.basename(file) === 'package.json')
    .map(file => [path.relative(root, file), bytesAt(file)]));
  for (const file of walk(path.join(repo, 'pi/extensions'))) {
    const relative = path.relative(path.join(repo, 'pi/extensions'), file);
    if (relative === 'claude-rules.ts') continue;
    desired.add(relative);
    const data = fs.readFileSync(file), target = path.join(root, relative);
    if (relative.endsWith('.json') || !preserveCustomExtension(target, data, previous.get(target))) files.set(relative, data);
  }
  for (const old of prior.files) {
    const relative = path.relative(root, old.target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || desired.has(relative) || relative === 'herdr-agent-state.ts') continue;
    if (hashAt(old.target) === old.hash) files.delete(relative);
  }
  const retired = legacyTarget(agentDir);
  if (retired) files.delete(path.relative(root, retired));
  return files;
}
export function buildPlan({ repo, agentDir, home = os.homedir(), herdrDir = path.join(home, '.config/herdr'),
  hashlineDir = path.join(home, '.config/pi-hashline-edit-pro'), host, agentsOnly = true, settingsFile }) {
  repo = path.resolve(repo); agentDir = path.resolve(agentDir); herdrDir = path.resolve(herdrDir); hashlineDir = path.resolve(hashlineDir);
  const manifestPath = path.join(agentDir, MANIFEST);
  const prior = readObject(manifestPath, { version: 1, repo, agentDir, files: [] });
  validateManifest(prior, agentDir, repo);
  const previous = new Map(prior.files.map((item) => [item.target, item]));
  const desired = new Map(); const warnings = []; const preserved = new Map();
  const add = (target, bytes, kind = 'config') => {
    target = path.resolve(target); const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (target.endsWith('.json')) JSON.parse(data.toString('utf8'));
    if (desired.has(target)) throw new Error(`Duplicate deployment target: ${target}`);
    const old = previous.get(target);
    if (kind === 'extension' && preserveCustomExtension(target, data, old)) {
      // No ownership evidence: never overwrite a user's extension, even at a desired path.
      warnings.push(`preserved custom extension: ${target}`);
      if (old) preserved.set(target, old);
      return;
    }
    desired.set(target, { target, data, kind });
  };
  const source = (name) => fs.readFileSync(name === 'settings.json' && settingsFile ? settingsFile : path.join(repo, 'pi', name));
  const merge = (name, target, transform = value => value) => add(target, json({ ...readObject(target), ...transform(JSON.parse(source(name))) }));
  const settingsPath = path.join(agentDir, 'settings.json'), localSettings = readObject(settingsPath);
  const settings = { ...localSettings, ...JSON.parse(source('settings.json')) };
  for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'externalEditor']) {
    if (Object.hasOwn(localSettings, key)) settings[key] = localSettings[key];
  }
  settings.packages = (settings.packages ?? []).map(entry => {
    const expand = value => value.startsWith('repo:') ? path.resolve(repo, value.slice(5)) : value;
    return typeof entry === 'string' ? expand(entry) : { ...entry, source: expand(entry.source) };
  });
  add(settingsPath, json(settings));
  // Machine-specific policy is initialized once; later changes belong to the local operator.
  const seedConfig = (target, bytes, kind) => {
    if (!exists(target)) return add(target, bytes, kind);
    const old = previous.get(target);
    if (old) preserved.set(target, old);
  };
  for (const name of ['AGENTS.md', 'keybindings.json', 'pi-cc-extensions.json', 'WATCHDOG.yml']) add(path.join(agentDir, name), source(name));
  if (exists(path.join(repo, 'pi/sol-pi.json'))) add(path.join(agentDir, 'sol-pi.json'), source('sol-pi.json'));
  for (const file of walk(path.join(repo, 'pi/themes'))) add(path.join(agentDir, 'themes', path.relative(path.join(repo, 'pi/themes'), file)), fs.readFileSync(file));
  seedConfig(path.join(path.dirname(agentDir), 'permissions.json'), source('permissions.json'), 'config');
  merge('openai-codex-compat.json', path.join(agentDir, 'openai-codex-compat.json'));
  merge('pi-hashline-edit-pro.json', path.join(hashlineDir, 'config.json'));
  for (const file of walk(path.join(repo, 'pi/extensions'))) {
    const relative = path.relative(path.join(repo, 'pi/extensions'), file);
    if (relative === 'claude-rules.ts') continue;
    const target = path.join(agentDir, 'extensions', relative), bytes = fs.readFileSync(file);
    if (relative === 'picc-permission-modes/config.json') seedConfig(target, bytes, 'extension-config');
    else add(target, bytes, relative.endsWith('.json') ? 'extension-config' : 'extension');
  }
  let herdr = fs.readFileSync(path.join(repo, 'herdr/config.toml'));
  if (!fs.existsSync('/bin/zsh')) {
    if (!fs.existsSync('/bin/bash')) throw new Error('No supported shell for Herdr configuration');
    herdr = Buffer.from(herdr.toString().replace(/^default_shell = "\/bin\/zsh"$/m, 'default_shell = "/bin/bash"'));
  }
  add(path.join(herdrDir, 'config.toml'), herdr);
  const changes = [];
  const addChange = (target, data, kind) => {
    const before = bytesAt(target); const beforeHash = before === null ? null : digest(before);
    const afterHash = data === null ? null : digest(data);
    if (beforeHash === afterHash) return;
    writable(target);
    changes.push({ target, before, data, beforeHash, afterHash, kind,
      mode: before === null ? 0o600 : fs.statSync(target).mode & 0o777 });
  };
  // Stale files may only be pruned from the two previously managed resource roots.
  // Never prune config, host chunks, official Herdr integration, or an arbitrary manifest path.
  const pruneRoots = ['extensions', 'themes'].map((name) => path.join(agentDir, name) + path.sep);
  for (const old of prior.files) {
    if (desired.has(old.target) || preserved.has(old.target)) continue;
    if (!pruneRoots.some((root) => old.target.startsWith(root))) continue;
    if (old.target === path.join(agentDir, 'extensions/herdr-agent-state.ts')) continue;
    if (hashAt(old.target) === old.hash) addChange(old.target, null, 'retired');
    else if (exists(old.target)) warnings.push(`preserved modified stale file: ${old.target}`);
  }
  if (agentsOnly) {
    if (!host) throw new Error('Set PI_HOST_DIR for AGENTS-only preflight');
    for (const change of planAgentsOnly(path.resolve(host), agentDir)) addChange(change.file, change.after === null ? null : Buffer.from(change.after), 'agents-only');
  }
  for (const item of desired.values()) addChange(item.target, item.data, item.kind);
  const files = [...desired.values()].map((item) => ({ target: item.target, hash: digest(item.data), kind: item.kind }));
  files.push(...preserved.values());
  const manifest = { version: 1, repo, agentDir, files: files.sort((a, b) => a.target.localeCompare(b.target)) };
  addChange(manifestPath, json(manifest), 'manifest');
  return { repo, agentDir, changes, warnings };
}
function assertCurrent(changes, key) {
  for (const item of changes) if (hashAt(item.target) !== item[key]) throw new Error(`Changed since plan/backup; refusing all writes: ${item.target}`);
}
export function applyPlan(plan, backupRoot) {
  // Run deployments sequentially. Hash checks still protect edits made after planning.
  assertCurrent(plan.changes, 'beforeHash');
  for (const item of plan.changes) writable(item.target);
  if (!plan.changes.length) return null;
  const backup = path.resolve(backupRoot, `transaction-${randomUUID()}`);
  plainPath(path.join(backup, 'transaction.json'));
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const records = plan.changes.map((item, index) => {
    const blob = item.before === null ? null : `before-${index}`;
    if (blob) fs.writeFileSync(path.join(backup, blob), item.before, { flag: 'wx', mode: 0o600 });
    return { target: item.target, beforeHash: item.beforeHash, afterHash: item.afterHash, blob, mode: item.mode, kind: item.kind };
  });
  const record = { version: 1, status: 'prepared', repo: plan.repo, agentDir: plan.agentDir, files: records };
  atomic(path.join(backup, 'transaction.json'), json(record));
  const applied = [];
  try {
    for (const item of plan.changes) {
      assertCurrent([item], 'beforeHash');
      if (item.data === null) fs.unlinkSync(item.target); else atomic(item.target, item.data, item.mode);
      applied.push(item);
    }
    record.status = 'applied'; atomic(path.join(backup, 'transaction.json'), json(record));
    return backup;
  } catch (error) {
    for (const item of applied.reverse()) {
      if (hashAt(item.target) !== item.afterHash) continue;
      if (item.before === null) fs.unlinkSync(item.target); else atomic(item.target, item.before, item.mode);
    }
    record.status = 'failed'; atomic(path.join(backup, 'transaction.json'), json(record));
    throw error;
  }
}
export function restoreBackup(backup, apply = false) {
  backup = path.resolve(backup);
  const file = path.join(backup, 'transaction.json'); const record = readObject(file);
  if (!path.isAbsolute(record.agentDir ?? '') || record.version !== 1 || record.status !== 'applied' || !Array.isArray(record.files)) throw new Error('Backup is not an applied transaction');
  const targets = new Set();
  const changes = record.files.map((item) => {
    if (!path.isAbsolute(item.target ?? '') || path.resolve(item.target) !== item.target || targets.has(item.target) || ![item.beforeHash, item.afterHash].every((hash) => hash === null || /^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid backup record');
    targets.add(item.target);
    let data = null;
    if (item.beforeHash !== null) {
      if (!/^before-\d+$/.test(item.blob ?? '')) throw new Error('Unsafe backup blob');
      data = bytesAt(path.join(backup, item.blob));
      if (data === null || digest(data) !== item.beforeHash) throw new Error(`Corrupt backup blob: ${item.blob}`);
    }
    plainPath(item.target); writable(item.target);
    return { ...item, data };
  });
  assertCurrent(changes, 'afterHash'); // validate ALL first, never partial restore on ordinary conflicts
  if (apply) {
    const restored = [];
    try {
      for (const item of changes.toReversed()) {
        assertCurrent([item], 'afterHash');
        const deployed = bytesAt(item.target);
        if (item.data === null) fs.unlinkSync(item.target); else atomic(item.target, item.data, item.mode);
        restored.push({ ...item, deployed });
      }
      record.status = 'restored'; atomic(file, json(record));
    } catch (error) {
      for (const item of restored.reverse()) {
        if (hashAt(item.target) !== item.beforeHash) continue;
        if (item.deployed === null) fs.unlinkSync(item.target); else atomic(item.target, item.deployed, item.mode);
      }
      throw error;
    }
  }
  return changes;
}

function argsOf(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--apply', '--check', '--dry-run'].includes(name)) options[name.slice(2)] = true;
    else if (['--settings', '--repo', '--agent-dir', '--home', '--herdr-dir', '--hashline-dir', '--host', '--backup', '--restore'].includes(name) && args[index + 1]) options[name.slice(2)] = args[++index];
    else throw new Error(`Unknown/missing argument: ${name}`);
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argsOf(process.argv.slice(2));
    if (args.restore) {
      for (const item of restoreBackup(args.restore, args.apply)) console.log(`${args.apply ? 'restored' : 'would restore'}\t${item.target}`);
    } else {
      if (!args.repo || !args['agent-dir']) throw new Error('Required: --repo <dir> --agent-dir <dir> [--apply --backup <dir>]');
      const plan = buildPlan({ repo: args.repo, agentDir: args['agent-dir'], home: args.home,
        herdrDir: args['herdr-dir'], hashlineDir: args['hashline-dir'], settingsFile: args.settings, host: args.host ?? process.env.PI_HOST_DIR });
      for (const warning of plan.warnings) console.warn(`warning\t${warning}`);
      for (const item of plan.changes) console.log(`${args.apply ? 'apply' : 'plan'}\t${item.kind}\t${item.target}`);
      if (args.apply) {
        if (!args.backup) throw new Error('--apply requires --backup');
        const backup = applyPlan(plan, args.backup); if (backup) console.log(`backup\t${backup}`);
      }
      console.log(`summary\tchanges=${plan.changes.length} preserved=${plan.warnings.length}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
