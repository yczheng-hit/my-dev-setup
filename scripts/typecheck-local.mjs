#!/usr/bin/env node
// Strict checks against the installed Pi API, without installing/patching a host dependency.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const root = path.resolve(import.meta.dirname, '..');
const fromHost = createRequire(path.join(host, 'package.json'));
const fromDev = createRequire(path.join(root, 'tools/pi-btw-split/package.json'));
const ts = fromDev('typescript');
const nodeTypes = path.dirname(fromDev.resolve('@types/node/package.json'));
function peer(name) {
  for (const base of fromHost.resolve.paths(name) ?? []) {
    const file = path.join(base, name, 'dist/index.d.ts'); if (fs.existsSync(file)) return file;
  }
  throw new Error(`Missing host peer types: ${name}`);
}
const paths = { '@earendil-works/pi-coding-agent': [path.join(host, 'dist/index.d.ts')] };
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-tui', '@earendil-works/pi-agent-core']) paths[name] = [peer(name)];
paths.typebox = [fromHost.resolve('typebox').replace(/\.mjs$/, '.d.mts')];
const roots = process.argv.slice(2);
if (!roots.length) throw new Error('Pass package extension directories to typecheck');
const files = roots.flatMap((dir) => ts.sys.readDirectory(path.resolve(root, dir), ['.ts'], ['**/node_modules/**'], ['**/*']));
const options = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, esModuleInterop: true,
  types: ['node'], typeRoots: [path.dirname(nodeTypes)], paths };
const program = ts.createProgram(files, options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log(`PASS strict TypeScript ${ts.version}: ${files.length} root files against Pi ${JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version}`);
