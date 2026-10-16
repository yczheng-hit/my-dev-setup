import { describe, expect, it } from "vitest";
import { containsUnquotedExpansion } from "./shellSecurity.ts";
import {
  isReadOnlyCommand,
  splitBashSubcommands,
} from "./utils.ts";
describe("Bash command classification - bug fix verification", () => {
  describe("bug repro: xargs in pipeline", () => {
    it("correctly identifies find | xargs grep | head as read-only", () => {
      const cmd = `find "C:/Users/UserName/AppData/Roaming/npm/node_modules/@earendil-works/" -name "*.js" >2/dev/null | xargs grep -l "abort" 2>/dev/null | head -5`;
      expect(isReadOnlyCommand(cmd)).toBe(true);
    });
    it("correctly identifies simple find | xargs grep | head as read-only", () => {
      const cmd = `find . -name "*.js" | xargs grep -l "abort" | head -5`;
      expect(isReadOnlyCommand(cmd)).toBe(true);
    });
  });
  describe("bug repro: 2>&1 redirection in pipeline", () => {
    it("correctly splits cd && echo 2>&1 | head into 3 subcommands (no stray '1')", () => {
      const cmd = `cd /tmp && echo hello 2>&1 | head -5`;
      const sub = splitBashSubcommands(cmd);
      expect(sub).not.toContain("1");
      expect(sub).toEqual(["cd /tmp", "echo hello", "head -5"]);
    });
    it("cd && npx 2>&1 | head splits correctly (npx not on allowlist is OK)", () => {
      const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck extensions/pi-tasks.ts 2>&1 | head -40`;
      const sub = splitBashSubcommands(cmd);
      expect(sub).toHaveLength(3);
      expect(sub[0]).toMatch(/^cd /);
      expect(sub[1]).toMatch(/^npx /);
      expect(sub[2]).toMatch(/^head /);
      expect(isReadOnlyCommand(cmd)).toBe(false);
    });
  });
  describe("xargs security: only safe targets allowed", () => {
    it("blocks xargs rm (dangerous target)", () => {
      expect(isReadOnlyCommand(`find . -name "*.tmp" | xargs rm`)).toBe(false);
    });
    it("blocks xargs with -exec-like flags", () => {
      expect(
        isReadOnlyCommand(`find . -name "*.txt" | xargs -I {} sh -c "rm {}"`),
      ).toBe(false);
    });
    it("blocks xargs with -e EOF (deprecated unsafe flag)", () => {
      expect(
        isReadOnlyCommand(`find . -name "*.txt" | xargs -e EOF echo foo`),
      ).toBe(false);
    });
    it("allows xargs grep", () => {
      expect(isReadOnlyCommand(`find . -name "*.txt" | xargs grep foo`)).toBe(
        true,
      );
    });
    it("allows xargs wc", () => {
      expect(isReadOnlyCommand(`find . -name "*.txt" | xargs wc -l`)).toBe(
        true,
      );
    });
  });
  describe("simple commands still work", () => {
    it("ls is read-only", () => {
      expect(isReadOnlyCommand(`ls /tmp`)).toBe(true);
    });
    it("cat is read-only", () => {
      expect(isReadOnlyCommand(`cat /etc/hosts`)).toBe(true);
    });
    it("echo hello | grep hello is read-only", () => {
      expect(isReadOnlyCommand(`echo hello | grep hello`)).toBe(true);
    });
    it("cat /etc/hosts | head -5 is read-only", () => {
      expect(isReadOnlyCommand(`cat /etc/hosts | head -5`)).toBe(true);
    });
    it("find / -name '*.log' | head -5 is read-only", () => {
      expect(isReadOnlyCommand(`find / -name "*.log" | head -5`)).toBe(true);
    });
  });
  describe("security: cd + git compound blocked", () => {
    it("blocks cd /malicious && git status (sandbox-escape vector)", () => {
      expect(isReadOnlyCommand(`cd /tmp && git status`)).toBe(false);
    });
  });
  describe("security: unquoted expansion blocks allowlist", () => {
    it("blocks $VAR expansion in command", () => {
      expect(isReadOnlyCommand(`cat $FILE`)).toBe(false);
    });
  });
});