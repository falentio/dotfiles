/** Tool-result content as pi stores it. prune reads text and passes every other block through. */
export type TextBlock = { type: "text"; text: string; textSignature?: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ContentBlock = TextBlock | ImageBlock;

/** Slice sizes in Unicode code points, so a slice never splits a surrogate pair. */
export interface PruneBudget {
	readonly thresholdChars: number;
	readonly headChars: number;
	readonly tailChars: number;
	readonly marker: string;
}

export const codePointLength = (text: string): number => Array.from(text).length;

/** Unicode code points of the text blocks. Non-text blocks measure 0. */
export function measureText(blocks: readonly ContentBlock[]): number {
	let total = 0;
	for (const block of blocks) {
		if (block.type === "text") total += codePointLength(block.text);
	}
	return total;
}

/**
 * Head + marker + tail across the concatenation of text blocks, preserving non-text block order.
 * Returns undefined when the content fits, so a caller never rewrites a result needlessly.
 *
 * The span between headChars and total - tailChars is removed. Its first overlapping text block
 * carries the marker, so the marker appears exactly once even when the span crosses blocks.
 */
export function pruneContent(
	blocks: readonly ContentBlock[],
	budget: PruneBudget,
): ContentBlock[] | undefined {
	const total = measureText(blocks);
	if (total <= budget.thresholdChars) return undefined;

	const removedStart = budget.headChars;
	const removedEnd = total - budget.tailChars;
	const out: ContentBlock[] = [];
	let consumed = 0;
	let marked = false;

	for (const block of blocks) {
		if (block.type !== "text") {
			out.push(block);
			continue;
		}
		const points = Array.from(block.text);
		const start = consumed;
		const end = start + points.length;
		const headEnd = Math.min(points.length, Math.max(0, removedStart - start));
		const tailStart = Math.min(points.length, Math.max(0, removedEnd - start));
		const intersects = start < removedEnd && end > removedStart;
		const marker = intersects && !marked ? budget.marker : "";
		if (marker) marked = true;
		const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
		if (text.length > 0) out.push({ ...block, text });
		consumed = end;
	}

	return out;
}
