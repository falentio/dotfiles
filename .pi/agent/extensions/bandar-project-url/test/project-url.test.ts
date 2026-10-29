import { describe, expect, it } from "bun:test";
import {
	PROJECT_URL_HEADER,
	projectUrlOfRemote,
	projectUrlOfRemotes,
	remotesOf,
} from "../project-url.ts";

const remotes: Array<[string, string | null]> = [
	["https://github.com/o/r.git", "https://github.com/o/r"],
	["http://host/o/r/", "http://host/o/r"],
	["git@github.com:o/r.git", "https://github.com/o/r"],
	["git@GitHub.com:o/r.git", "https://github.com/o/r"],
	["ssh://git@github.com/o/r.git", "https://github.com/o/r"],
	["git://host/o/r.git", "https://host/o/r"],
	["git+ssh://git@host/o/r.git", "https://host/o/r"],
	["git+https://github.com/o/r.git", "https://github.com/o/r"],
	["ssh://git@host:2222/o/r.git", "https://host/o/r"],
	["https://user:pass@github.com/o/r.git", "https://github.com/o/r"],
	["https://git.example.com:8443/team/repo.git", "https://git.example.com:8443/team/repo"],
	["http://git.internal:8080/team/repo", "http://git.internal:8080/team/repo"],
	["/home/x/r", null],
	["C:\\repos\\r", null],
	["file:///home/x/r", null],
	["", null],
];

describe("projectUrlOfRemote", () => {
	for (const [remote, expected] of remotes) {
		it(`maps ${JSON.stringify(remote)}`, () => {
			expect(projectUrlOfRemote(remote)).toBe(expected);
		});
	}
});

describe("remotesOf", () => {
	it("reads a url per remote and skips other remote keys", () => {
		expect(
			remotesOf(
				"remote.origin.fetch +refs/heads/*:refs/remotes/origin/*\n" +
					"remote.origin.url git@github.com:o/r.git\n" +
					"remote.up.url https://github.com/u/r.git\n",
			),
		).toEqual([
			{ name: "origin", url: "git@github.com:o/r.git" },
			{ name: "up", url: "https://github.com/u/r.git" },
		]);
	});

	it("keeps a url that contains a space", () => {
		expect(remotesOf("remote.origin.url https://host/o/r x\n")).toEqual([
			{ name: "origin", url: "https://host/o/r x" },
		]);
	});

	it("reads crlf output", () => {
		expect(remotesOf("remote.origin.url git@github.com:o/r.git\r\n")).toEqual([
			{ name: "origin", url: "git@github.com:o/r.git" },
		]);
	});

	it("ignores a push-only remote", () => {
		expect(remotesOf("remote.origin.pushurl https://host/push.git\n")).toEqual([]);
	});
});

describe("projectUrlOfRemotes", () => {
	it("prefers origin over an earlier remote", () => {
		expect(
			projectUrlOfRemotes([
				{ name: "upstream", url: "git@github.com:other/repo.git" },
				{ name: "origin", url: "https://github.com/o/r.git" },
			]),
		).toBe("https://github.com/o/r");
	});

	it("takes the first parseable remote when origin is missing", () => {
		expect(
			projectUrlOfRemotes([
				{ name: "a", url: "/home/x/r" },
				{ name: "b", url: "git@github.com:o/r.git" },
				{ name: "c", url: "https://github.com/other/repo.git" },
			]),
		).toBe("https://github.com/o/r");
	});

	it("falls past an origin that does not parse", () => {
		expect(
			projectUrlOfRemotes([
				{ name: "origin", url: "file:///home/x/r" },
				{ name: "b", url: "https://github.com/o/r" },
			]),
		).toBe("https://github.com/o/r");
	});

	it("returns null when nothing parses", () => {
		expect(
			projectUrlOfRemotes([
				{ name: "origin", url: "" },
				{ name: "b", url: "file:///home/x/r" },
			]),
		).toBeNull();
	});
});

describe("PROJECT_URL_HEADER", () => {
	it("is the header bandar reads", () => {
		expect(PROJECT_URL_HEADER).toBe("x-bandar-project-url");
	});
});
