/**
 * Restore the just-submitted interactive prompt to the editor when cancelled with Esc
 * before any tool executes, and omit the aborted prompt from model context via native
 * context_edit entries (without navigating the session tree or closing /btw).
 */
import type { ContextEditEntryDraft, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const STEER_INTERRUPT_ENTRY = "cc-steer.interrupted";
const PROBE_WIDGET_KEY = "esc-restore-input-probe";

type ChatContainerLike = {
	children?: unknown[];
	invalidate?: () => void;
};

type ScreenLike = {
	getPrimaryScrollView?: () => { child?: { children?: unknown[] } } | undefined;
	children?: Array<{ children?: unknown[] }>;
	requestRender?: () => void;
};

function unwrapScreen(raw: unknown): ScreenLike | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const ref = raw as Record<string, unknown>;
	const probe = "__escRestoreUnwrap__";
	ref[probe] = function (this: unknown) {
		return this;
	};
	let target: unknown;
	try {
		target = (ref[probe] as () => unknown)();
		return (target ?? ref) as ScreenLike;
	} catch {
		return ref as ScreenLike;
	} finally {
		if (target && typeof target === "object") {
			delete (target as Record<string, unknown>)[probe];
		}
		delete ref[probe];
	}
}

function resolveChatContainer(screen: ScreenLike | undefined): ChatContainerLike | undefined {
	if (!screen) return undefined;
	const doc = screen.getPrimaryScrollView?.()?.child ?? screen.children?.[0];
	const chat = doc?.children?.[2] as ChatContainerLike | undefined;
	return chat && Array.isArray(chat.children) ? chat : undefined;
}

interface ActiveRun {
	rawText: string;
	preRunLeafId: string | null;
	chatChildCountBefore?: number;
	started: boolean;
	toolExecuted: boolean;
	midTurnInputSeen: boolean;
	completedTurns: number;
}

function findAbortedUserEntry(branch: SessionEntry[], preRunLeafId: string | null): SessionEntry | null | "unsafe" {
	let startIndex = 0;
	if (preRunLeafId !== null) {
		const idx = branch.findIndex((entry) => entry.id === preRunLeafId);
		if (idx === -1) return "unsafe";
		startIndex = idx + 1;
	}

	const added = branch.slice(startIndex);
	if (added.length === 0) return null;

	let userEntry: SessionEntry | null = null;
	for (const entry of added) {
		if (entry.type === "custom" && entry.customType === STEER_INTERRUPT_ENTRY) {
			return "unsafe";
		}
		if (entry.type !== "message") continue;

		const role = entry.message.role;
		if (role === "user") {
			if (userEntry !== null) return "unsafe";
			userEntry = entry;
			continue;
		}
		if (role === "toolResult" || role === "bashExecution") {
			return "unsafe";
		}
		if (role === "assistant") {
			const stopReason = entry.message.stopReason;
			if (stopReason !== "aborted" && stopReason !== "error") {
				return "unsafe";
			}
			if ((entry.message as { ccSteerInterrupted?: boolean }).ccSteerInterrupted) {
				return "unsafe";
			}
		}
	}

	return userEntry;
}

export default function escRestoreInput(pi: ExtensionAPI) {
	let activeRun: ActiveRun | undefined;
	let liveScreen: ScreenLike | undefined;

	const reset = () => {
		activeRun = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		reset();
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget(PROBE_WIDGET_KEY, (tui) => {
				liveScreen = unwrapScreen(tui);
				return { render: () => [], invalidate: () => {} };
			});
			ctx.ui.setWidget(PROBE_WIDGET_KEY, undefined);
		} catch {
			// Ignore in headless/non-widget harnesses
		}
	});
	pi.on("session_shutdown", reset);

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;
		if (event.streamingBehavior !== undefined) {
			if (activeRun) activeRun.midTurnInputSeen = true;
			return;
		}
		if (!event.text.trim()) return;
		const chat = resolveChatContainer(liveScreen);
		activeRun = {
			rawText: event.text,
			preRunLeafId: ctx.sessionManager.getLeafId(),
			chatChildCountBefore: chat?.children?.length,
			started: false,
			toolExecuted: false,
			midTurnInputSeen: false,
			completedTurns: 0,
		};
	});

	pi.on("before_agent_start", () => {
		if (activeRun) activeRun.started = true;
	});

	pi.on("agent_start", () => {
		if (activeRun) activeRun.started = true;
	});

	pi.on("tool_execution_start", () => {
		if (activeRun) activeRun.toolExecuted = true;
	});

	pi.on("message_end", (event) => {
		if (!activeRun) return;
		const msg = event.message as { role?: string; ccSteerInterrupted?: boolean };
		if (msg.role === "assistant" && msg.ccSteerInterrupted) {
			activeRun.midTurnInputSeen = true;
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!activeRun) return;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		const aborted = stopReason === "aborted" || Boolean(ctx.signal?.aborted);
		if (!aborted && stopReason !== "error") {
			activeRun.completedTurns += 1;
			return;
		}

		if (!aborted || !activeRun.started) return;
		if (activeRun.toolExecuted || activeRun.completedTurns > 0 || activeRun.midTurnInputSeen) return;
		if (!ctx.hasUI || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() !== "") return;

		const target = findAbortedUserEntry(ctx.sessionManager.getBranch(), activeRun.preRunLeafId);
		if (!target || target === "unsafe") return;

		const edits: ContextEditEntryDraft[] = [
			{ type: "context_edit", targetId: target.id, replacement: null },
		];
		if (event.messageEntryId) {
			edits.push({ type: "context_edit", targetId: event.messageEntryId, replacement: null });
		}
		return {
			entries: [...(event.entries ?? []), ...edits],
		};
	});

	pi.on("agent_settled", (event, ctx) => {
		const run = activeRun;
		activeRun = undefined;

		if (!event.aborted || !run || !run.started) return;
		if (run.toolExecuted || run.completedTurns > 0 || run.midTurnInputSeen) return;
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() !== "") return;

		const target = findAbortedUserEntry(ctx.sessionManager.getBranch(), run.preRunLeafId);
		if (target === "unsafe") return;

		const chat = resolveChatContainer(liveScreen);
		if (
			chat?.children &&
			typeof run.chatChildCountBefore === "number" &&
			chat.children.length > run.chatChildCountBefore
		) {
			chat.children.splice(run.chatChildCountBefore);
			chat.invalidate?.();
			liveScreen?.requestRender?.();
		}

		ctx.ui.setEditorText(run.rawText);
		ctx.ui.notify("已取消并退回输入框", "info");
	});
}
