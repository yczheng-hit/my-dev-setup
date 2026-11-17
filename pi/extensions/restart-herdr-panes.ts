import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface HerdrAgentItem {
	agent?: string;
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent_status?: string;
	cwd?: string;
	foreground_cwd?: string;
	agent_session?: {
		kind?: string;
		value?: string;
	};
}

interface RestartPlanEntry {
	paneId: string;
	status: string;
	sessionFile?: string;
	cwd: string;
	isCurrent: boolean;
	isBusy: boolean;
	action: "restart" | "skip";
	reason: string;
}

function parseCommandArgs(rawArgs: string) {
	const tokens = rawArgs
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	const options = {
		all: false,
		includeBusy: false,
		includeCurrent: false,
		dryRun: false,
		panes: [] as string[],
	};

	for (let i = 0; i < tokens.length; i++) {
		const arg = tokens[i]!;
		if (arg === "all" || arg === "--all" || arg === "-a") {
			options.all = true;
			options.includeBusy = true;
			options.includeCurrent = true;
		} else if (arg === "--include-busy" || arg === "busy") {
			options.includeBusy = true;
		} else if (arg === "--include-current" || arg === "current") {
			options.includeCurrent = true;
		} else if (arg === "--dry-run" || arg === "-n" || arg === "dry-run") {
			options.dryRun = true;
		} else if (arg === "--pane" && tokens[i + 1]) {
			for (const p of tokens[++i]!.split(",")) {
				if (p.trim()) options.panes.push(p.trim());
			}
		} else if (arg.startsWith("--pane=")) {
			for (const p of arg.slice("--pane=".length).split(",")) {
				if (p.trim()) options.panes.push(p.trim());
			}
		} else if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(arg)) {
			options.panes.push(arg);
		} else {
			throw new Error(
				`未知参数: ${arg}（可用: all | --all | --include-busy | --include-current | --pane <id> | --dry-run）`,
			);
		}
	}
	return options;
}

function buildPlan(agents: HerdrAgentItem[], options: ReturnType<typeof parseCommandArgs>) {
	const currentPaneId = process.env.HERDR_PANE_ID ?? "";
	const explicitPanes = new Set(options.panes);
	const filterExplicit = explicitPanes.size > 0;
	const entries: RestartPlanEntry[] = [];

	for (const item of agents) {
		if (!item || item.agent !== "pi") continue;
		const paneId = item.pane_id;
		if (filterExplicit && !explicitPanes.has(paneId)) continue;

		const status = item.agent_status ?? "unknown";
		const sessionFile =
			item.agent_session?.kind === "path" && typeof item.agent_session.value === "string"
				? item.agent_session.value
				: undefined;
		const cwd = item.foreground_cwd || item.cwd || "";
		const isCurrent = Boolean(currentPaneId && paneId === currentPaneId);
		const isBusy = status === "working" || status === "blocked";

		let action: "restart" | "skip" = "restart";
		let reason = "ready";

		if (!sessionFile || !path.isAbsolute(sessionFile) || !fs.existsSync(sessionFile)) {
			action = "skip";
			reason = "无有效会话 .jsonl";
		} else if (isCurrent && !options.includeCurrent && !options.all && !explicitPanes.has(paneId)) {
			action = "skip";
			reason = "当前面板（传 all 可包含）";
		} else if (isBusy && !options.includeBusy && !options.all && !explicitPanes.has(paneId)) {
			action = "skip";
			reason = `状态=${status}（传 all 或 --include-busy 可包含）`;
		}

		entries.push({
			paneId,
			status,
			sessionFile,
			cwd,
			isCurrent,
			isBusy,
			action,
			reason,
		});
	}

	entries.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? 1 : -1;
		return a.paneId.localeCompare(b.paneId);
	});

	return {
		entries,
		toRestart: entries.filter((e) => e.action === "restart"),
		skipped: entries.filter((e) => e.action === "skip"),
	};
}

function resolveScriptPath(): string {
	const candidates = [
		path.join(process.env.HOME ?? "", ".local/bin/pi-restart-herdr-panes"),
		path.join(process.env.HOME ?? "", "tools/my-dev-setup/scripts/pi-restart-herdr-panes.mjs"),
	];
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	return "pi-restart-herdr-panes";
}

