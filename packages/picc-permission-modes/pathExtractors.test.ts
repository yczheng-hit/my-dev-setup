import { describe, it, expect } from "vitest";
import { extractBashPaths } from "./pathExtractors.ts";
import { isDangerousFilePath } from "./permissionContext.ts";
const SED_SCRIPT = `s/.*/ *"\\(.*\\)"".*\\^1/`;
describe("pathExtractors — upstream-parity extractors", () => {
  it("sed with a substitution and no file returns no paths (the repro)", () => {
    expect(extractBashPaths(`sed '${SED_SCRIPT}'`, true)).toEqual([]);
  });
  it("read-only grep | sed pipeline extracts no write paths (screenshot repro)", () => {
    expect(
      extractBashPaths(
        `grep -m1 "version" "$f" | sed '${SED_SCRIPT}'`,
        true,
      ),
    ).toEqual([]);
  });
  it("sed -i still extracts the target file (true positive preserved)", () => {
    expect(extractBashPaths(`sed -i 's/a/b/' .gitconfig`, true)).toContain(
      ".gitconfig",
    );
  });
  it("sed -e with a trailing file extracts the file, not the expression", () => {
    expect(extractBashPaths(`sed -e 's/a/b/' target.txt`, true)).toEqual([
      "target.txt",
    ]);
  });
  it("jq filter with no file returns no paths", () => {
    expect(extractBashPaths(`jq '.version'`, true)).toEqual([]);
  });
  it("jq filter with a trailing file extracts the file", () => {
    expect(extractBashPaths(`jq '.version' data.json`, false)).toEqual([
      "data.json",
    ]);
  });
  it("tr character sets are not treated as paths", () => {
    expect(extractBashPaths(`tr 'a-z' 'A-Z'`, true)).toEqual([]);
  });
  it("rm still extracts its target (true positive preserved)", () => {
    expect(extractBashPaths(`rm -rf .git`, true)).toContain(".git");
  });
  it("git diff --no-index extracts its two file paths", () => {
    expect(extractBashPaths(`git diff --no-index a b`, false)).toEqual([
      "a",
      "b",
    ]);
  });
  it("plain git subcommand extracts no paths", () => {
    expect(extractBashPaths(`git status`, true)).toEqual([]);
  });
});
describe("D4 gate — sed substitution no longer false-positives", () => {
  it("the extracted sed substitution is not classified as a dangerous path", () => {
    const paths = extractBashPaths(
      `grep -m1 "version" "$f" | sed '${SED_SCRIPT}'`,
      true,
    );
    for (const p of paths) {
      expect(isDangerousFilePath(p)).toBe(false);
    }
  });
  it("a genuine dangerous sed target is still flagged", () => {
    const paths = extractBashPaths(`sed -i 's/a/b/' .gitconfig`, true);
    expect(paths.some((p) => isDangerousFilePath(p))).toBe(true);
  });
});
