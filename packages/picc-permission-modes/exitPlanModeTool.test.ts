import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeExitPlanModeTool, OPTIONS_TUI } from "./exitPlanModeTool.ts";
import { getPlanFilePath } from "./utils.ts";

describe("ExitPlanMode invalid plan guard", () => {
  it.each([true, false])("keeps plan mode on read errors (hasUI=%s)", async (hasUI) => {
    const state = {
      planText: vi.fn(async () => { throw new Error("read failed"); }),
      applyExit: vi.fn(),
      applyRefine: vi.fn(),
    };
    const ctx = {
      hasUI,
      sessionManager: { getSessionId: () => "read-error-session" },
      ui: {
        custom: vi.fn(async () => ({ action: "acceptEdits" })),
        select: vi.fn(async () => "Yes, auto-accept edits on plan exit"),
      },
    } as unknown as ExtensionContext;
    const result = await makeExitPlanModeTool(state).execute(
      "exit", {}, new AbortController().signal, undefined, ctx,
    );
    expect(result.details).toMatchObject({ exited: false, reason: "unreadable-plan" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(getPlanFilePath("read-error-session")),
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(state.applyExit).not.toHaveBeenCalled();
    expect(state.applyRefine).not.toHaveBeenCalled();
  });

  it("rejects an empty plan in headless mode before requesting selection", async () => {
    const state = {
      planText: vi.fn(async () => " \n\t"),
      applyExit: vi.fn(),
      applyRefine: vi.fn(),
    };
    const ctx = {
      hasUI: false,
      sessionManager: { getSessionId: () => "empty-headless-session" },
      ui: { select: vi.fn(async () => "Yes, auto-accept edits on plan exit") },
    } as unknown as ExtensionContext;
    const result = await makeExitPlanModeTool(state).execute(
      "exit", {}, new AbortController().signal, undefined, ctx,
    );
    expect(result.details).toMatchObject({ exited: false, reason: "missing-or-empty-plan" });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(state.applyExit).not.toHaveBeenCalled();
  });
});


describe("ExitPlanMode tool option order", () => {
  it("keeps legacy TUI choices in bypass-first order", () => {
    expect(OPTIONS_TUI).toEqual([
      "Yes, bypass permissions on plan exit",
      "Yes, auto-accept edits on plan exit",
      "Stay in plan mode",
      "Request changes to the plan…",
    ]);
  });

  it.each([
    [0, "bypassPermissions"],
    [1, "acceptEdits"],
  ] as const)("maps headless choice %s to %s", async (index, mode) => {
    const state = {
      planText: vi.fn(async () => "# Approved plan"),
      applyExit: vi.fn(),
      applyRefine: vi.fn(),
    };
    const ctx = {
      hasUI: false,
      sessionManager: { getSessionId: () => "headless-order-session" },
      ui: {
        select: vi.fn(async (_title: string, choices: string[]) => choices[index]),
        custom: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const result = await makeExitPlanModeTool(state).execute(
      "exit", {}, new AbortController().signal, undefined, ctx,
    );
    expect(result.details).toMatchObject({ exited: true, mode });
    expect(state.applyExit).toHaveBeenCalledWith(ctx, {
      mode, plan: "# Approved plan", allowedPrompts: undefined,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});
