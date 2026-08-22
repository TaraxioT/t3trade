# fidelity.md — cockpit replica vs the real app

Mock = `apps/marketing/src/pages/index.astro` (idx) and `apps/marketing/src/layouts/Layout.astro` (lay).
App = the files under `apps/web/src/` named per row. One row per divergence.
Severity reflects visibility at the size the replica renders (1440x900 desktop surface).

| # | What the mock does | What the app does | Mock file:line | App file:line | Severity |
|---|---|---|---|---|---|
| 1 | Page chrome typeface is DM Sans + JetBrains Mono | system-ui stack + ui-monospace/SF Mono | lay:122-123 | apps/web/src/index.css:137-139 | low (chrome; the replica itself re-scopes the app stacks at idx:1640-1641, which matches) |
| 2 | Page radius ladder 12/8/16px | `--radius: 0.625rem` with derived sm/md/lg/xl ladder (10/8/10/14px) | lay:124-126 | apps/web/src/index.css:1387, 199-205 | low (chrome; contract clause 4 sanctions two ladders. Replica cards correctly use 14px = app `rounded-xl`, see row 15) |
| 3 | Hand-drawn 16px stroke icons for sidebar, breadcrumb, status bar, composer, dock (dozens of literal `<path>` elements) | lucide-react ^0.564.0 icons at 14-16px, strokeWidth 1.5-2 | idx:491-534, 582-607, 915-917, 924-940 | MissionLivePanel.tsx:123, MissionHeaderPill.tsx:18-26, MissionLivePanel.tsx:2679 (`size-[11px]` strokeWidth 2) | high (contract replica rule: "icons come from the same lucide set … No hand-drawn paths") |
| 4 | Agent-log row glyphs are unicode text characters (◇ ◔ ◌ ▤ ▲ ◉ ▼ B S ✓) rendered at 12px inside a 16px circle | lucide icon (e.g. Activity, Radar, TrendingUp) at `size-[11px]` strokeWidth 2 inside the 16px token | idx:254-295 (glyph strings), 894, 2226-2240 | MissionLivePanel.tsx:2676-2680 | high (same clause as row 3; geometry and stroke differ visibly at replica size) |
| 5 | `--fg-panel`, `--chart-primary`, `--chart-blue` defined as hand-copied literals in the layout | real tokens: `.mission-panel` overrides `--foreground` via `color-mix(in oklch, var(--card-foreground) 94%, var(--card))`; `--primary` dark `oklch(0.571 0.21 264)`; `--info` = blue-500 | lay:110-121, idx:2092 | trading.css:179-194, index.css:1465, 1426 | low (the copied values verify exactly: chart-primary == dark `--primary` byte-for-byte, chart-blue == blue-500's `oklch(62.3% 0.214 259.815)`, fg-panel == the resolved 94% mix; the defect is only that they are literals that can silently drift on an app token change) |
| 6 | `--ok`/`--loss`/`--warn` quote the app's dark profit/loss/armed values as literals | `--profit`/`--loss`/`--armed` defined once and theme-switched in trading.css | lay:106-112 | trading.css:30-55 | low (values match the dark variant exactly; naming diverges from the app token names) |
| 7 | Chart wash gradient stops 0.10 / 0.03 / 0 (three stops) | dark wash tokens `--mission-chart-wash-top: 0.13`, `--mission-chart-wash-mid: 0.04`, two stops | idx:635-639 | trading.css:139-144, MissionPriceChart.tsx:855-866 | medium (the wash is the largest colour region on the panel; 0.10-vs-0.13 top reads visibly dimmer) |
| 8 | Wedge gradient near/far 0.13 / 0.04 in `--chart-blue` | `--mission-chart-wedge-near/far: 0.13 / 0.04` dark in `--info` ink | idx:640-643 | trading.css:139-144, MissionPriceChart.tsx:870-882 | match (no row action; recorded because the mission asked for wedge opacities — this one is faithful) |
| 9 | All five level lines share dash `4 4`, stroke-width 1, opacity 0.85 | levels use `strokeDasharray="2 4"` (rules and stubs) and the entry uses `"5 4"`, strokeWidth 1 (selected 2) | idx:2902-2906, 2929-2933 | MissionPriceChart.tsx:1052, 1105, 1128 | low (dash rhythm differs only at zoom) |
| 10 | Level chips docked at their price row, right:2, 10.5px mono, glass = border 50%, card 62%, bevel 6%, blur 8px, tabular-nums | same anatomy: `mission-chip` at `top: labelY%`, right:2, px-1.5 py-[1.5px], 10.5px, border-border/50, card 62% dark, bevel white/6%, backdrop-blur-sm | idx:2947-2973 | MissionPriceChart.tsx:1500-1518, trading.css:266-274 | match on material (recorded; chip placement requested by the mission is faithful — app also docks per-price with collision folding the mock does not implement, minor) |
| 11 | Chip caption ("target", "above", "stop") set at the chip's own 10.5px, same ink | caption is `text-[9.5px] opacity-70`, glyph `text-[9px]`, both visually recessed under `formatPrice(tag.price)` | idx:727-738 | MissionPriceChart.tsx:1539-1553 | low |
| 12 | Log row value figure in foreground ink (`--fg`) | figure is `text-muted-foreground` (11px mono tabular) | idx:2275-2281 | MissionLivePanel.tsx:2685-2688 | low (right-aligned column, one step too loud) |
| 13 | Log row divider hand-stated as `oklab(1 0 0 / 0.015)` | `divide-y divide-border/15` on the feed | idx:2208-2210 | MissionLivePanel.tsx:3039, 3047 | match (mock comment documents deriving it; value consistent with border/15 on white/6% border) |
| 14 | Log text `color-mix(--fg-panel 90%)`, 12px/16.5 | `text-[12px] text-foreground/90 leading-snug` on the panel's overridden foreground | idx:2264-2273 | MissionLivePanel.tsx:2661-2682 | match |
| 15 | Panel cards (chart, positions, log) at radius 14px, border white/12%, bg card 58%, bevel white/9%, shadow `0 16px 36px -24px rgb(0 0 0/80%)`, blur(16px) saturate(1.08) | `CARD_CLASS = "mission-panel-glass … rounded-xl"`; dark: outline white/12%, card 58%, bevel white/9%, same shadow, `--glass-blur: 16px; --glass-saturation: 1.08` | idx:2112-2124 | MissionLivePanel.tsx:286, trading.css:100-123, index.css:116-117 | match (14px == radius-xl of 0.625rem base) |
| 16 | Progress rule: 3px, track `fg-panel 8%`, fill `--chart-primary`, label mono 11px `N% to target` with `Math.round` | `h-[3px] bg-foreground/[0.08]`, fill `bg-primary`, `${Math.round(percent)}% to target`, mono 11px tabular | idx:3223-3250, 337, 885-888 | MissionLivePanel.tsx:1653-1671 | match |
| 17 | Status bar drawn as a third glass pane (own border, radius 14, blur, shadow), 45px on desktop | status bar is `CARD_CLASS` glass card, `lg:min-h-[45px]`, `py-2.5`, `gap-x-4` | idx:2296-2309, 4543-4545 | MissionLivePanel.tsx:1909-1920 | match on material/height (recorded; "third pane" framing in the mock comment is accurate) |
| 18 | Status dot is a state-reel dot tinted wait/armed/long; prediction chip omits the leading "→" | the one dot on the panel is exposure-toned (`bg-profit`/`bg-loss`/`bg-muted-foreground`); projection prints `→ {price} by {time}` after a TrendingUp/Down icon | idx:906-917 | MissionLivePanel.tsx:1906-1925, 1956-1967 | low |
| 19 | Funding figure hardcoded literal "Funding 0.0013%/8h" | `Funding {(rate*100).toFixed(4)}%/8h` | idx:917 | MissionLivePanel.tsx:1998-2001 | low (format matches; the mock's is a literal digit in markup, contract replica rule) |
| 20 | Position rows 28px pill-radius mono 11px tabular px-8; leverage badge `bg currentColor 16%` | `h-7 … rounded-full px-2 font-mono text-[11px] tabular-nums`; leverage `rounded-[3px] bg-current/15` | idx:3084-3096, 3132-3137 | MissionLivePanel.tsx:2292, 1699-1706 | match (16%-vs-15% badge fill is sub-pixel; not rowed separately) |
| 21 | Every position row filled `fg-panel 3%` with solid border 60% | open rows `bg-foreground/[0.03]` with border-border, planned/placeholder rows `border-dashed border-border/50` | idx:3093-3095 | MissionLivePanel.tsx:2295-2298 | low |
| 22 | Header capsule: 30px, px-12/4, card 60% + blur 8px, market + state word + P&L + phase dots (1 solid, 2 hollow rings) | `rounded-full border-border bg-card/60 backdrop-blur px-3 py-1 text-sm`; phase dots `bg-foreground` done / ring foreground current / ring muted/40 pending; P&L `formatSignedUsd` | idx:1780-1797, 588-595, 1737-1754 | MissionHeaderPill.tsx:155-223, 86-90 | match (the "current" middle dot as a foreground ring is the one nuance the mock flattens; low) |
| 23 | Capsule state words "BTC · Waiting / Armed / Long 20x / Completed" | market anchor + stateWord; while exposed the word is the exposure label ("Long 0.2631" — size, not leverage) | idx:589-592 | MissionHeaderPill.tsx:143-146, 279 | low |
| 24 | Capsule P&L is a static "$0.00" beside a reel that never touches it | header P&L is the live `formatSignedUsd(position.unrealisedPnl)` walking with the position | idx:594 | MissionHeaderPill.tsx:200-208 | medium (a $0.00 money figure that never moves while the log and positions count to +$51.06 contradicts the one-mission-state rule by omission) |
| 25 | Chart header: mark 26px mono tabular in fg-panel; 24h change in fg-panel 70% (not money palette); interval pill lowercase | mark + `change24hPercent` with the day's move deliberately outside the money palette; `intervalLabel` pill lowercase mono 11px | idx:2583-2621 | MissionLivePanel.tsx:771-773, 990-991, 1023 | match (26px leading figure size not located verbatim in the app source; unverified) |
| 26 | Every number traces to the inline `MISSION` const in the page frontmatter; `src/lib/mission.ts` does not exist | n/a (contract requires the fixture at `apps/marketing/src/lib/mission.ts`) | idx:20-33, plus literal digits at idx:255-295 (log values), 828-857 (settled rows), 1020 ("/ 17"), 900 ("51 earlier turns") | DESIGN-CONTRACT.md:58 | high (contract replica rule violated: fixture lives inline and many digits are literals in markup) |
| 27 | RR band: `border-t` border 40%, `bg fg-panel 2%`, segments opacity 0.68, 15% fills | `CONTEXT_BAND_CLASS = "border-t border-border/40 bg-foreground/[0.02] px-4 py-2"`, `.mission-rr-segment` dark opacity 0.68 | idx:2796-2856 | MissionLivePanel.tsx:353, trading.css:151-155 | match |

## Counts

- high: 3 (rows 3, 4, 26)
- medium: 3 (rows 7, 24, and row 5 kept low; recount: rows 7, 24 only — see below)
- low: 11

Corrected tally: high 3, medium 2 (rows 7, 24), low 11, informational matches 11.

## Unverified

- Composer glass geometry (22px radius, 768px width, 144px height, `color(srgb … / 0.8)` fill, 70/48px rows): the mock cites a `chat-composer-glass-shell` class (idx:4548-4549) that does not exist anywhere in `apps/web/src` (rg over the tree returns nothing), so the numbers cannot be confirmed against source.
- Chart header mark size (26px): not found as a literal in MissionLivePanel/MissionPriceChart; the mock's claim is plausible but unconfirmed.
- MissionStripBar.tsx: read; it is the full-width bar variant, not represented in the replica, so no diff was possible.

## Dispositions (P5, 2026-08-21)

Footnoted list; the table above is the original audit record and stays as written.

- 1: deliberate. Page chrome keeps the marketing brand type; contract clause 4 sanctions the split. The replica itself now re-scopes the app stacks via `--app-font-sans` / `--app-font-mono` from the token bridge.
- 2: deliberate. Two ladders per contract clause 4; replica cards now consume `var(--app-radius-xl)` (0.875rem = 14px) instead of a hand-typed 14px.
- 3: FIXED. Every replica icon is now a lucide glyph from `src/lib/icons.ts` via `renderIcon` at the app's geometry (log tokens 11px/2, chart chips 9px/2, status bar 11px/2, composer chevrons 12px/2). The surfaces that carried most of the hand-drawn set (sidebar, breadcrumb actions, dock) were cropped out entirely. One interim: the composer send arrow renders `ChevronUp` until `ArrowUp` is added to the generated set (requested via coordinator).
- 4: FIXED. Log row glyphs are lucide names in the `mission.ts` fixture (`LogRow.glyph: IconName`), rendered at 11px / strokeWidth 2 inside the 16px token.
- 5: FIXED. `--fg`, `--fg-muted`, `--border`, `--card-app`, `--chart-primary` (now `--app-primary`), `--chart-blue` (`--app-info`), and `--fg-panel` (the app's own formula, `color-mix(in oklch, var(--app-foreground) 94%, var(--app-card))`) all resolve from `app-tokens.generated.css`. Rendered values unchanged.
- 6: FIXED. The replica consumes `--app-profit` / `--app-loss` / `--app-armed` under the app's own names, scoped to the window.
- 7: FIXED. Wash stops now `var(--app-mission-chart-wash-top)` / `var(--app-mission-chart-wash-mid)` (0.13 / 0.04). Correction to the row: the app's gradient is three stops (0% / 45% / 100%), same structure as the replica; only the opacities differed.
- 8: affirmed. Wedge stops now sourced from `var(--app-mission-chart-wedge-near/far)`; values were already faithful.
- 9: FIXED. Level rules and stubs at `2 4`, the entry at `5 4`, strokeWidth 1 (mobile raster override scaled to `5 10` / `13 10`).
- 10: affirmed. Chip material faithful; the glass values now come from the shared token block.
- 11: FIXED. Chip captions set at 9.5px / opacity 0.7 under the 10.5px figure.
- 12: FIXED. Log row value figure now `--fg-muted` (the app's `text-muted-foreground`); tone colours still override for up/down.
- 13: affirmed deliberate-literal. The divide ink stays the documented literal because mixing it in this pipeline computes 0.009 alpha; the value is derived from the app's `divide-border/15` and recorded in a comment.
- 14: affirmed.
- 15: affirmed, and now token-sourced: outline/opacity/bevel/shadow/blur/saturation/radius all from `--app-mission-panel-*` / `--app-glass-*`, byte-equal to the literals they replace.
- 16: affirmed.
- 17: affirmed; the status bar's glass is the same token block, with a solid `prefers-reduced-transparency` fallback.
- 18: deliberate on the dots. The capsule/status/sidebar reel dots are the story's state reel (waiting/armed/long/settled), which the marketing replay needs on every surface; the app's single exposure-toned panel dot is a live-position detail the replay generalises. The projection's leading arrow is carried by the lucide `TrendingUp` icon the app pairs with it.
- 19: FIXED by the fixture move. The funding string lives in `mission.ts` (`STATUSBAR.funding`); its format matches the app's `(rate*100).toFixed(4)` output.
- 20: affirmed. 16%-vs-15% badge fill is sub-pixel at render size.
- 21: deliberate. Every position row the replica renders is a placed order (open or filled), so the app's solid open-row treatment applies; the fixture has no planned/placeholder rows, so the dashed variant has no surface here.
- 22: affirmed, plus the one nuance fixed: the middle (current) phase dot now reads as a foreground ring, one step above the pending rings. The capsule P&L tail is no longer part of this row's capsule copy; see 24.
- 23: FIXED. While exposed, the capsule state word is the size (`Long 0.0536`), matching `MissionHeaderPill`'s exposure label; the positions card keeps the leverage badge where the app puts it.
- 24: FIXED. The capsule P&L is a `pnl-track` reel over the same `pnlArc` every other money figure uses, on the existing `beatRange("run", "settle")` slice (no new timing), formatted by `formatSignedUsd`. It walks green through the run, red through the drawdown, and lands on `+$51.06`.
- 25: affirmed. The 26px mark stays as recorded (unverified in app source; consistent with the panel's figure hierarchy).
- 26: CLOSED. The fixture lives at `src/lib/mission.ts`; a grep pass over the replica markup finds no literal mission digits (every figure renders from the fixture through `format.ts`; remaining literals are beat fractions and viewBox geometry, not mission data).
- 27: affirmed.

Post-P5 note on the ledger's scope: rows 1-2 record page-chrome divergences outside the replica; the replica-vs-app comparisons above were re-checked against the cropped surface (no sidebar, no breadcrumb, capsule-only header).
