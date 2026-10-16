import { describe, expect, it, beforeEach, afterEach } from "vitest";
import permissionModesExtension from "./index.ts";

/**
 * Regression test for the headless host-mode contract (Option B).
 *
 * The picc-claude-shim (driven by T3) builds its pi session via
 * `createAgentSession` and never calls `bindExtensions`, so pi never fires
 * `session_start`. That means the extension's `onSessionStart` (where a
 * `--permission-mode` flag would normally be applied) never runs, and the
 * gate would otherwise stay on "default" — auto-rejecting every non-allow
 * tool call even when the host selected "Full access".
 *
 * The fix: the shim sets `PICC_PERMISSION_MODE` (mapped from its own
 * `--permission-mode`, which already folds in `--dangerously-skip-permissions`
 * → `bypassPermissions`) before extensions register, and the extension applies
 * it in its register function. These tests model exactly that: env set before
 * `permissionModesExtension(...)`, NO `session_start` fired, then a headless
 * `tool_call`.
 */
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const on = (event: string, handler: Handler) => {
    const arr = handlers.get(event) ?? [];
    arr.push(handler);
    handlers.set(event, arr);
  };
  const noop = () => {};
  return {
    on,
    registerFlag: noop,
    registerTool: noop,
    activateTool: noop,
    deactivateTool: noop,
    registerMessageRenderer: noop,
    registerCommand: noop,
    registerShortcut: noop,
    appendEntry: noop,
    sendUserMessage: noop,
    getFlag: () => undefined,
    sendMessage: noop,
    ui: {
      select: async () => "Block",
      confirm: async () => false,
      notify: noop,
      editor: async () => undefined,
      custom: async <T>(): Promise<T> => ("Block" as unknown as T),
    },
    handlers,
  };
}

function headlessCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "host-mode-test" },
  };
}

async function runToolCall(toolName: string, input: Record<string, unknown>, cwd: string) {
  const pi = makeFakePi();
  permissionModesExtension(pi as never);
  const list = pi.handlers.get("tool_call") ?? [];
  for (const h of list) {
    const result = await h({ toolName, input, toolCallId: `call-${Math.random()}` }, headlessCtx(cwd));
    if (result !== undefined) return result;
  }
  return undefined;
}

describe("host permission mode via PICC_PERMISSION_MODE (headless, no session_start)", () => {
  const cwd = process.cwd();
  const prev = process.env.PICC_PERMISSION_MODE;

  beforeEach(() => {
    delete process.env.PICC_PERMISSION_MODE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PICC_PERMISSION_MODE;
    else process.env.PICC_PERMISSION_MODE = prev;
  });

  it("with no env set, default mode auto-rejects a non-allow bash call (the original bug)", async () => {
    const result = await runToolCall("bash", { command: "npm test" }, cwd);
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Permission to use bash has been denied");
  });

  it("bypassPermissions (Full access) allows an edit in a headless session", async () => {
    process.env.PICC_PERMISSION_MODE = "bypassPermissions";
    const result = await runToolCall(
      "edit",
      { file_path: `${cwd}/src/host-mode-env-test-file.ts`, old_string: "a", new_string: "b" },
      cwd,
    );
    expect(result).toBeUndefined();
  });

  it("bypassPermissions (Full access) allows a non-read-only bash in a headless session", async () => {
    process.env.PICC_PERMISSION_MODE = "bypassPermissions";
    const result = await runToolCall("bash", { command: "npm test" }, cwd);
    expect(result).toBeUndefined();
  });

  it("keeps user deny rules enforced even in bypassPermissions", async () => {
    process.env.PICC_PERMISSION_MODE = "bypassPermissions";
    const result = await runToolCall("bash", { command: "rm -rf node_modules" }, cwd);
    expect(result).toMatchObject({ block: true });
  });

  it("acceptEdits allows an in-cwd edit but still prompts (blocks) bash in headless", async () => {
    process.env.PICC_PERMISSION_MODE = "acceptEdits";
    const edit = await runToolCall(
      "edit",
      { file_path: `${cwd}/src/host-mode-env-test-file.ts`, old_string: "a", new_string: "b" },
      cwd,
    );
    expect(edit).toBeUndefined();
    const bash = await runToolCall("bash", { command: "npm test" }, cwd);
    expect(bash).toMatchObject({ block: true });
  });

  it("unknown env values fall back to default (still auto-reject)", async () => {
    process.env.PICC_PERMISSION_MODE = "not-a-real-mode";
    const result = await runToolCall("bash", { command: "npm test" }, cwd);
    expect(result).toMatchObject({ block: true });
  });
});
