# takumi-js API map

Verified against `takumi-js@2.16.3`, `@takumi-rs/core@2.16.3`, `@takumi-rs/helpers@2.16.3` on 2026-10-18. Numbers and defaults move between releases, so re-run `scripts/verify-gotchas.tsx` after an upgrade before trusting one.

## Packages

| Package | What it is | Node engines |
| :-- | :-- | :-- |
| `takumi-js` | The entry point. Bundles both bindings and picks one per runtime. | `>=20.19` |
| `@takumi-rs/core` | Native (napi) renderer, Node and Bun only. | `>=18` |
| `@takumi-rs/wasm` | WebAssembly renderer for workerd, edge runtimes, Deno, browsers. | `>=20.19` |
| `@takumi-rs/helpers` | JSX and HTML to node tree, fonts, emoji, image prep. | `>=18` |
| `takumi-pdf` | Paged PDF output, separate install: `npm i takumi-pdf @takumi-rs/helpers`. | `>=20.19` |
| `@takumi-rs/image-response` | Retired shim. Installs `takumi-js`; import `ImageResponse` from `takumi-js/response`. | |

## Imports

| Import | Exports |
| :-- | :-- |
| `takumi-js` | `render`, `measure`, `renderSvg`, `renderAnimation`, `setGlyphCacheMaxBytes` |
| `takumi-js/node` | `Renderer`, `setGlyphCacheMaxBytes`. Re-exports `@takumi-rs/core`, so it forces the native backend. |
| `takumi-js/wasm` | `Renderer`, `init`, `initSync`, `setGlyphCacheMaxBytes`, `default`. Forces WebAssembly. |
| `takumi-js/response` | `ImageResponse` |
| `takumi-js/helpers` | `container`, `text`, `image`, `style`, `em`, `rem`, `vh`, `vw`, `fr`, `percentage`, `rgba`, `googleFonts`, `fontFromUrl`, `subsetFonts`, `prepareImages`, `collectCodepoints`, `defaultMaxFetchBytes`, `fetchOk`, `readBodyLimited` |
| `takumi-js/helpers/jsx` | `fromJsx`, `defaultStylePresets`, `Bitmap` |
| `takumi-js/helpers/html` | `fromHtml` |
| `takumi-js/helpers/emoji` | `extractEmojis` |

## Entry points

```ts
render(element: ReactNode | ReactElementLike | Node | string, options?: RenderOptions): Promise<Buffer | Uint8Array>
measure(element, options?): Promise<MeasuredNode>
renderSvg(element, options?): Promise<string>
renderAnimation(options: RenderAnimationOptions): Promise<Buffer | Uint8Array>
```

`render` routes the input by type: a node tree passes through, a string goes to `fromHtml`, anything else goes to `fromJsx`. Every input type accepts the same options.

## RenderOptions

| Option | Type | Meaning |
| :-- | :-- | :-- |
| `width`, `height` | `number` | Canvas size in device pixels. Omit both to size the canvas from content. |
| `format` | `"png" \| "jpeg" \| "webp" \| "ico" \| "raw"` | Encoder. Default `"png"`. |
| `quality` | `number` | `0` to `100`, default `75`. JPEG, and WebP unless `lossless`. |
| `lossless` | `boolean` | WebP only. Wins over `quality`. |
| `devicePixelRatio` | `number` | Device pixels per CSS pixel in layout. Does not resize an explicit canvas. |
| `fonts` | `FontLoader[] \| Promise<FontLoader[]>` | Bytes, a `{ name, data, weight, style, unicodeRange, generic }` descriptor, or a URL string fetched on demand. |
| `fontFamilies` | `string[]` | Fallback chain for this render. Defaults to every registered family in registration order. |
| `css` | `CssInput \| CssInput[]` | Stylesheet text, or rule objects (`{ selector, style }`, `{ keyframes, steps }`, `{ media }`, `{ layer }`, `{ supports }`). |
| `images` | `ImageLoader[] \| { sources?, fetch?, timeout?, maxBytes?, allowUrl?, cache?, fetchCache? }` | Pre-fetched image bytes, or the policy for fetching them. |
| `emoji` | `"twemoji" \| "blobmoji" \| "noto" \| "openmoji" \| "fluent" \| "fluentFlat" \| "from-font"` | Emoji provider. Default `"twemoji"`. |
| `timeMs` | `number` | Animation timeline position for a single frame. |
| `dithering` | `"none" \| "ordered-bayer"` | Ordered Bayer noise on gradients. |
| `drawDebugBorder` | `boolean` | Layout debug borders. |
| `lang` | `string` | BCP-47 default for the root. |
| `renderer` | `Renderer` | Render through your own renderer instead of the shared default. |
| `jsx` | `FromJsxOptions` | `{ defaultStyles, tailwindClassesProperty }` for the JSX path. |
| `signal` | `AbortSignal` | Cancels resource fetching. An already-aborted signal throws before work starts. |

