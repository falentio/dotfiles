import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * The MCP result shape, with one change: the body is the structured content and the text is a summary.
 * A script reads the call's value and never parses; the text stays for a reader and for a host that only
 * renders text. The schema is open, so a field the API adds tomorrow still arrives.
 */
export const OUTPUT_SCHEMA = { type: "object", additionalProperties: true } as const;

/** A script reads a primitive or an array by property, so both arrive wrapped. A real object passes. */
const keyed = (body: unknown): JsonValue => {
	const value = (body ?? null) as JsonValue;
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : { value };
};

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * What a reader needs to decide whether to look further: how many results, which URLs failed, and which
 * ones came back. Never the whole body, which is what the structured side is for.
 */
export const summarize = (body: unknown): string => {
	if (typeof body !== "object" || body === null) return JSON.stringify(body) ?? String(body);
	const record = body as Record<string, unknown>;
	const results = Array.isArray(record.results) ? record.results : [];
	const errors = Array.isArray(record.errors) ? record.errors : [];
	const lines: string[] = [];
	if ("total_results" in record) {
		lines.push(`${plural(Number(record.total_results) || 0, "result")} for ${JSON.stringify(record.query ?? "")}`);
	} else if (results.length > 0) {
		lines.push(`fetched ${plural(results.length, "page")}`);
	}
	for (const result of results.slice(0, 3)) {
		if (typeof result !== "object" || result === null) continue;
		const { title, url } = result as { title?: unknown; url?: unknown };
		lines.push(`- ${String(title ?? "(untitled)")} ${String(url ?? "")}`.trimEnd());
	}
	if (results.length > 3) lines.push(`- and ${results.length - 3} more`);
	if (errors.length > 0) {
		const failed = errors
			.slice(0, 3)
			.map((error) => (typeof error === "object" && error !== null ? String((error as { error?: unknown }).error ?? "error") : String(error)))
			.join(", ");
		lines.push(`${plural(errors.length, "URL")} failed: ${failed}${errors.length > 3 ? ", …" : ""}`);
	}
	return lines.length > 0 ? lines.join("\n") : "no results";
};

export const envelope = (body: unknown) => ({
	content: [{ type: "text" as const, text: summarize(body) }],
	structuredContent: keyed(body),
	details: undefined,
});
