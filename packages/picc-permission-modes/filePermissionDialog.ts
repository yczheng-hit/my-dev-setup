import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderDiffLines, type DiffLine } from "./utils.ts";
const EDIT_FILE_TITLE_HEX = "b1b9f9";
const BASH_PANEL_TITLE_HEX = "b1b9f9";
const SELECTED_OPTION_HEX = "b1b9f9";
const DIFF_ADDED_HEX = "207c36";
const TOP_RULE_HEX = "b1b9f9";
function fgHex(hex: string, text: string): string {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) return text;
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return text;
  }
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
export type FilePermissionChoice = string | null;
export interface FilePermissionDialogOptions {
  message?: string;
  options: string[];
  description?: string;
  title?: string;
  subtitle?: string;
  diffLines?: DiffLine[];
  previewLines?: string[];
  question?: string;
  command?: string;
  note?: string;
  showBashPanel?: boolean;
  showPanel?: boolean;
}
export class FilePermissionDialog implements Component {
  private readonly message: string;
  private readonly description: string;
  private readonly options: string[];
  private readonly title: string;
  private readonly subtitle: string;
  private readonly question: string;
  private readonly diffLines: DiffLine[];
  private readonly previewLines: string[];
  private readonly showPanel: boolean;
  private readonly command: string;
  private readonly note: string;
  private readonly showBashPanel: boolean;
  private readonly boldFn: ((text: string) => string) | null;
  private readonly dimFn: ((text: string) => string) | null;
  private readonly fgFn: ((color: string, text: string) => string) | null;
  private selectedIndex: number;
  private closed = false;
  private readonly onChoice: (choice: FilePermissionChoice) => void;
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;
  private scrollOffset = 0;
  private readonly getTerminalRows: () => number;
  constructor(
    opts: FilePermissionDialogOptions,
    onChoice: (choice: FilePermissionChoice) => void,
    boldFn?: (text: string) => string,
    dimFn?: (text: string) => string,
    fgFn?: (color: string, text: string) => string,
    getTerminalRows?: () => number,
  ) {
    this.message = opts.message ?? "";
    this.description = opts.description ?? "";
    this.options = [...opts.options];
    this.title = opts.title ?? "";
    this.subtitle = opts.subtitle ?? "";
    this.question = opts.question ?? "Do you want to proceed?";
    this.diffLines = opts.diffLines ?? [];
    this.previewLines = opts.previewLines ?? [];
    this.showPanel = opts.showPanel ?? false;
    this.command = opts.command ?? "";
    this.note = opts.note ?? "This command requires approval";
    this.showBashPanel = opts.showBashPanel ?? false;
    this.selectedIndex = 0;
    this.onChoice = onChoice;
    this.boldFn = boldFn ?? null;
    this.dimFn = dimFn ?? null;
    this.fgFn = fgFn ?? null;
    this.getTerminalRows = getTerminalRows ?? (() => 24);
  }
  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
  }
  private setSelectedIndex(index: number): void {
    if (this.options.length === 0) return;
    const clamped = Math.max(0, Math.min(this.options.length - 1, index));
    if (clamped !== this.selectedIndex) {
      this.selectedIndex = clamped;
      this.invalidate();
    }
  }
  private findShiftTabOptionIndex(): number {
    for (let i = 0; i < this.options.length; i++) {
      const label = this.options[i] ?? "";
      if (label.includes("allow all") || label.includes("during this session")) {
        return i;
      }
    }
    return -1;
  }
  private finish(choice: FilePermissionChoice): void {
    if (this.closed) return;
    this.closed = true;
    this.onChoice(choice);
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "up") || data === "k") {
      this.setSelectedIndex(this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.setSelectedIndex(this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "pageup")) {
      this.scrollDelta(-Math.max(1, Math.floor(this.diffPreviewViewport() / 2)));
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.scrollDelta(Math.max(1, Math.floor(this.diffPreviewViewport() / 2)));
      return;
    }
    if (matchesKey(data, "home")) {
      this.setScrollOffset(0);
      return;
    }
    if (matchesKey(data, "end")) {
      const total = this.contentLineCount();
      const scrollable = Math.max(1, this.diffPreviewViewport() - 1);
      this.setScrollOffset(Math.max(0, total - scrollable));
      return;
    }
    if (matchesKey(data, "enter")) {
      const opt = this.options[this.selectedIndex];
      this.finish(opt ?? null);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish(null);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      const idx = this.findShiftTabOptionIndex();
      if (idx < 0) {
        this.finish(null);
        return;
      }
      this.setSelectedIndex(idx);
      this.finish(this.options[idx] ?? null);
      return;
    }
    if (data.length === 1 && data >= "1" && data <= "9") {
      const n = Number.parseInt(data, 10);
      if (n >= 1 && n <= this.options.length) {
        this.setSelectedIndex(n - 1);
        const opt = this.options[n - 1];
        this.finish(opt ?? null);
        return;
      }
    }
  }
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines = this.renderBody(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
  private renderBody(width: number): string[] {
    if (this.showBashPanel && this.command.length > 0) {
      return this.renderBashPanel(width);
    }
    if (this.showPanel && (this.title || this.subtitle || this.question || this.diffLines.length > 0)) {
      return this.renderPanel(width);
    }
    const lines: string[] = [];
    lines.push(fgHex(TOP_RULE_HEX, "─".repeat(width)));
    lines.push("");
    const title = this.message;
    if (title.length > 0) {
      for (const wrappedLine of wrapTextWithAnsi(title, width)) {
        lines.push(wrappedLine);
      }
      lines.push("");
    }
    if (this.description.length > 0 && this.dimFn) {
      const dimmed = this.dimFn(this.description);
      for (const wrappedLine of wrapTextWithAnsi(dimmed, width)) {
        lines.push(wrappedLine);
      }
      lines.push("");
    }
    for (let i = 0; i < this.options.length; i++) {
      const label = this.options[i] ?? "";
      const isSelected = i === this.selectedIndex;
      const marker = isSelected ? "▶ " : "  ";
      const num = `${i + 1}.`;
      const labelWidth = Math.max(1, width - marker.length - num.length - 1);
      const styledLabel = this.formatOptionLabel(label, labelWidth);
      lines.push(`${marker}${num} ${styledLabel}`);
    }
    lines.push("");
    const hints = "↑↓ navigate · enter select · esc cancel · shift+tab allow all";
    lines.push(truncateToWidth(hints, width));
    return lines;
  }
  private renderPanel(width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(fgHex(TOP_RULE_HEX, "─".repeat(width)));
    if (this.title.length > 0) {
      lines.push(truncateToWidth(fgHex(EDIT_FILE_TITLE_HEX, this.title), width));
    }
    if (this.subtitle.length > 0) {
      const dimmed = this.dimFn ? this.dimFn(this.subtitle) : this.subtitle;
      lines.push(truncateToWidth(dimmed, width));
    }
    lines.push("");
    const hasDiff = this.diffLines.length > 0;
    const hasPreview = this.previewLines.length > 0;
    const content = hasPreview
      ? this.renderPreviewLines(this.previewLines, width)
      : hasDiff
        ? this.renderDiffRows(width)
        : [];
    const contentTotal = content.length;
    const viewport = this.diffPreviewViewport();
    const overflows = contentTotal > viewport;
    let visibleContent = content;
    if (overflows) {
      const scrollable = Math.max(1, viewport - 1);
      const maxOffset = Math.max(0, contentTotal - scrollable);
      const start = Math.min(this.scrollOffset, maxOffset);
      const end = Math.min(start + scrollable, contentTotal);
      visibleContent = content.slice(start, end);
    }
    let scrollIndicatorLine: string | null = null;
    if (overflows) {
      const scrollable = Math.max(1, viewport - 1);
      const maxOffset = Math.max(0, contentTotal - scrollable);
      const start = Math.min(this.scrollOffset, maxOffset);
      scrollIndicatorLine = this.scrollIndicator(start, contentTotal, scrollable);
    }
    if (hasPreview || hasDiff) {
      for (const row of visibleContent) {
        lines.push(row);
      }
      if (scrollIndicatorLine !== null) {
        lines.push(truncateToWidth(this.dimFn ? this.dimFn(scrollIndicatorLine) : scrollIndicatorLine, width));
      }
      lines.push("");
    }
    if (this.question.length > 0) {
      const styled = this.boldQuestionFileName(this.question);
      for (const wrappedLine of wrapTextWithAnsi(styled, width)) {
        lines.push(wrappedLine);
      }
    }
    for (const optLine of this.renderOptions(width)) {
      lines.push(optLine);
    }
    lines.push("");
    const hints = overflows
      ? "Esc to cancel · PageUp/PageDown to scroll"
      : "Esc to cancel · Tab to amend";
    lines.push(truncateToWidth(this.dimFn ? this.dimFn(hints) : hints, width));
    return lines;
  }
  private renderOptions(width: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.options.length; i++) {
      const label = this.options[i] ?? "";
      const isSelected = i === this.selectedIndex;
      const marker = isSelected ? "▶ " : "  ";
      const num = `${i + 1}.`;
      const labelWidth = Math.max(1, width - marker.length - num.length - 1);
      const styledLabel = this.formatOptionLabel(label, labelWidth);
      const line = isSelected ? fgHex(SELECTED_OPTION_HEX, `${marker}${num} ${styledLabel}`) : `${marker}${num} ${styledLabel}`;
      out.push(line);
    }
    return out;
  }
  private renderBashPanel(width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(fgHex(TOP_RULE_HEX, "─".repeat(width)));
    lines.push(truncateToWidth(fgHex(BASH_PANEL_TITLE_HEX, "Bash command"), width));
    lines.push("");
    const indent = "  ";
    const bodyWidth = Math.max(1, width - indent.length);
    for (const wrappedLine of wrapTextWithAnsi(this.command, bodyWidth)) {
      lines.push(indent + wrappedLine);
    }
    if (this.description.length > 0 && this.dimFn) {
      const dimmed = this.dimFn(this.description);
      for (const wrappedLine of wrapTextWithAnsi(dimmed, bodyWidth)) {
        lines.push(indent + wrappedLine);
      }
    }
    lines.push("");
    for (const wrappedLine of wrapTextWithAnsi(this.note, width)) {
      lines.push(wrappedLine);
    }
    lines.push("");
    for (const wrappedLine of wrapTextWithAnsi(this.question, width)) {
      lines.push(wrappedLine);
    }
    for (const optLine of this.renderOptions(width)) {
      lines.push(optLine);
    }
    lines.push("");
    const hints = "Esc to cancel · Tab to amend · ctrl+e to explain";
    lines.push(truncateToWidth(this.dimFn ? this.dimFn(hints) : hints, width));
    return lines;
  }
  private renderPreviewLines(rawLines: string[], width: number): string[] {
    const gutterW = String(rawLines.length).length;
    const contentW = Math.max(1, width - gutterW - 1);
    const out: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const num = String(i + 1).padStart(gutterW, " ");
      const dimNum = this.dimFn ? this.dimFn(num) : num;
      const text = rawLines[i].replace(/\t/g, "  ");
      const content =
        text.length > contentW ? text.slice(0, contentW) : text;
      out.push(`${dimNum} ${content}`);
    }
    return out;
  }
  private renderDiffRows(width: number): string[] {
    return renderDiffLines(this.diffLines, width).map((row): string => {
      if (row.type === "add") {
        return fgHex(DIFF_ADDED_HEX, row.plain);
      }
      const colorKey = row.type === "del" ? "toolDiffRemoved" : "toolDiffContext";
      return this.fgFn ? this.fgFn(colorKey, row.plain) : row.plain;
    });
  }
  private contentLineCount(): number {
    if (this.previewLines.length > 0) return this.previewLines.length;
    if (this.diffLines.length > 0) return this.diffLines.length;
    return 0;
  }
  private diffPreviewViewport(): number {
    const termRows = Math.max(8, this.getTerminalRows());
    const hasContent = this.contentLineCount() > 0;
    const topRegion =
      1  +
      1  +
      (this.title.length > 0 ? 1 : 0) +
      (this.subtitle.length > 0 ? 1 : 0) +
      1;
    const bottomRegion =
      (hasContent ? 1 : 0)  +
      1  +
      1  +
      1  +
      this.options.length +
      1  +
      1 ;
    const available = termRows - topRegion - bottomRegion;
    return Math.max(2, available);
  }
  private scrollIndicator(start: number, total: number, visible: number): string {
    const end = Math.min(start + visible, total);
    return `▼ ${start + 1}-${end} of ${total} · PgUp/PgDn to scroll`;
  }
  private scrollDelta(delta: number): void {
    const total = this.contentLineCount();
    const scrollable = Math.max(1, this.diffPreviewViewport() - 1);
    const maxOffset = Math.max(0, total - scrollable);
    const next = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.invalidate();
    }
  }
  private setScrollOffset(offset: number): void {
    const total = this.contentLineCount();
    const scrollable = Math.max(1, this.diffPreviewViewport() - 1);
    const maxOffset = Math.max(0, total - scrollable);
    const next = Math.max(0, Math.min(maxOffset, offset));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.invalidate();
    }
  }
  private formatOptionLabel(label: string, availableWidth: number): string {
    const idx = label.indexOf("(shift+tab)");
    if (idx < 0 || !this.boldFn) {
      return truncateToWidth(label, availableWidth);
    }
    const before = label.slice(0, idx);
    const hint = label.slice(idx);
    const composed = `${before}${this.boldFn(hint)}`;
    if (visibleWidth(composed) <= availableWidth) return composed;
    return truncateToWidth(label, availableWidth);
  }
  private boldQuestionFileName(question: string): string {
    if (!this.boldFn) return question;
    if (!question.endsWith("?")) return question;
    const beforeQ = question.slice(0, -1);
    const lastSpace = beforeQ.lastIndexOf(" ");
    if (lastSpace < 0) return question;
    const head = beforeQ.slice(0, lastSpace);
    const pathPart = beforeQ.slice(lastSpace + 1);
    return `${head} ${this.boldFn(pathPart)}?`;
  }
}
export function createFilePermissionDialogFactory(
  opts: FilePermissionDialogOptions,
): (tui: TUI, theme: Theme, _keybindings: unknown, done: (choice: FilePermissionChoice) => void) => Component {
  return (
    tui: TUI,
    theme: Theme,
    _keybindings: unknown,
    done: (choice: FilePermissionChoice) => void,
  ): Component => {
    const getTerminalRows = (): number => {
      try {
        const rows = tui?.terminal?.rows;
        if (typeof rows === "number" && rows > 0) return rows;
      } catch {
      }
      return 24;
    };
    const dialog = new FilePermissionDialog(
      opts,
      done,
      (text: string): string => {
        try {
          return theme.bold(text);
        } catch {
          return text;
        }
      },
      (text: string): string => {
        try {
          return theme.fg("dim", text);
        } catch {
          return text;
        }
      },
      (color: string, text: string): string => {
        try {
          return theme.fg(color, text);
        } catch {
          return text;
        }
      },
    );
    return dialog;
  };
}