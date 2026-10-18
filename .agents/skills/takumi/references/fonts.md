# Fonts

Takumi reads no system fonts. What renders is the built-in face plus whatever you pass as `fonts`.

## Before you load anything

One face ships built in: Geist, Latin only, weights 300 to 800. Latin text paints without any setup. Every other script, and any brand face, needs a font.

A character the built-in face has no glyph for does not raise anything. It draws the same box as any other uncovered character, so a page of Japanese can ship as a row of identical boxes and the render still resolves. Compare the pixels when a script is in doubt, or load the font and see the text change.

Naming a font installed on the machine does nothing. `fontFamily: "DejaVu Sans"` and `fontFamily: "NoSuchFace"` measure identically.

## Pass fonts

`fonts` accepts bytes, a descriptor, a URL string fetched on demand, or a promise of any of those. Pass it on every render: a registered font stays in the process's default fallback chain and changes later renders ([pitfalls](pitfalls.md#register-fonts-deliberately-they-outlive-the-render)).

```tsx
import { readFile } from "node:fs/promises";

const brand = await readFile("./brand.woff2");                    // bytes
fonts: [brand]

fonts: [{ name: "Brand", data: brand, weight: 700, style: "italic" }]   // descriptor, name and weight optional

fonts: ["https://cdn.example/brand.woff2"]                        // fetched during the render
```

A bad URL rejects the render with the network error, so a deploy whose font host is unreachable fails loudly rather than falling back to boxes.

A weight or style you did not supply is synthesized from the nearest face. Set `fontSynthesis: "none"` on the element when a real face has to exist.

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

- A bare string loads weight 400, normal style.
- `weight` takes one weight, a list, or a range such as `"100..900"`; a range loads the variable font, and `fontWeight` plus `fontVariationSettings` on the element drive its axes.
- `axes` picks the variable axes to keep, each at a value or a range.
- `generic` claims a CSS generic keyword for the family, so a stack ending in `serif` or `monospace` reaches it without naming the family.
- The options object form takes `{ families, display, baseUrl }` plus the fetch options below. Point `baseUrl` at an API-compatible mirror such as `https://fonts.bunny.net/css2` when Google is unreachable or you would rather not call it.
- Fetch options apply wherever Takumi downloads fonts: `fetch`, `timeout` (30 s default), `maxBytes` (32 MiB default), `allowUrl` (return false to refuse a URL), `signal`.

Each returned subset carries `{ name, key, weight, style, unicodeRange, generic, data() }`. `name` is the family to write in `font-family`, and `unicodeRange` routes a codepoint to the subset that declares it, the way a browser does.

## Subset and pin

Drop subsets the content cannot use, before any download:

```tsx
import { subsetFonts, collectCodepoints } from "takumi-js/helpers";

const fonts = await googleFonts(["Noto Sans JP"]);
const used = subsetFonts({ fonts, source: [node, "0123456789"] });   // free, offline
await render(node, { width, height, fonts: used });
```

`source` is a node, a string, or a list of them. `collectCodepoints(source)` lists the codepoints when you need the numbers themselves. Ranged subsets are trimmed to what the content draws and a whole font file always loads in full; range-less entries are always kept.

Pin one render's chain with `fontFamilies`. It overrides the registered set for that render only:

```tsx
await render(card, { width, height, fonts, fontFamilies: ["Inter", "Noto Sans JP"] });
await render(card, { width, height, fontFamilies: [] });   // built-in face only
```

## Register once, reuse

Rendering many images, register faces on a `Renderer` and pass it in. Registration returns the families it created, with the faces each one holds, which is the cheap assertion that a file carries the weight you expect.

```tsx
import { Renderer } from "takumi-js/node";

const renderer = new Renderer({ cacheMaxBytes: 128 * 1024 * 1024 });
const families = await renderer.registerFont({ name: "Inter", data: inter, weight: 400 });
// [{ name: "Inter", faces: [{ weight: 400, style: "normal", width: 100, index: 0 }] }]

await render(card, { width: 1200, height: 630, renderer });
```

Register each subset of a family under the same `name` with its own `unicodeRange`, and the codepoint picks the subset. Two budgets matter here: `cacheMaxBytes` on the renderer covers decoded images, rasterized SVG, and parsed stylesheets; `setGlyphCacheMaxBytes` covers resolved glyphs and masks, defaults to 8 MiB, and is read at first use, so call it before the first render. A CJK page re-rasterizes glyphs under that default.

## Emoji

`emoji` picks where emoji glyphs come from: `"twemoji"` (default), `"blobmoji"`, `"noto"`, `"openmoji"`, `"fluent"`, `"fluentFlat"`, or `"from-font"`. Every provider but `"from-font"` fetches glyph images from a CDN during the render.

- Reachable network: leave the default.
- No egress: pass `emoji: "from-font"` and a font that carries the emoji, or prefetch the emoji images.
- Manual path: `extractEmojis(node, emojiType)` rewrites emoji text nodes into image nodes you can serve yourself.

## Read more

[Typography & Fonts](https://takumi.kane.tw/docs/typography-and-fonts) covers styling text, flowing text, and choosing a face. [Images & Emoji](https://takumi.kane.tw/docs/load-images#emoji) covers the emoji pipeline.
