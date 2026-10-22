import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// Keep the scheduler logic testable from plain node --test.
const core = require("./scheduler-core.cjs");
const lifecycle = require("./scheduler-lifecycle.cjs");
const coordination = require("./scheduler-coordination.cjs");
const { createTaskStore } = require("./task-store.cjs");

const ACTIONS = ["notify", "prompt", "shell", "message"] as const;
const TYPES = ["once", "interval", "cron"] as const;
const SCOPES = ["session", "cwd", "global"] as const;
const WAKE_ON = ["always", "failure", "success", "never", "change"] as const;
const STOP_ON = ["success", "failure", "never"] as const;
const MANAGE_ACTIONS = ["enable", "disable", "remove", "update", "cleanup"] as const;

const STATE_FILE = process.env.PI_SCHEDULER_STATE_FILE || join(homedir(), ".pi", "agent", "state", "scheduler", "tasks.json");
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout's practical max (~24.8 days)
const STATE_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000;
// local patch: smaller outputs; a wake shows the head and tail of long logs.
const MAX_STORED_OUTPUT_CHARS = 4_000;
const MAX_PROMPT_STDOUT_CHARS = 4_000;
const MAX_PROMPT_STDERR_CHARS = 2_000;
// local patch: display-only log entries (shown in the chat, never sent to the model).
const LOG_ENTRY_TYPE = "scheduled-task-log";
const ACTION_LABELS: Record<string, string> = { notify: "提醒", prompt: "唤醒", shell: "命令", message: "消息" };

type ScheduledTask = Record<string, any>;
type TimerHandle =
	| { kind: "timeout"; handle: NodeJS.Timeout }
	| { kind: "cron"; handle: Cron };

function truncateMiddle(text: string | undefined, maxChars: number): string {
	const value = text ?? "";
	if (value.length <= maxChars) return value;
	const head = Math.floor(maxChars * 0.35);
	const tail = maxChars - head;
	return `${value.slice(0, head)}\n[…省略 ${value.length - maxChars} 字符…]\n${value.slice(-tail)}`;
}

function currentSessionFile(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? undefined;
}

function taskBelongsToSession(task: ScheduledTask, ctx: ExtensionContext): boolean {
	return core.taskMatchesScope(task, { cwd: ctx.cwd, sessionFile: currentSessionFile(ctx) });
}

function isRunOwnerActive(owner: Record<string, any> | undefined): boolean {
	const pid = Number(owner?.pid);
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

function sendAgentPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}
}

// local patch: compact Chinese wake/log text instead of the upstream field dump.
function taskTitle(task: ScheduledTask): string {
	const name = task.name || task.title;
	return name ? `${task.id}「${name}」` : task.id;
}

function scheduledPromptHeader(task: ScheduledTask, event = "到点"): string {
	return `⏰ 定时任务 ${taskTitle(task)} ${event} · ${core.formatClock(new Date())}`;
}

function taskCreatedText(task: ScheduledTask): string {
	return `已安排 ${taskTitle(task)}：${core.describeTask(task)}`;
}

