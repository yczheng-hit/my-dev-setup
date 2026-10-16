// Pure state + formatting for the subagent HUD segment (no Pi imports, unit-tested directly).

export type RowState = "running" | "queued" | "complete" | "failed" | "stopped" | "unknown";

export interface HudRow {
	key: string;
	agent: string;
	model?: string;
	task?: string;
	startedAt: number;
	endedAt?: number;
	tokens?: number;
	state: RowState;
}

/** `data.fleet.entries[]` from the pi-subagents status RPC (fleetStatus v1). Running children only. */
export interface FleetEntry {
	key?: string;
	agent: string;
	model?: string;
	effort?: string;
	startedAt: number;
	tokens?: { total?: number };
}

/** A node of `data.asyncSnapshot.runs[]` (asyncStatusSnapshot v1). Includes finished runs. */
export interface SnapshotNode {
	id: string;
	kind?: string;
	label?: string;
	state?: string;
	startedAt?: number;
	endedAt?: number;
	children?: SnapshotNode[];
}

/** What the parent asked for when it called the `subagent` tool (the RPC never exposes the task). */
export interface Launch {
	agent?: string;
	model?: string;
	task?: string;
	launchedAt: number;
}

export interface UpdateInput {
	runs?: SnapshotNode[];
	fleet?: FleetEntry[];
	launches: ReadonlyMap<string, Launch>;
	completions: ReadonlyMap<string, RowState>;
	now: number;
	lingerMs: number;
}

const MATCH_WINDOW_MS = 10_000;

export function isTerminal(state: RowState): boolean {
	return state === "complete" || state === "failed" || state === "stopped" || state === "unknown";
}

/** Snapshot states → HUD states. */
export function mapSnapshotState(state: string | undefined): RowState {
	switch (state) {
		case "running":
			return "running";
		case "queued":
			return "queued";
		case "complete":
			return "complete";
		case "failed":
		case "partial":
		case "rejected":
			return "failed";
		case "stopped":
		case "paused":
			return "stopped";
		default:
			return "unknown";
	}
}

/** Completion-event child statuses → HUD states. */
export function mapCompletionStatus(status: string | undefined, success?: boolean): RowState {
	if (status === "completed" || (status === undefined && success === true)) return "complete";
	if (status === "failed" || (status === undefined && success === false)) return "failed";
	if (status === "stopped" || status === "paused" || status === "detached") return "stopped";
	return "unknown";
}

function firstAgent(label: string | undefined): string {
	const first = (label ?? "").split(",")[0]?.trim();
	return first || "subagent";
}

