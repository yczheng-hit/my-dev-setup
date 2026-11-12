import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ToolLoadoutState {
	planModeActive: boolean;
	goalModeActive: boolean;
	piContextUsed: boolean;
	reviewOutputActive: boolean;
	webSearchUsed: boolean;
	schedulerManagementActive: boolean;
	bgTasksActive: boolean;
	obsRecallAvailable: boolean;
	contextRecallAvailable: boolean;
}

const SCHEDULE_PROMPT_RE = /\b(schedule|scheduled|cron|timer|reminder|wake)\b|定时|提醒|计划任务/i;
const BG_PROMPT_RE = /\b(bg_list|bg_output|bg_stop|background\s+task|background\s+process)\b|后台任务/i;

export function deriveToolLoadoutState(
	entries: any[],
	options: {
		defaultPlanMode?: boolean;
		promptText?: string;
		reviewUsedInSession?: boolean;
		webSearchUsedInSession?: boolean;
		schedulerUsedInSession?: boolean;
		bgTasksUsedInSession?: boolean;
	} = {},
): ToolLoadoutState {
	let planModeActive: boolean | undefined;
	let goalModeActive: boolean | undefined;
	let piContextUsed = false;
	let reviewOutputActive = Boolean(options.reviewUsedInSession);
	let webSearchUsed = Boolean(options.webSearchUsedInSession);
	let schedulerManagementActive = Boolean(options.schedulerUsedInSession);
	let bgTasksActive = Boolean(options.bgTasksUsedInSession);
	let obsRecallAvailable = false;
	let contextRecallAvailable = false;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;

		if (planModeActive === undefined) {
			if (entry.type === "custom" && entry.customType === "modes") {
				planModeActive = entry.data?.mode === "plan";
			} else if (entry.type === "custom_message" && entry.customType === "permission-modes:plan-mode") {
				planModeActive = true;
			} else if (entry.type === "custom_message" && entry.customType === "permission-modes:plan-mode-exit") {
				planModeActive = false;
			}
		}

		if (goalModeActive === undefined) {
			if (entry.type === "custom" && (entry.customType === "goal-state" || entry.customType === "goals-state")) {
				const status = entry.data?.goal?.status;
				goalModeActive = Boolean(
					entry.data?.goal && (status === "active" || status === "budget_limited" || status === "waiting"),
				);
			} else if (entry.type === "custom_message" && entry.customType === "goal-contract") {
				goalModeActive = entry.details?.state === "active";
			}
		}

		if (entry.type === "compaction") {
			contextRecallAvailable = true;
		}

		if (typeof entry.customType === "string") {
			if (entry.customType.startsWith("pi-context")) piContextUsed = true;
			if (entry.customType.includes("supi-review")) reviewOutputActive = true;
			if (entry.customType.includes("scheduler")) schedulerManagementActive = true;
			if (entry.customType.includes("sol-pi") || entry.customType.includes("ambient-compact")) {
				obsRecallAvailable = true;
				contextRecallAvailable = true;
			}
		}

		const msg = entry.type === "message" ? entry.message : undefined;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block?.type !== "toolCall") continue;
				const name = block.name;
				if (
					name === "context_checkpoint" ||
					name === "context_compact" ||
					name === "context_timeline"
				) {
					piContextUsed = true;
				}
				if (name === "review_run" || name === "review_output") {
					reviewOutputActive = true;
				}
				if (
					name === "web_search" ||
					name === "source_check" ||
					name === "fetch_content" ||
					name === "get_search_content"
				) {
					webSearchUsed = true;
				}
				if (
					name === "schedule_task" ||
					name === "list_scheduled_tasks" ||
					name === "cancel_scheduled_task" ||
					name === "manage_scheduled_task"
				) {
					schedulerManagementActive = true;
				}
				if (
					name === "bg_list" ||
					name === "bg_output" ||
					name === "bg_stop" ||
					(name === "bash" && block.arguments?.run_in_background === true)
				) {
					bgTasksActive = true;
				}
			}
		} else if (msg?.role === "toolResult" || msg?.role === "user") {
			const serialized = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			if (serialized.includes("pi-bg-tasks") || serialized.includes("auto-backgrounded") || serialized.includes("<task-notification>")) {
				bgTasksActive = true;
			}
			if (serialized.includes("obs_")) {
				obsRecallAvailable = true;
			}
			if (serialized.includes("ctx_")) {
				contextRecallAvailable = true;
			}
		}
	}

	if (typeof options.promptText === "string" && options.promptText.length > 0) {
		if (options.promptText.includes("Goal mode is active") || options.promptText.includes("goal_complete")) {
			goalModeActive = true;
		}
		if (SCHEDULE_PROMPT_RE.test(options.promptText)) {
			schedulerManagementActive = true;
		}
		if (BG_PROMPT_RE.test(options.promptText) || options.promptText.includes("<task-notification>")) {
			bgTasksActive = true;
		}
	}

	return {
		planModeActive: planModeActive ?? Boolean(options.defaultPlanMode),
		goalModeActive: goalModeActive ?? false,
		piContextUsed,
		reviewOutputActive,
		webSearchUsed,
		schedulerManagementActive,
		bgTasksActive,
		obsRecallAvailable,
		contextRecallAvailable,
	};
}

