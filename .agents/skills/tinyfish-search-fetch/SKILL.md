---
name: tinyfish-search-fetch
description: Use this skill before any TinyFish web research (MANDATORY). Run Search and Fetch through the Code Mode execute tool with tools.tinyfish.search and tools.tinyfish.fetch_content when the user needs current facts, source discovery, page content, news, research papers, structured extraction, or a Search-to-Fetch research pass.
---

# Search and fetch with TinyFish

Call TinyFish from the Code Mode `execute` tool. The runtime exposes `tools.tinyfish.search` and `tools.tinyfish.fetch_content`. The legacy native tools `tinyfish_search` and `tinyfish_fetch_content` are not in the Code Mode catalog, so every TinyFish call belongs inside `execute`.

Search returns ranked result metadata. Fetch returns content from known URLs. Use `tools.tinyfish.run_web_automation` for clicks, form entry, login, or another site workflow.

## Why route through Code Mode

- One `execute` call performs discovery and extraction. Search results feed Fetch without a return trip to the conversation.
- Independent calls run concurrently with `Promise.all`.
- Selection, deduplication, and filtering happen in JavaScript. Only the value you `return` enters context.
- Page text stays in the runtime until you decide what to return. Return excerpts and metadata instead of whole documents.

## Call shape

```js
const found = await tools.tinyfish.search({ query: "...", page: 0 });
const fetched = await tools.tinyfish.fetch_content({
  urls: found.results.slice(0, 3).map((r) => r.url),
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
});
return {
  sources: fetched.results.map((r) => ({ url: r.final_url, title: r.title })),
  failed: fetched.errors,
};
```

Rules for the runtime:

- Await every call. Pending calls are interrupted when the block ends.
- `tools.tinyfish.fetch_content` requires `urls`, `format`, `links`, `image_links`, and `page_metadata`. Omitting any of the four output fields throws a `Missing key` error before any network work.
- A request-level validation error throws. Conflicting search filters and a batch carrying a validator both throw. Wrap the block in `try/catch` when the arguments come from a user or a model.
- A per-URL failure does not throw. It appears in the `errors` array of the fetch envelope.
- Return JSON-serializable data. Read the live signature with `search({ query: "tinyfish" })` inside `execute` when a parameter shape matters.

## When TinyFish is not suitable

- The objective of the fetch is to get copy-pasteable content, like a component, block, code, or snippet.

## Route the request

- Use Search when the relevant URL is unknown or the user asks you to find sources.
- Use Fetch when the user gives a URL or when Search has identified source pages.
- Use Agent automation when the task requires interaction instead of reading.

## Search

1. State the evidence target in `query`. Add `purpose` when the query does not express how the results will be used. The query and purpose are concrete before the tool call.
2. Choose the search type. Use `domain_type: "web"` for general sources, `"news"` for articles with publisher and date fields, and `"research_paper"` for academic results.
3. Add only relevant filters. Use `include_domains` and `exclude_domains` for domain control. Use `location` and `language` for a regional result set. Use `recency_minutes` for a rolling freshness window or `after_date` and `before_date` for calendar bounds.
4. Keep time filters valid. Use `pub_year_min` and `pub_year_max` for research papers. Keep research-paper searches free of `recency_minutes`, `after_date`, and `before_date`. Keep rolling and calendar freshness filters separate.
5. Call `tools.tinyfish.search` with `page: 0` for the first page. Request another page only when the first page lacks enough relevant or independent sources. Keep `page` within `0` through `10`.
6. Read the envelope. `results` holds discovery records with `position`, `site_name`, `title`, `snippet`, and `url`. `total_results` and `page` echo the request. A news record adds `date` and `publisher`. A research-paper record adds `authors`, `year`, `venue`, `cited_by_count`, and `pdf_url`.
7. Treat each result's title, snippet, and URL as discovery data. Preserve the result URL and source position.
8. Use the `fetch` parameter for a one-call search and extraction only when its live schema matches the extraction need. The value is a JSON-encoded string of at most `256` characters, and the response adds a nested `fetch` object to each result. Use explicit `tools.tinyfish.fetch_content` when selectors, validators, or independent URL failure handling matter.
9. Set `include_thumbnail` to the string `"true"` or `"false"`, never a boolean. Request thumbnails only when the caller needs result images.
10. Base factual claims on fetched page content when available. Label a claim as a search-result summary when only a snippet supports it. The completed research has a traceable URL for every source-backed claim.

Use `purpose` as a short statement of the user's goal, not as a second keyword list. Use dedicated domain parameters instead of putting domain filters in the query when the API supports them.

## Fetch

