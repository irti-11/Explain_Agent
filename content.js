const SYSTEM_PROMPT =
  "You are a senior engineer and a great teacher. A student is learning technology " +
  "(programming, AI, computer systems, electronics, web) and selects text while reading. " +
  "Explain it like an expert who respects the student's time. " +
  "Rules: use simple words but stay technically correct. English only. " +
  "No greetings, no filler, no questions back. " +
  "Format: short **bold** labels and short lines starting with '-'. No tables, no headings, no emojis. " +
  "Use the page title and surrounding text to understand the topic, so the meaning fits this context. " +
  "Adapt to the selection type:\n" +
  "TERM (1-3 words): give the meaning in plain words, what it means in THIS context, " +
  "how it works or why it matters (2-3 lines), a tiny example (code or real-life), " +
  "and 2-3 related terms.\n" +
  "SENTENCE: say what it means in simple words, explain every hard term inside it, " +
  "and say why it matters.\n" +
  "PARAGRAPH: give the big idea in one line, then explain step by step, " +
  "list the key terms, then a one-line summary.\n" +
  "CODE: say what it does, go through it line by line, and mention one common mistake.\n" +
  "If the user asks a follow-up, answer it directly and in the same expert style.";

const CARD_W = 360;
const MS = 54; // mascot size
const MOODS = [
  "happy",
  "think",
  "listen",
  "sad",
  "excited",
  "surprised",
  "wink",
  "tongue",
  "sleepy",
];

let messages = [];
let host = null;
let root = null;
let api = null;
let pinned = false;
let hideTimer = null;
let lookX = 0;
let lookY = 0;
let rafPending = false;
let currentText = "";
let lastMove = Date.now();

/* ---------- helpers ---------- */

function detectKind(text) {
  const looksLikeCode =
    /[{};=<>]|=>|\(\)|\bfunction\b|\bdef\b|\bclass\b|\bimport\b|#include/.test(
      text,
    ) &&
    (text.includes("\n") || /[{};]/.test(text));
  if (looksLikeCode) return "CODE";
  const words = text.split(/\s+/).length;
  if (words <= 3) return "TERM";
  if (words <= 40 && !text.includes("\n")) return "SENTENCE";
  return "PARAGRAPH";
}

function getContext() {
  const sel = window.getSelection();
  let around = "";
  try {
    const el =
      sel.anchorNode.nodeType === 1
        ? sel.anchorNode
        : sel.anchorNode.parentElement;
    around = (el.closest("p, li, pre, div, section") || el).innerText.slice(
      0,
      700,
    );
  } catch (e) {}
  return { title: document.title, around };
}

function md(src) {
  let s = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(
    /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g,
    (_, c) => "<pre>" + c.trim() + "</pre>",
  );
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/^\s*[-*]\s+/gm, "• ");
  s = s.replace(/^#{1,4}\s+(.*)$/gm, "<b>$1</b>");
  return s;
}

/* ---------- white-space finder: where are the words on this page? ---------- */

function collectObstacles() {
  const out = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim())
          return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const t = p.tagName;
        if (
          t === "SCRIPT" ||
          t === "STYLE" ||
          t === "NOSCRIPT" ||
          t === "TEXTAREA"
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const range = document.createRange();
  let n;
  let count = 0;
  while ((n = walker.nextNode()) && count++ < 8000) {
    range.selectNodeContents(n);
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width < 2 || r.height < 2) continue;
      if (
        r.bottom < -100 ||
        r.top > vh + 100 ||
        r.right < -100 ||
        r.left > vw + 100
      )
        continue;
      out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
  }

  const media = document.querySelectorAll(
    "img,video,canvas,iframe,button,input,textarea,select,pre",
  );
  for (let i = 0; i < media.length; i++) {
    const r = media[i].getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  return out;
}

