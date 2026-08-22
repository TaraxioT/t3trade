# P9a: marketing perf/a11y static census (read-only)

Measured against the on-disk state of `apps/marketing/src/**` and a fresh
`apps/marketing/dist/` (built 2026-08-22 01:38). P8 (mobile pass) was editing
`src/components/**` concurrently; every file:line below was verified against the
latest on-disk content at read time (`git status` shows `src/components/`,
`src/lib/`, `src/styles/` untracked-new and `Layout.astro`/`index.astro`
modified, so line numbers refer to the working tree, not HEAD).

Classification: COMPOSITOR = transform/opacity only. PAINT = anything that
rerasters (clip-path, stroke-*, background, box-shadow, filter, color).
LAYOUT = geometry (width, height, inset, margin, padding, font-size...).
LAYOUT rows are defects; there are none (see verdict).

## 1. Animated property census

### Layout.astro (`src/layouts/Layout.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :251 | `.btn` `transition: transform, background, border-color, color` | transform / background / border-color / color | COMPOSITOR + PAINT | Hover feedback; background+color repaint is a one-off 180ms paint of a pill-sized element. Cheap. |
| :320 | `@keyframes fade-in` | opacity, transform: translateY | COMPOSITOR | Hero copy entrance. |
| :331 | `@keyframes pulse` | opacity | COMPOSITOR | Defined; referenced nowhere in the read set (dead keyframes, note only). |
| :335 | `@keyframes blink` | opacity | COMPOSITOR | Composer caret (replica idle-fidelity loop). |
| :345 | `@keyframes scrub-rise` | opacity, transform | COMPOSITOR | Generic `.scrub` arrival. |
| :350 | `@keyframes scrub-word` | opacity, transform | COMPOSITOR | Kinetic headline words. |
| :355 | `@keyframes scrub-draw` | stroke-dashoffset | PAINT | SVG stroke draw; per-frame repaint of one path, scroll-scrubbed. Expected cost for a draw-on effect. |
| :460 | `@keyframes spine-draw` | stroke-dashoffset | PAINT | One fixed 24px-wide SVG, scroll-scrubbed on the compositor-driven timeline. Fine. |
| :464 | `@keyframes spine-resolve` | opacity | COMPOSITOR | |
| :496 | `@keyframes tape-fill` | transform: scaleX | COMPOSITOR | Scroll progress bar. |
| :500 | `@keyframes nav-settle` | border-bottom-color | PAINT | 24px scroll range, single step (steps(1,end)); one repaint total. Fine. |
| :478 | `.nav` `transition: border-color` | border-color | PAINT | One-shot. |
| :519, :560, :610 | `.nav-brand`, `.nav-github`, `.footer-links a` `transition: color` | color | PAINT | Text repaint on hover, small elements. Fine. |

Not animated but per-scroll cost worth noting: `.nav` `backdrop-filter: blur(18px)`
(:474-475) repaints on every scroll frame under the sticky bar; and `body::after`
grain overlay is `position: fixed` (:191), so it does not re-raster on scroll.

### tokens.css (`src/styles/tokens.css`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :50 | `.tile::after` `transition: opacity .3s` | opacity | COMPOSITOR | Spotlight fade. The `--mx/--my` custom-property writes drive a `radial-gradient` background repaint per pointermove; contained to the tile, gated off for reduced-motion and touch (`index.astro:124-139`). |
| :84 | `@keyframes check-in` | opacity, transform | COMPOSITOR | Shared "row arrives" scrub. |

### replica.css (`src/styles/replica.css`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :208 | `@keyframes pnl-count` | transform: translateY | COMPOSITOR | Money reels, steps(32). |
| :174-176, :181-191, :237-249, :281-284 | timeline plumbing (`animation-timeline`/`animation-range` on ~24 selector lists) | n/a (wiring) | - | No properties of their own; keyframes live in components. |

