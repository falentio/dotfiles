#!/usr/bin/env node
/**
 * Build one self-contained Colorfigures page.
 *
 *     node build.js figure.html OUT.html
 *
 * figure.html loads <script src="core.js"></script>; the engine (assets/core.js) is inlined in its place, and the
 * page features are added: zoom (pinch, ctrl/cmd + scroll, a - 100% + chip), notices on the figure, the See-through /
 * Labels switches placed for desktop and phone, labels as numbered badges with a list on a phone, a taller frame on a
 * phone, the slim game keypad on a phone, solid cast shadows in see-through, and a lighter filter while the figure
 * moves on touch screens.
 */

const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const HERE = __dirname;

const HEAD = `<style>.mcap{display:none!important}@media (max-width:560px){.stat .v{font-size:20px!important}.stats{align-items:flex-end}}@media (min-width:561px){.vset{top:4px!important}#stats{top:var(--vset-h,44px)!important}}</style><style>@media (max-width:560px){body > header{display:none}}</style><script>window.FIG_A = () => innerWidth <= 560 ? 1.1 : .75;</script><script>window.LBL_U = () => { if (innerWidth > 560) return 0; const s = document.getElementById("fig"); return s && s.clientWidth && s.viewBox.baseVal.width ? s.viewBox.baseVal.width / s.clientWidth : 0; };</script>`;