export function computeHiddenDeclarations(
	declaredToolNames: Iterable<string>,
	state: ToolLoadoutState,
): string[] {
	const declared = new Set(declaredToolNames);
	const hidden: string[] = [];

	if (!state.planModeActive && declared.has("ExitPlanMode")) {
		hidden.push("ExitPlanMode");
	}

	if (!state.goalModeActive) {
		for (const name of ["goal_complete", "goal_blocked", "goal_wait"]) {
			if (declared.has(name)) hidden.push(name);
		}
	}

	const ambientCompactActive = declared.has("update_plan") || declared.has("context_recall");
	if (ambientCompactActive && !state.piContextUsed) {
		for (const name of ["context_compact", "context_checkpoint", "context_timeline"]) {
			if (declared.has(name)) hidden.push(name);
		}
	}

	if (declared.has("questionnaire") && declared.has("question")) {
		hidden.push("question");
	}

	if (declared.has("update_plan") && declared.has("todo")) {
		hidden.push("todo");
	}

	if (!state.reviewOutputActive && declared.has("review_output")) {
		hidden.push("review_output");
	}

	if (!state.webSearchUsed && declared.has("get_search_content")) {
		hidden.push("get_search_content");
	}

	if (!state.schedulerManagementActive) {
		for (const name of ["manage_scheduled_task", "list_scheduled_tasks", "cancel_scheduled_task"]) {
			if (declared.has(name)) hidden.push(name);
		}
	}

	if (!state.bgTasksActive) {
		for (const name of ["bg_list", "bg_output", "bg_stop"]) {
			if (declared.has(name)) hidden.push(name);
		}
	}

	if (!state.obsRecallAvailable && declared.has("obs_recall")) {
		hidden.push("obs_recall");
	}

	if (!state.contextRecallAvailable && declared.has("context_recall")) {
		hidden.push("context_recall");
	}

	return hidden;
}

