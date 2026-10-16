import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hasAnyRules,
  parsePermissionsBlock,
  permissionsBlockEqual,
  readJsonFile,
} from "./permissionsConfig.ts";
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from "./permissionContext.ts";
import type { PermissionBehavior } from "./types.ts";
export interface RepoPermissions {
  allow: string[];
  deny: string[];
  ask: string[];
  source: "local-config" | "claude-settings" | "none";
}
const EMPTY: RepoPermissions = {
  allow: [],
  deny: [],
  ask: [],
  source: "none",
};
export function resolveRepoPermissionsPath(cwd: string): string {
  return join(cwd, ".pi", "permissions.json");
}
export function resolveClaudeLocalSettingsPath(cwd: string): string {
  return join(cwd, ".claude", "settings.local.json");
}
export function resolveClaudeProjectSettingsPath(cwd: string): string {
  return join(cwd, ".claude", "settings.json");
}
function mergeUnique(
  a: { allow: string[]; deny: string[]; ask: string[] },
  b: { allow: string[]; deny: string[]; ask: string[] },
): { allow: string[]; deny: string[]; ask: string[] } {
  const union = (x: string[], y: string[]) => {
    const seen = new Set(x);
    const out = [...x];
    for (const v of y) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  };
  return {
    allow: union(a.allow, b.allow),
    deny: union(a.deny, b.deny),
    ask: union(a.ask, b.ask),
  };
}
function permsAt(path: string): {
  allow: string[];
  deny: string[];
  ask: string[];
} {
  const raw = readJsonFile(path);
  if (!raw || typeof raw !== "object") {
    return { allow: [], deny: [], ask: [] };
  }
  return parsePermissionsBlock((raw as Record<string, unknown>).permissions);
}
export function loadRepoPermissions(cwd: string): RepoPermissions {
  const repoPath = resolveRepoPermissionsPath(cwd);
  const repoPerms = permsAt(repoPath);
  if (hasAnyRules(repoPerms)) {
    return { ...repoPerms, source: "local-config" };
  }
  const localPerms = permsAt(resolveClaudeLocalSettingsPath(cwd));
  const projectPerms = permsAt(resolveClaudeProjectSettingsPath(cwd));
  const merged = mergeUnique(localPerms, projectPerms);
  if (hasAnyRules(merged)) {
    if (!permissionsBlockEqual(repoPerms, merged)) {
      persistRepoPermissions(repoPath, merged);
    }
    return { ...merged, source: "claude-settings" };
  }
  return EMPTY;
}
function persistRepoPermissions(
  repoPath: string,
  perms: { allow: string[]; deny: string[]; ask: string[] },
): boolean {
  try {
    const existing = readJsonFile(repoPath);
    const base: Record<string, unknown> =
      existing && typeof existing === "object"
        ? { ...(existing as Record<string, unknown>) }
        : {};
    base.permissions = {
      allow: [...perms.allow],
      deny: [...perms.deny],
      ask: [...perms.ask],
    };
    mkdirSync(dirname(repoPath), { recursive: true });
    writeFileSync(repoPath, JSON.stringify(base, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
export function addRepoPermissionRule(
  cwd: string,
  behavior: PermissionBehavior,
  ruleRaw: string,
): boolean {
  const rule = permissionRuleValueToString(
    permissionRuleValueFromString(ruleRaw),
  );
  const repoPath = resolveRepoPermissionsPath(cwd);
  try {
    const existing = readJsonFile(repoPath);
    const base: Record<string, unknown> =
      existing && typeof existing === "object"
        ? { ...(existing as Record<string, unknown>) }
        : {};
    const perms = parsePermissionsBlock(base.permissions);
    const existingSet = new Set(
      perms[behavior].map((r) =>
        permissionRuleValueToString(permissionRuleValueFromString(r)),
      ),
    );
    if (!existingSet.has(rule)) {
      perms[behavior] = [...perms[behavior], rule];
    } else {
      return true;
    }
    base.permissions = {
      allow: perms.allow,
      deny: perms.deny,
      ask: perms.ask,
    };
    mkdirSync(dirname(repoPath), { recursive: true });
    writeFileSync(repoPath, JSON.stringify(base, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