/** Merge one status reply into the previous rows. Rows are keyed by async run id (or `fleet:<key>`). */
export function updateRows(prev: ReadonlyMap<string, HudRow>, input: UpdateInput): Map<string, HudRow> {
	const { now, lingerMs } = input;
	const next = new Map<string, HudRow>();
	const fleet = [...(input.fleet ?? [])];
	const used = new Set<number>();

	const baseModel = (model: string | undefined) => model?.split(":")[0];
	/**
	 * Claim the fleet entry for a run. Fleet keys are opaque, so this matches on agent, start time and
	 * model. Parallel launches start children in the same millisecond, so time alone is ambiguous:
	 * when the run's model is known (its launch, or what it showed before), a different-model entry
	 * is never taken — no entry is better than another run's model and tokens.
	 */
	const takeFleet = (agent: string, times: number[], expectedModel?: string): FleetEntry | undefined => {
		const want = baseModel(expectedModel);
		let best = -1;
		let bestDelta = Infinity;
		fleet.forEach((entry, index) => {
			if (used.has(index) || entry.agent !== agent) return;
			if (want && entry.model && baseModel(entry.model) !== want) return;
			const delta = Math.min(...times.map((t) => Math.abs(entry.startedAt - t)));
			if (delta < bestDelta) {
				best = index;
				bestDelta = delta;
			}
		});
		if (best < 0 || bestDelta > MATCH_WINDOW_MS) return undefined;
		used.add(best);
		return fleet[best];
	};

	for (const run of input.runs ?? []) {
		if (!run?.id) continue;
		const before = prev.get(run.id);
		const launch = input.launches.get(run.id);
		const agent = launch?.agent ?? firstAgent(run.label);
		// Fleet entries carry the child's start time; the run's own start is only a fallback.
		const childTimes = (run.children ?? []).map((c) => c.startedAt).filter((t): t is number => typeof t === "number");
		const times = childTimes.length ? childTimes : typeof run.startedAt === "number" ? [run.startedAt] : [];
		let state = mapSnapshotState(run.state);
		const completed = input.completions.get(run.id);
		if (completed && completed !== "unknown") state = completed;
		const entry = !isTerminal(state) ? takeFleet(agent, times.length ? times : [now], launch?.model ?? before?.model) : undefined;
		// A workflow run (also what `/run` launches) has its own "workflow" fleet entry beside its
		// children's; claim it so the wrapper never shows up as a segment of its own.
		const wrapper = run.kind === "workflow" && !isTerminal(state) ? takeFleet("workflow", times.length ? times : [now]) : undefined;
		const startedAt = run.startedAt ?? entry?.startedAt ?? before?.startedAt ?? launch?.launchedAt ?? now;
		const endedAt = isTerminal(state) ? (before?.endedAt ?? run.endedAt ?? now) : undefined;
		if (endedAt !== undefined && now - endedAt > lingerMs) continue;
		// A run that was already finished before we ever saw it running is history, not news.
		if (endedAt !== undefined && !before) continue;
		next.set(run.id, {
			key: run.id,
			agent,
			model: entry?.model ?? before?.model ?? launch?.model,
			task: launch?.task ?? before?.task,
			startedAt,
			...(endedAt !== undefined ? { endedAt } : {}),
			tokens: entry?.tokens?.total || wrapper?.tokens?.total || before?.tokens,
			state,
		});
	}

	// Foreground children (and anything not in the snapshot) appear only in the fleet.
	fleet.forEach((entry, index) => {
		if (used.has(index) || entry.agent === "workflow") return; // unmatched wrapper: its children speak for it
		const key = `fleet:${entry.key ?? `${entry.agent}:${entry.startedAt}`}`;
		const before = prev.get(key);
		next.set(key, {
			key,
			agent: entry.agent,
			model: entry.model ?? before?.model,
			task: before?.task,
			startedAt: entry.startedAt,
			tokens: entry.tokens?.total ?? before?.tokens,
			state: "running",
		});
	});

	// Rows that vanished: finish them (once), then keep them for the linger window.
	for (const [key, row] of prev) {
		if (next.has(key)) continue;
		if (isTerminal(row.state)) {
			if (row.endedAt !== undefined && now - row.endedAt <= lingerMs) next.set(key, row);
			continue;
		}
		const state = input.completions.get(key) ?? "unknown";
		next.set(key, { ...row, state: isTerminal(state) ? state : "unknown", endedAt: now });
	}
	return next;
}

export function shortModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	let name = model.split(":")[0] ?? model; // drop a :thinking suffix
	name = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	name = name.replace(/^claude-/, "");
	return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

