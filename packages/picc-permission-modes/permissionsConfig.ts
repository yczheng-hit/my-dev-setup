import { existsSync, readFileSync } from "node:fs";
import { resolvePermissionModesConfigPath } from "./config-path.ts";
export interface UserPermissions {
  allow: string[];
  deny: string[];
  ask: string[];
  source: "local-config" | "none";
}
const EMPTY: UserPermissions = {
  allow: [],
  deny: [],
  ask: [],
  source: "none",
};
function resolveLocalConfigPath(): string {
  return resolvePermissionModesConfigPath();
}
/** Strip `//` and `/* * /` JSON comments (matches the upstream loader's
 *  behavior so the autoMode block can live next to flat-permission rules
 *  with comments in the same file). */
function stripJsonComments(input: string): string {
  let output = "";
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1] ?? "";
    if (char === "/" && next === "/") {
      const newline = input.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = input.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const seg = consumeString(input, i, char);
      output += seg.output;
      i = seg.nextIndex;
      continue;
    }
    output += char;
    i++;
  }
  return output;
}
interface ScanSegment {
  output: string;
  nextIndex: number;
}
function consumeString(input: string, start: number, quote: string): ScanSegment {
  let out = quote;
  let i = start + 1;
  let escaped = false;
  while (i < input.length) {
    const c = input[i];
    out += c;
    i++;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === quote) break;
  }
  return { output: out, nextIndex: i };
}
export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry);
    }
  }
  return out;
}
export function parsePermissionsBlock(block: unknown): {
  allow: string[];
  deny: string[];
  ask: string[];
} {
  if (!block || typeof block !== "object") {
    return { allow: [], deny: [], ask: [] };
  }
  const r = block as Record<string, unknown>;
  return {
    allow: readStringArray(r.allow),
    deny: readStringArray(r.deny),
    ask: readStringArray(r.ask),
  };
}
export function hasAnyRules(perms: {
  allow: string[];
  deny: string[];
  ask: string[];
}): boolean {
  return perms.allow.length > 0 || perms.deny.length > 0 || perms.ask.length > 0;
}
export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}
/** Deep-equal-ish comparison for a parsed permissions block. Compares the
 *  three rule arrays by content (order-insensitive). Returns true when the
 *  two blocks describe the same allow/deny/ask sets. */
export function permissionsBlockEqual(
  a: { allow: string[]; deny: string[]; ask: string[] },
  b: { allow: string[]; deny: string[]; ask: string[] },
): boolean {
  const norm = (xs: string[]) => [...xs].sort();
  return (
    JSON.stringify(norm(a.allow)) === JSON.stringify(norm(b.allow)) &&
    JSON.stringify(norm(a.deny)) === JSON.stringify(norm(b.deny)) &&
    JSON.stringify(norm(a.ask)) === JSON.stringify(norm(b.ask))
  );
}
export function loadUserPermissions(): UserPermissions {
  const localPath = resolveLocalConfigPath();
  const localRaw = readJsonFile(localPath);
  if (localRaw && typeof localRaw === "object") {
    const localPerms = parsePermissionsBlock(
      (localRaw as Record<string, unknown>).permissions,
    );
    if (hasAnyRules(localPerms)) {
      return { ...localPerms, source: "local-config" };
    }
  }
  return EMPTY;
}