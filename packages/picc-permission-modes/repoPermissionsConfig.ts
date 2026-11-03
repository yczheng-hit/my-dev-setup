import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hasAnyRules,
  parsePermissionsBlock,
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
  source: "local-config" | "none";
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
  return EMPTY;
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
