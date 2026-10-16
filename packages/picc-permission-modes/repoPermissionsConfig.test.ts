import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRepoPermissions,
  addRepoPermissionRule,
} from "./repoPermissionsConfig.ts";
let tempDir: string;
let cwd: string;
let repoPath: string;
let claudeLocalPath: string;
let claudeProjectPath: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-perm-repo-"));
  cwd = tempDir;
  repoPath = join(tempDir, ".pi", "permissions.json");
  claudeLocalPath = join(tempDir, ".claude", "settings.local.json");
  claudeProjectPath = join(tempDir, ".claude", "settings.json");
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}
function readPerms(path: string): { allow: string[]; deny: string[]; ask: string[] } {
  return JSON.parse(readFileSync(path, "utf-8")).permissions;
}
describe("loadRepoPermissions", () => {
  describe("empty / missing files", () => {
    it("returns {source:'none'} when no files exist", () => {
      const result = loadRepoPermissions(cwd);
      expect(result).toEqual({ allow: [], deny: [], ask: [], source: "none" });
    });
    it("returns {source:'none'} when all files exist but have empty permissions", () => {
      writeJson(repoPath, { permissions: { allow: [], deny: [], ask: [] } });
      writeJson(claudeLocalPath, { permissions: { allow: [] } });
      writeJson(claudeProjectPath, { permissions: { deny: [] } });
      expect(loadRepoPermissions(cwd).source).toBe("none");
    });
  });
  describe("repo file precedence", () => {
    it("uses the repo file as-is when it has any rule", () => {
      writeJson(repoPath, { permissions: { allow: ["Bash(npm *)"] } });
      writeJson(claudeLocalPath, { permissions: { allow: ["Bash(git *)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("local-config");
      expect(result.allow).toEqual(["Bash(npm *)"]);
      expect(result.allow).not.toContain("Bash(git *)");
    });
    it("a single deny rule counts as non-empty (repo file wins)", () => {
      writeJson(repoPath, { permissions: { deny: ["Bash(rm *)"] } });
      writeJson(claudeProjectPath, { permissions: { allow: ["Read"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("local-config");
      expect(result.deny).toEqual(["Bash(rm *)"]);
      expect(result.allow).toEqual([]);
    });
  });
  describe("auto-import from claude repo settings", () => {
    it("imports from settings.local.json when the repo file is absent", () => {
      writeJson(claudeLocalPath, { permissions: { allow: ["Bash(git *)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["Bash(git *)"]);
      expect(existsSync(repoPath)).toBe(true);
      expect(readPerms(repoPath).allow).toContain("Bash(git *)");
    });
    it("imports from settings.json when the repo file is absent", () => {
      writeJson(claudeProjectPath, { permissions: { allow: ["Read"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["Read"]);
    });
    it("merges both claude files, deduping across them", () => {
      writeJson(claudeLocalPath, { permissions: { allow: ["Bash(git *)", "Read"] } });
      writeJson(claudeProjectPath, { permissions: { allow: ["Read", "Bash(go)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("claude-settings");
      expect(result.allow.filter((r) => r === "Read")).toHaveLength(1);
      expect(result.allow).toContain("Bash(git *)");
      expect(result.allow).toContain("Bash(go)");
      expect(result.allow).toHaveLength(3);
    });
    it("merges across behaviors (allow from one, deny from the other)", () => {
      writeJson(claudeLocalPath, { permissions: { allow: ["Read"] } });
      writeJson(claudeProjectPath, { permissions: { deny: ["Bash(rm *)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.allow).toEqual(["Read"]);
      expect(result.deny).toEqual(["Bash(rm *)"]);
    });
    it("does NOT overwrite a repo file that already has rules", () => {
      writeJson(repoPath, { permissions: { allow: ["Bash(npm *)"] } });
      writeJson(claudeLocalPath, { permissions: { allow: ["Bash(git *)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("local-config");
      expect(readPerms(repoPath).allow).toEqual(["Bash(npm *)"]);
    });
    it("is idempotent when the repo file already matches the import", () => {
      writeJson(repoPath, { permissions: { allow: ["Bash(git *)", "Read"] } });
      writeJson(claudeLocalPath, { permissions: { allow: ["Read", "Bash(git *)"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("local-config");
      expect(result.allow.sort()).toEqual(["Bash(git *)", "Read"]);
    });
  });
  describe("tolerance", () => {
    it("drops non-string entries in claude rules", () => {
      writeJson(claudeLocalPath, {
        permissions: { allow: ["Read", 42, null, "Bash(go)"] },
      });
      const result = loadRepoPermissions(cwd);
      expect(result.allow).toEqual(["Read", "Bash(go)"]);
    });
    it("treats malformed JSON in a claude file as empty", () => {
      mkdirSync(dirname(claudeLocalPath), { recursive: true });
      writeFileSync(claudeLocalPath, "{ not valid json", "utf-8");
      writeJson(claudeProjectPath, { permissions: { allow: ["Read"] } });
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["Read"]);
    });
    it("tolerates JSON comments in the repo file", () => {
      mkdirSync(dirname(repoPath), { recursive: true });
      writeFileSync(
        repoPath,
        `{
          // leading comment
          "permissions": {
            "allow": ["Read"],
            "deny": [],
            "ask": []
          }
        }`,
        "utf-8",
      );
      const result = loadRepoPermissions(cwd);
      expect(result.source).toBe("local-config");
      expect(result.allow).toEqual(["Read"]);
    });
  });
});
describe("addRepoPermissionRule", () => {
  it("creates the file and dirs and appends a new rule", () => {
    addRepoPermissionRule(cwd, "allow", "Bash(git *)");
    expect(existsSync(repoPath)).toBe(true);
    expect(readPerms(repoPath).allow).toEqual(["Bash(git *)"]);
  });
  it("dedupes an already-present rule (no duplicate write)", () => {
    addRepoPermissionRule(cwd, "allow", "Bash(git *)");
    addRepoPermissionRule(cwd, "allow", "Bash(git *)");
    expect(readPerms(repoPath).allow).toEqual(["Bash(git *)"]);
  });
  it("appends to an existing permissions block preserving other behaviors", () => {
    writeJson(repoPath, {
      permissions: { allow: ["Read"], deny: ["Bash(rm *)"], ask: [] },
    });
    addRepoPermissionRule(cwd, "allow", "Bash(npm *)");
    const perms = readPerms(repoPath);
    expect(perms.allow).toEqual(["Read", "Bash(npm *)"]);
    expect(perms.deny).toEqual(["Bash(rm *)"]);
  });
  it("normalizes the rule via parse→serialize roundtrip", () => {
    addRepoPermissionRule(cwd, "allow", "Read");
    expect(readPerms(repoPath).allow).toEqual(["Read"]);
  });
  it("preserves other top-level keys in the repo file", () => {
    writeJson(repoPath, {
      permissions: { allow: [] },
      otherKey: { nested: true },
    });
    addRepoPermissionRule(cwd, "allow", "Bash(git *)");
    const parsed = JSON.parse(readFileSync(repoPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.permissions).toEqual({
      allow: ["Bash(git *)"],
      deny: [],
      ask: [],
    });
    expect(parsed.otherKey).toEqual({ nested: true });
  });
});
