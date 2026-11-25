#!/usr/bin/env node
// Rewrite @mrclrchtr/supi-code-intelligence/headless.ts so its heavy local modules load lazily.
//
// supi-review imports this file at extension load only to read HEADLESS_INSPECTION_TOOL_NAMES and
// to hand the factory to Reviewer child sessions. Loading the whole LSP/tree-sitter stack eagerly
// costs ~0.5s of every Pi start, so the local imports become dynamic imports inside the factory.
//
// Two upstream shapes must be patched, and Pi awaits async extension factories either way:
//   A) `export default function headlessInspectionProfile(pi) { ... }`
//   B) `export function createHeadlessInspectionProfile(...): (pi) => void { return (pi) => { ... } }`,
//      where the default export is `createHeadlessInspectionProfile()` evaluated at module load.
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

// Shape A: the default export is the factory itself.
const defaultFactory = /export default function (\w+)\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/;
// Shape B: the builder returns the `(pi) => { ... }` closure that reads the module bindings.
const returnedClosure = /(\breturn\s+)(?:async\s+)?(\(\s*\w+(?::\s*[\w.<>[\]]+)?\s*\))\s*(?::\s*[^{]+)?=>\s*\{/;

if (defaultFactory.test(rewritten)) {
  rewritten = rewritten.replace(
    defaultFactory,
    (_all, name, args) => `export default async function ${name}(${args}): Promise<void> {\n${destructure}`,
  );
} else if (returnedClosure.test(rewritten)) {
  rewritten = rewritten.replace(
    returnedClosure,
    (_all, lead, params) => `${lead}async ${params}: Promise<void> => {\n${destructure}`,
  );
  // The builder's declared return type still says the closure is synchronous; widen it so a
  // type-aware reader (or a future tsc run) does not flag the async factory.
  rewritten = rewritten.replace(
    /\)\s*:\s*\(\s*pi:\s*ExtensionAPI\s*\)\s*=>\s*void\s*\{/,
    "): (pi: ExtensionAPI) => void | Promise<void> {",
  );
  // The default export copies the same annotation.
  rewritten = rewritten.replace(
    /const (\w+): \(pi: ExtensionAPI\) => void = /,
    "const $1: (pi: ExtensionAPI) => void | Promise<void> = ",
  );
} else {
  console.log("skip\tno default export or returned factory closure");
  process.exit(0);
}

if (rewritten === source) {
  console.log("unchanged\talready lazy");
  process.exit(0);
}
fs.writeFileSync(file, rewritten);
console.log(`patched\t${modules.length} lazy module import(s)`);
