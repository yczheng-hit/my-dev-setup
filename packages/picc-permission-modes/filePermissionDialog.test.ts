import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createFilePermissionDialogFactory,
  FilePermissionDialog,
  type FilePermissionChoice,
} from "./filePermissionDialog.ts";
import type { DiffLine } from "./utils.ts";
const stubTheme = {
  fg: (color: string, text: string) => text,
  bg: (color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
};
const DEFAULT_OPTIONS_3 = [
  "Yes",
  "Yes, allow all edits during this session (shift+tab)",
  "No",
];
const BASH_OPTIONS_2 = ["Allow", "Block"];
function makeDialog(
  options: string[] = DEFAULT_OPTIONS_3,
  message: string = "Pi requested permissions to write to /foo/bar.ts, but you haven't granted it yet.",
  description?: string,
): {
  dialog: FilePermissionDialog;
  choicePromise: Promise<FilePermissionChoice>;
} {
  let resolveChoice: (c: FilePermissionChoice) => void = () => {};
  const choicePromise = new Promise<FilePermissionChoice>((resolve) => {
    resolveChoice = resolve;
  });
  const dialog = new FilePermissionDialog(
    { options, message, description },
    (c) => resolveChoice(c),
    (t) => t,
    (t) => t,
  );
  return { dialog, choicePromise };
}
describe("FilePermissionDialog.render", () => {
  it("renders the message, three options with the ▶ marker on the first, and footer hints", () => {
    const { dialog } = makeDialog();
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Pi requested permissions to write to /foo/bar.ts");
    expect(out).toContain("Yes");
    expect(out).toContain("Yes, allow all edits during this session (shift+tab)");
    expect(out).toContain("No");
    expect(out).toContain("↑↓ navigate");
    expect(out).toContain("shift+tab allow all");
  });
  it("the first option is marked with the ▶ selected glyph by default", () => {
    const { dialog } = makeDialog();
    const out = dialog.render(80);
    const firstOptionLine = out.find((l) => l.includes("Yes"));
    expect(firstOptionLine).toBeDefined();
    expect(firstOptionLine!.startsWith("▶ ")).toBe(true);
  });
  it("non-selected options are prefixed with two spaces (not ▶)", () => {
    const { dialog } = makeDialog();
    const out = dialog.render(80);
    const secondOptionLine = out.find((l) => l.includes("allow all edits"));
    expect(secondOptionLine).toBeDefined();
    expect(secondOptionLine!.startsWith("  2.")).toBe(true);
    expect(secondOptionLine!.startsWith("▶ ")).toBe(false);
  });
  it("caches the render output for the same width", () => {
    const { dialog } = makeDialog();
    const a = dialog.render(80);
    const b = dialog.render(80);
    expect(a).toBe(b);
  });
  it("invalidates the cache when selectedIndex changes", () => {
    const { dialog } = makeDialog();
    const before = dialog.render(80);
    dialog.handleInput("\x1b[B");
    const after = dialog.render(80);
    expect(after).not.toBe(before);
    const selected = after.find((l) => l.includes("allow all edits"));
    expect(selected!.startsWith("▶ ")).toBe(true);
  });
  it("truncates long option labels to fit the terminal width", () => {
    const { dialog } = makeDialog(DEFAULT_OPTIONS_3);
    const out = dialog.render(30);
    for (const line of out) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });
  it("omits the title line for empty messages (bash 2-option case)", () => {
    const { dialog } = makeDialog(BASH_OPTIONS_2, "");
    const out = dialog.render(80);
    const firstOption = out.find((l) => l.startsWith("▶ 1. Allow"));
    expect(firstOption).toBeDefined();
  });
  it("renders the 2-option bash prompt with two option rows", () => {
    const { dialog } = makeDialog(BASH_OPTIONS_2, "");
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Allow");
    expect(out).toContain("Block");
    expect(out).toContain("shift+tab allow all");
  });
  it("renders the bash description line below the message and above the options", () => {
    const { dialog } = makeDialog(
      BASH_OPTIONS_2,
      "Allow bash command?\n  npm test",
      "Run the test suite",
    );
    const out = dialog.render(80);
    const cmdIdx = out.findIndex((l) => l.includes("npm test"));
    const descIdx = out.findIndex((l) => l.includes("Run the test suite"));
    const optIdx = out.findIndex(
      (l) => l.startsWith("▶ ") || l.startsWith("  1."),
    );
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeGreaterThan(cmdIdx);
    expect(optIdx).toBeGreaterThan(descIdx);
  });
  it("omits the description line when description is undefined or empty", () => {
    const noDesc = makeDialog(BASH_OPTIONS_2, "Allow bash command?\n  npm test");
    expect(noDesc.dialog.render(80).join("\n")).not.toContain("Run the");
    const emptyDesc = makeDialog(BASH_OPTIONS_2, "Allow bash command?\n  npm test", "");
    const out = emptyDesc.dialog.render(80);
    expect(out.join("\n")).toContain("Allow bash command?");
  });
  it("wraps a long bash description instead of truncating with '...'", () => {
    const longDesc =
      "Discard all uncommitted changes in the working tree and match the remote main branch exactly, resetting any staged or unstaged edits.";
    const { dialog } = makeDialog(
      BASH_OPTIONS_2,
      "Allow bash command?\n  git reset --hard origin/main",
      longDesc,
    );
    const width = 50;
    const out = dialog.render(width);
    for (const line of out) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const optIdx = out.findIndex((l) => l.startsWith("▶ ") || l.startsWith("  1."));
    const descRegion = out.slice(0, optIdx).join("\n");
    expect(descRegion).toContain("Discard all uncommitted changes");
    expect(descRegion).toContain("match the remote main branch exactly");
    expect(descRegion).not.toContain("...");
  });
  it("wraps a long bash D4 message instead of truncating with '...'", () => {
    const longTitle =
      "Bash command targets a sensitive file: /c/Users/UserName/.pi/agent/extensions/picc-working-spinner/node_modules/@types/something/deeply/nested. This is a safety check (D4) and must be approved manually.";
    const { dialog } = makeDialog(BASH_OPTIONS_2, longTitle);
    const width = 60;
    const out = dialog.render(width);
    for (const line of out) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const optionsStartIdx = out.findIndex(
      (l) => l.startsWith("▶ ") || l.startsWith("  1."),
    );
    const titleRegion = out.slice(0, optionsStartIdx).join("\n");
    expect(titleRegion).toContain("Bash command targets a sensitive file:");
    expect(titleRegion).toContain("must be approved manually");
    expect(titleRegion).not.toContain("...");
    const titleLines = out.slice(
      0,
      out.findIndex((l) => l.startsWith("▶ ") || l.startsWith("  1.")),
    );
    const visibleTitleLines = titleLines.filter((l) => l.trim().length > 0);
    expect(visibleTitleLines.length).toBeGreaterThan(1);
  });
});
describe("FilePermissionDialog.handleInput", () => {
  it("Shift+Tab selects the 'allow all edits during this session' option", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x1b[Z");
    await expect(choicePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
  it("Enter on the default (first) option returns 'Yes'", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\r");
    await expect(choicePromise).resolves.toBe("Yes");
  });
  it("Down arrow then Enter returns the second option", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await expect(choicePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
  it("Up arrow clamps at index 0 (does not underflow)", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x1b[A");
    dialog.handleInput("\x1b[A");
    dialog.handleInput("\r");
    await expect(choicePromise).resolves.toBe("Yes");
  });
  it("Down arrow at the last option clamps to the last index", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    await expect(choicePromise).resolves.toBe("No");
  });
  it("Esc returns null (user dismissed)", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x1b");
    await expect(choicePromise).resolves.toBeNull();
  });
  it("Ctrl+C returns null", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("\x03");
    await expect(choicePromise).resolves.toBeNull();
  });
  it("Digit shortcut: '2' selects the second option", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("2");
    await expect(choicePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
  it("Vim j/k navigation behaves like arrow keys", async () => {
    const { dialog, choicePromise } = makeDialog();
    dialog.handleInput("j");
    dialog.handleInput("j");
    dialog.handleInput("k");
    dialog.handleInput("\r");
    await expect(choicePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
  it("Shift+Tab in a 2-option bash prompt falls back to null (no matching option)", async () => {
    const { dialog, choicePromise } = makeDialog(BASH_OPTIONS_2, "");
    dialog.handleInput("\x1b[Z");
    await expect(choicePromise).resolves.toBeNull();
  });
  it("Subsequent input after close is a no-op (onChoice called exactly once)", async () => {
    let calls = 0;
    let resolveChoice: (c: FilePermissionChoice) => void = () => {};
    const choicePromise = new Promise<FilePermissionChoice>((resolve) => {
      resolveChoice = resolve;
    });
    const dialog = new FilePermissionDialog(
      { options: DEFAULT_OPTIONS_3 },
      (c) => {
        calls++;
        resolveChoice(c);
      },
    );
    dialog.handleInput("\r");
    dialog.handleInput("\x1b[Z");
    dialog.handleInput("\x1b");
    await expect(choicePromise).resolves.toBe("Yes");
    expect(calls).toBe(1);
  });
});
describe("FilePermissionDialog panel layout (showPanel)", () => {
  function makePanelDialog(opts: {
    title?: string;
    subtitle?: string;
    question?: string;
    diffLines?: DiffLine[];
    previewLines?: string[];
    identity?: boolean;
  } = {}) {
    let resolveChoice: (c: FilePermissionChoice) => void = () => {};
    const choicePromise = new Promise<FilePermissionChoice>((resolve) => {
      resolveChoice = resolve;
    });
    const tag = (color: string) => (text: string) => `<${color}>${text}</>`;
    const identity = (t: string) => t;
    const dimFn = opts.identity ? identity : tag("dim");
    const boldFn = opts.identity ? identity : tag("bold");
    const fgFn = opts.identity
      ? (color: string, text: string) => text
      : (color: string, text: string) => `<${color}>${text}</>`;
    const dialog = new FilePermissionDialog(
      {
        options: DEFAULT_OPTIONS_3,
        title: opts.title,
        subtitle: opts.subtitle,
        question: opts.question,
        diffLines: opts.diffLines,
        previewLines: opts.previewLines,
        showPanel: true,
      },
      (c) => resolveChoice(c),
      boldFn,
      dimFn,
      fgFn,
    );
    return { dialog, choicePromise };
  }
  const SAMPLE_DIFF: DiffLine[] = [
    { type: "context", oldNo: 1, newNo: 1, text: "@article{liang2025," },
    { type: "context", oldNo: 2, newNo: 2, text: "  author = {X. Liang}," },
    { type: "del", oldNo: 3, newNo: 0, text: "  title  = {Old Title}," },
    { type: "add", oldNo: 0, newNo: 3, text: "  title  = {New Title}," },
    { type: "context", oldNo: 4, newNo: 4, text: "  year   = {2025}" },
  ];
  it("renders title, subtitle, top-rule, diff, question, options and CC footer", () => {
    const { dialog } = makePanelDialog({
      title: "Edit file",
      subtitle: "MyLibrary.bib",
      question: "Do you want to make this edit to MyLibrary.bib?",
      diffLines: SAMPLE_DIFF,
    });
    const out = dialog.render(60).join("\n");
    expect(out).toContain("\x1b[38;2;177;185;249mEdit file\x1b[39m");
    expect(out).toContain("<dim>MyLibrary.bib");
    expect(out).toContain("<toolDiffRemoved>");
    expect(out).toContain("\x1b[38;2;32;124;54m");
    expect(out).toContain("<toolDiffContext>");
    expect(out).toContain("Do you want to make this edit to <bold>MyLibrary.bib</>?");
    expect(out).toContain("▶ 1. Yes");
    expect(out).toContain("Esc to cancel · Tab to amend");
    expect(out).not.toContain("shift+tab allow all");
  });
  it("colors added lines with 207c36 and removed with toolDiffRemoved", () => {
    const { dialog } = makePanelDialog({ diffLines: SAMPLE_DIFF });
    const out = dialog.render(60);
    const addLine = out.find((l) => l.includes("New Title"));
    const delLine = out.find((l) => l.includes("Old Title"));
    expect(addLine).toContain("\x1b[38;2;32;124;54m");
    expect(addLine).not.toContain("<toolDiffAdded>");
    expect(delLine).toContain("<toolDiffRemoved>");
  });
  it("renders a write preview as a plain dim-numbered listing (no green, no +)", () => {
    const { dialog } = makePanelDialog({
      title: "Create file",
      subtitle: "notes.md",
      question: "Do you want to create this file: notes.md?",
      previewLines: ["# Title", "some content", "another line"],
    });
    const out = dialog.render(60).join("\n");
    expect(out).toContain("\x1b[38;2;177;185;249mCreate file\x1b[39m");
    expect(out).toContain("──");
    expect(out).toContain("<dim>1</> # Title");
    expect(out).toContain("<dim>2</> some content");
    expect(out).toContain("<dim>3</> another line");
    expect(out).not.toContain("\x1b[38;2;32;124;54m");
    expect(out).not.toContain(" + ");
    expect(out).not.toContain("<toolDiffAdded>");
    expect(out).not.toContain("<toolDiffContext>");
    expect(out).toContain("Do you want to create this file: <bold>notes.md</>?");
  });
  it("truncates a write preview to the terminal width", () => {
    const { dialog } = makePanelDialog({
      identity: true,
      title: "Create file",
      previewLines: [
        "a-very-long-line-that-should-be-truncated-to-fit-a-narrow-terminal",
      ],
    });
    const width = 30;
    for (const line of dialog.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("colors the selected option with b1b9f9", () => {
    const { dialog } = makePanelDialog({
      title: "Edit file",
      diffLines: SAMPLE_DIFF,
    });
    const out = dialog.render(60);
    const selected = out.find((l) => l.includes("▶ 1. Yes"));
    const unselected = out.find((l) => l.includes("  2. Yes, allow all"));
    expect(selected).toBeDefined();
    expect(unselected).toBeDefined();
    expect(selected).toContain("\x1b[38;2;177;185;249m");
    expect(unselected).not.toContain("\x1b[38;2;177;185;249m");
  });
  it("bolds the file-name tail of the question", () => {
    const { dialog } = makePanelDialog({
      title: "Edit file",
      question: "Do you want to make this edit to MyLibrary.bib?",
    });
    const out = dialog.render(80).join("\n");
    expect(out).toContain("Do you want to make this edit to <bold>MyLibrary.bib</>?");
  });
  it("the panel top-rule is a full-width border line", () => {
    const { dialog } = makePanelDialog({ diffLines: SAMPLE_DIFF });
    const out = dialog.render(40);
    const ruleIdx = out.findIndex((l) => l.includes("──"));
    expect(ruleIdx).toBeGreaterThanOrEqual(0);
    expect(visibleWidth(out[ruleIdx]!)).toBe(40);
  });
  it("falls back to no diff/top-rule when diffLines is empty", () => {
    const { dialog } = makePanelDialog({
      title: "Create file",
      question: "Do you want to create this file: notes.md?",
    });
    const out = dialog.render(60).join("\n");
    expect(out).toContain("\x1b[38;2;177;185;249mCreate file\x1b[39m");
    expect(out).toContain("──");
    expect(out).toContain("Do you want to create this file: <bold>notes.md</>?");
    expect(out).not.toContain("<toolDiffAdded>");
    expect(out).not.toContain("\x1b[38;2;32;124;54m");
  });
  it("every panel line fits the terminal width", () => {
    const { dialog } = makePanelDialog({
      identity: true,
      title: "Edit file",
      subtitle: "a-very-long-file-name-that-goes-on-and-on.ts",
      question: "Do you want to make this edit to a-very-long-file-name.ts?",
      diffLines: SAMPLE_DIFF.map((d) => ({ ...d, text: d.text + " some extra text" })),
    });
    const width = 30;
    for (const line of dialog.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("shift+tab still selects the allow-all option in panel mode", async () => {
    const { dialog, choicePromise } = makePanelDialog({ diffLines: SAMPLE_DIFF });
    dialog.handleInput("\x1b[Z");
    await expect(choicePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
});
describe("FilePermissionDialog bash panel (showBashPanel)", () => {
  const BASH_OPTIONS_3 = [
    "Yes",
    "Yes, and don't ask again for: python *",
    "No",
  ];
  function makeBashDialog(opts: {
    command?: string;
    description?: string;
    note?: string;
    question?: string;
    options?: string[];
    identity?: boolean;
  } = {}) {
    let resolveChoice: (c: FilePermissionChoice) => void = () => {};
    const choicePromise = new Promise<FilePermissionChoice>((resolve) => {
      resolveChoice = resolve;
    });
    const tag = (color: string) => (text: string) => `<${color}>${text}</>`;
    const identity = (t: string) => t;
    const dimFn = opts.identity ? identity : tag("dim");
    const boldFn = opts.identity ? identity : tag("bold");
    const fgFn = opts.identity
      ? (color: string, text: string) => text
      : (color: string, text: string) => `<${color}>${text}</>`;
    const dialog = new FilePermissionDialog(
      {
        options: opts.options ?? BASH_OPTIONS_3,
        command: opts.command ?? "python -c \"print('Hello, World!')\"",
        description: opts.description,
        note: opts.note,
        question: opts.question,
        showBashPanel: true,
      },
      (c) => resolveChoice(c),
      boldFn,
      dimFn,
      fgFn,
    );
    return { dialog, choicePromise };
  }
  it("renders header, top-rule, command, dim description, note, question, options, and bash footer", () => {
    const { dialog } = makeBashDialog({
      description: "Print hello world with Python",
    });
    const out = dialog.render(80);
    const joined = out.join("\n");
    expect(joined).toContain("\x1b[38;2;177;185;249mBash command\x1b[39m");
    expect(joined).toContain("──");
    expect(out.some((l) => l === "  python -c \"print('Hello, World!')\"")).toBe(true);
    expect(out.some((l) => l.startsWith("  <dim>Print hello world with Python</>"))).toBe(true);
    expect(joined).toContain("This command requires approval");
    expect(joined).toContain("Do you want to proceed?");
    expect(joined).toContain("▶ 1. Yes");
    expect(joined).toContain("2. Yes, and don't ask again for: python *");
    expect(joined).toContain("3. No");
    expect(joined).toContain("Esc to cancel · Tab to amend · ctrl+e to explain");
    expect(joined).not.toContain("shift+tab allow all");
  });
  it("colors the selected option row in b1b9f9", () => {
    const { dialog } = makeBashDialog();
    const out = dialog.render(80);
    const yesLine = out.find((l) => l.includes("1. Yes"));
    expect(yesLine).toBeDefined();
    expect(yesLine!.includes("\x1b[38;2;177;185;249m")).toBe(true);
    const noLine = out.find((l) => l.includes("3. No"));
    expect(noLine!.includes("\x1b[38;2;177;185;249m")).toBe(false);
  });
  it("omits the description body line when description is undefined", () => {
    const { dialog } = makeBashDialog({ description: undefined });
    const out = dialog.render(80);
    expect(out.some((l) => l.includes("Print hello"))).toBe(false);
  });
  it("uses a custom note when provided", () => {
    const { dialog } = makeBashDialog({
      note: "Bash command targets a sensitive file: /tmp/x. Manual approval required.",
    });
    const out = dialog.render(80);
    expect(out.some((l) => l.includes("Bash command targets a sensitive file"))).toBe(true);
    expect(out.some((l) => l.includes("This command requires approval"))).toBe(false);
  });
  it("wraps a long command without truncating", () => {
    const longCmd =
      "git reset --hard origin/main && npm ci && python -c \"print('Hello, World!')\"";
    const { dialog } = makeBashDialog({ command: longCmd, identity: true });
    const width = 40;
    const out = dialog.render(width);
    for (const line of out) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const noteIdx = out.findIndex((l) => l.includes("requires approval"));
    const body = out
      .slice(0, noteIdx < 0 ? out.length : noteIdx)
      .filter((l) => l.startsWith("  "))
      .join("\n");
    expect(body).toContain("git reset --hard");
    expect(body).toContain("print('Hello, World!')");
    expect(body).not.toContain("...");
  });
  it("shift+tab commits null when no session-wide option is present", async () => {
    const { dialog, choicePromise } = makeBashDialog();
    dialog.handleInput("\x1b[Z");
    await expect(choicePromise).resolves.toBeNull();
  });
  it("digit '3' commits No", async () => {
    const { dialog, choicePromise } = makeBashDialog();
    dialog.handleInput("3");
    await expect(choicePromise).resolves.toBe("No");
  });
});
describe("FilePermissionDialog overlay scroll", () => {
  const SAMPLE_DIFF: DiffLine[] = Array.from({ length: 60 }, (_, i) => ({
    type: "context" as const,
    oldNo: i + 1,
    newNo: i + 1,
    text: `line ${i + 1} of the diff`,
  }));
  function makeScrollDialog(opts: {
    rows?: number;
    diffLines?: DiffLine[];
    previewLines?: string[];
  }): FilePermissionDialog {
    let resolveChoice: (c: FilePermissionChoice) => void = () => {};
    void new Promise<FilePermissionChoice>((resolve) => {
      resolveChoice = resolve;
    });
    const identity = (t: string) => t;
    const dialog = new FilePermissionDialog(
      {
        options: DEFAULT_OPTIONS_3,
        title: "Edit file",
        subtitle: "MyLibrary.bib",
        question: "Do you want to make this edit to MyLibrary.bib?",
        diffLines: opts.diffLines,
        previewLines: opts.previewLines,
        showPanel: true,
      },
      (c) => resolveChoice(c),
      identity,
      identity,
      (_color, text) => text,
      () => opts.rows ?? 24,
    );
    return dialog;
  }
  it("clamps a tall diff to fit the terminal and keeps options + footer visible", () => {
    const dialog = makeScrollDialog({ rows: 16, diffLines: SAMPLE_DIFF });
    const out = dialog.render(60);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.some((l) => l.includes("▶ 1. Yes"))).toBe(true);
    expect(out.some((l) => l.includes("3. No"))).toBe(true);
    expect(out.some((l) => l.includes("Esc to cancel"))).toBe(true);
    const diffLines = out.filter(
      (l) => l.trim().length > 0 && l.startsWith("line ") === false && /^\d+ /.test(l) === false && l.includes("of the diff"),
    );
    expect(diffLines.length).toBeLessThan(60);
  });
  it("shows a scroll indicator only when the content overflows", () => {
    const overflowing = makeScrollDialog({ rows: 12, diffLines: SAMPLE_DIFF });
    expect(
      overflowing.render(60).some((l) => l.includes("PgUp/PgDn to scroll")),
    ).toBe(true);
    const fitting = makeScrollDialog({
      rows: 60,
      diffLines: SAMPLE_DIFF.slice(0, 5),
    });
    expect(
      fitting.render(60).some((l) => l.includes("PgUp/PgDn to scroll")),
    ).toBe(false);
  });
  it("PageDown advances the visible window and keeps the options pinned", () => {
    const dialog = makeScrollDialog({ rows: 12, diffLines: SAMPLE_DIFF });
    const before = dialog.render(60);
    const beforeWindow = before
      .filter((l) => l.includes("of the diff"))
      .map((l) => l.trim());
    dialog.handleInput("\x1b[6~");
    const after = dialog.render(60);
    const afterWindow = after
      .filter((l) => l.includes("of the diff"))
      .map((l) => l.trim());
    expect(afterWindow[0]).not.toBe(beforeWindow[0]);
    expect(after.some((l) => l.includes("▶ 1. Yes"))).toBe(true);
  });
  it("PageUp / Home / End clamp at the edges without error", () => {
    const dialog = makeScrollDialog({ rows: 16, diffLines: SAMPLE_DIFF });
    dialog.handleInput("\x1b[5~");
    dialog.handleInput("\x1b[5~");
    dialog.handleInput("\x1b[H");
    expect(dialog.render(60).length).toBeLessThanOrEqual(16);
    dialog.handleInput("\x1b[F");
    dialog.handleInput("\x1b[F");
    dialog.handleInput("\x1b[6~");
    expect(dialog.render(60).length).toBeLessThanOrEqual(16);
  });
  it("short content is rendered in full with no scroll indicator (unchanged look)", () => {
    const dialog = makeScrollDialog({
      rows: 24,
      diffLines: SAMPLE_DIFF.slice(0, 3),
    });
    const out = dialog.render(60);
    expect(out.some((l) => l.includes("PgUp/PgDn to scroll"))).toBe(false);
    expect(out.some((l) => l.includes("line 1 of the diff"))).toBe(true);
    expect(out.some((l) => l.includes("line 3 of the diff"))).toBe(true);
    expect(out.some((l) => l.includes("Esc to cancel · Tab to amend"))).toBe(true);
  });
});
describe("createFilePermissionDialogFactory", () => {
  it("returns a component whose done() resolves with the chosen option", () => {
    const factory = createFilePermissionDialogFactory({
      message: "msg",
      options: DEFAULT_OPTIONS_3,
    });
    let resolveDone: (c: FilePermissionChoice) => void = () => {};
    const donePromise = new Promise<FilePermissionChoice>((resolve) => {
      resolveDone = resolve;
    });
    const component = factory(
      {} as any,
      stubTheme as any,
      undefined,
      resolveDone,
    );
    expect(component).toBeDefined();
    expect(typeof component.render).toBe("function");
    expect(typeof component.handleInput).toBe("function");
    expect(typeof component.invalidate).toBe("function");
    component.handleInput!("\x1b[Z");
    return expect(donePromise).resolves.toBe(
      "Yes, allow all edits during this session (shift+tab)",
    );
  });
});