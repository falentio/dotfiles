---
name: takumi
description: Render images from JSX, HTML, and CSS with Takumi (takumi-js), without a headless browser. Use for OG images, social cards, banners, and favicons; for PNG, JPEG, WebP, ICO, SVG, or animated WebP, GIF, and APNG output on Node, Bun, or an edge runtime; when returning an image from a route with ImageResponse; when porting a satori or next/og template; or when a Takumi render comes out blank, clipped, or missing glyphs.
---

# Takumi

`takumi-js` turns JSX, an HTML string, or a node tree into image bytes. It parses CSS and Tailwind in Rust, in process: native on Node and Bun, WebAssembly on edge runtimes and browsers. There is no browser and no screenshot.

```bash
npm i takumi-js
```

## Render an image

Five decisions, in this order. Each step ends on something you can check.

**1. Pick the import for the runtime.** `takumi-js` resolves the backend by itself: native on Node and Bun, WebAssembly on workerd, edge runtimes, and browsers. Import from `takumi-js` unless you are forcing a backend for a test (`takumi-js/wasm`) or dropping the wrapper for the raw native renderer (`takumi-js/node`). Done when the import matches the runtime, on Node 20.19 or newer.

**2. Build the input.** `render` accepts a JSX element, an HTML string, or a node tree, and routes by type. JSX needs a compiler: Bun runs `.tsx` directly, Node needs a build step first. Style with the `tw` prop (built-in Tailwind parser, no build step), a `style` object, or a `css` string of stylesheet text. A bare `div` is block, so a centered card needs `display: flex` or `grid`.

```tsx
import { render } from "takumi-js";
import { writeFile } from "node:fs/promises";

const png = await render(
  <div tw="w-full h-full grid place-items-center bg-linear-to-b from-blue-100 to-red-50">
    <h1 tw="text-6xl font-bold">Hello Takumi</h1>
  </div>,
  { width: 1200, height: 630 },
);

await writeFile("og.png", png);
```

**3. Size the canvas.** `width` and `height` are device pixels and are final. Omit both to size the canvas from content. `devicePixelRatio` converts CSS lengths into those device pixels, so at `2` a CSS-pixel value draws twice as large: enlarge the canvas yourself to export at 2x, or content overflows and clips.

```tsx
await render(card, { width: 2400, height: 1260, devicePixelRatio: 2 });
```

Done when a rendered file opens at the intended pixel size.

**4. Load the fonts.** Nothing reads the machine's installed fonts. One built-in face (Geist, Latin, weights 300 to 800) covers plain Latin; every other script draws identical boxes until you pass `fonts`. Emoji glyphs come from a CDN by default, so an air-gapped render also needs `emoji: "from-font"`. Load Google families with `googleFonts`, or pass font file bytes.

```tsx
import { readFile } from "node:fs/promises";
import { googleFonts } from "takumi-js/helpers";

const fonts = await googleFonts([{ name: "Inter", weight: "400..700" }]);
await render(card, { width: 1200, height: 630, fonts });
await render(card, { width, height, fonts: [await readFile("./brand.woff2")] });
```

Pass `fonts` on every render: registered fonts stay in that process's default fallback chain. Done when text paints in the intended face, including every script, numeral, and icon the design uses.

**5. Encode, then prove.** `format` picks the encoder and defaults to `png`. `quality` (0 to 100, default 75) applies to `jpeg` and lossy `webp`; `renderSvg` returns vector output instead of bytes. Done when you have rendered the real file and looked at it, not when the call resolved: a blank or clipped image is a success as far as the API is concerned, and `render(123)` renders happily.

## Route to a branch

- **Return the image from a route, or run on edge**: [recipes.md](references/recipes.md#serve-from-a-route).
- **Animation, animated GIF, or keyframes**: [recipes.md](references/recipes.md#animation).
- **Vector SVG, or layout numbers before you paint**: [recipes.md](references/recipes.md#svg-and-measure).
- **Tailwind config, design tokens, or a CSS subset question**: [recipes.md](references/recipes.md#tailwind-and-css) and the [styling reference](https://takumi.kane.tw/docs/styling).
- **Fonts in depth**: subsetting, variable axes, generic families, per-render chains, and emoji glyphs: [fonts.md](references/fonts.md).
- **Exact option names, types, and defaults**: [api.md](references/api.md).
- **Something renders wrong, or an upgrade changed behavior**: [pitfalls.md](references/pitfalls.md), then run the proof script below.

## Docs

Canonical pages, in the order a render needs them: [Introduction](https://takumi.kane.tw/docs/), [Styling](https://takumi.kane.tw/docs/styling), [Typography & Fonts](https://takumi.kane.tw/docs/typography-and-fonts), [Images & Emoji](https://takumi.kane.tw/docs/load-images), [Output Formats](https://takumi.kane.tw/docs/output-formats), [Keyframe Animation](https://takumi.kane.tw/docs/keyframe-animation), [ImageResponse](https://takumi.kane.tw/docs/image-response), [Helpers](https://takumi.kane.tw/docs/helpers), [measure()](https://takumi.kane.tw/docs/measure-api), [CSS reference](https://takumi.kane.tw/docs/reference), [Performance](https://takumi.kane.tw/docs/performance-and-optimization), [Troubleshooting](https://takumi.kane.tw/docs/troubleshooting), [vs Satori](https://takumi.kane.tw/docs/comparison-to-satori), [integration recipes](https://takumi.kane.tw/docs/integration/nextjs).

## Prove the behavior

```bash
bun .agents/skills/takumi/scripts/verify-gotchas.tsx --root <project with takumi-js installed>
```

Every rule in `pitfalls.md` has a check here, alongside the surface in `api.md`, all measured against the installed version. Run it after an upgrade, and when a render contradicts a rule here. It exits non-zero on the first failed rule and prints the measured value beside each check.
