# Takumi pitfalls

Each rule below is reproduced by `../scripts/verify-gotchas.tsx`, run against `takumi-js@2.16.3`. Run it before trusting any number here after an upgrade.

## Size the canvas in device pixels

`width` and `height` are the canvas in device pixels, and `devicePixelRatio` is the CSS-pixel-to-device-pixel ratio used during layout, not a scale factor on the export.

- With an explicit canvas, `devicePixelRatio: 2` draws every CSS length twice as large inside the same `width` by `height` canvas, so content overflows and clips.
- With no `width`/`height`, the canvas is sized from content, and `devicePixelRatio: 2` doubles the returned dimensions: a 320x180 element renders 640x360.

To export a 1200x630 design at 2x, ask for 2x the canvas and keep the ratio:

```tsx
await render(card, { width: 2400, height: 1260, devicePixelRatio: 2 });
```

The docs page [Output Formats](https://takumi.kane.tw/docs/output-formats#device-pixel-ratio) describes `devicePixelRatio: 2` on a 1200x630 canvas as producing a 2400x1260 image. That holds only for a content-sized canvas.

## Register fonts deliberately, they outlive the render

The managed `render` keeps one renderer per process. Fonts passed as `fonts` are registered on it and stay in the default fallback chain for later renders in the same process, which silently changes their output.

```tsx
await render(a, { fonts: [inter] });   // Inter is now the default family
await render(b, {});                   // b renders in Inter
await render(c, { fontFamilies: ["Geist"] });  // this render only
```

Pass `fonts` on every render, pass `fontFamilies` to pin one render's chain, or construct a `Renderer` and pass it as `options.renderer` for full isolation. A reused `Renderer` also renders byte-identical output across calls, which makes snapshots stable.

## Load the fonts you need, there is no system font

Takumi never reads installed fonts. It ships one built-in fallback, Geist, covering Latin at weights 300 to 800, and it sits last in the fallback chain. Pass `fonts` for every other script, every icon set, and every brand face.

Naming a font the machine has installed does nothing. `fontFamily: "DejaVu Sans"` and `fontFamily: "Nonexistent Family"` measure identically.

An uncovered character draws a box, and every uncovered character draws the same box: two different Japanese strings render identically and the render still resolves, so a Japanese or Arabic page can ship as boxes with no error anywhere. Compare the pixels when a script is in question. The PDF renderer is the exception: it rejects the same text with `No registered font covers 漢 (U+6F22), 字 (U+5B57). Register one that does.`

```tsx
import { googleFonts } from "takumi-js/helpers";

const fonts = await googleFonts([{ name: "Noto Sans JP", weight: "400..700" }]);
await render(card, { width, height, fonts });
```

## Emoji are fetched from a CDN by default

`emoji` defaults to `"twemoji"`, so a render containing emoji issues network requests. In an air-gapped CI job, an offline edge worker, or behind an egress allowlist, that request fails and takes the render with it.

Pass `emoji: "from-font"` with a font file that carries the glyphs, or keep the CDN reachable and let the default run.

## Remote images are fetched during the render

An `<img src="https://...">` is fetched while rendering, with a 30 second timeout and a 32 MiB body cap. Prefetch when the bytes are already in hand and the key must match the `src` string exactly:

```tsx
await render(element, { images: [{ src: "https://cdn.example/avatar.png", data: bytes }] });
```

A `src` with no matching entry falls through to the network. Restrict or refuse with `images: { allowUrl: (url) => url.startsWith("https://cdn.example/") }`, which throws `URL blocked by allowUrl policy` for anything else.

Raw pixels are for node trees only: `{ type: "image", src: { width, height, data } }`. Passing an `RgbaImage` object as an `images[]` entry throws `Expected Buffer, ArrayBuffer, or Uint8Array`.

## CSS covers less than a browser

The supported surface is a documented subset. Traps an agent walks into:

- `position: sticky` does not exist, and `overflow` takes `visible`, `clip`, or `hidden` only.
- `transform` is 2D only.
- `:hover` and `:focus` parse and never match, and `prefers-color-scheme` matches nothing.
- `@media` reads viewport width, height, aspect-ratio, orientation, resolution, and media type.

Grid, block, inline, and float layout work, along with `::before`/`::after`, `:is()`, `calc()`, `@supports`, and RTL. The property matrix is [the CSS reference](https://takumi.kane.tw/docs/reference).

## Validate your own input

`render` coerces what it is given. `render(123, options)` and `render(null, options)` both resolve and produce a small image instead of throwing, so a bad value from a database or a query string ships as a wrong image. Check the input where it enters your code.

Errors you can rely on: an unknown `format` rejects with `does not match any variant of enum OutputFormat`; a canvas outside 1 to 64 megapixels rejects with `Invalid viewport dimensions: a canvas holds 1 to 64 megapixels`; an aborted `signal` rejects with `The operation was aborted.`.

## A bad CSS value fails the render, an unknown property does not

An unrecognized property name in a style object is dropped without a word. A known property with an unparsable value rejects the render with the property name, the offending value, and the values it accepts.

```
InvalidArg, invalid value for display, ... near "not-a-display": ... expected a value of 'none
```

That error is the fastest way to find the typo, so let it surface rather than wrapping the render in a catch-all.

## Budget the caches

Two separate budgets, both process-wide:

- `new Renderer({ cacheMaxBytes })` covers decoded images, rasterized SVG, and parsed stylesheets. Default 64 MiB, `0` disables.
- `setGlyphCacheMaxBytes(bytes)` covers resolved glyphs and glyph masks. Default 8 MiB, read at first use, so call it before the first render.

A CJK page re-rasterizes glyphs under the 8 MiB default. Raise it for large glyph sets, and keep one `Renderer` alive across requests instead of constructing one per render.

## Animation is a timeline, not a loop

`render` draws one frame at `timeMs`; `renderAnimation` samples the timeline into a WebP, APNG, or GIF. Nothing runs on its own. An element with `animate-spin` stays put unless you pass `timeMs` or put it in a scene, and `timeMs: 0` is what omitting it does.

On `takumi-js@2.16.3` a `rotate()` step in stylesheet keyframes renders byte-identical frames at every `timeMs`, while `translateX()` in the same shape animates, and Tailwind's `animate-spin` preset animates. Check the frames you animate rather than trusting the class: the proof script reports both sides of this.

## SVG drops the raster options

`renderSvg` returns an SVG document string and takes no `format`, `quality`, `lossless`, `dithering`, `drawDebugBorder`, or `devicePixelRatio`. The types reject them, so a shared options object needs the raster keys stripped before it reaches `renderSvg`.
