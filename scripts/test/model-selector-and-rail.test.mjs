import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
	enrichModelSelectorInstance,
	formatModelDetails,
} from "../../pi/extensions/model-selector-info.ts";
import { collectTurnAnchors, TurnJumpRail } from "../../pi/extensions/turn-jump-rail.ts";

async function findHost() {
	if (process.env.PI_HOST_DIR) return process.env.PI_HOST_DIR;
	const { findHost: locate } = await import("../agents-only.mjs");
	return locate();
}

const host = await findHost();

test("model-selector-info formats model context window, pricing, image support, and enriches ModelSelectorComponent", { skip: !host }, async () => {
	const details = formatModelDetails({
		id: "sonnet",
		name: "Claude Sonnet (gateway)",
		contextWindow: 500_000,
		maxTokens: 64_000,
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
	});
	assert.equal(details, "上下文: 500k (输出 64k) · 价格: $2/$10/M (缓存 $0.1) · 🖼 支持图像 · 🧠 思考");

	const textOnlyDetails = formatModelDetails({
		id: "gpt-text",
		name: "GPT Text",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 10, output: 50 },
		input: ["text"],
		reasoning: false,
	});
	assert.equal(textOnlyDetails, "上下文: 1.05M (输出 128k) · 价格: $10/$50/M · 📝 纯文本");

	const fakeChild = {
		text: "  Model Name: Claude Sonnet (gateway)",
		setText(next) {
			this.text = next;
		},
	};
	const fakeSelector = {
		selectedIndex: 0,
		filteredModels: [
			{
				model: {
					id: "sonnet",
					name: "Claude Sonnet (gateway)",
					contextWindow: 500_000,
					maxTokens: 64_000,
					cost: { input: 2, output: 10, cacheRead: 0.1 },
					input: ["text", "image"],
					reasoning: true,
				},
			},
		],
		listContainer: {
			children: [fakeChild],
		},
	};
	enrichModelSelectorInstance(fakeSelector);
	assert.match(fakeChild.text, /Model Name: Claude Sonnet \(gateway\).*上下文: 500k \(输出 64k\) · 价格: \$2\/\$10\/M \(缓存 \$0\.1\) · 🖼 支持图像 · 🧠 思考/);
});

test("turn-jump-rail collects turn anchors, highlights visible turns, and jumps to reply on left-click", { skip: !host }, async () => {
	const require = createRequire(path.join(host, "package.json"));
	const { Container } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));

	class FakeUser extends Container {
		static name = "UserMessageComponent";
		constructor(linesCount) {
			super();
			this.linesCount = linesCount;
		}
		render() {
			return Array.from({ length: this.linesCount }, (_, i) => `user-${i}`);
		}
	}
	Object.defineProperty(FakeUser, "name", { value: "UserMessageComponent" });

	class FakeAssistant extends Container {
		constructor(linesCount) {
			super();
			this.linesCount = linesCount;
			this.lastMessage = { role: "assistant" };
			this.contentContainer = {};
		}
		render() {
			return Array.from({ length: this.linesCount }, (_, i) => `assistant-${i}`);
		}
	}
	Object.defineProperty(FakeAssistant, "name", { value: "AssistantMessageComponent" });

	const chat = new Container();
	chat.addChild(new FakeUser(2)); // rows 0..1
	chat.addChild(new FakeAssistant(10)); // rows 2..11 (turn 0: start 0, replyStart 2, end 12)
	chat.addChild(new FakeUser(3)); // rows 12..14
	chat.addChild(new FakeAssistant(15)); // rows 15..29 (turn 1: start 12, replyStart 15, end 30)
	chat.addChild(new FakeUser(2)); // rows 30..31
	chat.addChild(new FakeAssistant(8)); // rows 32..39 (turn 2: start 30, replyStart 32, end 40)

	const turns = collectTurnAnchors([chat], 80);
	assert.equal(turns.length, 3);
	assert.deepEqual(turns[0], { index: 0, start: 0, replyStart: 2, end: 12 });
	assert.deepEqual(turns[1], { index: 1, start: 12, replyStart: 15, end: 30 });
	assert.deepEqual(turns[2], { index: 2, start: 30, replyStart: 32, end: 40 });

	let scrollTop = 30;
	const jumped = [];
	const rail = new TurnJumpRail(
		() => ({ turns, scrollTop, viewportHeight: 10, maxRows: 12 }),
		(turn) => {
			jumped.push(turn.index);
			scrollTop = turn.replyStart ?? turn.start;
		},
	);
	rail.setTheme({
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => `<b>${text}</b>`,
	});

	const rendered = rail.render(2);
	// 3 turns with spacers -> 5 lines (row 0 = turn 0, row 2 = turn 1, row 4 = turn 2)
	assert.equal(rendered.length, 5);
	assert.equal(rendered[0], "<dim>▬▬</dim>");
	assert.equal(rendered[2], "<dim>▬▬</dim>");
	assert.equal(rendered[4], "<b><accent>▬▬</accent></b>");

	// Click row 0 (turn 0) -> jumps to turn 0!
	const clickRes = rail.handleMouse({
		type: "press",
		button: "left",
		x: 0,
		y: 0,
		screenX: 77,
		screenY: 2,
		width: 2,
		height: 5,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.deepEqual(clickRes, { handled: true, render: true });
	assert.deepEqual(jumped, [0]);
	assert.equal(scrollTop, 2);
});
