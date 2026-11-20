import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diffSettingsSnapshot, readSettingsSnapshot } from "../../pi/extensions/hot-sync-settings.ts";

test("readSettingsSnapshot and diffSettingsSnapshot detect model, thinking, and enabledModels updates", () => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hot-sync-test-")));
	try {
		const file = path.join(tmp, "settings.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				defaultProvider: "local",
				defaultModel: "opus",
				defaultThinkingLevel: "medium",
				enabledModels: ["local/opus", "local/sonnet"],
			}),
		);
		const snap1 = readSettingsSnapshot(file);
		assert.deepEqual(snap1, {
			defaultProvider: "local",
			defaultModel: "opus",
			defaultThinkingLevel: "medium",
			modelThinkingLevels: undefined,
			enabledModels: ["local/opus", "local/sonnet"],
		});

		fs.writeFileSync(
			file,
			JSON.stringify({
				defaultProvider: "local",
				defaultModel: "sonnet",
				defaultThinkingLevel: "high",
				enabledModels: ["local/opus", "local/sonnet", "local/haiku"],
			}),
		);
		const snap2 = readSettingsSnapshot(file);
		const diff = diffSettingsSnapshot(snap1, snap2);
		assert.deepEqual(diff, {
			modelChanged: true,
			thinkingChanged: true,
			enabledModelsChanged: true,
		});

		const noDiff = diffSettingsSnapshot(snap2, snap2);
		assert.deepEqual(noDiff, {
			modelChanged: false,
			thinkingChanged: false,
			enabledModelsChanged: false,
		});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
