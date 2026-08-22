# P6r: hero rework, static watch-state frame (pass 4, developer-approved direction)

Developer approved the static hero ("looks nice") with one revision: rest the
card at an early, instantly-parseable moment instead of the story's settled
end. Target register: watch/armed.

## How the armed rest state is built (hero-scoped only, no frozen edits)
Two moves inside `.hero-frame`:

1. `animation: none` on the replica's story elements (the beat-list selectors
   re-declared hero-scoped). Root cause found while implementing: with no
   `--mission` timeline in scope, Chrome falls scroll-timeline animations
   back to the DOCUMENT timeline, where `fill: both` + 0-duration pins every
   element at its 100% (settled) keyframe - which is why static base styles
   never showed. Killing the animations on this instance lets the components'
   base styles speak. The composer's caret blink is untouched (idle-loop
   fidelity).
2. Point the base states at the armed beat, every value lifted from the
   frozen replica's own machinery:
   - `.status-track { translateY(-1.5em) }` - status-walk's armed step; capsule
     reads "BTC - Armed", statusbar "Waiting on trigger".
   - `.price-line { stroke-dashoffset: 0.6205 }` and `.price-wash
     { clip-path: inset(0 62.68% 0 0) }` - the generated price-draw/wash-clip
     keyframes' own 18% (watch-armed) stops, extracted from the built CSS.
   - `.log-feed-inner` rest shifts from the fixture's own row geometry:
     -234.5px desktop (7 rows x 33.5px past the 14-row page), -585px phone
     (8-row page at 45px), -495px >401px (10-row page). Visible page ends on
     "Watch armed - mark crosses above".
   - `.pnl-track { transform: none }` - reels rest at their first step:
     +$0.00, 0% to target. `.progress-fill { scaleX(0) }`.
   - display:none for everything that only exists after the watch fires:
     entry/stop/wake levels, wedge, drawdown/target marks, met/mark/entry/
     stop/wake chips, the rr tick, and all position rows (positions empty).

Mission's own rest state is untouched: verified under genuine
prefers-reduced-motion (CDP emulation) it still rests at the settled end
(Completed capsule, full price line, "Sold to close" tail, closed rows).

## Verification (shots/p6r/, agy verdicts)
- watch-desktop-1440 + watch-card-zoom2: capsule "BTC - Armed +$0.00", price
  line ~40% drawn with clean right side, target+trigger levels, armed +
  reassess chips, last log row "Watch armed", positions empty, nothing
  sliced; "clearly presents an agent waiting in an armed monitoring state".
- watch-fold-1280, watch-mobile-390: same parse, CTA above fold, soft fade
  above viewport bottom, nothing sliced.
- watch-desktop-1440 vs -s350: card identical at scroll 0 and mid-hero
  scroll (no timeline; static).
- watch-hero-reduced: armed state intact under reduce.
- watch-mission-reduced: Mission end state unchanged (settled).
- Note: Playwright's emulateMedia motion and --force-prefers-reduced-motion
  both silently fail in this Chrome build; captures use CDP
  Emulation.setEmulatedMedia. Earlier "reduced" frames in this dir from
  passes 2-3 were bogus and have been superseded.

## Checks
- Build green at guard 34 ("scroll timelines ok (34 declarations, none
  folded)"). Hero contributes zero timelines.
- astro check: 0 errors, 0 warnings, 1 hint (pre-existing, frozen
  scripts/extract-app-tokens.mjs).
- Concurrent-change note: replica/Composer.astro was modified at 04:08 by the
  concurrent Mission-region agent (not by me; my ownership is Hero.astro).
  No other frozen file changed under me.

# Pass 5: the github.com demo frame

Read the reference (/Users/george/Workspace/t3trade/github-hero-frame.png) via
agy first; agy confirmed the measured spec (24px top radius, square bottom,
1px border on lit edges, translucent surface, 20px top/side inset, 12px inner
concentric rounding, open bottom).

Implementation (Hero.astro only):
- .hero-frame-shell wraps the cockpit OUTSIDE the zoom so the frame's
  geometry stays true px: border-radius 24px 24px 0 0; 1px var(--border-strong)
  on top/sides (neutral ink, dark-theme adaptation of their rgb(140,147,151));
  background a subtle white-lift gradient (their rgba(255,255,255,0.15)
  equivalent over dark); padding 20px 20px 0.
- .hero-frame .appwin gets border-radius 12px 12px 0 0 (concentric inner,
  square bottom), hero-scoped like the other instance overrides.
- Bottom treatment: OPEN, flowing into the existing soft fade. One line: the
  frame opens toward the fold and the fade remains the only thing that cuts
  the product, per the fold ruling; a closed rounded bottom would put a hard
  frame edge where the developer already ruled the fade must do the cutting.
- Ladder note: the shell is page chrome in the marketing ladder; 24px is a
  deliberate one-off matching the reference's measured geometry, documented
  in-file against the contract's radius-ladder clause. The replica inside
  keeps the app ladder; no element mixes both.
- Zoom retuned for the +21px frame: 0.52 / 0.66 / 0.37 / 0.51 / 0.42; the
  <=1080 frame padding-inline dropped to 0 (the shell now carries the inset).
  Measured fold gaps: 1440x900 +17, 1280x800 +62, 390x844 +42; CTA above
  fold at all three.

