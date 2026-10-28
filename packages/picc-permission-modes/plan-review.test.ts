import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeExitPlanModeTool } from "./exitPlanModeTool.ts";
import { dialogOptionsFor } from "./exitPlanModeDialog.ts";
import { getPlanFilePath } from "./utils.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function review(keys: string[], feedback: Array<string | undefined> = []) {
  // Never launch external editors or read real user configuration in unit tests.
  vi.stubEnv("EDITOR", ""); vi.stubEnv("VISUAL", "");
  const dir = mkdtempSync(path.join(tmpdir(), "picc-review-")); dirs.push(dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const sessionId = path.basename(dir);
  const file = getPlanFilePath(sessionId);
  writeFileSync(file, "# Original plan\n");
  let overlayOpen = false;
  const theme = { fg: (_name: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s, underline: (s: string) => s, strikethrough: (s: string) => s };
  const state = { planText: vi.fn(async () => readFileSync(file, "utf8")), applyExit: vi.fn(), applyRefine: vi.fn() };
  const ui = {
    theme, notify: vi.fn(), select: vi.fn(),
    editor: vi.fn(async () => { expect(overlayOpen, "approval must release focus before opening an editor").toBe(false); return feedback.shift(); }),
    custom: vi.fn(async (factory: any) => new Promise((resolve) => {
      overlayOpen = true;
      const dialog = factory({ terminal: { rows: 30 }, requestRender: vi.fn() }, theme, {}, (result: unknown) => { overlayOpen = false; resolve(result); });
      dialog.render(100);
      const key = keys.shift();
      if (key === "refine") { dialog.handleInput("4"); dialog.handleInput("\r"); }
      else if (key === "edit") dialog.handleInput("\x07");
      else if (key === "cancel") dialog.handleInput("\x1b");
      else if (key === "stay") { dialog.handleInput("3"); dialog.handleInput("\r"); }
      else if (key === "accept") dialog.handleInput("\r");
      else throw new Error("Unexpected extra approval dialog");
    })),
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getSessionId: () => sessionId } };
  const run = () => makeExitPlanModeTool(state).execute("review", {}, new AbortController().signal, undefined, ctx as any);
  return { run, state, ui, ctx, file };
}

describe("plan review lifecycle (local patch)", () => {
  it("gives non-approval choices distinct action labels", () => {
    expect(dialogOptionsFor("Plan").map(x => x.label)).toEqual([
      "Yes, bypass permissions on plan exit", "Yes, auto-accept edits on plan exit",
      "Stay in plan mode", "Request changes to the plan…",
    ]);
  });
  it("closes approval before feedback input and returns feedback without a queued run", async () => {
    const { run, ui, state } = review(["refine"], ["Add rollback tests"]);
    const result = await run();
    expect(ui.editor).toHaveBeenCalledWith("Refine plan — what should change?");
    expect(JSON.stringify(result.content)).toContain("Add rollback tests");
    expect(result.details).toMatchObject({ exited: false, choice: "refine" });
    expect(state.applyExit).not.toHaveBeenCalled();
    expect(state.applyRefine).not.toHaveBeenCalled();
    expect(result.terminate).not.toBe(true);
  }, 1500);
  it.each([undefined, "", "   "])("cancelled refinement (%s) stops the turn and preserves the plan", async (feedback) => {
    const { run, file, state } = review(["refine"], [feedback]);
    const result = await run();
    expect(result.details).toMatchObject({ exited: false, choice: "refine-cancelled" });
    expect(result.terminate).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("# Original plan\n");
    expect(state.applyExit).not.toHaveBeenCalled();
    expect(state.applyRefine).not.toHaveBeenCalled();
  }, 1500);
  it.each(["cancel", "stay"])("%s ends the turn instead of reopening approval", async (key) => {
    const { run, ui } = review([key]);
    const result = await run();
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ exited: false, choice: "stay" });
    expect(ui.editor).not.toHaveBeenCalled();
  });
  it("Ctrl+G closes approval, edits with Pi, then approves the saved edit", async () => {
    const { run, ui, file, state, ctx } = review(["edit", "accept"], ["# Edited plan\n"]);
    const result = await run();
    expect(ui.editor).toHaveBeenCalledWith("Edit plan", "# Original plan\n");
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(readFileSync(file, "utf8")).toBe("# Edited plan\n");
    expect(state.applyExit).toHaveBeenCalledWith(ctx, { mode: "bypassPermissions", plan: "# Edited plan\n", allowedPrompts: undefined });
    expect(result.details.exited).toBe(true);
  }, 1500);
  it.each([undefined, "", "   "])("cancelled/empty edit (%s) reopens approval without damaging the plan", async (edit) => {
    const { run, ui, file } = review(["edit", "cancel"], [edit]);
    const result = await run();
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(readFileSync(file, "utf8")).toBe("# Original plan\n");
    expect(result.terminate).toBe(true);
    if (edit !== undefined) expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cannot be empty"), "warning");
  }, 1500);
  it("RPC uses its supported selector, not a terminal overlay", async () => {
    const { run, ui, ctx } = review([]);
    ctx.mode = "rpc";
    ui.select.mockResolvedValue("Stay in plan mode");
    const result = await run();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledOnce();
    expect(result.terminate).toBe(true);
  });
});