export function formatTokens(tokens: number | undefined): string | undefined {
	if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined;
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function taskLabel(task: string | undefined, max = 28): string | undefined {
	const line = task
		?.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return undefined;
	const chars = [...line];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

export interface Painter {
	fg(color: "accent" | "success" | "error" | "warning" | "dim" | "muted" | "text", text: string): string;
}

const plain: Painter = { fg: (_color, text) => text };
const SPINNER = ["◐", "◓", "◑", "◒"];

/** A run of [plain, painted] pieces; the plain width decides the layout. */
type Piece = [string, string];
const join = (pieces: Piece[]): Piece => [pieces.map((p) => p[0]).join(""), pieces.map((p) => p[1]).join("")];

function icon(row: HudRow, now: number, paint: Painter): Piece {
	switch (row.state) {
		case "complete":
			return ["✓", paint.fg("success", "✓")];
		case "failed":
			return ["✗", paint.fg("error", "✗")];
		case "stopped":
			return ["■", paint.fg("warning", "■")];
		case "unknown":
			return ["•", paint.fg("muted", "•")];
		default: {
			const frame = SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? "◐";
			return [frame, paint.fg("accent", frame)];
		}
	}
}

function segment(row: HudRow, now: number, paint: Painter, withTask: boolean): Piece {
	const parts: Piece[] = [icon(row, now, paint), [` ${row.agent}`, ` ${row.agent}`]];
	const model = shortModel(row.model);
	if (model) parts.push([` [${model}]`, paint.fg("muted", ` [${model}]`)]);
	const task = withTask ? taskLabel(row.task) : undefined;
	if (task) parts.push([`: ${task}`, `: ${task}`]);
	const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt);
	parts.push([` (${elapsed})`, paint.fg("dim", ` (${elapsed})`)]);
	const tokens = formatTokens(row.tokens);
	if (tokens) parts.push([` · ${tokens}`, paint.fg("dim", ` · ${tokens}`)]);
	return join(parts);
}

const width = (text: string) => [...text].length;

/**
 * One status text for the HUD line, or undefined when there is nothing to show.
 * Degrades to fit `budget` columns: full segments → without tasks → a one-segment summary.
 * Segments are separated by " | " because the HUD collapses repeated spaces.
 */
export function renderStatus(
	rows: Iterable<HudRow>,
	opts: { now: number; budget: number; painter?: Painter },
): string | undefined {
	const paint = opts.painter ?? plain;
	const all = [...rows];
	if (all.length === 0) return undefined;
	const active = all.filter((r) => !isTerminal(r.state)).sort((a, b) => a.startedAt - b.startedAt);
	const done = all.filter((r) => isTerminal(r.state)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	const ordered = [...active, ...done];
	const sep: Piece = [" | ", paint.fg("dim", " | ")];
	const joined = (pieces: Piece[]): Piece => join(pieces.flatMap((p, i) => (i === 0 ? [p] : [sep, p])));

	for (const withTask of [true, false]) {
		const line = joined(ordered.map((row) => segment(row, opts.now, paint, withTask)));
		if (width(line[0]) <= opts.budget) return line[1];
	}

	// Summary: ◐ 3 running: delegate×2, scout · 7.4k ✓1 ✗1
	const counts = new Map<string, number>();
	for (const row of active) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
	const names = [...counts].map(([agent, n]) => (n > 1 ? `${agent}×${n}` : agent)).join(", ");
	const tokens = formatTokens(active.reduce((sum, r) => sum + (r.tokens ?? 0), 0));
	const tally = (state: RowState, mark: string, color: "success" | "error" | "warning" | "muted"): Piece[] => {
		const n = done.filter((r) => r.state === state).length;
		return n ? [[` ${mark}${n}`, paint.fg(color, ` ${mark}${n}`)]] : [];
	};
	const tail: Piece[] = [
		...(tokens ? [[` · ${tokens}`, paint.fg("dim", ` · ${tokens}`)] as Piece] : []),
		...tally("complete", "✓", "success"),
		...tally("failed", "✗", "error"),
		...tally("stopped", "■", "warning"),
		...tally("unknown", "•", "muted"),
	];
	const head: Piece = active.length
		? icon(active[0]!, opts.now, paint)
		: ["✓", paint.fg("success", "✓")];
	const label = active.length ? ` ${active.length} running` : ` ${done.length} done`;
	const full = join([head, [label, label], ...(active.length && names ? [[`: ${names}`, `: ${names}`] as Piece] : []), ...tail]);
	if (width(full[0]) <= opts.budget) return full[1];
	return join([head, [label, label], ...tail])[1];
}

/** Columns we may use on the shared HUD status line (rest is for permission mode, todos, …). */
export function statusBudget(columns: number | undefined): number {
	return Math.max(40, (columns && columns > 0 ? columns : 160) - 50);
}

/**
 * Status key. The HUD (and Pi's footer) sort statuses with localeCompare, so "zz-" puts our block
 * last on the line, after permission mode and todos, instead of wedged between them.
 */
export const STATUS_KEY = "zz-subagents";

/** Leading bar that separates our block from the statuses before it (a todo "✓" read like ours). */
export const LEAD = "│ ";

/** The text for setStatus: the rendered segments behind a dim "│ ", or undefined when idle. */
export function hudStatusText(
	rows: Iterable<HudRow>,
	opts: { now: number; budget: number; painter?: Painter },
): string | undefined {
	const paint = opts.painter ?? plain;
	const body = renderStatus(rows, { ...opts, budget: opts.budget - width(LEAD) });
	return body === undefined ? undefined : paint.fg("dim", LEAD) + body;
}
