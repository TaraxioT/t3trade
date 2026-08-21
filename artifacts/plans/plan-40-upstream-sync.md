# Plan 40 — upstream sync to v0.0.34-nightly.20260820.1142 + standing sync strategy

Measured 2026-08-20 (all numbers verified in-repo, not estimated):

- Baseline: `3b72d17cb` (v0.0.33, tag `upstream-base/2026-08-10-3b72d17cb`) — this is
  exactly `git merge-base main upstream/main`, so the last sync closed cleanly.
- Target: `beab6886f` = `upstream/main` HEAD = tag `v0.0.34-nightly.20260820.1142`.
  **No stable v0.0.34 exists yet** — the whole 259-commit range is nightlies.
- Divergence: 2795 fork commits ahead / 259 upstream commits behind (GitHub's
  "519 ahead" is a first-parent count; 2795 is the true commit count).
- Overlap: 91 files touched by both sides; `git merge-tree` forecasts **28 conflicts**.
- **No upstream migrations in the range** (fork ids 054–073 are safe, no renumbering).
- **No Effect version bump** in the range (last sync's Batch-B problem does not exist).
- Local `main` is 4 commits ahead of `origin/main` (unpushed), and Plan 39 Phase 0
  WIP is dirty in the tree (contracts/trading.ts, TradingMissionProjection.ts + test,
  tradingPresentation.ts, untracked missionSizeUnitStore.ts).
- `docs/upstream/PATCH_LEDGER.md` last updated 2026-08-13 — plans 27–39 seams missing.
- `apps/web/src/index.css` is BOTH a forecast conflict and a Plan 39 Phase-4 file →
  sync must land before Plan 39 Phases 1–5 resume.

## Conflict forecast (28 files), bucketed by resolution policy

Buckets verified 2026-08-20 against the actual upstream diffs
(`git log/diff 3b72d17cb..upstream/main -- <file>`), not just file names.
All six Plan-39 trading source files verified **fork-only** (`git ls-tree
upstream/main` returns nothing) — only `index.css` intersects Plan 39.

**A. Fork identity — keep ours (or keep our deletion):**
README.md · docs/user/install.md · apps/marketing/src/pages/index.astro ·
apps/marketing/src/pages/download.astro (deleted in fork — keep deleted) ·
.github/workflows/release.yml (fork release conventions: t3trade-v* tags, unsigned
arm64, prerelease) · .github/workflows/mobile-showcase-screenshots.yml ·
apps/desktop/resources/icon.ico + icon.png — **verified**: upstream commit
`ad117235b` deleted icon.icns/ico/png and replaced committed binaries with an
optional path-probe (`DesktopAssets.ts` returns `Option`-typed `iconPaths` by
probing `resolveResourcePathCandidates`). Resolution: KEEP the fork's branded
binaries in `apps/desktop/resources/` AND take upstream's probe code — the
probe finds them. After the merge, verify the packaged app still shows the
fork icon (the launcher also copies `icon.icns` into Resources,
electron-launcher.mjs:239).

**B. Version/update plumbing — take upstream, re-apply fork deltas (all
verified small on the upstream side except the tests):**
apps/web/src/versionSkew.ts (+2 lines upstream) + .test.ts ·
apps/web/src/components/desktopUpdate.logic.ts (22 lines) ·
packages/shared/package.json (8 lines) ·
packages/client-runtime/src/state/threadSettled.test.ts (166 lines — upstream
`f21b47e52` "a merged PR settles its thread only once") ·
apps/desktop/src/app/DesktopAppIdentity.test.ts · DesktopLifecycle.test.ts ·
DesktopTelemetryPublisher.test.ts · DesktopApplicationMenu.test.ts.

**C. Known fork seams — take upstream's rewrite, re-inject the fork seam
(backfill PATCH_LEDGER first). Verified upstream-side sizes:**
- apps/web/src/index.css — **1600 lines changed upstream**, dominated by
  `9885a845c refactor(web): simplify global styling (#6381)` plus dark-theme
  fixes. The fork's mission keyframes block will not survive as a hunk.
  Decided resolution: during the merge, take upstream's file whole and move
  the fork's mission/trading CSS into a new fork-owned
  `apps/web/src/trading.css` imported with one line from index.css. This is
  the plan's seam-shrinking item done at the moment it is cheapest, and it
  makes this the last index.css conflict.
- apps/web/src/components/chat/ChatComposer.tsx — **1229 lines changed
  upstream** (state drawers #7150, file drops #6636, image-type checks,
  oversized-prompt guard, model picker). Near-rewrite: take upstream, re-inject
  the fork's trading seam per ledger.
- apps/web/src/components/chat/MessagesTimeline.tsx — 643 lines (tool activity
  collapse #7152 et al). Same treatment.
- apps/web/src/components/Sidebar.tsx — 528 lines (statuses, tooltips, badges).
  Same treatment; the mission join/row/status seam re-injects as in the
  v0.0.33 sync.
- apps/server/src/orchestration/decider.ts — 36 lines, ONE upstream commit
  (`07e668dc4` settle snoozed threads immediately). Small; merge by hand.
- apps/server/src/provider/Layers/ProviderService.ts — 66 lines, ONE commit
  (`cd096b9ad` withhold browser access from agents). Small; merge by hand.
- apps/server/src/bin.ts (2) · cli/connect.ts (11) · cli/service.ts (13) —
  trivial upstream deltas onto fork-modified files.
- apps/server/src/orchestration/decider.settled.test.ts — pairs with decider.ts.

Note: `apps/server/src/ws.ts` overlaps but **auto-merges clean** this time.

**D. Mechanical:** pnpm-lock.yaml — never hand-merge; take either side, then
`pnpm install` regenerates it after all package.json conflicts are resolved.

## PR count: exactly 2

1. Sync PR `sync/upstream-2026-08-20-beab6886f` → main. **"Create a merge
   commit" ONLY — never squash/rebase** (the PR #22 squash orphaned the entire
   ancestry and had to be repaired with a stitch merge).
2. Hardening PR (seam-shrinking + drift automation, Prompt 5). Fork-only files;
   any merge method is safe, but default to merge commit for uniformity.

Everything else (Plan 39 checkpoint, ledger backfill) goes directly to main,
matching existing fork practice.

## The prompt series

Run the prompts in order, one session each (2 and 3 may be one session).
Full text of each prompt lives in the chat transcript of 2026-08-20; summary:

- **Prompt 0 (gate)** — the sync starts only AFTER Plan 39 completes and its
  commits are on main. Prompt 1 is the readiness check, not a WIP-parking step.
- **Prompt 1** — verify Plan 39 is fully landed (clean tree, gates green),
  push main to origin.
- **Prompt 2** — backfill PATCH_LEDGER for plans 27–39 seams (only the 28
  forecast-conflict files matter), then create the sync branch, `git merge --no-ff
  upstream/main`, resolve the 28 conflicts per the buckets above.
- **Prompt 3** — full gate on the merge commit, open the sync PR per
  SYNC_RUNBOOK.md step 6, merge with a merge commit, tag
  `upstream-base/2026-08-20-beab6886f`, add the BASELINE.md row, push the tag.
- **Prompt 4** — post-sync: pull main, re-run the gate, resume Plan 39 Phase 1.
- **Prompt 5** — standing strategy: extract mission keyframes to a fork-owned
  CSS file, add `scripts/upstream-drift.sh` (fetch + merge-tree forecast) +
  weekly schedule, write cadence + merge-method rules into SYNC_RUNBOOK v2.

## Standing cadence rules (going into SYNC_RUNBOOK v2)

- Sync weekly, or whenever `upstream-drift.sh` reports > 150 commits or > 15
  forecast conflicts — whichever comes first. 259 commits produced 28 conflicts;
  smaller batches shrink superlinearly.
- Sync to a tag, always (nightly is fine when no stable exists); record the tag
  name in BASELINE.md.
- Sync PRs merge with a merge commit. No exceptions.
- Every plan that touches a bucket-C seam file adds its ledger row in the same
  commit — the ledger being stale is what makes conflict resolution slow.
- Never sync with a dirty tree; checkpoint or branch WIP first.
