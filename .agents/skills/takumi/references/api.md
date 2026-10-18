# takumi-js API map

Verified against `takumi-js@2.16.3`, `@takumi-rs/core@2.16.3`, `@takumi-rs/helpers@2.16.3` on 2026-10-18. `Source` says where a row comes from: `measured` was re-run against the installed packages by `../scripts/verify-gotchas.tsx`, `typings` is transcribed from `@takumi-rs/core/index.d.ts` and was not. Types live in that file; this page carries the names, defaults, and traps. Re-run the script after an upgrade before trusting a number.

## Packages

`takumi-js` installs both backends and picks one per runtime, native on Node and Bun and WebAssembly elsewhere. `@takumi-rs/core` is the native renderer, Node and Bun only, and `@takumi-rs/wasm` the WebAssembly one for workerd, edge runtimes, Deno, and browsers. `@takumi-rs/helpers` turns JSX and HTML into node trees and loads fonts, images, and emoji. `takumi-pdf` adds paged PDF output as a separate install (`npm i takumi-pdf @takumi-rs/helpers`), and `@takumi-rs/image-response` is a retired shim whose `ImageResponse` now lives at `takumi-js/response`. Node engines: 20.19 or newer for `takumi-js` and `@takumi-rs/wasm`, 18 for `@takumi-rs/core` and `@takumi-rs/helpers`.

## Imports

| Import | What is there |
| :-- | :-- |
| `takumi-js` | `render`, `measure`, `renderSvg`, `renderAnimation`, `setGlyphCacheMaxBytes` |
| `takumi-js/node` | `Renderer`, `setGlyphCacheMaxBytes`; forces the native backend. |
| `takumi-js/wasm` | `Renderer`, `init`, `initSync`, `setGlyphCacheMaxBytes`, `default`; forces WebAssembly. |
| `takumi-js/wasm/no-init` | `@takumi-rs/wasm` re-exported, for a runtime that skips `init()`. |
| `takumi-js/wasm-url` | Default-exports the binary URL for a bundler to resolve. |
| `takumi-js/response` | `ImageResponse`, also as `default`. |
| `takumi-js/helpers` | `googleFonts`, `fontFromUrl`, `subsetFonts`, `collectCodepoints`, `prepareImages`, `container`, `text`, `image`, the lazy lengths (`em`, `rem`, `vh`, `vw`, `fr`, `percentage`, `rgba`), and the fetch limits (`defaultMaxFetchBytes`, `fetchOk`, `readBodyLimited`). |
| `takumi-js/helpers/jsx` | `fromJsx`, `defaultStylePresets`, `Bitmap` |
| `takumi-js/helpers/html` | `fromHtml` |
| `takumi-js/helpers/emoji` | `extractEmojis` |
| `@takumi-rs/helpers/renderer` | `FontRegistry`, `prepareRenderInput`, `resolveImageLoaders` |

`render` routes its input by type: a node tree passes through, a string goes to `fromHtml`, anything else to `fromJsx`. `fromJsx` is async and returns `{ node, css, stylesheets }`; `fromHtml` is sync and returns `{ node, css }`.

## Options

| Option | Meaning | Source |
| :-- | :-- | :-- |
| `width`, `height` | Canvas size in device pixels; omit both to size from content. | measured |
| `format` | Encoder, default `"png"`. | measured |
| `quality` | `0` to `100`, default `75`; JPEG, and WebP unless `lossless`. | measured |
| `lossless` | WebP only, on by default, and it wins over `quality`. | measured |
| `devicePixelRatio` | Device pixels per CSS pixel during layout. | measured |
| `fonts` | Bytes, a descriptor (`{ name, data, weight, style, unicodeRange, generic }`), a URL string fetched on demand, or a promise of those. | typings |
| `fontFamilies` | Fallback chain for this render; defaults to every registered family in registration order. | measured |
| `css` | Stylesheet text, or rule objects (`{ selector, style }`, `{ keyframes, steps }`, `{ media }`, `{ layer }`, `{ supports }`). | measured |
| `images` | Pre-fetched `{ src, data }` entries, or the fetch policy (`sources`, `fetch`, `timeout`, `maxBytes`, `allowUrl`, `cache`, `fetchCache`). | measured |
| `emoji` | Provider: `twemoji` (default), `blobmoji`, `noto`, `openmoji`, `fluent`, `fluentFlat`, `from-font`. | measured |
| `timeMs` | Timeline position for a single frame. | measured |
| `dithering` | `"none"` or `"ordered-bayer"` gradient noise. | typings |
| `drawDebugBorder` | Layout debug borders. | typings |
| `lang` | BCP-47 default for the root. | typings |
| `renderer` | Render through your own `Renderer`. | measured |
| `jsx` | `{ defaultStyles, tailwindClassesProperty }` for the JSX path. | typings |
| `signal` | Cancels resource fetching. | measured |

`RenderSvgOptions` is the same minus `format`, `quality`, `lossless`, `dithering`, `drawDebugBorder`, and `devicePixelRatio`, since SVG is vector output. `RenderAnimationOptions` is `{ width, height, fps, format: "webp" | "apng" | "gif", scenes: [{ node, durationMs }] }` plus the font, image, and CSS options.

Deprecated but accepted, and marked for removal in v3: `stylesheets` (which prints `takumi: the stylesheets option is deprecated, use css instead.`) and `keyframes`, both replaced by `css` or one `{ keyframes, steps }` entry, and `dithering: "floyd-steinberg"` as an alias of `"ordered-bayer"`. An upstream `context7.json` rule still sends readers to `stylesheets` for a compiled Tailwind stylesheet, so a Context7 lookup can land on the deprecated spelling.

## The Renderer class

```ts
const renderer = new Renderer({ cacheMaxBytes: 64 * 1024 * 1024 });
await renderer.registerFont({ name: "Inter", data: bytes, weight: 400 }); // Promise<RegisteredFamily[]>
await renderer.render(node, options);   // Buffer, a node tree only
```

`Renderer` takes a node tree, not JSX: convert first with `fromJsx` or `fromHtml`, or use the managed `render` and pass the renderer as `options.renderer`. A string throws `InvalidArg, invalid type: string "<div>x</div>", expected a node` even though the published signature reads `Node | string`; run HTML through `fromHtml` first. `cacheMaxBytes` is the shared budget for decoded images, rasterized SVG, and parsed stylesheets, default 64 MiB, and `0` disables caching.

`setGlyphCacheMaxBytes(bytes)` sets a separate module-wide budget for resolved glyphs and glyph masks, default 8 MiB. Call it before the first render; a CJK page overflows that default and re-rasterizes.

## Node tree and measure

```ts
type Node = ContainerNode | TextNode | ImageNode;
// container: { type: "container", children?: Node[] } + metadata (tagName, className, tw, style, ...)
// text:      { type: "text", text: string } + metadata
// image:     { type: "image", src: string | Uint8Array | ArrayBuffer | RgbaImage, width?, height? }
```

`helpers.container`, `helpers.text`, and `helpers.image` build the same shapes with types attached.

`measure` returns the laid-out tree without encoding: `{ width, height, transform, children, runs }`, with one `runs` entry (`{ text, x, y, width, height }`) per text run. Lengths are device pixels, and each run positions relative to the content box of its owning node. Use it to size a canvas from content, or to assert that text fit before you render.
