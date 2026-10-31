import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	codePointLength,
	measureText,
	pruneContent,
	type ContentBlock,
	type ImageBlock,
	type PruneBudget,
	type TextBlock,
} from "../prune.ts";

const MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const SHORT_MARKER = "[]";

const text = (value: string): TextBlock => ({ type: "text", text: value });
const image = (data = "AAAA"): ImageBlock => ({ type: "image", data, mimeType: "image/png" });
const slice = (over: Partial<PruneBudget> = {}): PruneBudget => ({
	thresholdChars: 100,
	headChars: 40,
	tailChars: 20,
	marker: MARKER,
	...over,
});
const textOf = (blocks: readonly ContentBlock[]): string =>
	blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const cycle = (length: number): string =>
	Array.from({ length }, (_, index) => "abcdefghij"[index % 10]).join("");

describe("measureText", () => {
	test("counts code points, not UTF-16 units", () => {
		assert.equal(codePointLength("a\u{1F600}b"), 3);
		assert.equal(measureText([text("a\u{1F600}b")]), 3);
	});

	test("ignores non-text blocks", () => {
		assert.equal(measureText([text("abc"), image(), text("de")]), 5);
	});

	test("measures empty content as zero", () => {
		assert.equal(measureText([]), 0);
	});
});

describe("pruneContent", () => {
	test("leaves content that fits within the threshold", () => {
		assert.equal(pruneContent([text(cycle(99))], slice({ thresholdChars: 100 })), undefined);
		assert.equal(pruneContent([text(cycle(100))], slice({ thresholdChars: 100 })), undefined);
		assert.equal(pruneContent([], slice()), undefined);
	});

	test("never prunes content with no text blocks", () => {
		assert.equal(pruneContent([image(), image()], slice({ thresholdChars: 0 })), undefined);
	});

	test("keeps the head, one marker, and the tail of one block", () => {
		const result = pruneContent(
			[text("abcdefghijkl")],
			slice({ thresholdChars: 10, headChars: 4, tailChars: 2, marker: SHORT_MARKER }),
		);
		assert.deepEqual(result, [text("abcd[]kl")]);
	});

	test("removes the span across text blocks and marks it once", () => {
		const blocks = ["a", "b", "c", "d"].map((letter) => text(letter.repeat(20)));
		const result = pruneContent(blocks, slice({ thresholdChars: 60, headChars: 10, tailChars: 10 }));
		assert.ok(result);
		assert.equal(textOf(result), "a".repeat(10) + MARKER + "d".repeat(10));
		assert.equal(count(textOf(result), MARKER), 1);
		assert.equal(codePointLength(textOf(result)), 10 + codePointLength(MARKER) + 10);
	});

	test("keeps non-text blocks in order with their fields", () => {
		const first = image("first");
		const second = image("second");
		const budget = slice({ thresholdChars: 10, headChars: 3, tailChars: 3, marker: SHORT_MARKER });
		const result = pruneContent([text("0123456789"), first, text("abcdefghij"), second], budget);
		assert.ok(result);
		assert.deepEqual(
			result.map((block) => block.type),
			["text", "image", "text", "image"],
		);
		assert.equal(result[1], first);
		assert.equal(result[3], second);
		assert.deepEqual(result, [text("012[]"), first, text("hij"), second]);
	});

	test("keeps fields the pruned text block carries", () => {
		const block: TextBlock = { type: "text", text: "abcdefghijkl", textSignature: "sig-1" };
		const budget = slice({ thresholdChars: 10, headChars: 4, tailChars: 2, marker: SHORT_MARKER });
		assert.deepEqual(pruneContent([block], budget), [
			{ type: "text", text: "abcd[]kl", textSignature: "sig-1" },
		]);
	});

	test("drops text blocks that fall entirely inside the removed span", () => {
		const budget = slice({ thresholdChars: 4, headChars: 1, tailChars: 1, marker: "M" });
		const result = pruneContent([text("aaaa"), text("bbbb"), text("cccc")], budget);
		assert.ok(result);
		assert.deepEqual(result, [text("aM"), text("c")]);
		assert.ok(result.every((block) => block.type !== "text" || block.text.length > 0));
	});

	test("never splits a surrogate pair", () => {
		const block = text("\u{1F600}".repeat(60));
		const budget = slice({ thresholdChars: 55, headChars: 10, tailChars: 5 });
		const result = pruneContent([block], budget);
		assert.ok(result);
		const output = textOf(result);
		for (const character of output) {
			const point = character.codePointAt(0) ?? 0;
			assert.ok(point < 0xd800 || point > 0xdfff, "output holds no lone surrogate");
		}
		assert.ok(output.startsWith("\u{1F600}".repeat(10)));
		assert.ok(output.endsWith("\u{1F600}".repeat(5)));
		assert.equal(codePointLength(output), 15 + codePointLength(MARKER));
	});

	test("returns undefined for a result that was already pruned", () => {
		const budget = slice({ thresholdChars: 60, headChars: 10, tailChars: 5 });
		const once = pruneContent([text(cycle(500))], budget);
		assert.ok(once);
		assert.equal(pruneContent(once, budget), undefined);
	});

	test("every over-budget input becomes head plus marker plus tail, below the threshold", () => {
		for (const total of [101, 102, 137, 400]) {
			for (const head of [0, 1, 40]) {
				for (const tail of [0, 1, 20]) {
					const budget = slice({ thresholdChars: 100, headChars: head, tailChars: tail });
					assert.ok(head + codePointLength(MARKER) + tail < budget.thresholdChars);
					const body = cycle(total);
					const result = pruneContent([text(body)], budget);
					assert.ok(result, `total ${total} head ${head} tail ${tail} prunes`);
					const output = textOf(result);
					const expected = body.slice(0, head) + MARKER + (tail === 0 ? "" : body.slice(total - tail));
					assert.equal(output, expected);
					assert.ok(codePointLength(output) <= budget.thresholdChars);
					assert.ok(codePointLength(output) < total);
					assert.equal(count(output, MARKER), 1);
				}
			}
		}
	});
});
