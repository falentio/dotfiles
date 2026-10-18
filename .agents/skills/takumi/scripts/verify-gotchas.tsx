#!/usr/bin/env bun
// Proves the rules in ../references/pitfalls.md against an installed takumi-js.
//   bun <this file> --root <project with takumi-js installed>   (default: cwd)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd();
const resolve = (spec) => Bun.resolveSync(spec, root);

const { render, renderSvg, renderAnimation, measure } = await import(resolve("takumi-js"));
const { Renderer } = await import(resolve("takumi-js/node"));
const { ImageResponse } = await import(resolve("takumi-js/response"));
const { container, text } = await import(resolve("takumi-js/helpers"));
const { fromJsx } = await import(resolve("takumi-js/helpers/jsx"));
const { fromHtml } = await import(resolve("takumi-js/helpers/html"));

const packageVersion = (await import(resolve("takumi-js/package.json"), { with: { type: "json" } })).default.version;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log((pass ? "PASS  " : "FAIL  ") + name + (detail ? "  ::  " + detail : ""));
};
const report = (name, detail) => console.log("INFO  " + name + (detail ? "  ::  " + detail : ""));
const probe = async (fn) => {
  try { return { value: await fn() }; } catch (error) { return { error: String(error && error.message ? error.message : error).split("\n")[0] }; }
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const magic = (b) => ({ png: b[0] === 0x89 && b[1] === 0x50, jpeg: b[0] === 0xff && b[1] === 0xd8, webp: b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57, gif: b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 });
const pngSize = (b) => ({ w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] });
const inked = (raw) => { let n = 0; for (let i = 0; i < raw.length; i += 4) if (raw[i] < 240 || raw[i + 1] < 240 || raw[i + 2] < 240) n++; return n; };
const reds = (raw) => { let n = 0; for (let i = 0; i < raw.length; i += 4) if (raw[i] > 200 && raw[i + 1] < 60 && raw[i + 2] < 60) n++; return n; };
const masked = (raw) => { let n = 0; for (let i = 0; i < raw.length; i += 4) if (raw[i] < 40 && raw[i + 3] > 200) n++; return n; };

const fontPath = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/System/Library/Fonts/Helvetica.ttc", "C:/Windows/Fonts/arial.ttf"].find(existsSync);
const localFont = fontPath ? { name: "Verify Face", data: new Uint8Array(readFileSync(fontPath)) } : null;
const card = <div tw="w-full h-full grid place-items-center bg-blue-500"><h1 tw="text-6xl font-bold text-white">Hello</h1></div>;
const white = { display: "flex", width: "100%", height: "100%", background: "#fff" };

console.log("takumi-js " + packageVersion + "  root " + root + (fontPath ? "  font " + fontPath : "  no local font found"));

const png = await render(card, { width: 1200, height: 630 });
check("render(jsx + tw) returns a PNG of the requested size", magic(png).png && pngSize(png).w === 1200 && pngSize(png).h === 630, pngSize(png).w + "x" + pngSize(png).h + " " + png.length + "B");

const blue = await render(<div tw="w-full h-full bg-blue-500" />, { width: 8, height: 8, format: "raw" });
check("tw classes paint without any provider", blue[2] > 150 && blue[0] < 120, "rgba " + blue.slice(0, 4).join(","));

const fromTree = await render(container({ style: white, children: [text("tree", { fontSize: 32, color: "#000" })] }), { width: 200, height: 60 });
check("a helpers node tree renders", magic(fromTree).png, fromTree.length + "B");

const fromMarkup = await render("<div style='display:flex;width:100%;height:100%;background:#f00'>x</div>", { width: 64, height: 32 });
check("an HTML string renders", magic(fromMarkup).png && pngSize(fromMarkup).w === 64, fromMarkup.length + "B");

const jsxResult = await fromJsx({ type: "div", props: { children: "x" } });
check("fromJsx returns { node, css }", "node" in jsxResult && "css" in jsxResult, Object.keys(jsxResult).join(","));
check("fromHtml is synchronous", typeof fromHtml("<div>x</div>").node === "object", "");

