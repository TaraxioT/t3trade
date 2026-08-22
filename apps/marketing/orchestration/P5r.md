# P5r: cockpit animated-story regressions

Date: 2026-08-22. Worker pass over three reported defects + one copy check.

## Defect 1: rogue green line at story start
Root cause: NOT in Chart.astro. `Hero.astro` had briefly declared
`view-timeline-name: --mission` (duplicate of Mission.astro:170), so replica
elements resolved the nearest declaring scope and the draw keyframes ran
against the wrong timeline, rendering the final run-to-target segment at the
story's start. The concurrent hero-static agent removed the declaration
(Hero.astro now has zero `view-timeline` lines); dist CSS contains exactly one
`view-timeline-name: --mission` (grep over `dist/_astro/*.css`: 1 occurrence).
No Chart.astro change needed. Verified: beat-000.png shows no green line in the
mission chart plot (note: scrub-000.png's "fully drawn cockpit" is the hero's
new static `.hero-frame`, a different element, not the mission chart).

## Defect 2: graph does not hit target at end
Same root cause (timeline scramble). After the hero fix + rebuild:
beat-100.png shows the line fully drawn reaching the 76,763 target, status
`BTC · Completed +$51.06`. No Chart.astro change needed.

## Defect 3: composer caret misalignment
Root cause: Composer.astro desktop media block (min-width:1081px) sets
`.composer-line { align-items: flex-start; }`, pinning the 13px caret to the
row top while glyphs center in the 22.75px line box. Fix: added
`.composer-line .composer-caret { margin-top: 4.875px; }` inside the desktop
block (centers the caret on the first 22.75px line). Verified in
caret-zoom.png (blink frozen for capture only via injected
`.composer-caret{animation:none}`): caret vertically centered on the
placeholder line.

## Copy check: "Suse skills"
No defect. The replica string is `Ask anything, @tag files/folders, $use
skills, or / for commands` (Composer.astro:33) and is character-for-character
the app's real placeholder (`apps/web/src/components/chat/ChatComposer.tsx`,
final branch of the placeholder ternary: "Ask anything, @tag files/folders,
$use skills, or / for commands"). "$use" is the app's skills sigil; the
screenshot's "Suse" is "$" reading as "S" at small size. mission.ts untouched
(the placeholder is not a fixture number; no change made).

## Verification evidence (shots/p5r/)
- beat-000/010/030/050/070/090/100.png: stepped fixed-scroll scrub at
  1440x900 over the contain range (scrollY 1283.5 -> 3443.5). Order: empty ->
  history draws -> Armed -> Long at entry -> P&L counting +$8.02/+3.89% ->
  drawdown dip -$6.84 -> rally -> Completed +$51.06, line at 76,763.
- reduced-mission-end.png: prefers-reduced-motion end state. Chart drawn to
  76,763 with check, log ends on "Looked at the market" / "Sold to close
  0.0536 BTC at 76,763 +$51.06", positions Closed/Done, P&L +$51.06 / +24.79%.
- caret-zoom.png: caret centered, placeholder transcribed exactly.
- First-pass scrub-*.png used the entry-pass mapping and are superseded by
  beat-*.png; kept for reference.
- Capture scripts p5r-capture*.mjs (in orchestration/) were deleted after use;
  shots remain.

## Timeline guard
Build output: `only 34 animation-timeline declarations survived, expected at
least 37` -> check-scroll-timelines.mjs exits 1. EXPECTED: the hero going
static removed 3 timelines. Real count: 34. Guard not edited (coordinator
settles MIN_TIMELINES).

## Not done
Nothing outstanding in scope. beats.ts, Mission.astro, Hero.astro,
scripts/check-scroll-timelines.mjs untouched.

---

# P5r reopen: the real chart bug (tall viewport 1885x1611)

## Root causes (3, all in Chart.astro)

1. ROGUE TAIL STROKE AT STORY ZERO. The price line was revealed by the
   pathLength=1 dash technique (stroke-dasharray: 1 + animated
   stroke-dashoffset). Under the chart's non-uniform viewBox stretch
   (preserveAspectRatio="none" + vector-effect non-scaling-stroke), Chrome's
   dash rendering paints the path TAIL segment even at stroke-dashoffset
   exactly 1 (verified: computed offset "1px" while a bright green diagonal
   painted; hiding .price-line removed it, hiding the wash changed nothing -
   iso-*.png pixel diffs). Aspect-driven, which is why <=1024-tall
   verification missed it. Additionally a round-linecap dot painted at the
   path origin (zero-length dash boundary at offset 1; dotbase/dotnoline
   diff = 2px dot at crop x=4).
