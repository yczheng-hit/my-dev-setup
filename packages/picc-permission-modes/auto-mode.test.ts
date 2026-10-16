import { describe, expect, it, vi } from "vitest";
import { AutoMode } from "./auto-mode.ts";
import { ClassifierHttpError, ClassifierTimeoutError } from "./auto-mode-provider.ts";
import type { AutoModeConfig } from "./auto-mode-config.ts";
function makeConfig(overrides: Partial<AutoModeConfig> = {}): AutoModeConfig {
  return {
    allow: [],
    softDeny: [],
    hardDeny: [],
    classifyAllShell: false,
    safeToolAllowlist: ["Read"],
    denialLimits: { maxConsecutive: 3, maxTotal: 20 },
    transcriptMaxChars: 200,
    environment: ["test environment"],
    ...overrides,
  };
}
function makeCtx(overrides: Record<string, unknown> = {}) {
  const model = { id: "test-model", baseUrl: "https://api.example.com" };
  return {
    cwd: "/tmp",
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    },
    ...overrides,
  };
}
const allowResponse = {
  id: "r",
  stopReason: "stop_sequence",
  text: "<block>no</block>",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};
const blockResponse = {
  id: "r",
  stopReason: "stop_sequence",
  text: "<block>yes</block><reason>destructive</reason>",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};
