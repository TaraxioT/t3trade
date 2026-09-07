# T3 Trade System Atlas — Binding Style Guide

Every section page in `site/` MUST be built from this guide. It exists so that a dozen
independent agents produce one coherent site. Copy the blocks exactly; add page-specific
CSS below the base, never inside it.

Design read: an engineering documentation microsite for a supervised trading platform,
in a "night trading terminal" language: deep blue-black surfaces, chalk text, and
semantic market colors (bid green, ask red, caution amber, data-flow cyan). The
signature motif is the animated flow ribbon: an SVG pipeline whose dashed edges carry
traveling pulses, one instance per page, each showing that page's real data path.

Dials: variance 7, motion 8, density 5. The site is dark-only, one theme, locked.

## 1. Page base (copy verbatim into every page)

Every page opens with this exact head and base CSS. Only `<title>`, `<meta name="description">`,
the active nav link class, and page-specific CSS/JS below the marked line may change.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PAGE TITLE · T3 Trade System Atlas</title>
    <meta name="description" content="ONE PLAIN SENTENCE ABOUT THIS PAGE" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/fonts/fonts.css" />
    <style>
      :root {
        --void: #060a12; /* page base */
        --panel: #0b1120; /* raised surface */
        --panel-2: #0e1526; /* second raise */
        --edge: rgba(148, 163, 199, 0.13);
        --edge-strong: rgba(148, 163, 199, 0.24);
        --chalk: #d8e0ec; /* primary text */
        --slate: #8a97ad; /* secondary text */
        --dim: #5c6b84; /* tertiary text */
        --bid: #2bd576; /* success, long, confirmed */
        --ask: #ff5d6c; /* risk, refusal, halt */
        --amber: #ffb224; /* caution, limits, unknown */
        --flow: #56ccf2; /* data in motion, links, events */
        --flow-soft: rgba(86, 204, 242, 0.14);
        --font-body: "IBM Plex Sans", system-ui, sans-serif;
        --font-mono: "IBM Plex Mono", ui-monospace, monospace;
        --font-display: "Archivo", system-ui, sans-serif;
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      html {
        scroll-behavior: smooth;
      }
      @media (prefers-reduced-motion: reduce) {
        html {
          scroll-behavior: auto;
        }
      }
      body {
        background: var(--void);
        color: var(--chalk);
        font-family: var(--font-body);
        font-size: 16.5px;
        line-height: 1.65;
        -webkit-font-smoothing: antialiased;
      }
      ::selection {
        background: rgba(86, 204, 242, 0.28);
      }
      a {
        color: var(--flow);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      :focus-visible {
        outline: 2px solid var(--flow);
        outline-offset: 2px;
        border-radius: 4px;
      }
      code,
      .mono {
        font-family: var(--font-mono);
        font-size: 0.86em;
      }
      code.path {
        color: var(--slate);
        background: var(--panel);
        border: 1px solid var(--edge);
        border-radius: 6px;
        padding: 0.1em 0.4em;
        white-space: nowrap;
      }
      .wrap {
        max-width: 1160px;
        margin: 0 auto;
        padding: 0 24px;
      }

      /* chrome */
      .nav {
        position: sticky;
        top: 0;
        z-index: 50;
        background: rgba(6, 10, 18, 0.82);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid var(--edge);
      }
      .nav-inner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 60px;
        gap: 16px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--chalk);
        font-family: var(--font-mono);
        font-size: 13px;
        letter-spacing: 0.08em;
        white-space: nowrap;
      }
      .brand:hover {
        text-decoration: none;
      }
      .brand .tick {
        color: var(--bid);
      }
      .nav-links {
        display: flex;
        gap: 4px;
      }
      .nav-links a {
        color: var(--slate);
        font-size: 13.5px;
        padding: 6px 10px;
        border-radius: 8px;
        white-space: nowrap;
      }
      .nav-links a:hover {
        color: var(--chalk);
        background: var(--panel);
        text-decoration: none;
      }
      .nav-links a[aria-current="page"] {
        color: var(--flow);
        background: var(--flow-soft);
      }
      @media (max-width: 820px) {
        .nav-links {
          display: none;
        }
        .nav-links.open {
          display: flex;
          flex-direction: column;
          position: absolute;
          top: 60px;
          right: 12px;
          background: var(--panel);
          border: 1px solid var(--edge);
          border-radius: 10px;
          padding: 8px;
        }
        .nav-menu-btn {
          display: inline-flex !important;
        }
      }
      .nav-menu-btn {
        display: none;
        color: var(--slate);
        background: none;
        border: 1px solid var(--edge);
        border-radius: 8px;
        padding: 6px 10px;
        font-family: var(--font-mono);
        font-size: 12px;
        cursor: pointer;
      }

      .footer {
        border-top: 1px solid var(--edge);
        margin-top: 96px;
        padding: 40px 0 56px;
        color: var(--dim);
        font-size: 14px;
      }
      .footer .cols {
        display: flex;
        gap: 32px;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: flex-start;
      }
      .footer nav {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .footer a {
        color: var(--slate);
      }
      .footer a:hover {
        color: var(--flow);
      }
      .footer .mono {
        font-size: 12px;
        letter-spacing: 0.06em;
      }

      /* type roles */
      .kicker {
        font-family: var(--font-mono);
        font-size: 12.5px;
        letter-spacing: 0.14em;
        color: var(--flow);
        text-transform: uppercase;
      }
      h1 {
        font-family: var(--font-display);
        font-weight: 800;
        font-stretch: 112%;
        font-size: clamp(34px, 5.4vw, 58px);
        line-height: 1.04;
        letter-spacing: -0.015em;
        margin: 14px 0 18px;
        max-width: 18ch;
      }
      h2 {
        font-family: var(--font-display);
        font-weight: 700;
        font-stretch: 106%;
        font-size: clamp(24px, 3.2vw, 34px);
        line-height: 1.15;
        letter-spacing: -0.01em;
        margin: 0 0 14px;
        max-width: 26ch;
      }
      h3 {
        font-family: var(--font-body);
        font-weight: 600;
        font-size: 18px;
        margin: 0 0 8px;
      }
      p {
        max-width: 66ch;
        color: var(--chalk);
      }
      p.lede {
        font-size: 19px;
        color: var(--slate);
        max-width: 58ch;
      }
      .section {
        padding: 76px 0;
        border-top: 1px solid var(--edge);
      }
      .section:first-of-type {
        border-top: none;
      }
      .icon {
        width: 1.25em;
        height: 1.25em;
        flex: none;
        vertical-align: -0.25em;
      }

      /* reveal on scroll */
      .reveal {
        opacity: 0;
        transform: translateY(18px);
      }
      .reveal.in {
        opacity: 1;
        transform: none;
        transition:
          opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1),
          transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @media (prefers-reduced-motion: reduce) {
        .reveal {
          opacity: 1;
          transform: none;
        }
      }

      /* flow ribbon animation */
      .edge-line {
        stroke-dasharray: 5 7;
        animation: march 1.1s linear infinite;
      }
      @keyframes march {
        to {
          stroke-dashoffset: -12;
        }
      }
      .node-pulse {
        animation: nodepulse 2.6s ease-in-out infinite;
      }
      @keyframes nodepulse {
        0%,
        100% {
          opacity: 0.55;
        }
        50% {
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .edge-line {
          animation: none;
          stroke-dasharray: none;
        }
        .node-pulse {
          animation: none;
          opacity: 0.8;
        }
      }
      /* SMIL pulses and any canvas must additionally be disabled by page JS under
   prefers-reduced-motion; see the recipe in section 4. */
    </style>
  </head>
  <body></body>
</html>
```

Nav markup (mark your own page with `aria-current="page"`; menu button toggles `.open`):

```html
<header class="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="/"><span class="tick">▲</span>T3 TRADE · SYSTEM ATLAS</a>
    <nav class="nav-links" id="navlinks">
      <a href="/">Atlas</a>
      <a href="/overview.html">Big picture</a>
      <a href="/architecture.html">Event spine</a>
      <a href="/execution.html">Execution</a>
      <a href="/risk.html">Risk</a>
      <a href="/status.html">Build board</a>
    </nav>
    <button
      class="nav-menu-btn"
      aria-expanded="false"
      aria-controls="navlinks"
      onclick="const n=document.getElementById('navlinks');n.classList.toggle('open');this.setAttribute('aria-expanded',n.classList.contains('open'))"
    >
      MENU
    </button>
  </div>
</header>
```

Footer markup (fill prev/next from the atlas order; the list lives in section 8):

```html
<footer class="footer">
  <div class="wrap cols">
    <div style="max-width:38ch">
      <div class="mono">T3 TRADE · SYSTEM ATLAS</div>
      <p style="margin-top:10px;color:var(--dim)">
        Written and illustrated by coordinated build agents. Every claim cites the repository.
        <a href="/status.html">See the board</a>.
      </p>
    </div>
    <nav aria-label="Section neighbors">
      <div class="mono" style="margin-bottom:6px">READ NEXT</div>
      <a href="/PREV.html">← PREV TITLE</a>
      <a href="/NEXT.html">NEXT TITLE →</a>
    </nav>
  </div>
</footer>
```

## 2. Fonts and icons

Fonts are self-hosted in `/fonts/` (Archivo variable with width axis, IBM Plex Sans,
IBM Plex Mono). Use `font-stretch` (106-118%) on Archivo display text for the expanded
terminal feel. Never load external font CDNs.

Icons: Tabler outline glyphs, stroke 1.75, inlined as SVG with class `icon`. The fetched
set lives at `/tmp/t3reports/icons.md` (terminal-2, route, gauge, shield-check,
shield-lock, refresh, rotate-clockwise, file-code, key, rocket, telescope,
plug-connected, cloud, device-desktop, scale, alert-triangle, book-2, activity, lock,
circle-check, circle-x, arrow-right, arrow-up-right, radar, clock, database, broadcast,
cpu, bug, flame, math, anchor, api, bolt, circle-dot, trending-up, chart-bar, bell,
focus-2, arrows-double-ne-sw). Read that file and copy the `<svg>` snippets verbatim.
Do not invent icon paths.

## 3. Color semantics (locked)

- `--bid` green: only for confirmed success, fills, healthy states, long.
- `--ask` red: only for refusal, risk gates, halts, short.
- `--amber`: only for caution, limits, unknown outcomes, degradation.
- `--flow` cyan: only for data in motion, links, events, interactive affordances.
- Never recolor these mid-page, never introduce a fifth accent, no gradients between
  accents. One theme: dark. No light sections.

## 4. The signature: flow ribbon

Every page has exactly one flow ribbon in its hero: an SVG diagram of that subsystem's
real path. Rules: rounded-rect nodes with mono 11px labels, edges as `<path>` with
class `edge-line` (marching dashes), one or two traveling pulse circles using SMIL
`<animateMotion>` on the same path (a `<circle r="3" fill="var(--flow)">`), and node
labels that are real module/event names from the repository (e.g. `trading.execution.requested`,
`signInNonceLane`, `POST /exchange`). Under reduced motion the SMIL elements must be
given `<animateMotion ... begin="indefinite">` never started, or removed by page JS.

Minimal working example (adapt geometry, keep the classes):

```html
<svg viewBox="0 0 900 120" role="img" aria-label="Intent becomes a signed exchange order">
  <path
    id="p1"
    class="edge-line"
    d="M130,60 H340"
    stroke="var(--edge-strong)"
    fill="none"
    stroke-width="2"
  />
  <path
    id="p2"
    class="edge-line"
    d="M470,60 H680"
    stroke="var(--edge-strong)"
    fill="none"
    stroke-width="2"
  />
  <g class="node-pulse">
    <rect
      x="10"
      y="34"
      width="120"
      height="52"
      rx="10"
      fill="var(--panel)"
      stroke="var(--edge-strong)"
    />
    <text
      x="70"
      y="56"
      text-anchor="middle"
      fill="var(--chalk)"
      font-family="var(--font-mono)"
      font-size="11"
    >
      intent
    </text>
    <text
      x="70"
      y="72"
      text-anchor="middle"
      fill="var(--slate)"
      font-family="var(--font-mono)"
      font-size="9"
    >
      trading_enter
    </text>
  </g>
  <g class="node-pulse">
    <rect
      x="350"
      y="34"
      width="120"
      height="52"
      rx="10"
      fill="var(--panel)"
      stroke="var(--edge-strong)"
    />
    <text
      x="410"
      y="56"
      text-anchor="middle"
      fill="var(--chalk)"
      font-family="var(--font-mono)"
      font-size="11"
    >
      guards
    </text>
    <text
      x="410"
      y="72"
      text-anchor="middle"
      fill="var(--slate)"
      font-family="var(--font-mono)"
      font-size="9"
    >
      §16.3 preview
    </text>
  </g>
  <g class="node-pulse">
    <rect
      x="690"
      y="34"
      width="120"
      height="52"
      rx="10"
      fill="var(--panel)"
      stroke="var(--edge-strong)"
    />
    <text
      x="750"
      y="56"
      text-anchor="middle"
      fill="var(--chalk)"
      font-family="var(--font-mono)"
      font-size="11"
    >
      order
    </text>
    <text
      x="750"
      y="72"
      text-anchor="middle"
      fill="var(--slate)"
      font-family="var(--font-mono)"
      font-size="9"
    >
      POST /exchange
    </text>
  </g>
  <circle r="3.5" fill="var(--flow)">
    <animateMotion dur="2.4s" repeatCount="indefinite"><mpath href="#p1" /></animateMotion>
  </circle>
  <circle r="3.5" fill="var(--flow)" opacity=".7">
    <animateMotion dur="2.4s" begin="1.2s" repeatCount="indefinite">
      <mpath href="#p2" />
    </animateMotion>
  </circle>
</svg>
```

Give every `<path>` an `id` and reference it with `<mpath href="#id">`. Reduced-motion
JS recipe (include on pages with SMIL):

```html
<script>
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document
      .querySelectorAll("animateMotion, animate")
      .forEach((a) => a.setAttribute("begin", "indefinite"));
  }
</script>
```

## 5. Reveal recipe (include verbatim at the end of body)

```html
<script>
  (() => {
    const els = document.querySelectorAll(".reveal");
    if (
      !("IntersectionObserver" in window) ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e, i) => {
          if (e.isIntersecting) {
            e.target.style.transitionDelay = Math.min(i * 70, 280) + "ms";
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -40px 0px" },
    );
    els.forEach((el) => io.observe(el));
  })();
</script>
```

Stagger siblings with `style="transition-delay:80ms"` style inline delays or by order.
Animate only transform and opacity. No window scroll listeners, no rAF loops touching
layout, no continuous full-screen animation. A canvas is allowed only if it pauses when
`document.hidden` and under reduced motion.

## 6. Layout families (use at least four different ones per page)

1. **Split**: two asymmetric columns (7/5), prose left, panel/diagram right. Collapse to
   one column under 768px.
2. **Ledger**: rows separated by single `border-top: 1px solid var(--edge)` on the
   container only (never every row), term in mono left, explanation right.
3. **Bento**: CSS grid `grid-template-columns: repeat(12, 1fr)` with cells spanning
   4/5/7/8 unevenly; at least two cells carry a visual (mini ribbon, icon composition,
   tinted panel with `background: var(--panel-2)`), never all-text.
4. **Timeline**: vertical spine with `border-left: 2px solid var(--edge-strong)`, steps
   as `position: relative` blocks with a dot `::before` on the spine. Use for lifecycles.
5. **Stat strip**: 3-4 big mono numbers (`font-size: clamp(30px,4vw,44px)`) with small
   labels under, in one row, wrapping. Numbers must be real (line counts, TTLs, limits).
6. **Callout**: `background: var(--panel); border: 1px solid var(--edge);
border-left: 3px solid <semantic color>; border-radius: 10px; padding: 18px 20px;`
   For rules and invariants. Max one callout per screen height.
7. **Evidence list**: `code.path` citations under an h3, grouped, max 6 per group.

Radius system: 10px everywhere (cards, callouts, chips). Buttons/links: 8px. No mixed radii.
Eyebrow discipline: the hero kicker is the page's one eyebrow; sections use plain h2 only.
No section-number labels, no scroll cues, no marquee, no em-dashes anywhere.

## 7. Writing rules

- Plain language for a smart engineer new to the repo. Short sentences. Active voice.
  Explain every term on first use, then use it freely. Analogy budget: one per concept.
- Zero em-dashes (`—`) and zero en-dashes (`–`) anywhere in visible text. Use periods,
  commas, colons, parentheses. Hyphens only for compound words and ranges like 3-5.
- No filler verbs ("elevate", "seamless", "unleash"). No marketing voice. This is a
  mission log, not a landing page.
- Every factual claim about the system cites the repository with `<code class="path">`
  inline: `apps/server/src/trading/HyperliquidExecutionService.ts:17-23`. Quote real
  constants, statuses, and file names. If you did not verify it, do not print it.
- Uncertainty is allowed and labeled: "the code suggests" is fine; guessing is not.
- Numbers in prose stay exact (50 bps, 100 bps, 30 minutes, 5 seconds).

## 8. Page contract and atlas order

Each page must answer, in whatever order serves the story: what is this for; how it
works internally; how it connects to sibling subsystems; why it matters; the nuances
(the surprising rules and the reasons behind them); and a go-deeper list with evidence.
Answer "how the system comes to life" where natural (boot, first request, failure paths).

Atlas order (footer prev/next follow this):
`/` index → `/overview.html` → `/architecture.html` → `/execution.html` → `/risk.html` →
`/reconciliation.html` → `/contracts.html` → `/signer.html` → `/missions.html` →
`/research.html` → `/providers.html` → `/relay.html` → `/clients.html` →
`/invariants.html` → `/stories.html` → `/glossary.html`.

Cross-link between pages with plain `<a>` using the reader-facing title.

## 9. Build board check-in (required, three times per page)

POST to the status API (exact URL and token come from your coordinator prompt):

```sh
curl -sf -X POST "$SITE_URL/api/status" -H 'content-type: application/json' -d '{
  "token": "$STATUS_TOKEN",
  "agent": {
    "id": "your-slug", "section": "Page Title", "page": "/yourpage.html",
    "status": "exploring|drafting|writing|review|done|failed|improved",
    "progress": 0-100,
    "notes": ["short human notes"], "findings": ["one-line repo facts with paths"], "files": ["site/yourpage.html"]
  },
  "note": "one line about what just happened"
}'
```

Check in at: mission start (exploring, 5), after reading the explorer artifacts and any
source (drafting, 35, with findings), and at the end (done, 100, with a note naming the
artifact file). If the POST fails, continue the mission and mention it in your report.

## 10. Self-check before done

- Base CSS present verbatim; nav with `aria-current="page)"; footer prev/next correct.
- One flow ribbon with real labels; marching dashes; SMIL pulses; reduced-motion off.
- At least four layout families; no layout family repeated back-to-back.
- Zero em-dashes; terms explained; every claim cited; no invented facts.
- Works at 375px width (inspect mentally: grids collapse, ribbon scales via viewBox).
- Contrast: chalk on void for body; slate only at 14px+; no dim text under 14px.
- `<meta name="viewport">` present; all images (none expected) have alt; buttons have
  accessible names; file size ideally under 120KB.

## Terminology standards (added after the language polish pass)

- Say "exchange-authoritative" for data read from the exchange. Use "canonical" only
  after defining it on the page.
- Reserve "harness" for named code concepts (the harness run, the decision lease) and
  explain it on first use. Distinguish the model, the provider process, and the agent
  runtime; do not use them interchangeably.
- First mention on a page: "exchange-native reduce-only stop". Afterwards: "protective
  stop". Avoid mixing "trigger child", "child", and "protection" for the same mechanism.
- Prefer plain verbs for behavior: "attempts to cancel each one" over "best effort",
  "submitted only if both checks pass" over metaphors about gates being defeated.
