import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryParseShellCommand } from "./upstream/utils/bash/shellQuote.ts";

// A bash command whose quoted heredoc carries a JS template literal. shell-quote throws
// "Bad substitution: new" on it; picc used to console.error that straight onto Pi's TUI
// (seen over the editor and the HUD footer, three times per command).
const COMMAND = "cat > /tmp/x <<'EOF'\nlog(`${new Date().toTimeString()}`);\nEOF";

describe("shell parse failures never write to the terminal", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PICC_DEBUG;
	});

	it("reports the failure to the caller without console or stderr output", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = tryParseShellCommand(COMMAND);
		expect(result.success).toBe(false);
		expect(result.success ? "" : result.error).toMatch(/Bad substitution/);
		expect(consoleError).not.toHaveBeenCalled();
		expect(stderrWrite).not.toHaveBeenCalled();
	});

	it("PICC_DEBUG=<absolute file> appends the diagnostic there instead", () => {
		const dir = mkdtempSync(join(tmpdir(), "picc-debug-"));
		try {
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
			process.env.PICC_DEBUG = join(dir, "picc.log");
			tryParseShellCommand(COMMAND);
			expect(consoleError).not.toHaveBeenCalled();
			expect(readFileSync(join(dir, "picc.log"), "utf8")).toMatch(/\[picc-permission-modes\] Bad substitution: new/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
