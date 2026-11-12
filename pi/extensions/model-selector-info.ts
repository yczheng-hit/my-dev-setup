/**
 * Enrich Pi's /model selector (ModelSelectorComponent) with model metadata:
 * context window length, max output tokens, input/output/cache pricing,
 * image (vision) support, and reasoning support.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type AnyObject = Record<string | symbol, any>;

const WIDGET_ID = "model-selector-info";
const PATCHED = Symbol.for("pi-model-selector-info.patched");

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

export function formatTokenCount(tokens: unknown): string {
	const value = Number(tokens);
	if (!Number.isFinite(value) || value <= 0) return "";
	if (value >= 1_000_000) {
		const m = value / 1_000_000;
		return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 1_000)}k`;
	}
	return String(value);
}

export function formatPrice(price: unknown): string {
	const value = Number(price);
	if (!Number.isFinite(value) || value < 0) return "";
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function formatModelDetails(model: AnyObject | undefined): string {
	if (!model || typeof model !== "object") return "";
	const parts: string[] = [];

	const ctx = formatTokenCount(model.contextWindow);
	const out = formatTokenCount(model.maxTokens);
	if (ctx && out) {
		parts.push(`上下文: ${ctx} (输出 ${out})`);
	} else if (ctx) {
		parts.push(`上下文: ${ctx}`);
	}

	const cost = model.cost as AnyObject | undefined;
	if (cost && typeof cost === "object") {
		const inp = formatPrice(cost.input);
		const outp = formatPrice(cost.output);
		if (inp !== "" && outp !== "") {
			const cacheRead = formatPrice(cost.cacheRead);
			const cacheNote = cacheRead !== "" && Number(cost.cacheRead) > 0 ? ` (缓存 $${cacheRead})` : "";
			parts.push(`价格: $${inp}/$${outp}/M${cacheNote}`);
		}
	}

	const supportsImage = Array.isArray(model.input) && model.input.includes("image");
	parts.push(supportsImage ? "🖼 支持图像" : "📝 纯文本");

	if (model.reasoning) {
		parts.push("🧠 思考");
	}

	return parts.join(" · ");
}

export function formatCompactModelBadges(model: AnyObject | undefined): string {
	if (!model || typeof model !== "object") return "";
	const parts: string[] = [];

	const ctx = formatTokenCount(model.contextWindow);
	if (ctx) parts.push(ctx);

	const cost = model.cost as AnyObject | undefined;
	if (cost && typeof cost === "object") {
		const inp = formatPrice(cost.input);
		const outp = formatPrice(cost.output);
		if (inp !== "" && outp !== "") {
			parts.push(`$${inp}/$${outp}`);
		}
	}

	if (Array.isArray(model.input) && model.input.includes("image")) {
		parts.push("🖼");
	}

	return parts.join(" · ");
}

function resolveRenderer(reference: AnyObject): AnyObject {
	const probe = Symbol("pi-model-selector-receiver");
	reference[probe] = function (this: AnyObject) {
		return this;
	};
	let target: AnyObject | undefined;
	try {
		target = reference[probe]();
		return target ?? reference;
	} finally {
		if (target) delete target[probe];
		else reference[probe] = undefined;
	}
}

export function enrichModelSelectorInstance(instance: AnyObject, activeTheme?: Theme): void {
	const listContainer = instance?.listContainer;
	const children: AnyObject[] | undefined = listContainer?.children;
	const filteredModels: AnyObject[] | undefined = instance?.filteredModels;
	if (!Array.isArray(children) || !Array.isArray(filteredModels) || filteredModels.length === 0) return;

	const selectedIndex = Number(instance.selectedIndex ?? 0);
	const selected = filteredModels[selectedIndex]?.model;
	if (!selected) return;

	const fg = (color: string, text: string) => {
		try {
			return activeTheme ? (activeTheme as AnyObject).fg(color, text) : text;
		} catch {
			return text;
		}
	};

	// 1. Enrich the "Model Name: ..." line at the bottom of the selector
	const details = formatModelDetails(selected);
	if (details) {
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			const text = typeof child?.text === "string" ? child.text : undefined;
			if (text && text.includes("Model Name:") && !text.includes("上下文:") && !text.includes("支持图像") && !text.includes("纯文本")) {
				const suffix = fg("dim", `  │ ${details}`);
				if (typeof child.setText === "function") {
					child.setText(`${text}${suffix}`);
				} else {
					child.text = `${text}${suffix}`;
				}
				break;
			}
		}
	}
}

export default function modelSelectorInfo(pi: ExtensionAPI): void {
	let currentTheme: Theme | undefined;
	const restoreFns: Array<() => void> = [];

	function patchPrototype(proto: AnyObject | undefined): void {
		if (!proto || typeof proto.updateList !== "function" || proto[PATCHED]) return;
		const original = proto.updateList;
		const wrapped = function (this: AnyObject, ...args: unknown[]) {
			const res = original.apply(this, args);
			try {
				enrichModelSelectorInstance(this, currentTheme);
			} catch {
				// Defensive: keep stock selector intact if internals change
			}
			return res;
		};
		proto[PATCHED] = true;
		proto.updateList = wrapped;
		restoreFns.push(() => {
			if (proto.updateList === wrapped) proto.updateList = original;
			delete proto[PATCHED];
		});
	}
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		currentTheme = ctx.ui.theme;
		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			currentTheme = theme;
			const screen = resolveRenderer(tui as unknown as AnyObject);
			if (screen && typeof screen.setFocus === "function" && !screen[PATCHED]) {
				const originalSetFocus = screen.setFocus.bind(screen);
				const wrappedSetFocus = (component: AnyObject) => {
					if (
						component &&
						typeof component === "object" &&
						typeof component.updateList === "function" &&
						Array.isArray(component.filteredModels) &&
						component.listContainer
					) {
						const proto = Object.getPrototypeOf(component);
						const wasPatched = Boolean(proto?.[PATCHED]);
						patchPrototype(proto);
						if (!wasPatched) {
							try {
								enrichModelSelectorInstance(component, currentTheme);
							} catch {}
						}
					}
					return originalSetFocus(component);
				};
				screen[PATCHED] = true;
				screen.setFocus = wrappedSetFocus;
				restoreFns.push(() => {
					if (screen.setFocus === wrappedSetFocus) {
						delete screen.setFocus;
					}
					delete screen[PATCHED];
				});
			}
			return EMPTY_COMPONENT;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		while (restoreFns.length > 0) {
			try {
				restoreFns.pop()?.();
			} catch {}
		}
		currentTheme = undefined;
	});
}