describe("AutoMode.classify — unavailable semantics", () => {
  it("returns unavailable when the provider cannot be resolved (no ctx, no config)", async () => {
    const am = new AutoMode({ config: makeConfig() });
    const res = await am.classify({ toolName: "bash", input: { command: "ls" }, sessionMessages: [] });
    expect(res).toMatchObject({ unavailable: true });
    expect(res).toMatchObject({ reason: expect.stringContaining("unconfigured") });
    expect(am.counters()).toMatchObject({ consecutive: 0, total: 0 });
  });
  it("returns unavailable when the HTTP call fails (not a denial)", async () => {
    const send = vi.fn().mockRejectedValue(new ClassifierHttpError(500, "boom"));
    const am = new AutoMode({ config: makeConfig(), sendFn: send });
    const res = await am.classify({
      toolName: "bash",
      input: { command: "ls" },
      sessionMessages: [],
      ctx: makeCtx() as any,
    });
    expect(res).toMatchObject({ unavailable: true });
    expect(res).toMatchObject({ reason: expect.stringContaining("500") });
    expect(am.counters()).toMatchObject({ consecutive: 0, total: 0 });
  });
  it("returns unavailable on timeout", async () => {
    const send = vi.fn().mockRejectedValue(new ClassifierTimeoutError(25000));
    const am = new AutoMode({ config: makeConfig(), sendFn: send });
    const res = await am.classify({
      toolName: "bash",
      input: { command: "ls" },
      sessionMessages: [],
      ctx: makeCtx() as any,
    });
    expect(res).toMatchObject({ unavailable: true });
    expect(res).toMatchObject({ reason: expect.stringContaining("timed out") });
  });
  it("still blocks (fail-closed) on an unparseable classifier response", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "r",
      stopReason: "end_turn",
      text: "I am not sure what to do.",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    const am = new AutoMode({ config: makeConfig(), sendFn: send });
    const res = await am.classify({
      toolName: "bash",
      input: { command: "ls" },
      sessionMessages: [],
      ctx: makeCtx() as any,
    });
    expect(res).toMatchObject({ block: true, via: "classify" });
    expect(res).toMatchObject({ reason: expect.stringContaining("no parseable response") });
    expect(am.counters()).toMatchObject({ consecutive: 1, total: 1 });
  });
});
describe("AutoMode.classify — denial limits", () => {
  it("trips the consecutive limit into fallbackPrompt and keeps total", async () => {
    const send = vi.fn().mockResolvedValue(blockResponse);
    const am = new AutoMode({
      config: makeConfig({ denialLimits: { maxConsecutive: 2, maxTotal: 100 } }),
      sendFn: send,
    });
    const req = { toolName: "bash", input: { command: "ls" }, sessionMessages: [], ctx: makeCtx() as any };
    const d1 = await am.classify(req);
    expect(d1).toMatchObject({ block: true, via: "classify" });
    const d2 = await am.classify(req);
    expect(d2).toMatchObject({ block: true, via: "fallbackPrompt", shouldFallbackToPrompt: true });
    expect(d2).toMatchObject({ reason: expect.stringContaining("denial limit reached") });
  });
  it("resets the total counter when the total limit trips (CC parity)", async () => {
    const send = vi.fn().mockResolvedValue(blockResponse);
    const am = new AutoMode({
      config: makeConfig({ denialLimits: { maxConsecutive: 100, maxTotal: 2 } }),
      sendFn: send,
    });
    const req = { toolName: "bash", input: { command: "ls" }, sessionMessages: [], ctx: makeCtx() as any };
    await am.classify(req);
    const d2 = await am.classify(req);
    expect(d2).toMatchObject({ block: true, via: "fallbackPrompt" });
    expect(am.counters().total).toBe(0);
  });
  it("a success resets the consecutive counter", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(blockResponse)
      .mockResolvedValueOnce(allowResponse)
      .mockResolvedValue(blockResponse);
    const am = new AutoMode({
      config: makeConfig({ denialLimits: { maxConsecutive: 2, maxTotal: 100 } }),
      sendFn: send,
    });
    const req = { toolName: "bash", input: { command: "ls" }, sessionMessages: [], ctx: makeCtx() as any };
    await am.classify(req);
    await am.classify(req);
    const d3 = await am.classify(req);
    expect(d3).toMatchObject({ block: true, via: "classify" });
  });
});
describe("AutoMode.classify — safe allowlist", () => {
  it("allowlists by case-insensitive name without an API call", async () => {
    const send = vi.fn();
    const am = new AutoMode({ config: makeConfig(), sendFn: send });
    const res = await am.classify({ toolName: "read", input: { path: "/x" }, sessionMessages: [] });
    expect(res).toMatchObject({ allow: true, via: "safeAllowlist" });
    expect(send).not.toHaveBeenCalled();
  });
});
describe("AutoMode — classifier request shape", () => {
  it("excludes assistant text, keeps user text and tool_use; trims from the front", async () => {
    const send = vi.fn().mockResolvedValue(allowResponse);
    const am = new AutoMode({
      config: makeConfig({ transcriptMaxChars: 300 }),
      sendFn: send,
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: "please do the thing" }] },
      { role: "assistant", content: [{ type: "text", text: "SECRET PROSE NOT FOR CLASSIFIER" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
      },
    ];
    await am.classify({
      toolName: "bash",
      input: { command: "pwd" },
      sessionMessages: messages,
      ctx: makeCtx() as any,
    });
    expect(send).toHaveBeenCalledOnce();
    const [, req] = send.mock.calls[0] as [unknown, { user: string }];
    expect(req.user).toContain('"user":"please do the thing"');
    expect(req.user).not.toContain("SECRET PROSE NOT FOR CLASSIFIER");
    expect(req.user).toContain('"bash":{"command":"ls"}');
    expect(req.user).toContain("Proposed action:");
  });
  it("trims oldest lines when the transcript exceeds the budget", async () => {
    const send = vi.fn().mockResolvedValue(allowResponse);
    const am = new AutoMode({
      config: makeConfig({ transcriptMaxChars: 60 }),
      sendFn: send,
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: "X".repeat(60) }] },
      { role: "user", content: [{ type: "text", text: "RECENT MESSAGE" }] },
    ];
    await am.classify({
      toolName: "bash",
      input: { command: "pwd" },
      sessionMessages: messages,
      ctx: makeCtx() as any,
    });
    const [, req] = send.mock.calls[0] as [unknown, { user: string }];
    expect(req.user).not.toContain("XXXXXXXX");
    expect(req.user).toContain("RECENT MESSAGE");
  });
  it("wraps AGENTS.md/CLAUDE.md content in <user_instructions> before the transcript", async () => {
    const send = vi.fn().mockResolvedValue(allowResponse);
    const am = new AutoMode({ config: makeConfig(), sendFn: send });
    await am.classify({
      toolName: "bash",
      input: { command: "pwd" },
      sessionMessages: [],
      ctx: makeCtx({ cwd: "/tmp" }) as any,
    });
    const [, req] = send.mock.calls[0] as [unknown, { user: string }];
    expect(req.user).not.toContain("<user_instructions>");
  });
});
