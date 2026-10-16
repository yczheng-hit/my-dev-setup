import { describe, it, expect } from "vitest";
import { isReadOnlyCommand } from "./utils.ts";
import { extractFirstBashPath } from "./pathExtractors.ts";
describe("User screenshot repros", () => {
  it("Screenshot 1: find | xargs grep | head (was: edit sensitive file prompt)", () => {
    const cmd = `find "C:/Users/UserName/AppData/Roaming/npm/node_modules/@earendil-works/" -name "*.js" >2/dev/null | xargs grep -l "abort" 2>/dev/null | head -5`;
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it("Screenshot 2: cd && npx tsc 2>&1 | head (was: edit C:/Users/UserName/.pi/agent)", () => {
    const cmd = `cd "C:/Users/UserName/.pi/agent" && npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck extensions/pi-tasks.ts 2>&1 | head -40`;
    expect(isReadOnlyCommand(cmd)).toBe(false);
    expect(extractFirstBashPath(cmd)).toBe("");
  });
  it("Bonus: A genuine dangerous write still triggers the safety check", () => {
    const cmd = `rm -rf .git/`;
    expect(extractFirstBashPath(cmd)).toBe(".git/");
  });
  it("Bonus: A genuine dangerous edit still triggers the safety check", () => {
    const cmd = `cat .bashrc`;
    expect(extractFirstBashPath(cmd)).toBe("");
  });
  it("Bonus: chmod does go through write gate", () => {
    expect(extractFirstBashPath(`chmod 755 /etc/passwd`)).toBe("");
  });
});