### Chart.astro (`src/components/replica/Chart.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :133 (frontmatter, injected :176) | `@keyframes price-draw` (generated) | stroke-dashoffset | PAINT | The price stroke drawing across the pinned story. Continuous scroll-scrubbed stroke repaint of one path; this is the section's headline effect and is the accepted cost. |
| :144 | `@keyframes wash-clip` (generated) | clip-path | PAINT | Inset clip reveal of the area wash; clip-path animations are rasterized per frame. Same story beat as price-draw, acceptable paired cost. |
| :155 | `@keyframes price-wash` (generated) | opacity, transform: translateX | COMPOSITOR | Settle flourish only (finishes at --wash-settle). |
| :847 | `@keyframes chip-in` | opacity, transform (translateY + scale) | COMPOSITOR | |
| :865 | `@keyframes chip-flash` | opacity, transform, **box-shadow** | COMPOSITOR + PAINT | Box-shadow ripple 14%->40% of the armed chip's beat; shadow grows 0->10px on a pill, once per chip. Bounded, fine. |
| :881 | `@keyframes reassess-flash` | opacity | COMPOSITOR | |
| :902 | `@keyframes level-draw` | opacity, transform: scaleX | COMPOSITOR | |
| :928 | `@keyframes fire-ping` | opacity, transform: scale | COMPOSITOR | |
| :943 | `@keyframes zone-in` | opacity | COMPOSITOR | |
| :954 | `@keyframes stop-flare` | opacity, **stroke-width** | PAINT | SVG stroke width 1->4->2 on one horizontal line over the drawdown beat. Repaint only, no reflow (SVG geometry is paint here). Fine. |
| :974 | `@keyframes target-ping` | opacity, transform: scale | COMPOSITOR | |
| :998/:1003 | `@keyframes measure-down` / `measure-up` | clip-path | PAINT | Wipe reveal of the two rr bar segments; the figures stay true-size by design. Repaint per frame while the wipe runs, bounded to a 20px bar. |

### Window.astro (`src/components/replica/Window.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :24 (frontmatter, injected :40) | `@keyframes status-walk` (generated) | transform: translateY | COMPOSITOR | Status reel steps. |
| :219 | `@keyframes win-live` | transform (scale + translateY) | COMPOSITOR | Window focus; explicitly disabled when un-pinned (:377-380). |

### AgentLog.astro (`src/components/replica/AgentLog.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :33 (frontmatter, injected :97) | `@keyframes progress-arc` (generated) | transform: scaleX | COMPOSITOR | Progress rule bends with the number. |
| :62 | `@keyframes feed-follow` (generated) | transform: translateY | COMPOSITOR | Tail-follow, steps(1,end). |
| :88 | `@keyframes feed-follow-phone` (generated) | transform: translateY | COMPOSITOR | Phone twin. |
| :358 | `@keyframes log-enter` | opacity, transform: translateY(4px) | COMPOSITOR | |

### Positions.astro (`src/components/replica/Positions.astro`)

| Location | Rule / keyframes | Properties | Class |
|---|---|---|---|
| :313 | `@keyframes order-enter` | opacity, transform (translateY + scale) | COMPOSITOR |
| :324 | `@keyframes swap-in` | transform: translateY | COMPOSITOR |

### StatusBar.astro

| Location | Rule / keyframes | Properties | Class |
|---|---|---|---|
| :98-99 | `.sb-pred` uses global `check-in` | opacity, transform | COMPOSITOR |

### Composer.astro (`src/components/replica/Composer.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :93 | `.composer-caret` `animation: blink 1.1s steps(1,end) infinite` | opacity | COMPOSITOR | Perpetual loop, but it is the real product's idle caret (contract clause 9 exemption), it is aria-hidden, and it has a reduced-motion guard (:252-256). |
| :279 | `@keyframes msg-show` | opacity | COMPOSITOR | |
| :292 | `@keyframes msg-type` | clip-path | PAINT | Stepped 44-glyph typing clip; per-frame raster of a one-line span, bounded. |
| :303 | `@keyframes send-fire` | transform | COMPOSITOR | |

### Tape.astro (`src/components/sections/Tape.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :60 | `@keyframes tape-run` | transform: translate3d | COMPOSITOR | The page's one perpetual chrome loop; the two-run track makes the -50% wrap seamless and the compositor owns it (comment :47-49). Real data ticker, contract-sanctioned. |
| :110 | `@keyframes tape-shimmer` | background-position | PAINT | Loading placeholder only (1.4s, ends when data lands or section removes itself). background-position animation repaints each frame, but it is masked to the placeholder pills and transient. Acceptable; a transform-based shimmer would be free. |

