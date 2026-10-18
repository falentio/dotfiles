# Fonts

Loading, subsets, variable axes, and emoji. Option names and defaults are in [api.md](api.md), the traps in [pitfalls.md](pitfalls.md), and the rule that nothing reads the machine's installed fonts is step 4 of [the skill](../SKILL.md).

## Pass fonts

`fonts` accepts bytes, a descriptor, a URL string fetched on demand, or a promise of any of those. Pass it on every render: a registered font stays in the process's default fallback chain and changes later renders ([pitfalls](pitfalls.md#register-fonts-deliberately-they-outlive-the-render)).

```tsx
import { readFile } from "node:fs/promises";

const brand = await readFile("./brand.woff2");
await render(card, { width, height, fonts: [brand] });                                        // bytes
await render(card, { width, height, fonts: [{ name: "Brand", data: brand, weight: 700 }] });  // descriptor, name and weight optional
await render(card, { width, height, fonts: ["https://cdn.example/brand.woff2"] });            // fetched during the render
```

A bad URL rejects the render with the network error, so a deploy whose font host is unreachable fails loudly rather than falling back to boxes. A weight or style you did not supply is synthesized from the nearest face; set `fontSynthesis: "none"` on the element when a real face has to exist.

## Google Fonts

`googleFonts` makes one css2 request and returns every coverage subset of the requested families. The subset bytes download lazily, and the renderer registers only the subsets the content uses.

```tsx
import { googleFonts } from "takumi-js/helpers";

const fonts = await googleFonts([
  "Inter",
  { name: "Noto Sans JP", weight: "400..700" },
  { name: "Fraunces", weight: 700, style: "italic", axes: { opsz: "9..144" }, generic: "serif" },
]);

await render(card, { width: 1200, height: 630, fonts });
```

A bare string loads weight 400, normal style. `weight` takes one weight, a list, or a range such as `"100..900"`, and a range loads the variable font, whose axes `fontWeight` and `fontVariationSettings` drive on the element. `axes` keeps the named variable axes, and `generic` claims a CSS generic keyword for the family. Point the options object's `baseUrl` at an API-compatible mirror such as `https://fonts.bunny.net/css2` when Google is unreachable or you would rather not call it.

Each returned subset carries `{ name, key, weight, style, unicodeRange, generic, data() }`; `name` is the family to write in `font-family`, and `unicodeRange` routes a codepoint to the subset that declares it, the way a browser does. `fetch`, `timeout` (30 s default), `maxBytes` (32 MiB default), `allowUrl`, and `signal` apply wherever Takumi downloads fonts.

## Subset and pin

Drop subsets the content cannot use, before any download:

```tsx
import { subsetFonts, collectCodepoints } from "takumi-js/helpers";

const fonts = await googleFonts(["Noto Sans JP"]);
const used = subsetFonts({ fonts, source: [node, "0123456789"] });   // free, offline
await render(node, { width, height, fonts: used });
```

`source` is a node, a string, or a list of them, and `collectCodepoints(source)` lists the codepoints themselves. Ranged subsets are trimmed to what the content draws, a whole font file always loads in full, and range-less entries are always kept. `fontFamilies` pins one render's chain, overriding the registered set for that render only:

```tsx
await render(card, { width, height, fonts, fontFamilies: ["Inter", "Noto Sans JP"] });
await render(card, { width, height, fontFamilies: [] });   // built-in face only
```

## Register once, reuse

```tsx
import { Renderer } from "takumi-js/node";

const renderer = new Renderer({ cacheMaxBytes: 128 * 1024 * 1024 });
const families = await renderer.registerFont({ name: "Inter", data: inter, weight: 400 });
// [{ name: "Inter", faces: [{ weight: 400, style: "normal", width: 100, index: 0 }] }]

await render(card, { width: 1200, height: 630, renderer });
```

Registration returns the families it created, with the faces each one holds, which is the cheap assertion that a file carries the weight you expect. Register each subset of a family under the same `name` with its own `unicodeRange`, and the codepoint picks the subset. The two cache budgets are in [pitfalls](pitfalls.md#budget-the-caches).

## Emoji

`emoji` picks the provider: `"twemoji"` (default), `"blobmoji"`, `"noto"`, `"openmoji"`, `"fluent"`, `"fluentFlat"`, or `"from-font"`, which draws the glyph from a loaded emoji font with no fetch. On the manual path, `extractEmojis(node, emojiType)` rewrites emoji text nodes into image nodes you can serve yourself. The default provider's network dependency and its check are in [pitfalls](pitfalls.md#emoji-are-fetched-from-a-cdn-by-default).

## Read more

[Typography & Fonts](https://takumi.kane.tw/docs/typography-and-fonts) covers styling text, flowing text, and choosing a face. [Images & Emoji](https://takumi.kane.tw/docs/load-images#emoji) covers the emoji pipeline.
