import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePermissionModesConfig,
  resolvePermissionModesConfigPath,
} from "./config-path.ts";

describe("permission modes config path", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it("uses the user extension directory by default", () => {
    expect(resolvePermissionModesConfigPath("C:\\home\\test\\.pi\\agent", {})).toBe(
      "C:\\home\\test\\.pi\\agent\\extensions\\picc-permission-modes\\config.json",
    );
  });

  it("honors the explicit config-path override", () => {
    expect(
      resolvePermissionModesConfigPath("/home/test/.pi/agent", {
        PICC_PERMISSION_MODES_CONFIG_PATH: "/tmp/picc-config.json",
      }),
    ).toBe("/tmp/picc-config.json");
  });

  it("creates a default config without replacing an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "picc-perm-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "extensions", "picc-permission-modes", "config.json");

    expect(ensurePermissionModesConfig(configPath)).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
      autoMode: { provider: { apiKey: "${ANTHROPIC_AUTH_TOKEN}" } },
      permissions: { allow: [], deny: [], ask: [] },
    });

    const existing = '{"permissions":{"allow":["Read"]}}\n';
    writeFileSync(configPath, existing, "utf-8");
    ensurePermissionModesConfig(configPath);
    expect(readFileSync(configPath, "utf-8")).toBe(existing);
  });
});
