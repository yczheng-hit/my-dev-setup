import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
  // local patch: own the deny rule instead of depending on the user's
  // ~/.claude/settings.json (and never read the user's real picc config).
  const prevConfig = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  let configDir = "";

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "picc-host-mode-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf:*)"] } }),
    );
    process.env.PICC_PERMISSION_MODES_CONFIG_PATH = join(configDir, "config.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterAll(() => {
    restoreEnv("PICC_PERMISSION_MODES_CONFIG_PATH", prevConfig);
    restoreEnv("CLAUDE_CONFIG_DIR", prevClaude);
    rmSync(configDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    delete process.env.PICC_PERMISSION_MODE;
  });
  afterEach(() => {
    restoreEnv("PICC_PERMISSION_MODE", prev);
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