1. Normalize the input to public `http` or `https` URLs. Batch at most ten URLs per call. The URL set is valid before the tool call.
2. Pass all four required output fields: `format`, `links`, `image_links`, and `page_metadata`. A call without them is rejected before any network work.
3. Define the extraction goal in `purpose` when the task needs focused extraction. Keep the purpose under `2000` characters.
4. Choose one output format. Use `format: "markdown"` for readable page content, `"html"` when markup matters, and `"json"` for the structured document tree.
5. Set output flags deliberately. Set `links: true` when outbound URLs matter. Set `image_links: true` when image URLs matter. Set `page_metadata: true` when titles, descriptions, authors, dates, or Open Graph data matter.
6. Scope extraction when the page has a clear region. Use `exclude_selectors` before `include_selectors` to remove noise and keep the target region. Each selector array has at most twenty entries, and each entry has at most one thousand characters.
7. Treat selector results as a contract. A partial include match returns matched content and `unmatched_selectors`. A total miss returns `selector_not_matched` with candidate selectors. Retry with a useful candidate or change the selector. Keep a scoped request scoped.
8. Set freshness intentionally. Omit `ttl` to accept the cache, use `ttl: 0` for a live preference, and use a positive number of seconds for a bounded freshness preference. Use `per_url_timeout_ms` only when a page needs a custom deadline.
9. Use validators for repeatable single-page checks. First set `include_etag_and_last_modified: true`. Replay one returned `etag` or `last_modified` value through `if_none_match` or `if_modified_since` on a single-URL request. A batch with a validator throws.
10. Inspect both `results` and `errors`. A successful HTTP response can contain failures for individual URLs. Match each result to `url` and `final_url`, and report or recover from each per-URL error.
11. Return the extracted content with its source URL, final URL, title, and relevant metadata. State the format, scope, freshness choice, and any URL-level failures. Return only the needed excerpt when the full text is large.

## Search-to-Fetch

When Search produced the URLs, preserve result order and pass the smallest useful set to Fetch in the same `execute` call. Fetch the top three sources for a normal research pass. Use a larger batch only when the question needs broader comparison and the batch remains within ten URLs.

```js
const { results } = await tools.tinyfish.search({
  query: "...",
  purpose: "...",
  page: 0,
});
const { results: pages, errors } = await tools.tinyfish.fetch_content({
  urls: results.slice(0, 3).map((r) => r.url),
  purpose: "Extract ...",
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
});
return {
  sources: pages.map((p) => ({ url: p.final_url, title: p.title, text: p.text })),
  failed: errors,
};
```

## Examples

### Search the web with intent

```js
const out = await tools.tinyfish.search({
  query: "Python PDF invoice parser",
  purpose: "Find an open-source library for parsing PDF invoices in Python",
  include_domains: "github.com,pypi.org",
  language: "en",
  page: 0,
});
return out.results;
```

### Search recent news

```js
const out = await tools.tinyfish.search({
  query: "AI regulation",
  purpose: "Find reporting from the last 24 hours about AI regulation",
  domain_type: "news",
  location: "US",
  recency_minutes: 1440,
  page: 0,
});
return out.results.map(({ title, publisher, date, url }) => ({ title, publisher, date, url }));
```

### Search research papers by publication year

```js
const out = await tools.tinyfish.search({
  query: "transformer architecture",
  purpose: "Find academic papers about transformer architecture published from 2019 through 2022",
  domain_type: "research_paper",
  pub_year_min: 2019,
  pub_year_max: 2022,
  page: 0,
});
return out.results;
```

Do not add `recency_minutes`, `after_date`, or `before_date` to this research-paper request.

### Search and fetch source pages in one call

```js
const found = await tools.tinyfish.search({
  query: "TinyFish web agent",
  purpose: "Find authoritative pages that explain the TinyFish web agent",
  page: 0,
});
const fetched = await tools.tinyfish.fetch_content({
  urls: found.results.slice(0, 3).map((r) => r.url),
  purpose: "Extract the sections that explain when to use Search and how to pass search intent",
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
});
return {
  pages: fetched.results.map((r) => ({ url: r.final_url, title: r.title, text: r.text })),
  failed: fetched.errors,
};
```

### Fetch a focused page region

```js
const out = await tools.tinyfish.fetch_content({
  urls: ["https://example.com/article"],
  purpose: "Extract the article body without navigation, comments, or related links",
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
  exclude_selectors: ["nav", "aside", ".comments"],
  include_selectors: ["main", "article"],
});
return { pages: out.results, failed: out.errors };
```

If the response contains `unmatched_selectors`, use the matched content and report the misses. If the response contains `selector_not_matched`, use its candidate selectors or revise the scope. Do not silently treat an unscoped page as equivalent.

### Fetch current content and retain validators

First request validators:

```js
const first = await tools.tinyfish.fetch_content({
  urls: ["https://example.com/status"],
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
  ttl: 0,
  include_etag_and_last_modified: true,
});
return first.results[0].etag;
```

