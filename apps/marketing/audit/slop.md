# slop.md — design-skill violations, mechanical

Vocabulary from the design-taste-frontend skill (Sections 4/9/14); stack rules
overridden by DESIGN-CONTRACT.md where they conflict (Astro + CSS timelines,
no React/GSAP). Counts are mechanical (rg) unless marked "judgement".
"Chrome" = page chrome outside the `.appwin` replica; replica internals are
exempt where the contract exempts them.

| # | Violation class | Count | Evidence (file:line) | Verdict |
|---|---|---|---|---|
| 1 | Em-dash (`—`) | 22 total (`rg -n "—"`): index.astro 22, Layout.astro 0 | index.astro:169, 203, 1521, 1777, 1871, 1949, 2091, 2340, 2508, 2858, 2976, 3024, 3165, 3917, 3933, 4024, 4079, 4301, 4327, 4342, 4436, 4548 | all 22 sit in code comments, 0 in visible strings — the contract's "zero in any visible string" holds; the skill's absolute ban does not. Flag for comment hygiene only |
| 2 | Eyebrows vs budget | 2 `.eyebrow` instances against a budget of `ceil(9/3) = 3` (9 sections: hero, tape, mission, checks, harness, arming, state, open, cta) | index.astro:409 (hero), 1152 (open) | pass, but the two say near-duplicate things ("Open source · alpha · Hyperliquid testnet" vs "Open source") |
| 3 | Mono-caps micro-labels in chrome beyond the eyebrow class | 11 `text-transform: uppercase` rules in index.astro + 3 in Layout.astro; chrome instances: state-card-label x2 (1128, 1137), arming-state x2 (1092, 1101), preview-stamp (1038), harness-tag x5 rendered (1078-1081), preview-title adjacent | index.astro:3643-3649, 3596-3604, 3461-3470, 3564-3571; Layout.astro:446-452, 195-202 | borderline: card labels and pills rather than section eyebrows; the templated mono-caps rhythm the skill flags is present in spirit |
| 4 | Decorative middle-dots (`·`) | 48 lines contain `·` in index.astro + 2 in Layout.astro. In-replica (exempt, mirrors the app's own separators): ~40. In chrome: hero eyebrow carries 2 (409), nav tag 1 (Layout.astro:51), footer 3 (Layout.astro:77), cta-release 2 (1188), tape placeholder 1 (444) | listed lines | chrome violates the "max 1 per line" ration in 4 places (hero eyebrow, footer, cta-release) |
| 5 | Decorative status dots in chrome | 2 (arming card) | index.astro:1093 (`arming-dot` on "No valid signer key"), 1102 ("Valid key loaded") | they do convey the real semantic state of the signer key, which the skill's exception allows; counted because the contract says "no decorative status dots outside the replica" without the exception |
| 6 | Perpetual loops beyond the ticker tape (contract clause 9) | 2 confirmed + 1 borderline: armed arming-dot `pulse 2s infinite` (3619), composer caret `blink 1.1s infinite` (2416); borderline: tape shimmer while loading (1579, removes on fill, part of the tape itself) | index.astro:3606-3620, 2412-2417, 1574-1580 | the two confirmed loops are inside or adjacent to the replica surface; the caret blink and armed pulse imitate the real app's idle chrome, but the contract's ban is unqualified |
| 7 | Section-number labels (`00 / INDEX` etc.) | 0 | rg for `00 /`, `No. 0`, numeric-eyebrow patterns: none | pass |
| 8 | Scroll cues | 1, judgement | index.astro:463-467 lede: "keep scrolling and the log fills, the watch fires, the checks pass, and the chart earns its target" | an instruction to scroll inside visible copy; no `Scroll ↓` glyph exists anywhere |
| 9 | Version stamps in chrome | 1, borderline | index.astro:1187-1189 `cta-release` prints the fetched release tag + "macOS arm64 · not notarized"; nav tag "testnet · alpha" (Layout.astro:51) is a status label, not a version | the tag is real release data served to a download CTA, not a decorative `v1.4.2` footer; counted because the contract bans version stamps in page chrome without an exception |
| 10 | Locale / city / time / weather strips | 0 | none found | pass |
| 11 | Marquees | 1 (the Hyperliquid tape) | index.astro:435-451, 1500-1584 | within max-one-per-page, and the contract exempts it as real data |
| 12 | Section layout-family repeats (contract clause 7: no two sections share a family) | 2 duplicates across 9 sections: checks (copy-left/card-right split, 3337-3342) and arming (card-left/copy-right split, 3576-3581) are the same split family mirrored; hero (1391) and final CTA (3701) are both centered-stack | index.astro:3337, 3576, 1391, 3701 | family count (7 distinct over 9 sections) clears the "at least 4 families" floor but the "no two share" clause fails twice |
| 13 | Consecutive image+text zigzag (cap 2) | 0 runs of 3 (checks and arming are separated by the harness grid) | — | pass |
| 14 | Hero text-element count (max 4) | 4: eyebrow (409), h1 (411-413), sub (415-418), CTA pair (420-429). No tagline below CTAs, no trust strip | index.astro:404-431 | pass |
| 15 | CTA intent duplication | 1 cluster: the "go to the repo/source" intent wears three labels — nav "GitHub" (Layout.astro:64), hero + CTA "Run from source" (425, 1185), open "Browse the source" (1167), footer "GitHub" (Layout.astro:80) | listed lines | skill 4.5 "No Duplicate CTA Intent" wants one label per intent; the download intent is consistently labeled ("Download for macOS" x2) |
| 16 | Hand-rolled decorative SVG | 34 `<svg>` elements total (index.astro 33, Layout.astro 1). In-replica icons: ~24 (sidebar, breadcrumb, composer, status bar, chart marks). In chrome: 9 — Apple download mark (422), source arrow (427), GitHub mark (Layout.astro:61-63), note ticks x3 (956, 968, 980), rr tick (758), preview checkmarks x5 rendered (1030) | listed lines | chrome hand-rolled SVG violates skill 9.E ("no hand-rolled SVG icons"); the replica's are a fidelity defect tracked in fidelity.md rows 3-4 |
| 17 | AI-written cute copy | 2 flagged, judgement: "keep scrolling and the log fills, the watch fires, the checks pass, and the chart earns its target" (465-466 — instruction plus the metaphor "earns its target"); "The stop is not advisory" (983 — punchy but plain enough to keep) | index.astro:465-466, 983 | no "quietly trusted", no fake-precise invented specs (the 17 checks and fixture numbers trace to the product), no Jane-Doe names |
| 18 | Fake-precise numbers | 0 in chrome (the tape is real API data with a remove-on-fail path, 1293-1298; 17 checks is the product's own count) | index.astro:386, 1237-1299 | pass |
| 19 | Scoring/progress bars with filled tracks | 1 outside the replica: none in chrome. The in-replica progress rule and RR bar mirror the app and are exempt | index.astro:3223-3238 | pass |
| 20 | Pills/labels overlaid on images, photo-credit captions, decoration strips, floating corner sub-text | 0 | none found | pass |

## Counts per class

- Fail: rows 4 (chrome middle-dots), 6 (2 perpetual loops), 8 (scroll cue), 12 (2 layout-family repeats), 15 (CTA intent triple-label), 16 (9 chrome hand-rolled SVGs), 17 (1-2 cute strings), 3 (borderline mono-caps rhythm), 5 (2 dots, arguably semantic), 9 (borderline release tag)
- Pass: rows 1 (visible strings), 2, 7, 10, 11, 13, 14, 18, 19, 20
- Measured em-dash total: 22 (index.astro), all in comments; Layout.astro 0.

## Not verified

- Rendered-browser confirmation of any row (static analysis only, per mission constraints); counts marked "rendered" (harness-tag, preview checkmarks) assume default data, which is static in the frontmatter.
