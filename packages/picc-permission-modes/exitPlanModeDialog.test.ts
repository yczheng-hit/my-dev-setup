import { describe, expect, it } from "vitest";
import {
  dialogOptionsFor,
  ExitPlanModeDialog,
  type ExitPlanModeDialogResult,
} from "./exitPlanModeDialog.ts";
import type { MarkdownTheme, TuiMouseEvent } from "@earendil-works/pi-tui";
import { dispatchMouseEvent } from "@earendil-works/pi-tui/dist/tui.js";
/** A no-op theme: every color/font function returns the plain input string.
 *  Lets us assert about output structure without ANSI noise. */
const stubDialogTheme = {
  title: (t: string) => t,
  sectionLabel: (t: string) => t,
  optionSelected: (t: string) => t,
  optionDefault: (t: string) => t,
  optionHint: (t: string) => t,
  hint: (t: string) => t,
  hintDim: (t: string) => t,
  border: (t: string) => t,
  emptyPlan: (t: string) => t,
  overflowMarker: (t: string) => t,
};
const stubMarkdownTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => `* ${t}`,
  bold: (t) => t,
  italic: (t) => t,
  underline: (t) => t,
  strikethrough: (t) => t,
};
function makeDialog(
  planText: string,
  editorPlanContent?: string,
  terminalRows: number = 30,
): {
  dialog: ExitPlanModeDialog;
  finishPromise: Promise<ExitPlanModeDialogResult | undefined>;
} {
  let resolveDone: (r: ExitPlanModeDialogResult) => void = () => {};
  const finishPromise = new Promise<ExitPlanModeDialogResult | undefined>(
    (resolve) => {
      resolveDone = resolve;
    },
  );
  const onEditorLaunch = async () => editorPlanContent;
  const dialog = new ExitPlanModeDialog(
    planText,
    "/tmp/plan.md",
    [...dialogOptionsFor(planText)],
    stubDialogTheme,
    stubMarkdownTheme,
    (r) => resolveDone(r),
    onEditorLaunch,
    () => terminalRows,
  );
  return {
    dialog,
    finishPromise: finishPromise as Promise<ExitPlanModeDialogResult | undefined>,
  };
}
function longPlan(lines: number): string {
  const out: string[] = ["# Long Plan", ""];
  for (let i = 1; i <= lines; i++) {
    out.push(`${i}. Step number ${i} with some body text to make it taller`);
  }
  return out.join("\n");
}
function wheelEvent(delta: number | undefined, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "wheel", button: "none",
    x: 10, y: 6, screenX: 10, screenY: 6,
    width: 80, height: 20,
    shift: false, alt: false, ctrl: false,
    wheelDelta: delta,
    ...overrides,
  };
}