const formats = { png: await render(card, { width: 40, height: 40 }), jpeg: await render(card, { width: 40, height: 40, format: "jpeg", quality: 80 }), webp: await render(card, { width: 40, height: 40, format: "webp", lossless: true }), ico: await render(card, { width: 40, height: 40, format: "ico" }) };
const raw = await render(card, { width: 40, height: 40, format: "raw" });
check("png, jpeg, webp, ico, raw all encode", magic(formats.png).png && magic(formats.jpeg).jpeg && magic(formats.webp).webp && formats.ico[2] === 1 && raw.length === 40 * 40 * 4, "raw " + raw.length + "B");

const jpegDefault = await render(card, { width: 240, height: 126, format: "jpeg" });
const jpeg75 = await render(card, { width: 240, height: 126, format: "jpeg", quality: 75 });
const jpeg80 = await render(card, { width: 240, height: 126, format: "jpeg", quality: 80 });
check("jpeg defaults to quality 75", hash(jpegDefault) === hash(jpeg75) && hash(jpeg75) !== hash(jpeg80), "default == 75, != 80");

const webpDefault = await render(card, { width: 240, height: 126, format: "webp" });
const webpLossless = await render(card, { width: 240, height: 126, format: "webp", lossless: true, quality: 10 });
check("WebP is lossless by default and lossless ignores quality", hash(webpDefault) === hash(webpLossless), "default == lossless:true, quality:10");

const svg = await renderSvg(card, { width: 200, height: 100 });
check("renderSvg returns an svg document", svg.startsWith("<svg") && svg.includes("</svg>"), svg.length + " chars");
const svgRaster = await probe(() => renderSvg(card, { width: 40, height: 40, format: "png" } as never));
check("renderSvg ignores a raster option at runtime instead of rejecting it", !svgRaster.error && String(svgRaster.value).startsWith("<svg"), svgRaster.error || "svg returned, format dropped");

const animation = await renderAnimation({ width: 60, height: 40, fps: 10, format: "webp", scenes: [{ node: <div tw="w-full h-full bg-red-500" />, durationMs: 200 }] });
const gif = await renderAnimation({ width: 60, height: 40, fps: 10, format: "gif", scenes: [{ node: <div tw="w-full h-full bg-red-500" />, durationMs: 200 }] });
check("renderAnimation encodes webp and gif", magic(animation).webp && magic(gif).gif, animation.length + "B / " + gif.length + "B");

const explicitDpr = await render(card, { width: 300, height: 150, devicePixelRatio: 2 });
check("devicePixelRatio leaves an explicit canvas size alone", pngSize(explicitDpr).w === 300 && pngSize(explicitDpr).h === 150, pngSize(explicitDpr).w + "x" + pngSize(explicitDpr).h);
const autoDpr = await render(<div tw="w-[300px] h-[150px] bg-black" />, { devicePixelRatio: 2 });
check("devicePixelRatio scales a content-sized canvas", pngSize(autoDpr).w === 600 && pngSize(autoDpr).h === 300, pngSize(autoDpr).w + "x" + pngSize(autoDpr).h);
const targeted = await render(<div tw="w-[20px] h-[20px] bg-black" />, { width: 100, height: 50, devicePixelRatio: 2, format: "raw" });
check("devicePixelRatio draws CSS lengths at 2x inside that canvas", masked(targeted) === 1600, masked(targeted) + " device px");

