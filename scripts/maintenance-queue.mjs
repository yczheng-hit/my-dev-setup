// Durable, local-only candidates and an owned startup hook. Never replaces a running host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const HOOK_MARKER = '# my-dev-setup: deferred maintenance v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export const queueRoot = agentDir => path.join(agentDir, 'state/my-dev-setup');
export function plainPath(target) {
  for (let dir = path.resolve(target);; dir = path.dirname(dir)) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink maintenance destination: ${dir}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dir === path.dirname(dir)) break;
  }
}
export function atomic(file, bytes, mode = 0o600) {
  plainPath(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlink maintenance file: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, bytes, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function treeDigest(root) {
  const sum = createHash('sha256');
  function walk(relative) {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    sum.update(json([relative, stat.mode & 0o777, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file']));
    if (stat.isSymbolicLink()) sum.update(fs.readlinkSync(full));
    else if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) sum.update(fs.readFileSync(full));
    else throw new Error(`Unsupported candidate file: ${full}`);
  }
  walk(''); return sum.digest('hex');
}
// Only repository-controlled inputs; no credentials, sessions, logs or ignored dependencies.
export function repositoryDigest(repo) {
  const sum = createHash('sha256');
  function tracked(root, prefix = '') {
    const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(`Cannot fingerprint maintenance source: ${root}`);
    for (const relative of [...new Set(result.stdout.split('\0').filter(Boolean))].sort()) {
      if (!prefix && !/^(?:pi\/|herdr\/|scripts\/|packages\/|tools\/|(?:maintenance\.json|tools\.tsv|setup\.sh|bootstrap\.sh|AGENTS\.md)$)/.test(relative)) continue;
      const full = path.join(root, relative); sum.update(prefix + relative + '\0');
      if (!fs.existsSync(full)) { sum.update('missing'); continue; }
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) { tracked(full, `${prefix}${relative}/`); continue; }
      if (stat.isSymbolicLink()) {
        sum.update(fs.readlinkSync(full));
        if (fs.existsSync(path.join(full, '.git'))) tracked(full, `${prefix}${relative}/`);
      } else sum.update(fs.readFileSync(full));
    }
  }
  tracked(repo); return sum.digest('hex');
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function readLaunchHook(bin) {
  const metadataFile = `${bin}.my-dev-setup.json`;
  if (!fs.existsSync(metadataFile)) return;
  const bytes = fs.readFileSync(bin, 'utf8');
  if (!bytes.includes(HOOK_MARKER)) return; // A package manager may have replaced our wrapper.
  const value = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (value.version !== 1 || value.bin !== bin || value.wrapperHash !== hash(bytes)
    || !value.original?.real || !value.original?.node || !path.isAbsolute(value.original.real)) throw new Error('Invalid maintenance startup hook; original installation preserved.');
  return value;
}
export function installLaunchHook(repo, agentDir, installation) {
  const bin = installation.bin;
  const current = readLaunchHook(bin);
  if (current) {
    if (current.repo !== repo || current.agentDir !== agentDir) throw new Error('Pi startup hook belongs to another repository/agent directory.');
    return current;
  }
  if (!installation.node || !['npm', 'pnpm', 'bun', 'managed', 'brew'].includes(installation.kind)) throw new Error('Cannot establish owner Node for automatic startup activation.');
  plainPath(path.dirname(bin)); plainPath(queueRoot(agentDir));
  const stat = fs.lstatSync(bin), link = stat.isSymbolicLink() ? fs.readlinkSync(bin) : undefined;
  const original = { ...installation }; delete original.hook;
  let runEntry = installation.real, savedFile;
  if (!link) {
    // Keep a shell launcher's directory semantics ($0); never move its package tree.
    savedFile = `${bin}.my-dev-setup-original-${randomUUID()}`;
    fs.copyFileSync(bin, savedFile, fs.constants.COPYFILE_EXCL); fs.chmodSync(savedFile, stat.mode & 0o777);
    runEntry = savedFile;
  }
  const script = `#!/bin/sh\n${HOOK_MARKER}\nexec ${quote(installation.node)} ${quote(path.join(repo, 'scripts/maintenance-launch.mjs'))} ${quote(`${bin}.my-dev-setup.json`)} "$@"\n`;
  if (fs.existsSync(`${bin}.my-dev-setup.json`)) {
    const previous = JSON.parse(fs.readFileSync(`${bin}.my-dev-setup.json`, 'utf8'));
    if (previous.bin !== bin || previous.repo !== repo || previous.agentDir !== agentDir) throw new Error('Stale startup hook belongs to another owner.');
  }
  const metadata = { version: 1, bin, repo, agentDir, original, runEntry, link, savedFile,
    originalHash: link ? undefined : hash(fs.readFileSync(bin)), wrapperHash: hash(script) };
  atomic(`${bin}.my-dev-setup.json`, json(metadata));
  const temp = `${bin}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, script, { mode: 0o755, flag: 'wx' }); fs.renameSync(temp, bin); }
  finally { fs.rmSync(temp, { force: true }); }
  return metadata;
}
export function restoreLaunchHook(bin) {
  const hook = readLaunchHook(bin); if (!hook) return;
  const temp = `${bin}.${randomUUID()}.tmp`;
  try {
    if (hook.link) fs.symlinkSync(hook.link, temp);
    else {
      if (hash(fs.readFileSync(hook.savedFile)) !== hook.originalHash) throw new Error('Original Pi launcher backup changed.');
      fs.copyFileSync(hook.savedFile, temp, fs.constants.COPYFILE_EXCL); fs.chmodSync(temp, fs.statSync(hook.savedFile).mode & 0o777);
    }
    fs.renameSync(temp, bin); fs.unlinkSync(`${bin}.my-dev-setup.json`);
  } finally { fs.rmSync(temp, { force: true }); }
  return hook;
}
export function queuePrepared(options, lock, prepared, installation) {
  const { repo, agentDir } = options, root = queueRoot(agentDir);
  plainPath(root); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const guard = path.join(root, 'queue.lock'), fd = fs.openSync(guard, 'wx', 0o600);
  let destination;
  try {
    const sourceHash = repositoryDigest(repo);
    if (prepared.sourceHash && sourceHash !== prepared.sourceHash) throw new Error('Repository changed after candidate validation.');
    destination = path.join(root, 'candidates', randomUUID()); fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of ['host', 'agent']) fs.cpSync(path.join(prepared.stage, name), path.join(destination, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    const artifact = { version: 1, repo, agentDir, installation: { ...installation }, lock, sourceHash,
      stage: destination, hostHash: treeDigest(path.join(destination, 'host')), agentHash: treeDigest(path.join(destination, 'agent')) };
    delete artifact.installation.hook;
    atomic(path.join(destination, 'candidate.json'), json(artifact));
    installLaunchHook(repo, agentDir, installation);
    atomic(path.join(root, 'pending.json'), json({ version: 1, stage: destination, candidateHash: hash(fs.readFileSync(path.join(destination, 'candidate.json'))) }));
    atomic(path.join(root, 'status.json'), json({ status: 'queued', installedHost: installation.version, targetHost: lock.host.version,
      activation: 'next-safe-start', currentProcessUnchanged: true, stage: destination }));
    return artifact;
  } catch (error) {
    // Once pending.json references this directory, preserve it even if status writing failed.
    let published = false;
    try { published = JSON.parse(fs.readFileSync(path.join(root, 'pending.json'), 'utf8')).stage === destination; } catch {}
    if (destination && !published) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}
export function readQueued(agentDir) {
  const root = queueRoot(agentDir), file = path.join(root, 'pending.json');
  if (!fs.existsSync(file)) return;
  plainPath(file);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof pending.stage !== 'string') throw new Error('Invalid pending candidate path.');
  if (pending.version !== 1 || path.dirname(pending.stage) !== path.join(root, 'candidates') || !/^[a-f0-9-]{36}$/.test(path.basename(pending.stage))) throw new Error('Invalid pending maintenance candidate.');
  plainPath(pending.stage);
  const candidate = path.join(pending.stage, 'candidate.json'), bytes = fs.readFileSync(candidate);
  if (hash(bytes) !== pending.candidateHash) throw new Error('Pending candidate metadata changed; ask the agent to prepare it again.');
  const artifact = JSON.parse(bytes);
  if (artifact.version !== 1 || artifact.agentDir !== agentDir || artifact.stage !== pending.stage
    || artifact.hostHash !== treeDigest(path.join(pending.stage, 'host')) || artifact.agentHash !== treeDigest(path.join(pending.stage, 'agent')))
    throw new Error('Pending candidate contents changed; ask the agent to prepare it again.');
  if (artifact.sourceHash !== repositoryDigest(artifact.repo)) throw new Error('Repository changed since validation; ask the agent to prepare it again.');
  return artifact;
}