On a later single-URL request, replay one validator from the result:

```js
const next = await tools.tinyfish.fetch_content({
  urls: ["https://example.com/status"],
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
  if_none_match: "<etag from the previous result>",
});
return next.results[0].not_modified ? "unchanged" : next.results[0].text;
```

When the origin returns `304`, the result carries `not_modified: true` and `text: null`. Retain the previous content and the validators.

## Search API reference

Use the live `tools.tinyfish.search` schema as the runtime contract. Read it with `search({ query: "tinyfish.search" })` inside `execute`. The HTTP API endpoint is `GET https://api.search.tinyfish.ai`. Requests use the `X-API-Key` header. The documented environment variable is `TINYFISH_API_KEY`. Search requests are free at any wallet balance, but the account still needs Search API access.

### Search filter rules

- Do not combine `recency_minutes` with `after_date` or `before_date`.
- If both calendar bounds are present, `after_date` is less than or equal to `before_date`.
- Do not use calendar or rolling freshness filters with `domain_type: "research_paper"`.
- Use publication-year bounds for research papers. If both are present, `pub_year_min` is less than or equal to `pub_year_max`.
- If only one of `location` and `language` is present, TinyFish resolves the other. If neither is present, the default pairing is `US` and `en`.
- Query operators such as `site:` and `-site:` still work. Dedicated domain parameters are preferred.
- A filter conflict throws before the request runs, and the error names the offending parameter.

Search metadata is not full page content. Fetch the URL before treating a snippet as evidence for a detailed claim.

## Fetch API reference

Use the live `tools.tinyfish.fetch_content` schema as the runtime contract. Read it with `search({ query: "tinyfish.fetch_content" })` inside `execute`. The HTTP API endpoint is `POST https://api.fetch.tinyfish.ai`. Requests use the `X-API-Key` header and `Content-Type: application/json`. The documented environment variable is `TINYFISH_API_KEY`. Fetch requests are free at any wallet balance, but the account still needs an API key.

Required fields are `urls`, `format`, `links`, `image_links`, and `page_metadata`. Selector parameters can contain CSS comma-grouping. Invalid CSS syntax throws from the tool call, and the error names the offending selector.

### Fetch result envelope

- `results` holds one entry per successful URL. Each entry has `url`, `final_url`, `title`, `description`, `language`, `text`, `author`, `published_date`, `latency_ms`, and `format`, plus `links`, `image_links`, or `page_metadata` when requested.
- `errors` holds one entry per failed URL. Each entry has `url`, an `error` code such as `invalid_url`, `bot_blocked`, `selector_not_matched`, or `selector_unsupported`, and any available `status` or details.
- A per-URL failure never throws. Inspect `errors` even when the call succeeded.
- A validator replay that hits `304` returns `not_modified: true` and `text: null`.

### Fetch selector behavior

- Exclusions run before inclusions.
- Selector processing runs after fetching and does not change cache or routing.
- Scripts and styles are removed from scoped output.
- Scoped extraction bypasses automatic boilerplate removal.
- `text`, `links`, and `image_links` are scoped. Page-level metadata remains based on the full document.
- A partial include match returns `unmatched_selectors` with the matched content.
- A total include miss returns `selector_not_matched` and candidate selector hints. The service does not silently return the full page.
- A direct PDF or CSV URL with selectors returns `selector_unsupported`.

### Fetch freshness and validators

- Omit `ttl` when any available cache is acceptable.
- Use `ttl: 0` when current origin content matters.
- Use a positive `ttl` when a bounded freshness preference is enough.
- Set `include_etag_and_last_modified: true` to receive validators. The service does not store validators for you.
- Replay `if_none_match` or `if_modified_since` only with one URL.
- A `304` origin response produces `not_modified: true`. The worked response can contain `text: null`.
- Browser-rendered pages can return `conditional_unsupported` because conditional requests use a fast path.

### Fetch content result

Titles prefer `og:title` over `<title>`. Descriptions prefer `og:description` over the description meta tag. The `text` value is a string for Markdown or HTML, an object for JSON, or `null` for a not-modified result.

### Supported content

- HTML receives formatted text extraction.
- PDF receives text extraction.
- JSON endpoints return raw JSON as text unless the `json` format is requested for the document tree.
- Plain text returns in full.
- PNG and JPG images are unsupported.
- Video and other unsupported binary content can fail with a per-URL error.
- Selectors are unsupported for direct PDF and CSV downloads.

## Completion check

The task is complete only when the TinyFish calls ran inside `execute`, the route is correct, all selected filters are compatible, the chosen format and flags match the evidence need, the full `results` and `errors` arrays were checked, scoped extraction was not silently widened, and every source-backed claim has a traceable page URL.
