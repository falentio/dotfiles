import { arr, bool, int, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";

const choice = <const V extends readonly string[]>(values: V, description: string): Schema<V[number]> =>
	({ enum: values, description });

export const SEARCH_PARAMETERS = obj(
	{
		query: str({ description: "Search query", minLength: 1, maxLength: 2000 }),
		purpose: opt(
			str({
				description:
					"Why this search is being run: the underlying goal or task the results will be used for. Ranks results against your intent.",
				minLength: 1,
				maxLength: 2000,
			}),
		),
		location: opt(str({ description: "Country code for geo-targeted results" })),
		language: opt(str({ description: "Language code for result language" })),
		include_domains: opt(str({ description: "Comma-separated list of domains to restrict results to" })),
		exclude_domains: opt(str({ description: "Comma-separated list of domains to remove from results" })),
		after_date: opt(str({ description: "Return results after this date (YYYY-MM-DD)" })),
		before_date: opt(str({ description: "Return results before this date (YYYY-MM-DD)" })),
		recency_minutes: opt(
			int({ description: "Return results from the past N minutes (1 to 5,256,000).", minimum: 1, maximum: 5_256_000 }),
		),
		domain_type: opt(
			choice(
				["web", "news", "research_paper"],
				'Type of search: "web", "news" for news articles, or "research_paper" for academic papers. Defaults to "web".',
			),
		),
		pub_year_min: opt(
			int({ description: "Papers published on or after this year. Research papers only.", minimum: 0, maximum: 9999 }),
		),
		pub_year_max: opt(
			int({ description: "Papers published on or before this year. Research papers only.", minimum: 0, maximum: 9999 }),
		),
		page: opt(int({ description: "Page number, starting at 0", minimum: 0, maximum: 10 })),
		include_thumbnail: opt(
			choice(["true", "false"], 'When "true", each result includes a thumbnail_url when available. Defaults to false.'),
		),
		fetch: opt(str({ description: "JSON-encoded fetch configuration object.", maxLength: 256 })),
	},
	{ open: true },
);

export const SEARCH_DESCRIPTION =
	"Web search through TinyFish. Use for current facts, docs, product and tool explanations, comparisons, and finding source URLs; call tinyfish_fetch_content before treating a snippet as evidence. Returns compact ranked metadata (position, site_name, title, snippet, url) with total_results and page. A rate limit waits instead of throwing.";

export const FETCH_PARAMETERS = obj(
	{
		urls: arr(str({ description: "URLs to fetch, 1 to 10, fetched in parallel" }), { minItems: 1, maxItems: 10 }),
		format: choice(
			["markdown", "html", "json"],
			'Output format: "markdown" for readable content, "html" for markup, "json" for a document tree.',
		),
		// Optional because the MCP took a call without them, and each defaults to off on the wire.
		links: opt(bool({ description: "Also return outbound links (<a href>) per result", default: false })),
		image_links: opt(bool({ description: "Also return image URLs (<img src>) per result", default: false })),
		page_metadata: opt(bool({ description: "Also return page-head metadata per result", default: false })),
		iframe_links: opt(bool({ description: "Also return iframe src URLs per result", default: false })),
		purpose: opt(
			str({
				description: "Why these URLs are being fetched: the goal the content will serve. Tailors fetching and extraction.",
				minLength: 1,
				maxLength: 2000,
			}),
		),
		ttl: opt(
			int({ description: "Freshness tolerance in seconds. Omit to accept the cache, 0 to prefer a live fetch.", minimum: 0 }),
		),
		per_url_timeout_ms: opt(
			int({ description: "Per-URL timeout in milliseconds; one slow URL does not fail the batch.", minimum: 1, maximum: 110_000 }),
		),
		include_selectors: opt(
			arr(str({ description: "CSS selector that scopes extracted content" }), { minItems: 1, maxItems: 20 }),
		),
		exclude_selectors: opt(
			arr(str({ description: "CSS selector for elements to remove before extraction" }), { minItems: 1, maxItems: 20 }),
		),
		include_etag_and_last_modified: opt(
			bool({ description: "Return etag / last_modified validators per result", default: false }),
		),
		if_none_match: opt(str({ description: "Replay a prior etag. One URL only.", minLength: 1 })),
		if_modified_since: opt(str({ description: "Replay a prior last_modified. One URL only.", minLength: 1 })),
	},
	{ open: true },
);

export const FETCH_DESCRIPTION =
	"Fetch and extract page content through TinyFish. Returns { results, errors }: a per-URL failure lands in errors and does not throw. Selectors scope the extraction, ttl sets freshness, and a validator replay answers not_modified.";

export type SearchParams = Static<typeof SEARCH_PARAMETERS>;
export type FetchParams = Static<typeof FETCH_PARAMETERS>;
