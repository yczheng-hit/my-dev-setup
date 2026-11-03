#!/usr/bin/env node
// Load every native-addon dependency of a package the way pi will, one child process each, so an
// ABI problem (old libstdc++, wrong Node version, missing prebuild) shows up at setup time instead
// of as a silently missing plugin after /reload.
//
//   native-deps.mjs <package-dir> [dependency...]
//
// stdout, tab separated, one line per addon:
//   ok    <dep>
//   fail  <dep>  <kind>  <message>
// kind: libstdcxx | node-abi | no-binary   -> a local rebuild can fix it
//       missing | crash | other            -> diagnosis only
// exit 1 when any addon fails to load.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [pkgArg, ...only] = process.argv.slice(2);
if (!pkgArg) {
  console.error('usage: native-deps.mjs <package-dir> [dependency...]');
  process.exit(2);
}
const pkgDir = path.resolve(pkgArg);
const manifest = path.join(pkgDir, 'package.json');
const deps = Object.keys(JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies ?? {});

function findPackageDir(dep) {
  for (let dir = pkgDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}

function looksNative(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return ['binding.gyp', 'prebuilds', 'build/Release'].some((p) => fs.existsSync(path.join(dir, p)))
    || pkg.gypfile === true
    || /node-gyp|prebuild/.test(pkg.scripts?.install ?? '');
}

function classify({ code, message }) {
  if (/GLIBCXX_|CXXABI_|GLIBC_[\d.]+['`]? not found/.test(message)) return 'libstdcxx';
  if (/NODE_MODULE_VERSION|did not self-register/.test(message)) return 'node-abi';
  if (code === 'MODULE_NOT_FOUND' && !/\.node\b/.test(message)) return 'missing';
  if (code === 'ERR_DLOPEN_FAILED' || /No native build was found|\.node\b|ELF|mach-o|file too short/i.test(message)) return 'no-binary';
  return 'other';
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 400);
const loader = `
  const { createRequire } = require('node:module');
  try { createRequire(process.argv[1])(process.argv[2]); }
  catch (e) { process.stdout.write(JSON.stringify({ code: e.code, message: String(e.message) })); process.exit(1); }
`;

let failed = 0;
for (const dep of deps) {
  if (only.length && !only.includes(dep)) continue;
  const dir = findPackageDir(dep);
  if (!dir) {
    // Not installed yet: setup.sh installs missing dependencies before this check.
    if (only.includes(dep)) { console.log(`fail\t${dep}\tmissing\tnot installed`); failed += 1; }
    continue;
  }
  if (!looksNative(dir)) continue;
  const r = spawnSync(process.execPath, ['-e', loader, manifest, dep], { encoding: 'utf8', timeout: 30000 });
  if (r.status === 0) {
    console.log(`ok\t${dep}`);
    continue;
  }
  failed += 1;
  if (r.status === null) {
    console.log(`fail\t${dep}\tcrash\t${oneLine(`terminated by ${r.signal ?? 'timeout'} while loading`)}`);
    continue;
  }
  let error;
  try { error = JSON.parse(r.stdout); } catch { error = { message: r.stderr || r.stdout || 'unknown error' }; }
  console.log(`fail\t${dep}\t${classify(error)}\t${oneLine(error.message)}`);
}
process.exit(failed ? 1 : 0);