const noFonts = await render(<div style={white}><span style={{ fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw" });
check("Latin text paints with no fonts registered", inked(noFonts) > 100, inked(noFonts) + " inked px");

const inkHash = async (value) => hash(await render(<div style={white}><span style={{ fontSize: 40 }}>{value}</span></div>, { width: 240, height: 80, format: "raw", fontFamilies: [] }));
const latinA = await inkHash("Abcd");
const latinB = await inkHash("Wxyz");
check("the built-in face paints Latin", latinA !== latinB, latinA + " vs " + latinB);
const cjkA = await inkHash("漢字");
const cjkB = await inkHash("山田");
check("characters the built-in face cannot cover render as identical boxes, not glyphs", cjkA === cjkB, cjkA + " vs " + cjkB);

const legacy = await render(<div style={white}><span style={{ fontFamily: "Verify Face", fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw", images: { fetch: () => Promise.reject(new Error("offline-probe")) } });
check("an unreachable twemoji CDN does not break plain Latin text", legacy.length === 200 * 60 * 4, "no fetch needed");

if (localFont) {
  const withFont = await render(<div style={white}><span style={{ fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw", fonts: [localFont] });
  const afterFont = await render(<div style={white}><span style={{ fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw" });
  check("a font passed to one render stays registered for the next", hash(withFont) === hash(afterFont), hash(withFont));
  const isolated = await render(<div style={white}><span style={{ fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw", fontFamilies: ["NoSuchFamily"] });
  check("fontFamilies keeps that font out of the chain", inked(isolated) > 100 && hash(isolated) !== hash(withFont), inked(isolated) + " inked px");
  const inked2 = await render(<div style={white}><span style={{ fontFamily: "Verify Face", fontSize: 40 }}>HHHH</span></div>, { width: 200, height: 60, format: "raw", fonts: [localFont] });
  check("a loaded font file paints glyphs", inked(inked2) > 100, inked(inked2) + " inked px");
const cyrillicBefore = await inkHash("Привет");
const cyrillicAfter = await render(<div style={white}><span style={{ fontSize: 40 }}>Абвгде</span></div>, { width: 240, height: 80, format: "raw", fonts: [localFont] });
check("a font with Cyrillic coverage turns its boxes into glyphs", cyrillicBefore !== hash(cyrillicAfter), hash(cyrillicAfter));
} else {
  check("font persistence and file loading", true, "SKIPPED: no local font file on this machine");
}

const offlineEmoji = await probe(() => render(<div style={white}><span style={{ fontSize: 40 }}>hi 😀</span></div>, { width: 200, height: 100, format: "raw", images: { fetch: () => Promise.reject(new Error("offline-probe")) } }));
check("emoji pulls glyphs off the network by default", Boolean(offlineEmoji.error) && offlineEmoji.error.includes("offline-probe"), offlineEmoji.error || "no throw");
const fromFont = await probe(() => render(<div style={white}><span style={{ fontSize: 40 }}>hi 😀</span></div>, { width: 200, height: 100, format: "raw", emoji: "from-font", images: { fetch: () => Promise.reject(new Error("offline-probe")) } }));
check("emoji: \"from-font\" renders offline", !fromFont.error && fromFont.value.length === 200 * 100 * 4, fromFont.error || "rendered");

const sprite = await render(<div tw="w-[4px] h-[4px] bg-red-600" />, { width: 4, height: 4 });
const spriteElement = <div style={white}><img src="https://cdn.invalid/sprite.png" width={20} height={20} /></div>;
const prefetched = await render(spriteElement, { width: 20, height: 20, format: "raw", images: [{ src: "https://cdn.invalid/sprite.png", data: sprite }] });
check("images[] serves a matching src from bytes, with no request", reds(prefetched) === 400, reds(prefetched) + " red px");
const mismatched = await probe(() => render(spriteElement, { width: 20, height: 20, format: "raw", images: [{ src: "https://other.invalid/sprite.png", data: sprite }] }));
check("a src with no prefetched entry falls through to the network", Boolean(mismatched.error) && mismatched.error.includes("ENOTFOUND"), mismatched.error || "no throw");
const blocked = await probe(() => render(spriteElement, { width: 20, height: 20, format: "raw", images: { allowUrl: () => false } }));
check("images.allowUrl blocks a URL with a named error", Boolean(blocked.error) && blocked.error.includes("allowUrl"), blocked.error || "no throw");

const rgbaPixels = new Uint8Array(4 * 4 * 4);
for (let i = 0; i < 16; i++) { rgbaPixels[i * 4] = 220; rgbaPixels[i * 4 + 3] = 255; }
const rgbaNode = container({ style: white, children: [{ type: "image", src: { width: 4, height: 4, data: rgbaPixels }, width: 20, height: 20 }] });
const rgbaRender = await render(rgbaNode, { width: 20, height: 20, format: "raw" });
check("a node tree takes raw RGBA pixels as an image src", reds(rgbaRender) === 400, reds(rgbaRender) + " red px");

const zero = await probe(() => render(card, { width: 0, height: 0 }));
const huge = await probe(() => render(card, { width: 20000, height: 20000 }));
check("the canvas bounds are 1 to 64 megapixels", Boolean(zero.error && zero.error.includes("Invalid viewport")) && Boolean(huge.error && huge.error.includes("Invalid viewport")), zero.error + " | " + huge.error);
const badFormat = await probe(() => render(card, { width: 10, height: 10, format: "bmp" }));
check("an unknown format throws an enum error", Boolean(badFormat.error) && badFormat.error.includes("OutputFormat"), badFormat.error || "no throw");
const coerced = await probe(() => render(123, { width: 10, height: 10 }));
check("a non-element input renders instead of throwing", !coerced.error, coerced.error || "rendered " + coerced.value.length + "B");
const aborted = new AbortController();
aborted.abort();
const abort = await probe(() => render(card, { width: 10, height: 10, signal: aborted.signal }));
check("an aborted signal stops the render", Boolean(abort.error) && abort.error.toLowerCase().includes("abort"), abort.error || "no throw");

const measured = await measure(<span tw="text-xl">Hello</span>);
check("measure reports layout without encoding", measured.width > 0 && measured.height > 0, measured.width.toFixed(1) + "x" + measured.height.toFixed(1));

const shared = new Renderer();
if (localFont) await shared.registerFont(localFont);
const viaRenderer = { width: 240, height: 80, renderer: shared };
const first = await render(<div style={white}><span style={{ fontSize: 32 }}>Reuse</span></div>, viaRenderer);
const second = await render(<div style={white}><span style={{ fontSize: 32 }}>Reuse</span></div>, viaRenderer);
check("the same Renderer renders byte-identical output", hash(first) === hash(second), hash(first));

const spin = (timeMs) => render(<div tw="w-full h-full bg-white"><div tw="w-10 h-10 bg-black animate-spin" /></div>, { width: 100, height: 100, format: "raw", timeMs });
check("timeMs moves an animated frame", hash(await spin(0)) !== hash(await spin(125)), "t0 vs t125");
const slideSheet = "@keyframes slide { from { transform: translateX(0); } to { transform: translateX(120px); } } .slide { animation: slide 1s linear infinite; }";
const slideFrame = (timeMs) => render(<div style={white}><div className="slide" style={{ width: 40, height: 40, background: "#000" }} /></div>, { width: 140, height: 60, format: "raw", timeMs, css: [slideSheet] });
check("stylesheet keyframes drive timeMs", hash(await slideFrame(0)) !== hash(await slideFrame(125)), "translateX at 0 and 125 ms");

const turnSheet = "@keyframes turn { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } .turn { animation: turn 1s linear infinite; }";
const turnFrame = (timeMs) => render(<div style={white}><div className="turn" style={{ width: 40, height: 40, background: "#000" }} /></div>, { width: 140, height: 60, format: "raw", timeMs, css: [turnSheet] });
check("a 0 to 360 degree rotate keyframe is a zero-degree step", hash(await turnFrame(0)) === hash(await turnFrame(250)), "identical at 0 and 250 ms");
const quarterSheet = "@keyframes quarter { from { transform: rotate(0deg); } to { transform: rotate(90deg); } } .quarter { animation: quarter 1s linear infinite; }";
const quarterFrame = (timeMs) => render(<div style={white}><div className="quarter" style={{ width: 40, height: 40, background: "#000" }} /></div>, { width: 140, height: 60, format: "raw", timeMs, css: [quarterSheet] });
check("a sub-180 degree rotate keyframe animates", hash(await quarterFrame(0)) !== hash(await quarterFrame(125)), "0 vs 125 ms");
check("the built-in animate-spin preset moves a frame", hash(await spin(0)) !== hash(await spin(125)), "0 vs 125 ms");

const response = new ImageResponse(card, { width: 200, height: 100, headers: { "cache-control": "public, max-age=60" } });
const served = new Uint8Array(await response.arrayBuffer());
check("ImageResponse is a web Response carrying a PNG", response.status === 200 && response.headers.get("content-type") === "image/png" && response.headers.get("cache-control") === "public, max-age=60" && magic(served).png, served.length + "B");
await response.ready;

const installedFamily = await measure(<span style={{ fontFamily: "DejaVu Sans", fontSize: 40 }}>HHHH</span>);
const nonsenseFamily = await measure(<span style={{ fontFamily: "Verify Nonexistent Face", fontSize: 40 }}>HHHH</span>);
check("a system font name resolves like a nonsense family", installedFamily.width === nonsenseFamily.width, installedFamily.width.toFixed(1) + " vs " + nonsenseFamily.width.toFixed(1));

const unknownProp = await probe(() => render(<div style={{ definitelyNotACssProp: "x", width: 40, height: 20 }} />, { width: 40, height: 20 }));
check("an unknown CSS property name is dropped silently", !unknownProp.error, unknownProp.error || "rendered");
const badValue = await probe(() => render(<div style={{ display: "not-a-display", width: 40, height: 20 }} />, { width: 40, height: 20 }));
check("a known CSS property with a bad value throws with its name", Boolean(badValue.error) && badValue.error.includes("display"), badValue.error || "no throw");

const sticky = await probe(() => render(<div style={{ position: "sticky", width: 20, height: 10 }} />, { width: 40, height: 20, format: "raw" }));
check("position: sticky is rejected by name", Boolean(sticky.error) && sticky.error.includes("invalid value for position"), sticky.error || "no throw");
const mediaPixel = async (css) => (await render(<div style={white}><div className="m" style={{ width: 40, height: 20 }} /></div>, { width: 40, height: 20, format: "raw", css: [css] })).slice(0, 4).join(",");
const darkMedia = await mediaPixel("@media (prefers-color-scheme: dark) { .m { background: #000; } }");
const narrowMedia = await mediaPixel("@media (min-width: 10px) { .m { background: #123456; } }");
check("prefers-color-scheme never applies while a matching min-width block does", darkMedia === "255,255,255,255" && narrowMedia === "18,52,86,255", darkMedia + " vs " + narrowMedia);

const styled = await render(<div className="prec" tw="w-full h-full bg-blue-500" style={{ background: "#00ff00" }} />, { width: 10, height: 10, format: "raw", css: [".prec { background: #ff0000; }"] });
check("an inline style beats a tw utility", styled[1] === 255 && styled[0] === 0, "rgba " + styled.slice(0, 4).join(","));
const twRhymes = await render(<div className="prec2" tw="w-full h-full bg-blue-500" />, { width: 10, height: 10, format: "raw", css: [".prec2 { background: #ff0000; }"] });
report("a css-option rule beats the equivalent tw utility on 2.16.3", twRhymes[0] === 255 && twRhymes[2] === 0);

const noTime = await render(<div tw="w-full h-full bg-white"><div tw="w-10 h-10 bg-black animate-spin" /></div>, { width: 100, height: 100, format: "raw" });
check("omitting timeMs is the same as timeMs: 0", hash(noTime) === hash(await spin(0)), "t0");

const { setGlyphCacheMaxBytes } = await import(resolve("takumi-js"));
const glyph = await probe(() => { setGlyphCacheMaxBytes(16 * 1024 * 1024); return Promise.resolve(new Uint8Array(1)); });
check("setGlyphCacheMaxBytes takes a byte budget", !glyph.error, glyph.error || "16 MiB");

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(results.length + " checks, " + failed.length + " failed" + (failed.length ? ": " + failed.map((r) => r.name).join("; ") : ""));
process.exit(failed.length ? 1 : 0);
