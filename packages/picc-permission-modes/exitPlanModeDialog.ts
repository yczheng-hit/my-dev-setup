// local patch: close approval before handing editing to Pi's native UI.
import {
  type Component,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { shortenPath } from "./utils.ts";
/** Review actions; editing is handled by the tool after this overlay closes. */
export type ExitPlanModeDialogAction =
  | "acceptEdits"
  | "bypassPermissions"
  | "no"
  | "refine"
  | "edit";
export interface ExitPlanModeDialogResult {
  action: ExitPlanModeDialogAction;
}
interface ExitPlanModeDialogOption {
  id: ExitPlanModeDialogAction;
  label: string;
  shortcutHint?: string;
}
/** Wrapped color functions extracted from the active pi theme. Keeps the
 *  dialog styling consistent with the rest of the TUI without hard-coding
 *  hex codes. */
interface ExitPlanModeDialogTheme {
  title: (text: string) => string;
  sectionLabel: (text: string) => string;
  optionSelected: (text: string) => string;
  optionDefault: (text: string) => string;
  optionHint: (text: string) => string;
  hint: (text: string) => string;
  hintDim: (text: string) => string;
  border: (text: string) => string;
  emptyPlan: (text: string) => string;
}
const OPTIONS_NORMAL: ExitPlanModeDialogOption[] = [
  {
    id: "bypassPermissions",
    label: "Yes, bypass permissions on plan exit",
    shortcutHint: "enter",
  },
  {
    id: "acceptEdits",
    label: "Yes, auto-accept edits on plan exit",
    shortcutHint: "shift+tab",
  },
  {
    id: "no",
    label: "Stay in plan mode",
    shortcutHint: "esc",
  },
  {
    id: "refine",
    label: "Request changes to the plan…",
  },
];
const OPTIONS_EMPTY: ExitPlanModeDialogOption[] = [
  {
    id: "acceptEdits",
    label: "Yes, proceed without a plan",
    shortcutHint: "enter",
  },
  {
    id: "no",
    label: "Stay in plan mode",
    shortcutHint: "esc",
  },
];
function buildDialogTheme(theme: Theme): ExitPlanModeDialogTheme {
  const fg = (name: string, text: string): string => {
    try {
      return theme.fg(name as never, text);
    } catch {
      return text;
    }
  };
  return {
    title: (t) => fg("accent", t),
    sectionLabel: (t) => fg("muted", t),
    optionSelected: (t) => fg("accent", t),
    optionDefault: (t) => fg("text", t),
    optionHint: (t) => fg("dim", t),
    hint: (t) => fg("dim", t),
    hintDim: (t) => fg("muted", t),
    border: (t) => fg("borderAccent", t) || fg("border", t) || t,
    emptyPlan: (t) => fg("warning", t),
  };
}
export function buildMarkdownTheme(theme: Theme): MarkdownTheme {
  const fg = (name: string, text: string): string => {
    try {
      return theme.fg(name as never, text);
    } catch {
      return text;
    }
  };
  const bold = (t: string): string => {
    try {
      return theme.bold(t);
    } catch {
      return t;
    }
  };
  const italic = (t: string): string => {
    try {
      return theme.italic(t);
    } catch {
      return t;
    }
  };
  const underline = (t: string): string => {
    try {
      return theme.underline(t);
    } catch {
      return t;
    }
  };
  const strikethrough = (t: string): string => {
    try {
      return theme.strikethrough(t);
    } catch {
      return t;
    }
  };
  return {
    heading: (t) => fg("mdHeading", t),
    link: (t) => fg("mdLink", t),
    linkUrl: (t) => fg("mdLinkUrl", t),
    code: (t) => fg("mdCode", t),
    codeBlock: (t) => fg("mdCodeBlock", t),
    codeBlockBorder: (t) => fg("mdCodeBlockBorder", t),
    quote: (t) => italic(fg("mdQuote", t)),
    quoteBorder: (t) => fg("mdQuoteBorder", t),
    hr: (t) => fg("mdHr", t),
    listBullet: (t) => fg("mdListBullet", t),
    bold: (t) => bold(t),
    italic: (t) => italic(t),
    underline: (t) => underline(t),
    strikethrough: (t) => strikethrough(t),
  };
}
export class ExitPlanModeDialog implements Component {
  private planText: string;
  private planPath: string;
  private options: ExitPlanModeDialogOption[];
  private selectedIndex: number;
  private readonly dialogTheme: ExitPlanModeDialogTheme;
  private readonly markdownTheme: MarkdownTheme;
  private readonly done: (result: ExitPlanModeDialogResult) => void;
  private closed = false;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedMdLines: { width: number; lines: string[] } | null = null;
  private readonly getTerminalRows: () => number;
  private scrollOffset = 0;
  /** Border color function — applied to the top + bottom border rows
   *  rendered around the dialog body. Set by the factory. */
  private borderColor: (s: string) => string = (s) => s;
  constructor(
    planText: string,
    planPath: string,
    options: ExitPlanModeDialogOption[],
    dialogTheme: ExitPlanModeDialogTheme,
    markdownTheme: MarkdownTheme,
    done: (result: ExitPlanModeDialogResult) => void,
    getTerminalRows: () => number = () => 24,
  ) {
    this.planText = planText;
    this.planPath = planPath;
    this.options = options;
    this.dialogTheme = dialogTheme;
    this.markdownTheme = markdownTheme;
    this.done = done;
    this.getTerminalRows = getTerminalRows;
    this.selectedIndex = 0;
  }
  /** Called by the factory to install the border color function. The
   *  border lines are rendered as the first + last row of `render()`
   *  output (no separate `DynamicBorder` component needed — that would
   *  require a Container wrapper, which doesn't forward input). */
  setBorderColor(fn: (s: string) => string): void {
    this.borderColor = fn;
    this.invalidate();
  }
  invalidate(): void {
    this.cachedLines = null;
  }
  private setSelectedIndex(index: number): void {
    const clamped = Math.max(0, Math.min(this.options.length - 1, index));
    if (clamped !== this.selectedIndex) {
      this.selectedIndex = clamped;
      this.invalidate();
    }
  }
  /** Returns the rendered Markdown lines for the current plan, cached by
   *  width. Re-rendered only when `planText` changes or the width changes.
   *  Returns null if no plan is set (or plan is empty). */
  private getPlanLines(width: number): string[] {
    if (this.cachedMdLines && this.cachedMdLines.width === width) {
      return this.cachedMdLines.lines;
    }
    const md = new Markdown(this.planText, 0, 0, this.markdownTheme);
    const lines = md.render(Math.max(10, width));
    this.cachedMdLines = { width, lines };
    return lines;
  }
  private finish(result: ExitPlanModeDialogResult): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== "wheel") return undefined;
    if (event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height) {
      return undefined;
    }
    // Consume even boundary/no-op wheels so the conversation behind the
    // approval overlay never scrolls. Pi owns wheel acceleration and redraws.
    return { handled: true, render: this.scrollPlan(event.wheelDelta ?? 0) };
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape")) {
      this.finish({ action: "no" });
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.setSelectedIndex(this.options.findIndex((opt) => opt.id === "acceptEdits"));
      this.finish({ action: "acceptEdits" });
      return;
    }
    if (matchesKey(data, "up")) {
      this.setSelectedIndex(this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.setSelectedIndex(this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "pageup")) {
      this.scrollPlan(-Math.max(1, Math.floor(this.planViewportSize() / 2)));
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.scrollPlan(Math.max(1, Math.floor(this.planViewportSize() / 2)));
      return;
    }
    if (matchesKey(data, "home")) {
      this.setScrollOffset(0);
      return;
    }
    if (matchesKey(data, "end")) {
      const width = Math.max(10, this.cachedWidth > 0 ? this.cachedWidth : 80);
      const planLines = this.getPlanLines(width);
      const viewport = this.planViewportSize();
      this.setScrollOffset(Math.max(0, planLines.length - viewport + 1));
      return;
    }
    if (matchesKey(data, "enter")) {
      const opt = this.options[this.selectedIndex];
      if (!opt) return;
      this.finish({ action: opt.id });
      return;
    }
    if (matchesKey(data, "ctrl+g")) {
      this.finish({ action: "edit" });
      return;
    }
    if (data.length === 1 && data >= "1" && data <= "9") {
      const n = Number.parseInt(data, 10);
      if (n >= 1 && n <= this.options.length) {
        this.setSelectedIndex(n - 1);
        return;
      }
    }
  }
  private topRegionHeight(): number {
    return 4;
  }
  private bottomRegionHeight(): number {
    return 2  + this.options.length + 1 ;
  }
  /** Available rows for plan content at the current terminal height.
   *  Reserves room for the top region, bottom region, and the 2 border
   *  rows (top + bottom) that the dialog's `render()` prepends/appends. */
  private planViewportSize(): number {
    const termRows = Math.max(8, this.getTerminalRows());
    const available = termRows - this.topRegionHeight() - this.bottomRegionHeight() - 2 ;
    return Math.max(2, available);
  }
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const body = this.renderBody(width);
    const horizontal = "─".repeat(Math.max(1, width));
    const top = this.borderColor(horizontal);
    const bottom = this.borderColor(horizontal);
    const lines = [top, ...body, bottom];
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
  private renderBody(width: number): string[] {
    const lines: string[] = [];
    const isEmpty = this.planText.trim() === "";
    lines.push(this.dialogTheme.title("Ready to code?"));
    lines.push("");
    if (isEmpty) {
      lines.push(this.dialogTheme.emptyPlan("The plan is empty."));
    } else {
      lines.push(this.dialogTheme.sectionLabel("Here is the plan:"));
    }
    lines.push("");
    if (!isEmpty) {
      const planLines = this.getPlanLines(width);
      const viewport = this.planViewportSize();
      if (planLines.length > viewport) {
        const scrollable = viewport - 1;
        const maxOffset = Math.max(0, planLines.length - scrollable);
        const start = Math.min(this.scrollOffset, maxOffset);
        const end = Math.min(start + scrollable, planLines.length);
        lines.push(...planLines.slice(start, end));
        const indicator = this.scrollIndicator(start, planLines.length, scrollable);
        lines.push(this.dialogTheme.hintDim(indicator));
      } else {
        lines.push(...planLines);
      }
    }
    lines.push("");
    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i]!;
      const isSelected = i === this.selectedIndex;
      const marker = isSelected ? "▶ " : "  ";
      const num = `${i + 1}.`;
      const labelText = ` ${opt.label}`;
      const styled = isSelected
        ? this.dialogTheme.optionSelected(labelText)
        : this.dialogTheme.optionDefault(labelText);
      const hint = opt.shortcutHint
        ? `   ${this.dialogTheme.optionHint(opt.shortcutHint)}`
        : "";
      lines.push(
        `${marker}${this.dialogTheme.optionDefault(num)}${styled}${hint}`,
      );
    }
    lines.push("");
    const hints: string[] = [];
    hints.push(
      this.dialogTheme.hint(
        isEmpty
          ? "ctrl-g to write a plan with Pi"
          : "ctrl-g to edit with Pi",
      ),
    );
    hints.push(
      this.dialogTheme.hintDim(
        `Plan saved to: ${shortenPath(this.planPath)}`,
      ),
    );
    lines.push(hints.join("   "));
    return lines;
  }
  /** Build a one-line scroll indicator showing the current position
   *  within the plan, with keyboard and fullscreen mouse-wheel hints. */
  private scrollIndicator(start: number, total: number, visible: number): string {
    const end = Math.min(start + visible, total);
    return `▼ ${start + 1}-${end} of ${total} · PgUp/PgDn to scroll · mouse wheel (fullscreen)`;
  }
  /** Adjust the plan scroll offset by `delta` rows, clamped to the
   *  valid range `[0, maxScrollOffset]`. Ensures the plan is rendered
   *  before trying to scroll so the cache is always populated. */
  private scrollPlan(delta: number): boolean {
    const width = Math.max(10, this.cachedWidth > 0 ? this.cachedWidth : 80);
    const planLines = this.getPlanLines(width);
    const viewport = this.planViewportSize();
    const scrollable = Math.max(1, viewport - 1);
    const maxOffset = planLines.length > viewport ? planLines.length - scrollable : 0;
    const next = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.invalidate();
      return true;
    }
    return false;
  }
  /** Set the plan scroll offset to an absolute value, clamped to the
   *  valid range. Ensures the plan is rendered before scrolling. */
  private setScrollOffset(offset: number): void {
    const width = Math.max(10, this.cachedWidth > 0 ? this.cachedWidth : 80);
    const planLines = this.getPlanLines(width);
    const viewport = this.planViewportSize();
    const scrollable = Math.max(1, viewport - 1);
    const maxOffset = planLines.length > viewport ? planLines.length - scrollable : 0;
    const next = Math.max(0, Math.min(maxOffset, offset));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.invalidate();
    }
  }
}
export function createExitPlanModeDialogFactory(
  planText: string,
  planPath: string,
  dialogTheme: ExitPlanModeDialogTheme,
  markdownTheme: MarkdownTheme,
) {
  return (
    tui: TUI,
    _theme: Theme,
    _keybindings: unknown,
    done: (result: ExitPlanModeDialogResult) => void,
  ): Component => {
    const isEmpty = planText.trim() === "";
    const options2 = isEmpty ? OPTIONS_EMPTY : OPTIONS_NORMAL;
    const getTerminalRows = (): number => {
      try {
        const rows = tui?.terminal?.rows;
        if (typeof rows === "number" && rows > 0) return rows;
      } catch {
      }
      return 24;
    };
    const dialog = new ExitPlanModeDialog(
      planText,
      planPath,
      options2,
      dialogTheme,
      markdownTheme,
      done,
      getTerminalRows,
    );
    dialog.setBorderColor((s: string): string => dialogTheme.border(s));
    return dialog;
  };
}
/** Internal helper exposed for tests: returns the option list the factory
 *  would use for the given plan content. */
export function dialogOptionsFor(
  planText: string,
): readonly ExitPlanModeDialogOption[] {
  return planText.trim() === "" ? OPTIONS_EMPTY : OPTIONS_NORMAL;
}