`RenderSvgOptions` is the same table minus `format`, `quality`, `lossless`, `dithering`, `drawDebugBorder`, and `devicePixelRatio`, since SVG is vector output.

`RenderAnimationOptions` is `{ width, height, fps, format: "webp" | "apng" | "gif", scenes: [{ node: RenderInput, durationMs }], ... }` plus the same font, image, and CSS options.

## The Renderer class

```ts
const renderer = new Renderer({ cacheMaxBytes: 64 * 1024 * 1024 });
await renderer.registerFont({ name: "Inter", data: bytes, weight: 400 }); // Promise<RegisteredFamily[]>
await renderer.render(node, options);      // Buffer, node tree only, no JSX
await renderer.renderSvg(node, options);   // string
await renderer.measure(node, options);     // MeasuredNode
await renderer.renderAnimation(options);   // Buffer
```

`Renderer` takes a node tree, not JSX. Convert first with `fromJsx` or `fromHtml`, or use the managed `render` and pass the renderer as `options.renderer`. `cacheMaxBytes` is the shared budget for decoded images, rasterized SVG, and parsed stylesheets; `0` disables caching.

`setGlyphCacheMaxBytes(bytes)` sets a separate module-wide budget for resolved glyphs and glyph masks, default 8 MiB. Call it before the first render. Raise it for CJK pages, where a few thousand outlines overflow the default and re-rasterize.

## Node tree

```ts
type Node = ContainerNode | TextNode | ImageNode;

type ContainerNode = { type: "container"; children?: Node[]; /* + metadata */ };
type TextNode      = { type: "text"; text: string;           /* + metadata */ };
type ImageNode     = { type: "image"; src: string | Uint8Array | ArrayBuffer | RgbaImage; width?: number; height?: number; /* + metadata */ };

type NodeMetadata = { tagName?, className?, id?, dir?, lang?, attributes?, tw?, style?, preset? };
type RgbaImage = { width: number; height: number; data: Uint8Array | ArrayBuffer; premultiplied?: boolean };
```

`tw` on a node is a Tailwind class string; `style` is a React `CSSProperties` object. `helpers.container`, `helpers.text`, and `helpers.image` build the same shapes with types attached.

## Templates and helpers

```ts
fromJsx(element, { defaultStyles?, tailwindClassesProperty? }): Promise<{ node, css, stylesheets }>  // async
fromHtml(html: string): { node, css }                                                              // sync
```

Fonts: `googleFonts(options | families[])` returns subsets to hand to `fonts`; `fontFromUrl(url)` wraps a URL as a loader; `subsetFonts({ fonts, source })` drops subsets the content cannot use, without network.

Images: `prepareImages({ node })` resolves the images a tree needs; `extractEmojis(node, emojiType)` rewrites emoji text nodes to images.

Lazy values: `em`, `rem`, `vh`, `vw`, `fr`, `percentage`, `rgba`, `style`.

## measure

`measure` returns the laid-out tree without encoding: `{ width, height, transform, children, runs }`, where `runs` are `{ text, x, y, width, height }` for each text run. Lengths are device pixels, and each run positions relative to the content box of its owning node. Use it to size a canvas from content, or to assert that text fit before you render.
