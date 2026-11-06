/**
 * Restore the just-submitted interactive prompt to the editor when cancelled with Esc
 * before any tool executes, and rewind the aborted prompt from the active session branch.
 */
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const RESTORE_CMD = "undo-prompt";
const STEER_INTERRUPT_ENTRY = "cc-steer.interrupted";

interface ActiveRun {
	rawText: string;
	preRunLeafId: string | null;
	started: boolean;
	toolExecuted: boolean;
	midTurnInputSeen: boolean;
	completedTurns: number;
}

interface PendingRewind {
	userEntryId: string;
	preRunLeafId: string | null;
	expectedLeafId: string | null;
	rawText: string;
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
	let pendingRewind: PendingRewind | undefined;

	const reset = () => {
		activeRun = undefined;
		pendingRewind = undefined;
	};

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;
		if (event.streamingBehavior !== undefined) {
			if (activeRun) activeRun.midTurnInputSeen = true;
			return;
		}
		if (!event.text.trim()) return;
		activeRun = {
			rawText: event.text,
			preRunLeafId: ctx.sessionManager.getLeafId(),
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
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		const run = activeRun;
		activeRun = undefined;
		pendingRewind = undefined;

		if (!event.aborted || !run || !run.started) return;
		if (run.toolExecuted || run.completedTurns > 0 || run.midTurnInputSeen) return;
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() !== "") return;

		const branch = ctx.sessionManager.getBranch();
		const target = findAbortedUserEntry(branch, run.preRunLeafId);
		if (target === "unsafe") return;

		if (target === null) {
			ctx.ui.setEditorText(run.rawText);
			ctx.ui.notify("已取消并退回输入框", "info");
			return;
		}

		pendingRewind = {
			userEntryId: target.id,
			preRunLeafId: run.preRunLeafId,
			expectedLeafId: ctx.sessionManager.getLeafId(),
			rawText: run.rawText,
		};
		pi.sendUserMessage(`/${RESTORE_CMD}`, { expandPromptTemplates: true });
	});

	pi.registerCommand(RESTORE_CMD, {
		description: "撤回刚中断的用户输入并恢复到输入框",
		handler: async (_args, ctx) => {
			const target = pendingRewind;
			pendingRewind = undefined;
			if (!target || !ctx.hasUI) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

			const currentDraft = ctx.ui.getEditorText();
			if (currentDraft.trim() !== "" && currentDraft !== target.rawText) return;
			if (ctx.sessionManager.getLeafId() !== target.expectedLeafId) return;

			const branch = ctx.sessionManager.getBranch();
			const check = findAbortedUserEntry(branch, target.preRunLeafId);
			if (check === "unsafe" || !check || check.id !== target.userEntryId) return;

			const result = await ctx.navigateTree(target.userEntryId, { summarize: false });
			if (result.cancelled) return;

			ctx.ui.setEditorText(target.rawText);
			ctx.ui.notify("已取消并退回输入框", "info");
		},
	});
}
