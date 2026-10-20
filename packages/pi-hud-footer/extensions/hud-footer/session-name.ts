// local patch: session name display and /rename (not in upstream pi-hud-footer).
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { HudLanguage } from "./types.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** Longest session name shown in the HUD, in terminal columns, so the other segments stay visible. */
export const SESSION_NAME_MAX_WIDTH = 32;

const MESSAGES = {
	en: {
		label: "session",
		description: "Rename the current session (shown in the HUD and /resume).",
		prompt: "Rename session",
		emptyPlaceholder: "New session name",
		renamed: (name: string) => `Session renamed: ${name}`,
		unchanged: "Session name unchanged.",
		usage: (current: string | undefined) =>
			current ? `Session name: ${current}. Usage: /rename <new name>` : "Usage: /rename <new name>",
	},
	zh: {
		label: "会话",
		description: "重命名当前会话（显示在 HUD 和 /resume 列表中）。",
		prompt: "重命名会话",
		emptyPlaceholder: "新的会话名称",
		renamed: (name: string) => `会话已重命名：${name}`,
		unchanged: "会话名称未改变。",
		usage: (current: string | undefined) =>
			current ? `当前会话名称：${current}。用法：/rename <新名称>` : "用法：/rename <新名称>",
	},
} as const;


/** Normalize a name the same way Pi stores it: newlines folded into spaces, then trimmed. */
export function normalizeSessionName(value: string | undefined): string {
	return (value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/** Themed HUD segment for the session name, or undefined when the session is unnamed. */
export function sessionNameText(name: string | undefined, theme: Theme, language: HudLanguage): string | undefined {
	const normalized = normalizeSessionName(name);
	if (!normalized) return undefined;
	const shown = truncateToWidth(normalized, SESSION_NAME_MAX_WIDTH, "…");
	return `${theme.fg("muted", `${MESSAGES[language].label}:`)}${theme.fg("text", shown)}`;
}

/** Register `/rename [name]`. Without a name, the TUI asks for one. */
export function registerRenameCommand(pi: ExtensionAPI, language: () => HudLanguage, initialLanguage: HudLanguage) {
	pi.registerCommand("rename", {
		description: MESSAGES[initialLanguage].description,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const messages = MESSAGES[language()];
			const current = normalizeSessionName(pi.getSessionName()) || undefined;
			let next = normalizeSessionName(args);

			if (!next) {
				if (!ctx.hasUI) {
					ctx.ui.notify(messages.usage(current), "info");
					return;
				}
				next = normalizeSessionName(await ctx.ui.input(messages.prompt, current ?? messages.emptyPlaceholder));
				if (!next) {
					ctx.ui.notify(messages.unchanged, "info");
					return;
				}
			}

			if (next === current) {
				ctx.ui.notify(messages.unchanged, "info");
				return;
			}
			pi.setSessionName(next);
			ctx.ui.notify(messages.renamed(normalizeSessionName(pi.getSessionName()) || next), "info");
		},
	});
}
