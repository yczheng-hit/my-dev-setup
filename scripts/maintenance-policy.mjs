// Portable update policy and installation provenance. No installs or writes here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLaunchHook } from './maintenance-queue.mjs';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sourceOf = entry => typeof entry === 'string' ? entry : entry.source;
export const withSource = (entry, source) => typeof entry === 'string' ? source : { ...entry, source };
export function executable(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
}
export function inspectInstallation({ bin = executable('pi'), node = process.execPath, env = process.env, probe, realpath = fs.realpathSync } = {}) {
  const run = probe ?? ((command, args) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 15000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
  });
  if (!bin) {
    const npm = path.join(path.dirname(node), 'npm');
    if (!fs.existsSync(npm)) return { kind: 'blocked', reason: 'Pi absent; install Node/npm first (no automatic system/Node installation).' };
    return { kind: 'npm', missing: true, manager: npm, node, prefix: path.dirname(path.dirname(node)), bin: path.join(path.dirname(node), 'pi') };
  }
  const hook = readLaunchHook(bin);
  if (hook) {
    const owned = hook.original;
    try {
      if (readJson(path.join(owned.host, 'package.json')).name !== PI_PACKAGE || !fs.existsSync(owned.node) || !fs.existsSync(owned.manager ?? owned.real)) throw new Error('Missing owner');
      return { ...owned, bin, version: readJson(path.join(owned.host, 'package.json')).version, hook };
    } catch { return { kind: 'blocked', bin, reason: 'Maintenance hook owner changed; refusing installation migration.' }; }
  }
  const real = realpath(bin);
  // pnpm can expose a shell shim rather than a symlink into package code.
  const pnpmShim = executable('pnpm', env);
  if (pnpmShim) {
    const binDir = run(pnpmShim, ['bin', '-g']), root = run(pnpmShim, ['root', '-g']);
    if (real === path.join(realpath(path.dirname(bin)), path.basename(bin)) && binDir && root && fs.existsSync(binDir) && fs.realpathSync(path.dirname(bin)) === fs.realpathSync(binDir)) {
      const host = path.join(root, PI_PACKAGE);
      try { if (readJson(path.join(host, 'package.json')).name === PI_PACKAGE) return { kind: 'pnpm', bin, real, host: fs.realpathSync(host), version: readJson(path.join(host, 'package.json')).version, manager: pnpmShim, node }; } catch {}
    }
  }
  // Official installer launches a versioned release and sets this variable. It is
  // NOT a global npm installation, even though a release contains node_modules.
  const roots = new Set(env.PI_MANAGED_INSTALL_ROOT ? [env.PI_MANAGED_INSTALL_ROOT] : []);
  // The official executable is <agent>/bin/pi, alongside (not inside) install/.
  roots.add(path.join(path.dirname(path.dirname(real)), 'install'));
  for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) roots.add(dir);
  for (const candidate of roots) {
    if (!fs.existsSync(path.join(candidate, 'managed-install.json'))) continue;
    const root = fs.realpathSync(candidate);
    const launcher = path.join(path.dirname(root), 'bin/pi');
    const owns = real.startsWith(root + path.sep) || real === launcher;
    if (!owns) continue; // Ignore an unrelated inherited launcher environment, even if broken.
    try {
      const marker = readJson(path.join(root, 'managed-install.json'));
      const version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release');
      const host = path.join(root, 'releases', version, 'node_modules', PI_PACKAGE);
      if (marker.kind !== 'pi-managed-install' || marker.schemaVersion !== 1 || marker.layout !== 'releases-v1'
        || readJson(path.join(host, 'package.json')).name !== PI_PACKAGE) throw new Error('Invalid marker');
      if (real === launcher) {
        const script = fs.readFileSync(real, 'utf8');
        if (!script.includes('PI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install') || !script.includes('exec "$pi_release_bin" "$@"')) throw new Error('Unknown launcher');
      }
      const bundledNode = path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? process.env.HOME ?? process.cwd(), '.local/share'), 'pi-node/current/bin/node');
      return { kind: 'managed', bin, real, host, root, version: readJson(path.join(host, 'package.json')).version,
        node: fs.existsSync(bundledNode) ? bundledNode : node };
    } catch { return { kind: 'blocked', bin, real, reason: 'Invalid official managed installation marker/launcher; rerun its installer to repair.' }; }
  }
  if (real.startsWith('/nix/store/')) return { kind: 'blocked', bin, real, reason: 'Nix owns Pi. Update the owning flake/profile; refusing a second npm Pi.' };
  const brew = real.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\//);
  if (brew) {
    const manager = path.join(brew[1], 'bin/brew');
    if (!fs.existsSync(manager)) return { kind: 'blocked', bin, real, reason: 'Homebrew provenance found but its brew executable is absent.' };
    let host;
    for (let dir = path.dirname(real); dir.startsWith(brew[1]); dir = path.dirname(dir)) {
      try { if (readJson(path.join(dir, 'package.json')).name === PI_PACKAGE) { host = dir; break; } } catch {}
      if (path.dirname(dir) === dir) break;
    }
    return { kind: 'brew', manager, formula: brew[2], node, bin, real, host, version: host ? readJson(path.join(host, 'package.json')).version : undefined };
  }
  let host;
  for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try { if (readJson(path.join(dir, 'package.json')).name === PI_PACKAGE) { host = dir; break; } } catch {}
  }
  if (!host) return { kind: 'blocked', bin, real, reason: 'Standalone/custom Pi has no recognized package-manager provenance; use its original installer, not npm fallback.' };
  const version = readJson(path.join(host, 'package.json')).version;
  const base = { bin, real, host, version };
  // Verify pnpm/bun ownership before the generic npm directory layout.
  const pnpm = executable('pnpm', env);
  if (pnpm) {
    const root = run(pnpm, ['root', '-g']);
    if (root && fs.existsSync(path.join(root, PI_PACKAGE)) && fs.realpathSync(path.join(root, PI_PACKAGE)) === host) return { ...base, kind: 'pnpm', manager: pnpm, node };
  }
  const bunPrefix = host.split('/install/global/node_modules/');
  const bun = bunPrefix.length === 2 ? path.join(bunPrefix[0], 'bin/bun') : undefined;
  if (bun && fs.existsSync(bun)) return { ...base, kind: 'bun', manager: bun, node };
  const suffix = `/lib/node_modules/${PI_PACKAGE}`;
  if (host.endsWith(suffix)) {
    const prefix = host.slice(0, -suffix.length), manager = path.join(prefix, 'bin/npm'), ownedNode = path.join(prefix, 'bin/node');
    if (fs.existsSync(manager) && fs.existsSync(ownedNode)) return { ...base, kind: 'npm', manager, node: ownedNode, prefix };
  }
  return { ...base, kind: 'blocked', reason: 'Cannot prove npm/pnpm/bun ownership of this Pi. Original installation left untouched.' };
}
export function hostUpdateCommand(installation, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable Pi version');
  const spec = `${PI_PACKAGE}@${version}`;
  switch (installation.kind) {
    case 'managed': return [installation.bin, ['update', '--self']];
    case 'npm': return [installation.manager, ['install', '--global', '--prefix', installation.prefix, '--ignore-scripts', '--no-audit', '--no-fund', spec]];
    case 'pnpm': return [installation.manager, ['add', '--global', '--ignore-scripts', spec]];
    case 'bun': return [installation.manager, ['add', '--global', '--ignore-scripts', spec]];
    case 'brew': return [installation.manager, ['upgrade', installation.formula]];
    default: throw new Error(installation.reason ?? 'Unrecognized Pi installation');
  }
}
export function inventory(repo) {
  const policy = readJson(path.join(repo, 'maintenance.json'));
  if (policy.version !== 1 || policy.host?.installation !== 'preserve') throw new Error('Unsupported maintenance policy');
  const settings = readJson(path.join(repo, 'pi/settings.json'));
  const entries = (settings.packages ?? []).map(entry => {
    const source = sourceOf(entry);
    if (typeof source !== 'string') throw new Error('Invalid package source');
    if (source.startsWith('repo:')) {
      const relative = source.slice(5), rule = policy.repositoryPackages[relative];
      if (!rule || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Unclassified repository package: ${source}`);
      if (!['repository-only', 'owner-repository-only'].includes(rule.policy)) throw new Error(`Repository package cannot track an upstream release: ${source}`);
      return { source, entry, relative, ...rule };
    }
    if (source.startsWith('npm:')) {
      const match = source.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@(.+))?$/);
      if (!match) throw new Error(`Invalid npm source: ${source}`);
      if (Object.values(policy.repositoryPackages).some(rule => rule.kind === 'patched' && rule.upstream === match[1])) throw new Error(`Patched package must use repository source, not ${source}`);
      return { source, entry, kind: 'remote-npm', name: match[1] };
    }
    if (source.startsWith('git:')) {
      const match = source.slice(4).match(/^(github\.com\/[^/@]+\/[^/@]+)(?:@([^\s]+))?$/);
      if (!match) throw new Error(`Unsupported git source (use github.com/owner/repo[@branch]): ${source}`);
      return { source, entry, kind: 'remote-git', url: `https://${match[1]}.git`, identity: match[1], ref: match[2] ?? 'HEAD' };
    }
    throw new Error(`Unclassified package source: ${source}`);
  });
  return { policy, settings, entries };
}
export async function resolveLatest(repo, { metadata, gitHead } = {}) {
  const data = inventory(repo);
  const get = metadata ?? (async name => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Registry lookup failed for ${name}: HTTP ${response.status}`);
    return response.json();
  });
  const head = gitHead ?? ((url, ref) => {
    const result = spawnSync('git', ['ls-remote', url, ref], { encoding: 'utf8', timeout: 30000 });
    const sha = result.stdout?.trim().split(/\s/)[0];
    if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error(`Cannot resolve git ref: ${url} ${ref}`);
    return sha;
  });
  const host = await get(data.policy.host.package);
  if (!/^\d+\.\d+\.\d+$/.test(host.version)) throw new Error('Pi latest is not a stable release');
  const remotes = await Promise.all(data.entries.filter(entry => entry.kind.startsWith('remote-')).map(async entry => {
    if (entry.kind === 'remote-npm') {
      const pkg = await get(entry.name);
      if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !pkg.dist?.integrity) throw new Error(`Invalid stable release metadata: ${entry.name}`);
      return { source: entry.source, kind: entry.kind, name: entry.name, version: pkg.version, integrity: pkg.dist.integrity, resolved: `npm:${entry.name}@${pkg.version}` };
    }
    const commit = await head(entry.url, entry.ref);
    return { source: entry.source, kind: entry.kind, url: entry.url, identity: entry.identity, commit, resolved: `git:${entry.identity}@${commit}` };
  }));
  return { version: 1, host: { package: data.policy.host.package, version: host.version, integrity: host.dist?.integrity }, remotes };
}
export function resolvedSettings(repo, lock) {
  const { settings } = inventory(repo);
  const resolved = new Map(lock.remotes.map(item => [item.source, item.resolved]));
  return { ...settings, packages: settings.packages.map(entry => {
    const source = sourceOf(entry);
    if (!source.startsWith('repo:') && !resolved.has(source)) throw new Error(`Lock omits configured remote: ${source}`);
    return withSource(entry, resolved.get(source) ?? source);
  }) };
}
