#!/usr/bin/env node
// Rebuild ONE native dependency of a package from source against the running Node, using a
// toolchain probed from this machine. Used when the prebuilt binary cannot load (for example
// tree-sitter's prebuild needs a newer libstdc++ than the system has). Install scripts stay off
// for everything else; only the named addon is compiled, inside its own node_modules directory.
//
//   rebuild-native.mjs [--dry-run] <package-dir> <dependency>
//
// Linux: prefers the newest g++ >= 10 (PATH gcc-N/g++-N, gcc-toolset, devtoolset, or CC/CXX) and
// links libstdc++/libgcc statically so the result does not depend on the old system runtime.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args[0] === '--dry-run' ? (args.shift(), true) : false;
const [pkgArg, dep] = args;
if (!pkgArg || !dep) {
  console.error('usage: rebuild-native.mjs [--dry-run] <package-dir> <dependency>');
  process.exit(2);
}

const fail = (message) => { console.error(`rebuild-native: ${message}`); process.exit(1); };
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
const isExecutable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
const which = (cmd) => {
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : undefined;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return undefined;
};

const pkgDir = path.resolve(pkgArg);
function findUp(rel) {
  for (let dir = pkgDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}
const depDir = findUp(path.join('node_modules', dep));
if (!depDir || !fs.existsSync(path.join(depDir, 'binding.gyp'))) {
  fail(`${dep} has no binding.gyp under ${pkgDir}/node_modules, so it cannot be built from source`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const isLinux = process.platform === 'linux';

// ---- node-gyp
function findNodeGyp() {
  const execPrefix = path.resolve(path.dirname(process.execPath), '..');
  const npmRoot = run(which('npm') ?? 'npm', ['root', '-g']).stdout?.trim();
  const candidates = [
    process.env.npm_config_node_gyp,
    path.join(execPrefix, 'lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'),
    npmRoot && path.join(npmRoot, 'npm/node_modules/node-gyp/bin/node-gyp.js'),
    npmRoot && path.join(npmRoot, 'node-gyp/bin/node-gyp.js'),
    findUp('node_modules/node-gyp/bin/node-gyp.js'),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}
const nodeGyp = findNodeGyp();
if (!nodeGyp) fail('node-gyp not found (it ships with npm; or install it: npm install -g node-gyp)');
const gypMajor = (() => {
  try { return Number(JSON.parse(fs.readFileSync(path.join(path.dirname(nodeGyp), '../package.json'), 'utf8')).version.split('.')[0]); }
  catch { return 0; }
})();

// ---- python (node-gyp's bundled gyp needs >= 3.8; node-gyp < 10 cannot run on >= 3.12)
function findPython() {
  const names = [process.env.PYTHON, process.env.npm_config_python,
    ...['3.13', '3.12', '3.11', '3.10', '3.9', '3.8'].map((v) => `python${v}`), 'python3', 'python'];
  for (const name of names) {
    const bin = name && which(name);
    if (!bin) continue;
    const r = run(bin, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (r.status !== 0) continue;
    const [major, minor] = r.stdout.trim().split('.').map(Number);
    if (major === 3 && minor >= 8 && (minor < 12 || gypMajor >= 10)) return { bin, version: r.stdout.trim() };
  }
  return undefined;
}
const python = findPython();
if (!python) fail('no usable Python found (need 3.8+; node-gyp reports a SyntaxError on older ones). Install python3.11 or set PYTHON=/path/to/python3');

// ---- C/C++ compiler
const gccMajor = (bin) => {
  const r = run(bin, ['-dumpfullversion', '-dumpversion']);
  return r.status === 0 ? parseInt(r.stdout, 10) || 0 : 0;
};
function findCompiler() {
  if (!isLinux) return { note: 'default toolchain' };
  if (process.env.CC && process.env.CXX) {
    const cc = which(process.env.CC);
    const cxx = which(process.env.CXX);
    if (!cc || !cxx) fail(`CC/CXX are set but not executable: ${process.env.CC} ${process.env.CXX}`);
    return { cc, cxx, major: gccMajor(cxx), note: 'from CC/CXX' };
  }
  const pairs = [];
  for (let n = 20; n >= 7; n -= 1) {
    pairs.push([which(`gcc-${n}`), which(`g++-${n}`)]);
    for (const root of [`/opt/rh/gcc-toolset-${n}/root/usr/bin`, `/opt/rh/devtoolset-${n}/root/usr/bin`]) {
      pairs.push([which(path.join(root, 'gcc')), which(path.join(root, 'g++'))]);
    }
  }
  pairs.push([which('gcc'), which('g++')]);
  const found = pairs.filter(([cc, cxx]) => cc && cxx)
    .map(([cc, cxx]) => ({ cc, cxx, major: gccMajor(cxx) }))
    .sort((a, b) => b.major - a.major)[0];
  return found ? { ...found, note: 'newest g++ found' } : {};
}
const compiler = findCompiler();
// Node >= 22 headers and tree-sitter 0.25 build as C++20; older Node needs C++17.
const minGcc = nodeMajor >= 22 ? 10 : 7;
if (isLinux && (!compiler.cxx || compiler.major < minGcc)) {
  fail(`no g++ >= ${minGcc} found (best: ${compiler.cxx ? `${compiler.cxx} ${compiler.major}` : 'none'}). `
    + 'Install gcc-12 / gcc-toolset-12, or point CC and CXX at a newer compiler.');
}

// ---- Node headers: the install that is running us; node-gyp downloads them (needs network) otherwise
const execPrefix = path.resolve(path.dirname(process.execPath), '..');
const nodedir = fs.existsSync(path.join(execPrefix, 'include/node/node.h')) ? execPrefix : undefined;

const env = { ...process.env };
if (compiler.cc) { env.CC = compiler.cc; env.CXX = compiler.cxx; }
if (isLinux) env.LDFLAGS = `${process.env.LDFLAGS ?? ''} -static-libstdc++ -static-libgcc`.trim();
const gypArgs = [nodeGyp, 'rebuild', `--python=${python.bin}`, ...(nodedir ? [`--nodedir=${nodedir}`] : []),
  '--napi_build_version=8', `--jobs=${Math.max(1, Math.min(4, os.cpus().length))}`];

const rel = (file) => file.replace(`${os.homedir()}/`, '~/');
console.log(`rebuilding ${dep} from source in ${rel(depDir)}`);
console.log(`  node-gyp ${gypMajor || '?'}  python ${python.version} (${rel(python.bin)})`);
console.log(isLinux ? `  g++ ${compiler.major} (${rel(compiler.cxx)}, ${compiler.note}), static libstdc++/libgcc` : `  ${compiler.note}`);
console.log(`  node headers: ${nodedir ? `${rel(nodedir)}/include/node` : 'not found locally, node-gyp will download them'}`);
if (dryRun) {
  console.log(`  [dry-run] cd ${rel(depDir)} && ${isLinux ? `CC=${compiler.cxx ? compiler.cc : ''} CXX=${compiler.cxx} LDFLAGS="${env.LDFLAGS}" ` : ''}node ${gypArgs.map(rel).join(' ')}`);
  process.exit(0);
}

const build = run(process.execPath, gypArgs, { cwd: depDir, env, maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
if (build.status !== 0) {
  const tail = `${build.stdout ?? ''}\n${build.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  console.error(tail);
  fail(`node-gyp rebuild of ${dep} failed${build.signal ? ` (${build.signal})` : ''}; see the output above`);
}
console.log(`built ${dep}`);