2. TARGET CHECK PAINTED FROM PAGE LOAD. `.target-check path` ran scrub-draw
   with NO animation-timeline (state: finished on the document timeline,
   range "normal"), and the `.target-check` span had a timeline but no
   animation-name - nothing gated the glyph (the "dash at the tip" in the
   coordinator's frame).
3. STOP HOLDS GHOST. `.stop-hold-label` used the global check-in keyframes
   whose from-frame is opacity 0.12, ghosting the label over the chart from
   page load until the drawdown beat (computed opacity 0.12 pre-story).

## Fixes (Chart.astro only)

- The price line no longer uses dashes at all: no stroke-dasharray/dashoffset;
  it reveals through the SAME generated wash-clip track
  (`animation-name: wash-clip`), whose stops come from the same beat table,
  so line and wash can never disagree and no engine dash bug can leak or
  drop ink. The generated @keyframes price-draw block was removed.
- `.target-check path` now carries animation-timeline: --mission +
  animation-range contain var(--from/--to) (custom props inherit from the
  span), and `.target-check` was added to the zone-in list as a second gate.
- New local `@keyframes stop-note-in` (from opacity 0, same translateY(8px)
  arrival) replaces check-in for `.stop-hold-label`.

## Width sweep (painted pixels, agy-vision reads of chart crops)

Zero = forced pre-story frame; Final = forced story-end frame. Zero rows are
all CLEAN (no stroke/check/diagonal/STOP HOLDS). Final rows all TOUCHES.

| viewport | band | zero | final |
|---|---|---|---|
| 390x844 | phone pass .68 | CLEAN | TOUCHES |
| 768x900 | tablet pass .68 | CLEAN | TOUCHES |
| 1000x900 | mid pass .6 | CLEAN | TOUCHES (v4) |
| 1100x800 | mid pass .6 (desktop layout) | CLEAN | TOUCHES (v4) |
| 1200x800 | mid pass .6 (developer's crop band) | CLEAN | TOUCHES (v4) |
| 1300x800 | mid pass .6 | CLEAN | TOUCHES (v4) |
| 1280x800 | mid pass .6 | CLEAN | TOUCHES (v4) |
| 1280x900 | pinned | CLEAN | TOUCHES |
| 1440x900 | pinned | CLEAN | TOUCHES |
| 1920x900 | pinned | CLEAN | TOUCHES |
| 1200x1000 | pinned | CLEAN | TOUCHES |
| 1440x1400 | pinned tall | CLEAN | TOUCHES |
| 1512x1611 | pinned tall | CLEAN | TOUCHES |
| 1885x1611 | pinned tall (developer) | CLEAN | TOUCHES |

Real-scroll evidence at 1885x1611 (tallscrub-*.png): entry blank; beats
10/30/50/70/90 draw in order (survey -> chips -> entry -> P&L counting ->
drawdown -$6.84 -> 90%); end touches 76,763 with the check.
reduced-mission-end2.png: composed end state intact (line at 76,763, check,
log ends "Sold to close 0.0536 BTC at 76,763 +$51.06", Closed/Done, +$51.06).

## Disposition of the secondary anomalies (NOT my files)

- GUTTER LETTER FRAGMENTS (B..., S..., W..., n... vertically clipped between
  the chart card and the log card at 1885x1611): the decorative
  behind-the-glass transcript `.appwin-bg-lines--right` in
  Window.astro (right: 60px, width: 420px, opacity .22) - its line starts
  peek out left of the Agent Log card at this aspect. Window.astro is not
  mine; required change: clip or narrow the bg-lines layer (e.g. overflow
  hidden on the shell or shifting the column right) at tall aspects.
- HERO ARMED PARTIAL DRAW: hero-side (Hero.astro, concurrently owned). The
  mission chart's fix does not affect it. The hero must show the FIRST ~38%
  at its armed rest, never the tail; same dash-technique hazard applies to
  the hero's line if it still uses dashoffset - recommend the hero adopt the
  same clip reveal.

## Build status

`astro build` green, scroll-timeline guard passes with 37 declarations
(guard MIN was settled at 37 by the hero work; my .target-check path wiring
contributed +1 vs the 36 the hero left). `astro check`: 0 errors, 0
warnings. beats.ts, Mission.astro, Hero.astro, tokens.css untouched.

---

# P5r closeout: gutter letters fixed, hero verified

## Gutter fragments (Window.astro, now mine)
The decorative transcript columns sit behind the cards with `.appwin-bg`
already clipped to the window, so the fragments were the right column's
leading letters exposed in the chart/log card gutter where a card edge fell
mid-word at tall aspects. Fix (Window.astro): edge-fade masks on both
columns - the left column fades out to its right, the right column
(`--right`) fades in over its first 120px (`mask-image:
linear-gradient(to left, black 40px, transparent 120px)`). No card-edge
position can ever produce a hard single-letter cut.

Verified painted pixels at 1885x1611, 1512x1611, 1440x1400, 1440x900
(gutter-*.png, agy-vision): CLEAN, zero fragments, all four.

## Hero armed partial draw
Verified heroline-1885x1611.png / heroline-1440x900.png: line drawn from
far left covering ~38% at load, right half completely clear, no tail
fragment or check-mark. The hero agent's view-box clip at the 62.68% edge
works as reported.

## Status
Build green (guard 37), astro check 0 errors / 0 warnings. Chart story
closed.
