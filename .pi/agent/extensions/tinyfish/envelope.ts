import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * The MCP result shape. The model gets the body as text; a script gets it as `structuredContent`, which
 * codemode resolves the call to, so a call is an object there. A schema is what makes that apply, and
 * an open one declares it without pinning a field the API may add.
 */
export const OUTPUT_SCHEMA = { type: "object", additionalProperties: true } as const;

/** A script reads a primitive or an array by property, so both arrive wrapped. A real object passes. */
const keyed = (body: unknown): JsonValue => {
	const parsed = JSON.parse(JSON.stringify(body ?? null)) as JsonValue;
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : { value: parsed };
};

export const envelope = (body: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(body) }],
	structuredContent: keyed(body),
	details: undefined,
});