describe("ExitPlanModeDialog.handleMouse", () => {
  it("scrolls down and up by Pi's normalized wheel delta", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const initial = dialog.render(80).join("\n");
    expect(initial).toContain("▼ 1-6 of 102");
    expect(initial).toContain("mouse wheel");
    expect(dialog.handleMouse(wheelEvent(3))).toEqual({ handled: true, render: true });
    expect(dialog.render(80).join("\n")).toContain("▼ 4-9 of 102");
    expect(dialog.handleMouse(wheelEvent(-3))).toEqual({ handled: true, render: true });
    expect(dialog.render(80).join("\n")).toBe(initial);
  });
  it.each(["Short plan", longPlan(5), "", " \n\t"])(
    "consumes wheels without redrawing a fitting or empty plan (%s)", (plan) => {
      const { dialog } = makeDialog(plan, undefined, 20);
      const initial = dialog.render(80);
      expect(initial.join("\n")).not.toContain("PgUp/PgDn to scroll");
      for (const delta of [100, -100]) {
        expect(dialog.handleMouse(wheelEvent(delta, { height: initial.length }))).toEqual({
          handled: true, render: false,
        });
        expect(dialog.render(80)).toBe(initial);
      }
    },
  );
  it.each([{ x: -1 }, { x: 80 }, { y: -1 }, { y: 20 }])(
    "ignores wheel events outside the dialog bounds (%j)", (coordinates) => {
      const { dialog } = makeDialog(longPlan(100), undefined, 20);
      const initial = dialog.render(80);
      expect(dialog.handleMouse(wheelEvent(3, coordinates))).toBeUndefined();
      expect(dialog.render(80)).toBe(initial);
    },
  );
  it("clamps at both boundaries and suppresses no-op redraws", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const initial = dialog.render(80);
    expect(dialog.handleMouse(wheelEvent(-10000))).toEqual({ handled: true, render: false });
    expect(dialog.render(80)).toBe(initial);
    expect(dialog.handleMouse(wheelEvent(10000))).toEqual({ handled: true, render: true });
    const atEnd = dialog.render(80);
    expect(atEnd.join("\n")).toContain("▼ 97-102 of 102");
    expect(dialog.handleMouse(wheelEvent(10000))).toEqual({ handled: true, render: false });
    expect(dialog.render(80)).toBe(atEnd);
    expect(dialog.handleMouse(wheelEvent(-10000))).toEqual({ handled: true, render: true });
    expect(dialog.render(80)).toEqual(initial);
  });

  it.each([0, undefined])("consumes a wheel delta of %s without redrawing", (delta) => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const initial = dialog.render(80);
    expect(dialog.handleMouse(wheelEvent(delta))).toEqual({ handled: true, render: false });
    expect(dialog.render(80)).toBe(initial);
  });

  it.each([1, 14, 18])(
    "keeps the header, approval selection and footer fixed when wheeling over row %s", async (y) => {
      const { dialog, finishPromise } = makeDialog(longPlan(100), undefined, 20);
      dialog.handleInput("2");
      const initial = dialog.render(80);
      expect(initial.join("\n")).toContain("▶ 2. Yes, auto-accept edits");
      // Alt acceleration is already included by Pi: don't multiply the delta again.
      expect(dialog.handleMouse(wheelEvent(6, { y, alt: true }))).toEqual({ handled: true, render: true });
      const scrolled = dialog.render(80);
      expect(scrolled.join("\n")).toContain("▼ 7-12 of 102");
      expect(scrolled.slice(0, 5)).toEqual(initial.slice(0, 5));
      expect(scrolled.slice(-8)).toEqual(initial.slice(-8));
      dialog.handleInput("\r");
      await expect(finishPromise).resolves.toEqual({ action: "acceptEdits" });
    },
  );

  it.each(["press", "release", "move", "drag", "click"] as const)(
    "does not handle non-wheel %s events", (type) => {
      const { dialog } = makeDialog(longPlan(100), undefined, 20);
      const initial = dialog.render(80);
      expect(dialog.handleMouse(wheelEvent(3, { type }))).toBeUndefined();
      expect(dialog.render(80)).toBe(initial);
    },
  );

  it("ignores mouse events after the dialog closes", async () => {
    const { dialog, finishPromise } = makeDialog(longPlan(100), undefined, 20);
    const initial = dialog.render(80);
    dialog.handleInput("\x1b");
    await expect(finishPromise).resolves.toEqual({ action: "no" });
    expect(dialog.handleMouse(wheelEvent(3))).toBeUndefined();
    expect(dialog.render(80)).toBe(initial);
  });

  it("uses real Pi mouse dispatch, retains the overlay target and consumes boundary wheels", async () => {
    const { dialog, finishPromise } = makeDialog(longPlan(100), undefined, 20);
    dialog.render(80);
    const dispatched = dispatchMouseEvent(dialog, wheelEvent(3, { screenX: 12, screenY: 10 }));
    expect(dispatched).toMatchObject({ handled: true, render: true });
    expect(dispatched?.target).toEqual({
      component: dialog, originX: 2, originY: 4, width: 80, height: 20,
    });
    expect(dialog.render(80).join("\n")).toContain("▼ 4-9 of 102");
    expect(dispatchMouseEvent(dialog, wheelEvent(-10000))).toMatchObject({ handled: true, render: true });
    expect(dispatchMouseEvent(dialog, wheelEvent(-10000))).toMatchObject({ handled: true, render: false });
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({ action: "bypassPermissions" });
    expect(dispatchMouseEvent(dialog, wheelEvent(3))).toBeUndefined();
  });
});