### Hero.astro (`src/components/sections/Hero.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :125-127 | `.hero-eyebrow/.hero-title/.hero-sub/.hero-actions` `animation: fade-in` | opacity, transform | COMPOSITOR | Load-time entrance with delays (:129-131). |
| :174, :185 | `.hero-source-link`/arrow `transition: color / transform, opacity` | color, transform, opacity | COMPOSITOR + PAINT | Hover. |
| :231 | `@keyframes hero-open-up` | clip-path | PAINT | Scroll-scrubbed shutter open of the crop. Full-stage clip repaint per scroll frame for cover 0-36%; it is the hero's one effect and is mask+clip only (no geometry). Accepted cost; noted so nobody adds a second one. |
| :248 | `@keyframes hero-copy-out` | opacity, transform, visibility | COMPOSITOR | |

### Mission.astro (`src/components/sections/Mission.astro`)

| Location | Rule / keyframes | Properties | Class |
|---|---|---|---|
| :183 | `@keyframes dim-hold` | opacity | COMPOSITOR |
| :197 | `.note-mark` uses global `check-in` | opacity, transform | COMPOSITOR |

### Checks.astro (`src/components/sections/Checks.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :282 | `@keyframes tally-count` | transform: translateY | COMPOSITOR | Odometer, steps(17,end). |
| :299 | `@keyframes stamp-land` | opacity, transform (scale+rotate) | COMPOSITOR | |

### Arming.astro (`src/components/sections/Arming.astro`)

| Location | Rule / keyframes | Properties | Class | Judgment |
|---|---|---|---|---|
| :130 | `@keyframes arming-light` | opacity, **box-shadow** | COMPOSITOR + PAINT | One-shot 8px dot lighting; glow 0->10px once. Fine. |
| :135 | `@keyframes arming-wake` | background (gradient) | PAINT | Gradient crossfade of a half-band, one 20% cover range. Bounded repaint; a transform/opacity curtain would be free but this is cheap enough. |

### Capture.astro

| Location | Rule / keyframes | Properties | Class |
|---|---|---|---|
| :123 | `@keyframes capture-rise` | opacity, translate | COMPOSITOR |

### Verdict

**Zero LAYOUT-property animations.** Every animation in the tree is
transform/opacity/clip-path/stroke/background/box-shadow. No width, height,
inset, margin, padding, font-size or line-height is ever animated. The paint
rows above all carry bounded, story-justified costs; the only two worth a
second look if budgets ever tighten are `hero-open-up` (full-stage clip scrub)
and the `price-draw`/`wash-clip` pair (per-frame stroke/clip repaint while
pinned).

## 2. will-change census

| Location | Declaration | Genuinely animates? | On a long list? |
|---|---|---|---|
| `src/components/sections/Tape.astro:56` | `will-change: transform` on `.tape-track` | Yes - the only infinite transform loop on the page (:51-57) | No - one element |

That is the entire census: exactly one `will-change`, correctly spent on the
one perpetual animation, nowhere else. No will-change is stacked on scroll-scrub
elements (scroll timelines promote their targets already), none leaks on a
long-lived list.

## 3. Reduced-motion coverage

Global strategy: every scroll-driven animation is inside
`@media (prefers-reduced-motion: no-preference) @supports (animation-timeline: ...)`,
so reduced-motion users (and timeline-less browsers) fall through to base
styles. Whether that fallback is a *composed end state* (contract clause 10)
per element:

### Covered, lands composed

