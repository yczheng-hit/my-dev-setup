import { describe, it, expect } from "vitest";
import { isReadOnlyCommand, splitBashSubcommands } from "./utils.ts";
describe("User-reported bug fixes", () => {
  it("Bug 1: find ... | xargs grep ... | head -5 is read-only (was triggering edit prompt)", () => {
    const cmd = `find "C:/Users/UserName/AppData/Roaming/npm/node_modules/@earendil-works/" -name "*.js" >2/dev/null | xargs grep -l "abort" 2>/dev/null | head -5`;
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it("Bug 1 (simpler repro): find . -name '*.js' | xargs grep | head is read-only", () => {
    expect(
      isReadOnlyCommand(`find . -name "*.js" | xargs grep -l "abort" | head -5`),
    ).toBe(true);
  });
  it("Bug 2: 2>&1 redirection is stripped, not split", () => {
    const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck extensions/pi-tasks.ts 2>&1 | head -40`;
    const sub = splitBashSubcommands(cmd);
    expect(sub).not.toContain("1");
    expect(sub[1]).not.toMatch(/2>&1\s*$/);
  });
  it("Bug 2: 2>&1 stripped from subcommand tail", () => {
    expect(splitBashSubcommands(`echo hello 2>&1`)).toEqual(["echo hello"]);
  });
});