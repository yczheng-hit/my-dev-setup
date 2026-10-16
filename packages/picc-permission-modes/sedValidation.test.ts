import { describe, expect, it } from "vitest";
import { checkSedConstraints } from "./sedValidation.ts";
describe("checkSedConstraints", () => {
  describe("non-sed commands", () => {
    it("returns passthrough for plain non-sed commands", () => {
      expect(checkSedConstraints("ls -la").behavior).toBe("passthrough");
    });
    it("returns passthrough for an empty command", () => {
      expect(checkSedConstraints("").behavior).toBe("passthrough");
    });
  });
  describe("line-printing pattern (Pattern 1)", () => {
    it("allows sed -n 'Np' file (print line N)", () => {
      expect(checkSedConstraints("sed -n '1p' file.txt").behavior).toBe(
        "passthrough",
      );
    });
    it("allows sed -n '1p;2p' file (semicolon-separated prints)", () => {
      expect(
        checkSedConstraints("sed -n '1p;2p;3p' file.txt").behavior,
      ).toBe("passthrough");
    });
    it("allows sed -n 'N,Mp' file (range print)", () => {
      expect(checkSedConstraints("sed -n '1,10p' file.txt").behavior).toBe(
        "passthrough",
      );
    });
    it("rejects sed -n without -n flag", () => {
      const result = checkSedConstraints("sed 'p' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("rejects sed -n with non-print command (sed -n '/regex/d')", () => {
      const result = checkSedConstraints("sed -n '/foo/d' file.txt");
      expect(result.behavior).toBe("ask");
    });
  });
  describe("substitution pattern (Pattern 2)", () => {
    it("allows sed 's/foo/bar/' (substitution with no file args)", () => {
      expect(
        checkSedConstraints("sed 's/foo/bar/'").behavior,
      ).toBe("passthrough");
    });
    it("rejects sed 's/foo/bar/' file.txt when allowFileWrites=false", () => {
      const result = checkSedConstraints("sed 's/foo/bar/' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("allows sed 's/foo/bar/' file.txt when allowFileWrites=true", () => {
      expect(
        checkSedConstraints("sed -i 's/foo/bar/' file.txt", {
          allowFileWrites: true,
        }).behavior,
      ).toBe("passthrough");
    });
    it("rejects sed with file args when allowFileWrites=false", () => {
      const result = checkSedConstraints("sed s/x/y/ file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("allows sed -i 's/foo/bar/g' file when allowFileWrites=true", () => {
      expect(
        checkSedConstraints("sed -i 's/foo/bar/g' file.txt", {
          allowFileWrites: true,
        }).behavior,
      ).toBe("passthrough");
    });
    it("rejects sed -i 's/foo/bar/g' file when allowFileWrites=false", () => {
      const result = checkSedConstraints("sed -i 's/foo/bar/g' file.txt", {
        allowFileWrites: false,
      });
      expect(result.behavior).toBe("ask");
    });
  });
  describe("dangerous operations (denylist)", () => {
    it("blocks sed 's/.../.../w file' (write flag)", () => {
      const result = checkSedConstraints("sed 's/foo/bar/w out.txt' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed 's/.../.../e' (execute flag)", () => {
      const result = checkSedConstraints("sed 's/foo/bar/e' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with /pattern/w file (range write)", () => {
      const result = checkSedConstraints("sed '/foo/w file.txt' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with /pattern/e (range execute)", () => {
      const result = checkSedConstraints("sed '/foo/e' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with negation operator (!)", () => {
      const result = checkSedConstraints("sed '/foo/!d' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with tilde address", () => {
      const result = checkSedConstraints("sed '1~2d' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with curly braces (block command)", () => {
      const result = checkSedConstraints("sed '/foo/{d}' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with non-ASCII characters (homoglyph bypass)", () => {
      const result = checkSedConstraints("sed 's/foo/bar/ｗ file.txt' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with backslash-delimiter tricks", () => {
      const result = checkSedConstraints("sed 's\\foo\\bar\\' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed 'y/' followed by write/execute", () => {
      const result = checkSedConstraints("sed 'y/abc/xyz/w file.txt' file.txt");
      expect(result.behavior).toBe("ask");
    });
  });
  describe("compound commands", () => {
    it("allows read-only pipeline ending in sed -n print", () => {
      expect(
        checkSedConstraints("cat file.txt | sed -n '1,5p'").behavior,
      ).toBe("passthrough");
    });
    it("blocks compound command with dangerous sed even if first is safe", () => {
      const result = checkSedConstraints(
        "sed -n '1p' file.txt && sed 's/foo/bar/w out.txt' file.txt",
      );
      expect(result.behavior).toBe("ask");
    });
    it("allows compound safe sed commands", () => {
      expect(
        checkSedConstraints(
          "sed 's/a/b/' && sed 's/c/d/'",
        ).behavior,
      ).toBe("passthrough");
    });
  });
  describe("malformed input", () => {
    it("blocks sed with malformed shell syntax", () => {
      const result = checkSedConstraints("sed 'unclosed");
      expect(result.behavior).toBe("ask");
    });
    it("blocks sed with dangerous flag combinations (-ew)", () => {
      const result = checkSedConstraints("sed -ew 's/foo/bar/' file.txt");
      expect(result.behavior).toBe("ask");
    });
  });
  describe("Edge cases", () => {
    it("treats uppercase W the same as lowercase w", () => {
      const result = checkSedConstraints("sed 's/foo/bar/W file.txt' file.txt");
      expect(result.behavior).toBe("ask");
    });
    it("treats uppercase E the same as lowercase e", () => {
      const result = checkSedConstraints("sed 's/foo/bar/E' file.txt");
      expect(result.behavior).toBe("ask");
    });
  });
});