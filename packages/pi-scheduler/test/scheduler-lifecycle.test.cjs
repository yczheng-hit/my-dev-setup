const test = require("node:test");
const assert = require("node:assert/strict");
const { isSessionContextActive } = require("../extensions/scheduler/scheduler-lifecycle.cjs");

function liveContext() {
	return { isIdle: () => true };
}

test("accepts distinct live Pi context wrappers in the same generation", () => {
	const sessionStartContext = liveContext();
	const commandOrToolContext = liveContext();
	assert.notEqual(sessionStartContext, commandOrToolContext);
	assert.equal(isSessionContextActive(sessionStartContext, commandOrToolContext, 3, 3), true);
});

test("rejects callbacks from an older session generation", () => {
	assert.equal(isSessionContextActive(liveContext(), liveContext(), 4, 3), false);
});

test("rejects stale active or candidate wrappers", () => {
	const staleContext = { isIdle: () => { throw new Error("stale extension context"); } };
	assert.equal(isSessionContextActive(staleContext, liveContext(), 3, 3), false);
	assert.equal(isSessionContextActive(liveContext(), staleContext, 3, 3), false);
});
