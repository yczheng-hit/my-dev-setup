import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const extensionPath = path.join(repo, "pi/extensions/esc-restore-input.ts");

async function findHost() {
	if (process.env.PI_HOST_DIR) return process.env.PI_HOST_DIR;
	const { findHost: locate } = await import("../agents-only.mjs");
	return locate();
}

const host = await findHost();

async function createSessionFixture({ onStream, tools = [] } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-esc-restore-")));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.copyFileSync(extensionPath, path.join(agentDir, "extensions/esc-restore-input.ts"));

	const require = createRequire(path.join(host, "package.json"));
	const sdk = await import(pathToFileURL(path.join(host, "dist/index.js")));
	const { AuthStorage } = await import(pathToFileURL(path.join(host, "dist/core/auth-storage.js")));
	const ai = require.resolve
		.paths("@earendil-works/pi-ai")
		.map((base) => path.join(base, "@earendil-works/pi-ai/dist/index.js"))
		.find((file) => fs.existsSync(file));
	const { createAssistantMessageEventStream } = await import(pathToFileURL(ai));

	const runtime = await sdk.ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStorePath: path.join(root, "models.json"),
		refreshOnCreate: false,
	});

	let session;
	const calls = [];
	runtime.registerProvider("fixture", {
		baseUrl: "https://fixture.invalid",
		apiKey: "FIXTURE_KEY",
		api: "api-fixture",
		models: [
			{
				id: "test-model",
				name: "test-model",
				reasoning: false,
				input: ["text"],
				contextWindow: 200000,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple(model, context, options) {
			calls.push({ model, context: structuredClone(context), options });
			const stream = createAssistantMessageEventStream();
			const baseOutput = {
				role: "assistant",
				api: model.api,
				provider: "fixture",
				model: model.id,
				timestamp: Date.now(),
				stopReason: "stop",
				content: [{ type: "text", text: "normal reply" }],
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			queueMicrotask(() => {
				if (onStream) {
					onStream({ stream, baseOutput, options, session, callIndex: calls.length - 1 });
				} else {
					stream.push({ type: "start", partial: baseOutput });
					stream.push({ type: "done", reason: "stop", message: baseOutput });
					stream.end();
				}
			});
			return stream;
		},
	});

	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: true });
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noContextFiles: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const sm = sdk.SessionManager.create(cwd, path.join(root, "sessions"));
	({ session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		settingsManager: settings,
		modelRuntime: runtime,
		model: runtime.getModel("fixture", "test-model"),
		resourceLoader: loader,
		sessionManager: sm,
		customTools: tools,
		noTools: "all",
	}));

	let draft = "";
	const notices = [];
	const errors = [];
	const noop = () => {};
	const ui = {
		notify: (text, type) => notices.push({ text, type }),
		setStatus: noop,
		setWorkingMessage: noop,
		setWidget: noop,
		setFooter: noop,
		getEditorComponent: () => undefined,
		setEditorComponent: noop,
		getEditorText: () => draft,
		setEditorText: (text) => {
			draft = text;
		},
		onTerminalInput: () => noop,
		custom: async () => undefined,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
	};

	await session.bindExtensions({
		mode: "tui",
		uiContext: ui,
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, options);
				if (!result.cancelled && result.editorText && !draft.trim()) {
					draft = result.editorText;
				}
				return { cancelled: result.cancelled };
			},
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
		onError: (err) => errors.push(err),
	});
	assert.deepEqual(errors, []);

	return {
		session,
		sm,
		calls,
		notices,
		errors,
		getDraft: () => draft,
		setDraft: (text) => {
			draft = text;
		},
		cleanup: () => {
			session.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test(
	"Esc during streaming rewinds the aborted prompt from session history and restores text to editor",
	{ skip: !host },
	async () => {
		let shouldAbort = false;
		const f = await createSessionFixture({
			onStream({ stream, baseOutput, session }) {
				stream.push({ type: "start", partial: baseOutput });
				if (shouldAbort) {
					const abortedMsg = {
						...baseOutput,
						stopReason: "aborted",
						errorMessage: "Operation aborted",
						content: [{ type: "text", text: "partial..." }],
					};
					void session.abort();
					stream.push({ type: "error", reason: "aborted", error: abortedMsg });
					stream.end();
				} else {
					stream.push({ type: "done", reason: "stop", message: baseOutput });
					stream.end();
				}
			},
		});

		try {
			// Turn 1 completes normally
			await f.session.prompt("第一条正常指令");
			assert.equal(f. getDraft(), "");
			const leafAfterTurn1 = f.sm.getLeafId();
			assert.ok(leafAfterTurn1);

			// Turn 2 is immediately aborted with Esc
			shouldAbort = true;
			await f.session.prompt("第二条发错的指令 --typo");

			// Editor has the mistaken prompt restored, and projected context omits the aborted turn without session_tree
			assert.equal(f.getDraft(), "第二条发错的指令 --typo");
			assert.ok(!JSON.stringify(f.sm.buildSessionContext().messages).includes("第二条发错的指令 --typo"));
			assert.ok(f.notices.some((n) => n.text.includes("已取消并退回输入框")));

			// Turn 2 retried after fixing typo: model context should NOT contain the aborted prompt
			shouldAbort = false;
			f.setDraft("");
			await f.session.prompt("第二条修正后的指令");
			const lastContext = JSON.stringify(f.calls.at(-1).context);
			assert.ok(lastContext.includes("第一条正常指令"));
			assert.ok(lastContext.includes("第二条修正后的指令"));
			assert.ok(!lastContext.includes("第二条发错的指令 --typo"));
		} finally {
			f.cleanup();
		}
	},
);

test(
	"Does not rewind or overwrite editor when a tool has already started executing before Esc",
	{ skip: !host },
	async () => {
		const f = await createSessionFixture({
			onStream({ stream, baseOutput, session }) {
				stream.push({ type: "start", partial: baseOutput });
				// Simulate tool execution starting before abort
				void session.extensionRunner
					.emit({
						type: "tool_execution_start",
						toolCallId: "call-1",
						toolName: "bash",
						args: { command: "echo hi" },
					})
					.then(() => {
						const abortedMsg = {
							...baseOutput,
							stopReason: "aborted",
							errorMessage: "Operation aborted",
							content: [],
						};
						void session.abort();
						stream.push({ type: "error", reason: "aborted", error: abortedMsg });
						stream.end();
					});
			},
		});

		try {
			await f.session.prompt("已经开始执行工具的指令");
			assert.equal(f.getDraft(), "");
			assert.equal(
				f.sm.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
				true,
			);
		} finally {
			f.cleanup();
		}
	},
);

test("Does not overwrite non-empty editor draft when aborted", { skip: !host }, async () => {
	const f = await createSessionFixture({
		onStream({ stream, baseOutput, session }) {
			stream.push({ type: "start", partial: baseOutput });
			f.setDraft("正在输入的新内容");
			const abortedMsg = {
				...baseOutput,
				stopReason: "aborted",
				errorMessage: "Operation aborted",
				content: [],
			};
			void session.abort();
			stream.push({ type: "error", reason: "aborted", error: abortedMsg });
			stream.end();
		},
	});

	try {
		await f.session.prompt("原指令");
		assert.equal(f.getDraft(), "正在输入的新内容");
	} finally {
		f.cleanup();
	}
});
