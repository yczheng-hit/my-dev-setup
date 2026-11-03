#!/usr/bin/env node
// Regenerate/verify the runtime-only vendored patch from an unpacked npm release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = process.argv[2];
if (!original) throw new Error('usage: permission-patch.mjs <unpacked npm 0.1.3 package> [--check]');
const local = path.join(root, 'packages/picc-permission-modes');
const artifact = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? path.join(root, 'patches/picc-permission-modes/0.1.3-local.patch');
function runtimeFiles(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(rel, entry.name);
    if (entry.isDirectory()) return entry.name === 'upstream' || rel.startsWith('upstream') ? runtimeFiles(dir, name) : [];
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'vitest.config.ts' ? [name] : [];
  }).sort();
}
function copyRuntime(from, to) {
  for (const file of runtimeFiles(from)) {
    const dest = path.join(to, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(path.join(from, file), 'utf8').replace(/\r\n/g, '\n'));
  }
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-patch-'));
function git(...args) {
  const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
try {
  if (JSON.parse(fs.readFileSync(path.join(original, 'package.json'))).version !== '0.1.3') throw new Error('Expected npm 0.1.3');
  git('init', '-q'); copyRuntime(original, temp); git('add', '.');
  git('-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'normalized npm runtime');
  for (const file of runtimeFiles(temp)) fs.unlinkSync(path.join(temp, file));
  copyRuntime(local, temp); git('add', '-A');
  const patch = git('diff', '--cached', '--binary', '--no-ext-diff', '--no-color').replace(/^ $/gm, '');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(artifact, 'utf8') !== patch) throw new Error('Vendored patch differs; regenerate without --check');
  } else fs.writeFileSync(artifact, patch);
  git('reset', '--hard', '-q', 'HEAD');
  const applied = spawnSync('git', ['apply', '--check', artifact], { cwd: temp, encoding: 'utf8' });
  if (applied.status !== 0) throw new Error(applied.stderr);
  git('apply', artifact);
  const expected = runtimeFiles(local), actual = runtimeFiles(temp);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Runtime file inventory mismatch');
  for (const file of expected) if (fs.readFileSync(path.join(temp, file), 'utf8') !== fs.readFileSync(path.join(local, file), 'utf8').replace(/\r\n/g, '\n')) throw new Error(`Mismatch: ${file}`);
  console.log(`PASS npm 0.1.3 + patch == ${expected.length} local runtime files (sibling pi-agents-context required)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