Verification: frame-desktop-1440 + frame-card-zoom2, frame-fold-1280,
frame-mobile-390, frame-desktop-1440-s350. agy verdicts: deliberate framed
container like github.com's demo, neutral ink, clean wrap, armed state
preserved, nothing sliced, CTA above fold, soft fade above the fold at all
sizes, card identical at scroll 0 vs mid-hero.

Checks: build green at guard 34; astro check 0 errors / 0 warnings / 1
pre-existing hint (frozen extract-app-tokens.mjs).

# Pass 6: the section minimap rail

The app's chat-timeline minimap as page chrome (permitted third script, commit
5f5d15a8e). Markup + script in index.astro, styles global there (the ticks are
created at runtime by the script, so Astro's scope attribute never lands on
them - the first build silently shipped unstyled ticks, caught in the agy
frame read and fixed with `<style is:global>`).

- Fixed rail in the RIGHT gutter at >=1081px (the spine owns the left one);
  hidden below (same breakpoint, same justification: a second fixed gutter
  under 1081 clutters a column that no longer has margins to spare).
- One real <button> per rendered section (10), built from `main > section` at
  runtime so the tape's self-removal retires its own tick; nav landmark with
  aria-label; per-tick aria-label "Jump to <name>"; hover label restrained
  (mono 10px uppercase chip, plain opacity/transform transitions).
- In-view highlight via IntersectionObserver with a -40%/-40% center band
  (a section-entering fact, not a scroll-position read); aria-current on the
  active tick. Accent ink for the active tick: "current position" is the one
  semantic the accent already carries (the spine's terminal node), so the two
  gutters agree. No animation-timeline declarations added.
- Jumps: scrollIntoView, behavior "instant" under prefers-reduced-motion
  ("auto" would defer to html's scroll-behavior: smooth and smooth-scroll
  over the preference - caught in DOM verification and fixed).
- Verified: 10 ticks/labels, active tick tracks scroll (0/1470/2963/4890/7639
  px -> ticks 0/2/2/3/8/9), click jumps to CTA, keyboard Tab reaches ticks
  with the page focus ring + visible label, hidden at 390, reduced-motion
  jump lands instantly. Shipped JS 3668 B raw / 1783 B gzipped (budget 12288).

# Pass 7: glass stronger, backlight, cockpit lower

Read github-hero-glow.png + github-hero-frame.png via agy first (glow
strongest at top/upper corners, 25-40px+ spread, near-zero at bottom; bezel
near-opaque frosted slate; demo truncates mid-content).

- Shell: border one step above --border-strong (color-mix), surface lift
  ~0.09 -> 0.02 white, inset top highlight, backdrop-filter blur(10px) frost.
- Backlight: static .hero-backlight behind the shell, two radial gradients in
  var(--accent) (24% core / 11% wide wash), strongest at the top perimeter,
  fading with the frame's own bottom mask. Light, not motion: no animation.
- Cockpit lower: frame margin-top clamp(88px, 11vh, 120px) desktop (84px
  narrow, 44px landscape), mask widened to 140px. The fold now lands INSIDE
  the fade's span at all three canonical sizes (frame bottoms: 954/+(-54) at
  1440x900, 798/+2 at 1280x800, 866/(-22) at 390x844), so the composer is cut
  mid-content like the reference's truncated editor while the fade - not the
  bezel - remains the softer visible edge.
- agy verdicts (glow-desktop-1440, glow-fold-1280, glow-mobile-390): teal
  glow behind the frame's top on all three; frosted-glass bezel with distinct
  border; composer dissolving mid-content; CTA above fold everywhere; nothing
  sliced; rail present at 1440 with one accent tick and no labels, absent at
  390.
- Checks: build green at guard 34; astro check 0/0/1 (pre-existing frozen
  hint).

# Pass 8 (stopped): exact-match experiment, then revert + uniform insets

The github-exact pass (violet border rgb(140,147,251), white-0.15 surface,
violet-to-cyan backlight, opaque rgb(21,26,34) media backing) was rejected by
the developer: "multiple colors, some sticking out, everything looks white,
lost its glass appeal. Earlier was better."

Reverted in full to the pass-7 glass: neutral hairline (border-strong mix),
translucent lift gradient, inset highlight, backdrop blur, single-accent
hue-160 backlight. The one retained change, per the developer's final
instruction: the glass-to-cockpit inset is now uniform - the appwin fills the
shell's content box (width:100%) so left = right = top = 20px padding (+1px
border) = 21px rendered, measured equal at 1440x900, 1280x800, 390x844.
Violet-cyan contract exception reverted (54accf68b); one-accent holds again.

Also this pass (before the stop): the hero price line's armed reveal switched
from stroke-dashoffset 0.6205 to a view-box clip (inset 0 62.68% 0 0) - at
zoom 0.37 on the stacked surface Chrome's dashoffset + non-scaling-stroke
rasterization split the stroke into two fragments (isolated by offset/zoom
probes); the clip is geometry and renders one continuous stroke at every
size. The Mission-side chart artifacts and the composer overlap seen in the
reg frames belong to the concurrent Mission agent and were reported, not
touched.

Verification (glass-desktop-1440, glass-fold-1280, glass-mobile-390): dark
glass read, single teal glow, equal gaps, CTA above fold, nothing sliced -
pass on all three. Build green at guard 36 (34 + the rail's mission-progress
view timeline + its name declaration; coordinator to settle the floor).
astro check 0/0/1 pre-existing.

HERO FRAME ITERATION STOPS HERE per the stop order.
