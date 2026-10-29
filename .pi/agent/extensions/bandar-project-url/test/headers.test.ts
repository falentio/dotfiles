import { describe, expect, it } from "bun:test";
import { PROJECT_URL_HEADER, SESSION_ID_HEADER } from "../headers.ts";

describe("PROJECT_URL_HEADER", () => {
	it("is the header bandar reads", () => {
		expect(PROJECT_URL_HEADER).toBe("x-bandar-project-url");
	});
});

describe("SESSION_ID_HEADER", () => {
	it("is the header bandar reads", () => {
		expect(SESSION_ID_HEADER).toBe("x-bandar-session-id");
	});
});
