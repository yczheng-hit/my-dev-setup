"use strict";

function isSessionContextActive(activeCtx, candidateCtx, currentGeneration, expectedGeneration) {
	if (!activeCtx || currentGeneration !== expectedGeneration) return false;
	try {
		// Pi creates distinct context wrappers for events, commands, and tool calls.
		// Probe both wrappers for staleness instead of comparing object identity.
		activeCtx.isIdle();
		candidateCtx.isIdle();
		return true;
	} catch {
		return false;
	}
}

module.exports = { isSessionContextActive };
