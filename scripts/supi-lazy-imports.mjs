#!/usr/bin/env node
// Rewrite @mrclrchtr/supi-code-intelligence/headless.ts so its heavy local modules load lazily.
//
// supi-review imports this file at extension load only to read HEADLESS_INSPECTION_TOOL_NAMES and
// to hand the factory to Reviewer child sessions. Loading the whole LSP/tree-sitter stack eagerly
// costs ~0.5s of every Pi start, so the local imports become dynamic imports inside the factory.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: supi-lazy-imports.mjs <headless.ts>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.log("skip\tno headless.ts");
  process.exit(0);
}

const source = fs.readFileSync(file, "utf8");
const localImport = /^import\s+(?:type\s+)?\{([^}\n]*)\}\s*from\s*["'](\.\/[^"']+)["'];?[ \t]*$/gm;
const modules = [];
for (const match of source.matchAll(localImport)) {
  const names = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 0) modules.push({ names, spec: match[2] });
}

if (modules.length === 0) {
  console.log("unchanged\tno static local imports");
  process.exit(0);
}

const destructure =
  `\tconst [${modules.map((mod) => `{ ${mod.names.join(", ")} }`).join(", ")}] = await Promise.all([\n` +
  modules.map((mod) => `\t\timport("${mod.spec}"),`).join("\n") +
  "\n\t]);\n";

let rewritten = source
  .replace(localImport, "")
  .replace(/^\n+/, "")
  .replace(/\n{3,}/g, "\n\n");

const factory = /export default function (\w+)\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/;
if (!factory.test(rewritten)) {
  console.log("skip\tno default export factory");
  process.exit(0);
}
rewritten = rewritten.replace(
  factory,
  (_all, name, args) => `export default async function ${name}(${args}): Promise<void> {\n${destructure}`,
);

if (rewritten === source) {
  console.log("unchanged\talready lazy");
  process.exit(0);
}
fs.writeFileSync(file, rewritten);
console.log(`patched\t${modules.length} lazy module import(s)`);