| Element | file:line | End state reduced-motion users see |
|---|---|---|
| Hero copy fade-in | Hero.astro:340-347 | Explicit `animation: none` guard; copy fully visible. |
| Hero crop + copy hand-over | Hero.astro:221-260 | Gated; crop rests at `inset(4% 0 0 56%)` (:204) with copy visible over it - the "doorway" composed frame. |
| `.scrub` / `.kinetic` words | Layout.astro:359-378 | Gated; base opacity 1, words fully readable. |
| Spine draw/resolve | Layout.astro:442-468 | Gated; line rests fully drawn (dashoffset 0, :431), node visible. |
| Tape marquee | Tape.astro:50-58 | Gated; static first copy, real prices after JS fill. |
| Tape shimmer | Tape.astro:120-124 | Explicit reduce guard. |
| Composer caret blink | Composer.astro:252-256 | Explicit reduce guard. |
| PnL/ROI/pct reels | replica.css:119-122 | Rests at final stop (`translateY(-32*1.3em)`) - the closing figures. |
| Status reels | replica.css:71, Window.astro:24-29 | Rest at "Mission complete" / "Completed" step (-4.5em). |
| Price line | Chart.astro:446-454 | Rests `stroke-dashoffset: 0` - fully drawn walk to target. |
| Chips | Chart.astro:742-761 | Base opacity 1; all chips visible at their rows (composed chart frame). |
| Levels / grid / wedge / dots / labels | Chart.astro:798+ | Base opacity 1 / drawn; grid labels visible. |
| rr segments | Chart.astro:638 | `clip-path: inset(0)` at rest - both bars fully measured out. |
| Log rows / feed follow | AgentLog.astro:358-381 | Rows at opacity 1; feed rests at final shift (last keyframe = 100% stop is animation-only, BUT base `.log-feed-inner` has no transform -> feed rests at top). **Gap - see below.** |
| Positions rows / state swap | Positions.astro:299-327 | Rows opacity 1; `.armed-state--met` rests at `translateY(15px)` = hidden below the window, so the token shows the pre-close state ("Open"/"Working"). **Gap - see below.** |
| Progress fill | AgentLog.astro:325-332 | Rests width 100% / no transform - full bar to target. |
| Arming light/wake | Arming.astro:111-146 | Gated; dot rests lit (opacity 1 :102), band gradient static. |
| Checks list / tally / stamp / chips | Checks.astro:262-308 | Rest visible; tally rests at 17 (:161-163). |
| Capture rise | Capture.astro:115-130 | Gated; rests fully composed. |
| Mission dim/vignette | Mission.astro:177-188 | Gated; rests opacity 0 - room undimmed. |
| Tile spotlight JS | index.astro:125-126 | Gated by `matchMedia(prefers-reduced-motion: reduce)` early-return. |

### Gaps (clause 10 traps)

1. **AgentLog feed follow - reduced motion shows the TOP of the log, not the end of the story.**
   `AgentLog.astro:193-196`: `.log-feed-inner` has no base transform; the
   tail-follow exists only as the `feed-follow` animation. Reduced-motion (and
   timeline-less) users see rows 1-14 of a ~30-row feed and never see the rows
   that carry the story's conclusion (the win, the follow-up, the settle).
   Needed end state: rest the strip at the final shift
   (`transform: translateY(-<last feedStops shift>px)`, the same number the
   100% keyframe already computes) exactly the way `.pnl-track` and
   `.status-track` rest on their last stop.
2. **Positions state swap never closes.** `Positions.astro:299`
   (`.armed-state--met { transform: translateY(15px) }`) keeps the "Closed" /
   "Done" tokens parked below the 15px window at rest; only the `swap-in`
   animation lifts them. Reduced-motion users see the live rows stuck on
   "Open"/"Working" forever, contradicting the settled-history story around
   them. Needed end state: rest at `translateY(0)` (met state shown), matching
   the reel pattern.
3. **Stop-hold flare is invisible at rest.** `Chart.astro:566-571`:
   `.stop-hold { opacity: 0 }`; only `stop-flare` brings it to 0.32. The
   resting chart therefore never shows the "stop holds" moment's thicker line
   (the label `.stop-hold-label` does rest visible, so the story is told, but
   the line itself is missing from the composed frame). Needed end state:
   rest at the keyframes' 100% frame (`opacity: 0.32; stroke-width: 2`).
