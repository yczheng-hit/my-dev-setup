import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { wrapTypoTolerantAutocomplete } from "../../pi/extensions/fuzzy-slash-autocomplete.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));

async function findHost() {
	if (process.env.PI_HOST_DIR) return process.env.PI_HOST_DIR;
	const { findHost: locate } = await import("../agents-only.mjs");
	return locate();
}

const host = await findHost();

test("Typo-tolerant slash autocomplete matches transposed and misspelled commands (/cancle, /relaod, /compcat, /scheudle)", { skip: !host }, async () => {
	const require = createRequire(path.join(host, "package.json"));
	const { CombinedAutocompleteProvider } = await import(
		pathToFileURL(require.resolve("@earendil-works/pi-tui"))
	);

	const commands = [
		{ name: "settings", description: "Open settings" },
		{ name: "model", description: "Select model" },
		{ name: "compact", description: "Compact context" },
		{ name: "reload", description: "Reload runtime" },
		{ name: "resume", description: "Resume session" },
		{ name: "handoff", description: "Transfer context" },
		{ name: "schedule", description: "Schedule task" },
		{ name: "schedules", description: "List schedules" },
		{ name: "schedule-cancel", description: "Cancel scheduled task" },
		{ name: "schedule-cleanup", description: "Cleanup scheduled tasks" },
		{ name: "skill:code-review", description: "Review code" },
	];

	const baseProvider = new CombinedAutocompleteProvider(commands, repo, null);
	const wrapped = wrapTypoTolerantAutocomplete(baseProvider);

	// Stock provider returns null for "/cancle", wrapped provider returns "schedule-cancel"
	assert.equal(await baseProvider.getSuggestions(["/cancle"], 0, 7, {}), null);
	const cancleRes = await wrapped.getSuggestions(["/cancle"], 0, 7, {});
	assert.ok(cancleRes);
	assert.equal(cancleRes.items[0].value, "schedule-cancel");

	// "/relaod" -> "reload"
	assert.equal(await baseProvider.getSuggestions(["/relaod"], 0, 7, {}), null);
	const reloadRes = await wrapped.getSuggestions(["/relaod"], 0, 7, {});
	assert.ok(reloadRes);
	assert.equal(reloadRes.items[0].value, "reload");

	// "/compcat" -> "compact"
	assert.equal(await baseProvider.getSuggestions(["/compcat"], 0, 8, {}), null);
	const compactRes = await wrapped.getSuggestions(["/compcat"], 0, 8, {});
	assert.ok(compactRes);
	assert.equal(compactRes.items[0].value, "compact");

	// "/scheudle" -> "schedule", "schedules", "schedule-cancel", ...
	const scheduleRes = await wrapped.getSuggestions(["/scheudle"], 0, 9, {});
	assert.ok(scheduleRes);
	assert.equal(scheduleRes.items[0].value, "schedule");
	assert.ok(scheduleRes.items.some((item) => item.value === "schedule-cancel"));

	// Applying completion replaces "/cancle" with "/schedule-cancel "
	const applied = wrapped.applyCompletion(["/cancle"], 0, 7, cancleRes.items[0], cancleRes.prefix);
	assert.deepEqual(applied.lines, ["/schedule-cancel "]);
});
