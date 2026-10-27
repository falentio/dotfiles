import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCOUT_CONFIG } from "../config.ts";

describe("SCOUT_CONFIG", () => {
	it("holds the extension settings", () => {
		assert.equal(SCOUT_CONFIG.stateRoot, join(homedir(), ".pi", "scout"));
		assert.equal(SCOUT_CONFIG.idleMs, 3_600_000);
		assert.equal(SCOUT_CONFIG.turnMs, 900_000);
		assert.equal(SCOUT_CONFIG.lockWaitMs, 600_000);
	});
});