const TAIL = `<style>@media (max-width:560px),(pointer:coarse){#art{filter:none!important}.ctl:has(#wb){display:none!important}}</style><style>@media (max-width:560px){html body .kpad{width:100%;box-sizing:border-box;justify-content:space-between;gap:10px;margin:10px 0 0;padding:0;border:0;background:none;box-shadow:none}
html body .kpad .dp{display:flex;gap:8px}html body .kpad .hub{display:none}
html body .kpad .k{width:46px;height:42px;font-size:14px;border-radius:9px}
html body .kpad .go{width:auto;height:42px;padding:0 26px;border-radius:999px;flex-direction:row;font-size:13px;box-shadow:0 3px 0 var(--ink),inset 0 -4px 0 rgba(0,0,0,.18)}
html body .kpad .go small{display:none}html body .kpad .go.down{transform:translateY(2px);box-shadow:0 1px 0 var(--ink),inset 0 -2px 0 rgba(0,0,0,.18)}}</style>
<script>requestAnimationFrame(() => { const o = { "◀": 0, "▲": 1, "▼": 2, "▶": 3 }; for (const k of document.querySelectorAll(".kpad .k")) k.style.order = o[k.textContent] ?? 0; });</script><style>@media (max-width:560px){.vset{margin:8px 0 2px!important}}</style><script>requestAnimationFrame(() => { const v = document.querySelector(".vset"), s = document.getElementById("stats"), z = document.querySelector(".zwrap"); if (!v) return; if (z && z.parentNode === v.parentNode){ const kp = document.querySelector(".kpad"); if (kp && innerWidth <= 560){ z.after(kp); kp.after(v); } else z.after(v); } else if (s && s.parentNode) s.parentNode.insertBefore(v, s); });</script><script>(() => { const fit = () => { const fig = document.getElementById("fig"); if (!fig) return;
  fig.style.maxHeight = ""; if (innerWidth <= 560) return;
  const extra = document.documentElement.scrollHeight - fig.clientHeight, room = innerHeight - extra - 12;
  if (room < fig.clientHeight) fig.style.maxHeight = Math.max(320, room) + "px"; };
  addEventListener("load", () => requestAnimationFrame(fit)); addEventListener("resize", fit); setTimeout(fit, 400); })();</script><style>.zwrap{position:relative}.zwrap.on{overflow:hidden}@media (min-width:561px){.zwrap.on{overflow:visible}html.zoomed,html.zoomed body{overflow:hidden}}.zwrap #fig{transform-origin:0 0}
.zchip{position:absolute;right:2px;bottom:6px;display:flex;align-items:center;gap:2px;font:600 11px ui-monospace,Menlo,monospace;
 background:rgba(242,239,231,.88);border:1px solid rgba(35,30,22,.25);border-radius:999px;padding:2px;z-index:3;user-select:none}
.zchip button{all:unset;cursor:pointer;min-width:22px;height:22px;line-height:22px;text-align:center;border-radius:999px;color:#231e16}
.zchip button:hover{background:rgba(35,30,22,.08)}.zchip .zp{min-width:44px}</style>
<script>(() => { const fig = document.getElementById("fig"); if (!fig) return;
  const wrap = document.createElement("div"); wrap.className = "zwrap"; fig.parentNode.insertBefore(wrap, fig); wrap.appendChild(fig);
  const chip = document.createElement("div"); chip.className = "zchip";
  chip.innerHTML = '<button class="zm" aria-label="Zoom out">−</button><button class="zp" aria-label="Reset zoom">100%</button><button class="zi" aria-label="Zoom in">+</button>';
  wrap.appendChild(chip);
  let s = 1, tx = 0, ty = 0;
  const box = () => ({ w: fig.clientWidth, h: fig.clientHeight });
  const apply = () => { const { w, h } = box(); s = Math.min(5, Math.max(1, s));
    if (s <= 1.001){ s = 1; tx = ty = 0; } else { tx = Math.min(0, Math.max(w - w*s, tx)); ty = Math.min(0, Math.max(h - h*s, ty)); }
    fig.style.transform = s === 1 ? "" : \`translate(\${tx}px,\${ty}px) scale(\${s})\`; wrap.classList.toggle("on", s > 1); document.documentElement.classList.toggle("zoomed", s > 1);   /* desktop: nothing is cut off, the page just does not scroll while zoomed */
    chip.querySelector(".zp").textContent = Math.round(s*100) + "%"; grain(); };
  // the paper grain is noise in drawing units: zoomed, it would blow up into blotches, so its frequency rises with the
  // zoom and it stays the same fine grain on screen (the filter is rebuilt on resize, so this re-applies then too)
  const grain = () => { const fl = document.getElementById("hand"); if (!fl) return;
    const ts = [...fl.querySelectorAll("feTurbulence")]; if (!ts.length) return;
    const g = ts.find(t => t.getAttribute("result") === "n1") || ts.reduce((a, b) => parseFloat(b.getAttribute("baseFrequency")) > parseFloat(a.getAttribute("baseFrequency")) ? b : a);
    if (!g.dataset.f0) g.dataset.f0 = g.getAttribute("baseFrequency");
    const v = (parseFloat(g.dataset.f0) * s).toFixed(4); if (g.getAttribute("baseFrequency") !== v) g.setAttribute("baseFrequency", v); };
  const fd = document.getElementById("fdefs"); if (fd) new MutationObserver(() => grain()).observe(fd, { childList: true, subtree: true });
  const zoomAt = (k, px, py) => { const s2 = Math.min(5, Math.max(1, s*k)); tx = px - (px - tx)*s2/s; ty = py - (py - ty)*s2/s; s = s2; apply(); };
  const local = e => { const r = wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  wrap.addEventListener("wheel", e => {
    if (e.ctrlKey || e.metaKey){ e.preventDefault(); const [x, y] = local(e); zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY))*.006), x, y);   /* a wheel notch ~1.35x, a pinch stays smooth */ }
    else if (s > 1){ e.preventDefault(); tx -= e.deltaX; ty -= e.deltaY; apply(); } }, { passive: false });
  const center = () => { const { w, h } = box(); return [w/2, h/2]; };
  chip.querySelector(".zi").onclick = () => zoomAt(1.5, ...center());
  chip.querySelector(".zm").onclick = () => zoomAt(1/1.5, ...center());
  chip.querySelector(".zp").onclick = () => { s = 1; apply(); };
  chip.addEventListener("pointerdown", e => e.stopPropagation());
  // two fingers: pinch to zoom and move to pan; the figure's own one-finger turn waits while they are down
  const pts = new Map(); let pinch = null;
  const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x)/2, y: (a.y + b.y)/2 }; };
  wrap.addEventListener("pointerdown", e => { if (e.pointerType !== "touch") return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2){ pinch = two(); e.stopPropagation(); } }, true);
  wrap.addEventListener("pointermove", e => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2){ e.stopPropagation(); e.preventDefault(); const n = two(), r = wrap.getBoundingClientRect();
      tx += n.x - pinch.x; ty += n.y - pinch.y; zoomAt(n.d / pinch.d, n.x - r.left, n.y - r.top); pinch = n; } }, true);
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  wrap.addEventListener("pointerup", up, true); wrap.addEventListener("pointercancel", up, true);
  addEventListener("resize", apply);
})();</script><style>.toast{position:absolute!important;left:50%!important;right:auto!important;top:6%!important;bottom:auto!important;z-index:4!important;
  transform:translate(-50%,8px)!important;opacity:0!important;pointer-events:none!important;display:flex!important;align-items:center;gap:8px;
  width:max-content;max-width:min(86%,440px);white-space:normal!important;font:600 12.5px/1.35 ui-monospace,Menlo,monospace!important;
  letter-spacing:.01em!important;text-transform:none!important;color:#231e16!important;background:#fff1bf!important;
  border:1px solid rgba(35,30,22,.28)!important;border-radius:8px!important;box-shadow:0 8px 22px rgba(35,30,22,.16)!important;
  padding:7px 13px 7px 9px!important;transition:opacity .18s ease,transform .18s ease!important}
.toast::before{content:"!";flex:none;width:17px;height:17px;border-radius:50%;background:#231e16;color:#fff1bf;font:800 11px/17px ui-monospace,Menlo,monospace;text-align:center}
.toast.show{opacity:1!important;transform:translate(-50%,0)!important}</style>
<script>(() => { const cap = () => { const t = document.getElementById("toast"); if (!t) return; const s = t.textContent;
  if (s && s[0] !== s[0].toUpperCase()) t.textContent = s[0].toUpperCase() + s.slice(1); };
  let seen = null; const watch = () => { const t = document.getElementById("toast"); if (!t || t === seen) return; seen = t;
    const zw = document.querySelector(".zwrap"); if (zw && t.parentNode !== zw) zw.appendChild(t);   // sits on the figure itself
    new MutationObserver(cap).observe(t, { childList: true, characterData: true, subtree: true }); cap(); };
  watch(); const st = document.querySelector(".stage"); if (st) new MutationObserver(watch).observe(st, { childList: true }); })();</script><script>(() => { const fix = () => { const art = document.getElementById('art'); if (!art) return;
    for (const el of art.querySelectorAll('[fill="#41538f" i]')){ let top = null, a = el.parentElement;
      while (a && a !== art){ const o = a.getAttribute('opacity'); if (o !== null && +o < 1) top = a; a = a.parentElement; }
      if (top) top.parentNode.insertBefore(el, top); } };
  const go = () => { const art = document.getElementById('art'); if (!art) return setTimeout(go, 50); fix(); new MutationObserver(fix).observe(art, { childList: true }); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', go); else go(); })();</script><style>.lgd{display:none}@media (max-width:560px){html:not(.nolabels) .lgd.has{display:grid}}
.lgd{grid-template-columns:1fr 1fr;gap:2px 8px;margin:4px 0 12px;font:700 10.5px/1.25 ui-monospace,Menlo,monospace;letter-spacing:.03em;color:#231e16}
.lgd button{all:unset;display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px;border-radius:7px;-webkit-tap-highlight-color:transparent}
.lgd b{flex:none;min-width:17px;height:17px;padding:0 3px;box-sizing:border-box;border-radius:999px;border:1.2px solid #231e16;background:#fff4d6;text-align:center;font:800 10px/15px ui-monospace,Menlo,monospace}
.lgd .on b{background:var(--accent,#f4b829)}.lgd .sel{background:rgba(35,30,22,.09)}.lgd .sel b{background:#231e16;color:#fff4d6}</style>
<script>(() => { const fig = document.getElementById("fig"); if (!fig) return;
  const lg = document.createElement("div"); lg.className = "lgd"; const at = document.querySelector(".zwrap") || fig; at.parentNode.insertBefore(lg, at.nextSibling);
  const hs = document.createElement("style"); document.head.appendChild(hs);
  let sig = "", sel = 0, q = 0, names = "", num = new Map();
  // the figure's own numbers count every label it has ever drawn; here they are reset to 1, 2, 3... down the left
  // column then the right, each time the set of labels changes (so they hold still while the figure turns)
  const renum = () => { if (innerWidth > 560) return; const gs = [...fig.querySelectorAll(".tag[data-t]")];
    const key = gs.map(g => g.dataset.t).sort().join("|");
    if (key !== names){ names = key; num = new Map(); const vb = fig.viewBox.baseVal, cx = vb.x + vb.width/2;
      const at = g => { const r = g.querySelector("rect"); return r ? [+r.getAttribute("x") + r.getAttribute("width")/2, +r.getAttribute("y")] : [0, 0]; };
      gs.map(g => [g.dataset.t, ...at(g)]).sort((a, b) => ((a[1] > cx) - (b[1] > cx)) || a[2] - b[2]).forEach(([t]) => { if (!num.has(t)) num.set(t, num.size + 1); }); }
    for (const g of gs){ const n = String(num.get(g.dataset.t)); if (g.dataset.n !== n){ g.dataset.n = n; const t = g.querySelector("text"); if (t) t.textContent = n; } } };
  const mark = () => { hs.textContent = sel ? \`#fig .tag[data-n="\${sel}"] rect{fill:#231e16!important}#fig .tag[data-n="\${sel}"] text{fill:#fff4d6}#fig .tag[data-n="\${sel}"] path{stroke-width:2.4}\` : "";
    for (const x of lg.children) x.classList.toggle("sel", +x.dataset.n === sel); };
  const upd = () => { q = 0; const m = new Map();
    if (innerWidth <= 560) for (const g of fig.querySelectorAll(".tag[data-n]")){ const n = +g.dataset.n; if (!m.has(n)) m.set(n, [g.dataset.t, g.classList.contains("on")]); }
    const a = [...m].sort((x, y) => x[0] - y[0]), s = JSON.stringify(a); if (s === sig) return; sig = s;
    lg.classList.toggle("has", a.length > 0);
    lg.innerHTML = a.map(([n, [t, on]]) => \`<button data-n="\${n}" class="\${on ? "on" : ""}"><b>\${n}</b><span>\${t}</span></button>\`).join(""); mark(); };
  lg.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; sel = sel === +b.dataset.n ? 0 : +b.dataset.n; mark(); });
  new MutationObserver(() => { renum(); if (!q) q = requestAnimationFrame(upd); }).observe(fig, { childList: true, subtree: true }); renum();
  addEventListener("resize", () => { if (!q) q = requestAnimationFrame(upd); }); upd(); })();</script>`;

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: node build.js figure.html OUT.html");
  process.exit(1);
}

const core = readFileSync(join(HERE, "..", "assets", "core.js"), "utf8");
let page = readFileSync(src, "utf8");

const tag = /<script\s+src=["\'](?:\.\/)?core\.js["\']\s*>\s*<\/script>/.exec(page);
if (!tag) {
  console.error('no <script src="core.js"></script> in ' + src);
  process.exit(1);
}
page = page.slice(0, tag.index) + "<script>\n" + core + "\n</script>" + page.slice(tag.index + tag[0].length);

if (page.includes("</head>")) page = page.replace("</head>", HEAD + "</head>");
else page = HEAD + page;

const i = page.lastIndexOf("</body>");
page = i >= 0 ? page.slice(0, i) + TAIL + page.slice(i) : page + TAIL;

writeFileSync(out, page, "utf8");
console.log("wrote " + out);
