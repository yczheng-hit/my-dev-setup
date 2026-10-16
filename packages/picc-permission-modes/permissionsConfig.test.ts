import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUserPermissions } from "./permissionsConfig.ts";
let tempDir: string;
let localConfigPath: string;
let claudeSettingsPath: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-perm-cfg-"));
  localConfigPath = join(tempDir, "config.json");
  claudeSettingsPath = join(tempDir, "settings.json");
  process.env.PICC_PERMISSION_MODES_CONFIG_PATH = localConfigPath;
  process.env.CLAUDE_CONFIG_DIR = tempDir;
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
  delete process.env.CLAUDE_CONFIG_DIR;
});
describe("loadUserPermissions", () => {
  describe("empty / missing files", () => {
    it("returns source=none when neither file exists", () => {
      const result = loadUserPermissions();
      expect(result.source).toBe("none");
      expect(result.allow).toEqual([]);
      expect(result.deny).toEqual([]);
      expect(result.ask).toEqual([]);
    });
    it("returns source=none when local config exists but has no permissions block", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({ autoMode: { allow: ["test"] } }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("none");
    });
    it("returns source=none when local config has empty permissions arrays", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("none");
    });
    it("tolerates JSON comments in the local config (matches auto-mode loader)", () => {
      writeFileSync(
        localConfigPath,
        `{
          "permissions": { "allow": ["Read"] }
        }`,
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("local-config");
      expect(result.allow).toEqual(["Read"]);
    });
  });
  describe("local config takes precedence over claude settings", () => {
    it("uses local config when it has any rules (no merge with claude settings)", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: {
            allow: ["Read"],
            deny: [],
            ask: [],
          },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["WebFetch", "Bash(go)"],
            deny: ["Bash(rm *)"],
            ask: [],
          },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("local-config");
      expect(result.allow).toEqual(["Read"]);
      expect(result.deny).toEqual([]);
      expect(result.allow).not.toContain("Bash(go)");
    });
    it("uses local config deny rules even when claude settings only has allow", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: {
            allow: [],
            deny: ["Bash(rm *)"],
            ask: [],
          },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["WebFetch"],
            deny: [],
            ask: [],
          },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("local-config");
      expect(result.deny).toEqual(["Bash(rm *)"]);
      expect(result.allow).toEqual([]);
    });
  });
  describe("claude settings fallback", () => {
    it("falls back to claude settings when local config has empty permissions", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["WebFetch", "Read", "Bash(go)"],
            deny: ["Bash(rm *)"],
            ask: [],
          },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["WebFetch", "Read", "Bash(go)"]);
      expect(result.deny).toEqual(["Bash(rm *)"]);
    });
    it("falls back to claude settings when local config doesn't exist", () => {
      expect(existsSync(localConfigPath)).toBe(false);
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"] },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["Read"]);
    });
    it("ignores non-string entries in allow/deny/ask arrays", () => {
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["Read", null, 42, "", "Bash(go)"],
            deny: [true, "Bash(rm *)"],
            ask: ["Read(//etc/**)"],
          },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("claude-settings");
      expect(result.allow).toEqual(["Read", "Bash(go)"]);
      expect(result.deny).toEqual(["Bash(rm *)"]);
      expect(result.ask).toEqual(["Read(//etc/**)"]);
    });
    it("handles malformed JSON gracefully (returns source=none)", () => {
      writeFileSync(localConfigPath, "{ not json", "utf-8");
      writeFileSync(claudeSettingsPath, "{ also not json", "utf-8");
      const result = loadUserPermissions();
      expect(result.source).toBe("none");
    });
  });
  describe("partial rules (only one of allow/deny/ask populated)", () => {
    it("treats a single populated array as a non-empty permissions block", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("local-config");
      expect(result.allow).toEqual(["Read"]);
    });
    it("uses claude settings when only deny is populated", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: [], deny: ["Bash(rm *)"], ask: [] },
        }),
        "utf-8",
      );
      const result = loadUserPermissions();
      expect(result.source).toBe("claude-settings");
      expect(result.deny).toEqual(["Bash(rm *)"]);
      expect(result.allow).toEqual([]);
    });
  });
  describe("persistence to local config.json", () => {
    it("writes the parsed claude-settings rules back when local config has no permissions block", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({ autoMode: { allow: ["x"] } }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["Read", "WebFetch"],
            deny: ["Bash(rm *)"],
            ask: [],
          },
        }),
        "utf-8",
      );
      loadUserPermissions();
      const written = JSON.parse(readFileSync(localConfigPath, "utf-8"));
      expect(written.permissions).toEqual({
        allow: ["Read", "WebFetch"],
        deny: ["Bash(rm *)"],
        ask: [],
      });
      expect(written.autoMode).toEqual({ allow: ["x"] });
    });
    it("writes when local config has empty permissions arrays", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
          autoMode: { allow: ["x"] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      loadUserPermissions();
      const written = JSON.parse(readFileSync(localConfigPath, "utf-8"));
      expect(written.permissions.allow).toEqual(["Read"]);
      expect(written.autoMode).toEqual({ allow: ["x"] });
    });
    it("is idempotent — does NOT rewrite when local config already matches claude settings", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      const before = readFileSync(localConfigPath, "utf-8");
      loadUserPermissions();
      const after = readFileSync(localConfigPath, "utf-8");
      expect(after).toBe(before);
    });
    it("rewrites when local config differs from claude settings (e.g. user manually edited it to be empty/stale)", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: {
            allow: ["Read", "Bash(go)"],
            deny: ["Bash(rm *)"],
            ask: [],
          },
        }),
        "utf-8",
      );
      loadUserPermissions();
      const written = JSON.parse(readFileSync(localConfigPath, "utf-8"));
      expect(written.permissions.allow).toEqual(["Read", "Bash(go)"]);
      expect(written.permissions.deny).toEqual(["Bash(rm *)"]);
    });
    it("does NOT write when local config has populated permissions (no fallback fires)", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: {
            allow: ["Bash(only-local-rule)"],
            deny: [],
            ask: [],
          },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      const before = readFileSync(localConfigPath, "utf-8");
      const result = loadUserPermissions();
      expect(result.source).toBe("local-config");
      const after = readFileSync(localConfigPath, "utf-8");
      expect(after).toBe(before);
    });
    it("creates the local config file if it doesn't exist", () => {
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      loadUserPermissions();
      expect(existsSync(localConfigPath)).toBe(true);
      const written = JSON.parse(readFileSync(localConfigPath, "utf-8"));
      expect(written.permissions.allow).toEqual(["Read"]);
    });
    it("treats order-insensitive matches as equal (idempotent under reordering)", () => {
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          permissions: { allow: ["Bash(a)", "Bash(b)"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify({
          permissions: { allow: ["Bash(b)", "Bash(a)"], deny: [], ask: [] },
        }),
        "utf-8",
      );
      const before = readFileSync(localConfigPath, "utf-8");
      loadUserPermissions();
      const after = readFileSync(localConfigPath, "utf-8");
      expect(after).toBe(before);
    });
  });
});