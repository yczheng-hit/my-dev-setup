import { describe, expect, it } from "vitest";
import { buildEditDiff, renderDiffLines, toRelativePath } from "./utils.ts";
describe("buildEditDiff", () => {
  it("produces context / add / del rows with correct line numbers", () => {
    const oldStr = "a\nb\nc\nd\ne";
    const newStr = "a\nB\nc\nd\ne";
    const lines = buildEditDiff("f.txt", oldStr, newStr, "/");
    expect(lines).not.toBeNull();
    const types = lines!.map((l) => l.type);
    expect(types).toContain("add");
    expect(types).toContain("del");
    const del = lines!.find((l) => l.type === "del")!;
    const add = lines!.find((l) => l.type === "add")!;
    expect(del.oldNo).toBe(2);
    expect(add.newNo).toBe(2);
  });
  it("treats an empty old string as a new-file creation (all additions)", () => {
    const lines = buildEditDiff("new.txt", "", "hello\nworld", "/");
    expect(lines).not.toBeNull();
    expect(lines!.every((l) => l.type === "add")).toBe(true);
  });
  it("returns an empty array when old and new are identical", () => {
    const lines = buildEditDiff("f.txt", "same", "same", "/");
    expect(lines).toEqual([]);
  });
  it("unescapes & and $ from the diff output", () => {
    const lines = buildEditDiff("f.txt", "a & b $ c", "a & b $ d", "/");
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.text.includes("&"))).toBe(true);
    expect(lines!.some((l) => l.text.includes("$"))).toBe(true);
  });
});
describe("renderDiffLines", () => {
  it("lays out gutter + marker + content and aligns numbers", () => {
    const lines = buildEditDiff("f.txt", "a\nb\nc", "a\nB\nc", "/")!;
    const rendered = renderDiffLines(lines, 80);
    const add = rendered.find((r) => r.plain.includes("B"))!;
    expect(add.type).toBe("add");
    expect(add.plain).toMatch(/^\s*2 \+ B$/);
  });
  it("truncates content to fit the terminal width", () => {
    const lines = buildEditDiff(
      "f.txt",
      "short",
      "a-very-long-line-that-should-be-truncated-to-fit-a-narrow-terminal",
      "/",
    )!;
    const rendered = renderDiffLines(lines, 20);
    for (const r of rendered) {
      expect(r.plain.length).toBeLessThanOrEqual(20 + 6);
    }
  });
  it("returns an empty array for an empty diff", () => {
    expect(renderDiffLines([], 80)).toEqual([]);
  });
});
describe("toRelativePath", () => {
  it("returns a relative path for files under cwd", () => {
    expect(toRelativePath("/w/proj/src/a.ts", "/w/proj")).toBe("src/a.ts");
  });
  it("falls back to the basename for files outside cwd", () => {
    expect(toRelativePath("/elsewhere/b.ts", "/w/proj")).toBe("b.ts");
  });
});