describe("ExitPlanModeDialog.render", () => {
  it("renders the title, 'Here is the plan:' label, plan content, and 4 options for a non-empty plan", () => {
    const { dialog } = makeDialog("# Hello\n\nA short plan.\n\n1. Step one\n2. Step two");
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Ready to code?");
    expect(out).toContain("Here is the plan:");
    expect(out).toContain("Hello");
    expect(out).toContain("A short plan");
    expect(out).toContain("Step one");
    expect(out).toContain("Step two");
    expect(out).toContain("Yes, auto-accept edits on plan exit");
    expect(out).toContain("Yes, bypass permissions on plan exit");
    expect(out).toContain("No, stay in plan mode");
    expect(out).toContain("No, and let me refine the plan");
    expect(out).toContain("ctrl-g to edit in $EDITOR");
    expect(out).toContain("Plan saved to:");
    expect(out).toContain("plan.md");
  });
  it("renders the empty-plan variant with 2 options and a 'ctrl-g to write a plan' hint", () => {
    const { dialog } = makeDialog("   \n\n  ");
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Ready to code?");
    expect(out).toContain("The plan is empty");
    expect(out).toContain("Yes, proceed without a plan");
    expect(out).toContain("No, stay in plan mode");
    expect(out).not.toContain("bypass permissions");
    expect(out).not.toContain("auto-accept edits");
    expect(out).toContain("ctrl-g to write a plan in $EDITOR");
  });
  it("marks the first option with the ▶ selected glyph by default", () => {
    const { dialog } = makeDialog("Plan");
    const out = dialog.render(80).join("\n");
    const firstLineWithYes = out
      .split("\n")
      .find((l) => l.includes("Yes, bypass permissions"));
    expect(firstLineWithYes).toBeDefined();
    expect(firstLineWithYes!.startsWith("▶ ")).toBe(true);
  });
  it("caches the render output for the same width", () => {
    const { dialog } = makeDialog("Plan");
    const a = dialog.render(80);
    const b = dialog.render(80);
    expect(a).toBe(b);
  });
});
describe("ExitPlanModeDialog.handleInput", () => {

  it("Enter defaults to bypass permissions", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    expect(dialog.render(80).join("\n")).toContain("▶ 1. Yes, bypass permissions on plan exit   enter");
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({ action: "bypassPermissions" });
  });
  it("Esc → { action: 'no' }", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("\x1b");
    await expect(finishPromise).resolves.toEqual({ action: "no" });
  });
  it("Shift+Tab → { action: 'acceptEdits' } (Claude Code shortcut)", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("\x1b[Z");
    await expect(finishPromise).resolves.toEqual({ action: "acceptEdits" });

    expect(dialog.render(80).join("\n")).toContain("▶ 2. Yes, auto-accept edits on plan exit   shift+tab");
  });
  it("Enter on second option (selectedIndex = 1) → { action: 'acceptEdits' }", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({
      action: "acceptEdits",
    });
  });
  it("Enter on No, stay → { action: 'no' }", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({ action: "no" });
  });
  it("Enter on the refine option opens the editor and returns { action: 'refine', updatedPlan }", async () => {
    const { dialog, finishPromise } = makeDialog("Plan", "refined content");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({
      action: "refine",
      updatedPlan: "refined content",
    });
  });
  it("Up arrow clamps at 0 (does not underflow)", () => {
    const { dialog } = makeDialog("Plan");
    dialog.handleInput("\x1b[A");
    dialog.handleInput("\x1b[A");
    const out = dialog.render(80).join("\n");
    const bypassLine = out
      .split("\n")
      .find((l) => l.includes("Yes, bypass permissions"));
    expect(bypassLine!.startsWith("▶ ")).toBe(true);
  });
  it("Down arrow clamps at last option (does not overflow)", () => {
    const { dialog } = makeDialog("Plan");
    for (let i = 0; i < 20; i++) dialog.handleInput("\x1b[B");
    const out = dialog.render(80).join("\n");
    const refineLine = out
      .split("\n")
      .find((l) => l.includes("No, and let me refine"));
    expect(refineLine!.startsWith("▶ ")).toBe(true);
  });
  it("Number key '2' selects accept edits, and Enter confirms it", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("2");
    const out = dialog.render(80).join("\n");
    const acceptLine = out
      .split("\n")
      .find((l) => l.includes("Yes, auto-accept edits"));
    expect(acceptLine!.startsWith("▶ 2.")).toBe(true);
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({ action: "acceptEdits" });
  });
  it("Ctrl+G updates planText but does NOT close the dialog", async () => {
    const { dialog, finishPromise } = makeDialog("Original", "Updated text");
    let raceResult: ExitPlanModeDialogResult | "pending" = "pending";
    void finishPromise.then((r) => {
      if (r) raceResult = r;
    });
    dialog.handleInput("\x07");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(raceResult).toBe("pending");
    dialog.handleInput("\r");
    await expect(finishPromise).resolves.toEqual({ action: "bypassPermissions" });
  });
  it("done() is idempotent: pressing Esc then Enter only resolves once", async () => {
    const { dialog, finishPromise } = makeDialog("Plan");
    dialog.handleInput("\x1b");
    dialog.handleInput("\r");
    const result = await finishPromise;
    expect(result).toEqual({ action: "no" });
  });
});
describe("dialogOptionsFor", () => {
  it("returns 4 options for non-empty plan text", () => {
    expect(dialogOptionsFor("anything")).toHaveLength(4);
    expect(dialogOptionsFor("# Heading")).toHaveLength(4);
  });
  it("returns 2 options for empty / whitespace-only plan text", () => {
    expect(dialogOptionsFor("")).toHaveLength(2);
    expect(dialogOptionsFor("   \n\n")).toHaveLength(2);
  });
});
describe("ExitPlanModeDialog layout (full-width overlay)", () => {
  it("renders 'Ready to code?' at the top, plan content inline, and options at the bottom", () => {
    const { dialog } = makeDialog("# My Plan\n\nBody text", undefined);
    const lines = dialog.render(80);
    const out = lines.join("\n");
    expect(lines[1]).toBe("Ready to code?");
    expect(out).toContain("Here is the plan:");
    expect(out).toContain("My Plan");
    expect(out).toContain("Body text");
    expect(lines.some((l) => l.startsWith("┌"))).toBe(false);
    expect(lines.some((l) => l.startsWith("└"))).toBe(false);
    expect(lines.some((l) => l.startsWith("│"))).toBe(false);
    expect(lines[0]!.match(/^─+$/)).not.toBeNull();
    expect(lines[lines.length - 1]!.match(/^─+$/)).not.toBeNull();
    const lastLines = lines.slice(-10).join("\n");
    expect(lastLines).toContain("Yes, auto-accept edits on plan exit");
    expect(lastLines).toContain("Yes, bypass permissions on plan exit");
    expect(lastLines).toContain("No, stay in plan mode");
    expect(lastLines).toContain("No, and let me refine the plan");
    expect(lastLines).toContain("ctrl-g to edit in $EDITOR");
    expect(lastLines).toContain("Plan saved to:");
  });
  it("shows 'The plan is empty.' when plan text is whitespace (no overflow markers)", () => {
    const { dialog } = makeDialog("   \n\n  ", undefined);
    const lines = dialog.render(80);
    const out = lines.join("\n");
    expect(lines[1]).toBe("Ready to code?");
    expect(out).toContain("The plan is empty.");
    expect(out).not.toContain("more above");
    expect(out).not.toContain("more below");
    expect(out).not.toContain("Here is the plan:");
    expect(out).toContain("Yes, proceed without a plan");
    expect(out).toContain("ctrl-g to write a plan in $EDITOR");
    expect(out).not.toContain("Yes, auto-accept edits on plan exit");
  });
  it("options are always rendered (even when plan overflows)", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const lines = dialog.render(80);
    const out = lines.join("\n");
    expect(out).toContain("Yes, auto-accept edits on plan exit");
    expect(out).toContain("Yes, bypass permissions on plan exit");
    expect(out).toContain("No, stay in plan mode");
    expect(out).toContain("No, and let me refine the plan");
  });
});
describe("ExitPlanModeDialog plan rendering (scrollable middle)", () => {
  it("renders the plan in full when it fits the viewport", () => {
    const { dialog } = makeDialog(longPlan(20), undefined, 50);
    const out = dialog.render(80).join("\n");
    for (let i = 1; i <= 20; i++) {
      expect(out).toContain(`Step number ${i}`);
    }
    expect(out).not.toContain("PgUp/PgDn to scroll");
  });
  it("shows a scroll indicator when the plan overflows the viewport", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const out = dialog.render(80).join("\n");
    expect(out).toContain("of 102");
    expect(out).toContain("PgUp/PgDn to scroll");
    expect(out).toContain("Step number 1 with");
    expect(out).not.toMatch(/\* 100\. Step number 100\b/);
  });
  it("options are ALWAYS visible at the bottom regardless of plan length", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n");
    const { dialog } = makeDialog(longText, undefined, 20);
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Yes, auto-accept edits on plan exit");
    expect(out).toContain("Yes, bypass permissions on plan exit");
    expect(out).toContain("No, stay in plan mode");
    expect(out).toContain("No, and let me refine the plan");
    expect(out).toContain("ctrl-g to edit in $EDITOR");
  });
  it("total rendered lines fit within the terminal height", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n");
    const { dialog } = makeDialog(longText, undefined, 20);
    const lines = dialog.render(80);
    expect(lines.length).toBeLessThanOrEqual(22);
  });
  it("PageDown scrolls the plan content forward", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const before = dialog.render(80).join("\n");
    expect(before).toContain("Step number 1 with");
    expect(before).not.toMatch(/\* 50\. Step number 50\b/);
    for (let i = 0; i < 16; i++) {
      dialog.handleInput("\x1b[6~");
    }
    const after = dialog.render(80).join("\n");
    expect(after).toMatch(/\* 50\. Step number 50\b/);
  });
  it("PageUp scrolls the plan content backward", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    for (let i = 0; i < 16; i++) {
      dialog.handleInput("\x1b[6~");
    }
    const scrolled = dialog.render(80).join("\n");
    expect(scrolled).not.toMatch(/\* 1\. Step number 1\b/);
    for (let i = 0; i < 16; i++) {
      dialog.handleInput("\x1b[5~");
    }
    const back = dialog.render(80).join("\n");
    expect(back).toMatch(/\* 1\. Step number 1\b/);
  });
  it("Home scrolls to the start of the plan", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    dialog.handleInput("\x1b[6~");
    dialog.handleInput("\x1b[F");
    const before = dialog.render(80).join("\n");
    expect(before).toMatch(/\* 100\. Step number 100\b/);
    dialog.handleInput("\x1b[H");
    const after = dialog.render(80).join("\n");
    expect(after).toMatch(/\* 1\. Step number 1\b/);
    expect(after).not.toMatch(/\* 100\. Step number 100\b/);
  });
  it("End scrolls to the end of the plan", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const before = dialog.render(80).join("\n");
    expect(before).toContain("Step number 1 with");
    dialog.handleInput("\x1b[F");
    const after = dialog.render(80).join("\n");
    expect(after).toContain("Step number 100 with");
    expect(after).not.toMatch(/\* 1\. Step number 1\b/);
  });
  it("scroll indicator shows the current visible range", () => {
    const { dialog } = makeDialog(longPlan(100), undefined, 20);
    const initial = dialog.render(80).join("\n");
    expect(initial).toMatch(/▼ 1-\d+ of 102/);
    dialog.handleInput("\x1b[F");
    const atEnd = dialog.render(80).join("\n");
    expect(atEnd).toMatch(/▼ \d+-102 of 102/);
  });
  it("up/down arrows move the selected option indicator", () => {
    const { dialog } = makeDialog("# Plan\n\nBody", undefined, 30);
    const initial = dialog.render(80).join("\n");
    expect(initial).toContain("▶ 1.");
    expect(initial).not.toContain("▶ 2.");
    dialog.handleInput("\x1b[B");
    const after = dialog.render(80).join("\n");
    expect(after).toContain("▶ 2.");
    expect(after).not.toContain("▶ 1.");
  });
  it("Enter commits the selected option", async () => {
    let resolveDone: (r: ExitPlanModeDialogResult) => void = () => {};
    const finishPromise = new Promise<ExitPlanModeDialogResult>((resolve) => {
      resolveDone = resolve;
    });
    const dialog = new ExitPlanModeDialog(
      "# Plan",
      "/tmp/plan.md",
      [...dialogOptionsFor("# Plan")],
      stubDialogTheme,
      stubMarkdownTheme,
      (r) => resolveDone(r),
      async () => undefined,
      () => 30,
    );
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    const result = await finishPromise;
    expect(result.action).toBe("acceptEdits");
  });
});