export default function restartHerdrPanesExtension(pi: ExtensionAPI) {
	const handler = async (rawArgs: string, ctx: any) => {
		if (process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("必须在 Herdr 面板内运行（需要 HERDR_ENV=1）", "error");
			return;
		}

		let options: ReturnType<typeof parseCommandArgs>;
		try {
			options = parseCommandArgs(rawArgs);
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}

		const listRes = spawnSync("herdr", ["agent", "list"], { encoding: "utf8", timeout: 15_000 });
		if (listRes.status !== 0) {
			ctx.ui.notify(`herdr agent list 失败: ${(listRes.stderr || listRes.stdout || "").trim()}`, "error");
			return;
		}

		let agents: HerdrAgentItem[] = [];
		try {
			const parsed = JSON.parse(listRes.stdout || "{}");
			agents = parsed?.result?.agents ?? [];
		} catch (err) {
			ctx.ui.notify(`解析 herdr agent list 失败: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const plan = buildPlan(agents, options);
		const summaryLines: string[] = [];
		if (plan.toRestart.length > 0) {
			summaryLines.push(`准备重启 (${plan.toRestart.length} 个):`);
			for (const entry of plan.toRestart) {
				const dir = entry.cwd ? path.basename(entry.cwd) || entry.cwd : "-";
				const flags = [entry.status, dir, ...(entry.isCurrent ? ["当前面板"] : [])].join(" · ");
				summaryLines.push(`  • ${entry.paneId} (${flags})`);
			}
		}
		if (plan.skipped.length > 0) {
			summaryLines.push(`跳过 (${plan.skipped.length} 个):`);
			for (const entry of plan.skipped) {
				const dir = entry.cwd ? path.basename(entry.cwd) || entry.cwd : "-";
				summaryLines.push(`  - ${entry.paneId} (${dir}): ${entry.reason}`);
			}
		}

		if (options.dryRun) {
			ctx.ui.notify(summaryLines.join("\n") || "未找到任何 Pi 面板", "info");
			return;
		}

		if (plan.toRestart.length === 0) {
			ctx.ui.notify(
				`没有可重启的空闲 Pi 面板。\n${summaryLines.join("\n")}\n提示: 使用 /restart-panes all 可包含忙碌和当前面板`,
				"info",
			);
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify("/restart-panes 需要交互式 TUI 确认授权", "error");
			return;
		}

		const approved = await ctx.ui.confirm(
			`确认重启 ${plan.toRestart.length} 个 Herdr Pi 面板？`,
			`${summaryLines.join("\n")}\n\n重启后将自动通过 --session 原样恢复各面板会话并校验版本。`,
		);
		if (!approved) {
			ctx.ui.notify("已取消重启 Pi 面板", "info");
			return;
		}

		const scriptPath = resolveScriptPath();
		const cliArgs = [
			scriptPath,
			"--yes",
			...plan.toRestart.map((e) => `--pane=${e.paneId}`),
			...(options.includeBusy || options.all ? ["--include-busy"] : []),
			...(options.includeCurrent || options.all ? ["--include-current"] : []),
		];

		const includesCurrent = plan.toRestart.some((e) => e.isCurrent);
		if (includesCurrent) {
			ctx.ui.notify(
				`正在后台依序重启 ${plan.toRestart.length} 个面板（当前面板排在最后自动重启并恢复当前会话）…`,
				"info",
			);
			const child = spawn(process.execPath, cliArgs, {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			child.unref();
			return;
		}

		ctx.ui.notify(`开始重启 ${plan.toRestart.length} 个 Pi 面板…`, "info");
		const res = spawnSync(process.execPath, cliArgs, {
			encoding: "utf8",
			timeout: Math.max(60_000, plan.toRestart.length * 60_000),
			env: process.env,
		});
		if (res.status !== 0) {
			ctx.ui.notify(
				`重启部分或全部失败:\n${(res.stderr || res.stdout || "").trim()}`,
				"error",
			);
			return;
		}
		const okLines = (res.stdout || "")
			.split("\n")
			.filter((l) => l.startsWith("OK\t"))
			.join("\n");
		ctx.ui.notify(
			`已完成 ${plan.toRestart.length} 个 Pi 面板重启与版本校验:\n${okLines}`,
			"info",
		);
	};

	pi.registerCommand("restart-panes", {
		description: "Restart Herdr Pi panes to the current version and restore their sessions (use 'all' to include busy & current)",
		handler,
	});
	pi.registerCommand("restart-herdr-panes", {
		description: "Alias for /restart-panes",
		handler,
	});
}
