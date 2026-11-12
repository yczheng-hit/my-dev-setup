/**
 * Right-side clickable turn/reply navigation rail (minimap ticks `▬▬`) for Pi's fullscreen TUI.
 *
 * - Renders a vertical column of `▬▬` ticks on the right edge of the transcript viewport,
 *   one per conversation turn.
 * - Highlights ticks whose turn/reply is currently visible in the viewport.
 * - Left-clicking any tick scrolls the transcript directly to that turn's reply
 *   (clicking the same tick again toggles to that turn's user prompt).
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	OverlayOptions,
	TUI,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type AnyObject = Record<string | symbol, any>;

const WIDGET_ID = "turn-jump-rail";
const TICK_GLYPH = "▬▬";
const RAIL_WIDTH = 2;
const RAIL_TOP_ROW = 2;

interface ScrollViewLike {
	scrollTop: number;
	viewportHeight?: number;
	contentHeight?: number;
	child?: unknown;
	getContentWidth?(width: number): number;
	scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
}

interface OverlayEntryLike {
	component?: unknown;
	hidden?: boolean;
	options?: OverlayOptions;
}

type AltScreen = TUI & {
	mode?: string;
	layoutRoot?: { entries?: readonly { component?: unknown }[] | null } | null;
	getPrimaryScrollView?: () => ScrollViewLike | undefined;
	overlayStack?: readonly unknown[];
	isOverlayVisible?: (entry: unknown) => boolean;
	hasOverlay?: () => boolean;
};

export interface TurnAnchor {
	index: number;
	start: number;
	replyStart?: number;
	end: number;
}

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

export function resolveRenderer(reference: AnyObject): AltScreen {
	const probe = Symbol("pi-turn-jump-rail-receiver");
	reference[probe] = function (this: AnyObject) {
		return this;
	};
	let target: AnyObject | undefined;
	try {
		target = reference[probe]();
		return (target ?? reference) as AltScreen;
	} finally {
		if (target) delete target[probe];
		else reference[probe] = undefined;
	}
}

function measureLines(component: unknown, width: number): number {
	try {
		const render = (component as { render?: (w: number) => string[] }).render;
		return typeof render === "function" ? (render.call(component, width)?.length ?? 0) : 0;
	} catch {
		return 0;
	}
}

function isUserPromptComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const name = (value as { constructor?: { name?: string } }).constructor?.name;
	return name === "UserMessageComponent" || name === "SkillInvocationMessageComponent";
}

function isAssistantReplyComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const name = (value as { constructor?: { name?: string } }).constructor?.name;
	if (name === "AssistantMessageComponent") return true;
	const candidate = value as { lastMessage?: { role?: string }; contentContainer?: unknown };
	return candidate.lastMessage?.role === "assistant" && Boolean(candidate.contentContainer);
}

function plainContainerChildren(value: unknown): readonly unknown[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (isUserPromptComponent(value) || isAssistantReplyComponent(value)) return undefined;
	const name = (value as { constructor?: { name?: string } }).constructor?.name;
	const children = (value as { children?: unknown }).children;
	if (!Array.isArray(children)) return undefined;
	if (name && name !== "Container" && name !== "TranscriptContainer") return undefined;
	return children;
}

export function collectTurnAnchors(children: readonly unknown[], width: number): TurnAnchor[] {
	const turns: TurnAnchor[] = [];
	let currentTurn: TurnAnchor | undefined;

	function walk(nodes: readonly unknown[], offset: number): number {
		for (const child of nodes) {
			if (isUserPromptComponent(child)) {
				const height = measureLines(child, width);
				if (height > 0) {
					if (currentTurn) currentTurn.end = Math.max(currentTurn.end, offset);
					currentTurn = {
						index: turns.length,
						start: offset,
						end: offset + height,
					};
					turns.push(currentTurn);
				}
				offset += height;
			} else if (isAssistantReplyComponent(child)) {
				const height = measureLines(child, width);
				if (height > 0) {
					if (!currentTurn) {
						currentTurn = {
							index: turns.length,
							start: offset,
							replyStart: offset,
							end: offset + height,
						};
						turns.push(currentTurn);
					} else {
						if (currentTurn.replyStart === undefined) {
							currentTurn.replyStart = offset;
						}
						currentTurn.end = offset + height;
					}
				}
				offset += height;
			} else {
				const nested = plainContainerChildren(child);
				if (nested !== undefined) {
					offset = walk(nested, offset);
				} else {
					const height = measureLines(child, width);
					if (currentTurn && height > 0) {
						currentTurn.end = offset + height;
					}
					offset += height;
				}
			}
		}
		return offset;
	}

	walk(children, 0);
	return turns;
}

export class TurnJumpRail implements Component {
	private theme: Theme | undefined;
	private rowToTurn: Array<TurnAnchor | undefined> = [];
	private readonly getState: () => {
		turns: TurnAnchor[];
		scrollTop: number;
		viewportHeight: number;
		maxRows: number;
	} | undefined;
	private readonly onSelectTurn: (turn: TurnAnchor) => void;

	constructor(
		getState: () => {
			turns: TurnAnchor[];
			scrollTop: number;
			viewportHeight: number;
			maxRows: number;
		} | undefined,
		onSelectTurn: (turn: TurnAnchor) => void,
	) {
		this.getState = getState;
		this.onSelectTurn = onSelectTurn;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	reset(): void {
		this.theme = undefined;
		this.rowToTurn = [];
	}

	render(_width: number): string[] {
		const theme = this.theme;
		const state = this.getState();
		if (!theme || !state || state.turns.length === 0 || state.maxRows <= 0) {
			this.rowToTurn = [];
			return [];
		}

		const { turns, scrollTop, viewportHeight, maxRows } = state;
		const viewBottom = scrollTop + Math.max(1, viewportHeight);

		// Sample turns if there are more turns than available rows
		const displayed: TurnAnchor[] =
			turns.length <= maxRows
				? turns
				: Array.from({ length: maxRows }, (_, i) => {
						const idx = Math.round((i * (turns.length - 1)) / Math.max(1, maxRows - 1));
						return turns[idx]!;
					});

		// Use 1-row spacing between ticks when space permits (matches the visual style in the screenshot)
		const useSpacers = displayed.length > 1 && displayed.length * 2 - 1 <= maxRows;
		const lines: string[] = [];
		const rowMap: Array<TurnAnchor | undefined> = [];

		let anyVisible = false;
		const visibility = displayed.map((turn) => {
			const visible = turn.end > scrollTop && turn.start < viewBottom;
			if (visible) anyVisible = true;
			return visible;
		});

		if (!anyVisible && displayed.length > 0) {
			// Highlight the turn closest to scrollTop
			let closestIdx = 0;
			for (let i = 0; i < displayed.length; i++) {
				if (displayed[i]!.start <= scrollTop) closestIdx = i;
			}
			visibility[closestIdx] = true;
		}

		for (let i = 0; i < displayed.length; i++) {
			const turn = displayed[i]!;
			const isVisible = visibility[i];
			const tick = isVisible
				? theme.bold(theme.fg("accent", TICK_GLYPH))
				: theme.fg("dim", TICK_GLYPH);
			lines.push(tick);
			rowMap.push(turn);

			if (useSpacers && i < displayed.length - 1) {
				lines.push(" ".repeat(RAIL_WIDTH));
				rowMap.push(turn);
			}
		}

		this.rowToTurn = rowMap;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.rowToTurn.length === 0) return undefined;
		if (event.y < 0 || event.y >= this.rowToTurn.length) return undefined;
		if (event.type === "press" && event.button === "left") {
			const turn = this.rowToTurn[event.y];
			if (turn) {
				this.onSelectTurn(turn);
				return { handled: true, render: true };
			}
		}
		return undefined;
	}

	invalidate(): void {}
}

export default function turnJumpRail(pi: ExtensionAPI): void {
	let altScreen: AltScreen | undefined;
	let overlay: OverlayHandle | null = null;
	let restoreHasOverlay: (() => void) | undefined;

	let cache: {
		width: number;
		contentHeight: number | undefined;
		children: readonly unknown[] | undefined;
		turns: TurnAnchor[];
	} | null = null;

	function primaryScrollView(): ScrollViewLike | undefined {
		const screen = altScreen;
		if (!screen) return undefined;
		try {
			const direct = screen.getPrimaryScrollView?.();
			if (direct) return direct;
		} catch {}
		const entries = screen.layoutRoot?.entries;
		const found = entries?.find((entry) => {
			const component = entry?.component as { primary?: unknown } | undefined;
			return Boolean(component && component.primary === true);
		});
		return found?.component as ScrollViewLike | undefined;
	}

	function terminalCols(): number {
		return Math.max(1, altScreen?.terminal?.columns ?? 80);
	}

	function terminalRows(): number {
		return Math.max(1, altScreen?.terminal?.rows ?? 24);
	}

	function getTurns(sv: ScrollViewLike, width: number): TurnAnchor[] {
		const contentHeight = sv.contentHeight;
		const docChildren = (sv.child as { children?: unknown[] } | undefined)?.children;
		const children = Array.isArray(docChildren) ? docChildren : undefined;
		if (
			cache &&
			cache.width === width &&
			cache.contentHeight === contentHeight &&
			cache.children === children
		) {
			return cache.turns;
		}
		const turns = children ? collectTurnAnchors(children, width) : [];
		cache = { width, contentHeight, children, turns };
		return turns;
	}

	const rail = new TurnJumpRail(
		() => {
			const screen = altScreen;
			if (!screen || screen.mode !== "fullscreen") return undefined;
			const sv = primaryScrollView();
			if (!sv) return undefined;
			const cols = terminalCols();
			const width =
				typeof sv.getContentWidth === "function" ? sv.getContentWidth(cols) : cols;
			const turns = getTurns(sv, Math.max(1, width));
			const rows = terminalRows();
			const viewportHeight = sv.viewportHeight ?? Math.max(1, rows - 6);
			const maxRows = Math.max(4, Math.min(24, rows - 8));
			return {
				turns,
				scrollTop: sv.scrollTop,
				viewportHeight,
				maxRows,
			};
		},
		(turn) => {
			const sv = primaryScrollView();
			if (!sv) return;
			const replyRow = turn.replyStart ?? turn.start;
			// If already near replyStart, toggle to the user prompt start of this turn
			const targetRow =
				Math.abs(sv.scrollTop - replyRow) <= 1 && turn.replyStart !== undefined
					? turn.start
					: replyRow;
			sv.scrollTo(Math.max(0, targetRow), { disableFollow: true });
			altScreen?.requestRender();
		},
	);

	function installNonCapturingOverlayBypass(screen: AltScreen): void {
		if (typeof screen.hasOverlay !== "function") return;
		restoreHasOverlay?.();
		const previous = screen.hasOverlay.bind(screen);
		const isVisible = (entry: OverlayEntryLike): boolean => {
			try {
				return typeof screen.isOverlayVisible === "function"
					? screen.isOverlayVisible(entry)
					: !entry.hidden;
			} catch {
				return true;
			}
		};
		const wrapped = (): boolean => {
			const stack = screen.overlayStack;
			if (!Array.isArray(stack)) return previous();
			for (const raw of stack) {
				const entry = raw as OverlayEntryLike;
				if (!isVisible(entry)) continue;
				if (entry.options?.nonCapturing === true || entry.component === rail) continue;
				return true;
			}
			return false;
		};
		screen.hasOverlay = wrapped;
		restoreHasOverlay = () => {
			if (screen.hasOverlay === wrapped) {
				screen.hasOverlay = previous;
			}
			restoreHasOverlay = undefined;
		};
	}

	function syncOverlay(): void {
		const screen = altScreen;
		if (!screen) return;
		const want = screen.mode === "fullscreen";
		if (want && !overlay) {
			overlay = screen.showOverlay(rail, {
				anchor: "top-right",
				row: RAIL_TOP_ROW,
				margin: { right: 1 },
				width: RAIL_WIDTH,
				nonCapturing: true,
			});
		} else if (!want && overlay) {
			overlay.hide();
			overlay = null;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		cache = null;
		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			const screen = resolveRenderer(tui as unknown as AnyObject);
			altScreen = screen;
			rail.setTheme(theme);
			installNonCapturingOverlayBypass(screen);
			syncOverlay();
			return EMPTY_COMPONENT;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		restoreHasOverlay?.();
		overlay?.hide();
		overlay = null;
		altScreen = undefined;
		rail.reset();
		cache = null;
	});
}
