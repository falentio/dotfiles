# Recipes

Shapes verified against `takumi-js@2.16.3`; each one runs as written. Option names and defaults live in [api.md](api.md), the traps in [pitfalls.md](pitfalls.md).

## Serve from a route

`ImageResponse` extends the web `Response`, so any runtime with `Request` and `Response` can return one, and the API matches `next/og`.

```tsx
import { ImageResponse } from "takumi-js/response";

export function GET(request: Request) {
  const title = new URL(request.url).searchParams.get("title") ?? "Untitled";

  return new ImageResponse(
    <div tw="w-full h-full grid place-items-center bg-white">
      <h1 tw="text-6xl font-bold">{title}</h1>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      onError: (error) => console.error("og render failed", error),
    },
  );
}
```

- Options are the render options plus `ResponseInit` (`status`, `headers`) and `onError`. `width` and `height` are required here, with no content sizing. A rejected render streams as an error response and calls `onError`.
- Keep the returned response object, not the bytes: `await response.ready` resolves when the stream finishes.
- For a request-scoped abort, pass `signal: request.signal`.
- A bundler that prunes optional dependencies reports `Cannot find native binding` or a `core-<hash>` module error: [Troubleshooting](https://takumi.kane.tw/docs/troubleshooting) has the fix per bundler.
- Framework wiring: [Next.js](https://takumi.kane.tw/docs/integration/nextjs), [Nuxt](https://takumi.kane.tw/docs/integration/nuxt), [SvelteKit](https://takumi.kane.tw/docs/integration/sveltekit), [Astro](https://takumi.kane.tw/docs/integration/astro), [Nitro](https://takumi.kane.tw/docs/integration/nitro), [TanStack Start](https://takumi.kane.tw/docs/integration/tanstack-start).

## Force the WebAssembly backend

`takumi-js` picks native on Node and Bun, WebAssembly on workerd and browsers. To exercise the edge path from a Node test, or to render in a runtime the resolver misses, import the wasm backend directly:

```tsx
import init, { Renderer } from "takumi-js/wasm";

await init();                 // once per process
const renderer = new Renderer();
const png = await renderer.render(node, { width: 1200, height: 630 });
```

The wasm build carries the same built-in face and the same option names, and it renders without `init()` too. WebP on wasm is always lossless and `quality` applies to JPEG only.

## Animation

`renderAnimation` samples a timeline of scenes into one file. Each scene is any render input and carries its own duration.

```tsx
import { renderAnimation } from "takumi-js";

const webp = await renderAnimation({
  width: 600,
  height: 400,
  fps: 30,
  format: "webp",          // "webp" | "apng" | "gif"
  scenes: [
    { durationMs: 500, node: <div tw="w-full h-full bg-red-500" /> },
    { durationMs: 500, node: <div tw="w-full h-full bg-blue-500" /> },
  ],
});
```

A single frame of a CSS animation comes from `render` plus `timeMs`:

```tsx
await render(<div tw="w-full h-full grid place-items-center"><div tw="w-16 h-16 bg-blue-500 animate-spin" /></div>, {
  width: 400,
  height: 400,
  timeMs: 250,
});
```

Keyframes can come from a Tailwind arbitrary value, from a `<style>` tag in the tree, or from the `css` option, where the object form is type-checked instead of parsed:

```tsx
await render(card, {
  width: 100,
  height: 100,
  timeMs: 500,
  css: {
    keyframes: "move",
    steps: [
      { offset: "from", style: { transform: "translateX(0)" } },
      { offset: "to", style: { transform: "translateX(120px)" } },
    ],
  },
});
```

Offsets are `from`, `to`, or `"<n>%"`. Presets `animate-spin`, `animate-ping`, `animate-pulse`, and `animate-bounce` ship in the Tailwind parser. A `rotate()` keyframe step stayed static on 2.16.3 while `translateX()` animated ([details](pitfalls.md#animation-is-a-timeline-not-a-loop)).

For video, render frames with `format: "raw"` and feed RGBA buffers to ffmpeg: [Keyframe Animation](https://takumi.kane.tw/docs/keyframe-animation).

## SVG and measure

```tsx
import { renderSvg, measure } from "takumi-js";

const svg = await renderSvg(card, { width: 1200, height: 630 });   // string, no raster options
const { width, height, children, runs } = await measure(card);     // layout, no encoding
```

`measure` returns the laid-out tree: each node's box and transform, plus a `runs` entry per text run with its own `x`, `y`, `width`, and `height`. Lengths are device pixels, and a run's `x` and `y` are relative to the content box of the node that holds it. Use it to size a canvas from content, to check that a title fits before painting, or to place a highlight behind a specific line.

## Tailwind and CSS

The `tw` prop runs Takumi's own Tailwind parser, so it needs no build step, no PostCSS, and no network. Arbitrary values work (`w-[42px]`, `bg-[linear-gradient(...)]`, `animate-[move_1s_linear_infinite]`), and `_` becomes a space inside brackets.

An inline `style` beats a `tw` utility for the same property. A rule from the `css` option also beat the equivalent `tw` utility in the measured case, so rather than leaning on a precedence order, give a property to exactly one of the three.

```tsx
await render(
  <div className="card" tw="p-4" style={{ padding: 8 }}>...</div>,
  { width: 400, height: 200, css: [".card { background: #fff; border-radius: 12px; }"] },
);
```

A bare `div` is block, not flex. Every layout that satori templates wrote with an explicit `display: flex` still needs it here. An unknown property name in a style object is dropped silently; a known property with an unparsable value rejects the render and names the property.

A bundler can compile Tailwind as well: that stylesheet arrives through `css` and coexists with `tw`. Preflight stays off until a stylesheet imports `"tailwindcss"`, and utilities land in the last layer. Design tokens, the bundler setup, and where Takumi differs from Tailwind: [Styling](https://takumi.kane.tw/docs/styling) and the [CSS reference](https://takumi.kane.tw/docs/reference).

## Images and emoji

```tsx
await render(card, {
  width: 1200,
  height: 630,
  images: {
    sources: [{ src: avatarUrl, data: avatarBytes }],     // keyed by the exact src string
    allowUrl: (url) => url.startsWith("https://cdn.example/"),
    timeout: 10_000,
    cache: "auto",
  },
});
```

A `src` with no prefetched entry is fetched during the render (30 s timeout, 32 MiB body cap, 8192x8192 decode). `data:` URLs are decoded inline. Raw RGBA in JSX goes through the `Bitmap` component from `takumi-js/helpers/jsx`; a node tree carries it as `{ type: "image", src: { width, height, data } }`.

Emoji glyphs come from a CDN unless you say otherwise: `emoji: "from-font"` with an emoji font, or a prefetched image per emoji. Providers: `twemoji` (default), `blobmoji`, `noto`, `openmoji`, `fluent`, `fluentFlat`. Details: [Images & Emoji](https://takumi.kane.tw/docs/load-images).

## Reuse across requests

One `Renderer` per process, registered fonts on it, and the same bytes come out of every identical call. In a server that is the difference between a warm glyph cache and rebuilding it per request.

```tsx
import { render } from "takumi-js";
import { Renderer } from "takumi-js/node";

const renderer = new Renderer({ cacheMaxBytes: 256 * 1024 * 1024 });
await renderer.registerFont({ name: "Inter", data: interBytes });

export const png = (node: unknown) => render(node as never, { width: 1200, height: 630, renderer });
```

Key the HTTP cache on the inputs you already have (title, theme, width) rather than hashing the image, and return `cache-control` with an immutable lifetime from the route.

## Coming from satori or next/og

- `satori()` becomes `render()` for bytes, or `renderSvg()` for vector output.
- An `ImageResponse` import moves from `next/og` to `takumi-js/response`.
- A bare `div` is block, so explicit flex styles stay needed, and the rendered output will not match satori pixel for pixel.
- Puppeteer screenshots lose page scripts, and anything outside the supported CSS matrix; check the [CSS reference](https://takumi.kane.tw/docs/reference) before assuming a property carries over.

[Comparison to Satori](https://takumi.kane.tw/docs/comparison-to-satori) has the full migration table.

## Paged PDF

Invoices and reports are a separate package with its own renderer: `npm i takumi-pdf @takumi-rs/helpers`, then `render(node, { size, margin, header, footer, pages })`. A4 by default, with page numbers, outline, and PDF/A options. Start at [PDF](https://takumi.kane.tw/docs/pdf).
