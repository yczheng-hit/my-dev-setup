#!/usr/bin/env node
// Verify/regenerate extension runtime artifacts from an unpacked, exact npm release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const [name, original, ...flags] = process.argv.slice(2);
if (!['pi-scheduler', 'pi-hud-footer'].includes(name) || !original) throw new Error('usage: runtime-patch.mjs pi-scheduler|pi-hud-footer <unpacked-release> [--check] [--output=<temp-file>]');
const local = path.join(root, 'packages', name);
const manifest = JSON.parse(fs.readFileSync(path.join(local, 'package.json')));
const upstream = JSON.parse(fs.readFileSync(path.join(original, 'package.json')));
if (upstream.name !== manifest.name || upstream.version !== manifest.version) throw new Error('Wrong npm baseline name/version');
const artifact = path.resolve(flags.find((arg) => arg.startsWith('--output='))?.slice(9) ?? path.join(root, 'patches', name, `${manifest.version}-local.patch`));
function files(dir, rel = 'extensions') {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(rel, entry.name);
    return entry.isDirectory() ? files(dir, file) : entry.isFile() ? [file] : [];
  }).sort();
}
function copy(from, to) {
  for (const file of files(from)) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.writeFileSync(path.join(to, file), fs.readFileSync(path.join(from, file), 'utf8').replace(/\r\n/g, '\n'));
  }
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-patch-'));
function git(...args) {
  const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status) throw new Error(result.stderr); return result.stdout;
}
try {
  git('init', '-q'); copy(original, temp); git('add', '.');
  // Only a disposable fixture baseline; never creates a commit in the user's repository.
  git('-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'npm runtime fixture');
  fs.rmSync(path.join(temp, 'extensions'), { recursive: true, force: true }); copy(local, temp); git('add', '-A');
  const patch = git('diff', '--cached', '--binary', '--no-ext-diff', '--no-color').replace(/^ $/gm, '');
  if (flags.includes('--check')) {
    if (fs.readFileSync(artifact, 'utf8') !== patch) throw new Error('Artifact differs from local runtime');
  } else fs.writeFileSync(artifact, patch);
  git('reset', '--hard', '-q', 'HEAD'); git('apply', '--check', artifact); git('apply', artifact);
  assertFiles();
  console.log(`PASS ${manifest.name}@${manifest.version} + patch == ${files(local).length} local runtime files`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
function assertFiles() {
  if (JSON.stringify(files(local)) !== JSON.stringify(files(temp))) throw new Error('Runtime inventory mismatch');
  for (const file of files(local)) {
    if (fs.readFileSync(path.join(temp, file), 'utf8') !== fs.readFileSync(path.join(local, file), 'utf8').replace(/\r\n/g, '\n')) throw new Error(`Mismatch: ${file}`);
  }
}
