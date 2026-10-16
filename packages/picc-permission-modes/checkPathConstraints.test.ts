import { describe, it, expect } from "vitest";
import { checkPathConstraints } from "./upstream/tools/BashTool/pathValidation.ts";
import { commandHasAnyCd } from "./upstream/tools/BashTool/bashPermissions.ts";
import {
  buildContext,
  type ToolPermissionContext,
} from "./permissionContext.ts";
const cwd = process.cwd();
function ctx(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return buildContext("default", [], overrides);
}
function behavior(
  command: string,
  overrides: Partial<ToolPermissionContext> = {},
): string {
  const r = checkPathConstraints(
    { command },
    cwd,
    ctx(overrides),
    commandHasAnyCd(command),
  );
  return r.behavior;
}
describe("checkPathConstraints: Read rules apply to bash read commands", () => {
  it("allows `cat /abs/file` when Read(//**) is allowed (the reported gap)", () => {
    expect(
      behavior("cat /abs/file.txt", {
        alwaysAllowRules: { session: ["Read(//**)"] },
      }),
    ).toBe("passthrough");
  });
  it("allows `grep` over an allowed path", () => {
    expect(
      behavior("grep foo /abs/file.txt", {
        alwaysAllowRules: { session: ["Read(//**)"] },
      }),
    ).toBe("passthrough");
  });
  it("allows an in-cwd read with no rule", () => {
    expect(behavior(`cat ${cwd}/package.json`)).toBe("passthrough");
  });
  it("allows `cd dir && cat f.txt` under Read(//**) (cd + read is fine)", () => {
    expect(
      behavior("cd dir && cat f.txt", {
        alwaysAllowRules: { session: ["Read(//**)"] },
      }),
    ).toBe("passthrough");
  });
});
describe("checkPathConstraints: reads outside allowed scope prompt", () => {
  it("asks for an out-of-cwd path with no matching Read rule", () => {
    expect(behavior("cat /outside/file.txt")).toBe("ask");
  });
  it("asks for a glob read whose base dir is outside cwd", () => {
    expect(behavior("cat /outside/core/*.js")).toBe("ask");
  });
});
describe("checkPathConstraints: deny rules block bash reads", () => {
  it("denies a read under a Read(...) deny rule", () => {
    expect(
      behavior("cat ~/secrets/a.txt", {
        alwaysDenyRules: { session: ["Read(~/secrets/**)"] },
      }),
    ).toBe("deny");
  });
});
describe("checkPathConstraints: writes and redirections", () => {
  it("asks for an out-of-cwd redirection write in default mode", () => {
    expect(behavior("echo hi > /outside/x")).toBe("ask");
  });
  it("asks for an in-cwd write in default mode (writes need acceptEdits)", () => {
    expect(behavior(`touch ${cwd}/newfile.txt`)).toBe("ask");
  });
  it("allows an in-cwd write under acceptEdits mode", () => {
    const r = checkPathConstraints(
      { command: `touch ${cwd}/newfile.txt` },
      cwd,
      buildContext("acceptEdits"),
      commandHasAnyCd(`touch ${cwd}/newfile.txt`),
    );
    expect(r.behavior).toBe("passthrough");
  });
  it("still asks for an out-of-cwd write under acceptEdits mode", () => {
    const r = checkPathConstraints(
      { command: "touch /outside/newfile.txt" },
      cwd,
      buildContext("acceptEdits"),
      commandHasAnyCd("touch /outside/newfile.txt"),
    );
    expect(r.behavior).toBe("ask");
  });
  it("asks for an out-of-cwd `rm` of a directory (not dangerous, not allowed)", () => {
    expect(behavior("rm -r /outside/scratch")).toBe("ask");
  });
});
describe("checkPathConstraints: security guards", () => {
  it("asks for a dangerous removal (rm -rf /)", () => {
    expect(behavior("rm -rf /")).toBe("ask");
  });
  it("asks for process substitution", () => {
    expect(behavior("echo hi > >(tee /x)")).toBe("ask");
  });
  it("asks for a shell-expansion path", () => {
    expect(behavior("cat $HOME/file")).toBe("ask");
  });
  it("passes through non-path read-only commands (git status)", () => {
    expect(behavior("git status")).toBe("passthrough");
  });
  it("passes through plain `ls`", () => {
    expect(behavior("ls")).toBe("passthrough");
  });
});