function formatDuration(ms: unknown): string {
	const value = Number(ms);
	if (!Number.isFinite(value) || value < 0) return "";
	return value < 10_000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value / 1000)}s`;
}

function shellOutcome(result: Record<string, any>): string {
	const parts = [result.killed ? "超时被终止" : `退出码 ${result.code}`];
	const duration = formatDuration(result.durationMs);
	if (duration) parts.push(`用时 ${duration}`);
	return parts.join(" · ");
}

function fenced(label: string, text: string): string[] {
	const body = text.replace(/\s+$/, "");
	return body ? [`${label}：`, "```", body, "```"] : [];
}

function shellResultPrompt(task: ScheduledTask, result: Record<string, any>, instruction: string, sessionCwd?: string): string {
	const stdout = truncateMiddle(result.stdout ?? "", MAX_PROMPT_STDOUT_CHARS);
	const stderr = truncateMiddle(result.stderr ?? "", MAX_PROMPT_STDERR_CHARS);
	const output = [...fenced("输出", stdout), ...fenced("错误输出", stderr)];
	return [
		scheduledPromptHeader(task, "运行完成"),
		`$ ${task.command}`,
		...(result.cwd && result.cwd !== sessionCwd ? [`目录：${result.cwd}`] : []),
		shellOutcome(result),
		...(output.length ? output : ["（无输出）"]),
		`下一步：${instruction}`,
	].join("\n");
}

function taskLabel(task: ScheduledTask): string {
	return task.name || task.title || task.id;
}

// local patch: display-only chat line; old sessions without a renderer simply skip it.
type LogEntryData = { text: string; level?: "info" | "notice" | "warning" | "error"; detail?: string };

export default function schedulerExtension(pi: ExtensionAPI) {
	let tasks: ScheduledTask[] = [];
	let handles = new Map<string, TimerHandle>();
	let expiryHandles = new Map<string, NodeJS.Timeout>();
	let activeCtx: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let stateRevision = -1;
	let widgetEnabled = true;
	let rescheduleAfterRefresh = false;
	const firing = new Set<string>();
	const abandonedAttempts = new Set<string>();
	const store = createTaskStore({ stateFile: STATE_FILE, sanitize: core.sanitizeTasks });

	function isOwnerActive(owner: Record<string, any> | undefined): boolean {
		return !(owner?.pid === process.pid && abandonedAttempts.has(owner?.attemptId)) && isRunOwnerActive(owner);
	}

	function isSessionActive(ctx: ExtensionContext, generation = sessionGeneration): boolean {
		return lifecycle.isSessionContextActive(activeCtx, ctx, sessionGeneration, generation);
	}

	async function loadTasks(): Promise<boolean> {
		const snapshot = await store.read();
		return coordination.reconcileSnapshot(
			snapshot,
			stateRevision,
			(nextTasks: ScheduledTask[], revision: number) => {
				tasks = nextTasks;
				stateRevision = revision;
			},
			() => rescheduleAll(),
		);
	}

	async function transactTasks<T>(mutator: (current: ScheduledTask[]) => T | Promise<T>): Promise<T> {
		const transaction = await store.transact(mutator);
		if (transaction.revision >= stateRevision) {
			tasks = transaction.tasks;
			stateRevision = transaction.revision;
		}
		return transaction.result;
	}

	function runInBackground(run: () => unknown, ctx: ExtensionContext, generation: number, label: string): void {
		void coordination.runInBackground(run, (error: any) => {
			rescheduleAfterRefresh = true;
			const message = `${label}: ${error?.message ?? String(error)}`;
			if (isSessionActive(ctx, generation) && ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		});
	}

	function clearHandle(id: string): void {
		const handle = handles.get(id);
		if (handle?.kind === "cron") handle.handle.stop();
		else if (handle) clearTimeout(handle.handle);
		handles.delete(id);
		const expiry = expiryHandles.get(id);
		if (expiry) clearTimeout(expiry);
		expiryHandles.delete(id);
	}

	function clearTimers(): void {
		for (const id of new Set([...handles.keys(), ...expiryHandles.keys()])) clearHandle(id);
	}

	function scheduleExpiry(task: ScheduledTask, ctx: ExtensionContext, generation = sessionGeneration): void {
		if (!task.expiresAt || task.status !== "pending" || !taskBelongsToSession(task, ctx)) return;
		const deadline = Date.parse(task.expiresAt);
		if (!Number.isFinite(deadline)) return;
		const timer = setTimeout(() => {
			runInBackground(async () => {
				expiryHandles.delete(task.id);
				if (!isSessionActive(ctx, generation)) return;
				await transactTasks((current) => {
					if (!isSessionActive(ctx, generation)) return;
					core.expireOverdueTasks(current.filter((item) => taskBelongsToSession(item, ctx)), new Date());
				});
				if (isSessionActive(ctx, generation)) rescheduleAll(generation);
			}, ctx, generation, "Scheduler expiry failed");
		}, Math.max(0, Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS)));
		expiryHandles.set(task.id, timer);
	}

	function visibleTasks(ctx = activeCtx): ScheduledTask[] {
		if (!ctx) return tasks;
		return tasks.filter((task) => taskBelongsToSession(task, ctx));
	}

	function updateWidget(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		if (!widgetEnabled) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		const upcoming = core.pendingTasks(visibleTasks(ctx)).slice(0, 3);
		if (upcoming.length === 0) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		// local patch: one compact Chinese line per task, local wall-clock time.
		const lines: string[] = [];
		for (const task of upcoming) {
			const when = task.nextRun ? `${core.formatRelativeZh(task.nextRun)}（${core.formatClock(task.nextRun)}）` : "无下次运行";
			const runs = task.runCount ? ` · 已运行 ${task.runCount} 次` : "";
			const last = task.lastStatus === "error" ? " · 上次失败" : "";
			lines.push(`⏰ ${taskLabel(task)} · ${ACTION_LABELS[task.action] ?? task.action} · ${when}${runs}${last}`);
		}
		ctx.ui.setWidget("scheduler", lines, { placement: "belowEditor" });
	}

	function updateStatus(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		const count = core.pendingTasks(visibleTasks(ctx)).length;
		ctx.ui.setStatus("scheduler", count ? `⏰ ${count} 个定时任务` : undefined); // local patch
		updateWidget(ctx);
	}

	function scheduleTaskHandle(task: ScheduledTask, ctx: ExtensionContext, generation = sessionGeneration): void {
		if (!isSessionActive(ctx, generation)) return;
		if (task.enabled === false || task.status !== "pending") return;
		if (!taskBelongsToSession(task, ctx)) return;
		clearHandle(task.id);

		if (task.type === "cron") {
			try {
				const cron = new Cron(task.schedule, () => {
					runInBackground(() => fireTask(task.id, ctx, generation), ctx, generation, `Scheduled task ${task.id} failed`);
				});
				handles.set(task.id, { kind: "cron", handle: cron });
			} catch (error: any) {
				const message = error?.message ?? String(error);
				runInBackground(() => transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === task.id);
					if (!persisted) return;
					persisted.enabled = false;
					persisted.status = "failed";
					persisted.lastStatus = "error";
					persisted.lastError = message;
				}), ctx, generation, `Failed to persist cron initialization error for ${task.id}`);
			}
			return;
		}

		const dueAt = Date.parse(task.nextRun ?? task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const delay = Math.max(0, dueAt - Date.now());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			runInBackground(async () => {
				handles.delete(task.id);
				if (!isSessionActive(ctx, generation)) return;
				if (Date.now() < dueAt) {
					scheduleTaskHandle(task, ctx, generation);
					return;
				}
				await fireTask(task.id, ctx, generation);
			}, ctx, generation, `Scheduled task ${task.id} failed`);
		}, timerDelay);
		handles.set(task.id, { kind: "timeout", handle: timer });
	}

	function rescheduleAll(generation = sessionGeneration): void {
		const ctx = activeCtx;
		if (!ctx || !isSessionActive(ctx, generation)) return;
		rescheduleAfterRefresh = false;
		clearTimers();
		for (const task of core.pendingTasks(tasks)) scheduleTaskHandle(task, ctx, generation);
		for (const task of tasks) scheduleExpiry(task, ctx, generation);
		updateStatus(ctx);
	}

	async function refreshFromStore(generation = sessionGeneration): Promise<void> {
		const ctx = activeCtx;
		if (!ctx || !isSessionActive(ctx, generation)) return;
		await coordination.refreshSchedulerState({
			store,
			currentRevision: () => stateRevision,
			isOwnerActive,
			recoverInterrupted: (current: ScheduledTask[], now: Date, options: any) => {
				core.expireOverdueTasks(current, now);
				return core.recoverInterruptedTasks(current, now, options);
			},
			now: () => new Date(),
			install: (nextTasks: ScheduledTask[], revision: number) => {
				tasks = nextTasks;
				stateRevision = revision;
			},
			reconcile: () => rescheduleAll(generation),
		});
		// Retry detached work only after a successful refresh, even when the
		// revision is unchanged. Never spin on a past-due task and a broken store.
		if (rescheduleAfterRefresh && isSessionActive(ctx, generation)) rescheduleAll(generation);
		for (const attemptId of abandonedAttempts) {
			if (!tasks.some((task) => task.status === "running" && task.runOwner?.attemptId === attemptId)) abandonedAttempts.delete(attemptId);
		}
	}

	const refreshLoop = coordination.createRefreshLoop({
		intervalMs: STATE_REFRESH_INTERVAL_MS,
		run: refreshFromStore,
		onError: (error: any) => {
			if (activeCtx?.hasUI) activeCtx.ui.notify(`Scheduler state refresh failed: ${error?.message ?? String(error)}`, "error");
		},
		setInterval,
		clearInterval,
	});

	function startStateRefresh(generation: number): void {
		refreshLoop.start(generation);
	}

	async function catchUpOverdueCronTasks(
		ctx: ExtensionContext,
		generation: number,
		options: { windowHours: number; maxFire: number },
	): Promise<void> {
		const overdue = core.selectCatchUpCronTasks(visibleTasks(ctx), new Date(), options);
		if (overdue.length === 0 || !isSessionActive(ctx, generation)) return;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Catching up ${overdue.length} missed cron task(s) (window ${options.windowHours}h, limit ${options.maxFire})`,
				"info",
			);
		}

		for (const { task, missedAt } of overdue) {
			if (!isSessionActive(ctx, generation)) return;
			await fireTask(task.id, ctx, generation, {
				expectedNextRun: task.nextRun ?? task.dueAt,
				occurrence: missedAt.toISOString(),
			});
		}
	}

	// Kept for the `message` action only: that content is meant for the model.
	function recordMessage(content: string, details?: Record<string, any>, triggerTurn = false): void {
		pi.sendMessage(
			{
				customType: "scheduled-task",
				content,
				display: true,
				details,
			},
			{ triggerTurn },
		);
	}

	// local patch: user-facing scheduler output is a session entry that never enters model context.
	function logEntry(text: string, level: LogEntryData["level"] = "info", detail?: string): void {
		pi.appendEntry<LogEntryData>(LOG_ENTRY_TYPE, detail ? { text, level, detail } : { text, level });
	}

	async function executeTask(
		task: ScheduledTask,
		ctx: ExtensionContext,
		isActive: () => boolean,
	): Promise<Record<string, any>> {
		if (task.action === "notify") {
			const message = task.message ?? "Scheduled reminder";
			// local patch: the persisted log entry below replaces the transient ctx.ui.notify line.
			logEntry(`🔔 ${taskTitle(task)}：${message}`, "notice"); // local patch
			return { ok: true, delivered: "notify", wakeReason: "notify", wakeDisposition: "not-requested" };
		}

		if (task.action === "prompt") {
			const prompt = `${scheduledPromptHeader(task)}\n${task.prompt}`; // local patch
			sendAgentPrompt(pi, ctx, prompt);
			return { ok: true, delivered: "prompt", wakeReason: "prompt", wakeDisposition: "delivered" };
		}

		if (task.action === "message") {
			const message = task.message ?? "Scheduled message";
			recordMessage(`⏰ ${message}`, { task }, task.triggerTurn !== false);
			return { ok: true, delivered: "message", triggerTurn: task.triggerTurn !== false, wakeReason: "message", wakeDisposition: task.triggerTurn !== false ? "delivered" : "not-requested" };
		}

		if (task.action === "shell") {
			const cwd = task.cwd || ctx.cwd;
			const timeout = task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			// local patch: no "Running scheduled command" toast; time the run for the wake/log line.
			const startedAt = Date.now();
			const result = await pi.exec("bash", ["-lc", task.command], { cwd, timeout });
			const durationMs = Date.now() - startedAt;
			const wakeOnChangeFingerprint = core.shellResultFingerprint({
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.code,
				killed: result.killed,
			});
			const shellResult: Record<string, any> = {
				ok: result.code === 0 && result.killed !== true,
				command: task.command,
				cwd,
				timeoutMs: timeout,
				code: result.code,
				killed: result.killed,
				durationMs, // local patch
				wakeOnChangeFingerprint,
				stdout: truncateMiddle(result.stdout ?? "", MAX_STORED_OUTPUT_CHARS),
				stderr: truncateMiddle(result.stderr ?? "", MAX_STORED_OUTPUT_CHARS),
			};

			if (!isActive()) return { ...shellResult, outputSuppressed: true, wakeReason: task.wakeOn ?? "never", wakeDisposition: "session-suppressed" };

			// local patch: the "finished" line is logged by fireTask only when the agent is not woken.
			shellResult.wakeReason = task.wakeOn ?? "never";
			shellResult.wakeDisposition = "suppressed";

			return shellResult;
		}

		throw new Error(`Unsupported scheduled action: ${task.action}`);
	}

	async function fireTask(
		taskId: string,
		ctx: ExtensionContext,
		generation = sessionGeneration,
		claimOptions?: { expectedNextRun?: string; occurrence?: string },
	): Promise<void> {
		if (!isSessionActive(ctx, generation) || firing.has(taskId)) return;

		firing.add(taskId);
		const attemptId = randomUUID();
		let task: ScheduledTask | undefined;
		let fallbackCwd: string | undefined;
		let rescheduleImmediately = true;
		try {
			// Completion can outlive this context. Capture values before any await.
			fallbackCwd = ctx.cwd;
			// Claim under the shared state lock. Other Pi processes may have armed the
			// same cwd/global task, but only one can transition it to running.
			task = await transactTasks((current) => {
				const candidate = current.find((item) => item.id === taskId);
				if (!candidate || candidate.enabled === false || candidate.status !== "pending") return undefined;
				if (!taskBelongsToSession(candidate, ctx)) return undefined;
				const persistedNextRun = candidate.nextRun ?? candidate.dueAt;
				if (claimOptions?.expectedNextRun && persistedNextRun !== claimOptions.expectedNextRun) return undefined;
				const dueAt = Date.parse(claimOptions?.occurrence ?? persistedNextRun ?? "");
				if (!Number.isFinite(dueAt) || dueAt > Date.now()) return undefined;
				const claimedAt = new Date();
				if (!core.canClaimTask(candidate, claimedAt)) {
					core.expireOverdueTasks([candidate], claimedAt);
					return undefined;
				}
				if (claimOptions?.occurrence) {
					candidate.nextRun = claimOptions.occurrence;
					candidate.dueAt = claimOptions.occurrence;
				}
				core.markScheduledTaskRunning(current, candidate.id, claimedAt, {
					runOwner: { pid: process.pid, attemptId, sessionFile: currentSessionFile(ctx) },
				});
				return { ...candidate, runOwner: { ...candidate.runOwner } };
			});
			if (!task) return;

			if (!isSessionActive(ctx, generation)) {
				await transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === taskId);
					if (persisted?.runOwner?.attemptId !== attemptId) return;
					persisted.status = "pending";
					persisted.lastStatus = "error";
					persisted.lastError = "Scheduled task start was cancelled because the Pi session changed";
					delete persisted.runOwner;
					delete persisted.startedAt;
				});
				return;
			}

			updateStatus(ctx);
			const result = await executeTask(task, ctx, () => isSessionActive(ctx, generation));
			result.attemptId = attemptId;
			let wakeRequested = false;
			let wakeTask: ScheduledTask | undefined;
			await transactTasks((current) => {
				const persisted = current.find((candidate) => candidate.id === taskId);
				if (persisted?.runOwner?.attemptId !== attemptId) return;
				// The current configuration wins over the snapshot that launched the
				// command, including A -> B -> A edits while it was running.
				result.superseded = persisted.executionRevision !== task?.executionRevision
					|| persisted.action !== task?.action || persisted.command !== task?.command
					|| (persisted.cwd ?? fallbackCwd) !== (task?.cwd ?? fallbackCwd);
				if (task?.action === "shell" && !result.superseded
					&& persisted.enabled !== false && persisted.status === "running") {
					result.wakeReason = persisted.wakeOn ?? "never";
					if (persisted.wakeOn !== "change") {
						wakeRequested = core.shouldWakeForShellResult(persisted, result);
					} else if (task.wakeOn === "change" && result.wakeOnChangeFingerprint
						&& persisted.wakeOnChangeRevision === task.wakeOnChangeRevision) {
						wakeRequested = core.shouldWakeForShellResult(persisted, result);
						persisted.lastResultFingerprint = result.wakeOnChangeFingerprint;
						persisted.wakeOnChangeKey = `${task.command ?? ""}\0${task.cwd ?? fallbackCwd}`;
					}
					if (wakeRequested) {
						result.wakeDisposition = "pending";
						wakeTask = { ...persisted };
					}
				}
				core.markScheduledTaskCompleted(current, persisted.id, new Date(), result, { ok: result.ok !== false });
			});
			if (wakeRequested && wakeTask) {
				result.wakeDisposition = "session-suppressed";
				if (isSessionActive(ctx, generation)) {
					const instruction = core.selectShellFollowUpPrompt(wakeTask, result);
					result.wakeDisposition = "no-followup";
					if (instruction) {
						try {
							sendAgentPrompt(pi, ctx, shellResultPrompt(wakeTask, result, instruction, fallbackCwd));
							result.wakeDisposition = "delivered";
						} catch (error: any) {
							result.wakeDisposition = "failed";
							result.wakeError = String(error?.message ?? error).slice(0, 1000);
						}
					}
				}
				await transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === taskId);
					const historyEntry = persisted?.history?.find((entry: any) => entry.attemptId === attemptId);
					if (historyEntry) {
						historyEntry.wakeDisposition = result.wakeDisposition;
						if (result.wakeError) historyEntry.wakeError = result.wakeError;
					}
					if (persisted?.result?.attemptId === attemptId) {
						persisted.result.wakeDisposition = result.wakeDisposition;
						if (result.wakeError) persisted.result.wakeError = result.wakeError;
					}
				});
			}
			// local patch: when the agent was not woken, leave one display-only line in the chat.
			if (task.action === "shell" && !result.outputSuppressed && result.wakeDisposition !== "delivered"
				&& isSessionActive(ctx, generation)) {
				const output = [result.stdout, result.stderr].map((text) => text?.trimEnd()).filter(Boolean).join("\n");
				logEntry(
					`🖥️ ${taskTitle(task)} 运行完成 · ${shellOutcome(result)}`,
					result.ok === false ? "warning" : "info",
					[`$ ${task.command}`, truncateMiddle(output.trimEnd(), 1_500)].filter(Boolean).join("\n"),
				);
			}
		} catch (error: any) {
			// If even failure persistence fails, the background boundary will
			// request a retry on the next refresh rather than rearm at delay zero.
			rescheduleImmediately = false;
			let failedTask: ScheduledTask | undefined;
			await transactTasks((current) => {
				const persisted = current.find((candidate) => candidate.id === taskId);
				if (persisted?.runOwner?.attemptId !== attemptId) return;
				const superseded = persisted.executionRevision !== task?.executionRevision
					|| persisted.action !== task?.action || persisted.command !== task?.command
					|| (persisted.cwd ?? fallbackCwd) !== (task?.cwd ?? fallbackCwd);
				core.markScheduledTaskFailed(current, persisted.id, new Date(), error, { superseded });
				failedTask = { ...persisted };
			});
			rescheduleImmediately = true;
			if (failedTask && isSessionActive(ctx, generation)) {
				const message = `定时任务 ${failedTask ? taskTitle(failedTask) : taskId} 运行失败：${error?.message ?? String(error)}`; // local patch
				logEntry(`⚠️ ${message}`, "error");
			}
		} finally {
			firing.delete(taskId);
			// The PID is alive but this attempt is no longer executing. Let normal
			// interrupted-run recovery clear it once storage becomes available.
			if (!rescheduleImmediately) abandonedAttempts.add(attemptId);
			if (activeCtx && rescheduleImmediately) rescheduleAll(sessionGeneration);
		}
	}

	async function createAndSchedule(input: Record<string, any>, ctx: ExtensionContext): Promise<ScheduledTask> {
		const scope = input.scope ?? "session";
		const sessionFile = scope === "session" ? currentSessionFile(ctx) : undefined;
		if (scope === "session" && !sessionFile) {
			throw new Error("Session-scoped tasks require a persisted Pi session; use scope 'cwd' or 'global' instead");
		}
		const task = await transactTasks((current) => {
			const created = core.createScheduledTask(
				{
					...input,
					schedule: input.schedule ?? input.when ?? input.whenText,
					cwd: input.cwd ?? ctx.cwd,
					scope,
					sessionFile,
				},
				new Date(),
			);
			current.push(created);
			return created;
		});
		rescheduleAll();
		return task;
	}

	function parseCommandTask(args: string, ctx: ExtensionContext): Record<string, any> {
		const parsed = core.splitScheduleCommand(args, new Date());
		const base: Record<string, any> = {
			action: parsed.action,
			type: parsed.type,
			schedule: parsed.schedule,
			cwd: ctx.cwd,
		};
		if (parsed.action === "prompt") return { ...base, prompt: parsed.payload };
		if (parsed.action === "shell") return { ...base, command: parsed.payload };
		return { ...base, message: parsed.payload };
	}

	function cleanupVisibleTasks(current: ScheduledTask[], ctx: ExtensionContext): ScheduledTask[] {
		const removable = current
			.filter((task) => taskBelongsToSession(task, ctx))
			.filter((task) => task.enabled === false || ["fired", "cancelled", "failed"].includes(task.status));
		const removableIds = new Set(removable.map((task) => task.id));
		current.splice(0, current.length, ...current.filter((task) => !removableIds.has(task.id)));
		for (const task of removable) clearHandle(task.id);
		return removable;
	}

	async function mutateVisibleTask(
		ctx: ExtensionContext,
		id: string,
		mutator: (visible: ScheduledTask[]) => ScheduledTask,
	): Promise<ScheduledTask> {
		const task = await transactTasks((current) => {
			const visible = current.filter((candidate) => taskBelongsToSession(candidate, ctx));
			return mutator(visible);
		});
		rescheduleAll();
		return task;
	}

	pi.registerMessageRenderer("scheduled-task", (message, options, theme) => {
		let text = `${theme.fg("accent", theme.bold("scheduled"))} ${message.content}`;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, 0, 0);
	});

	// local patch: renderer for display-only log entries (collapsed: one line; expanded: detail).
	pi.registerEntryRenderer<LogEntryData>(LOG_ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		if (!data?.text) return undefined;
		const color = data.level === "error" ? "error" : data.level === "warning" ? "warning" : data.level === "notice" ? "accent" : "muted";
		let text = theme.fg(color, data.text);
		if (data.detail) text += options.expanded ? `\n${theme.fg("dim", data.detail)}` : theme.fg("dim", "  (展开查看输出)");
		return new Text(text, 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		const generation = ++sessionGeneration;
		const interrupted = await transactTasks((current) => {
			core.expireOverdueTasks(current, new Date());
			return core.recoverInterruptedTasks(current, new Date(), { isOwnerActive });
		});
		if (!isSessionActive(ctx, generation)) return;

		if (interrupted.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Recovered ${interrupted.length} task(s) interrupted before completion; recurring tasks were rescheduled`,
				"warning",
			);
		}

		rescheduleAll(generation);
		startStateRefresh(generation);
		const catchUpOptions = core.parseCatchUpOptions(process.env);
		runInBackground(() => catchUpOverdueCronTasks(ctx, generation, catchUpOptions), ctx, generation, "Failed to catch up missed cron tasks");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		++sessionGeneration;
		clearTimers();
		refreshLoop.stop();
		if (ctx.hasUI) {
			ctx.ui.setStatus("scheduler", undefined);
			ctx.ui.setWidget("scheduler", undefined);
		}
		activeCtx = undefined;
	});

	pi.registerCommand("schedule", {
		description: "Schedule a notify, prompt, shell command, or message action",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /schedule [notify|prompt|shell|message] [once|every|interval|cron] <schedule> :: <payload>", "warning");
				return;
			}
			try {
				const task = await createAndSchedule(parseCommandTask(args, ctx), ctx);
				logEntry(`⏰ ${taskCreatedText(task)}`); // local patch
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("remind", {
		description: "Alias for /schedule notify",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /remind <when> <message>", "warning");
				return;
			}
			try {
				const parsed = core.splitScheduleCommand(`notify ${args}`, new Date());
				const task = await createAndSchedule(
					{ action: "notify", type: parsed.type, schedule: parsed.schedule, message: parsed.payload, cwd: ctx.cwd },
					ctx,
				);
				logEntry(`⏰ ${taskCreatedText(task)}`); // local patch
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedules", {
		description: "List scheduled tasks; pass 'all' to include inactive tasks or 'history' for run history",
		handler: async (args, ctx) => {
			await loadTasks();
			const view = args.trim().toLowerCase();
			const includeAll = view === "all" || view === "history";
			const includeHistory = view === "history";
			const visible = visibleTasks(ctx);
			logEntry(core.formatTaskList(visible, new Date(), { includeAll, includeHistory })); // local patch
			updateStatus(ctx);
		},
	});

	pi.registerCommand("schedule-cancel", {
		description: "Cancel a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /schedule-cancel <id>", "warning");
				return;
			}
			try {
				const task = await mutateVisibleTask(ctx, id, (visible) => core.cancelScheduledTask(visible, id, new Date()));
				logEntry(`已取消定时任务 ${taskTitle(task)}`); // local patch
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-enable", {
		description: "Enable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, args.trim(), (visible) => core.enableScheduledTask(visible, args.trim(), new Date()));
				ctx.ui.notify(`Enabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-disable", {
		description: "Disable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, args.trim(), (visible) => core.disableScheduledTask(visible, args.trim(), new Date()));
				ctx.ui.notify(`Disabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-remove", {
		description: "Remove a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			try {
				const removed = await transactTasks((current) => {
					const visible = current.filter((task) => taskBelongsToSession(task, ctx));
					const visibleRemoved = core.removeScheduledTask(visible, id);
					return core.removeScheduledTask(current, visibleRemoved.id);
				});
				clearHandle(removed.id);
				rescheduleAll();
				ctx.ui.notify(`Removed scheduled task ${removed.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-cleanup", {
		description: "Remove disabled/completed/cancelled/failed scheduled tasks visible to this session",
		handler: async (_args, ctx) => {
			const removed = await transactTasks((current) => cleanupVisibleTasks(current, ctx));
			rescheduleAll();
			ctx.ui.notify(`Cleaned up ${removed.length} scheduled task(s)`, "info");
		},
	});

	pi.registerCommand("schedule-widget", {
		description: "Turn the compact scheduled-actions widget on or off for this session",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "off" || value === "false" || value === "0") widgetEnabled = false;
			else if (value === "on" || value === "true" || value === "1" || value === "") widgetEnabled = true;
			else {
				ctx.ui.notify("Usage: /schedule-widget [on|off]", "warning");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`Schedule widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		// local patch: slim model-facing metadata. Aliases and rarely used fields (when, payload, title,
		// description, enabled, triggerTurn, successPrompt, failurePrompt) are no longer advertised but are
		// still accepted: TypeBox objects allow extra properties and the core reads them as before.
		description: "Do something later or repeatedly while Pi is open: notify the user, wake yourself with a prompt, or run a shell command and get woken with its output.",
		promptSnippet: "Schedule reminders, self-wakeups, or shell polling (CI, deploys) for later",
		promptGuidelines: [
			"For polling with schedule_task, use action='shell' type='interval' with followUpPrompt (and wakeOn/stopOn), and bound it with maxRuns or expiresIn.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "notify: show message; prompt: wake you with prompt; shell: run command" }),
			type: Type.Optional(StringEnum(TYPES, { description: "default once" })),
			schedule: Type.Optional(Type.String({ description: "once: '10m', '14:30', 'tomorrow 9am', ISO time; interval: '5m'; cron: '0 9 * * 1-5'" })),
			name: Type.Optional(Type.String()),
			message: Type.Optional(Type.String({ description: "notify text" })),
			prompt: Type.Optional(Type.String()),
			command: Type.Optional(Type.String()),
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "default 300000" })),
			followUpPrompt: Type.Optional(Type.String({ description: "shell: what to do with the output when woken" })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON, { description: "shell: default always with followUpPrompt, else never; change = output changed" })),
			stopOn: Type.Optional(StringEnum(STOP_ON, { description: "shell: stop recurring after this result" })),
			maxRuns: Type.Optional(Type.Number({ minimum: 1 })),
			expiresIn: Type.Optional(Type.String({ description: "e.g. '2h'" })),
			backoff: Type.Optional(Type.Object({ factor: Type.Number(), maxInterval: Type.String() }, { description: "interval only, e.g. {factor:2,maxInterval:'30m'}" })),
			scope: Type.Optional(StringEnum(SCOPES, { description: "default session" })),
		}),
		prepareArguments(args): any { // local patch: typed as any (upstream TS2322)
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, any>;
			if (input.schedule === undefined && input.when === undefined && typeof input.whenText === "string") {
				return { ...input, when: input.whenText };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await createAndSchedule(params, ctx);
			return {
				content: [{ type: "text", text: taskCreatedText(task) }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("schedule_task"))} ${theme.fg("muted", args.action ?? "prompt")}/${theme.fg("muted", args.type ?? "once")} ${theme.fg("accent", args.schedule ?? (args as any).when ?? "")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.[0];
			return new Text(theme.fg("success", "✓ ") + (text?.type === "text" ? text.text : "Scheduled"), 0, 0);
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		description: "List scheduled tasks (pending by default).",
		parameters: Type.Object({
			includeAll: Type.Optional(Type.Boolean({ description: "also finished/disabled" })),
			includeHistory: Type.Optional(Type.Boolean()),
			id: Type.Optional(Type.String({ description: "one task (id or prefix), with history" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			let visible = visibleTasks(ctx);
			if (params.id) {
				const matches = visible.filter((task) => task.id === params.id || task.id.startsWith(params.id));
				if (matches.length !== 1) throw new Error(`Scheduled task not found or prefix is ambiguous: ${params.id}`);
				visible = matches;
			}
			const text = core.formatTaskList(visible, new Date(), { includeAll: Boolean(params.includeAll || params.id || params.includeHistory), includeHistory: Boolean(params.includeHistory) });
			updateStatus(ctx);
			return { content: [{ type: "text", text }], details: { tasks: visible } };
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description: "Cancel a scheduled task.",
		parameters: Type.Object({
			id: Type.String({ description: "id or unique prefix" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await mutateVisibleTask(ctx, params.id, (visible) => core.cancelScheduledTask(visible, params.id, new Date()));
			return {
				content: [{ type: "text", text: `已取消 ${taskTitle(task)}` }], // local patch
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});

	pi.registerTool({
		name: "manage_scheduled_task",
		label: "Manage Scheduled Task",
		// local patch: update still accepts every schedule_task field (extra properties pass validation and
		// the core validates them); only fields needing null or schema checks are listed.
		description: "Enable, disable, remove, or update a scheduled task; cleanup removes finished ones. update accepts any schedule_task field (command, followUpPrompt, maxRuns, ...); null clears backoff/expiresIn.",
		parameters: Type.Object({
			action: StringEnum(MANAGE_ACTIONS),
			id: Type.Optional(Type.String({ description: "id or unique prefix; not needed for cleanup" })),
			schedule: Type.Optional(Type.String()),
			wakeOn: Type.Optional(StringEnum(WAKE_ON)),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1000 })),
			backoff: Type.Optional(Type.Union([Type.Object({ factor: Type.Number(), maxInterval: Type.String() }), Type.Null()])),
			expiresIn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "cleanup") {
				const removed = await transactTasks((current) => cleanupVisibleTasks(current, ctx));
				rescheduleAll();
				return { content: [{ type: "text", text: `已清理 ${removed.length} 个定时任务` }], details: { removed } }; // local patch
			}

			if (!params.id) throw new Error("id is required for this management action");
			const task = await transactTasks((current) => {
				const visible = current.filter((candidate) => taskBelongsToSession(candidate, ctx));
				if (params.action === "enable") {
					return core.enableScheduledTask(visible, params.id, new Date());
				}
				if (params.action === "disable") {
					return core.disableScheduledTask(visible, params.id, new Date());
				}
				if (params.action === "remove") {
					const visibleRemoved = core.removeScheduledTask(visible, params.id);
					return core.removeScheduledTask(current, visibleRemoved.id);
				}

				const updates: Record<string, any> = { ...params };
				delete updates.action;
				delete updates.id;
				if (updates.scope === "session") {
					updates.sessionFile = currentSessionFile(ctx);
					if (!updates.sessionFile) throw new Error("Session-scoped tasks require a persisted Pi session");
				} else if (updates.scope !== undefined) {
					updates.sessionFile = null;
				}
				return core.updateScheduledTask(visible, params.id, updates, new Date());
			});
			if (params.action === "remove") clearHandle(task.id);
			rescheduleAll();
			return {
				// local patch: short Chinese result with the task's new state.
				content: [{ type: "text", text: params.action === "remove" ? `已删除 ${taskTitle(task)}` : `已${{ enable: "启用", disable: "停用", update: "更新" }[params.action as string] ?? params.action} ${taskTitle(task)}：${core.describeTask(task)}` }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});
}