function freeAt(x, y, O, C) {
  const pad = 6;
  const l = x - pad;
  const t = y - pad;
  const r = x + MS + pad;
  const b = y + MS + pad;
  if (l < 0 || t < 0 || r > window.innerWidth || b > window.innerHeight)
    return false;
  if (C && l < C.r + 2 && r > C.l - 2 && t < C.b + 2 && b > C.t - 2)
    return false;
  for (let i = 0; i < O.length; i++) {
    const o = O[i];
    if (l < o.r && r > o.l && t < o.b && b > o.t) return false;
  }
  return true;
}

function candidates(C) {
  const out = [];
  const step = 36;
  for (const gap of [10, 36, 70]) {
    for (let y = C.t - MS; y <= C.b; y += step) {
      out.push({ x: C.l - gap - MS, y: y, gap: gap });
      out.push({ x: C.r + gap, y: y, gap: gap });
    }
    for (let x = C.l - MS; x <= C.r; x += step) {
      out.push({ x: x, y: C.t - gap - MS, gap: gap });
      out.push({ x: x, y: C.b + gap, gap: gap });
    }
  }
  return out;
}

/* ---------- eyes follow the mouse ---------- */

function look() {
  if (!root) return;
  const m = root.getElementById("mascot");
  const face = root.getElementById("face");
  const hair = root.getElementById("hair");
  if (!m || !face) return;
  const r = m.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dx = lookX - cx;
  const dy = lookY - cy;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 160);
  face.style.transform =
    "translate(" + (dx / d) * 6 * k + "px," + (dy / d) * 5 * k + "px)";
  if (hair) hair.style.transform = "rotate(" + (dx / d) * 12 * k + "deg)";
}

document.addEventListener(
  "mousemove",
  (e) => {
    lookX = e.clientX;
    lookY = e.clientY;
    lastMove = Date.now();
    if (api) api.wake();
    if (host && !rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        look();
      });
    }
  },
  { passive: true },
);

window.addEventListener(
  "scroll",
  () => {
    if (api) api.placeSoon();
  },
  { passive: true },
);
window.addEventListener("resize", () => {
  if (api) api.placeSoon();
});

/* ---------- open / close ---------- */

function closeUI(immediate) {
  if (!host) return;
  const h = host;
  const r = root;
  host = null;
  root = null;
  api = null;
  currentText = "";
  if (immediate) {
    h.remove();
    return;
  }
  const w = r.getElementById("wrap");
  if (w) w.classList.add("out");
  setTimeout(() => h.remove(), 200);
}