4. **Scroll tape and nav hairline are NOT reduced-motion gated.**
   `Layout.astro:481-494`: the `@supports (animation-timeline: scroll())` block
   for `.scroll-tape-fill` (tape-fill) and `.nav` (nav-settle) has no
   `prefers-reduced-motion` guard, unlike the spine block at :442. They track
   scroll position directly (arguably user-driven, not "motion"), but the
   site's own convention gates every other scroll animation. Same treatment
   recommended for consistency; their resting frames (scaleX(0) tape /
   transparent border) are otherwise fine.
5. Minor, no action strictly needed: transient pings (`.fire-ping`,
   `.target-ping` Chart.astro:491-509, 590-595) rest at opacity 0, which IS
   the correct end state for a one-shot ripple; `.composer-msg` and
   `.msg-type` rest at opacity 0 / fully clipped (Composer.astro:114, 120) -
   the sent message has cleared, correct end state.

## 4. A11y structure

### aria-hidden / text alternatives per surface

| Surface | Situation | file:line |
|---|---|---|
| Window (shell) | Decorative layers correctly hidden: `.appwin-bg` (Window.astro:54), traffic dots (:43). Title text "T3 Trade" + net pill are NOT hidden (fine, real text). Hero instance wrapped in `aria-hidden` hero-crop (Hero.astro:43) - the hero's Window carries no aria-label of its own but its text content is hidden as decoration; acceptable since the Mission instance is the readable one. | Window.astro:43,54; Hero.astro:43 |
| Chart | The SVG itself is the one surface with a real `role="img"` + full `aria-label` naming the whole story (range, break, entry, stop, target with prices). Overlays `.chart-marks`, `.grid-labels`, `.chart-chips` are aria-hidden (labels duplicate the SVG's summary). rr figcaption is real content, readable. | Chart.astro:196-197, 267, 282, 292 |
| AgentLog | Rows are real text (tone carried visually by rail/glyph, both aria-hidden :127-128); money cluster readable; `.log-progress` aria-hidden (:114) - the "x% to target" figure is hidden from AT with no text alternative. Minor: the progress figure is data, consider un-hiding. | AgentLog.astro:114, 127-128 |
| Positions | The entire `.pos-scroll` table body is `aria-hidden` (Positions.astro:36) - every position row, price, and PnL is invisible to AT. The head "Positions / Unrealised" cluster is readable, but the data is not. Biggest AT content gap in the replica. | Positions.astro:36 |
| StatusBar | Whole bar aria-hidden (StatusBar.astro:8) - "Mission complete", the projection chip, funding text all hidden. End-state text exists nowhere else for AT users. | StatusBar.astro:8 |
| Composer | Whole composer + wakeup capsule aria-hidden (Composer.astro:23, 32) - correct for a non-interactive replica; the typed instruction is decoration. | Composer.astro:23,32 |
| Topbar capsule | aria-hidden (Topbar.astro:11) - state reel text ("BTC - Long 20x" etc.) hidden; acceptable since the story is told by the log. | Topbar.astro:11 |
| Tape | Section has `aria-label="Hyperliquid testnet markets"` (Tape.astro:10); the duplicated second run is aria-hidden (:14); prices are real text filled by JS. Good. | Tape.astro:10,14 |
| Capture | The one real image: full descriptive alt naming the dashboard, chart, log and positions (Capture.astro:28-30). figcaption adds provenance. Pass. | Capture.astro:28-35 |
| Harness icons | `alt=""` on the five CLI logos (Harness.astro:45) - decorative, name is adjacent text. Correct. | Harness.astro:45 |
| Page chrome | `.scroll-tape` and `.spine` aria-hidden (Layout.astro:45, 51); decorative svgs aria-hidden (nav GitHub :86, dl icon Hero.astro:33). | Layout.astro:45,51 |

### Heading order

h1 (Hero.astro:22) -> h2s in order: Mission.astro:11, Checks.astro:13,
Harness.astro:19, Arming.astro:10, State.astro:9, Capture.astro:8, Open.astro:8,
Cta.astro:7; h3s only under the Mission h2 (Mission.astro:42,52,62). No skips,
no levels used for style alone. Pass.

### Focus-visible

Global `:focus-visible` outline (2px accent, offset 2) at Layout.astro:314-318
covers every link and the harness radios. Harness additionally mirrors
focus onto the tabs via `:has(...:focus-visible)` (Harness.astro:183-190) -
keyboard parity with pointer. Pass.

### Keyboard traps / tabindex / inert

No `tabindex` attribute anywhere in `src/**`; no `inert`; no positive-tabindex
traps. The only keyboard-operable custom control is the harness radio strip:
five native radios, opacity-0 but focusable (Harness.astro:84-88), arrow keys
work natively, labels are `for`-wired. No trap. The page is otherwise plain
links. Pass.

### Form controls

Only the harness radio group (Harness.astro:32-40): real `<input type="radio">`
with `name`, checked default, accessible name via the label text + icon.
Radio group lacks an explicit fieldset/legend or `aria-labelledby` on the
role="tablist" - the tablist has `aria-label="Agent CLIs"` (Harness.astro:42),
which names the group; radios themselves are named by their labels. Note: the
tablist/tab/tabpanel roles are decorative-only (no aria-controls/aria-selected
wiring), so a screen reader hears a labelled tablist with stateless tabs -
cosmetic ARIA; the underlying radios are what actually work. Acceptable, worth
knowing.

## 5. Contrast candidates (WCAG AA, computed from the literal tokens)

Method: oklch/oklab resolved to sRGB via OKLab, color-mix resolved linearly in
sRGB, ratio = (L1+0.05)/(L2+0.05). Resolved key colors for reference:
`--accent oklch(.75 .15 160)` = #3dca8d; `--ok` = #4dbf74; `--warn` = #e3ad52;
`--loss` = #ec5c52; `--fg-muted` = #b1b1b9; `--fg-dim` = #7e7e88;
`--fg-faint` = #55555e; `--bg` = #09090b. Panel surface (app card glass 58%
over window bg) resolves to ~#111318; app card = #101013 + 3% white ~= #16161a;
app muted-foreground (oklch 55.6% + 10% white) ~= #6e6e6e.