export function createToolLoadoutDietController(pi: ExtensionAPI) {
	let reviewUsedInSession = false;
	let webSearchUsedInSession = false;
	let schedulerUsedInSession = false;
	let bgTasksUsedInSession = false;
	let loadoutState: ToolLoadoutState = {
		planModeActive: process.env.PICC_PERMISSION_MODE === "plan",
		goalModeActive: false,
		piContextUsed: false,
		reviewOutputActive: false,
		webSearchUsed: false,
		schedulerManagementActive: false,
		bgTasksActive: false,
		obsRecallAvailable: false,
		contextRecallAvailable: false,
	};

	function syncLoadoutState(ctx?: { sessionManager?: any }, promptText?: string): boolean {
		const entries =
			ctx?.sessionManager?.getBranch?.() ??
			ctx?.sessionManager?.getEntries?.() ??
			[];
		const defaultPlanMode =
			pi.getFlag?.("permission-mode") === "plan" || process.env.PICC_PERMISSION_MODE === "plan";
		const next = deriveToolLoadoutState(entries, {
			defaultPlanMode,
			promptText,
			reviewUsedInSession,
			webSearchUsedInSession,
			schedulerUsedInSession,
			bgTasksUsedInSession,
		});
		const changed =
			next.planModeActive !== loadoutState.planModeActive ||
			next.goalModeActive !== loadoutState.goalModeActive ||
			next.piContextUsed !== loadoutState.piContextUsed ||
			next.reviewOutputActive !== loadoutState.reviewOutputActive ||
			next.webSearchUsed !== loadoutState.webSearchUsed ||
			next.schedulerManagementActive !== loadoutState.schedulerManagementActive ||
			next.bgTasksActive !== loadoutState.bgTasksActive ||
			next.obsRecallAvailable !== loadoutState.obsRecallAvailable ||
			next.contextRecallAvailable !== loadoutState.contextRecallAvailable;
		loadoutState = next;
		return changed;
	}

	function refreshActiveToolLoadout(): void {
		const active = pi.getActiveTools?.();
		if (Array.isArray(active) && active.length > 0) {
			pi.setActiveTools?.(active);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		reviewUsedInSession = false;
		webSearchUsedInSession = false;
		schedulerUsedInSession = false;
		bgTasksUsedInSession = false;
		syncLoadoutState(ctx);
		refreshActiveToolLoadout();
	});

	pi.on("session_tree", (_event, ctx) => {
		if (syncLoadoutState(ctx)) {
			refreshActiveToolLoadout();
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		syncLoadoutState(ctx, event?.prompt);
	});

	pi.on("tool_execution_start", (event) => {
		const toolName = event?.toolName;
		let changed = false;
		if ((toolName === "review_run" || toolName === "review_output") && !reviewUsedInSession) {
			reviewUsedInSession = true;
			loadoutState = { ...loadoutState, reviewOutputActive: true };
			changed = true;
		}
		if (
			(toolName === "web_search" || toolName === "source_check" || toolName === "fetch_content") &&
			!webSearchUsedInSession
		) {
			webSearchUsedInSession = true;
			loadoutState = { ...loadoutState, webSearchUsed: true };
			changed = true;
		}
		if (toolName === "schedule_task" && !schedulerUsedInSession) {
			schedulerUsedInSession = true;
			loadoutState = { ...loadoutState, schedulerManagementActive: true };
			changed = true;
		}
		if (toolName === "bash" && event?.args?.run_in_background === true && !bgTasksUsedInSession) {
			bgTasksUsedInSession = true;
			loadoutState = { ...loadoutState, bgTasksActive: true };
			changed = true;
		}
		if (changed) {
			refreshActiveToolLoadout();
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event?.toolName === "bash" && !bgTasksUsedInSession) {
			const text = JSON.stringify(event?.result ?? "");
			if (text.includes("pi-bg-tasks") || text.includes("auto-backgrounded")) {
				bgTasksUsedInSession = true;
			}
		}
		if (syncLoadoutState(ctx)) {
			refreshActiveToolLoadout();
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		if (syncLoadoutState(ctx)) {
			refreshActiveToolLoadout();
		}
	});

	pi.on("input", (event, ctx) => {
		const text = typeof event?.text === "string" ? event.text.trim() : "";
		if (text.startsWith("/supi-review") && !reviewUsedInSession) {
			reviewUsedInSession = true;
			loadoutState = { ...loadoutState, reviewOutputActive: true };
			refreshActiveToolLoadout();
		} else if (text.startsWith("/schedule") && !schedulerUsedInSession) {
			schedulerUsedInSession = true;
			loadoutState = { ...loadoutState, schedulerManagementActive: true };
			refreshActiveToolLoadout();
		} else if (text.startsWith("/plan") || text.startsWith("/mode") || text.startsWith("/goal")) {
			if (syncLoadoutState(ctx)) {
				refreshActiveToolLoadout();
			}
		}
	});

	return {
		getState(): ToolLoadoutState {
			return loadoutState;
		},
		prepareLoadout(loadout: { declared: ReadonlyArray<{ name: string }> }) {
			const hiddenDeclarations = computeHiddenDeclarations(
				loadout.declared.map((tool) => tool.name),
				loadoutState,
			);
			return hiddenDeclarations.length > 0 ? { hiddenDeclarations } : undefined;
		},
	};
}

export default function toolLoadoutDiet(_pi: ExtensionAPI) {
	// Wired into questionnaire tool's prepareLoadout hook.
}
