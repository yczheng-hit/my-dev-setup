/**
 * Hot-sync ~/.pi/agent/settings.json and ~/.pi/agent/models.json across running Pi panes.
 *
 * When any pane updates defaultProvider/defaultModel, defaultThinkingLevel,
 * modelThinkingLevels, enabledModels, or models.json on disk, other panes
 * automatically pick up the change (immediately if idle, or on agent_settled).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WatchedSettingsSnapshot {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	modelThinkingLevels?: Record<string, string>;
	enabledModels?: string[];
}

export function readSettingsSnapshot(settingsPath: string): WatchedSettingsSnapshot | undefined {
	try {
		if (!fs.existsSync(settingsPath)) return undefined;
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (!raw || typeof raw !== "object") return undefined;
		return {
			defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
			defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
			defaultThinkingLevel:
				typeof raw.defaultThinkingLevel === "string" ? raw.defaultThinkingLevel : undefined,
			modelThinkingLevels:
				raw.modelThinkingLevels && typeof raw.modelThinkingLevels === "object"
					? { ...raw.modelThinkingLevels }
					: undefined,
			enabledModels: Array.isArray(raw.enabledModels)
				? raw.enabledModels.filter((x: unknown): x is string => typeof x === "string")
				: undefined,
		};
	} catch {
		return undefined;
	}
}

export function diffSettingsSnapshot(
	prev: WatchedSettingsSnapshot | undefined,
	next: WatchedSettingsSnapshot | undefined,
): {
	modelChanged: boolean;
	thinkingChanged: boolean;
	enabledModelsChanged: boolean;
} {
	if (!prev || !next) {
		return { modelChanged: false, thinkingChanged: false, enabledModelsChanged: false };
	}
	const modelChanged =
		Boolean(next.defaultProvider && next.defaultModel) &&
		(prev.defaultProvider !== next.defaultProvider || prev.defaultModel !== next.defaultModel);
	const thinkingChanged =
		prev.defaultThinkingLevel !== next.defaultThinkingLevel ||
		JSON.stringify(prev.modelThinkingLevels ?? {}) !== JSON.stringify(next.modelThinkingLevels ?? {});
	const enabledModelsChanged =
		JSON.stringify(prev.enabledModels ?? null) !== JSON.stringify(next.enabledModels ?? null);
	return { modelChanged, thinkingChanged, enabledModelsChanged };
}

function fileMtimeMs(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

export default function hotSyncSettings(pi: ExtensionAPI): void {
	let activeCtx: ExtensionContext | undefined;
	let lastSettings: WatchedSettingsSnapshot | undefined;
	let lastSettingsMtime = 0;
	let lastModelsMtime = 0;
	let pendingSync = false;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let watchers: fs.FSWatcher[] = [];
	let applyingExternalChange = false;

	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const settingsPath = path.join(agentDir, "settings.json");
	const modelsPath = path.join(agentDir, "models.json");
	async function applyChanges(ctx: ExtensionContext): Promise<void> {
		if (applyingExternalChange) return;
		applyingExternalChange = true;
		try {
			let modelsRefreshed = false;
			const modelsMtime = fileMtimeMs(modelsPath);
			if (modelsMtime > 0 && modelsMtime !== lastModelsMtime) {
				lastModelsMtime = modelsMtime;
				try {
					await ctx.modelRegistry.refresh({ allowNetwork: false });
					modelsRefreshed = true;
				} catch {}
			}

			const settingsMtime = fileMtimeMs(settingsPath);
			const settingsChanged = settingsMtime > 0 && settingsMtime !== lastSettingsMtime;
			if (!settingsChanged && !modelsRefreshed) return;
			if (settingsChanged) lastSettingsMtime = settingsMtime;

			const next = readSettingsSnapshot(settingsPath) ?? lastSettings;
			if (!next) return;
			const prev = lastSettings;
			lastSettings = next;
			if (!prev) return;

			const diff = diffSettingsSnapshot(prev, next);
			if (!modelsRefreshed && !diff.modelChanged && !diff.thinkingChanged && !diff.enabledModelsChanged) {
				return;
			}

			// 1. Update session._scopedModels in-place so Ctrl+P and /model immediately use the new scope
			if (diff.enabledModelsChanged || modelsRefreshed) {
				try {
					const liveScoped = ctx.scopedModels as unknown as Array<{ model: any; thinkingLevel?: any }>;
					const available = ctx.modelRegistry.getAvailable();
					if (Array.isArray(liveScoped) && Array.isArray(available)) {
						if (Array.isArray(next.enabledModels) && next.enabledModels.length > 0) {
							const byKey = new Map(available.map((m) => [`${m.provider}/${m.id}`.toLowerCase(), m]));
							const nextScoped: Array<{ model: any; thinkingLevel?: any }> = [];
							for (const pattern of next.enabledModels) {
								const m = byKey.get(pattern.toLowerCase());
								if (m && !nextScoped.some((s) => s.model.provider === m.provider && s.model.id === m.id)) {
									nextScoped.push({ model: m });
								}
							}
							liveScoped.splice(0, liveScoped.length, ...nextScoped);
						} else {
							liveScoped.splice(0, liveScoped.length);
						}
					}
				} catch {}
			}

			// 2. Sync default model if changed in another pane
			if (diff.modelChanged && next.defaultProvider && next.defaultModel) {
				const current = ctx.model;
				if (!current || current.provider !== next.defaultProvider || current.id !== next.defaultModel) {
					const target = ctx.modelRegistry.find(next.defaultProvider, next.defaultModel);
					if (target) {
						await pi.setModel(target);
					}
				}
			}

			// 3. Sync thinking level if defaultThinkingLevel or per-model thinking level changed
			if (diff.thinkingChanged) {
				const model = ctx.model;
				const modelKey = model ? `${model.provider}/${model.id}` : undefined;
				const perModelLevel = modelKey ? next.modelThinkingLevels?.[modelKey] : undefined;
				const desiredLevel = (perModelLevel ?? next.defaultThinkingLevel) as any;
				if (desiredLevel && pi.getThinkingLevel() !== desiredLevel) {
					pi.setThinkingLevel(desiredLevel);
				}
			}
		} finally {
			applyingExternalChange = false;
		}
	}

	function scheduleCheck(): void {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			const ctx = activeCtx;
			if (!ctx) return;
			if (ctx.isIdle()) {
				pendingSync = false;
				void applyChanges(ctx);
			} else {
				pendingSync = true;
			}
		}, 150);
		debounceTimer.unref?.();
	}

	function cleanup(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
	}

	pi.on("session_start", (_event, ctx) => {
		cleanup();
		activeCtx = ctx;
		lastSettingsMtime = fileMtimeMs(settingsPath);
		lastModelsMtime = fileMtimeMs(modelsPath);
		lastSettings = readSettingsSnapshot(settingsPath);

		// Watch agentDir for atomic rename updates to settings.json / models.json
		try {
			if (fs.existsSync(agentDir)) {
				const watcher = fs.watch(agentDir, (_eventType, filename) => {
					if (!filename || filename === "settings.json" || filename === "models.json") {
						scheduleCheck();
					}
				});
				watcher.unref?.();
				watchers.push(watcher);
			}
		} catch {}

		// Lightweight 3s mtime poll fallback in case atomic rename events are coalesced by OS
		pollTimer = setInterval(() => {
			const sMtime = fileMtimeMs(settingsPath);
			const mMtime = fileMtimeMs(modelsPath);
			if (sMtime !== lastSettingsMtime || mMtime !== lastModelsMtime) {
				scheduleCheck();
			}
		}, 3_000);
		pollTimer.unref?.();
	});

	pi.on("model_select", () => {
		// Record our own pane's saves so we don't re-trigger on our own write
		setTimeout(() => {
			lastSettingsMtime = fileMtimeMs(settingsPath);
			lastSettings = readSettingsSnapshot(settingsPath) ?? lastSettings;
		}, 80).unref?.();
	});

	pi.on("thinking_level_select", () => {
		setTimeout(() => {
			lastSettingsMtime = fileMtimeMs(settingsPath);
			lastSettings = readSettingsSnapshot(settingsPath) ?? lastSettings;
		}, 80).unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeCtx = ctx;
		if (pendingSync && ctx.isIdle()) {
			pendingSync = false;
			void applyChanges(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		cleanup();
		activeCtx = undefined;
	});
}