### CTAs (pass)

| Pair | Math | Ratio | Verdict |
|---|---|---|---|
| `.btn-primary` label #04120b on gradient top oklch(.8 .15 160) (Layout.astro:259) | lum(#04120b)=0.0066, lum(top)=0.5207 -> (0.5707/0.0566) | **11.97** | PASS (needs 4.5) |
| same label on gradient bottom oklch(.7 .15 160) | (0.3863+0.05)/(0.0566) | **8.39** | PASS - worst case of the gradient |
| `.btn-ghost` label #b1b1b9 on transparent over #09090b (Layout.astro:280-283) | lum(#b1b1b9)=0.4372, lum(#09090b)=0.0034 -> 0.4872/0.0534 | **9.34** (9.06 over hover's 2% white) | PASS |
| `.hero-source-link` #b1b1b9 on bg (Hero.astro:171) | same | **9.34** | PASS |

### Muted labels

| Pair | file:line | Ratio | Verdict (threshold) |
|---|---|---|---|
| Footer links/brand `--fg-dim` on `--bg` | Layout.astro:595-611 | (0.2115+0.05)/(0.0534) = **4.95** | PASS 13px (4.5) |
| `.eyebrow` `--fg-dim` on bg | Layout.astro:220-227 | **4.95** | PASS 11px |
| `.cta-note` / `.cta-release` / `.cta-install-label` `--fg-dim` on bg | Cta.astro:80-94,121-127 | **4.95** | PASS |
| `.section-lede` `--fg-muted` on bg | tokens.css:25-31 | **9.34** | PASS |
| **`.capture-caption` `--fg-faint` on bg** | Capture.astro:107-113 | (0.0906+0.05)/0.0534 = **2.70** | **FAIL** 13px (4.5) |
| **`.tape-chg` `--fg-faint` on tape bg (+2% white)** | Tape.astro:92-96 | **2.62** | **FAIL** 11px placeholder (becomes ok/loss once filled: 8.3/5.7 - only the "·" placeholder and any no-prev cell fail) |
| **`.switch-tag` `--fg-faint` on switch bg** ("coding threads") | Harness.astro:149-158 | **2.62** | **FAIL** 10px uppercase |
| **`.preview-check-detail` `--fg-faint` on preview card** | Checks.astro:206-209 | **2.67** | **FAIL** 11px - each check's detail text is under threshold |
| `.preview-verdict-note` `--fg-dim` on card | Checks.astro:231-235 | **4.90** | PASS 11px |
| State labels `--ok`/`--warn` on #0a0a0d | State.astro:63-64 | **8.47 / 9.74** | PASS 12px |

