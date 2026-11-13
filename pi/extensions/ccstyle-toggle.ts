import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readCurrentCcstyleMode(): "on" | "compact" | "off" {
	const configPath = join(getAgentDir(), "pi-cc-extensions.json");
	if (!existsSync(configPath)) return "on";
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { mode?: unknown };
		if (parsed.mode === "compact" || parsed.mode === "off" || parsed.mode === "on") {
			return parsed.mode;
		}
	} catch {
		// Fall back to "on" if the file is unreadable.
	}
	return "on";
}

export default function registerCcstyleToggleShortcut(pi: ExtensionAPI): void {
	pi.registerShortcut("alt+c", {
		description: "Toggle Claude Code style between on (show tool cards) and compact (fold intermediate tool calls)",
		handler: (ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			const hasCcstyle = pi.getCommands().some((command) => command.name === "ccstyle");
			if (!hasCcstyle) {
				ctx.ui.notify("/ccstyle command is not available (pi-cc-extensions not loaded).", "warning");
				return;
			}
			const current = readCurrentCcstyleMode();
			const nextMode = current === "compact" ? "on" : "compact";
			pi.sendUserMessage(`/ccstyle ${nextMode}`, { expandPromptTemplates: true } as never);
		},
	});
}
