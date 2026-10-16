// pi-subagent-hud: running pi-subagents children as claude-hud style segments on the HUD status line.
//
// Data comes only from pi-subagents' documented in-process RPC (`status` → fleet DTO v1 and
// asyncStatusSnapshot v1, `ping` → capabilities and the async-complete event name) plus the
// parent's own `subagent` tool calls (the RPC never exposes task text). Output is one
// ctx.ui.setStatus("zz-subagents", "│ …") text; pi-hud-footer (or Pi's footer) prints it last on
// the extension status line. If pi-subagents is missing or its RPC changes, nothing is shown.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type HudRow,
	type Launch,
	type RowState,
	isTerminal,
	mapCompletionStatus,
	STATUS_KEY,
	hudStatusText,
	statusBudget,
	updateRows,
} from "./format";

const READY_EVENT = "subagents:rpc:v1:ready";
const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const LINGER_MS = 10_000;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const SLOW_POLL_MS = 15_000; // pi-subagents absent/not ready, or status not served from memory
const RPC_TIMEOUT_MS = 3_000;
const MAX_LAUNCHES = 200;

type Json = Record<string, any>;
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export default function subagentHud(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight = false;
	let capable = false;
	let completeEvent: string | undefined;
	let unsubscribeComplete: (() => void) | undefined;
	let lastText: string | undefined;
	let rows = new Map<string, HudRow>();
	const pendingCalls = new Map<string, Launch>(); // toolCallId → launch
	const launches = new Map<string, Launch>(); // async run id → launch
	const completions = new Map<string, RowState>(); // async run id → verdict

	function rpc(method: string, params?: Json): Promise<Json> {
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			let off: (() => void) | undefined;
			const timeout = setTimeout(() => {
				off?.();
				reject(new Error(`subagents rpc ${method} timed out`));
			}, RPC_TIMEOUT_MS);
			timeout.unref?.();
			off = pi.events.on(`${REPLY_PREFIX}${requestId}`, (reply) => {
				clearTimeout(timeout);
				off?.();
				if (isRecord(reply) && reply.success === true && isRecord(reply.data)) resolve(reply.data);
				else reject(new Error(isRecord(reply) && isRecord(reply.error) ? String(reply.error.message) : `subagents rpc ${method} failed`));
			});
			pi.events.emit(REQUEST_EVENT, { version: 1, requestId, method, ...(params ? { params } : {}) });
		});
	}

	function onComplete(payload: unknown): void {
		if (!isRecord(payload)) return;
		const runId = typeof payload.runId === "string" ? payload.runId : typeof payload.id === "string" ? payload.id : undefined;
		if (!runId) return;
		const verdicts = Array.isArray(payload.results)
			? payload.results.filter(isRecord).map((r) => mapCompletionStatus(r.status, r.success))
			: [];
		let state: RowState;
		if (verdicts.includes("failed")) state = "failed";
		else if (verdicts.includes("stopped")) state = "stopped";
		else if (verdicts.length > 0 && verdicts.every((v) => v === "complete")) state = "complete";
		else state = mapCompletionStatus(payload.status ?? payload.state, payload.success);
		completions.set(runId, state);
		schedule(0);
	}

	/** Accept a ping/ready payload; returns whether the RPC offers what we need. */
	function applyPing(data: unknown): boolean {
		if (!isRecord(data) || !isRecord(data.capabilities)) return false;
		const caps = data.capabilities;
		capable = caps.fleetStatus?.version === 1 && caps.asyncStatusSnapshot?.version === 1 && caps.status === true;
		const event = isRecord(data.events) && typeof data.events.asyncComplete === "string" ? data.events.asyncComplete : undefined;
		if (capable && event && event !== completeEvent) {
			unsubscribeComplete?.();
			completeEvent = event;
			unsubscribeComplete = pi.events.on(event, onComplete);
		}
		return capable;
	}

	function render(): void {
		if (!ctx?.hasUI) return;
		const text = hudStatusText(rows.values(), {
			now: Date.now(),
			budget: statusBudget(process.stdout.columns),
			painter: ctx.ui.theme,
		});
		if (text === lastText) return;
		lastText = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function schedule(ms: number): void {
		if (!ctx?.hasUI) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void tick(), ms);
		timer.unref?.();
	}

	function prune(): void {
		for (const id of completions.keys()) if (!rows.has(id)) completions.delete(id);
		if (launches.size > MAX_LAUNCHES) {
			for (const id of [...launches.keys()].slice(0, launches.size - MAX_LAUNCHES)) if (!rows.has(id)) launches.delete(id);
		}
	}

	async function tick(): Promise<void> {
		if (!ctx?.hasUI) return;
		if (inflight) return schedule(ACTIVE_POLL_MS);
		inflight = true;
		const gen = generation;
		let next = SLOW_POLL_MS;
		try {
			if (!capable) applyPing(await rpc("ping"));
			if (gen !== generation) return;
			if (capable) {
				const data = await rpc("status");
				if (gen !== generation) return;
				const inMemory = typeof data.text === "string" && data.text.startsWith("In-memory");
				if (isRecord(data.asyncSnapshot) && isRecord(data.fleet)) {
					rows = updateRows(rows, {
						runs: Array.isArray(data.asyncSnapshot.runs) ? data.asyncSnapshot.runs : [],
						fleet: Array.isArray(data.fleet.entries) ? data.fleet.entries : [],
						launches,
						completions,
						now: Date.now(),
						lingerMs: LINGER_MS,
					});
					prune();
				}
				const busy = rows.size > 0;
				next = inMemory ? (busy ? ACTIVE_POLL_MS : IDLE_POLL_MS) : busy ? IDLE_POLL_MS : SLOW_POLL_MS;
			}
		} catch {
			// pi-subagents not loaded/ready or a transient RPC error: keep what we have, retry slowly.
			const now = Date.now();
			for (const [key, row] of rows) if (isTerminal(row.state) && row.endedAt !== undefined && now - row.endedAt > LINGER_MS) rows.delete(key);
			next = rows.size > 0 ? IDLE_POLL_MS : SLOW_POLL_MS;
		} finally {
			if (gen === generation) inflight = false;
		}
		if (gen !== generation) return;
		render();
		schedule(next);
	}

	function reset(): void {
		generation += 1;
		if (timer) clearTimeout(timer);
		timer = undefined;
		inflight = false;
		rows = new Map();
		pendingCalls.clear();
		launches.clear();
		completions.clear();
		if (ctx?.hasUI && lastText !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
		lastText = undefined;
	}

	pi.events.on(READY_EVENT, (data) => {
		if (applyPing(data)) schedule(0);
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "subagent" || event.parentToolCallId || !isRecord(event.args)) return;
		const args = event.args;
		if (args.action !== undefined || typeof args.agent !== "string") return;
		pendingCalls.set(event.toolCallId, {
			agent: args.agent,
			...(typeof args.model === "string" ? { model: args.model } : {}),
			...(typeof args.task === "string" ? { task: args.task } : {}),
			launchedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent") return;
		const launch = pendingCalls.get(event.toolCallId);
		pendingCalls.delete(event.toolCallId);
		const asyncId = isRecord(event.result) && isRecord(event.result.details) ? event.result.details.asyncId : undefined;
		if (launch && !event.isError && typeof asyncId === "string") launches.set(asyncId, launch);
		schedule(0);
	});

	pi.on("session_start", (_event, context) => {
		reset();
		ctx = context;
		if (!context.hasUI) return;
		schedule(500);
	});

	pi.on("session_shutdown", () => {
		reset();
		ctx = undefined;
	});
}
