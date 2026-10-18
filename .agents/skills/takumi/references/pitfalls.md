# Takumi pitfalls

Measured against `takumi-js@2.16.3`; `../scripts/verify-gotchas.tsx` re-runs these rules and prints the measured value beside each one. Run it before trusting a number here after an upgrade.

## Size the canvas in device pixels

The measured shape of `devicePixelRatio` on 2.16.3:

- With an explicit canvas, `devicePixelRatio: 2` draws every CSS length twice as large inside the same `width` by `height` canvas, so content overflows and clips.
- With no `width`/`height`, the canvas is sized from content, and `devicePixelRatio: 2` doubles the returned dimensions: a 300x150 element renders 600x300.

To export a 1200x630 design at 2x, ask for 2x the canvas and keep the ratio:

```tsx
await render(card, { width: 2400, height: 1260, devicePixelRatio: 2 });
```

The docs page [Output Formats](https://takumi.kane.tw/docs/output-formats#device-pixel-ratio) says `devicePixelRatio` "scales the output resolution without touching the layout", and a 1200 x 630 render at `devicePixelRatio: 2` produces a 2400 x 1260 "image whose elements keep their CSS sizes". Both hold only for a content-sized canvas: with an explicit canvas the size is final, and the elements inside it stop keeping their CSS sizes.

## Register fonts deliberately, they outlive the render

The managed `render` keeps one renderer per process. Fonts passed as `fonts` are registered on it and stay in the default fallback chain for later renders in the same process, which silently changes their output.

```tsx
await render(a, { fonts: [inter] });   // Inter is now the default family
await render(b, {});                   // b renders in Inter
await render(c, { fontFamilies: ["Geist"] });  // this render only
```

Pass `fonts` on every render, pass `fontFamilies` to pin one render's chain, or construct a `Renderer` and pass it as `options.renderer` for full isolation. A reused `Renderer` also renders byte-identical output across calls, which makes snapshots stable.

## Load the fonts you need, there is no system font

Naming a font the machine has installed does nothing. `fontFamily: "DejaVu Sans"` and `fontFamily: "Nonexistent Family"` measure identically.

An uncovered character draws a box, and every uncovered character draws the same box: two different Japanese strings render identically and the render still resolves, so a Japanese or Arabic page can ship as boxes with no error anywhere. Compare the pixels when a script is in question. The PDF renderer is the exception: it rejects the same text with `No registered font covers 漢 (U+6F22), 字 (U+5B57). Register one that does.`

```tsx
import { googleFonts } from "takumi-js/helpers";

const fonts = await googleFonts([{ name: "Noto Sans JP", weight: "400..700" }]);
await render(card, { width, height, fonts });
```

## Emoji are fetched from a CDN by default

A render containing emoji issues network requests, and a failed fetch takes the render with it: with `images: { fetch: () => Promise.reject(new Error("offline-probe")) }` the call rejects with that error instead of drawing a box, while the same card with `emoji: "from-font"` renders offline from a loaded font.

## Remote images are fetched during the render

An `<img src="https://...">` is fetched while rendering, with a 30 second timeout and a 32 MiB body cap. Prefetch when the bytes are already in hand and the key must match the `src` string exactly:

```tsx
await render(element, { images: [{ src: "https://cdn.example/avatar.png", data: bytes }] });
```

A `src` with no matching entry falls through to the network. Restrict or refuse with `images: { allowUrl: (url) => url.startsWith("https://cdn.example/") }`, which throws `URL blocked by allowUrl policy` for anything else.

Raw pixels are for node trees only: `{ type: "image", src: { width, height, data } }`. Passing an `RgbaImage` object as an `images[]` entry throws `Expected Buffer, ArrayBuffer, or Uint8Array`.

## CSS covers less than a browser

The supported surface is a documented subset. Traps an agent walks into:

- `position: sticky` rejects the render with `InvalidArg, invalid value for position`, and `overflow` takes `visible`, `clip`, or `hidden` only.
- `transform` is 2D only.
- `:hover` and `:focus` parse and never match, and a `prefers-color-scheme` block never applies: in a 40x20 canvas a `(min-width: 10px)` block paints and a `(prefers-color-scheme: dark)` block beside it does not.
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

An angle keyframe moves along the shorter of the two arcs, so a 0 to 360 degree step is a zero-degree step and every frame is the first frame. Below 180 degrees it animates: frames at 0, 125, and 250 ms are distinct for 0 to 90 and for 0 to 270, and identical for 0 to 360 and for 0 to 359, which travels one degree backwards and stays under a pixel. The individual `rotate` property takes the same path as `transform: rotate()`.

For a full turn, write the quarters as separate keyframes the way Takumi's own `animate-spin` preset does (`0`, `90`, `180`, `270`, `359.999`). The proof script asserts both sides: 0 to 90 must differ across `timeMs`, and 0 to 360 must not.

## SVG drops the raster options

`renderSvg` returns an SVG document string and takes no `format`, `quality`, `lossless`, `dithering`, `drawDebugBorder`, or `devicePixelRatio`. The types reject them, but at runtime they are ignored rather than refused, so a shared options object cast past the type checker renders an SVG and drops them without a word. Strip the raster keys instead of casting.