### Replica inks on panel surface (~#111318)

| Pair | file:line | Ratio | Verdict |
|---|---|---|---|
| `--app-foreground` 97% | Window.astro:108 | **17.71** | PASS |
| `--fg-panel` 92.2% | Window.astro:121 | **15.34** | PASS |
| `--app-muted-foreground` (log values, times, captions) | Window.astro:109 | **4.97** | PASS, but with only 0.47 of headroom - any added opacity (see next rows) drops it under |
| `--ok` / `--loss` / `--warn` figures | replica.css:129-134, :83-85 | **8.28 / 5.72 / 9.52** | PASS |
| `.log-text` fg-panel at 90% | AgentLog.astro:286 | **12.46** | PASS |
| `.chart-chg` fg-panel at 70% | Chart.astro:415 | **7.79** | PASS 13px |
| `.rr-note` `--fg-muted` | Chart.astro:680 | **4.81** | PASS 11px |
| **`.chip-cap` (fg-muted at opacity .7, 9.5px)** | Chart.astro:765-768 | effective ink = 0.7*muted over chip bg -> **3.00** | **FAIL** (4.5) - the "target/entry/stop" captions inside level chips |
| `.chip--stop` text = `--loss` at 85% over chip bg | Chart.astro:777 | **4.39** | Marginal FAIL (4.5) at 10.5px - one step from passing; chip--target 6.20 and chip--armed 7.08 pass |
| **`.rr-seg--risk` ink: `--loss` at opacity .68 over its 15% tint** | Chart.astro:654-662 | **2.97** | **FAIL** 10px - the stop-side figures "risk" read at 3:1 |
| `.rr-seg--reward` `--ok` at .68 over 15% tint | Chart.astro:664-668 | **3.84** | Marginal FAIL at 10px (passes 3:1 large-text only, but 10px is not large) |
| **`.grid-labels` fg-muted at opacity .5** | Chart.astro:714-722 | **2.10** | FAIL - price axis labels; aria-hidden but visually the only place the price scale is stated. Replica-fidelity call: the app's own grid labels, flagged for the fixer to decide |

Summary of hard failures to fix: fg-faint as a text ink anywhere (capture
caption 2.70, preview check details 2.67, switch-tag 2.62, tape placeholder
2.62), chip captions 3.00, rr-seg risk 2.97 / reward 3.84, chip--stop 4.39,
grid labels 2.10. Cheapest systemic fix: retire `--fg-faint` for text (it is
already borderline on bg at 2.6-2.7 everywhere it is used) and lift the .68/.7
opacities on the rr segments and chip caps.

## 6. Payload census (fresh `dist/`, build of 2026-08-22 01:38)

| Item | Raw | Gzipped |
|---|---|---|
| JS (single inline `<script type="module">`, `index.html`; release lookup + tape + tile spotlight) | 2,287 B | **1,160 B** |
| External JS files | 0 | 0 |
| CSS (`_astro/index.DHhKs9no.css`, one file, `cssMinify: false` by design) | 106,485 B | 19,129 B |
| `index.html` document total | 224,039 B | 30,623 B |

**JS budget verdict: PASS.** Total shipped JavaScript is 1,160 bytes gzipped
against the 12 kB budget (`DESIGN-CONTRACT.md` "Stack rules") - under 10% of
the ceiling. No framework runtime, no external script tags.

Images (only fetched if used; capture images are `loading="lazy"`):

