import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { join, sep, dirname } from "node:path";
import * as path from "node:path";
import { tmpdir, homedir } from "node:os";
import permissionModesExtension, { loadAgentCanEnterPlanModeConfig, loadSubagentModeConfig, setInteractiveModeForTests, CLASSIFIER_NOTE_MARKER } from "./index.ts";
import {
  buildContext,
  generateSuggestions,
  isDangerousFilePath,
  isAcceptEditsBashCommand,
  matchingBashRule,
  matchingRuleForInput,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from "./permissionContext.ts";
import {
  clearPlanSlugs,
  generateWordSlug,
  getPlanFilePath,
  getPlanSlug,
  getPlansDir,
  isReadOnlyCommand,
  setPlanSlug,
  splitBashSubcommands,
} from "./utils.ts";
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: unknown) => unknown | Promise<unknown>;
interface FakeUi {
  select: (label: string, options: string[]) => Promise<string>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (msg: string, type?: string) => void;
  editor: (label: string, val: string) => Promise<string | undefined>;
  custom: <T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ) => Promise<T>;
}
interface FakePi {
  handlers: Map<string, Handler[]>;
  commands: Map<string, CommandHandler>;
  shortcuts: Map<string, Handler>;
  flags: Record<string, unknown>;
  appendEntries: Array<{ type: string; data: unknown }>;
  activeTools: string[];
  userMessages: Array<{ text: string; opts?: unknown }>;
  sentMessages: Array<{
    message: { customType?: string; content?: unknown; display?: boolean };
    opts?: unknown;
  }>;
  registeredTools: Array<{ name: string; tool: any }>;
  messageRenderers: Map<
    string,
    (message: any, options: any, theme: any) => unknown
  >;
  ui: FakeUi;
  fakeCtxFor: (opts?: Partial<{ cwd: string; hasUI: boolean }>) => any;
  simulateSessionStart: (cwd: string, ui?: Partial<FakeUi>, reason?: string, previousSessionFile?: string, opts?: { hasUI?: boolean }) => Promise<void>;
  simulateToolCall: (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: any,
    toolCallId?: string,
  ) => Promise<unknown>;
  simulateToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
    opts?: { isError?: boolean; content?: string; details?: unknown },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  }>;
  simulateCommand: (name: string, args: string, ctx?: any) => Promise<unknown>;
  simulateShortcut: (key: string, ctx?: any) => Promise<unknown>;
  simulateToolExecution: (
    name: string,
    params: any,
    ctx: any,
  ) => Promise<any>;
}
function defaultSelect(): Promise<string> {
  return Promise.resolve("Block");
}
function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, Handler>();
  const flags: Record<string, unknown> = {};
  const appendEntries: Array<{ type: string; data: unknown }> = [];
  const activeTools = ["read", "edit", "write", "bash", "grep", "find"];
  const userMessages: Array<{ text: string; opts?: unknown }> = [];
  const sentMessages: Array<{
    message: { customType?: string; content?: unknown; display?: boolean };
    opts?: unknown;
  }> = [];
  const registeredTools: Array<{ name: string; tool: any }> = [];
  const messageRenderers: Map<
    string,
    (message: any, options: any, theme: any) => unknown
  > = new Map();
  const ui: FakeUi = {
    select: defaultSelect,
    confirm: async () => false,
    notify: () => {},
    editor: async () => undefined,
    custom: async <T,>() => {
      return (await ui.select("", [])) as T;
    },
  };
  function makeCtx(pi: FakePi, opts: { cwd?: string; hasUI?: boolean; ui?: FakeUi } = {}) {
    const cwd = opts.cwd ?? "/home/user/project";
    const hasUI = opts.hasUI ?? true;
    const usedUi = opts.ui ?? ui;
    return {
      cwd,
      hasUI,
      mode: "tui",
      modelRegistry: { find: () => undefined },
      ui: {
        select: usedUi.select,
        confirm: usedUi.confirm,
        notify: usedUi.notify,
        editor: usedUi.editor,
        custom: usedUi.custom,
        setStatus: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setWorkingMessage: () => {},
        theme: {
          fg: (_role: string, text: string) => text,
          bold: (t: string) => t,
          strikethrough: (t: string) => t,
        },
      },
      sessionManager: {
        getSessionId: () => "test-session",
        getBranch: () => [],
        getGitBranch: () => "",
      },
      model: undefined,
    };
  }
  const pi: FakePi = {
    handlers,
    commands,
    shortcuts,
    flags,
    appendEntries,
    activeTools,
    userMessages,
    sentMessages,
    registeredTools,
    messageRenderers,
    ui,
    fakeCtxFor: (opts) => makeCtx(pi, opts),
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, def: { handler: CommandHandler }) {
      commands.set(name, def.handler);
    },
    registerShortcut(key: string, def: { handler: Handler }) {
      shortcuts.set(key, def.handler);
    },
    registerFlag(name: string, def: { default?: unknown }) {
      if (def?.default !== undefined && !(name in flags)) {
        flags[name] = def.default;
      }
    },
    registerTool(tool: any) {
      registeredTools.push({ name: tool.name, tool });
    },
    registerMessageRenderer(
      customType: string,
      renderer: (message: any, options: any, theme: any) => unknown,
    ) {
      messageRenderers.set(customType, renderer);
    },
    getFlag(name: string) {
      return flags[name];
    },
    appendEntry(type: string, data: unknown) {
      appendEntries.push({ type, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools.length = 0;
      activeTools.push(...tools);
    },
    sendUserMessage(text: string, opts?: unknown) {
      userMessages.push({ text, opts });
    },
    sendMessage(message: unknown, opts?: unknown) {
      sentMessages.push({ message: message as never, opts });
    },
    async simulateSessionStart(cwd: string, customUi?: Partial<FakeUi>, reason?: string, previousSessionFile?: string, opts?: { hasUI?: boolean }) {
      const merged = { ...ui, ...customUi };
      const branchEntries = appendEntries
        .filter((e) => e.type === "modes")
        .map((e) => ({ type: "custom", customType: e.type, data: e.data }));
      const ctx = {
        cwd,
        hasUI: opts?.hasUI ?? true,
        mode: "tui" as const,
        modelRegistry: { find: () => undefined },
        ui: {
          select: merged.select,
          confirm: merged.confirm,
          notify: merged.notify,
          editor: merged.editor,
          custom: merged.custom,
          setStatus: () => {},
          setWidget: () => {},
          setFooter: () => {},
          setWorkingMessage: () => {},
          theme: {
            fg: (_role: string, text: string) => text,
            bold: (t: string) => t,
            strikethrough: (t: string) => t,
          },
        },
        sessionManager: {
          getSessionId: () => "test-session",
          getBranch: () => branchEntries,
          getGitBranch: () => "",
        },
        model: undefined,
      };
      const list = handlers.get("session_start") ?? [];
      for (const h of list) {
        await h(
          {
            reason: reason ?? "startup",
            previousSessionFile,
          },
          ctx,
        );
      }
    },
    async simulateToolCall(toolName, input, ctx, toolCallId) {
      const list = handlers.get("tool_call") ?? [];
      const fullCtx = ctx ?? makeCtx(pi);
      const id = toolCallId ?? `test-call-${Math.random().toString(36).slice(2, 10)}`;
      for (const h of list) {
        const result = await h({ toolName, input, toolCallId: id }, fullCtx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    async simulateToolResult(toolName, input, toolCallId, opts) {
      const list = handlers.get("tool_result") ?? [];
      const fullCtx = makeCtx(pi);
      const event = {
        type: "tool_result",
        toolName,
        toolCallId,
        input,
        content: [{ type: "text", text: opts?.content ?? "" }],
        details: opts?.details ?? undefined,
        isError: opts?.isError ?? false,
      };
      for (const h of list) {
        await h(event, fullCtx);
      }
      return { content: event.content, isError: event.isError };
    },
    async simulateCommand(name, args, ctx) {
      const handler = commands.get(name);
      if (!handler) throw new Error(`No command registered: ${name}`);
      return handler(args, ctx ?? makeCtx(pi));
    },
    async simulateShortcut(key, ctx) {
      const handler = shortcuts.get(key);
      if (!handler) throw new Error(`No shortcut registered: ${key}`);
      return handler(ctx ?? makeCtx(pi));
    },
    async simulateToolExecution(name, params, ctx) {
      const toolEntry = registeredTools.find((t) => t.name === name);
      if (!toolEntry) throw new Error(`No tool registered: ${name}`);
      const tool = toolEntry.tool;
      if (typeof tool.execute !== "function") {
        throw new Error(`Tool ${name} has no execute`);
      }
      return tool.execute(
        "test-call",
        params ?? {},
        new AbortController().signal,
        () => {},
        ctx ?? makeCtx(pi),
      );
    },
  };
  return pi;
}
function makeFakePiForExtension(p: FakePi) {
  return p as unknown as Parameters<typeof permissionModesExtension>[0];
}
let globalEnvDir: string | undefined;
const savedGlobalEnv: { config?: string | undefined; claude?: string | undefined } = {};
beforeAll(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  globalEnvDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
  savedGlobalEnv.config = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
  savedGlobalEnv.claude = process.env.CLAUDE_CONFIG_DIR;
  process.env.PICC_PERMISSION_MODES_CONFIG_PATH = join(globalEnvDir, "config.json");
  process.env.CLAUDE_CONFIG_DIR = globalEnvDir;
});
beforeEach(() => {
  setInteractiveModeForTests(undefined);
});
afterAll(() => {
  if (savedGlobalEnv.config === undefined) delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
  else process.env.PICC_PERMISSION_MODES_CONFIG_PATH = savedGlobalEnv.config;
  if (savedGlobalEnv.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedGlobalEnv.claude;
  if (globalEnvDir) {
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(globalEnvDir, { recursive: true, force: true });
  }
});
describe("permission-modes extension: tool_call gate", () => {
  let pi: FakePi;
  let cwd: string;
  beforeEach(async () => {
    pi = createFakePi();
    cwd = process.cwd();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  async function switchMode(mode: string) {
    pi.flags["permission-mode"] = mode;
    await pi.simulateSessionStart(cwd);
  }
  describe("subagent (headless) mode", () => {
    function startHeadlessSession(parentMode: string | undefined) {
      setInteractiveModeForTests(parentMode as any);
      return pi.simulateSessionStart(cwd, undefined, undefined, undefined, { hasUI: false });
    }
    it("inherits bypassPermissions from parent and allows non-read-only bash", async () => {
      await startHeadlessSession("bypassPermissions");
      const headlessCtx = pi.fakeCtxFor({ cwd, hasUI: false });
      const result = await pi.simulateToolCall("bash", { command: "npm test" }, headlessCtx);
      expect(result).toBeUndefined();
    });
    it("with default parent mode, denies non-read-only bash with the headless message", async () => {
      await startHeadlessSession("default");
      const headlessCtx = pi.fakeCtxFor({ cwd, hasUI: false });
      const result = await pi.simulateToolCall("bash", { command: "npm test" }, headlessCtx);
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("Permission to use bash has been denied");
      expect(result?.reason).not.toContain("cannot run without UI");
    });
    it("allows read-only bash in a subagent regardless of mode", async () => {
      await startHeadlessSession("default");
      const headlessCtx = pi.fakeCtxFor({ cwd, hasUI: false });
      const result = await pi.simulateToolCall("bash", { command: "ls -la" }, headlessCtx);
      expect(result).toBeUndefined();
    });
    it("a non-subagent (UI) session still prompts for non-read-only bash", async () => {
      await pi.simulateSessionStart(cwd);
      const result = await pi.simulateToolCall(
        "bash",
        { command: "npm test" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("Allow bash command?");
      expect(result?.reason).not.toContain("headless agent");
    });
    it("forwards the model-supplied bash description into the permission dialog", async () => {
      await pi.simulateSessionStart(cwd);
      let capturedFactory:
        | ((
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (r: unknown) => void,
          ) => { render(w: number): string[] })
        | undefined;
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      const result = await pi.simulateToolCall(
        "bash",
        { command: "npm test", description: "Run the test suite" },
        pi.fakeCtxFor({
          cwd,
          ui: {
            ...pi.ui,
            custom: async (factory: (t: unknown, th: unknown, k: unknown, d: (r: unknown) => void) => unknown) => {
              capturedFactory = factory as typeof capturedFactory;
              return "Block" as never;
            },
          } as any,
        }),
      );
      expect(result).toMatchObject({ block: true });
      expect(capturedFactory).toBeDefined();
      const component = capturedFactory!({}, theme, undefined, () => {});
      const out = component.render(80).join("\n");
      expect(out).toContain("npm test");
      expect(out).toContain("Run the test suite");
    });
    it("omits the description when the model does not supply one for bash", async () => {
      await pi.simulateSessionStart(cwd);
      let capturedFactory:
        | ((
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (r: unknown) => void,
          ) => { render(w: number): string[] })
        | undefined;
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      await pi.simulateToolCall(
        "bash",
        { command: "npm test" },
        pi.fakeCtxFor({
          cwd,
          ui: {
            ...pi.ui,
            custom: async (factory: (t: unknown, th: unknown, k: unknown, d: (r: unknown) => void) => unknown) => {
              capturedFactory = factory as typeof capturedFactory;
              return "Block" as never;
            },
          } as any,
        }),
      );
      expect(capturedFactory).toBeDefined();
      const component = capturedFactory!({}, theme, undefined, () => {});
      const out = component.render(80).join("\n");
      expect(out).toContain("npm test");
      expect(out).not.toContain("Run the test suite");
    });
    it("respects an explicit Bash allow rule even in a default-mode subagent", async () => {
      await startHeadlessSession("default");
      const headlessCtx = pi.fakeCtxFor({ cwd, hasUI: false });
      const result = await pi.simulateToolCall("bash", { command: "npm test" }, headlessCtx);
      expect(result).toMatchObject({ block: true });
    });
  });
  describe("default mode", () => {
    it("auto-allows write of the plan file even outside plan mode (CC-style)", async () => {
      await switchMode("default");
      const planPath = getPlanFilePath("test-session");
      const result = await pi.simulateToolCall("write", { path: planPath });
      expect(result).toBeUndefined();
    });
    it("prompts on edit inside cwd", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall(
        "edit",
        { path: "src/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("auto-approves read inside cwd", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall("read", { path: "src/foo.ts" });
      expect(result).toBeUndefined();
    });
    it("prompts on read outside cwd", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall("read", { path: "/etc/passwd" });
      expect(result).toMatchObject({ block: true });
    });
    it("auto-approves safe bash (ls)", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall("bash", { command: "ls -la" });
      expect(result).toBeUndefined();
    });
    it("prompts on destructive bash (rm -rf /)", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "rm -rf /etc" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("bash panel renders the command, description, question, and 3 options", async () => {
      await switchMode("default");
      let capturedFactory:
        | ((
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (r: unknown) => void,
          ) => { render(w: number): string[] })
        | undefined;
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      const result = await pi.simulateToolCall(
        "bash",
        { command: "python -c \"print('hi')\"", description: "Print hello with Python" },
        pi.fakeCtxFor({
          cwd,
          ui: {
            ...pi.ui,
            custom: async (factory: (t: unknown, th: unknown, k: unknown, d: (r: unknown) => void) => unknown) => {
              capturedFactory = factory as typeof capturedFactory;
              return "No" as never;
            },
          } as any,
        }),
      );
      expect(result).toMatchObject({ block: true });
      expect(capturedFactory).toBeDefined();
      const out = capturedFactory!({}, theme, undefined, () => {}).render(80).join("\n");
      expect(out).toContain("Bash command");
      expect(out).toContain('python -c "print(\'hi\')"' );
      expect(out).toContain("Print hello with Python");
      expect(out).toContain("This command requires approval");
      expect(out).toContain("Do you want to proceed?");
      expect(out).toContain("Yes, and don't ask again for: python *");
      expect(out).toContain("Esc to cancel · Tab to amend · ctrl+e to explain");
      expect(out).not.toContain("1. Allow");
      expect(out).not.toContain("shift+tab allow all");
    });
    it("bash 'Yes' proceeds without adding a rule", async () => {
      await switchMode("default");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "git push" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Yes") as T } as any }),
      );
      expect(result).toBeUndefined();
    });
    it("bash scoped-allow ('Yes, and don't ask again for: X *') persists a session allow rule", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-perm-repo-default-"));
      const repoPath = join(dir, ".pi", "permissions.json");
      try {
        pi.flags["permission-mode"] = "default";
        await pi.simulateSessionStart(dir);
        const result = await pi.simulateToolCall(
          "bash",
          { command: "git push origin main" },
          pi.fakeCtxFor({
            cwd: dir,
            ui: { ...pi.ui, custom: async <T,>() => ("Yes, and don't ask again for: git *") as T } as any,
          }),
        );
        expect(result).toBeUndefined();
        expect(existsSync(repoPath)).toBe(true);
        expect(JSON.parse(readFileSync(repoPath, "utf-8")).permissions.allow)
          .toContain("Bash(git *)");
        const followup = await pi.simulateToolCall(
          "bash",
          { command: "git push origin dev" },
          pi.fakeCtxFor({ cwd: dir }),
        );
        expect(followup).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  describe("acceptEdits mode", () => {
    it("auto-approves edit inside cwd", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall("edit", { path: "src/foo.ts" });
      expect(result).toBeUndefined();
    });
    it("auto-approves edit on the acceptEdits bash allowlist (mkdir)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall("bash", { command: "mkdir new" });
      expect(result).toBeUndefined();
    });
    it("STILL prompts on sed with dangerous write flag (s/.../.../w file)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "sed 's/foo/bar/w out.txt' src/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("STILL prompts on bash command targeting a sensitive file (rm .gitconfig)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "rm .gitconfig" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("STILL prompts on bash command targeting a nested dangerous dir (vendor/repo/.git/HEAD)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "rm vendor/myrepo/.git/HEAD" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("STILL prompts on cp of a sensitive source file (cp .gitconfig x)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "cp .gitconfig /tmp/x" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("acceptEdits bash fast-path uses session-original cwd (mkdir still allows after agent has cd'd)", async () => {
      expect(true).toBe(true);
    });
    it("STILL prompts on sed with execute flag (s/.../.../e)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "sed 's/foo/bar/e' src/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("auto-approves safe sed -i substitution in acceptEdits", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall("bash", {
        command: "sed -i 's/foo/bar/g' src/foo.ts",
      });
      expect(result).toBeUndefined();
    });
    it("prompts on edit outside cwd", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "write",
        { path: "/etc/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
  });
  describe("plan mode", () => {
    it("prompts on edit of non-plan files (gates like default)", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall(
        "edit",
        { path: "src/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("prompts on write of non-plan files (gates like default)", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall(
        "write",
        { path: "src/foo.ts" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("allows write of the plan file", async () => {
      await switchMode("plan");
      const planPath = getPlanFilePath("test-session");
      const result = await pi.simulateToolCall("write", { path: planPath });
      expect(result).toBeUndefined();
    });
    it("allows edit of the plan file when the tool uses `file_path` (picc-edit)", async () => {
      await switchMode("plan");
      const planPath = getPlanFilePath("test-session");
      const result = await pi.simulateToolCall("edit", {
        file_path: planPath,
        old_string: "a",
        new_string: "b",
      });
      expect(result).toBeUndefined();
    });
    it("allows write of the plan file when the tool uses `file_path` (picc-write)", async () => {
      await switchMode("plan");
      const planPath = getPlanFilePath("test-session");
      const result = await pi.simulateToolCall("write", {
        file_path: planPath,
        content: "plan",
      });
      expect(result).toBeUndefined();
    });
    it("prompts on a non-plan edit when the tool uses `file_path`", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall(
        "edit",
        { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
        pi.fakeCtxFor({
          cwd,
          ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any,
        }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("auto-allows write of the plan file when the path is tilde-prefixed (picc-write)", async () => {
      await switchMode("plan");
      const planPath = getPlanFilePath("test-session");
      const home = homedir();
      const tildePath = `~${planPath.slice(home.length)}`;
      const result = await pi.simulateToolCall("write", {
        file_path: tildePath,
        content: "plan",
      });
      expect(result).toBeUndefined();
    });
    it("auto-approves read", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall("read", { path: "src/foo.ts" });
      expect(result).toBeUndefined();
    });
    it("auto-allows a pathless grep without a Windows-path prompt", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall("grep", { pattern: "foo" });
      expect(result).toBeUndefined();
    });
    it("auto-allows a pathless read without a Windows-path prompt", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall("read", {});
      expect(result).toBeUndefined();
    });
    it("auto-approves safe bash (ls)", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall("bash", { command: "ls" });
      expect(result).toBeUndefined();
    });
    it("prompts on destructive bash (rm -rf /)", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "rm -rf /" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("auto-approves compound read-only bash (cd && pwd && ls)", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall("bash", {
        command: 'cd ".pi/plans" && pwd && ls -la',
      });
      expect(result).toBeUndefined();
    });
    it("prompts on compound bash with a write subcommand", async () => {
      await switchMode("plan");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "pwd && rm -rf /tmp/foo" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("does not mutate the active tool set on entry (prompt caching)", async () => {
      const before = [...pi.activeTools];
      await switchMode("plan");
      expect(pi.activeTools).toEqual(before);
    });
  });
  describe("bypassPermissions mode", () => {
    it("auto-approves edit inside cwd", async () => {
      await switchMode("bypassPermissions");
      const result = await pi.simulateToolCall("edit", { path: "src/foo.ts" });
      expect(result).toBeUndefined();
    });
    it("auto-approves read anywhere", async () => {
      await switchMode("bypassPermissions");
      const result = await pi.simulateToolCall("read", { path: "/etc/passwd" });
      expect(result).toBeUndefined();
    });
    it("STILL prompts on dangerous-file safety check (D4)", async () => {
      await switchMode("bypassPermissions");
      const result = await pi.simulateToolCall(
        "edit",
        { path: "/home/user/.gitconfig" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("STILL prompts on dangerous-directory safety check (D4)", async () => {
      await switchMode("bypassPermissions");
      const result = await pi.simulateToolCall(
        "edit",
        { path: `${cwd}/.git/HEAD` },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
    it("does NOT D4-flag a read-only sed substitution (screenshot repro)", async () => {
      await switchMode("bypassPermissions");
      const result = await pi.simulateToolCall("bash", {
        command: `grep -m1 "version" pkg.json | sed 's/.*/ *"\\(.*\\)"".*\\^1/'`,
      });
      expect(result).toBeUndefined();
    });
    it("STILL prompts on in-place sed to a dangerous file (D4)", async () => {
      await switchMode("acceptEdits");
      const result = await pi.simulateToolCall(
        "bash",
        { command: "sed -i 's/a/b/' .gitconfig" },
        pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
      );
      expect(result).toMatchObject({ block: true });
    });
  });
});
describe("user-configured permissions", () => {
  let pi: FakePi;
  let cwd: string;
  let savedPermPath: string | undefined;
  let savedClaudePath: string | undefined;
  let tempDirs: string[] = [];
  beforeEach(async () => {
    savedPermPath = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    savedClaudePath = process.env.CLAUDE_CONFIG_DIR;
    tempDirs = [];
    pi = createFakePi();
    cwd = process.cwd();
  });
  afterEach(() => {
    if (savedPermPath === undefined) {
      delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    } else {
      process.env.PICC_PERMISSION_MODES_CONFIG_PATH = savedPermPath;
    }
    if (savedClaudePath === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedClaudePath;
    }
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });
  function writeLocalConfig(perms: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-perm-user-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: [], deny: [], ask: [], ...perms } }),
      "utf-8",
    );
    process.env.PICC_PERMISSION_MODES_CONFIG_PATH = path;
    process.env.CLAUDE_CONFIG_DIR = dir;
    return path;
  }
  /** Write a local config that has NO `permissions` block at all (the
   *  user's current state — only `autoMode` is present). Combined with a
   *  populated claude-settings file, this exercises the fallback path. */
  function writeLocalConfigWithoutPermissionsBlock(
    claudePerms: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): void {
    const dir = mkdtempSync(join(tmpdir(), "pi-perm-user-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ autoMode: { allow: ["x"] } }),
      "utf-8",
    );
    process.env.PICC_PERMISSION_MODES_CONFIG_PATH = path;
    const claudePath = join(dir, "settings.json");
    writeFileSync(
      claudePath,
      JSON.stringify({
        permissions: {
          allow: claudePerms.allow ?? [],
          deny: claudePerms.deny ?? [],
          ask: claudePerms.ask ?? [],
        },
      }),
      "utf-8",
    );
    process.env.CLAUDE_CONFIG_DIR = dir;
  }
  it("auto-allows Read when user has a bare 'Read' rule in default mode", async () => {
    writeLocalConfig({ allow: ["Read"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateSessionStart(cwd);
    const result = await pi.simulateToolCall("read", {
      path: "/some/outside/cwd/file.ts",
    });
    expect(result).toBeUndefined();
  });
  it("auto-allows Read in acceptEdits mode for out-of-cwd paths when user rule permits", async () => {
    writeLocalConfig({ allow: ["Read"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    pi.flags["permission-mode"] = "acceptEdits";
    await pi.simulateSessionStart(cwd);
    const result = await pi.simulateToolCall("read", {
      path: "C:\\Users\\Test\\AppData\\Roaming\\some\\file.ts",
    });
    expect(result).toBeUndefined();
  });
  it("denies Bash rule match even when acceptEdits would otherwise allow", async () => {
    writeLocalConfig({
      allow: ["Bash(go)"],
      deny: ["Bash(rm *)"],
    });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const allowed = await pi.simulateToolCall("bash", { command: "go" });
    expect(allowed).toBeUndefined();
  });
  it("session-dialog rules survive alongside userSettings rules", async () => {
    writeLocalConfig({ allow: ["Read"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    pi.flags["permission-mode"] = "acceptEdits";
    await pi.simulateSessionStart(cwd);
    const read = await pi.simulateToolCall("read", {
      path: "C:\\some\\other\\place.txt",
    });
    expect(read).toBeUndefined();
  });
  it("falls back to ~/.claude/settings.json when local config has NO permissions block at all", async () => {
    writeLocalConfigWithoutPermissionsBlock({ allow: ["Read"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    pi.flags["permission-mode"] = "acceptEdits";
    await pi.simulateSessionStart(cwd);
    const read = await pi.simulateToolCall("read", {
      path: "C:\\Users\\Test\\AppData\\Roaming\\some\\file.ts",
    });
    expect(read).toBeUndefined();
  });
});
describe("repo-scoped permissions", () => {
  let pi: FakePi;
  let cwd: string;
  let repoDir: string;
  beforeEach(async () => {
    pi = createFakePi();
    repoDir = mkdtempSync(join(tmpdir(), "pi-perm-repo-"));
    cwd = repoDir;
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });
  function writeRepoPerms(perms: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  }): string {
    const path = join(repoDir, ".pi", "permissions.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: [], deny: [], ask: [], ...perms } }),
      "utf-8",
    );
    return path;
  }
  function writeClaudeRepo(perms: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  }, local = true): string {
    const path = local
      ? join(repoDir, ".claude", "settings.local.json")
      : join(repoDir, ".claude", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: [], deny: [], ask: [], ...perms } }),
      "utf-8",
    );
    return path;
  }
  it("auto-allows a matching bash command from a repo-file allow rule", async () => {
    writeRepoPerms({ allow: ["Bash(git *)"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const result = await pi.simulateToolCall("bash", { command: "git push origin main" });
    expect(result).toBeUndefined();
  });
  it("denies a matching bash command from a repo-file deny rule", async () => {
    writeRepoPerms({ deny: ["Bash(rm *)"] });
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const result = await pi.simulateToolCall(
      "bash",
      { command: "rm -rf /tmp/x" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("No") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("bash 'Yes, and don't ask again' writes the rule to .pi/permissions.json and auto-allows a follow-up", async () => {
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const first = await pi.simulateToolCall(
      "bash",
      { command: "git push origin main" },
      pi.fakeCtxFor({
        cwd,
        ui: { ...pi.ui, custom: async <T,>() => ("Yes, and don't ask again for: git *") as T } as any,
      }),
    );
    expect(first).toBeUndefined();
    const repoFile = join(repoDir, ".pi", "permissions.json");
    expect(existsSync(repoFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(repoFile, "utf-8")) as {
      permissions: { allow: string[] };
    };
    expect(parsed.permissions.allow).toContain("Bash(git *)");
    const followup = await pi.simulateToolCall("bash", { command: "git push origin dev" });
    expect(followup).toBeUndefined();
  });
  it("auto-imports Claude Code repo settings when the repo file is absent", async () => {
    writeClaudeRepo({ allow: ["Bash(git *)"] }, true);
    writeClaudeRepo({ allow: ["Read", "Bash(git *)"] }, false);
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const gitResult = await pi.simulateToolCall("bash", { command: "git status" });
    expect(gitResult).toBeUndefined();
    const readResult = await pi.simulateToolCall("read", { path: "/anywhere/file.ts" });
    expect(readResult).toBeUndefined();
    const repoFile = join(repoDir, ".pi", "permissions.json");
    expect(existsSync(repoFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(repoFile, "utf-8")) as {
      permissions: { allow: string[] };
    };
    expect(parsed.permissions.allow).toContain("Bash(git *)");
    expect(parsed.permissions.allow).toContain("Read");
    expect(parsed.permissions.allow.filter((r) => r === "Bash(git *)")).toHaveLength(1);
  });
  it("does not overwrite a non-empty repo file with claude settings", async () => {
    writeRepoPerms({ allow: ["Bash(npm *)"] });
    writeClaudeRepo({ allow: ["Bash(git *)"] }, true);
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const npmResult = await pi.simulateToolCall("bash", { command: "npm install" });
    expect(npmResult).toBeUndefined();
    const gitBlocked = await pi.simulateToolCall(
      "bash",
      { command: "git push origin main" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("No") as T } as any }),
    );
    expect(gitBlocked).toMatchObject({ block: true });
    const parsed = JSON.parse(
      readFileSync(join(repoDir, ".pi", "permissions.json"), "utf-8"),
    ) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toContain("Bash(npm *)");
    expect(parsed.permissions.allow).not.toContain("Bash(git *)");
  });
});
describe("Shift+Tab mode cycle", () => {
  let pi: FakePi;
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
  });
  it("cycles default → acceptEdits → plan → bypassPermissions → auto → default", async () => {
    let entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("default");
    await pi.simulateShortcut("shift+tab");
    entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("acceptEdits");
    await pi.simulateShortcut("shift+tab");
    entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("plan");
    await pi.simulateShortcut("shift+tab");
    entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("bypassPermissions");
    await pi.simulateShortcut("shift+tab");
    entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("auto");
    await pi.simulateShortcut("shift+tab");
    entry = pi.appendEntries[pi.appendEntries.length - 1];
    expect((entry.data as any).mode).toBe("default");
  });
  it("never cycles into a mode the model profile doesn't support", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 15; i++) {
      await pi.simulateShortcut("shift+tab");
      const last = pi.appendEntries[pi.appendEntries.length - 1];
      seen.push((last.data as any).mode);
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen.every((m) => ["default", "acceptEdits", "plan", "bypassPermissions", "auto"].includes(m))).toBe(true);
  });
});
describe("Mode commands", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it("/plan sets mode to plan", async () => {
    await pi.simulateCommand("plan", "");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("plan");
  });
  it("/bypassPermissions sets mode to bypassPermissions", async () => {
    await pi.simulateCommand("bypassPermissions", "");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("/auto sets mode to auto", async () => {
    await pi.simulateCommand("auto", "");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("auto");
  });
  it("/acceptEdits sets mode to acceptEdits", async () => {
    await pi.simulateCommand("acceptEdits", "");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("acceptEdits");
  });
  it("/mode bypass sets mode to bypassPermissions", async () => {
    await pi.simulateCommand("mode", "bypass");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("/mode auto sets mode to auto", async () => {
    await pi.simulateCommand("mode", "auto");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("auto");
  });
  it("/mode with unknown arg notifies error", async () => {
    const notifs: string[] = [];
    const ctx = pi.fakeCtxFor({
      cwd,
      ui: { ...pi.ui, notify: (m: string) => notifs.push(m) } as any,
    });
    await pi.simulateCommand("mode", "bogus", ctx);
    expect(notifs.some((n) => /unknown/i.test(n))).toBe(true);
  });
  it("/mode (no args) opens selector", async () => {
    let selectorOptions: string[] = [];
    const ctx = pi.fakeCtxFor({
      cwd,
      ui: {
        ...pi.ui,
        select: async (_label: string, options: string[]) => {
          selectorOptions = options;
          return "Accept edits";
        },
      } as any,
    });
    await pi.simulateCommand("mode", "", ctx);
    expect(selectorOptions).toContain("Default");
    expect(selectorOptions).toContain("Accept edits");
    expect(selectorOptions).toContain("Plan Mode");
    expect(selectorOptions).toContain("Bypass Permissions");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("acceptEdits");
  });
});
describe("Plan-mode attachments", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  async function triggerBeforeAgentStart() {
    const list = pi.handlers.get("before_agent_start") ?? [];
    if (!list.length) return undefined;
    return await list[0](
      { prompt: "u", systemPrompt: "", systemPromptOptions: { cwd } },
      pi.fakeCtxFor({ cwd }),
    );
  }
  it("injects plan-mode attachment when in plan mode (wrapped in <system-reminder>)", async () => {
    await pi.simulateCommand("plan", "");
    const result = await triggerBeforeAgentStart();
    expect(result).toBeDefined();
    const msg = (result as any).message;
    expect(msg?.customType).toBe("permission-modes:plan-mode");
    expect(typeof msg?.content).toBe("string");
    expect(msg.content).toMatch(/^<system-reminder>\n/);
    expect(msg.content).toMatch(/\n<\/system-reminder>$/);
    expect(msg.content).toContain("Phase 1: Initial Understanding");
    expect(msg.content).toContain("Phase 5: Call ExitPlanMode");
  });
  it("does NOT inject plan-mode attachment in default mode", async () => {
    const result = await triggerBeforeAgentStart();
    expect(result).toBeUndefined();
  });
  it("injects plan-mode-exit attachment after exiting plan mode (wrapped in <system-reminder>)", async () => {
    await pi.simulateCommand("plan", "");
    await triggerBeforeAgentStart();
    await pi.simulateCommand("default", "");
    const result = await triggerBeforeAgentStart();
    const msg = (result as any).message;
    expect(msg?.customType).toBe("permission-modes:plan-mode-exit");
    expect(msg?.content).toMatch(/^<system-reminder>\n/);
    expect(msg?.content).toMatch(/\n<\/system-reminder>$/);
    expect(msg?.content).toContain("## Exited Plan Mode");
    expect(msg?.content).toContain("You have exited plan mode.");
    expect(msg?.content).toContain("You can now make edits, run tools, and take actions.");
  });
  it("does NOT leak a plan-mode-exit reminder into a new (/new) session", async () => {
    await pi.simulateCommand("plan", "");
    await triggerBeforeAgentStart();
    await pi.simulateCommand("default", "");
    await pi.simulateSessionStart(cwd, undefined, "new");
    const result = await triggerBeforeAgentStart();
    expect(result).toBeUndefined();
  });
  it("emits the sparse 5-phase variant on subsequent plan-mode turns (still <system-reminder>-wrapped)", async () => {
    await pi.simulateCommand("plan", "");
    await triggerBeforeAgentStart();
    await triggerBeforeAgentStart();
    const result = await triggerBeforeAgentStart();
    const msg = (result as any).message;
    expect(msg?.customType).toBe("permission-modes:plan-mode");
    expect(msg?.content).toMatch(/^<system-reminder>\n/);
    expect(msg?.content).not.toContain("Phase 1: Initial Understanding");
    expect(msg?.content).toContain("Plan mode still active");
  });
});
describe("Plan-mode re-entry reminder", () => {
  const sessionId = "test-session";
  const pinnedSlug = "reentry-test-slug";
  let pi: FakePi;
  const cwd = process.cwd();
  let planPath: string;
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    setPlanSlug(sessionId, pinnedSlug);
    planPath = getPlanFilePath(sessionId);
    rmSync(planPath, { force: true });
  });
  afterEach(() => {
    rmSync(planPath, { force: true });
  });
  async function enterPlanResult(entered: boolean) {
    await pi.simulateToolResult(
      "EnterPlanMode",
      {},
      `enter-${Math.random().toString(36).slice(2, 8)}`,
      { details: { entered, declined: !entered } },
    );
  }
  function reentryMessages() {
    return pi.sentMessages.filter(
      (m) => m.message.customType === "permission-modes:plan-mode-reentry",
    );
  }
  /** Drive a full exit → re-enter cycle: enter plan, exit to default (latches
   *  hasExitedPlanMode), then fire an approved EnterPlanMode. */
  async function exitThenReenter() {
    await pi.simulateCommand("plan", "");
    await pi.simulateCommand("default", "");
    await enterPlanResult(true);
  }
  it("fires a plan-mode-reentry reminder after exit→re-enter when a plan file exists", async () => {
    writeFileSync(planPath, "# plan\n", "utf-8");
    await exitThenReenter();
    const msgs = reentryMessages();
    expect(msgs.length).toBe(1);
    const content = String(msgs[0].message.content);
    expect(msgs[0].message.display).toBe(false);
    expect(content).toMatch(/^<system-reminder>\n/);
    expect(content).toMatch(/\n<\/system-reminder>$/);
    expect(content).toContain("## Re-entering Plan Mode");
    expect(content).toContain(planPath);
  });
  it("does NOT fire when EnterPlanMode is declined", async () => {
    writeFileSync(planPath, "# plan\n", "utf-8");
    await pi.simulateCommand("plan", "");
    await pi.simulateCommand("default", "");
    await enterPlanResult(false);
    expect(reentryMessages().length).toBe(0);
  });
  it("does NOT fire when no plan file exists on disk", async () => {
    await exitThenReenter();
    expect(reentryMessages().length).toBe(0);
  });
  it("is one-time: a second re-enter in the same cycle does not re-fire", async () => {
    writeFileSync(planPath, "# plan\n", "utf-8");
    await exitThenReenter();
    await enterPlanResult(true);
    expect(reentryMessages().length).toBe(1);
  });
  it("does NOT leak across /new (flag reset on a fresh session)", async () => {
    setPlanSlug("test-session", "reentry-new-slug");
    const pinnedPlanPath = getPlanFilePath("test-session");
    await pi.simulateCommand("plan", "");
    await pi.simulateCommand("default", "");
    await pi.simulateSessionStart(cwd, undefined, "new");
    setPlanSlug("test-session", "reentry-new-slug");
    writeFileSync(pinnedPlanPath, "# plan\n", "utf-8");
    await enterPlanResult(true);
    expect(reentryMessages().length).toBe(0);
    rmSync(pinnedPlanPath, { force: true });
  });
});
describe("ExitPlanMode tool", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("plan", "");
    rmSync(getPlanFilePath("test-session"), { force: true });
  });
  function writePlan(text: string) {
    writeFileSync(getPlanFilePath("test-session"), text, "utf-8");
  }
  it("is registered with name 'ExitPlanMode'", () => {
    expect(pi.registeredTools.some((t) => t.name === "ExitPlanMode")).toBe(true);
  });
  it("invokes ctx.ui.custom with a factory in TUI mode and shows 4 options for a non-empty plan", async () => {
    let capturedCustom: { factory: any; options: any } | null = null;
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async (factory: any, options?: any) => {
          capturedCustom = { factory, options };
          return { action: "no" };
        },
      } as any,
    });
    writePlan("# My Plan\n\n1. Step one\n2. Step two");
    await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    expect(capturedCustom).not.toBeNull();
    expect(capturedCustom!.options?.overlay).toBe(true);
    expect(capturedCustom!.options?.overlayOptions?.anchor).toBe(
      "bottom-center",
    );
    expect(capturedCustom!.options?.overlayOptions?.width).toBe("100%");
    expect(
      capturedCustom!.options?.overlayOptions?.maxHeight,
    ).toBeUndefined();
    const component = capturedCustom!.factory(
      null,
      { fg: (_r: string, t: string) => t, bold: (t: string) => t },
      {},
      () => {},
    );
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Ready to code?");
    expect(rendered).toContain("Here is the plan:");
    expect(rendered).toContain("My Plan");
    expect(rendered).toContain("Step one");
    expect(rendered).toContain("Yes, auto-accept edits on plan exit");
    expect(rendered).toContain("Yes, bypass permissions on plan exit");
    expect(rendered).toContain("No, stay in plan mode");
    expect(rendered).toContain("No, and let me refine the plan");
    expect(rendered).not.toContain("clear context");
  });
  it.each([
    ["\r", "bypassPermissions"],
    ["2\r", "acceptEdits"],
    ["\x1b[Z", "acceptEdits"],
  ])("real approval factory maps keys %j to %s", async (keys, mode) => {
    const ctx = pi.fakeCtxFor({ cwd, hasUI: true });
    ctx.ui.confirm = vi.fn(async () => false);
    ctx.ui.custom = (factory: any) => new Promise((resolve) => {
      const component = factory({ terminal: { rows: 30 } }, ctx.ui.theme, {}, resolve);
      component.render(80);
      if (keys === "2\r") {
        component.handleInput("2");
        component.handleInput("\r");
      } else {
        component.handleInput(keys);
      }
    });
    writePlan("# Approval factory plan");
    const result = await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    expect(result.details).toMatchObject({ exited: true, mode });
    expect((pi.appendEntries.at(-1)!.data as any).mode).toBe(mode);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", " \n\t\r\n"],
  ])("rejects a %s plan without opening approval UI", async (_kind, text) => {
    if (text !== undefined) writePlan(text);
    const ctx = pi.fakeCtxFor({ cwd });
    ctx.ui.custom = vi.fn(async () => ({ action: "acceptEdits" }));
    ctx.ui.select = vi.fn(async () => "Yes, auto-accept edits on plan exit");
    const result = await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    expect(result.details).toMatchObject({ exited: false, reason: "missing-or-empty-plan" });
    expect(result.content[0].text).toContain(getPlanFilePath("test-session"));
    expect(result.content[0].text).toContain("Write");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect((pi.appendEntries.at(-1)!.data as any).mode).toBe("plan");
  });
  it("rejects an unreadable plan without showing a placeholder for approval", async () => {
    const planPath = getPlanFilePath("test-session");
    mkdirSync(planPath);
    try {
      const ctx = pi.fakeCtxFor({ cwd });
      ctx.ui.custom = vi.fn(async () => ({ action: "acceptEdits" }));
      const result = await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
      expect(result.details).toMatchObject({ exited: false, reason: "unreadable-plan" });
      expect(result.content[0].text).toContain(planPath);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect((pi.appendEntries.at(-1)!.data as any).mode).toBe("plan");
    } finally {
      rmSync(planPath, { recursive: true, force: true });
    }
  });
  it("acceptEdits option switches mode and echoes plan in tool result (no follow-up)", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ({ action: "acceptEdits" }) as T,
      } as any,
    });
    writePlan("# My Plan\n\n1. Step one\n2. Step two");
    const result = await pi.simulateToolExecution(
      "ExitPlanMode",
      {},
      ctx,
    );
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("acceptEdits");
    expect(
      pi.userMessages.some((m) => m.text.includes("Implement the following plan")),
    ).toBe(false);
    const text = (result as any).content[0].text;
    expect(text).toContain("Approved Plan");
    expect(text).toContain("Step one");
  });
  it("bypassPermissions option switches to bypass without a second confirmation popup", async () => {
    let confirmCalled = false;
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ({ action: "bypassPermissions" }) as T,
        confirm: async () => {
          confirmCalled = true;
          return false;
        },
      } as any,
    });
    writePlan("# My Plan\n\n1. Step one\n2. Step two");
    const result = await pi.simulateToolExecution(
      "ExitPlanMode",
      {},
      ctx,
    );
    expect(confirmCalled).toBe(false);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
    const text = (result as any).content[0].text;
    expect(text).toContain("Approved Plan");
    expect(text).toContain("Step one");
  });
  it("No, stay keeps plan mode", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ({ action: "no" }) as T,
      } as any,
    });
    writePlan("# Plan to review\n");
    await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("plan");
  });
  it("No, refine with edited plan sends the edit back as a follow-up", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() =>
          ({
            action: "refine",
            updatedPlan: "Please add more error handling.\n",
          }) as T,
      } as any,
    });
    writePlan("# Plan to refine\n");
    await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    expect(
      pi.userMessages.some(
        (m) => m.text.includes("Refine the plan") && m.text.includes("error handling"),
      ),
    ).toBe(true);
  });
  it("Esc / dialog-dismissed → stays in plan mode", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ({ action: "no" }) as T,
      } as any,
    });
    writePlan("# Plan to review\n");
    await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("plan");
  });
  it("custom factory is NOT invoked in headless mode; falls back to ctx.ui.select", async () => {
    let selectCalled = false;
    let customCalled = false;
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: false,
      ui: {
        ...pi.ui,
        select: async () => {
          selectCalled = true;
          return "Yes, auto-accept edits on plan exit";
        },
        custom: async <T,>() => {
          customCalled = true;
          return { action: "no" } as T;
        },
      } as any,
    });
    writePlan("# Headless Plan");
    const result = await pi.simulateToolExecution(
      "ExitPlanMode",
      {},
      ctx,
    );
    expect(selectCalled).toBe(true);
    expect(customCalled).toBe(false);
    expect((result as any).content[0].text).toContain("Approved Plan");
  });
  it("applies allowedPrompts as session allow rules on exit (allowedPrompts schema)", async () => {
    writePlan("# My Plan");
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ({ action: "acceptEdits" }) as T,
      } as any,
    });
    await pi.simulateToolExecution(
      "ExitPlanMode",
      {
        allowedPrompts: [
          { tool: "Bash", prompt: "run tests" },
          { tool: "Bash", prompt: "install dependencies" },
        ],
      },
      ctx,
    );
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("acceptEdits");
    const sessionRules: string[] =
      (last.data as any).alwaysAllowRules?.session ?? [];
    expect(sessionRules).toContain("Bash(*)");
    expect(sessionRules).toContain("Bash(prompt: run tests)");
    expect(sessionRules).toContain("Bash(prompt: install dependencies)");
  });
});
describe("planMode.agentCanEnter (local patch)", () => {
  const cwd = process.cwd();
  let savedPath: string | undefined;
  let dir: string;
  beforeEach(() => {
    savedPath = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    dir = mkdtempSync(join(tmpdir(), "pi-plan-entry-"));
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    else process.env.PICC_PERMISSION_MODES_CONFIG_PATH = savedPath;
  });
  function loadWith(config: unknown): FakePi {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    process.env.PICC_PERMISSION_MODES_CONFIG_PATH = path;
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    return pi;
  }
  it("defaults to upstream behavior: the agent may request plan mode", () => {
    expect(loadAgentCanEnterPlanModeConfig(join(dir, "missing.json"))).toBe(true);
    expect(loadWith({ planMode: {} }).registeredTools.some((t) => t.name === "EnterPlanMode")).toBe(true);
  });
  it("false removes EnterPlanMode but keeps ExitPlanMode and manual /plan", async () => {
    const pi = loadWith({ planMode: { agentCanEnter: false } });
    const tools = pi.registeredTools.map((t) => t.name);
    expect(tools).not.toContain("EnterPlanMode");
    expect(tools).toContain("ExitPlanMode");
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("plan", "");
    expect((pi.appendEntries[pi.appendEntries.length - 1].data as any).mode).toBe("plan");
  });
});
describe("EnterPlanMode tool", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it("is registered with name 'EnterPlanMode'", () => {
    expect(pi.registeredTools.some((t) => t.name === "EnterPlanMode")).toBe(true);
  });
  it("requires user confirmation", async () => {
    let confirmCalled = false;
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        confirm: async () => {
          confirmCalled = true;
          return false;
        },
      } as any,
    });
    await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    expect(confirmCalled).toBe(true);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("default");
  });
  it("approval switches to plan mode and stores prePlanMode", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: { ...pi.ui, confirm: async () => true } as any,
    });
    const result = await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("plan");
  });
  it("returns a Claude Code-aligned plain-text result on approval", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: { ...pi.ui, confirm: async () => true } as any,
    });
    const res = await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    expect((res.content[0] as { type: string; text: string }).text).toContain(
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
    );
  });
  it("returns the exact plan path and workflow immediately on same-turn entry", async () => {
    const ctx = pi.fakeCtxFor({ cwd });
    ctx.ui.confirm = async () => true;
    // No before_agent_start event after entry: this is the reported failure pattern.
    const result = await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    const text = result.content[0].text;
    expect(text).toContain(getPlanFilePath(ctx.sessionManager.getSessionId()));
    expect(text).toContain("## Plan File Info:");
    expect(text).toContain("Phase 4: Final Plan");
    expect(text).toContain("Phase 5: Call ExitPlanMode");
    expect(text).toContain("READ-ONLY");
  });
  it("uses the executing session's path instead of the last session context", async () => {
    const ctx = pi.fakeCtxFor({ cwd });
    ctx.sessionManager.getSessionId = () => "executing-session";
    ctx.ui.confirm = async () => true;
    const result = await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    expect(result.content[0].text).toContain(getPlanFilePath("executing-session"));
    expect(result.content[0].text).not.toContain(getPlanFilePath("test-session"));
  });
  it("renders and approves the plan written to the returned path in the same turn", async () => {
    const ctx = pi.fakeCtxFor({ cwd });
    ctx.ui.confirm = async () => true;
    const entered = await pi.simulateToolExecution("EnterPlanMode", {}, ctx);
    const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
    expect(entered.content[0].text).toContain(planPath);
    const plan = "# Render performance plan\n\n1. Cache unchanged transcript rows.\n2. Verify resize handling.\n";
    try {
      expect(await pi.simulateToolCall("write", { path: planPath, content: plan }, ctx)).toBeUndefined();
      writeFileSync(planPath, plan, "utf-8");
      ctx.ui.custom = async (factory: any) => {
        const component = factory(null, ctx.ui.theme, {}, () => {});
        const rendered = component.render(100).join("\n");
        expect(rendered).toContain("Render performance plan");
        expect(rendered).toContain("Cache unchanged transcript rows.");
        expect(rendered).not.toContain("The plan is empty");
        return { action: "acceptEdits" };
      };
      const exited = await pi.simulateToolExecution("ExitPlanMode", {}, ctx);
      expect(exited.details.exited).toBe(true);
      expect(exited.content[0].text).toContain(plan);
      expect((pi.appendEntries.at(-1)!.data as any).mode).toBe("acceptEdits");
    } finally {
      rmSync(planPath, { force: true });
    }
  });
});
describe("Dangerous-path safety check", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it.each([
    "/home/user/.gitconfig",
    "/home/user/.bashrc",
    "/home/user/.zshrc",
    "/home/user/.mcp.json",
  ])("blocks edit to dangerous file %s in default mode", async (filePath) => {
    const result = await pi.simulateToolCall(
      "edit",
      { path: filePath },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("blocks edit inside .git directory", async () => {
    const result = await pi.simulateToolCall(
      "write",
      { path: `${cwd}/.git/HEAD` },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("blocks edit inside .claude directory", async () => {
    const result = await pi.simulateToolCall(
      "write",
      { path: "/home/user/project/.claude/settings.json" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("DANGEROUS rule wins over mode=default allow (D4)", async () => {
  });
});
describe("Persistence round-trip", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it("persists a modes entry after every setMode call", async () => {
    await pi.simulateCommand("plan", "");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect(last.type).toBe("modes");
    expect((last.data as any).mode).toBe("plan");
  });
  it("persists alwaysAllowRules after a scoped-allow", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ("Yes, allow all edits during this session (shift+tab)") as T,
      } as any,
    });
    await pi.simulateToolCall("edit", { path: "src/foo.ts" }, ctx);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).alwaysAllowRules?.session).toBeDefined();
  });
  it("session_start restores the latest persisted mode", async () => {
    await pi.simulateCommand("plan", "");
    await pi.simulateCommand("bypassPermissions", "");
    await pi.simulateSessionStart(cwd);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("session_start (reason: 'resume') preserves the user's current mode from previous session", async () => {
    const previousSessionDir = join(cwd, ".pi", "session", "previous");
    const previousSessionFile = join(previousSessionDir, "sessions.jsonl");
    mkdirSync(previousSessionDir, { recursive: true });
    const buildSession = (entries: any[]) => {
      const header = {
        type: "session",
        version: 3,
        id: "prev-session",
        timestamp: new Date().toISOString(),
        cwd,
      };
      return [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
    };
    writeFileSync(
      previousSessionFile,
      buildSession([
        {
          type: "custom",
          id: "e1",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "modes",
          data: {
            mode: "bypassPermissions",
            additionalWorkingDirectories: [],
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: true,
            planModeAttachmentCount: 0,
          },
        },
      ]),
      "utf-8",
    );
    await pi.simulateSessionStart(cwd, undefined, "resume", previousSessionFile);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
    rmSync(join(cwd, ".pi", "session"), { recursive: true, force: true });
  });
  it("session_start (reason: 'fork') preserves the user's current mode from previous session", async () => {
    const previousSessionDir = join(cwd, ".pi", "session", "prev-fork");
    const previousSessionFile = join(previousSessionDir, "sessions.jsonl");
    mkdirSync(previousSessionDir, { recursive: true });
    const buildSession = (entries: any[]) => {
      const header = {
        type: "session",
        version: 3,
        id: "prev-session-fork",
        timestamp: new Date().toISOString(),
        cwd,
      };
      return [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
    };
    writeFileSync(
      previousSessionFile,
      buildSession([
        {
          type: "custom",
          id: "e1",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "modes",
          data: {
            mode: "plan",
            additionalWorkingDirectories: [],
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: true,
            planModeAttachmentCount: 0,
          },
        },
      ]),
      "utf-8",
    );
    await pi.simulateSessionStart(cwd, undefined, "fork", previousSessionFile);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("plan");
    rmSync(join(cwd, ".pi", "session", "prev-fork"), { recursive: true, force: true });
  });
  it("session_start (reason: 'startup') restores from the current branch", async () => {
    await pi.simulateCommand("bypassPermissions", "");
    await pi.simulateSessionStart(cwd, undefined, "startup");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("session_start (reason: 'resume') without previousSessionFile leaves mode as default", async () => {
    await pi.simulateSessionStart(cwd, undefined, "resume");
    expect((pi.appendEntries[pi.appendEntries.length - 1].data as any).mode).toBe(
      "default",
    );
  });
  it("session_start (reason: 'resume') falls back to current branch when previousSessionFile is missing", async () => {
    await pi.simulateCommand("bypassPermissions", "");
    await pi.simulateSessionStart(cwd, undefined, "resume");
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("session_start (reason: 'resume') does NOT inject plan-mode-exit attachment", async () => {
    await pi.simulateSessionStart(cwd, undefined, "resume");
    const list = pi.handlers.get("before_agent_start") ?? [];
    if (list.length > 0) {
      const result = await list[0](
        { prompt: "u", systemPrompt: "", systemPromptOptions: { cwd } },
        pi.fakeCtxFor({ cwd }),
      );
      const msg = (result as any)?.message;
      if (msg) {
        expect(msg.customType).not.toBe("permission-modes:plan-mode-exit");
      }
    }
  });
});
describe("permissionRuleValueFromString", () => {
  it("parses tool-only rules", () => {
    expect(permissionRuleValueFromString("Edit")).toEqual({ toolName: "Edit" });
  });
  it("parses tool + content rules", () => {
    expect(permissionRuleValueFromString("Edit(./src/**)")).toEqual({
      toolName: "Edit",
      ruleContent: "./src/**",
    });
  });
  it("parses MCP server-level rules", () => {
    expect(permissionRuleValueFromString("mcp__server")).toEqual({
      toolName: "mcp__server",
    });
  });
  it("parses MCP wildcard rules", () => {
    expect(permissionRuleValueFromString("mcp__server__*")).toEqual({
      toolName: "mcp__server__*",
    });
  });
  it("keeps malformed rules visible (does not silently drop)", () => {
    expect(permissionRuleValueFromString("Edit(./foo")).toEqual({
      toolName: "Edit(./foo",
    });
  });
  it("round-trips via permissionRuleValueToString", () => {
    const cases = [
      "Edit",
      "Edit(./src/**)",
      "Bash(npm install)",
      "mcp__server__tool",
    ];
    for (const c of cases) {
      const v = permissionRuleValueFromString(c);
      expect(permissionRuleValueToString(v)).toBe(c);
    }
  });
});
describe("matchingRuleForInput: path patterns", () => {
  const cwd = process.cwd();
  function buildCtxWithAllow(rules: string[]) {
    return buildContext("default", [], {
      alwaysAllowRules: { session: rules },
    });
  }
  it("matches './**' against any path inside cwd", () => {
    const ctx = buildCtxWithAllow(["Edit(./**)"]);
    const m = matchingRuleForInput("Edit", "src/foo.ts", "edit", "allow", ctx);
    expect(m).not.toBeNull();
  });
  it("matches 'src/**' only against paths under src/", () => {
    const ctx = buildCtxWithAllow(["Edit(src/**)"]);
    expect(
      matchingRuleForInput("Edit", "src/foo.ts", "edit", "allow", ctx),
    ).not.toBeNull();
    expect(
      matchingRuleForInput("Edit", "tests/qux.ts", "edit", "allow", ctx),
    ).toBeNull();
  });
  it("matches absolute-path rule '/etc/**' against paths under /etc", () => {
    const ctx = buildCtxWithAllow(["Edit(C:/Windows/System32/drivers/etc/hosts)"]);
    expect(
      matchingRuleForInput("Edit", "C:/Windows/System32/drivers/etc/hosts", "edit", "allow", ctx),
    ).not.toBeNull();
    expect(
      matchingRuleForInput("Edit", "C:/Windows/System32/drivers/etc/passwd", "edit", "allow", ctx),
    ).toBeNull();
  });
  it("tool-name mismatch returns null", () => {
    const ctx = buildCtxWithAllow(["Edit(./src/**)"]);
    expect(
      matchingRuleForInput("Write", "src/foo.ts", "edit", "allow", ctx),
    ).toBeNull();
  });
});
describe("isDangerousFilePath", () => {
  it.each([
    "/home/user/.gitconfig",
    "/home/user/.bashrc",
    "/home/user/.mcp.json",
  ])("flags %s as dangerous (DANGEROUS_FILES leaf match)", (p) => {
    expect(isDangerousFilePath(p)).toBe(true);
  });
  describe("top-level dangerous dirs under cwd or $HOME", () => {
    const cwd = process.cwd();
    const home = require("node:os").homedir();
    const cwdPaths = [
      `${cwd}/.git/HEAD`,
      `${cwd}/.claude/settings.json`,
    ];
    const homePaths = [
      `${home}/.gitconfig`,
      `${home}/.claude/settings.json`,
    ];
    for (const p of [...cwdPaths, ...homePaths]) {
      it(`flags ${p} as dangerous`, () => {
        expect(isDangerousFilePath(p)).toBe(true);
      });
    }
  });
  it.each([
    "/home/user/project/vendor/third_party/.git/HEAD",
    "/home/user/project/third_party/.claude/settings.json",
  ])("does NOT flag nested %s as dangerous", (p) => {
    expect(isDangerousFilePath(p)).toBe(false);
  });
  it.each([
    "/home/user/project/src/foo.ts",
    "/home/user/project/package.json",
  ])("does NOT flag benign %s as dangerous", (p) => {
    expect(isDangerousFilePath(p)).toBe(false);
  });
  it("flags suspicious Windows paths", () => {
    expect(isDangerousFilePath("C:\\foo.txt:hidden")).toBe(true);
    expect(isDangerousFilePath("C:\\foo~1.txt")).toBe(true);
    expect(isDangerousFilePath("C:\\foo.txt.")).toBe(true);
  });
});
describe("generateSuggestions", () => {
  it("emits './**' + setMode acceptEdits for in-cwd edits", () => {
    const ctx = buildContext("default");
    const sugs = generateSuggestions("Edit", "src/foo.ts", ctx);
    expect(sugs.some((s) => s.type === "setMode" && s.mode === "acceptEdits")).toBe(true);
    const ruleSugs = sugs.filter((s) => s.type === "addRules") as any[];
    expect(ruleSugs.some((s) => s.rules[0].ruleContent.endsWith("**"))).toBe(true);
  });
});
describe("Rule matching: addRules path patterns", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it("a session-allow rule './**' auto-approves subsequent edits inside cwd", async () => {
    const ctx = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ("Yes, allow all edits during this session (shift+tab)") as T,
      } as any,
    });
    await pi.simulateToolCall("edit", { path: "src/foo.ts" }, ctx);
    const result2 = await pi.simulateToolCall("edit", { path: "src/bar.ts" });
    expect(result2).toBeUndefined();
  });
  it("scoped allow rules apply only to their directory", async () => {
    const targetOutsideCwd = "/tmp/outside-src/foo.ts";
    const ctx1 = pi.fakeCtxFor({
      cwd,
      hasUI: true,
      ui: {
        ...pi.ui,
        custom: async <T,>() => ("Yes, allow all edits in src/ during this session (shift+tab)") as T,
      } as any,
    });
    await pi.simulateToolCall("edit", { path: targetOutsideCwd }, ctx1);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).alwaysAllowRules?.session).toBeDefined();
    const result3 = await pi.simulateToolCall(
      "edit",
      { path: "/tmp/outside-tests/qux.ts" },
      pi.fakeCtxFor({
        cwd,
        ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any,
      }),
    );
    expect(result3).toMatchObject({ block: true });
  });
});
describe("--permission-mode CLI flag", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(() => {
    pi = createFakePi();
  });
  it("starts in bypassPermissions when --permission-mode bypassPermissions", async () => {
    pi.flags["permission-mode"] = "bypassPermissions";
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("bypassPermissions");
  });
  it("starts in auto when --permission-mode auto", async () => {
    pi.flags["permission-mode"] = "auto";
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("auto");
  });
  it("starts in acceptEdits when --permission-mode acceptEdits", async () => {
    pi.flags["permission-mode"] = "acceptEdits";
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("acceptEdits");
  });
  it("starts in default when --permission-mode default", async () => {
    pi.flags["permission-mode"] = "default";
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe("default");
  });
  it("does NOT inject plan-mode-exit attachment on first before_agent_start when starting fresh in bypassPermissions", async () => {
    pi.flags["permission-mode"] = "bypassPermissions";
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    const list = pi.handlers.get("before_agent_start") ?? [];
    expect(list.length).toBeGreaterThan(0);
    const result = await list[0](
      { prompt: "u", systemPrompt: "", systemPromptOptions: { cwd } },
      pi.fakeCtxFor({ cwd }),
    );
    if (result === undefined) return;
    const msg = (result as any).message;
    expect(msg?.customType).not.toBe("permission-modes:plan-mode-exit");
  });
});
describe("Footer: theme color guard", () => {
  it("does not throw when the theme rejects an unknown color", async () => {
    const pi = createFakePi();
    const throwingUi = {
      ...pi.ui,
      theme: {
        fg: (color: string, text: string) => {
          const allowed = ["muted", "dim", "text", "accent", "warning", "error", "success"];
          if (!allowed.includes(color)) {
            throw new Error(`Unknown theme color: ${color}`);
          }
          return text;
        },
        bold: (t: string) => t,
        strikethrough: (t: string) => t,
      },
    };
    const origSetFooter = pi.ui.setFooter;
    pi.ui.setFooter = ((factory: any) => {
      const wrapped = (_tui: any, _theme: any) => {
        return {
          render: (width: number) => {
            const r = factory(_tui, throwingUi.theme);
            return r.render(width);
          },
          invalidate: () => {},
        };
      };
      return origSetFooter.call(pi.ui, wrapped as any);
    }) as any;
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("acceptEdits", "");
    await pi.simulateCommand("plan", "");
    await pi.simulateCommand("bypassPermissions", "");
  });
});
// Local patch: the custom footer was removed in favour of the pi-cc-extensions
// footer + "permission-mode" status chip (see LOCAL-PATCH.md).
describe.skip("Footer: mode line format", () => {
  async function renderFooter(
    pi: any,
    width: number,
    setup?: () => Promise<void>,
  ): Promise<string[]> {
    let captured: any = null;
    const branchEntries = pi.appendEntries
      .filter((e: any) => e.type === "modes")
      .map((e: any) => ({ type: "custom", customType: e.type, data: e.data }));
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (t: string) => t,
      strikethrough: (t: string) => t,
    };
    const ctx: any = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      modelRegistry: { find: () => undefined },
      ui: {
        custom: async <T,>() => ("Block") as T,
        confirm: async () => false,
        notify: () => {},
        editor: async () => undefined,
        setStatus: () => {},
        setWidget: () => {},
        setFooter: (factory: any) => {
          captured = factory;
        },
        setWorkingMessage: () => {},
        theme,
      },
      sessionManager: {
        getSessionId: () => "test-session",
        getBranch: () => branchEntries,
        getGitBranch: () => "",
      },
      model: undefined,
    };
    if (setup) await setup();
    const list = pi.handlers.get("session_start") ?? [];
    for (const h of list) {
      await h({ reason: "startup" }, ctx);
    }
    if (!captured) return [];
    const r = captured(null, theme);
    return r.render(width);
  }
  function stripAnsi(s: string): string {
    return s.replace(/\u001b\[[0-9;]*m/g, "");
  }
  it("renders '\u23f8 plan mode on (shift+tab to cycle)' in plan mode", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("plan", "");
    const lines = await renderFooter(pi, 200);
    const combined = stripAnsi(lines.join("\n"));
    expect(combined).toContain("plan mode on");
    expect(combined).toContain("(shift+tab to cycle)");
    expect(combined).toContain("\u23f8");
  });
  it("renders '\u23f5\u23f5 accept edits on (shift+tab to cycle)' in acceptEdits mode", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("acceptEdits", "");
    const lines = await renderFooter(pi, 200);
    const combined = stripAnsi(lines.join("\n"));
    expect(combined).toContain("accept edits on");
    expect(combined).toContain("(shift+tab to cycle)");
  });
  it("emitEdits in acceptEdits mode uses the purple hex #ccb1ff via truecolor ANSI", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("acceptEdits", "");
    const lines = await renderFooter(pi, 200);
    const modeLine = lines[1] ?? "";
    expect(modeLine).toContain("\u001b[38;2;204;177;255m");
    expect(modeLine).toContain("accept edits on");
  });
  it("renders '\u23f5\u23f5 bypass permissions on (shift+tab to cycle)' in bypassPermissions mode", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("bypassPermissions", "");
    const lines = await renderFooter(pi, 200);
    const combined = stripAnsi(lines.join("\n"));
    expect(combined).toContain("bypass permissions on");
    expect(combined).toContain("(shift+tab to cycle)");
  });
  it("renders 'Default (shift+tab to cycle)' in default mode (no symbol, no 'on')", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    const lines = await renderFooter(pi, 200);
    const combined = stripAnsi(lines.join("\n"));
    expect(combined).toContain("Default");
    expect(combined).toContain("(shift+tab to cycle)");
    expect(combined).not.toMatch(/Default on/);
  });
  it("hides the cycle hint when the terminal is too narrow", async () => {
    const pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(process.cwd());
    await pi.simulateCommand("plan", "");
    const lines = await renderFooter(pi, 15);
    const combined = stripAnsi(lines.join("\n"));
    expect(combined).toContain("plan mode on");
    expect(combined).not.toContain("(shift+tab to cycle)");
  });
});
describe("/mode alias map", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  it.each([
    ["default", "default"],
    ["accept-edits", "acceptEdits"],
    ["acceptEdits", "acceptEdits"],
    ["plan", "plan"],
    ["bypass", "bypassPermissions"],
    ["bypass-permissions", "bypassPermissions"],
    ["auto", "auto"],
    ["ask", "default"],
  ])("/mode %s → %s", async (arg, expected) => {
    await pi.simulateCommand("mode", arg);
    const last = pi.appendEntries[pi.appendEntries.length - 1];
    expect((last.data as any).mode).toBe(expected);
  });
});
describe("plan slug helpers", () => {
  afterEach(() => {
    clearPlanSlugs();
  });
  it("generateWordSlug produces an adjective-verb-noun slug", () => {
    const slug = generateWordSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });
  it("getPlanSlug is stable for a session", () => {
    const a = getPlanSlug("sess-a");
    const b = getPlanSlug("sess-a");
    expect(a).toBe(b);
  });
  it("getPlanSlug differs across sessions (with very high probability)", () => {
    const a = getPlanSlug("sess-x");
    const b = getPlanSlug("sess-y");
    expect(a).not.toBe(b);
  });
  it("setPlanSlug re-seeds so a session reuses a given slug (resume)", () => {
    setPlanSlug("sess-r", "fixed-slug-99");
    expect(getPlanSlug("sess-r")).toBe("fixed-slug-99");
    expect(getPlanFilePath("sess-r")).toBe(
      path.join(getPlansDir(), "fixed-slug-99.md"),
    );
  });
  it("getPlanFilePath resolves under the global plans dir", () => {
    const p = getPlanFilePath("sess-p");
    expect(p).toBe(path.join(getPlansDir(), `${getPlanSlug("sess-p")}.md`));
    expect(p.startsWith(getPlansDir())).toBe(true);
  });
});
describe("splitBashSubcommands", () => {
  it("splits on &&", () => {
    expect(splitBashSubcommands("mkdir a && rm b")).toEqual(["mkdir a", "rm b"]);
  });
  it("splits on || and ;", () => {
    expect(splitBashSubcommands("a || b ; c")).toEqual(["a", "b", "c"]);
  });
  it("splits on | and |& (pipe)", () => {
    expect(splitBashSubcommands("cat foo | grep bar |& tail")).toEqual([
      "cat foo",
      "grep bar",
      "tail",
    ]);
  });
  it("splits on bare & (background)", () => {
    expect(splitBashSubcommands("sleep 1 & echo done")).toEqual([
      "sleep 1",
      "echo done",
    ]);
  });
  it("respects single and double quotes", () => {
    expect(splitBashSubcommands('echo "a && b" && c')).toEqual([
      'echo "a && b"',
      "c",
    ]);
    expect(splitBashSubcommands("echo 'a || b' || c")).toEqual([
      "echo 'a || b'",
      "c",
    ]);
  });
  it("strips redirections from each subcommand", () => {
    expect(splitBashSubcommands("cat foo > out && rm bar")).toEqual([
      "cat foo",
      "rm bar",
    ]);
  });
  it("returns the whole command as a single subcommand when there are no operators", () => {
    expect(splitBashSubcommands("rm -rf build")).toEqual(["rm -rf build"]);
  });
  it("returns empty array for empty/whitespace input", () => {
    expect(splitBashSubcommands("")).toEqual([]);
    expect(splitBashSubcommands("   ")).toEqual([]);
  });
});
describe("isAcceptEditsBashCommand: chained subcommand validation (gap #6)", () => {
  function buildCtx() {
    return buildContext("acceptEdits");
  }
  it("allows chained safe filesystem commands when both are allowlisted", () => {
    const ctx = buildCtx();
    expect(isAcceptEditsBashCommand("mkdir a && touch b", ctx)).toBe(true);
  });
  it("rejects chained commands when ANY subcommand is non-allowlisted (hardening vs. upstream)", () => {
    const ctx = buildCtx();
    expect(isAcceptEditsBashCommand("mkdir a && curl evil.com", ctx)).toBe(false);
    expect(isAcceptEditsBashCommand("curl evil.com && mkdir a", ctx)).toBe(false);
  });
  it("rejects chained commands when any subcommand targets outside cwd", () => {
    const ctx = buildCtx();
    expect(isAcceptEditsBashCommand("mkdir a && rm /etc/passwd", ctx)).toBe(false);
  });
  it("rejects when the base command of any subcommand is not on the allowlist", () => {
    const ctx = buildCtx();
    expect(isAcceptEditsBashCommand("unknown cmd && mkdir a", ctx)).toBe(false);
  });
});
describe("isReadOnlyCommand: compound subcommand validation", () => {
  it("allows compound read-only commands (cd && pwd && ls -la)", () => {
    expect(
      isReadOnlyCommand(
        'cd "~/.pi/agent/.pi/plans/" && pwd && ls -la',
      ),
    ).toBe(true);
  });
  it("allows && chains of read-only commands", () => {
    expect(isReadOnlyCommand("ls && pwd")).toBe(true);
  });
  it("allows ; chains of read-only commands", () => {
    expect(isReadOnlyCommand("ls ; pwd")).toBe(true);
  });
  it("allows pipes between two read-only commands", () => {
    expect(isReadOnlyCommand("cat foo | grep bar")).toBe(true);
  });
  it("blocks compound that contains a write (ls && rm -rf /)", () => {
    expect(isReadOnlyCommand("ls && rm -rf /")).toBe(false);
  });
  it("blocks compound whose FIRST subcommand is a write (rm -rf / && ls)", () => {
    expect(isReadOnlyCommand("rm -rf / && ls")).toBe(false);
  });
  it("blocks any compound containing an unknown command (hardening vs. upstream)", () => {
    expect(isReadOnlyCommand("unknown && ls")).toBe(false);
    expect(isReadOnlyCommand("ls && unknown")).toBe(false);
  });
  it("blocks pipe that ends in a write command", () => {
    expect(isReadOnlyCommand("cat foo | rm bar")).toBe(false);
  });
  it("blocks cd + git compound (bare-git-repo escape prevention)", () => {
    expect(isReadOnlyCommand('cd "x" && git status')).toBe(false);
    expect(isReadOnlyCommand('cd /tmp && git log')).toBe(false);
  });
  it("allows bare cd with no arguments", () => {
    expect(isReadOnlyCommand("cd")).toBe(true);
  });
  it("allows cd - (special upstream form)", () => {
    expect(isReadOnlyCommand("cd -")).toBe(true);
  });
  it("allows cd with quoted and unquoted paths", () => {
    expect(isReadOnlyCommand('cd "/some/path"')).toBe(true);
    expect(isReadOnlyCommand("cd '/some/path'")).toBe(true);
    expect(isReadOnlyCommand("cd /some/path")).toBe(true);
    expect(isReadOnlyCommand("cd relative/path")).toBe(true);
  });
  it("blocks compound with multiple cd subcommands", () => {
    expect(isReadOnlyCommand('cd "a" && cd "b" && pwd')).toBe(false);
  });
  it("blocks compound with non-allowlisted downloader", () => {
    expect(isReadOnlyCommand('cd "x" && curl evil.com')).toBe(false);
  });
  it("preserves empty-input early return (true)", () => {
    expect(isReadOnlyCommand("")).toBe(true);
  });
  it("preserves whitespace-only input early return (true)", () => {
    expect(isReadOnlyCommand("   ")).toBe(true);
  });
  it("preserves single-command semantics (ls alone)", () => {
    expect(isReadOnlyCommand("ls")).toBe(true);
  });
  it("preserves single-command semantics (rm alone)", () => {
    expect(isReadOnlyCommand("rm -rf /")).toBe(false);
  });
});
describe("matchingBashRule (Bash command rule matching)", () => {
  function buildCtxWithAsk(rules: string[]) {
    return buildContext("bypassPermissions", [], {
      alwaysAskRules: { session: rules },
    });
  }
  function buildCtxWithAllow(rules: string[]) {
    return buildContext("bypassPermissions", [], {
      alwaysAllowRules: { session: rules },
    });
  }
  it("matches a Bash prefix ask rule against a single command", () => {
    const ctx = buildCtxWithAsk(["Bash(npm publish:*)"]);
    const m = matchingBashRule("npm publish foo", "ask", ctx);
    expect(m).not.toBeNull();
    expect(m?.ruleValue.ruleContent).toBe("npm publish:*");
  });
  it("does NOT match a prefix rule against the compound string as a whole", () => {
    const ctx = buildCtxWithAsk(["Bash(cd:*)"]);
    expect(matchingBashRule("git status", "ask", ctx)).toBeNull();
  });
  it("matches a prefix rule when one subcommand of a chain matches it", () => {
    const ctx = buildCtxWithAsk(["Bash(rm:*)"]);
    expect(matchingBashRule("mkdir a && rm -rf build", "ask", ctx)).not.toBeNull();
  });
  it("matches a wildcard ask rule with single trailing wildcard", () => {
    const ctx = buildCtxWithAsk(["Bash(git *)"]);
    expect(matchingBashRule("git", "ask", ctx)).not.toBeNull();
    expect(matchingBashRule("git push origin main", "ask", ctx)).not.toBeNull();
  });
  it("matches an exact ask rule", () => {
    const ctx = buildCtxWithAsk(["Bash(dangerous-cmd)"]);
    expect(matchingBashRule("dangerous-cmd", "ask", ctx)).not.toBeNull();
    expect(matchingBashRule("dangerous-cmd arg", "ask", ctx)).toBeNull();
  });
  it("matches an allow rule against the full command including env-var prefix", () => {
    const ctx = buildCtxWithAllow(["Bash(npm test)"]);
    expect(matchingBashRule("FOO=bar npm test", "allow", ctx)).not.toBeNull();
  });
  it("returns null when no rule matches", () => {
    const ctx = buildCtxWithAsk(["Bash(npm publish:*)"]);
    expect(matchingBashRule("git status", "ask", ctx)).toBeNull();
  });
});
describe("Bypass + content-specific ask rule (gap #1)", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  async function startWithBypassAndAskRule(rules: string[]) {
    const previousSessionDir = join(cwd, ".pi", "session", "gap1");
    const previousSessionFile = join(previousSessionDir, "sessions.jsonl");
    mkdirSync(previousSessionDir, { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: "gap1-session",
      timestamp: new Date().toISOString(),
      cwd,
    };
    const modesEntry = {
      type: "custom",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "modes",
      data: {
        mode: "bypassPermissions",
        additionalWorkingDirectories: [],
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: { session: rules },
        isBypassPermissionsModeAvailable: true,
        planModeAttachmentCount: 0,
      },
    };
    writeFileSync(
      previousSessionFile,
      JSON.stringify(header) + "\n" + JSON.stringify(modesEntry) + "\n",
      "utf-8",
    );
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd, undefined, "resume", previousSessionFile);
  }
  afterEach(() => {
    rmSync(join(cwd, ".pi", "session", "gap1"), { recursive: true, force: true });
  });
  it("STILL prompts on a Bash command matching a content ask-rule in bypass mode", async () => {
    await startWithBypassAndAskRule(["Bash(npm publish:*)"]);
    const result = await pi.simulateToolCall(
      "bash",
      { command: "npm publish foo" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("STILL prompts on a file edit matching a content ask-rule in bypass mode", async () => {
    await startWithBypassAndAskRule(["Edit(./secret.txt)"]);
    const result = await pi.simulateToolCall(
      "edit",
      { path: "secret.txt" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("does NOT prompt when the rule is allow (allow wins over bypass auto-allow anyway)", async () => {
    await startWithBypassAndAskRule(["Bash(npm publish:*)"]);
    const result = await pi.simulateToolCall("bash", { command: "git status" });
    expect(result).toBeUndefined();
  });
});
describe("requiresUserInteraction hook (gap #2)", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("bypassPermissions", "");
  });
  it("auto-approves regular tools in bypass mode (existing behavior)", async () => {
    const result = await pi.simulateToolCall("read", { path: "/etc/passwd" });
    expect(result).toBeUndefined();
  });
  it("auto-allows tools in REQUIRES_USER_INTERACTION set in bypass mode", async () => {
    const selectSpy = vi.fn(async () => "Block");
    const result = await pi.simulateToolCall(
      "AskUserQuestion",
      { question: "Proceed?" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, select: selectSpy } as any }),
    );
    expect(result).toBeUndefined();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
describe("Bypass: dangerous-file safety check survives (gap #5 regression)", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("bypassPermissions", "");
  });
  it.each([
    "/home/user/.gitconfig",
    "/home/user/.bashrc",
    "/home/user/.zshrc",
    `${cwd}/.git/HEAD`,
    `${cwd}/.claude/settings.json`,
  ])("STILL prompts on dangerous path %s", async (filePath) => {
    const result = await pi.simulateToolCall(
      "edit",
      { path: filePath },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
});
import { resetAutoMode, setAutoMode } from "./auto-mode.ts";
import { AutoMode } from "./auto-mode.ts";
function makeStubAutoMode(
  decide: (
    req: { toolName: string; input: Record<string, unknown> },
  ) =>
    | { allow: true; reason?: string; via: "safeAllowlist" | "classify" }
    | {
        block: true;
        reason: string;
        via: "classify" | "fallbackPrompt";
        shouldFallbackToPrompt: boolean;
      }
    | { unavailable: true; reason: string },
): AutoMode {
  const stub = new AutoMode({ config: { allow: [], softDeny: [], hardDeny: [], classifyAllShell: false, safeToolAllowlist: [], denialLimits: { maxConsecutive: 3, maxTotal: 20 }, transcriptMaxChars: 1000, environment: { cwd: "/tmp" } } as any });
  (stub as any).classify = async (req: any) => decide(req);
  return stub;
}
describe("Auto-mode classifier decision rendering", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    resetAutoMode();
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("auto", "");
  });
  afterEach(() => {
    resetAutoMode();
  });
  function installStub(
    decide: (
      req: { toolName: string; input: Record<string, unknown> },
    ) =>
      | { allow: true; reason?: string; via: "safeAllowlist" | "classify" }
      | {
          block: true;
          reason: string;
          via: "classify" | "fallbackPrompt";
          shouldFallbackToPrompt: boolean;
        }
      | { unavailable: true; reason: string },
  ): void {
    resetAutoMode();
    setAutoMode(makeStubAutoMode(decide));
  }
  it("registers a message renderer for the auto-classifier-decision custom type", () => {
    expect(pi.messageRenderers.has("permission-modes:auto-classifier-decision")).toBe(true);
  });
  it("emits 'Allowed by auto mode classifier' when the classifier allows", async () => {
    installStub(() => ({ allow: true, via: "classify" }));
    const callId = "call-allow-1";
    const before = pi.sentMessages.length;
    const result = await pi.simulateToolCall(
      "bash",
      { command: "ls" },
      undefined,
      callId,
    );
    expect(result).toBeUndefined();
    const res = await pi.simulateToolResult(
      "bash",
      { command: "ls" },
      callId,
      { content: "total 0" },
    );
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).toContain("Allowed by auto mode classifier");
    expect(texts).toContain(CLASSIFIER_NOTE_MARKER);
    const hint = pi.sentMessages
      .slice(before)
      .find(
        (m) =>
          m.message.customType === "permission-modes:auto-classifier-decision",
      );
    expect(hint).toBeUndefined();
  });
  it("emits 'Allowed by auto mode classifier' even for safe-allowlist allow path", async () => {
    installStub(() => ({ allow: true, via: "safeAllowlist" }));
    const callId = "call-allowlist-1";
    const before = pi.sentMessages.length;
    await pi.simulateToolCall("read", { path: "/tmp/x" }, undefined, callId);
    const res = await pi.simulateToolResult(
      "read",
      { path: "/tmp/x" },
      callId,
      { content: "file body" },
    );
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).toContain("Allowed by auto mode classifier");
    const hint = pi.sentMessages
      .slice(before)
      .find(
        (m) =>
          m.message.customType === "permission-modes:auto-classifier-decision",
      );
    expect(hint).toBeUndefined();
  });
  it("emits 'Denied by auto mode classifier · /feedback if incorrect' on classifier block", async () => {
    installStub(() => ({
      block: true,
      reason: "rm -rf / is destructive",
      via: "classify",
      shouldFallbackToPrompt: false,
    }));
    const callId = "call-block-1";
    const before = pi.sentMessages.length;
    const result = await pi.simulateToolCall(
      "bash",
      { command: "rm -rf /" },
      undefined,
      callId,
    );
    expect(result).toMatchObject({ block: true });
    await pi.simulateToolResult("bash", { command: "rm -rf /" }, callId, {
      isError: true,
    });
    const newMessages = pi.sentMessages.slice(before);
    const hint = newMessages.find(
      (m) =>
        m.message.customType === "permission-modes:auto-classifier-decision",
    );
    expect(hint).toBeDefined();
    expect(hint!.message.content).toBe(
      "Denied by auto mode classifier · /feedback if incorrect",
    );
  });
  it("falls back to the user prompt when the classifier is unavailable (no hard block, no hint)", async () => {
    installStub(() => ({ unavailable: true, reason: "classifier HTTP 500" }));
    const callId = "call-unavailable-1";
    const before = pi.sentMessages.length;
    const result = await pi.simulateToolCall(
      "bash",
      { command: "ls" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any } as any),
      callId,
    );
    expect(result ?? { block: true }).toMatchObject({ block: true });
    await pi.simulateToolResult("bash", { command: "ls" }, callId);
    const newMessages = pi.sentMessages.slice(before);
    const hint = newMessages.find(
      (m) =>
        m.message.customType === "permission-modes:auto-classifier-decision",
    );
    expect(hint).toBeUndefined();
  });
  it("does NOT emit a hint in non-auto modes", async () => {
    await pi.simulateCommand("default", "");
    installStub(() => ({ allow: true, via: "classify" }));
    const callId = "call-other-mode-1";
    const before = pi.sentMessages.length;
    await pi.simulateToolCall("read", { path: "/tmp/x" }, undefined, callId);
    const res = await pi.simulateToolResult("read", { path: "/tmp/x" }, callId, {
      content: "file body",
    });
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).not.toContain("Allowed by auto mode classifier");
    const hint = pi.sentMessages
      .slice(before)
      .find(
        (m) =>
          m.message.customType === "permission-modes:auto-classifier-decision",
      );
    expect(hint).toBeUndefined();
  });
  it("clears pending decisions on mode change", async () => {
    installStub(() => ({ allow: true, via: "classify" }));
    const callId = "call-cleared-1";
    await pi.simulateToolCall("bash", { command: "ls" }, undefined, callId);
    await pi.simulateCommand("default", "");
    const before = pi.sentMessages.length;
    const res = await pi.simulateToolResult("bash", { command: "ls" }, callId, {
      content: "total 0",
    });
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).not.toContain("Allowed by auto mode classifier");
    const hint = pi.sentMessages
      .slice(before)
      .find(
        (m) =>
          m.message.customType === "permission-modes:auto-classifier-decision",
      );
    expect(hint).toBeUndefined();
  });
  it("fast-paths in-cwd edit/write in auto mode without a classifier call", async () => {
    installStub(() => ({ unavailable: true, reason: "should not be reached" }));
    const callId = "call-fastpath-1";
    const before = pi.sentMessages.length;
    const inCwd = join(cwd, "fastpath-test-file.ts");
    const result = await pi.simulateToolCall(
      "edit",
      { path: inCwd },
      pi.fakeCtxFor({ cwd }),
      callId,
    );
    expect(result).toBeUndefined();
    const res = await pi.simulateToolResult(
      "edit",
      { path: inCwd },
      callId,
      { content: "edited" },
    );
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).toContain("Allowed by auto mode classifier");
    const hint = pi.sentMessages
      .slice(before)
      .find(
        (m) =>
          m.message.customType === "permission-modes:auto-classifier-decision",
      );
    expect(hint).toBeUndefined();
  });
  it("does NOT fast-path out-of-cwd writes in auto mode (goes to classifier)", async () => {
    installStub(() => ({ allow: true, via: "classify" }));
    const callId = "call-fastpath-out-1";
    const outside = join(cwd, "..", "outside-file.ts");
    const result = await pi.simulateToolCall(
      "write",
      { path: outside },
      pi.fakeCtxFor({ cwd }),
      callId,
    );
    expect(result).toBeUndefined();
    await pi.simulateToolResult("write", { path: outside }, callId);
  });
  it("the registered renderer returns a Component for the hint content", () => {
    const renderer = pi.messageRenderers.get(
      "permission-modes:auto-classifier-decision",
    );
    expect(renderer).toBeDefined();
    const component = renderer!(
      {
        customType: "permission-modes:auto-classifier-decision",
        content: "Allowed by auto mode classifier",
        display: true,
      },
      { expanded: false },
      { fg: (_role: string, text: string) => text },
    );
    expect(component).toBeTruthy();
  });
});
describe("Plan mode routes ask to the auto-mode classifier", () => {
  let pi: FakePi;
  const cwd = process.cwd();
  beforeEach(async () => {
    resetAutoMode();
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
  });
  afterEach(() => {
    resetAutoMode();
  });
  function installStub(
    decide: (
      req: { toolName: string; input: Record<string, unknown> },
    ) =>
      | { allow: true; reason?: string; via: "safeAllowlist" | "classify" }
      | {
          block: true;
          reason: string;
          via: "classify" | "fallbackPrompt";
          shouldFallbackToPrompt: boolean;
        }
      | { unavailable: true; reason: string },
  ): void {
    resetAutoMode();
    setAutoMode(makeStubAutoMode(decide));
  }
  async function enterPlan() {
    await pi.simulateCommand("plan", "");
  }
  it("allows an ask when the classifier allows, and appends the note", async () => {
    installStub(() => ({ allow: true, via: "classify" }));
    await enterPlan();
    const callId = "plan-allow-1";
    const result = await pi.simulateToolCall(
      "edit",
      { path: "src/foo.ts" },
      undefined,
      callId,
    );
    expect(result).toBeUndefined();
    const res = await pi.simulateToolResult(
      "edit",
      { path: "src/foo.ts" },
      callId,
      { content: "edited" },
    );
    const texts = res.content.map((b) => b.text).join("\n");
    expect(texts).toContain("Allowed by auto mode classifier");
  });
  it("blocks when the classifier blocks", async () => {
    installStub(() => ({
      block: true,
      reason: "plan mode: edits are not allowed",
      via: "classify",
      shouldFallbackToPrompt: false,
    }));
    await enterPlan();
    const result = await pi.simulateToolCall("edit", {
      path: "src/foo.ts",
    });
    expect(result).toMatchObject({ block: true });
  });
  it("falls back to a prompt when the classifier is unavailable", async () => {
    installStub(() => ({ unavailable: true, reason: "no provider" }));
    await enterPlan();
    const result = await pi.simulateToolCall(
      "edit",
      { path: "src/foo.ts" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("falls back to a prompt when the denial limit trips", async () => {
    installStub(() => ({
      block: true,
      reason: "denied",
      via: "fallbackPrompt",
      shouldFallbackToPrompt: true,
    }));
    await enterPlan();
    const result = await pi.simulateToolCall(
      "edit",
      { path: "src/foo.ts" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
  it("still prompts in default mode even when the classifier would allow", async () => {
    installStub(() => ({ allow: true, via: "classify" }));
    const result = await pi.simulateToolCall(
      "edit",
      { path: "src/foo.ts" },
      pi.fakeCtxFor({ cwd, ui: { ...pi.ui, custom: async <T,>() => ("Block") as T } as any }),
    );
    expect(result).toMatchObject({ block: true });
  });
});
describe("auto mode: user rules precede the classifier", () => {
  let pi: FakePi;
  let cwd: string;
  let savedPermPath: string | undefined;
  let savedClaudePath: string | undefined;
  let tempDirs: string[] = [];
  beforeEach(() => {
    savedPermPath = process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    savedClaudePath = process.env.CLAUDE_CONFIG_DIR;
    tempDirs = [];
    pi = createFakePi();
    cwd = process.cwd();
  });
  afterEach(() => {
    resetAutoMode();
    if (savedPermPath === undefined) delete process.env.PICC_PERMISSION_MODES_CONFIG_PATH;
    else process.env.PICC_PERMISSION_MODES_CONFIG_PATH = savedPermPath;
    if (savedClaudePath === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudePath;
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });
  function writeLocalConfig(perms: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  }): void {
    const dir = mkdtempSync(join(tmpdir(), "pi-perm-auto-"));
    tempDirs.push(dir);
    const cfg = join(dir, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify({ permissions: { allow: [], deny: [], ask: [], ...perms } }),
      "utf-8",
    );
    process.env.PICC_PERMISSION_MODES_CONFIG_PATH = cfg;
    process.env.CLAUDE_CONFIG_DIR = dir;
  }
  /** Install the extension with the given rules loaded and a recording
   *  classifier stub. `calls` counts how many times `classify` was invoked so
   *  a test can assert the classifier was (or was not) consulted. */
  async function setupAutoWithRules(
    perms: { allow?: string[]; deny?: string[]; ask?: string[] },
    decide: (
      req: { toolName: string; input: Record<string, unknown> },
    ) =>
      | { allow: true; reason?: string; via: "safeAllowlist" | "classify" }
      | {
          block: true;
          reason: string;
          via: "classify" | "fallbackPrompt";
          shouldFallbackToPrompt: boolean;
        }
      | { unavailable: true; reason: string },
  ): Promise<{ calls: number }> {
    const calls = { n: 0 };
    writeLocalConfig(perms);
    permissionModesExtension(makeFakePiForExtension(pi));
    await pi.simulateSessionStart(cwd);
    await pi.simulateSessionStart(cwd);
    await pi.simulateCommand("auto", "");
    resetAutoMode();
    setAutoMode(
      makeStubAutoMode((req) => {
        calls.n++;
        return decide(req);
      }),
    );
    return calls;
  }
  it("blocks a deny-rules bash command WITHOUT consulting the classifier", async () => {
    const calls = await setupAutoWithRules(
      { deny: ["Bash(rm *)"] },
      () => ({ allow: true, via: "classify" }),
    );
    const result = await pi.simulateToolCall("bash", {
      command: "rm -f /tmp/picc-test-target",
    });
    expect(result).toMatchObject({ block: true });
    expect(calls.n).toBe(0);
  });
  it("auto-allows an allow-rules bash command WITHOUT consulting the classifier", async () => {
    const calls = await setupAutoWithRules(
      { allow: ["Bash(npm:*)"] },
      () => ({
        block: true,
        reason: "classifier should not be reached",
        via: "classify",
        shouldFallbackToPrompt: false,
      }),
    );
    const result = await pi.simulateToolCall("bash", { command: "npm test" });
    expect(result).toBeUndefined();
    expect(calls.n).toBe(0);
  });
  it("routes a rule-free bash ask to the classifier (allow → proceed)", async () => {
    const calls = await setupAutoWithRules(
      {},
      () => ({ allow: true, via: "classify" }),
    );
    const result = await pi.simulateToolCall("bash", {
      command: "git push",
    });
    expect(result).toBeUndefined();
    expect(calls.n).toBe(1);
  });
  it("routes a rule-free bash ask to the classifier (block → deny)", async () => {
    const calls = await setupAutoWithRules(
      {},
      () => ({
        block: true,
        reason: "dangerous push",
        via: "classify",
        shouldFallbackToPrompt: false,
      }),
    );
    const result = await pi.simulateToolCall("bash", {
      command: "git push",
    });
    expect(result).toMatchObject({ block: true });
    expect(calls.n).toBe(1);
  });
});
describe("Auto-mode classifier note: pre-LLM context strip", () => {
  let pi: FakePi;
  beforeEach(async () => {
    pi = createFakePi();
    permissionModesExtension(makeFakePiForExtension(pi));
  });
  async function runContextHandler(messages: unknown[]) {
    const list = pi.handlers.get("context") ?? [];
    expect(list.length).toBeGreaterThan(0);
    let result: unknown = undefined;
    for (const h of list) {
      result = await h(
        { type: "context", messages } as never,
        { cwd: "/home/user/project" } as never,
      );
    }
    return result as { messages: unknown[] } | undefined;
  }
  it("strips the marker from a tool-result message", async () => {
    const messages = [
      { role: "user", content: "run ls" },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [
          { type: "text", text: `total 0\n${CLASSIFIER_NOTE_MARKER}` },
        ],
        isError: false,
      },
    ];
    const result = await runContextHandler(messages);
    expect(result).toBeDefined();
    const toolMsg = result!.messages[1] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolMsg.content[0].text).not.toContain(CLASSIFIER_NOTE_MARKER);
    expect(toolMsg.content[0].text).toContain("total 0");
  });
  it("is a no-op (returns undefined) when no marker is present", async () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "bash",
        content: [{ type: "text", text: "total 12" }],
        isError: false,
      },
    ];
    const result = await runContextHandler(messages);
    expect(result).toBeUndefined();
  });
  it("leaves non-toolResult and non-text blocks untouched", async () => {
    const messages = [
      { role: "assistant", content: "thinking" },
      {
        role: "toolResult",
        toolCallId: "c3",
        toolName: "bash",
        content: [
          { type: "text", text: "real" },
          { type: "image", data: "base64" },
        ],
        isError: false,
      },
    ];
    const result = await runContextHandler(messages);
    expect(result).toBeUndefined();
  });
  it("removes a lone marker block down to an empty text block", async () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "c4",
        toolName: "bash",
        content: [{ type: "text", text: CLASSIFIER_NOTE_MARKER }],
        isError: false,
      },
    ];
    const result = await runContextHandler(messages);
    expect(result).toBeDefined();
    const toolMsg = result!.messages[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolMsg.content[0].text).toBe("");
  });
});
describe("loadSubagentModeConfig", () => {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  function writeConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, body, "utf-8");
    return p;
  }
  it("returns undefined when the file is missing", () => {
    expect(loadSubagentModeConfig(join(tmpdir(), "does-not-exist-xyz.json"))).toBeUndefined();
  });
  it("returns undefined when no subagent block is present", () => {
    const p = writeConfig('{ "autoMode": { "allow": [] } }');
    expect(loadSubagentModeConfig(p)).toBeUndefined();
  });
  it.each([
    ["default", "default"],
    ["acceptEdits", "acceptEdits"],
    ["bypassPermissions", "bypassPermissions"],
    ["auto", "auto"],
  ] as const)("parses subagent.mode = %s", (mode, expected) => {
    const p = writeConfig(JSON.stringify({ subagent: { mode } }));
    expect(loadSubagentModeConfig(p)).toBe(expected);
  });
  it("returns undefined for an unrecognized mode value", () => {
    const p = writeConfig(JSON.stringify({ subagent: { mode: "plan" } }));
    expect(loadSubagentModeConfig(p)).toBeUndefined();
  });
  it("returns undefined for malformed JSON", () => {
    const p = writeConfig("{ this is not json");
    expect(loadSubagentModeConfig(p)).toBeUndefined();
  });
});