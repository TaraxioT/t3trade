# P12 — Marketing deploy preflight (read-only)

Date: 2026-08-21. All checks read-only; nothing deployed, built, or written outside this file.

## Pass/fail table

| Precondition | Status | Evidence |
| --- | --- | --- |
| Wrangler authenticated | PASS | `wrangler whoami`: OAuth, georgekurianmathew@gmail.com, account `George Mathew | Athelstan` (a22fe9411b81705409eb7cdf9be367e3), scope `pages (write)` present |
| Pages project `t3trade` exists | PASS | `wrangler pages project list` → row `t3trade | t3trade.pages.dev | prod: No (direct-upload) | 5 hours ago` |
| Config sane | PASS | `wrangler.jsonc`: `name: t3trade`, `pages_build_output_dir: ./dist`, compat date 2026-08-01. Astro is default static output; `dist/` exists with `index.html`, `_astro/`, `_redirects`. No headers/compat flags needed. No `deploy` script in package.json — ship step runs `wrangler pages deploy` (or `... deploy dist`) directly |
| Determinism guards wired | PASS | `astro.config.mjs` sets `vite.build.cssMinify: false`. Build script: `extract-app-tokens.mjs --check` → `beats.test.ts` → `astro build` → `check-scroll-timelines.mjs` (fails build if <37 `animation-timeline` declarations or folded shorthand appears) |
| GitHub releases feed live | PASS (endpoint) / EMPTY (data) | `GET https://api.github.com/repos/TaraxioT/t3trade/releases?per_page=1` → HTTP 200, body exactly `[]`. Download UI will show no release until one is published |
| Hyperliquid testnet live | PASS | `POST https://api.hyperliquid-testnet.xyz/info` `{"type":"meta"}` → HTTP 200 in ~0.57s, valid universe JSON returned |

## Current live deployment

Production URL: **https://t3trade.pages.dev** — HTTP 200, `text/html`, 113,465-byte Astro-built page, `<title>T3 Trade · Trading Interface for Coding Agents</title>`, meta description matches this repo's marketing copy ("open-source desktop and self-hosted web app for supervised perp trading ... Hyperliquid testnet"). It is this repo's own marketing output, already deployed. Latest production deployment: `94d871d6` 5 hours ago (commit 10143a3), then `ad6352ce` 1 day ago, `94a82fb3` 1 day ago.

## Redirects

`public/_redirects`: `/download -> /#download` (301). Copied into `dist/_redirects`; Pages picks it up automatically.

## Notes / non-blockers

- A fresh build must happen at ship time (sources being edited concurrently; the existing `dist/` is stale by definition). All guards run inside `npm/bun run build`, so a passing build carries them.
- Release feed is empty — expected per prior check, confirmed. `fetchLatestRelease` handles `[]` (returns undefined).
- No custom domain on the project; production domain is `t3trade.pages.dev`.

**Verdict: no blockers. All ship preconditions pass.**