| Asset | Size |
|---|---|
| `capture/mission-live-panel-desktop.avif` / `.webp` | 43,413 B / 94,552 B |
| `capture/mission-live-panel-mobile.avif` / `.webp` (max-width 639px) | 34,073 B / 71,460 B |
| `harnesses/*.svg` (5 logos) | 360-2,005 B each (~5.7 kB total) |
| `favicon-32x32.png` / `favicon-16x16.png` / `apple-touch-icon.png` | 1,541 / 645 / 23,913 B |
| `favicon.ico` | 74,922 B (48px multi-size; heavy for a favicon) |
| **`icon.png` and `icon.webp` in `public/` - 657,978 B EACH, byte-identical size, and referenced nowhere in the built HTML** | ~1.29 MB dead weight deployed on every upload |

Fonts: Google Fonts stylesheet request (`fonts.googleapis.com`, DM Sans 3
weights + JetBrains Mono 2 weights, Layout.astro:30-35) plus the font files
from `fonts.gstatic.com` - two render-blocking-by-default external origins,
preconnected. No local font files.

Runtime network requests made by the page's script (`index.astro` inline):
1. `GET https://api.github.com/repos/<repo>/releases?per_page=1` (release
   lookup, `src/lib/releases.ts:7`) - fires on load, no fallback cache.
2. `POST https://api.hyperliquid.xyz/info` body `{"type":"metaAndAssetCtxs"}`
   (tape fill, index.astro inline) - on load; failure removes the band.

LCP/CLS: not measured here (no server, no browser, per mission).

## 7. Grain / layers

| Overlay | file:line | Fixed? | pointer-events? | Inside a scroller? | Notes |
|---|---|---|---|---|---|
| Grain/noise `body::after` (feTurbulence data-URI, opacity .035, 256px tile) | Layout.astro:189-199 | Yes, `position: fixed; inset: 0` | Yes, `pointer-events: none` (:193) | No - attached to body, above all content (z-index 9999) | Correct: fixed so it does not re-raster during scroll, click-through. One caveat: z-index 9999 sits above the sticky nav and the mission stage (z 60); intentional film grain over everything. |
| Vignette `.mission-dim` | Mission.astro:101-109 | No - absolute inside the pinned sticky | `pointer-events: none` | Inside `.mission-sticky`, which is the pinned viewport, not a scroll container (the scroller is the page) | Fine; fades out by 18% of the story and is display:none when un-pinned (:246). |
| Hero grid/glow | Hero.astro:92-114 | No - absolute in the sticky stage | `pointer-events: none` both | Sticky stage, not a scroller | Static, no animation. |

No grain or vignette lives inside an actual scrolling container; all are
fixed or pinned-viewport absolutes and all are pointer-inert.

## Defect list, ranked by user-visible impact

1. **Reduced-motion: agent log feed rests at the top, not the end of the story**
   (AgentLog.astro:193-196) - clause 10 violation; the mission's conclusion
   rows are never shown without animation.
2. **Reduced-motion: position state tokens never swap to Closed/Done**
   (Positions.astro:299) - the settled frame contradicts the story.
3. **Positions table and status bar are aria-hidden wholesale**
   (Positions.astro:36, StatusBar.astro:8) - the largest AT content gap; the
   replica's data is decorative to screen readers except the chart svg.
4. **`--fg-faint` used as a text ink fails AA everywhere it appears**
   (capture caption 2.70, preview check details 2.67, switch-tag 2.62, tape
   placeholder 2.62) - systemically under threshold, not marginally.
5. **rr-segment figures at opacity .68** (risk 2.97, reward 3.84,
   Chart.astro:654-668) and **chip captions at .7** (3.00, Chart.astro:765) -
   the risk/reward bar's own numbers are its least readable text.
6. **1.29 MB of unreferenced icon.png/icon.webp deployed in public/**
   (public/icon.png, public/icon.webp) - pure payload waste on every deploy.
7. **Stop-hold line rests invisible** (Chart.astro:566-571) - minor clause-10
  残 gap; label survives, line does not.
8. **Scroll-tape fill and nav hairline lack the reduced-motion guard** the
   rest of the site uses (Layout.astro:481-494) - consistency, low impact.
9. **favicon.ico at 75 kB** and grid labels at 2.10 (replica-fidelity call)
   - minor.
10. **No layout-property animations found; one will-change, correctly placed;
    JS budget 1,160 B gz against 12 kB - all clean.**
