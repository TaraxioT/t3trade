# T3 Trade marketing: design contract

## Design read
A redesign, overhaul-the-visuals and preserve-the-content, of an open-source
devtool landing page for technical traders and agent operators. Language:
dark-tech precision instrument. Reference standard: github.com's homepage.
Foundation: Astro plus native CSS scroll-driven animations plus a 1:1 product
replica system. Not a template, not a component library.

## Dials
DESIGN_VARIANCE 7. MOTION_INTENSITY 8. VISUAL_DENSITY 6.
Density is above the landing-page default on purpose: the product is a cockpit,
mono numerals are mandatory for every figure, and airy marketing spacing would
misrepresent it. Variance stays at 7 rather than 9 because the page must read as
an instrument, not an agency showreel.

## Non-negotiables
1. Zero em-dash and zero en-dash-as-separator in any visible string. Regular
   hyphen only.
2. One theme. The page is dark, top to bottom. No light section.
3. One accent. `--accent` at hue 160 is the page accent everywhere. Trading
   semantics are *data* colours and may only appear inside the replica and
   inside data marks. They are never used for page chrome, CTAs, links or
   section decoration. The app's trading tokens, verified against
   `apps/web/src/trading.css`, are `--profit`, `--loss`, `--long`, `--short`,
   `--armed`, plus the `--mission-chart-*` hues.
4. One radius ladder. Page chrome uses the marketing ladder. The replica uses
   the app ladder. The two never mix inside one element.
5. Eyebrows: at most `ceil(sectionCount / 3)` on the whole page, hero counts as
   one. Count them mechanically before shipping.
6. No section-number eyebrows, no scroll cues, no locale or time strips, no
   version stamps in page chrome, no decorative status dots outside the replica,
   no marquee more than once on the page.
7. No two sections share a layout family. Eight sections need at least four
   families. No three consecutive image-plus-text splits.
8. Hero: max four text elements, headline max two lines, subtext max 20 words,
   top padding max 6rem, CTA visible without scrolling at 1280x800 and at
   390x844.
9. Every animation must be justifiable in one sentence as hierarchy,
   storytelling, feedback or state transition. Delete anything else. No
   perpetual loops except the ticker tape, which is real data.
10. `prefers-reduced-motion: reduce` must land on a fully composed, readable
    end-state frame, never a blank or half-drawn one.

## The replica rule (this is the clause that resolves the biggest tension)
The design skill bans div-based fake screenshots. github.com does the same thing
we want to do and gets away with it because their replicas are built from their
real product's own design system, at 1:1, and are visibly *more* accurate than a
screenshot would be at that size. That is the bar. Concretely:

- The replica may only use values that came out of `apps/web` mechanically.
  Hand-typed approximations of app tokens are a defect, not a shortcut.
- The replica's typeface, radius ladder, border colours, card material, icon
  geometry and numeric formatting are the app's, not the marketing site's.
- The replica's icons come from the same lucide set the app imports, at the same
  size and stroke width. No hand-drawn paths.
- Every number in the replica traces to the fixture in
  `apps/marketing/src/lib/mission.ts`. No literal digits in markup.
- At least one section on the page carries a real capture of the running app,
  not a replica. A page that is 100% simulation is a fake-screenshot page no
  matter how good the simulation is.
- `docs/media/t3trade-mission.png` is an AI-generated fake with gibberish text;
  never ship it. `public/t3trade-screenshot.webp` was already removed from the
  site and has no remaining references anywhere in the repo (verified
  2026-08-21); if it reappears, delete it again.

## One mission state drives everything
There is exactly one scroll timeline for the cockpit story and exactly one
ordered list of beats. Every animated element in the replica derives its range
from that list by name, never from a literal percentage. If the pill says
`Long 20x` the entry mark is already drawn, because both read beat `entry`.
Adding a beat re-times the whole story consistently or it is rejected.

## Stack rules
- Astro. No React, no GSAP, no Motion, no animation library. Native CSS
  scroll-driven animations (`animation-timeline: view()` / `scroll()`).
- `window.addEventListener("scroll", ...)` is banned. So is any scroll position
  read into JS state.
- `cssMinify: false` in `astro.config.mjs` is deliberate. The minifier folds
  `animation-timeline` into the `animation` shorthand and silently kills every
  scroll animation. Do not re-enable it.
- `scripts/check-scroll-timelines.mjs` fails the build if timelines vanish or
  get folded. Raise `MIN_TIMELINES` whenever the real count rises. Never lower
  it.
- Shipped JS stays under 12kB gzipped for the whole page. The only scripts are
  the release lookup and the Hyperliquid tape.

## Working rules
- Marketing dev server: `pnpm --filter @t3tools/marketing dev --port 4180`.
  Astro daemonizes; stop it with `astro dev stop` from `apps/marketing`
  (`pnpm --filter @t3tools/marketing exec astro dev stop`).
- Never run `pnpm dev` from the repo root and never launch the t3 app for
  marketing work. Root dev defaults to the live install directory.
- One dev server, one browser, one owner, for the whole loop. Sub-agents do not
  start their own.
- Marketing-only staged sets fail the `vp fmt` pre-commit hook. Commit those
  with `--no-verify`.
- All image analysis in this effort goes through the `agy-vision` skill:
  screenshot comparison, scroll-frame reading, OCR of captured frames, UI
  diffing, alt-text drafting. Load it by name with the Skill tool and use its
  `agy` CLI invocation pattern with absolute image paths. Do not use other
  image-analysis tools for these judgments.
- Only the orchestrator deploys, only when the user says so, with
  `wrangler pages deploy` from `apps/marketing`.

## Definition of done for any agent
Run the Pre-Flight Check from the design-taste-frontend skill in full. Report
each box as pass or fail with the evidence. A box you did not check is a fail.