function openAgent(rect, text) {
  const ctx = getContext();
  closeUI(true);
  currentText = text;

  const px = window.scrollX;
  const py = window.scrollY;
  let left = rect.left + px;
  left = Math.max(
    px + 10,
    Math.min(left, px + window.innerWidth - CARD_W - 16),
  );

  const spaceBelow = window.innerHeight - rect.bottom;
  const above = spaceBelow < 480 && rect.top > 480;
  const top = above ? rect.top + py - 8 : rect.bottom + py + 8;

  host = document.createElement("div");
  host.style.cssText =
    "position:absolute;z-index:2147483647;left:" +
    left +
    "px;top:" +
    top +
    "px;" +
    (above ? "transform:translateY(-100%);" : "");
  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  *{box-sizing:border-box}
  .wrap{width:${CARD_W}px;position:relative;
        font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b2f;
        transform-origin:30px 20px;
        animation:pop .3s cubic-bezier(.34,1.56,.64,1) both}
  .wrap.out{animation:popout .18s ease-in both}
  @keyframes pop{from{opacity:0;transform:scale(.6) translateY(8px)}to{opacity:1;transform:none}}
  @keyframes popout{to{opacity:0;transform:scale(.7) translateY(6px)}}

  /* mascot: calm, glides to white space, moods change face + small motion */
  .mascot{position:absolute;left:16px;top:-64px;width:54px;height:54px;z-index:3;cursor:pointer;
          transform-origin:50% 90%;
          transition:left .75s cubic-bezier(.4,0,.2,1),top .75s cubic-bezier(.4,0,.2,1);
          filter:drop-shadow(0 6px 10px rgba(110,90,220,.25));
          animation:float 5s ease-in-out infinite}
  .mascot svg{display:block;overflow:visible}
  .mascot.hop svg{animation:hop .5s ease-out}
  .mascot.think{animation:sway 2.6s ease-in-out infinite}
  .mascot.excited{animation:bounce .6s ease-in-out 2}
  .mascot.surprised{animation:jolt .45s ease-out 1}
  .mascot.sleepy{animation:breathe 3.6s ease-in-out infinite}
  .mascot.sad{animation:slump 4s ease-in-out infinite}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes hop{0%{transform:translateY(0)}40%{transform:translateY(-10px)}100%{transform:translateY(0)}}
  @keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
  @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  @keyframes jolt{0%{transform:scale(1)}35%{transform:scale(1.12)}100%{transform:scale(1)}}
  @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
  @keyframes slump{0%,100%{transform:translateY(2px)}50%{transform:translateY(3px)}}
  @media (prefers-reduced-motion:reduce){.mascot,.mascot.think,.mascot.excited,.mascot.sleepy,.mascot.sad{animation:none}}

  /* face parts */
  #face{transition:transform .12s ease-out}
  #hair{transform-origin:32px 14px;transition:transform .15s ease-out}
  .eyes{transition:transform .25s ease}
  .mascot.think .eyes{transform:translate(1.5px,-2.5px)}
  .mascot.listen .eyes{transform:translate(0,2.5px)}
  .eye{transform-box:fill-box;transform-origin:center;animation:blink 4.5s infinite}
  @keyframes blink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.1)}}
  .st{stroke:#1b1b2f;stroke-width:2.4;fill:none;stroke-linecap:round;stroke-linejoin:round}
  .fl{fill:#1b1b2f}
  .ev{display:none}
  .blush{opacity:0;transition:opacity .3s}
  .mascot.excited .blush,.mascot.tongue .blush,.mascot.wink .blush{opacity:.55}
  .mascot.happy .blush{opacity:.25}

  /* eyes per mood */
  .mascot.happy .e-open,.mascot.think .e-open,.mascot.listen .e-open,.mascot.sad .e-open{display:block}
  .mascot.surprised .e-wide{display:block}
  .mascot.excited .e-joy{display:block}
  .mascot.sleepy .e-closed{display:block}
  .mascot.tongue .e-squint{display:block}
  .mascot.wink .e-wink{display:block}
  /* mouths per mood */
  .mascot.happy .m-smile,.mascot.listen .m-smile{display:block}
  .mascot.wink .m-smirk{display:block}
  .mascot.think .m-o{display:block}
  .mascot.surprised .m-wow{display:block}
  .mascot.excited .m-big{display:block}
  .mascot.tongue .m-tongue{display:block}
  .mascot.sad .m-frown{display:block}
  .mascot.sleepy .m-tiny{display:block}
  /* brows, sparkles, zzz */
  .mascot.sad .brow-sad{display:block}
  .mascot.think .brow-think{display:block}
  .mascot.excited .sparkles{display:block}
  .mascot.sleepy .zzz{display:block}
  .sparkles circle{animation:twinkle .6s ease-in-out infinite alternate;transform-box:fill-box;transform-origin:center}
  .sparkles circle:nth-child(2){animation-delay:.25s}
  @keyframes twinkle{from{transform:scale(.4);opacity:.4}to{transform:scale(1.2);opacity:1}}
  .zzz text{font:700 9px system-ui,sans-serif;fill:#6d66c9;animation:zfloat 2s ease-in-out infinite}
  .zzz text:nth-child(2){animation-delay:.8s;font-size:7px}
  @keyframes zfloat{0%{transform:translate(0,4px);opacity:0}40%{opacity:1}100%{transform:translate(4px,-6px);opacity:0}}

  /* color per mood */
  #g1,#g2,#g3{transition:stop-color .5s}
  .mascot.happy #g1,.mascot.listen #g1{stop-color:#7DD3FC}
  .mascot.happy #g2,.mascot.listen #g2{stop-color:#A78BFA}
  .mascot.happy #g3,.mascot.listen #g3{stop-color:#F9A8D4}
  .mascot.think #g1{stop-color:#67E8F9}
  .mascot.think #g2{stop-color:#60A5FA}
  .mascot.think #g3{stop-color:#A78BFA}
  .mascot.excited #g1{stop-color:#FDE047}
  .mascot.excited #g2{stop-color:#FDBA74}
  .mascot.excited #g3{stop-color:#F9A8D4}
  .mascot.wink #g1{stop-color:#F9A8D4}
  .mascot.wink #g2{stop-color:#E879F9}
  .mascot.wink #g3{stop-color:#A78BFA}
  .mascot.tongue #g1{stop-color:#86EFAC}
  .mascot.tongue #g2{stop-color:#5EEAD4}
  .mascot.tongue #g3{stop-color:#7DD3FC}
  .mascot.surprised #g1{stop-color:#FCA5A5}
  .mascot.surprised #g2{stop-color:#FDBA74}
  .mascot.surprised #g3{stop-color:#FDE68A}
  .mascot.sleepy #g1{stop-color:#C7D2FE}
  .mascot.sleepy #g2{stop-color:#DDD6FE}
  .mascot.sleepy #g3{stop-color:#E9D5FF}
  .mascot.sad #g1{stop-color:#BFDBFE}
  .mascot.sad #g2{stop-color:#A5B4FC}
  .mascot.sad #g3{stop-color:#CBD5E1}

  /* card */
  .card{background:rgba(255,255,255,.96);
        backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
        border:1px solid rgba(120,110,200,.14);border-radius:22px;
        box-shadow:0 12px 40px rgba(60,50,120,.2);overflow:hidden}
  .log{max-height:min(46vh,340px);overflow-y:auto;padding:16px 12px 4px 18px;
       scrollbar-width:thin;scrollbar-color:#d6d1f5 transparent}
  .log::-webkit-scrollbar{width:6px}
  .log::-webkit-scrollbar-track{background:transparent;margin:8px 0}
  .log::-webkit-scrollbar-thumb{background:#d6d1f5;border-radius:6px}
  .log::-webkit-scrollbar-thumb:hover{background:#b9b1ef}
  .log::-webkit-scrollbar-button{display:none;width:0;height:0}
  .msg{margin:0 0 10px;word-break:break-word}
  .bot{white-space:pre-wrap}
  .bot pre{background:#f6f5fb;border-radius:10px;padding:8px 10px;overflow-x:auto;
           white-space:pre;font:12.5px/1.5 ui-monospace,Consolas,monospace;margin:6px 0}
  .bot code{background:#f1effe;border-radius:5px;padding:1px 5px;
            font:12.5px ui-monospace,Consolas,monospace}
  .me{width:fit-content;max-width:90%;margin-left:auto;background:#f1effe;color:#4338ca;
      border-radius:14px;padding:6px 12px}
  .note{color:#6b6a80;font-size:13px}
  .dots{display:flex;gap:5px;padding:6px 2px}
  .dots i{width:7px;height:7px;border-radius:50%;background:#a99cf0;
          animation:dot 1s infinite ease-in-out}
  .dots i:nth-child(2){animation-delay:.15s}
  .dots i:nth-child(3){animation-delay:.3s}
  @keyframes dot{0%,80%,100%{transform:scale(.6);opacity:.5}40%{transform:scale(1);opacity:1}}

  .bar{display:flex;align-items:center;gap:8px;margin:8px 12px 12px;
       padding:6px 6px 6px 16px;background:#fff;border:1px solid #e6e4f2;
       border-radius:999px;box-shadow:0 2px 10px rgba(80,70,160,.08)}
  input{flex:1;min-width:0;border:0;outline:0;background:transparent;
        font:inherit;color:#1b1b2f}
  input::placeholder{color:#9a98ad}
  button{width:34px;height:34px;border-radius:50%;border:0;background:#111;color:#fff;
         cursor:pointer;display:grid;place-items:center;transition:transform .15s,opacity .15s}
  button:hover{transform:scale(1.08)}
  button:disabled{opacity:.35;cursor:default;transform:none}
</style>

<div class="wrap" id="wrap">
  <div class="mascot happy" id="mascot" title="Click me">
    <svg viewBox="0 0 64 64" width="54" height="54">
      <defs>
        <linearGradient id="orbG" x1="0" y1="0" x2="1" y2="1">
          <stop id="g1" offset="0" stop-color="#7DD3FC"/>
          <stop id="g2" offset=".5" stop-color="#A78BFA"/>
          <stop id="g3" offset="1" stop-color="#F9A8D4"/>
        </linearGradient>
        <radialGradient id="orbS" cx=".3" cy=".25" r=".8">
          <stop offset="0" stop-color="#fff" stop-opacity=".75"/>
          <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="32" cy="35" r="25" fill="url(#orbG)"/>
      <circle cx="32" cy="35" r="25" fill="url(#orbS)"/>
      <g id="hair">
        <path class="st" d="M26 11 q3 -7 7 -1 q3 -5 6 1" style="stroke-width:2.6"/>
      </g>

      <g id="face">
        <g class="blush">
          <ellipse cx="16.5" cy="41" rx="4" ry="2.6" fill="#fb7185"/>
          <ellipse cx="47.5" cy="41" rx="4" ry="2.6" fill="#fb7185"/>
        </g>

        <g class="eyes">
          <g class="ev e-open">
            <ellipse class="eye fl" cx="24" cy="32" rx="2.6" ry="3.4"/>
            <ellipse class="eye fl" cx="40" cy="32" rx="2.6" ry="3.4"/>
          </g>
          <g class="ev e-wide">
            <ellipse class="fl" cx="24" cy="31.5" rx="3.4" ry="4.6"/>
            <ellipse class="fl" cx="40" cy="31.5" rx="3.4" ry="4.6"/>
            <circle cx="25.2" cy="29.8" r="1.1" fill="#fff"/>
            <circle cx="41.2" cy="29.8" r="1.1" fill="#fff"/>
          </g>
          <g class="ev e-joy">
            <path class="st" d="M20 34 q4 -6 8 0"/>
            <path class="st" d="M36 34 q4 -6 8 0"/>
          </g>
          <g class="ev e-closed">
            <path class="st" d="M20 32 q4 4 8 0"/>
            <path class="st" d="M36 32 q4 4 8 0"/>
          </g>
          <g class="ev e-squint">
            <path class="st" d="M20 29 l7 3.5 l-7 3.5"/>
            <path class="st" d="M44 29 l-7 3.5 l7 3.5"/>
          </g>
          <g class="ev e-wink">
            <ellipse class="fl" cx="24" cy="32" rx="2.6" ry="3.4"/>
            <path class="st" d="M36 34 q4 -5 8 0"/>
          </g>
        </g>

        <g class="ev brow-sad">
          <path class="st" d="M19 27.5 l9 -3.5" style="stroke-width:2"/>
          <path class="st" d="M36 24 l9 3.5" style="stroke-width:2"/>
        </g>
        <g class="ev brow-think">
          <path class="st" d="M36 23.5 q5 -4 9 -1" style="stroke-width:2"/>
        </g>

        <path class="ev m-smile st" d="M25 42 q7 7 14 0"/>
        <path class="ev m-smirk st" d="M24 42 q8 7 16 -1"/>
        <ellipse class="ev m-o fl" cx="32" cy="44" rx="2.4" ry="2.8"/>
        <ellipse class="ev m-wow fl" cx="32" cy="44.5" rx="3.4" ry="4.4"/>
        <g class="ev m-big">
          <path class="fl" d="M23 39.5 q9 14 18 0 z"/>
          <ellipse cx="32" cy="44.6" rx="4" ry="2.2" fill="#fb7185"/>
        </g>
        <g class="ev m-tongue">
          <path d="M28 43.5 v4 a4 4 0 0 0 8 0 v-4 z" fill="#f472b6"/>
          <path class="st" d="M24 42 q8 7 16 0"/>
        </g>
        <path class="ev m-frown st" d="M25 46 q7 -6 14 0"/>
        <path class="ev m-tiny st" d="M29 44 q3 2 6 0"/>
      </g>

      <g class="ev sparkles">
        <circle cx="52" cy="14" r="2.4" fill="#fff"/>
        <circle cx="10" cy="20" r="1.8" fill="#fff"/>
      </g>
      <g class="ev zzz">
        <text x="48" y="14">z</text>
        <text x="55" y="8">z</text>
      </g>
    </svg>
  </div>

  <div class="card">
    <div class="log" id="log"></div>
    <div class="bar">
      <input id="inp" type="text" placeholder="Ask a follow-up..." autocomplete="off"/>
      <button id="send" aria-label="Send">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7"/>
        </svg>
      </button>
    </div>
  </div>
</div>`;
  document.body.appendChild(host);

  const my = host;
  const wrapEl = root.getElementById("wrap");
  const log = root.getElementById("log");
  const inp = root.getElementById("inp");
  const send = root.getElementById("send");
  const mascot = root.getElementById("mascot");

  let busy = false;
  let base = "happy";
  let flashing = false;
  let flashT = null;
  let sleeping = false;
  let lastWink = Date.now();
  let curL = null;
  let curT = null;
  let placeT = null;
  let tick = 0;

  /* ----- smart placement: go where there are no words ----- */
  function place() {
    if (host !== my) return;
    const hr = my.getBoundingClientRect();
    const C = { l: hr.left, t: hr.top, r: hr.left + CARD_W, b: hr.bottom };
    const O = collectObstacles();

    // stay still if the current spot is still free
    if (curL !== null && freeAt(hr.left + curL, hr.top + curT, O, C)) return;

    let best = null;
    let bestScore = Infinity;
    const list = candidates(C);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!freeAt(c.x, c.y, O, C)) continue;
      const s =
        c.gap + 0.12 * Math.hypot(c.x + MS / 2 - lookX, c.y + MS / 2 - lookY);
      if (s < bestScore) {
        bestScore = s;
        best = c;
      }
    }

    let nl;
    let nt;
    if (best) {
      nl = best.x - hr.left;
      nt = best.y - hr.top;
    } else {
      // page is full of words: sit on the card's top corner, covering the least
      nl = CARD_W - MS + 6;
      nt = -MS * 0.55;
    }
    if (curL !== null && Math.abs(nl - curL) < 2 && Math.abs(nt - curT) < 2)
      return;

    if (curL === null) {
      mascot.style.transition = "none";
      mascot.style.left = nl + "px";
      mascot.style.top = nt + "px";
      void mascot.offsetWidth;
      mascot.style.transition = "";
    } else {
      mascot.style.left = nl + "px";
      mascot.style.top = nt + "px";
    }
    curL = nl;
    curT = nt;
    setTimeout(look, 800);
  }

  function placeSoon() {
    clearTimeout(placeT);
    placeT = setTimeout(place, 300);
  }

  const ro = new ResizeObserver(placeSoon);
  ro.observe(wrapEl);

  /* ----- mood engine ----- */
  function render(m) {
    mascot.classList.remove(...MOODS);
    mascot.classList.add(m);
  }

  function setBase(m) {
    base = m;
    sleeping = false;
    if (!flashing) render(m);
  }

  function flash(m, ms) {
    flashing = true;
    sleeping = false;
    render(m);
    clearTimeout(flashT);
    flashT = setTimeout(() => {
      flashing = false;
      if (host === my) render(sleeping ? "sleepy" : base);
    }, ms);
  }

  api = {
    wake() {
      if (sleeping) {
        sleeping = false;
        flash("surprised", 800);
      }
    },
    placeSoon: placeSoon,
  };

  const life = setInterval(() => {
    if (host !== my) {
      clearInterval(life);
      ro.disconnect();
      clearTimeout(placeT);
      return;
    }
    tick++;
    if (tick % 3 === 0 && !document.hidden) place(); // re-check every ~4.5s
    if (busy || flashing || sleeping) return;
    const now = Date.now();
    if (now - lastMove > 25000) {
      sleeping = true;
      render("sleepy");
    } else if (base === "happy" && now - lastWink > 11000) {
      lastWink = now;
      flash("wink", 900);
    }
  }, 1500);

  mascot.addEventListener("click", () => {
    flash("tongue", 1300);
    mascot.classList.add("hop");
    setTimeout(() => mascot.classList.remove("hop"), 600);
  });

  /* ----- chat ----- */
  function addMsg(html, cls) {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function addDots() {
    return addMsg('<div class="dots"><i></i><i></i><i></i></div>', "");
  }

  function ask() {
    busy = true;
    send.disabled = true;
    setBase("think");
    const loading = addDots();

    function done() {
      busy = false;
      send.disabled = false;
      loading.remove();
    }

    try {
      chrome.runtime.sendMessage({ type: "ASK", messages }, (res) => {
        if (host !== my) return;
        done();

        if (chrome.runtime.lastError) {
          setBase("sad");
          addMsg(
            "The extension was reloaded. Refresh this page and select again.",
            "bot note",
          );
          return;
        }
        if (!res || res.error) {
          setBase("sad");
          addMsg(
            "Error: " + (res && res.error ? res.error : "no response"),
            "bot note",
          );
          return;
        }
        setBase("happy");
        flash("excited", 1500);
        addMsg(md(res.reply), "bot");
        messages.push({ role: "assistant", content: res.reply });
      });
    } catch (e) {
      done();
      setBase("sad");
      addMsg(
        "The extension was reloaded. Refresh this page and select again.",
        "bot note",
      );
    }
  }

  function submit() {
    const v = inp.value.trim();
    if (!v || busy) return;
    inp.value = "";
    addMsg(md(v), "me");
    messages.push({ role: "user", content: v });
    ask();
  }

  send.onclick = submit;
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submit();
  });
  inp.addEventListener("input", () => {
    lastMove = Date.now();
    if (!busy) flash("listen", 1600);
  });

  messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Page title: " +
        ctx.title +
        "\nText around the selection: " +
        ctx.around +
        "\n\nSelection type: " +
        detectKind(text) +
        '\nSelected text: "' +
        text +
        '"',
    },
  ];

  place();
  look();
  ask();
  flash("surprised", 700);
}

/* ---------- selection events ---------- */

document.addEventListener(
  "mousedown",
  (e) => {
    pinned = !!(host && e.composedPath().includes(host));
  },
  true,
);

document.addEventListener("mouseup", (e) => {
  if (host && e.composedPath().includes(host)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text || text.length > 3000) return;

    const a = document.activeElement;
    if (
      a &&
      (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)
    )
      return;
    if (host && text === currentText) return;

    let rect = sel.rangeCount
      ? sel.getRangeAt(0).getBoundingClientRect()
      : null;
    if (!rect || (!rect.width && !rect.height)) {
      rect = {
        left: e.clientX,
        right: e.clientX,
        top: e.clientY,
        bottom: e.clientY + 10,
      };
    }
    lookX = (rect.left + rect.right) / 2;
    lookY = (rect.top + rect.bottom) / 2;
    lastMove = Date.now();
    openAgent(rect, text);
  }, 10);
});

document.addEventListener("selectionchange", () => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!host || pinned) return;
    if (!window.getSelection().toString().trim()) closeUI(false);
  }, 150);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeUI(false);
});
