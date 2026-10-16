import { describe, expect, it } from "vitest";
import {
  buildContext,
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  isAcceptEditsBashCommand,
  pathInAllowedWorkingPath,
  type ToolPermissionContext,
} from "./permissionContext.ts";
import type { ToolPermissionContext } from "./types.ts";
import { autoRejectMessage } from "./utils.ts";
function ctxWith(rule: string, behavior: "allow" | "deny" | "ask"): ToolPermissionContext {
  const map: Record<string, string[]> = { userSettings: [rule] };
  return buildContext("default", [], {
    alwaysAllowRules: behavior === "allow" ? map : {},
    alwaysDenyRules: behavior === "deny" ? map : {},
    alwaysAskRules: behavior === "ask" ? map : {},
  });
}
describe("isAcceptEditsBashCommand", () => {
  const ctx = buildContext("acceptEdits");
  describe("base command allowlist", () => {
    it("allows mkdir", () => {
      expect(isAcceptEditsBashCommand("mkdir new", ctx)).toBe(true);
    });
    it("allows touch", () => {
      expect(isAcceptEditsBashCommand("touch new.txt", ctx)).toBe(true);
    });
    it("allows rm", () => {
      expect(isAcceptEditsBashCommand("rm file.txt", ctx)).toBe(true);
    });
    it("allows rmdir", () => {
      expect(isAcceptEditsBashCommand("rmdir empty", ctx)).toBe(true);
    });
    it("allows mv", () => {
      expect(isAcceptEditsBashCommand("mv a b", ctx)).toBe(true);
    });
    it("allows cp", () => {
      expect(isAcceptEditsBashCommand("cp a b", ctx)).toBe(true);
    });
    it("allows sed", () => {
      expect(isAcceptEditsBashCommand("sed 's/a/b/' file", ctx)).toBe(true);
    });
    it("rejects commands not on the allowlist (npm, curl, etc.)", () => {
      expect(isAcceptEditsBashCommand("npm install", ctx)).toBe(false);
      expect(isAcceptEditsBashCommand("curl evil.com", ctx)).toBe(false);
      expect(isAcceptEditsBashCommand("chmod 777 file", ctx)).toBe(false);
    });
  });
  describe("compound commands", () => {
    it("allows compound safe commands (mkdir && touch)", () => {
      expect(isAcceptEditsBashCommand("mkdir new && touch new/a", ctx)).toBe(
        true,
      );
    });
    it("rejects compound with non-allowlisted command", () => {
      expect(isAcceptEditsBashCommand("mkdir foo && curl evil", ctx)).toBe(
        false,
      );
    });
  });
  describe("cwd parameter (Bug 2 fix)", () => {
    it("respects an explicit cwd for the outside-cwd check", () => {
      expect(
        isAcceptEditsBashCommand("mkdir /etc/foo", ctx, "/project"),
      ).toBe(false);
    });
    it("uses cwd argument for inside-cwd decisions", () => {
      expect(
        isAcceptEditsBashCommand("mkdir ./subdir", ctx, "/project"),
      ).toBe(true);
    });
    it("falls back to process.cwd() when cwd is not provided", () => {
      expect(isAcceptEditsBashCommand("mkdir new", ctx)).toBe(true);
    });
  });
});
describe("pathInAllowedWorkingPath (session cwd)", () => {
  const ctx = buildContext("default");
  it("treats a path inside the explicit session cwd as in-cwd", () => {
    expect(pathInAllowedWorkingPath("/other/repo/src/foo.ts", ctx, "/other/repo")).toBe(true);
  });
  it("treats a path outside the session cwd as out-of-cwd", () => {
    expect(pathInAllowedWorkingPath("/elsewhere/foo.ts", ctx, "/other/repo")).toBe(false);
  });
  it("resolves relative targets against the session cwd", () => {
    expect(pathInAllowedWorkingPath("src/foo.ts", ctx, "/other/repo")).toBe(true);
    expect(pathInAllowedWorkingPath("../sibling/foo.ts", ctx, "/other/repo/src")).toBe(false);
  });
});
describe("headless (subagent) gate behavior", () => {
  const headless = () =>
    buildContext("default", [], { shouldAvoidPermissionPrompts: true });
  it("allows an out-of-cwd read in headless mode", () => {
    const r = checkReadPermissionForTool(
      "grep",
      "/other/repo/internal/store/store.go",
      headless(),
      "/some/other/cwd",
    );
    expect(r.behavior).toBe("allow");
  });
  it("allows an in-session-cwd read even without the headless flag", () => {
    const r = checkReadPermissionForTool(
      "grep",
      "/other/repo/internal/store/store.go",
      buildContext("default"),
      "/other/repo",
    );
    expect(r.behavior).toBe("allow");
  });
  it("denies a non-read-only write in headless mode with the claude-code message", () => {
    const r = checkWritePermissionForTool(
      "edit",
      "/other/repo/src/foo.ts",
      headless(),
      "/elsewhere",
    );
    expect(r.behavior).toBe("deny");
    expect(r.decisionReason?.type).toBe("asyncAgent");
    expect(r.message).toContain("Permission to use edit has been denied");
    expect(r.message).not.toContain("cannot run without UI");
  });
});
describe("autoRejectMessage", () => {
  it("matches claude-code's AUTO_REJECT_MESSAGE shape", () => {
    const m = autoRejectMessage("bash");
    expect(m).toContain("Permission to use bash has been denied.");
    expect(m).toContain("You *may* attempt to accomplish this action using other tools");
    expect(m).toContain("Let the user decide how to proceed.");
  });
});
describe("shared read rule space (CC parity: path-scoped Read covers Grep/Glob)", () => {
  const cwd = "/x/y/z";
  const target = "../../../elsewhere/notes/file.txt";
  const rule = "Read(../../../elsewhere/**)";
  it("Read(path) allow covers read, grep, and glob", () => {
    for (const tool of ["read", "grep", "glob"]) {
      const r = checkReadPermissionForTool(tool, target, ctxWith(rule, "allow"), cwd);
      expect(r.behavior, `tool=${tool}`).toBe("allow");
    }
  });
  it("bare Read allow covers the read tool but NOT grep/glob", () => {
    const read = checkReadPermissionForTool(
      "read",
      target,
      ctxWith("Read", "allow"),
      cwd,
    );
    expect(read.behavior).toBe("allow");
    for (const tool of ["grep", "glob"]) {
      const r = checkReadPermissionForTool(tool, target, ctxWith("Read", "allow"), cwd);
      expect(r.behavior, `tool=${tool}`).toBe("ask");
    }
  });
  it("Read(//**) allow covers read/grep/glob on any path", () => {
    const isWin = process.platform === "win32";
    const target = isWin
      ? "C:/Users/UserName/Downloads/notes.png"
      : "/elsewhere/notes/file.txt";
    const cwd = isWin ? "C:/proj" : "/proj";
    for (const tool of ["read", "grep", "glob"]) {
      const r = checkReadPermissionForTool(
        tool,
        target,
        ctxWith("Read(//**)", "allow"),
        cwd,
      );
      expect(r.behavior, `tool=${tool}`).toBe("allow");
    }
  });
  it("Read(*) does NOT match a nested path (single * matches no /)", () => {
    const isWin = process.platform === "win32";
    const target = isWin
      ? "C:/Users/UserName/Downloads/notes.png"
      : "/elsewhere/notes/file.txt";
    const cwd = isWin ? "C:/proj" : "/proj";
    for (const tool of ["read", "grep", "glob"]) {
      const r = checkReadPermissionForTool(
        tool,
        target,
        ctxWith("Read(*)", "allow"),
        cwd,
      );
      expect(r.behavior, `tool=${tool}`).toBe("ask");
    }
  });
  it("out-of-cwd grep/glob with NO matching Read(path) rule still asks", () => {
    for (const tool of ["grep", "glob"]) {
      const r = checkReadPermissionForTool(
        tool,
        target,
        buildContext("default"),
        cwd,
      );
      expect(r.behavior, `tool=${tool}`).toBe("ask");
    }
  });
  it("Read(path) deny blocks read, grep, and glob on that path", () => {
    for (const tool of ["read", "grep", "glob"]) {
      const r = checkReadPermissionForTool(tool, target, ctxWith(rule, "deny"), cwd);
      expect(r.behavior, `tool=${tool}`).toBe("deny");
    }
  });
  it("Read(path) allow does NOT leak into the write gate", () => {
    const r = checkWritePermissionForTool(
      "write",
      target,
      ctxWith(rule, "allow"),
      cwd,
    );
    expect(r.behavior).toBe("ask");
  });
  it("Edit(path) allow does NOT leak into the read gate", () => {
    const r = checkReadPermissionForTool(
      "grep",
      target,
      ctxWith("Edit(../../../elsewhere/**)", "allow"),
      cwd,
    );
    expect(r.behavior).toBe("ask");
  });
});