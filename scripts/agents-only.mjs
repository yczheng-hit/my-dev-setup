#!/usr/bin/env node
// Explicit deployment compatibility patch for Pi 1.4 (SDK AND bundled CLI).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readLaunchHook } from './maintenance-queue.mjs';
const MARKER = 'my-dev-setup: agents-only v1';
const HELPER = `// ${MARKER}\nimport{realpathSync as __agentsOnlyRealpath}from"node:fs";\nfunction __agentsOnlyForbidden(p){return [p,__agentsOnlyRealpath(p)].some(v=>/(^|[\\\\/])\\.claude([\\\\/]|$)|(^|[\\\\/])claude\\.md$/i.test(v))}\n`;
const OLD_HASH = '8a935f14f62c1c1a3e937f5c912c2215e25aa5fa591716e23c86224ce1dc34cd';
function exactlyOne(source, pattern, replacement) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw new Error(`Unsupported Pi context loader (${matches.length} matches for ${pattern}); refusing partial patch`);
  return source.replace(pattern, replacement);
}
export function patchResourceLoader(source) {
  if (source.includes(MARKER)) {
    if (!source.includes('const candidates=["AGENTS.override.md","AGENTS.md","AGENTS.MD"];') || !source.includes('__agentsOnlyForbidden(filePath)')) throw new Error('Incomplete agents-only patch');
    return source;
  }
  let after = exactlyOne(source, /(?:const|let) candidates\s*=\s*\["AGENTS.override.md",\s*"AGENTS.md",\s*"AGENTS.MD",\s*"CLAUDE.md",\s*"CLAUDE.MD"\];/, 'const candidates=["AGENTS.override.md","AGENTS.md","AGENTS.MD"];');
  after = exactlyOne(after, /if\s*\(\s*!statSync\d*\(filePath\)\.isFile\(\)\s*\)/, (match) => match.replace('!', '__agentsOnlyForbidden(filePath)||!'));
  return HELPER + after;
}
export function legacyTarget(agentDir) {
  const target = path.join(agentDir, 'extensions/claude-rules.ts');
  if (!fs.existsSync(target)) return;
  const source = fs.readFileSync(target, 'utf8');
  if (source.includes('Retired: .agents/rules is provided by repo:packages/pi-agents-context.')) return target;
  if (createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex') !== OLD_HASH) throw new Error(`Custom legacy extension preserved: ${target}. Review and remove it manually before agents-only deployment.`);
  return target;
}
function backupFile(source, backup) {
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup)) fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
}
export function retireLegacyExtension(agentDir, backupDir, dryRun = false) {
  const target = legacyTarget(agentDir);
  if (!target) return false;
  if (!dryRun) {
    backupFile(target, path.join(backupDir, 'retired/claude-rules.ts'));
    fs.unlinkSync(target);
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}retired managed Claude rules extension: ${target}`);
  return true;
}
export function applyAgentsOnly(host, agentDir, backupDir, dryRun = false) {
  // The same read-only validation is shared with setup's managed transaction.
  const changes = planAgentsOnly(host, agentDir);
  for (const { file, before, after } of changes) {
    if (before === after || after === null) continue;
    if (!dryRun) {
      backupFile(file, path.join(backupDir, 'pi-host', path.relative(host, file)));
      fs.writeFileSync(file, after);
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}patched AGENTS-only discovery: ${file}`);
  }
  retireLegacyExtension(agentDir, backupDir, dryRun);
}
// A read-only transaction plan lets setup validate every config/host mutation before writing.
export function planAgentsOnly(host, agentDir) {
  const files = [path.join(host, 'dist/core/resource-loader.js')];
  const chunks = path.join(host, 'dist/bundle/chunks');
  if (!fs.existsSync(chunks)) throw new Error('Unsupported Pi layout: bundled CLI chunks missing');
  for (const name of fs.readdirSync(chunks).filter((name) => name.endsWith('.js'))) {
    const file = path.join(chunks, name);
    if (fs.readFileSync(file, 'utf8').includes('function loadContextFileFromDir(')) files.push(file);
  }
  if (files.length < 2) throw new Error('Cannot locate bundled CLI context loader; refusing SDK-only patch');
  const changes = files.map((file) => {
    const before = fs.readFileSync(file, 'utf8');
    return { file, before, after: patchResourceLoader(before) };
  });
  const legacy = legacyTarget(agentDir);
  if (legacy) changes.push({ file: legacy, before: fs.readFileSync(legacy, 'utf8'), after: null });
  return changes;
}
export function findHost() {
  if (process.env.PI_HOST_DIR) return process.env.PI_HOST_DIR;
  const bin = spawnSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).stdout.trim();
  if (bin) { const hook = readLaunchHook(bin); if (hook) return hook.original.host; }
  if (bin) for (let dir = path.dirname(fs.realpathSync(bin)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try { if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@earendil-works/pi-coding-agent') return dir; } catch {}
  }
  throw new Error('Cannot find Pi host; set PI_HOST_DIR.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [agentDir, backupDir, ...flags] = process.argv.slice(2);
  if (!agentDir || !backupDir) throw new Error('usage: agents-only.mjs <agent-dir> <backup-dir> [--dry-run]');
  applyAgentsOnly(findHost(), agentDir, backupDir, flags.includes('--dry-run'));
}
