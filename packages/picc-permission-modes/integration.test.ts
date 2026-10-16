import { describe, it, expect } from "vitest";
import { buildContext } from "./permissionContext.ts";
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
} from "./permissionContext.ts";
import { extractFirstBashPath, extractBashPaths } from "./pathExtractors.ts";
import { isReadOnlyCommand } from "./utils.ts";
describe("Bug 1: find | xargs grep | head in bypass mode", () => {
  it("is classified as read-only (was triggering edit prompt)", () => {
    const cmd = `find "C:/Users/UserName/AppData/Roaming/npm/node_modules/@earendil-works/" -name "*.js" >2/dev/null | xargs grep -l "abort" 2>/dev/null | head -5`;
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it("find itself extracts paths correctly (for non-bypass modes)", () => {
    const cmd = `find "C:/Users/UserName/.pi/agent" -name "*.ts"`;
    const paths = extractBashPaths(cmd);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toContain("C:/Users/UserName/.pi/agent");
  });
});
describe("Bug 2: cd && npx tsc 2>&1 | head in bypass mode", () => {
  it("does NOT extract cd's argument as a write target", () => {
    const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit extensions/pi-tasks.ts 2>&1 | head -40`;
    const path = extractFirstBashPath(cmd);
    expect(path).toBe("");
  });
  it("npx (non-path-bearing) returns no paths", () => {
    expect(extractFirstBashPath(`npx --yes tsc --noEmit file.ts`)).toBe("");
    expect(extractBashPaths(`npx --yes tsc --noEmit file.ts`)).toEqual([]);
  });
  it("rm still extracts the write target", () => {
    expect(extractFirstBashPath(`rm /etc/passwd`)).toBe("/etc/passwd");
    expect(extractFirstBashPath(`rm build/ -rf`)).toBe("build/");
  });
  it("mkdir still extracts the write target", () => {
    expect(extractFirstBashPath(`mkdir -p /tmp/foo`)).toBe("/tmp/foo");
  });
  it("the actual user command's path is no longer routed through write gate", () => {
    const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit extensions/pi-tasks.ts 2>&1 | head -40`;
    const path = extractFirstBashPath(cmd);
    expect(path).toBe("");
  });
});
describe("Bug 1+2: combined behavior", () => {
  it("the full buggy command from screenshot 1 (find | xargs | head) is read-only", () => {
    const cmd = `find "C:/Users/UserName/AppData/Roaming/npm/node_modules/@earendil-works/" -name "*.js" >2/dev/null | xargs grep -l "abort" 2>/dev/null | head -5`;
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it("the full buggy command from screenshot 2 (cd && npx 2>&1 | head) is not routed through write gate", () => {
    const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck extensions/pi-tasks.ts 2>&1 | head -40`;
    expect(isReadOnlyCommand(cmd)).toBe(false);
    expect(extractFirstBashPath(cmd)).toBe("");
  });
});
describe("Dangerous path safety check still works", () => {
  it("rm /etc/passwd is dangerous (still flagged)", () => {
    const ctx = buildContext("default");
    const decision = checkWritePermissionForTool(
      "bash",
      "/etc/passwd",
      ctx,
    );
    expect(decision.behavior).toBe("ask");
  });
  it("edit .bashrc is dangerous (still flagged)", () => {
    const ctx = buildContext("default");
    const decision = checkWritePermissionForTool("bash", "/home/user/.bashrc", ctx);
    expect(decision.behavior).toBe("ask");
  });
});