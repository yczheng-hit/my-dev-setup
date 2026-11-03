import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUserPermissions } from "./permissionsConfig.ts";
const dirs: string[] = [];
const saved = { config: process.env.PICC_PERMISSION_MODES_CONFIG_PATH, claude: process.env.CLAUDE_CONFIG_DIR };
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  for (const [key, value] of [["PICC_PERMISSION_MODES_CONFIG_PATH", saved.config], ["CLAUDE_CONFIG_DIR", saved.claude]]) value === undefined ? delete process.env[key!] : process.env[key!] = value;
});
function fixture(local?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-perms-")); dirs.push(dir);
  process.env.PICC_PERMISSION_MODES_CONFIG_PATH = join(dir, "config.json");
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(CLAUDE_SENTINEL:*)"], deny: ["Read"], ask: ["Write"] } }));
  if (local !== undefined) writeFileSync(process.env.PICC_PERMISSION_MODES_CONFIG_PATH, local);
  return process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
}
describe("user permissions: native config only", () => {
  it.each([undefined, "{}", '{"permissions":{"allow":[],"deny":[],"ask":[]}}', "{broken"])("does not import or persist Claude settings for %s", (local) => {
    const path = fixture(local);
    expect(loadUserPermissions()).toEqual({ source: "none", allow: [], deny: [], ask: [] });
    expect(existsSync(path)).toBe(local !== undefined);
    if (local !== undefined) expect(readFileSync(path, "utf8")).toBe(local);
  });
  it("reads allow/deny/ask, ignores nonstrings, preserves native bytes", () => {
    const text = '{ // comment\n"permissions":{"allow":["Read",null,42,""],"deny":["Bash(rm:*)"],"ask":["Write"]},"other":1}';
    const path = fixture(text);
    expect(loadUserPermissions()).toEqual({ source: "local-config", allow: ["Read"], deny: ["Bash(rm:*)"], ask: ["Write"] });
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
