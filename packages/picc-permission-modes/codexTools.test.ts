import { describe, expect, it } from "vitest";
import { expandCodexToolCall } from "./codexTools.ts";

describe("expandCodexToolCall", () => {
  it("maps exec_command and shell_command onto bash", () => {
    expect(expandCodexToolCall("exec_command", { cmd: "npm test", workdir: "/x" })).toEqual([
      { tool: "bash", input: { command: "npm test" } },
    ]);
    expect(expandCodexToolCall("shell_command", { command: "ls" })).toEqual([{ tool: "bash", input: { command: "ls" } }]);
  });

  it("maps every apply_patch file operation onto write/edit with its path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "@@",
      " keep",
      "-before",
      "+after",
      "*** Delete File: .gitconfig",
      "*** End Patch",
    ].join("\n");
    const calls = expandCodexToolCall("apply_patch", { patch });
    expect(calls.map((c) => [c.tool, c.input.path])).toEqual([
      ["write", "src/new.ts"],
      ["edit", "src/old.ts"],
      ["edit", "src/moved.ts"],
      ["edit", ".gitconfig"],
    ]);
    expect(calls[0].input.content).toBe("export const a = 1;");
    expect(calls[1].input).toMatchObject({ old_string: "keep\nbefore", new_string: "keep\nafter" });
  });

  it("gates an unparseable patch as a pathless edit instead of letting it through", () => {
    expect(expandCodexToolCall("apply_patch", { patch: "garbage" })).toEqual([
      { tool: "edit", input: { path: "", old_string: "", new_string: "" } },
    ]);
  });

  it("leaves other tools unchanged", () => {
    expect(expandCodexToolCall("read", { path: "a" })).toEqual([{ tool: "read", input: { path: "a" } }]);
    expect(expandCodexToolCall("write_stdin", { session_id: 1, chars: "" })).toEqual([
      { tool: "write_stdin", input: { session_id: 1, chars: "" } },
    ]);
  });
});
